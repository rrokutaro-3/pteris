/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║          Pteris StoreClient — DEV / LOCAL TESTING BUILD             ║
 * ║                                                                      ║
 * ║  Drop-in replacement for store-client.js during SPA development.    ║
 * ║  No backend, no deploy, no Cloudflare — runs entirely in-browser.   ║
 * ║                                                                      ║
 * ║  HOW TO USE                                                          ║
 * ║  1. In your SPA, change the script import to point here:            ║
 * ║       import { StoreClient } from './store-client.dev.js'           ║
 * ║     Or via GitHub raw URL so you can edit this file without         ║
 * ║     touching your SPA:                                               ║
 * ║       import { StoreClient } from                                    ║
 * ║         'https://raw.githubusercontent.com/YOUR_ORG/pteris/         ║
 * ║          main/spa/lib/store-client.dev.js'                           ║
 * ║  2. That's it. The dev client starts automatically.                  ║
 * ║                                                                      ║
 * ║  CUSTOMISING DATA                                                    ║
 * ║  Edit DEV_PRODUCTS and DEV_CONFIGS below to match your store.       ║
 * ║  The index (categories, collections, search) is auto-built from     ║
 * ║  DEV_PRODUCTS every time the page loads — no manual step needed.    ║
 * ║                                                                      ║
 * ║  CHECKOUT                                                            ║
 * ║  createCheckout() returns a mock success page instead of Stripe.    ║
 * ║  getLiveStock() returns the stock values baked into DEV_PRODUCTS.   ║
 * ║                                                                      ║
 * ║  WHAT THIS FILE IS NOT                                               ║
 * ║  This file never ships to production. The production store-client.js ║
 * ║  is completely unchanged. Swap the import back before deploying.    ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — SAMPLE PRODUCTS
//
// Replace or extend this array with your own products.
// Shape mirrors data/source/products/*.json exactly.
// Fields the build pipeline adds (_build, pricing.sale etc.) are handled
// below in _applyDevSalePricing() — you don't need to add them manually.
// ─────────────────────────────────────────────────────────────────────────────

