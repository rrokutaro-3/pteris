import fs from 'fs/promises';
import path from 'path';

const BUILT_DIR = './data/products';   // FIXED: Read from BUILT products, not source
const OUTPUT_DIR = './data';
const BATCH_SIZE = 24;
const COLLECTIONS_CONFIG_PATH = './data/config/collections.json';

function buildSearchText(product) {
  const parts = [
    product.identity?.name,
    product.identity?.brand,
    ...(product.tags || []),
    ...(product.attributes?.map(a => `${a.name} ${a.value}`) || []),
    ...(product.variants?.flatMap(v => Object.values(v.options || {})) || [])
  ];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function buildCategoryMap(products) {
  const map = {};
  for (const p of products) {
    for (const catPath of p.categories || []) {
      if (!map[catPath]) {
        map[catPath] = {
          name: catPath.split('/').pop().replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
          productIds: [],
          heroImage: null,
          description: null
        };
      }
      map[catPath].productIds.push(p.id);
    }
  }
  return map;
}

/**
 * Load custom collections from data/config/collections.json.
 * Returns an empty object if the file doesn't exist — the three
 * auto-generated collections always work regardless.
 */
async function loadCustomCollections(validIds) {
  try {
    const raw = await fs.readFile(COLLECTIONS_CONFIG_PATH, 'utf-8');
    const data = JSON.parse(raw);
    const result = {};

    for (const [id, col] of Object.entries(data)) {
      if (typeof id !== 'string' || !id.trim()) continue;

      // Filter out any product IDs that weren't actually built (draft/archived/missing)
      const productIds = (col.productIds || []).filter(pid => validIds.has(pid));

      result[id] = {
        name: col.name || id,
        description: col.description || null,
        heroImage: col.heroImage || null,
        productIds
      };
    }

    return result;
  } catch {
    return {};
  }
}

function buildCollectionMap(products, customCollections = {}) {
  // Auto-generated collections
  const collections = {
    'new-arrivals': { name: 'New Arrivals', productIds: [], heroImage: null },
    'bestsellers':  { name: 'Bestsellers',  productIds: [], heroImage: null },
    'sale':         { name: 'On Sale',       productIds: [], heroImage: null },
    // Merge custom collections — defined before auto-population so the
    // auto loop below can also add products into any custom collection
    // that uses a tag/category rule in the future. For now they are
    // purely productIds-based and don't overlap with the auto sets.
    ...customCollections
  };

  for (const p of products) {
    const published = new Date(p.meta?.publishedAt || 0);
    const daysAgo = (Date.now() - published.getTime()) / (1000 * 60 * 60 * 24);
    if (daysAgo <= 30) collections['new-arrivals'].productIds.push(p.id);
    if (p.pricing?.sale?.active) collections['sale'].productIds.push(p.id);
    // Bestsellers: placeholder — would query order data in production
  }

  return collections;
}

/**
 * Filter dead links from relations.
 * Only include product IDs that exist in the built set.
 */
function filterRelations(product, validIds) {
  const filter = (arr) => (arr || []).filter(id => validIds.has(id));
  return {
    related: filter(product.relations?.related),
    upsells: filter(product.relations?.upsells),
    crossSells: filter(product.relations?.crossSells)
  };
}

export async function buildIndex(timestamp) {
  const files = await fs.readdir(BUILT_DIR);
  const jsonFiles = files.filter(f => f.endsWith('.json'));

  const products = [];
  const validIds = new Set();

  for (const file of jsonFiles) {
    const raw = await fs.readFile(path.join(BUILT_DIR, file), 'utf-8');
    const p = JSON.parse(raw);
    products.push(p);
    validIds.add(p.id);
  }

  // Filter dead links from all products
  for (const p of products) {
    p.relations = filterRelations(p, validIds);
  }

  // Load custom collections (needs validIds to filter references to
  // draft/archived/missing products before they reach the index)
  const customCollections = await loadCustomCollections(validIds);

  // Build lightweight refs
  const productRefs = {};
  const searchIndex = {};

  for (const p of products) {
    const inStock = p.variants?.some(v => (v.stock || 0) > 0) ?? false;
    const thumbImage = p.media?.images?.[0]?.url || '';

    productRefs[p.id] = {
      name: p.identity?.name,
      price: p.pricing?.price,
      compareAtPrice: p.pricing?.compareAtPrice,
      image: thumbImage,
      categories: p.categories || [],
      tags: p.tags || [],
      inStock,
      rating: 0,
      reviewCount: 0
    };

    searchIndex[p.id] = {
      text: buildSearchText(p),
      name: p.identity?.name,
      price: p.pricing?.price,
      image: thumbImage,
      inStock
    };
  }

  const index = {
    version: timestamp,
    productCount: products.length,
    products: productRefs,
    categories: buildCategoryMap(products),
    collections: buildCollectionMap(products, customCollections),
    search: searchIndex,
    pages: {
      home: 'config/home.json',
      about: 'config/about.json',
      shipping: 'config/shipping-page.json',
      faq: 'config/faq.json'
    },
    _meta: {
      builtAt: new Date().toISOString(),
      builder: 'lean-ecommerce-engine v2.2.0'
    }
  };

  await fs.writeFile(
    path.join(OUTPUT_DIR, 'index.json'),
    JSON.stringify(index, null, 2)
  );

  // ─── Generate batches for BOTH categories AND collections ───
  await fs.mkdir(path.join(OUTPUT_DIR, 'batches'), { recursive: true });

  // Clean old batch files first
  try {
    const oldBatches = await fs.readdir(path.join(OUTPUT_DIR, 'batches'));
    for (const f of oldBatches) {
      await fs.unlink(path.join(OUTPUT_DIR, 'batches', f));
    }
  } catch { /* directory might not exist yet */ }

  const batchTargets = {
    ...index.categories,
    ...Object.fromEntries(
      Object.entries(index.collections).map(([k, v]) => [`collection:${k}`, v])
    )
  };

  for (const [key, data] of Object.entries(batchTargets)) {
    const ids = data.productIds || [];
    const batches = Math.ceil(ids.length / BATCH_SIZE) || 1;

    for (let i = 0; i < batches; i++) {
      const batchIds = ids.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
      const batchData = {
        key,
        batch: i + 1,
        totalBatches: batches,
        productIds: batchIds,
        version: timestamp
      };

      const safeKey = key.replace(/\//g, '-').replace(/:/g, '-');
      const isLast = i === batches - 1;
      const suffix = isLast ? '-last' : '';

      await fs.writeFile(
        path.join(OUTPUT_DIR, 'batches', `${safeKey}-batch-${i + 1}${suffix}.json`),
        JSON.stringify(batchData, null, 2)
      );
    }
  }

  console.log(`   Index: ${products.length} products, ${Object.keys(index.categories).length} categories, ${Object.keys(index.collections).length} collections`);
  console.log(`   Batches: generated for ${Object.keys(batchTargets).length} targets`);
}

if (process.argv[1].endsWith('build-index.js')) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  buildIndex(timestamp);
}
