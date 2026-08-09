import fs from 'fs/promises';
import path from 'path';

const SOURCE_DIR = './data/source/products';
const OUTPUT_DIR = './data/products';
const SALE_CONFIG_PATH = './data/config/sale.json';
const ASSET_MIGRATION_PATH = './data/config/asset-migration.json';

/**
 * Minimal structural validation against the shape defined in
 * src/schema/product.schema.json.
 *
 * The JSON Schema file existed but nothing in the build pipeline ever
 * ran product files through it — build-configs.js only checked that
 * top-level *config* files exist, never product data. A malformed
 * product (missing pricing.currency, a non-array variants field, a
 * variant with no price, etc.) would build silently and only fail later
 * in less obvious ways — e.g. undefined/NaN reaching Stripe as cents, or
 * sync-prices.js writing garbage to D1. This is intentionally a plain
 * hand-rolled check, not a JSON Schema library dependency, in keeping
 * with the project's no-extra-dependencies approach — it validates the
 * same required fields product.schema.json declares, not the full
 * schema (patterns, enums, etc.).
 */
function validateProduct(product, file) {
  const errors = [];
  const req = (cond, msg) => { if (!cond) errors.push(msg); };

  req(typeof product.id === 'string' && product.id.length > 0, 'missing/invalid id');
  req(typeof product.type === 'string', 'missing type');
  req(product.identity && typeof product.identity.name === 'string' && product.identity.name.length > 0, 'missing identity.name');
  req(product.identity && typeof product.identity.slug === 'string', 'missing identity.slug');
  req(product.identity && typeof product.identity.sku === 'string', 'missing identity.sku');
  req(product.identity && typeof product.identity.status === 'string', 'missing identity.status');
  req(product.pricing && typeof product.pricing.currency === 'string', 'missing pricing.currency');
  req(product.pricing && typeof product.pricing.price === 'number' && product.pricing.price >= 0, 'missing/invalid pricing.price');
  req(Array.isArray(product.categories), 'categories must be an array');
  req(Array.isArray(product.variants) && product.variants.length > 0, 'variants must be a non-empty array');
  req(product.media && Array.isArray(product.media.images), 'missing media.images array');

  for (const v of product.variants || []) {
    req(typeof v.id === 'string' && v.id.length > 0, `variant missing/invalid id`);
    req(typeof v.sku === 'string', `variant ${v.id || '?'} missing sku`);
    req(v.options && typeof v.options === 'object', `variant ${v.id || '?'} missing options`);
    req(typeof v.price === 'number' && v.price >= 0, `variant ${v.id || '?'} missing/invalid price`);
    req(typeof v.stock === 'number', `variant ${v.id || '?'} missing stock`);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid product in ${file}:\n  - ${errors.join('\n  - ')}`);
  }
}

async function loadSaleConfig() {
  try {
    const raw = await fs.readFile(SALE_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { active: false, rules: [] };
  }
}

/**
 * Load the R2 -> Hugging Face asset URL map produced by
 * scripts/migrate-assets-to-hf.js, if one exists.
 *
 * That script's own log output promises "Next build will update product
 * URLs to point to HF," but nothing in the build pipeline actually read
 * asset-migration.json — the map was generated and then never consumed,
 * so migrated assets' URLs never got rewritten in product data.
 */
async function loadAssetMigrationMap() {
  try {
    const raw = await fs.readFile(ASSET_MIGRATION_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return data.map || {};
  } catch {
    return {};
  }
}

/**
 * Rewrite any URL in the product that has a migrated replacement.
 * Covers media images/videos, variant images, and SEO og:image — the
 * places product JSON stores R2 asset URLs.
 */
function rewriteMigratedAssetUrls(product, migrationMap) {
  if (!migrationMap || Object.keys(migrationMap).length === 0) return product;

  const rewrite = (url) => (url && migrationMap[url]) ? migrationMap[url] : url;

  if (product.media?.images) {
    product.media.images = product.media.images.map(img => ({ ...img, url: rewrite(img.url) }));
  }
  if (product.media?.videos) {
    product.media.videos = product.media.videos.map(v => ({
      ...v,
      url: rewrite(v.url),
      thumbnail: rewrite(v.thumbnail)
    }));
  }
  if (product.variants) {
    product.variants = product.variants.map(v => ({ ...v, image: rewrite(v.image) }));
  }
  if (product.seo?.ogImage) {
    product.seo.ogImage = rewrite(product.seo.ogImage);
  }

  return product;
}

/**
 * Apply sale to a product while PRESERVING variant price deltas.
 * If Small=$80 and Large=$90, a 20% sale makes them $64 and $72.
 */
function applySalePrice(product, saleConfig) {
  if (!saleConfig.active) return product;

  const now = new Date();
  const start = new Date(saleConfig.startDate);
  const end = new Date(saleConfig.endDate);
  if (now < start || now > end) return product;

  const rule = saleConfig.rules.find(r => {
    if (r.productId && r.productId === product.id) return true;
    if (r.tag && product.tags?.includes(r.tag)) return true;
    if (r.category && product.categories?.some(c => c === r.category || c.startsWith(r.category + '/'))) return true;
    return false;
  });

  if (!rule) return product;

  const enriched = JSON.parse(JSON.stringify(product));

  // Calculate discount ratio (preserve variant deltas)
  let discountRatio = 0;
  if (rule.discountType === 'percentage') {
    discountRatio = rule.discountValue / 100;
  } else if (rule.discountType === 'fixed') {
    // Fixed discount: apply to base price, then recalculate variant prices proportionally
    const basePrice = enriched.pricing.price;
    discountRatio = Math.min(rule.discountValue / basePrice, 1);
  }

  enriched.pricing.originalPrice = enriched.pricing.price;
  enriched.pricing.price = +(enriched.pricing.price * (1 - discountRatio)).toFixed(2);

  enriched.pricing.sale = {
    active: true,
    discountType: rule.discountType,
    discountValue: rule.discountValue,
    salePrice: enriched.pricing.price,
    badgeText: saleConfig.badgeText,
    badgeColor: saleConfig.badgeColor,
    badgeTextColor: saleConfig.badgeTextColor
  };

  // Apply proportional discount to each variant (preserving deltas).
  //
  // IMPORTANT: we keep both the discounted `price` (for display / cart)
  // AND the pre-discount `originalPrice` on each variant. A previous
  // version only wrote the discounted price and threw the original away,
  // which meant sync-prices.js had no correct per-variant "regular price"
  // to sync to D1 — it ended up syncing the discounted variant price as
  // the regular price, and the discounted *base product* price (not the
  // variant's own price) as the sale price, silently mispricing every
  // variant except the one matching the base price during a sale.
  enriched.variants = enriched.variants.map(v => {
    const originalPrice = v.price;
    const variantDiscounted = +(v.price * (1 - discountRatio)).toFixed(2);
    return {
      ...v,
      price: variantDiscounted,
      originalPrice,
    };
  });

  return enriched;
}

export async function buildProducts(timestamp) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const files = await fs.readdir(SOURCE_DIR);
  const jsonFiles = files.filter(f => f.endsWith('.json'));
  const saleConfig = await loadSaleConfig();
  const assetMigrationMap = await loadAssetMigrationMap();

  let count = 0;

  for (const file of jsonFiles) {
    const raw = await fs.readFile(path.join(SOURCE_DIR, file), 'utf-8');
    let product = JSON.parse(raw);

    // Skip anything not meant to be publicly live. The schema
    // (src/schema/product.schema.json) declares three states — active,
    // draft, archived — but this only ever excluded 'archived'. A product
    // left as 'draft' (the schema's own in-progress/not-ready state) was
    // built, published in index.json/batches, AND had its price synced to
    // D1 by sync-prices.js (which reads this function's output) — making
    // an unfinished, unreviewed product fully purchasable through
    // checkout even though nothing in the storefront UI would link to it.
    if (product.identity?.status === 'archived') continue;
    if (product.identity?.status === 'draft') continue;

    validateProduct(product, file);

    product = rewriteMigratedAssetUrls(product, assetMigrationMap);
    const enriched = applySalePrice(product, saleConfig);

    enriched._build = {
      version: timestamp,
      builtAt: new Date().toISOString()
    };

    await fs.writeFile(
      path.join(OUTPUT_DIR, `${product.id}.json`),
      JSON.stringify(enriched, null, 2)
    );

    count++;
  }

  console.log(`   Wrote ${count} product files to ${OUTPUT_DIR}`);
  return count;
}

if (process.argv[1].endsWith('build-products.js')) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  buildProducts(timestamp);
}