const DEV_PRODUCTS = [
  {
    id: 'p-8392',
    type: 'physical',
    identity: {
      name: 'Silk Mini Dress Midnight',
      slug: 'silk-mini-dress-midnight',
      sku: 'DRESS-8392',
      brand: 'Your Brand',
      status: 'active'
    },
    pricing: {
      currency: 'USD',
      price: 89,
      compareAtPrice: 120,
      taxClass: 'standard'
    },
    description: {
      short: 'Luxurious silk mini dress for evening wear.',
      full: '<p>Hand-crafted from 100% mulberry silk, this mini dress drapes beautifully and feels incredible against the skin. Perfect for cocktail parties, date nights, and special occasions.</p><ul><li>100% Silk</li><li>Dry clean only</li><li>Made in Italy</li></ul>',
      highlights: ['100% Silk', 'Dry clean only', 'Made in Italy']
    },
    categories: ['dresses', 'dresses/mini-dresses', 'new-arrivals'],
    tags: ['new-arrival', 'silk', 'evening', 'black', 'luxury'],
    attributes: [
      { name: 'Material', value: '100% Silk', group: 'fabric', visible: true, filterable: true }
    ],
    variants: [
      {
        id: 'v-8392-blk-s',
        sku: '8392-BLK-S',
        options: { Color: 'Black', Size: 'S' },
        price: 89,
        weight: 0.3,
        stock: 12,
        lowStockThreshold: 3,
        backorder: false,
        image: 'https://images.unsplash.com/photo-1595777457583-95e059d581b8?w=600'
      },
      {
        id: 'v-8392-blk-m',
        sku: '8392-BLK-M',
        options: { Color: 'Black', Size: 'M' },
        price: 89,
        weight: 0.3,
        stock: 8,
        lowStockThreshold: 3,
        backorder: false,
        image: 'https://images.unsplash.com/photo-1595777457583-95e059d581b8?w=600'
      },
      {
        id: 'v-8392-red-s',
        sku: '8392-RED-S',
        options: { Color: 'Red', Size: 'S' },
        price: 89,
        weight: 0.3,
        stock: 3,
        lowStockThreshold: 3,
        backorder: true,
        image: 'https://images.unsplash.com/photo-1566174053879-31528523f8ae?w=600'
      }
    ],
    media: {
      images: [
        { url: 'https://images.unsplash.com/photo-1595777457583-95e059d581b8?w=600', alt: 'Silk Mini Dress', type: 'image', order: 1, variant: null },
        { url: 'https://images.unsplash.com/photo-1566174053879-31528523f8ae?w=600', alt: 'Red variant', type: 'image', order: 2, variant: 'v-8392-red-s' }
      ],
      videos: []
    },
    ugc: [],
    relations: { related: ['p-8391'], upsells: [], crossSells: ['p-8405'] },
    shipping: { profile: 'standard', weight: 0.3, requiresShipping: true },
    seo: {
      title: 'Silk Mini Dress Midnight | Your Brand',
      description: 'Shop the Silk Mini Dress in Midnight. 100% silk, perfect for evening events.',
      canonical: '/product/silk-mini-dress-midnight'
    },
    meta: { publishedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() } // 7 days ago → appears in new-arrivals
  },

  {
    id: 'p-8391',
    type: 'physical',
    identity: {
      name: 'Linen Wrap Dress Sand',
      slug: 'linen-wrap-dress-sand',
      sku: 'DRESS-8391',
      brand: 'Your Brand',
      status: 'active'
    },
    pricing: {
      currency: 'USD',
      price: 65,
      compareAtPrice: null,
      taxClass: 'standard'
    },
    description: {
      short: 'Effortless linen wrap dress, perfect for warm days.',
      full: '<p>Our lightweight linen wrap dress moves with you. Adjustable tie-waist, relaxed fit, available in natural sand.</p>',
      highlights: ['100% Linen', 'Machine washable', 'Adjustable waist']
    },
    categories: ['dresses', 'dresses/wrap-dresses'],
    tags: ['linen', 'summer', 'casual', 'sand'],
    attributes: [],
    variants: [
      { id: 'v-8391-s', sku: '8391-S', options: { Size: 'S' }, price: 65, weight: 0.25, stock: 20, lowStockThreshold: 5, backorder: false, image: 'https://images.unsplash.com/photo-1515372039744-b8f02a3ae446?w=600' },
      { id: 'v-8391-m', sku: '8391-M', options: { Size: 'M' }, price: 65, weight: 0.25, stock: 15, lowStockThreshold: 5, backorder: false, image: 'https://images.unsplash.com/photo-1515372039744-b8f02a3ae446?w=600' },
      { id: 'v-8391-l', sku: '8391-L', options: { Size: 'L' }, price: 65, weight: 0.25, stock: 0,  lowStockThreshold: 5, backorder: true,  image: 'https://images.unsplash.com/photo-1515372039744-b8f02a3ae446?w=600' }
    ],
    media: {
      images: [{ url: 'https://images.unsplash.com/photo-1515372039744-b8f02a3ae446?w=600', alt: 'Linen Wrap Dress', type: 'image', order: 1, variant: null }],
      videos: []
    },
    ugc: [],
    relations: { related: ['p-8392'], upsells: [], crossSells: [] },
    shipping: { profile: 'standard', weight: 0.25, requiresShipping: true },
    seo: { title: 'Linen Wrap Dress Sand | Your Brand', description: 'Lightweight linen wrap dress in natural sand.', canonical: '/product/linen-wrap-dress-sand' },
    meta: { publishedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString() }
  },

  {
    id: 'p-8405',
    type: 'physical',
    identity: {
      name: 'Ribbed Knit Crop Top Ivory',
      slug: 'ribbed-knit-crop-top-ivory',
      sku: 'TOP-8405',
      brand: 'Your Brand',
      status: 'active'
    },
    pricing: {
      currency: 'USD',
      price: 38,
      compareAtPrice: 55,
      taxClass: 'standard'
    },
    description: {
      short: 'Stretchy ribbed crop top with a relaxed fit.',
      full: '<p>Essential wardrobe crop top in a soft ribbed knit. Pairs with everything. Available in ivory.</p>',
      highlights: ['95% Cotton, 5% Spandex', 'Hand wash cold', 'Relaxed crop fit']
    },
    categories: ['tops', 'tops/crop-tops', 'sale'],
    tags: ['sale', 'crop', 'knit', 'ivory', 'basics'],
    attributes: [],
    variants: [
      { id: 'v-8405-xs', sku: '8405-XS', options: { Size: 'XS' }, price: 38, weight: 0.15, stock: 30, lowStockThreshold: 5, backorder: false, image: 'https://images.unsplash.com/photo-1434389677669-e08b4cac3105?w=600' },
      { id: 'v-8405-s',  sku: '8405-S',  options: { Size: 'S'  }, price: 38, weight: 0.15, stock: 22, lowStockThreshold: 5, backorder: false, image: 'https://images.unsplash.com/photo-1434389677669-e08b4cac3105?w=600' },
      { id: 'v-8405-m',  sku: '8405-M',  options: { Size: 'M'  }, price: 38, weight: 0.15, stock: 10, lowStockThreshold: 5, backorder: false, image: 'https://images.unsplash.com/photo-1434389677669-e08b4cac3105?w=600' }
    ],
    media: {
      images: [{ url: 'https://images.unsplash.com/photo-1434389677669-e08b4cac3105?w=600', alt: 'Ribbed Crop Top', type: 'image', order: 1, variant: null }],
      videos: []
    },
    ugc: [],
    relations: { related: [], upsells: ['p-8392'], crossSells: [] },
    shipping: { profile: 'standard', weight: 0.15, requiresShipping: true },
    seo: { title: 'Ribbed Knit Crop Top Ivory | Your Brand', description: 'Soft ribbed crop top in ivory.', canonical: '/product/ribbed-knit-crop-top-ivory' },
    meta: { publishedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString() }
  }
];

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — CONFIGS
//
// Keys match exactly what your SPA calls: client.getConfig('store') → DEV_CONFIGS.store
// Add any custom config your SPA uses (e.g. 'home', 'lookbook') as extra keys here.
// ─────────────────────────────────────────────────────────────────────────────

