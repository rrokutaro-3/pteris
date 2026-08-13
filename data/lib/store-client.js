/**
 * Lean E-Commerce Data Client v2
 * Vanilla JS library for the SPA.
 *
 * Fixes in v2:
 * - Collection batch routing fixed
 * - Variant availability matrix
 * - HTML sanitization
 * - Ghost cache handling
 */

export class StoreClient {
  constructor(baseUrl, options = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiUrl = options.apiUrl || baseUrl.replace('/data', '/api');
    this.cache = new Map();
    this.index = null;
    this.version = null;
    this.options = {
      indexCacheKey: 'store_index_v2',
      indexCacheDuration: 1000 * 60 * 30,
      productCacheDuration: 1000 * 60 * 60,
      ...options
    };
  }

  // ─── Initialization ───
  async init() {
    const cached = this._getLocalCache(this.options.indexCacheKey);

    // Check if cached version matches current (avoid ghost cache)
    if (cached?.data?.version) {
      try {
        // Fetch just the version header or a tiny version file
        const versionCheck = await fetch(`${this.baseUrl}/.version?t=${Date.now()}`, { cache: 'no-store' });
        const serverVersion = versionCheck.ok ? await versionCheck.text() : null;

        if (serverVersion && cached.data.version === serverVersion) {
          this.index = cached.data;
          this.version = cached.data.version;
          console.log('[StoreClient] Using cached index:', this.version);
          return this.index;
        }
      } catch (e) {
        // Network issue, fall through to fetch
      }
    }

    const res = await fetch(`${this.baseUrl}/index.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(`Failed to load index: ${res.status}`);

    this.index = await res.json();
    this.version = this.index.version;

    this._setLocalCache(this.options.indexCacheKey, {
      data: this.index,
      timestamp: Date.now()
    });

    console.log('[StoreClient] Index loaded:', this.version);
    return this.index;
  }

  // ─── Products ───
  async getProduct(productId) {
    const cacheKey = `product_${productId}`;
    const cached = this._getLocalCache(cacheKey);
    if (cached && !this._isCacheExpired(cached.timestamp, this.options.productCacheDuration)) {
      return cached.data;
    }

    const res = await fetch(`${this.baseUrl}/products/${productId}.json?v=${this.version}`);
    if (!res.ok) throw new Error(`Product not found: ${productId}`);

    const product = await res.json();
    this._setLocalCache(cacheKey, { data: product, timestamp: Date.now() });
    return product;
  }

  async getProducts(productIds) {
    return Promise.all(productIds.map(id => this.getProduct(id)));
  }

  // ─── Categories ───
  getCategoryInfo(categoryPath) {
    return this.index?.categories?.[categoryPath] || null;
  }

  async getCategory(categoryPath, batchNumber = 1) {
    const cat = this.getCategoryInfo(categoryPath);
    if (!cat) throw new Error(`Category not found: ${categoryPath}`);

    return this._fetchBatch(categoryPath, batchNumber, cat.productIds || []);
  }

  // ─── Collections (FIXED) ───
  getCollectionInfo(collectionId) {
    return this.index?.collections?.[collectionId] || null;
  }

  async getCollection(collectionId, batchNumber = 1) {
    const coll = this.getCollectionInfo(collectionId);
    if (!coll) throw new Error(`Collection not found: ${collectionId}`);

    return this._fetchBatch(`collection:${collectionId}`, batchNumber, coll.productIds || []);
  }

  async _fetchBatch(key, batchNumber, allIds) {
    const safeKey = key.replace(/\//g, '-').replace(/:/g, '-');
    const batchSize = 24;
    const totalBatches = Math.ceil(allIds.length / batchSize) || 1;
    const isLast = batchNumber >= totalBatches;
    const suffix = isLast ? '-last' : '';

    const res = await fetch(`${this.baseUrl}/batches/${safeKey}-batch-${batchNumber}${suffix}.json?v=${this.version}`);

    if (!res.ok) {
      // Fallback: compute from index
      const start = (batchNumber - 1) * batchSize;
      const ids = allIds.slice(start, start + batchSize);
      const products = await this.getProducts(ids);
      return { key, batch: batchNumber, totalBatches, productIds: ids, products, isLast };
    }

    const batch = await res.json();
    const products = await this.getProducts(batch.productIds);
    return { ...batch, products, isLast };
  }

  // ─── Search ───
  search(query, options = {}) {
    if (!this.index?.search) return [];

    const q = query.toLowerCase().trim();
    const maxResults = options.limit || 20;
    const results = [];

    for (const [id, entry] of Object.entries(this.index.search)) {
      const score = this._calculateSearchScore(entry, q);
      if (score > 0) {
        results.push({ id, ...entry, score });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  _calculateSearchScore(entry, query) {
    const text = entry.text || '';
    const name = entry.name || '';
    let score = 0;

    if (name.toLowerCase() === query) score += 100;
    else if (name.toLowerCase().startsWith(query)) score += 80;
    else if (name.toLowerCase().includes(query)) score += 60;

    if (text.includes(query)) score += 40;

    const words = query.split(/\s+/);
    const matchedWords = words.filter(w => text.includes(w)).length;
    score += (matchedWords / words.length) * 30;

    return score;
  }

  // ─── Configs ───
  async getConfig(name) {
    if (this.cache.has(`config_${name}`)) return this.cache.get(`config_${name}`);

    const res = await fetch(`${this.baseUrl}/config/${name}.json?v=${this.version}`);
    if (!res.ok) throw new Error(`Config not found: ${name}`);

    const config = await res.json();
    this.cache.set(`config_${name}`, config);
    return config;
  }

  // ─── Live Stock ───
  async getLiveStock(productId) {
    const res = await fetch(`${this.apiUrl}/stock/${productId}`);
    if (!res.ok) throw new Error(`Stock check failed: ${res.status}`);
    return res.json();
  }

  // ─── Checkout ───
  // `shipping.method`, if set, should be a shipping profile `id` from
  // the store's shipping config (e.g. "express") — the server prefers
  // this over auto-selecting a profile by country, but only if that
  // profile actually serves the destination country (see
  // calculateShipping() in checkout.js). Omit it to let the server
  // auto-select, same as before.
  async createCheckout(cart, customer, shipping, coupon = null) {
    const res = await fetch(`${this.apiUrl}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cart, customer, shipping, coupon })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Checkout failed');
    return data;
  }

  // ─── Variant Availability Matrix ───
  /**
   * Given a product, returns which option combinations are available.
   * Prevents "ghost variant" selections.
   */
  buildVariantMatrix(product) {
    const matrix = {};
    const variants = product.variants || [];

    // Get all option keys (e.g., ["Color", "Size"])
    const optionKeys = Object.keys(variants[0]?.options || {});

    for (const v of variants) {
      const key = optionKeys.map(k => v.options[k]).join('|');
      matrix[key] = {
        id: v.id,
        sku: v.sku,
        price: v.price,
        stock: v.stock,
        available: (v.stock || 0) > 0 || v.backorder,
        image: v.image
      };
    }

    // Build per-option availability
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

  /**
   * Get available options for a given partial selection.
   * E.g., if Color=Black is selected, returns valid Sizes for Black.
   */
  getAvailableOptions(product, selected = {}) {
    const { matrix, optionKeys } = this.buildVariantMatrix(product);
    const selectedKeys = Object.keys(selected);

    const available = {};
    for (const key of optionKeys) {
      available[key] = new Set();
    }

    for (const [variantKey, variantData] of Object.entries(matrix)) {
      const parts = variantKey.split('|');
      const options = {};
      for (let i = 0; i < optionKeys.length; i++) {
        options[optionKeys[i]] = parts[i];
      }

      // Check if this variant matches current selection
      let matches = true;
      for (const [selKey, selVal] of Object.entries(selected)) {
        if (options[selKey] !== selVal) {
          matches = false;
          break;
        }
      }

      if (matches && variantData.available) {
        for (const key of optionKeys) {
          available[key].add(options[key]);
        }
      }
    }

    // Convert sets to arrays
    const result = {};
    for (const key of optionKeys) {
      result[key] = Array.from(available[key]);
    }
    return result;
  }

  // ─── Variant Groups ───

  /**
   * Returns a map of variantGroup → variant[] for a product.
   * Variants without a variantGroup are collected under the key null.
   *
   * Example output for a product with Color × Size variants:
   *   {
   *     "black": [{ id: "v-blk-s", options: { Color: "Black", Size: "S" }, ... }, ...],
   *     "white": [{ id: "v-wht-s", options: { Color: "White", Size: "S" }, ... }, ...],
   *     null:    [{ id: "v-ungrouped", ... }]  // only if any variant lacks variantGroup
   *   }
   */
  getVariantGroups(product) {
    const groups = {};
    for (const v of product.variants || []) {
      const key = v.variantGroup ?? null;
      if (!groups[key]) groups[key] = [];
      groups[key].push(v);
    }
    return groups;
  }

  /**
   * Returns the media images for a given variantGroup.
   * Also includes images where variantGroup is null/undefined (shared images
   * shown regardless of which colour/group is selected).
   *
   * Pass groupId = null to get only the shared (unattached) images.
   *
   * Example:
   *   const images = client.getMediaForGroup(product, 'black');
   *   // → all images tagged variantGroup: "black" + all with variantGroup: null
   */
  getMediaForGroup(product, groupId) {
    const images = product.media?.images || [];
    return images
      .filter(img => img.variantGroup === groupId || img.variantGroup == null)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  // ─── HTML Sanitization ───
  /**
   * Sanitizer for product description HTML.
   *
   * IMPORTANT: this is still not a substitute for a real sanitizer like
   * DOMPurify. It's meant for trusted, mostly-static product copy (the
   * kind of markup that lives in data/source/products/*.json), not
   * arbitrary user-generated content. If this store ever renders
   * customer-submitted HTML (e.g. review bodies), use DOMPurify for that
   * instead of extending this method.
   *
   * A previous version only stripped <script> tags and on* attributes.
   * That leaves several common XSS vectors open even for product-copy
   * style content:
   *   - javascript: / data: URLs in href/src (e.g. <a href="javascript:...">)
   *   - <iframe>, <object>, <embed> (arbitrary embedded content/clickjacking)
   *   - <style> / style="" (CSS-based exfiltration, e.g. background: url(...))
   *   - <form> / <base> (phishing, base-tag hijacking of relative URLs)
   * This version denylists those tags outright and strips dangerous URL
   * schemes from href/src/action attributes, in addition to the
   * script-tag and event-handler stripping already in place.
   */
  sanitizeHtml(html) {
    if (!html) return '';
    const div = document.createElement('div');
    div.innerHTML = html;

    // Remove dangerous tags outright (not just their content — some of
    // these are dangerous purely by being present, e.g. <base> or <style>).
    const dangerousTags = ['script', 'iframe', 'object', 'embed', 'style', 'form', 'base', 'link', 'meta'];
    div.querySelectorAll(dangerousTags.join(',')).forEach(el => el.remove());

    const urlAttrs = ['href', 'src', 'action', 'formaction', 'xlink:href'];
    const dangerousUrlPattern = /^\s*(javascript|data|vbscript):/i;

    const all = div.querySelectorAll('*');
    all.forEach(el => {
      const attrs = Array.from(el.attributes);
      for (const attr of attrs) {
        // Remove all event handler attributes (onclick, onerror, onload, ...)
        if (attr.name.toLowerCase().startsWith('on')) {
          el.removeAttribute(attr.name);
          continue;
        }
        // Remove inline style attributes (CSS-based exfiltration vector)
        if (attr.name.toLowerCase() === 'style') {
          el.removeAttribute(attr.name);
          continue;
        }
        // Strip javascript:/data:/vbscript: URLs from URL-bearing attributes
        if (urlAttrs.includes(attr.name.toLowerCase()) && dangerousUrlPattern.test(attr.value)) {
          el.removeAttribute(attr.name);
        }
      }
    });

    return div.innerHTML;
  }

  // ─── Cache Helpers ───
  _getLocalCache(key) {
    try {
      const raw = localStorage.getItem(`store_${key}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  _setLocalCache(key, value) {
    try {
      localStorage.setItem(`store_${key}`, JSON.stringify(value));
    } catch (e) {
      this._clearOldCache();
      try {
        localStorage.setItem(`store_${key}`, JSON.stringify(value));
      } catch {
        console.warn('[StoreClient] localStorage full');
      }
    }
  }

  _isCacheExpired(timestamp, duration) {
    return Date.now() - timestamp > duration;
  }

  _clearOldCache() {
    const keys = Object.keys(localStorage).filter(k => k.startsWith('store_'));
    keys.sort((a, b) => {
      const aTime = JSON.parse(localStorage.getItem(a))?.timestamp || 0;
      const bTime = JSON.parse(localStorage.getItem(b))?.timestamp || 0;
      return aTime - bTime;
    });
    const toRemove = Math.ceil(keys.length * 0.2);
    keys.slice(0, toRemove).forEach(k => localStorage.removeItem(k));
  }

  // ─── Utilities ───
  getProductRef(productId) {
    return this.index?.products?.[productId] || null;
  }

  getAllCategories() {
    return this.index?.categories || {};
  }

  getAllCollections() {
    return this.index?.collections || {};
  }

  getProductCount() {
    return this.index?.productCount || 0;
  }
}

// `export class StoreClient` above covers ES module usage — the
// documented `import { StoreClient } from './lib/store-client.js'`
// pattern requires a real ES export. A previous version only set
// `module.exports`, which is CommonJS syntax that's undefined in a
// browser <script type="module"> context, so that documented import
// would throw at runtime. The block below additionally supports
// requiring this file from Node/CommonJS tooling (e.g. tests, bundlers
// configured for CJS interop) without conflicting with the ES export.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StoreClient };
}
