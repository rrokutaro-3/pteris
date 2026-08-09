import fs from 'fs/promises';
import path from 'path';

/**
 * Syncs product prices to D1 for server-side checkout validation.
 * Runs after build-products so sale prices are included.
 */

const BUILT_DIR = './data/products';
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const D1_DB_ID = process.env.D1_DATABASE_ID;

async function d1Query(sql, params = []) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DB_ID}/query`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params })
    }
  );

  const data = await res.json();
  if (!data.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(data.errors)}`);
  }
  return data.result?.[0]?.results || [];
}

export async function syncPrices() {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !D1_DB_ID) {
    console.log('   ⚠️ D1 credentials not set, skipping price sync');
    return;
  }

  const files = await fs.readdir(BUILT_DIR);
  const jsonFiles = files.filter(f => f.endsWith('.json'));

  const prices = [];

  for (const file of jsonFiles) {
    const raw = await fs.readFile(path.join(BUILT_DIR, file), 'utf-8');
    const product = JSON.parse(raw);
    const saleActive = !!product.pricing?.sale?.active;

    for (const variant of product.variants || []) {
      // NOTE: a previous version of this sync always wrote
      // `variant.price` (which is already the discounted price during a
      // sale) as the "regular" price column, and wrote the discounted
      // *base product* price — not the variant's own discounted price —
      // as `sale_price`. That meant every variant except the one whose
      // price happened to equal the base price got billed the wrong
      // amount during a sale, and the true original price was lost
      // entirely once a sale ended (nothing to roll back to).
      //
      // build-products.js now preserves `variant.originalPrice`
      // alongside the discounted `variant.price`, so we sync:
      //   - price          -> the true regular (pre-sale) price
      //   - sale_price      -> this variant's own discounted price
      const regularPrice = saleActive && variant.originalPrice !== undefined
        ? variant.originalPrice
        : variant.price;
      const variantSalePrice = saleActive ? variant.price : null;

      prices.push({
        productId: product.id,
        variantId: variant.id,
        sku: variant.sku,
        price: regularPrice,
        compareAtPrice: product.pricing?.compareAtPrice || null,
        currency: product.pricing?.currency || 'USD',
        saleActive: saleActive ? 1 : 0,
        salePrice: variantSalePrice,
        // Weight is synced here so checkout can validate shipping cost
        // against the true product weight instead of trusting whatever
        // weight the client puts in its cart payload.
        weight: variant.weight ?? product.shipping?.weight ?? 0
      });
    }
  }

  // Batch insert into D1
  // D1 supports up to 100 parameters per query, so we batch in chunks.
  // 9 bound params per row (weight added) * 10 = 90 params, safely under
  // the limit. A previous version's comment claimed "9 params per row"
  // but the INSERT below only had 8 placeholders and never synced
  // weight at all — the comment and code had drifted apart.
  const CHUNK_SIZE = 10;
  let inserted = 0;

  for (let i = 0; i < prices.length; i += CHUNK_SIZE) {
    const chunk = prices.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, datetime("now"))').join(', ');
    const params = chunk.flatMap(p => [
      p.productId, p.variantId, p.sku, p.price, p.compareAtPrice,
      p.currency, p.saleActive, p.salePrice, p.weight
    ]);

    await d1Query(`
      INSERT INTO prices (product_id, variant_id, sku, price, compare_at_price, currency, sale_active, sale_price, weight, updated_at)
      VALUES ${placeholders}
      ON CONFLICT(product_id, variant_id) DO UPDATE SET
        sku = excluded.sku,
        price = excluded.price,
        compare_at_price = excluded.compare_at_price,
        currency = excluded.currency,
        sale_active = excluded.sale_active,
        sale_price = excluded.sale_price,
        weight = excluded.weight,
        updated_at = excluded.updated_at
    `, params);

    inserted += chunk.length;
  }

  console.log(`   Synced ${inserted} prices to D1`);
}

if (process.argv[1].endsWith('sync-prices.js')) {
  syncPrices().catch(err => {
    console.error('Price sync failed:', err);
    process.exit(1);
  });
}