const DEV_CONFIGS = {
  store: {
    name: 'Dev Store',
    url: 'http://localhost',
    currency: 'USD',
    language: 'en',
    timezone: 'America/Los_Angeles',
    features: {
      reviews: true,
      wishlist: true,
      guestCheckout: true,
      backorders: true,
      quickView: true,
      sizeGuide: true
    },
    notifications: {
      banner: {
        active: true,
        text: '🛠 Dev mode active — no real orders will be placed',
        link: null,
        bgColor: '#1a1a2e',
        textColor: '#e0e0e0',
        dismissible: true
      }
    },
    contact: {
      email: 'dev@yourbrand.com',
      returnsEmail: 'returns@yourbrand.com',
      supportEmail: 'support@yourbrand.com',
      phone: '+1-555-DEV-TEST',
      address: '123 Dev Lane, Localhost, CA 00000'
    },
    social: {
      instagram: 'https://instagram.com/yourbrand',
      tiktok: 'https://tiktok.com/@yourbrand',
      pinterest: 'https://pinterest.com/yourbrand'
    }
  },

  menus: {
    main: [
      {
        id: 'shop', label: 'Shop', url: '/category/all',
        children: [
          { id: 'dresses',  label: 'Dresses',  url: '/category/dresses' },
          { id: 'tops',     label: 'Tops',      url: '/category/tops' },
          { id: 'sale',     label: 'Sale',      url: '/collection/sale', badge: 'Up to 30% Off', highlight: true }
        ]
      },
      { id: 'new-in',      label: 'New In',      url: '/collection/new-arrivals' },
      { id: 'bestsellers', label: 'Bestsellers', url: '/collection/bestsellers' },
      { id: 'about',       label: 'About',       url: '/page/about' }
    ],
    footer: [
      {
        title: 'Shop',
        links: [
          { label: 'New Arrivals', url: '/collection/new-arrivals' },
          { label: 'Dresses',     url: '/category/dresses' },
          { label: 'Tops',        url: '/category/tops' },
          { label: 'Sale',        url: '/collection/sale' }
        ]
      },
      {
        title: 'Help',
        links: [
          { label: 'Shipping', url: '/page/shipping' },
          { label: 'Returns',  url: '/page/returns' },
          { label: 'FAQ',      url: '/page/faq' },
          { label: 'Contact',  url: '/page/contact' }
        ]
      }
    ],
    mobile: [
      { id: 'home',  label: 'Home',  url: '/',             icon: 'home' },
      { id: 'shop',  label: 'Shop',  url: '/category/all', icon: 'grid' },
      { id: 'search',label: 'Search',url: '/search',       icon: 'search' },
      { id: 'cart',  label: 'Cart',  url: '/cart',         icon: 'bag', badge: 'cart-count' }
    ],
    social: [
      { platform: 'instagram', url: 'https://instagram.com/yourbrand', icon: 'instagram' },
      { platform: 'tiktok',    url: 'https://tiktok.com/@yourbrand',   icon: 'tiktok' }
    ]
  },

  shipping: {
    profiles: [
      {
        id: 'standard',
        name: 'Standard Shipping',
        deliveryTime: '5-7 business days',
        freeThreshold: 75.00,
        rates: [
          { name: 'Light',    minWeight: 0,   maxWeight: 0.5,  price: 4.99,  countries: ['US', 'CA'] },
          { name: 'Standard', minWeight: 0.5, maxWeight: 2.0,  price: 7.99,  countries: ['US', 'CA'] },
          { name: 'Heavy',    minWeight: 2.0, maxWeight: 10.0, price: 12.99, countries: ['US', 'CA'] }
        ]
      },
      {
        id: 'express',
        name: 'Express Shipping',
        deliveryTime: '2-3 business days',
        freeThreshold: null,
        rates: [
          { name: 'Express', minWeight: 0, maxWeight: 5.0, price: 15.99, countries: ['US'] }
        ]
      },
      {
        id: 'international',
        name: 'International Shipping',
        deliveryTime: '10-20 business days',
        freeThreshold: null,
        rates: [
          { name: 'International',       minWeight: 0,   maxWeight: 2.0,  price: 24.99, countries: ['GB', 'DE', 'FR', 'AU'] },
          { name: 'International Heavy', minWeight: 2.0, maxWeight: 10.0, price: 39.99, countries: ['GB', 'DE', 'FR', 'AU'] }
        ]
      }
    ],
    defaultProfile: 'standard',
    origin: { country: 'US', zip: '10001' }
  },

  tax: {
    defaultRate: 0.00,
    includedInPrice: false,
    rules: [
      { country: 'US', state: 'CA', rate: 0.0725, included: false, name: 'California Sales Tax' },
      { country: 'US', state: 'NY', rate: 0.08,   included: false, name: 'New York Sales Tax' },
      { country: 'US', state: 'TX', rate: 0.0625, included: false, name: 'Texas Sales Tax' },
      { country: 'GB',              rate: 0.20,   included: true,  name: 'UK VAT' },
      { country: 'DE',              rate: 0.19,   included: true,  name: 'German VAT' }
    ]
  },

  coupons: {
    active: ['WELCOME10', 'FREESHIP'],
    codes: {
      WELCOME10: { type: 'percentage', value: 10, minOrder: 0,     usageLimit: null, maxDiscount: 50.00, expires: null, description: '10% off' },
      FREESHIP:  { type: 'fixed',      value: 7.99, minOrder: 50.00, usageLimit: null, maxDiscount: null,  expires: null, description: 'Free standard shipping on orders $50+' }
    }
  },

  sale: {
    active: false,
    saleName: 'Dev Sale',
    startDate: '2020-01-01T00:00:00Z',
    endDate: '2030-01-01T00:00:00Z',
    rules: [],
    badgeText: 'SALE',
    badgeColor: '#ff0000',
    badgeTextColor: '#ffffff'
  }

  // ── Add custom configs your SPA uses, e.g.:
  // home: {
  //   hero: { title: 'New Summer Collection', ... },
  //   featuredCollections: [...]
  // },
  // faq: { sections: [...] }
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — INDEX BUILDER (mirrors src/build/build-index.js)
//
// Runs locally in-browser. You never need to edit this section.
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_SIZE = 24;

function _buildSearchText(product) {
  const parts = [
    product.identity?.name,
    product.identity?.brand,
    ...(product.tags || []),
    ...(product.attributes?.map(a => `${a.name} ${a.value}`) || []),
    ...(product.variants?.flatMap(v => Object.values(v.options || {})) || [])
  ];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function _buildCategoryMap(products) {
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

function _buildCollectionMap(products) {
  const collections = {
    'new-arrivals': { name: 'New Arrivals', productIds: [], heroImage: null },
    'bestsellers':  { name: 'Bestsellers',  productIds: [], heroImage: null },
    'sale':         { name: 'On Sale',      productIds: [], heroImage: null }
  };

  for (const p of products) {
    const published = new Date(p.meta?.publishedAt || 0);
    const daysAgo = (Date.now() - published.getTime()) / (1000 * 60 * 60 * 24);
    if (daysAgo <= 30) collections['new-arrivals'].productIds.push(p.id);
    if (p.pricing?.sale?.active) collections['sale'].productIds.push(p.id);
    // bestsellers: placeholder, same as production
  }

  return collections;
}

/**
 * Apply sale config to products — mirrors build-products.js applySalePrice().
 * Mutates a deep copy; leaves DEV_PRODUCTS untouched.
 */
function _applyDevSalePricing(products, saleConfig) {
  if (!saleConfig?.active) return products;

  const now = new Date();
  const start = new Date(saleConfig.startDate);
  const end = new Date(saleConfig.endDate);
  if (now < start || now > end) return products;

  return products.map(p => {
    const rule = saleConfig.rules?.find(r => {
      if (r.productId && r.productId === p.id) return true;
      if (r.tag && p.tags?.includes(r.tag)) return true;
      if (r.category && p.categories?.some(c => c === r.category || c.startsWith(r.category + '/'))) return true;
      return false;
    });
    if (!rule) return p;

    const enriched = JSON.parse(JSON.stringify(p));
    let discountRatio = 0;
    if (rule.discountType === 'percentage') discountRatio = rule.discountValue / 100;
    else if (rule.discountType === 'fixed')  discountRatio = Math.min(rule.discountValue / enriched.pricing.price, 1);

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
    enriched.variants = enriched.variants.map(v => ({
      ...v,
      originalPrice: v.price,
      price: +(v.price * (1 - discountRatio)).toFixed(2)
    }));
    return enriched;
  });
}

/**
 * Build a complete index object from a product array — same shape as
 * the index.json the production build pipeline writes to data/index.json.
 */
function _buildIndex(products) {
  const validIds = new Set(products.map(p => p.id));

  // Filter dead relation links
  for (const p of products) {
    if (p.relations) {
      p.relations.related    = (p.relations.related    || []).filter(id => validIds.has(id));
      p.relations.upsells    = (p.relations.upsells    || []).filter(id => validIds.has(id));
      p.relations.crossSells = (p.relations.crossSells || []).filter(id => validIds.has(id));
    }
  }

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
      text: _buildSearchText(p),
      name: p.identity?.name,
      price: p.pricing?.price,
      image: thumbImage,
      inStock
    };
  }

  const categories  = _buildCategoryMap(products);
  const collections = _buildCollectionMap(products);

  // Build in-memory batch map (keyed by "safeKey-batch-N[-last]")
  const batches = {};
  const batchTargets = {
    ...categories,
    ...Object.fromEntries(Object.entries(collections).map(([k, v]) => [`collection:${k}`, v]))
  };

  for (const [key, data] of Object.entries(batchTargets)) {
    const ids = data.productIds || [];
    const totalBatches = Math.ceil(ids.length / BATCH_SIZE) || 1;
    const safeKey = key.replace(/\//g, '-').replace(/:/g, '-');

    for (let i = 0; i < totalBatches; i++) {
      const batchIds = ids.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
      const isLast   = i === totalBatches - 1;
      const suffix   = isLast ? '-last' : '';
      batches[`${safeKey}-batch-${i + 1}${suffix}`] = {
        key, batch: i + 1, totalBatches, productIds: batchIds, isLast
      };
      // Also store without suffix so _fetchBatch can find it either way
      batches[`${safeKey}-batch-${i + 1}`] = {
        key, batch: i + 1, totalBatches, productIds: batchIds, isLast
      };
    }
  }

  return {
    version: 'dev-' + Date.now(),
    productCount: products.length,
    products: productRefs,
    categories,
    collections,
    search: searchIndex,
    pages: {
      home: 'config/home.json',
      about: 'config/about.json',
      shipping: 'config/shipping-page.json',
      faq: 'config/faq.json'
    },
    _meta: {
      builtAt: new Date().toISOString(),
      builder: 'pteris-dev-client'
    },
    _batches: batches // internal — not in production index.json
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — DEV StoreClient
//
// Extends the real StoreClient API surface exactly.
// No fetch() calls to Pages or the Worker — all data is in-memory.
// ─────────────────────────────────────────────────────────────────────────────

export class StoreClient {
  constructor(baseUrl = '', options = {}) {
    this.baseUrl = (baseUrl || '').replace(/\/$/, '');
    this.apiUrl  = options.apiUrl || '';
    this.cache   = new Map();
    this.index   = null;
    this.version = null;
    this.options = {
      indexCacheKey: 'store_index_v2',
      indexCacheDuration: 1000 * 60 * 30,
      productCacheDuration: 1000 * 60 * 60,
      ...options
    };

    // Prepare products: skip draft/archived, apply sale pricing
    const saleConfig = DEV_CONFIGS.sale || { active: false };
    this._products = _applyDevSalePricing(
      DEV_PRODUCTS.filter(p => p.identity?.status === 'active'),
      saleConfig
    );
    this._productMap = Object.fromEntries(this._products.map(p => [p.id, p]));

    console.log(
      `%c[Pteris Dev] %cDev client active — ${this._products.length} products, no network calls`,
      'color:#6366f1;font-weight:bold',
      'color:#94a3b8'
    );
  }

  // ── Initialization ──────────────────────────────────────────────────────

  async init() {
    this.index   = _buildIndex(JSON.parse(JSON.stringify(this._products)));
    this.version = this.index.version;
    console.log('[Pteris Dev] Index built:', this.index.productCount, 'products,',
      Object.keys(this.index.categories).length, 'categories,',
      Object.keys(this.index.collections).length, 'collections');
    return this.index;
  }

  // ── Products ─────────────────────────────────────────────────────────────

  async getProduct(productId) {
    const product = this._productMap[productId];
    if (!product) throw new Error(`[Pteris Dev] Product not found: ${productId}`);
    return JSON.parse(JSON.stringify(product)); // return a fresh copy
  }

  async getProducts(productIds) {
    return Promise.all(productIds.map(id => this.getProduct(id)));
  }

  // ── Categories ───────────────────────────────────────────────────────────

  getCategoryInfo(categoryPath) {
    return this.index?.categories?.[categoryPath] || null;
  }

  async getCategory(categoryPath, batchNumber = 1) {
    const cat = this.getCategoryInfo(categoryPath);
    if (!cat) throw new Error(`[Pteris Dev] Category not found: ${categoryPath}`);
    return this._resolveBatch(categoryPath, batchNumber);
  }

  // ── Collections ──────────────────────────────────────────────────────────

  getCollectionInfo(collectionId) {
    return this.index?.collections?.[collectionId] || null;
  }

  async getCollection(collectionId, batchNumber = 1) {
    const coll = this.getCollectionInfo(collectionId);
    if (!coll) throw new Error(`[Pteris Dev] Collection not found: ${collectionId}`);
    return this._resolveBatch(`collection:${collectionId}`, batchNumber);
  }

  async _resolveBatch(key, batchNumber) {
    const safeKey = key.replace(/\//g, '-').replace(/:/g, '-');
    const batches = this.index._batches;

    // Try with -last suffix first (last batch), then without
    const batchData = batches[`${safeKey}-batch-${batchNumber}-last`]
                   || batches[`${safeKey}-batch-${batchNumber}`];

    if (!batchData) {
      // Batch doesn't exist — return empty
      return { key, batch: batchNumber, totalBatches: 1, productIds: [], products: [], isLast: true };
    }

    const products = await this.getProducts(batchData.productIds);
    return { ...batchData, products };
  }

  // ── Search ───────────────────────────────────────────────────────────────

  search(query, options = {}) {
    if (!this.index?.search) return [];
    const q = query.toLowerCase().trim();
    const maxResults = options.limit || 20;
    const results = [];

    for (const [id, entry] of Object.entries(this.index.search)) {
      const score = this._calculateSearchScore(entry, q);
      if (score > 0) results.push({ id, ...entry, score });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  _calculateSearchScore(entry, query) {
    const text = entry.text || '';
    const name = entry.name || '';
    let score = 0;
    if (name.toLowerCase() === query)             score += 100;
    else if (name.toLowerCase().startsWith(query)) score += 80;
    else if (name.toLowerCase().includes(query))   score += 60;
    if (text.includes(query)) score += 40;
    const words = query.split(/\s+/);
    const matchedWords = words.filter(w => text.includes(w)).length;
    score += (matchedWords / words.length) * 30;
    return score;
  }

  // ── Configs ──────────────────────────────────────────────────────────────

  async getConfig(name) {
    if (this.cache.has(`config_${name}`)) return this.cache.get(`config_${name}`);
    const config = DEV_CONFIGS[name];
    if (!config) throw new Error(`[Pteris Dev] Config not found: "${name}" — add it to DEV_CONFIGS in store-client.dev.js`);
    this.cache.set(`config_${name}`, config);
    return config;
  }

  // ── Live Stock ────────────────────────────────────────────────────────────

  async getLiveStock(productId) {
    const product = this._productMap[productId];
    if (!product) throw new Error(`[Pteris Dev] Product not found: ${productId}`);

    const variants = {};
    for (const v of product.variants || []) {
      variants[v.id] = {
        qty: v.stock,
        reserved: 0,
        available: v.stock,
        backorder: v.backorder || false
      };
    }
    const total = product.variants?.reduce((sum, v) => sum + (v.stock || 0), 0) ?? 0;
    return { productId, total, variants, lastUpdated: new Date().toISOString() };
  }

  // ── Checkout ──────────────────────────────────────────────────────────────

  async createCheckout(cart, customer, shipping, coupon = null) {
    // Simulate a small network delay so the SPA's loading states are testable
    await new Promise(r => setTimeout(r, 600));

    // Basic validation that mirrors the server (so the SPA's error handling is testable too)
    if (!cart?.length) throw new Error('cart is empty');
    for (const item of cart) {
      if (!item.productId || !item.variantId) throw new Error('invalid cart item');
      const product = this._productMap[item.productId];
      if (!product) throw new Error(`Product not found: ${item.productId}`);
      const variant = product.variants?.find(v => v.id === item.variantId);
      if (!variant) throw new Error(`Variant not found: ${item.variantId}`);
      const priceDiff = Math.abs((variant.price || 0) - (item.price || 0));
      if (priceDiff > 0.01) throw new Error(`Price mismatch on ${item.variantId}: expected ${variant.price}, got ${item.price}`);
    }

    const subtotal = cart.reduce((sum, i) => sum + i.price * i.qty, 0);
    const orderId  = 'dev_ord_' + Date.now().toString(36);

    // Build a self-contained mock success page
    const itemsHtml = cart.map(i => {
      const product = this._productMap[i.productId];
      const variant  = product.variants?.find(v => v.id === i.variantId);
      const img      = i.image || variant?.image || product?.media?.images?.[0]?.url || '';
      return `
        <div style="display:flex;gap:14px;align-items:center;padding:12px 0;border-bottom:1px solid #f0f0f0">
          ${img ? `<img src="${img}" style="width:60px;height:60px;object-fit:cover;border-radius:6px">` : ''}
          <div style="flex:1">
            <div style="font-weight:600;color:#1a1a2e">${i.name || product?.identity?.name}</div>
            <div style="font-size:13px;color:#666">Qty: ${i.qty} &middot; $${(i.price * i.qty).toFixed(2)}</div>
          </div>
        </div>`;
    }).join('');

    const mockPageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Dev Checkout Success</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f8fc;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .card{background:#fff;border-radius:16px;padding:40px;max-width:520px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.08)}
    .badge{background:#ecfdf5;color:#059669;font-size:12px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;padding:6px 14px;border-radius:99px;display:inline-block;margin-bottom:20px}
    h1{font-size:24px;font-weight:700;color:#1a1a2e;margin-bottom:8px}
    .meta{font-size:14px;color:#94a3b8;margin-bottom:28px}
    .items{margin-bottom:20px}
    .totals{background:#f7f8fc;border-radius:10px;padding:16px;margin-top:16px}
    .row{display:flex;justify-content:space-between;font-size:14px;padding:4px 0;color:#555}
    .row.total{font-weight:700;color:#1a1a2e;font-size:16px;padding-top:10px;margin-top:6px;border-top:1px solid #e5e7eb}
    .btn{display:block;text-align:center;background:#6366f1;color:#fff;text-decoration:none;padding:14px;border-radius:10px;font-weight:600;margin-top:24px;font-size:15px}
    .devnote{margin-top:20px;padding:14px;background:#fff7ed;border-radius:8px;font-size:12px;color:#92400e;line-height:1.6;border:1px solid #fde68a}
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">✓ Dev Mode — Order Simulated</div>
    <h1>Order Confirmed</h1>
    <div class="meta">Order ID: <strong>${orderId}</strong> &middot; ${customer?.email || ''}</div>
    <div class="items">${itemsHtml}</div>
    <div class="totals">
      <div class="row"><span>Subtotal</span><span>$${subtotal.toFixed(2)}</span></div>
      ${coupon ? `<div class="row"><span>Coupon (${coupon})</span><span style="color:#059669">applied</span></div>` : ''}
      <div class="row"><span>Shipping to ${shipping?.country || '—'}</span><span>calculated by server</span></div>
      <div class="row total"><span>Estimated Total</span><span>$${subtotal.toFixed(2)}+</span></div>
    </div>
    <a href="javascript:history.back()" class="btn">← Back to Store</a>
    <div class="devnote">
      <strong>🛠 Dev mode:</strong> No payment was processed. This page is generated locally by
      <code>store-client.dev.js</code>. Checkout validation ran successfully — cart, prices,
      and variant IDs all passed. Swap the import back to <code>store-client.js</code> when
      ready to go live.
    </div>
  </div>
</body>
</html>`;

    const blob = new Blob([mockPageHtml], { type: 'text/html' });
    const checkoutUrl = URL.createObjectURL(blob);

    console.log('[Pteris Dev] Mock checkout created:', { orderId, cart, customer, shipping, coupon, subtotal });
    return { checkoutUrl, orderId };
  }

  // ── Variant Matrix (identical to production) ─────────────────────────────

  buildVariantMatrix(product) {
    const matrix = {};
    const variants = product.variants || [];
    const optionKeys = Object.keys(variants[0]?.options || {});

    for (const v of variants) {
      const key = optionKeys.map(k => v.options[k]).join('|');
      matrix[key] = {
        id: v.id, sku: v.sku, price: v.price,
        stock: v.stock, available: (v.stock || 0) > 0 || v.backorder,
        image: v.image
      };
    }

    const availability = {};
    for (const key of optionKeys) {
      availability[key] = {};
      for (const v of variants) {
        const val = v.options[key];
        if (!availability[key][val]) availability[key][val] = [];
        availability[key][val].push(v.id);
      }
    }

    return { matrix, optionKeys, availability };
  }

  getAvailableOptions(product, selected = {}) {
    const { matrix, optionKeys } = this.buildVariantMatrix(product);
    const available = {};
    for (const key of optionKeys) available[key] = new Set();

    for (const [variantKey, variantData] of Object.entries(matrix)) {
      const parts   = variantKey.split('|');
      const options = {};
      for (let i = 0; i < optionKeys.length; i++) options[optionKeys[i]] = parts[i];

      let matches = true;
      for (const [selKey, selVal] of Object.entries(selected)) {
        if (options[selKey] !== selVal) { matches = false; break; }
      }

      if (matches && variantData.available) {
        for (const key of optionKeys) available[key].add(options[key]);
      }
    }

    const result = {};
    for (const key of optionKeys) result[key] = Array.from(available[key]);
    return result;
  }

  // ── HTML Sanitization (identical to production) ──────────────────────────

  sanitizeHtml(html) {
    if (!html) return '';
    const div = document.createElement('div');
    div.innerHTML = html;

    const dangerousTags = ['script', 'iframe', 'object', 'embed', 'style', 'form', 'base', 'link', 'meta'];
    div.querySelectorAll(dangerousTags.join(',')).forEach(el => el.remove());

    const urlAttrs = ['href', 'src', 'action', 'formaction', 'xlink:href'];
    const dangerousUrlPattern = /^\s*(javascript|data|vbscript):/i;

    div.querySelectorAll('*').forEach(el => {
      Array.from(el.attributes).forEach(attr => {
        if (attr.name.toLowerCase().startsWith('on')) { el.removeAttribute(attr.name); return; }
        if (attr.name.toLowerCase() === 'style')      { el.removeAttribute(attr.name); return; }
        if (urlAttrs.includes(attr.name.toLowerCase()) && dangerousUrlPattern.test(attr.value)) {
          el.removeAttribute(attr.name);
        }
      });
    });

    return div.innerHTML;
  }

  // ── Utility methods ───────────────────────────────────────────────────────

  getProductRef(productId)  { return this.index?.products?.[productId] || null; }
  getAllCategories()         { return this.index?.categories || {}; }
  getAllCollections()        { return this.index?.collections || {}; }
  getProductCount()         { return this.index?.productCount || 0; }

  // ── Stub cache helpers (no-ops — dev client doesn't use localStorage) ────

  _getLocalCache()  { return null; }
  _setLocalCache()  {}
  _isCacheExpired() { return true; }
  _clearOldCache()  {}
}

// CommonJS interop (same pattern as production store-client.js)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StoreClient };
}
