# Pteris — Developer Documentation

> Lean e-commerce engine. Cloudflare Workers API · D1 SQLite · Pages static hosting · Stripe · Resend.

---

## Table of Contents

1. [How It Works — The Big Picture](#1-how-it-works--the-big-picture)
2. [Infrastructure & Services](#2-infrastructure--services)
3. [The Build Pipeline](#3-the-build-pipeline)
4. [Product Files](#4-product-files)
5. [Config Files](#5-config-files)
6. [The StoreClient Library](#6-the-storeclient-library)
7. [Building Your SPA](#7-building-your-spa)
8. [The API — Complete Reference](#8-the-api--complete-reference)
9. [Admin API Reference](#9-admin-api-reference)
10. [The Database — D1 Schema](#10-the-database--d1-schema)
11. [Checkout Flow — End to End](#11-checkout-flow--end-to-end)
12. [Multi-Store Setup](#12-multi-store-setup)
13. [Asset Storage](#13-asset-storage)
14. [Email (Resend)](#14-email-resend)
15. [Migrating an Existing SPA](#15-migrating-an-existing-spa)

---

## 1. How It Works — The Big Picture

Pteris splits e-commerce into two parts: **static** and **live**.

**Static** (served from Cloudflare Pages — fast, free, CDN-cached):
- Product JSON files
- A search index
- Category/collection batch files
- Config files (shipping rules, tax rules, menus, coupons, store settings)
- Your SPA HTML

**Live** (served from a Cloudflare Worker — runs server-side logic):
- Checkout (price validation, stock reservation, Stripe session creation)
- Stripe webhook handling (stock commit, order status, confirmation emails)
- Stock checks
- Reviews (submit + list approved; moderation is admin-only)
- Email subscriptions (subscribe / unsubscribe)
- Admin API (inventory, orders, reviews, subscribers, coupons, stats)

Your SPA runs in the browser. It fetches static files directly from Pages (fast, cached), and only calls the Worker for real-time operations like checkout and stock checks.

```
Browser SPA
  │
  ├── GET /index.json          → Cloudflare Pages (static)
  ├── GET /products/{id}.json  → Cloudflare Pages (static)
  ├── GET /config/{name}.json  → Cloudflare Pages (static)
  │
  ├── POST /api/checkout            → Cloudflare Worker (live)
  ├── GET  /api/stock/{id}          → Cloudflare Worker (live)
  ├── POST /api/reviews             → Cloudflare Worker (live)
  ├── GET  /api/reviews/{productId} → Cloudflare Worker (live)
  ├── POST /api/subscribe           → Cloudflare Worker (live)
  ├── GET|POST /api/unsubscribe     → Cloudflare Worker (live)
  └── /api/admin/*                  → Cloudflare Worker (live, auth required)
```

The D1 database (SQLite) is only touched by the Worker — never directly from the browser. It stores live data: inventory quantities, orders, price verification table, reservations, coupon usage.

---

## 2. Infrastructure & Services

### What you need

| Service | Purpose | Cost |
|---|---|---|
| Cloudflare (free) | Workers, D1, Pages | Free tier covers most stores |
| Stripe | Payment processing | No monthly fee; ~2.9% + 30¢ per transaction |
| Resend | Transactional email | Free up to 3,000 emails/month |
| GitHub | Repo + CI/CD (Actions) | Free |

Optional:
- **Cloudflare R2** — asset storage (10 GB free), for product images and admin media uploads
- **Hugging Face** — overflow asset storage (free) when R2 approaches limit

### Cloudflare API token permissions

When creating your API token (`My Profile → API Tokens → Create Custom Token`):

| Permission | Required? |
|---|---|
| Workers Scripts: Edit | Always |
| Workers D1: Edit | Always |
| Pages: Edit | Always |
| Account Settings: Read | Always |
| Workers R2 Storage: Edit | Only if using R2 for media uploads |

> `setup.sh` uses this token to provision infrastructure (create D1, deploy Worker, deploy Pages, create R2 bucket). At runtime, the live Worker accesses R2 via its binding — your API token is never used by the deployed store itself.

### How they connect

```
GitHub Actions (build pipeline)
    │
    ├── Writes static files → Cloudflare Pages
    └── Writes prices/stock → Cloudflare D1 (via REST API)

Cloudflare Worker
    ├── Reads/writes → D1
    ├── Creates sessions → Stripe API
    └── Sends emails → Resend API

Stripe
    └── Sends webhook events → Worker /api/webhook/stripe
```

---

## 3. The Build Pipeline

Every time you push to `main` (or on a 6-hour schedule), GitHub Actions runs this sequence:

```
Step 1 — sync-stock     Pull live inventory from D1 → update source product JSON files
Step 2 — build-products Read source JSON → apply sale pricing → write to data/products/
Step 3 — sync-prices    Read built products → push prices (incl. sale prices) to D1
Step 4 — build-index    Generate index.json + paginated batch files
Step 5 — build-configs  Validate required configs exist + stamp with build version
         → Deploy to Cloudflare Pages
```

**Why this order matters:** Step 3 (`sync-prices`) reads the output of Step 2 (`build-products`). If you ran them in reverse, D1 would always have last build's prices. Step 1 runs first so built product files reflect real stock levels from D1.

### Running builds manually

```bash
npm run build                # Full pipeline (all 5 steps)
npm run build:products       # Only rebuild product files
npm run build:index          # Only rebuild index.json
npm run build:configs        # Only validate/stamp configs
npm run sync:stock           # Only pull stock from D1
npm run sync:prices          # Only push prices to D1
```

Requires `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `D1_DATABASE_ID` in your environment (set as GitHub Secrets for CI, or in your shell for local runs).

---

## 4. Product Files

### Where they live

```
data/source/products/   ← you edit these
data/products/          ← build output (don't edit directly)
```

Each product is a single JSON file named `{product-id}.json` (e.g. `p-8392.json`).

### Full product structure

```json
{
  "id": "p-8392",
  "type": "physical",

  "identity": {
    "name": "Silk Mini Dress — Midnight",
    "slug": "silk-mini-dress-midnight",
    "sku": "DRESS-8392",
    "barcode": "1234567890123",
    "brand": "Your Brand",
    "status": "active"
  },

  "pricing": {
    "currency": "USD",
    "price": 89.00,
    "compareAtPrice": 120.00,
    "costPrice": 45.00,
    "taxClass": "standard"
  },

  "description": {
    "short": "Luxurious silk mini dress for evening wear.",
    "full": "<p>Full HTML description. Safe tags only.</p>",
    "highlights": ["100% Silk", "Mini length", "Dry clean only"]
  },

  "categories": ["dresses", "dresses/mini-dresses", "new-arrivals"],
  "tags": ["new-arrival", "silk", "evening", "black", "luxury"],

  "attributes": [
    { "name": "Material", "value": "100% Silk", "group": "fabric", "visible": true, "filterable": true },
    { "name": "Fit", "value": "Slim", "group": "fit", "visible": true, "filterable": true }
  ],

  "variants": [
    {
      "id": "v-8392-blk-s",
      "sku": "8392-BLK-S",
      "options": { "Color": "Black", "Size": "S" },
      "variantGroup": "black",
      "price": 89.00,
      "weight": 0.3,
      "image": "https://cdn.yourbrand.com/products/p-8392/blk.webp",
      "stock": 12,
      "lowStockThreshold": 3,
      "backorder": false
    },
    {
      "id": "v-8392-blk-m",
      "sku": "8392-BLK-M",
      "options": { "Color": "Black", "Size": "M" },
      "variantGroup": "black",
      "price": 89.00,
      "weight": 0.3,
      "image": "https://cdn.yourbrand.com/products/p-8392/blk.webp",
      "stock": 8,
      "lowStockThreshold": 3,
      "backorder": false
    },
    {
      "id": "v-8392-red-s",
      "sku": "8392-RED-S",
      "options": { "Color": "Red", "Size": "S" },
      "variantGroup": "red",
      "price": 89.00,
      "weight": 0.3,
      "image": "https://cdn.yourbrand.com/products/p-8392/red.webp",
      "stock": 3,
      "lowStockThreshold": 3,
      "backorder": true
    }
  ],

  "media": {
    "images": [
      { "url": "https://cdn.../front.webp", "alt": "Front view", "type": "image", "order": 1, "variantGroup": null },
      { "url": "https://cdn.../blk-1.webp", "alt": "Black — front", "type": "image", "order": 1, "variantGroup": "black" },
      { "url": "https://cdn.../blk-2.webp", "alt": "Black — back",  "type": "image", "order": 2, "variantGroup": "black" },
      { "url": "https://cdn.../red-1.webp", "alt": "Red — front",   "type": "image", "order": 1, "variantGroup": "red" },
      { "url": "https://cdn.../red-2.webp", "alt": "Red — back",    "type": "image", "order": 2, "variantGroup": "red" }
    ],
    "videos": [
      { "url": "https://cdn.../vid-1.mp4", "thumbnail": "https://cdn.../vid-1-thumb.webp", "order": 1 }
    ]
  },

  "ugc": [
    { "platform": "tiktok", "url": "https://tiktok.com/...", "thumbnail": "...", "username": "@sarah" },
    { "platform": "instagram", "url": "https://instagram.com/...", "thumbnail": "...", "username": "@mike" }
  ],

  "relations": {
    "related": ["p-8391", "p-8405"],
    "upsells": ["p-9001"],
    "crossSells": ["p-9002", "p-9003"]
  },

  "shipping": {
    "profile": "standard",
    "weight": 0.3,
    "dimensions": { "l": 30, "w": 20, "h": 5, "unit": "cm" },
    "requiresShipping": true,
    "allowedCountries": ["US", "CA"],
    "blockedCountries": [],
    "handlingDays": { "min": 1, "max": 3 },
    "shipsFrom": { "country": "US", "city": "Los Angeles" },
    "note": "Optional product-level shipping note"
  },

  "sizeGuide": {
    "title": "Dress size guide",
    "unit": "cm",
    "unitAlternates": ["in"],
    "note": "When in doubt, size up.",
    "fitNotes": ["Slim fit through the waist"],
    "columns": ["Size", "Bust", "Waist", "Hip"],
    "rows": [
      { "Size": "S", "Bust": "84", "Waist": "66", "Hip": "90" },
      { "Size": "M", "Bust": "88", "Waist": "70", "Hip": "94" }
    ],
    "howToMeasure": [
      { "label": "Bust", "text": "Fullest part of the chest." }
    ],
    "links": []
  },

  "sourcing": {
    "sources": [
      { "name": "Supplier A", "url": "https://supplier.example/item/123" }
    ],
    "links": [
      { "label": "Packaging video", "url": "https://..." }
    ],
    "notes": "Prefer first source."
  },

  "seo": {
    "title": "Silk Mini Dress — Midnight | Your Brand",
    "description": "Shop the Silk Mini Dress in Midnight...",
    "keywords": ["silk dress", "mini dress"],
    "ogImage": "https://cdn.../og.webp",
    "canonical": "/product/silk-mini-dress-midnight",
    "structuredData": { "@context": "https://schema.org", "@type": "Product", "..." }
  },

  "meta": {
    "createdAt": "2026-08-01T00:00:00Z",
    "updatedAt": "2026-08-08T14:30:00Z",
    "publishedAt": "2026-08-01T00:00:00Z"
  }
}
```

**Size guide:** optional on the product. SPA should use `product.sizeGuide` when present, otherwise fall back to `config/size-guide.json` (`default` / `byCategory` / `byTag`). Same object shape in both places.

**Sourcing:** optional dropship/ops links. At checkout the Worker snapshots `sourcing` onto each order line item (frozen for admin). Not used for pricing.

**Product shipping countries:** ISO 3166-1 alpha-2. If `allowedCountries` is non-empty, only those destinations are accepted; else `blockedCountries` is applied.

### Key fields explained

**`status`** — controls visibility:
- `"active"` — built, indexed, priced in D1, fully purchasable
- `"draft"` — skipped entirely by the build pipeline; not published, not purchasable
- `"archived"` — same as draft; gone from the store

**`categories`** — array of slash-delimited paths. A product can be in multiple categories. The build automatically creates parent categories from paths:
```json
["dresses", "dresses/mini-dresses"]
// → creates: "dresses" category and "dresses/mini-dresses" subcategory
```

**`variants`** — at least one required. The `options` object defines which dimension each variant represents. Option key names become the UI selectors (Color, Size, etc.). All variants at the same product `id` must share the same option keys.

**`variantGroup`** — optional string on each variant. Groups variants that share the same colour (or other primary dimension) so media images can reference the group rather than individual variant IDs. For example, Black XS, Black S, Black M, and Black L would all carry `"variantGroup": "black"`, and media images tagged `"variantGroup": "black"` apply to all of them. Set to `null` (or omit) for shared/neutral images shown regardless of selection. Use `client.getVariantGroups(product)` to enumerate groups and `client.getMediaForGroup(product, groupId)` to retrieve the correct images when the customer switches colour.

**`weight`** — in kilograms. Used for shipping calculation server-side. The client cannot override this — the server pulls weight from D1 (synced from your product files at build time).

**`compareAtPrice`** — if set, shown as a strikethrough "was" price alongside the current price.

**`backorder`** — if `true` on a variant, it's still orderable even when `stock` is 0.

### Adding a product

1. Create `data/source/products/p-XXXX.json` with `"status": "active"`
2. Set at least one variant with a valid `price`, `stock`, `sku`, and `id`
3. Push to main — the build runs automatically, products are seeded into D1 inventory

> **First time only:** run `node scripts/seed-inventory.js` to bootstrap D1 inventory from your source files. After that, the build pipeline keeps them in sync automatically.

### Sale pricing

Sales are configured in `data/config/sale.json` (see Config Files section). When a sale is active, the build:
- Applies the discount to each variant price
- Preserves the original price as `variant.originalPrice`
- Syncs both to D1 so checkout charges the correct sale price

---

## 5. Config Files

Config files live at `data/config/` and are deployed to `config/` on your Pages site. Your SPA fetches them via `StoreClient.getConfig(name)`. They're the mechanism for changing content without touching HTML — think of them as a lightweight CMS layer.

**Available configs:**

| File | Purpose |
|---|---|
| `store.json` | Brand name, currency, contact info, social links, feature flags, notification banner |
| `menus.json` | Nav structure — main, footer, mobile, social |
| `shipping.json` | Shipping profiles and rates (also used by checkout for calculations) |
| `tax.json` | Tax rules by country/state (also used by checkout) |
| `coupons.json` | Discount codes (also used by checkout for validation) |
| `sale.json` | Global sale configuration (used at build time) |

You can add your own config files — just drop a JSON file in `data/config/` and fetch it by name.

---

### `store.json`

Controls global brand settings. Your SPA reads this once at init.

```json
{
  "name": "Your Brand",
  "url": "https://yourbrand.pages.dev",
  "currency": "USD",
  "language": "en",
  "timezone": "America/Los_Angeles",

  "features": {
    "reviews": true,
    "wishlist": true,
    "guestCheckout": true,
    "backorders": false,
    "quickView": true,
    "sizeGuide": true
  },

  "notifications": {
    "banner": {
      "active": true,
      "text": "Free shipping on orders over $75",
      "link": "/page/shipping",
      "bgColor": "#000000",
      "textColor": "#ffffff",
      "dismissible": true
    }
  },

  "contact": {
    "email": "hello@yourbrand.com",
    "returnsEmail": "returns@yourbrand.com",
    "supportEmail": "support@yourbrand.com",
    "phone": "+1-555-123-4567",
    "address": "123 Fashion Ave, New York, NY 10001"
  },

  "social": {
    "instagram": "https://instagram.com/yourbrand",
    "tiktok": "https://tiktok.com/@yourbrand"
  }
}
```

**SPA usage:**
```js
const store = await client.getConfig('store');
document.title = store.name;

if (store.notifications.banner.active) {
  showBanner(store.notifications.banner.text, store.notifications.banner.link);
}

// Feature flags — conditionally render UI
if (store.features.reviews) renderReviewsSection();
if (store.features.wishlist) renderWishlistButton();
```

---

### `menus.json`

Navigation structure. Four sections: `main`, `footer`, `mobile`, `social`.

```json
{
  "main": [
    {
      "id": "shop",
      "label": "Shop",
      "url": "/category/all",
      "children": [
        { "id": "dresses", "label": "Dresses", "url": "/category/dresses", "image": "https://cdn.../nav/dresses.webp" },
        { "id": "sale",    "label": "Sale",    "url": "/collection/sale",   "badge": "Up to 50% Off", "highlight": true }
      ]
    },
    { "id": "new-in", "label": "New In", "url": "/collection/new-arrivals" }
  ],
  "footer": [
    {
      "title": "Shop",
      "links": [
        { "label": "New Arrivals", "url": "/collection/new-arrivals" },
        { "label": "Sale",         "url": "/collection/sale" }
      ]
    }
  ],
  "mobile": [
    { "id": "home",  "label": "Home",  "url": "/",      "icon": "home" },
    { "id": "shop",  "label": "Shop",  "url": "/category/all", "icon": "grid" },
    { "id": "cart",  "label": "Cart",  "url": "/cart",  "icon": "bag", "badge": "cart-count" }
  ],
  "social": [
    { "platform": "instagram", "url": "https://instagram.com/yourbrand", "icon": "instagram" }
  ]
}
```

**SPA usage:**
```js
const menus = await client.getConfig('menus');

// Render main nav
menus.main.forEach(item => {
  const el = renderNavItem(item.label, item.url);
  if (item.highlight) el.classList.add('highlight');
  if (item.children) renderDropdown(item.children);
});

// Render footer
menus.footer.forEach(section => {
  renderFooterColumn(section.title, section.links);
});

// Render social icons
menus.social.forEach(link => {
  renderSocialIcon(link.platform, link.url);
});
```

---

### `shipping.json`

Defines shipping profiles with weight-tiered rates per country. Used by the checkout server for calculation — but your SPA can also fetch it to show estimated rates or display shipping options to the customer.

```json
{
  "profiles": [
    {
      "id": "standard",
      "name": "Standard Shipping",
      "deliveryTime": "5-7 business days",
      "freeThreshold": 75.00,
      "rates": [
        { "name": "Light",    "minWeight": 0,   "maxWeight": 0.5, "price": 4.99,  "countries": ["US", "CA"] },
        { "name": "Standard", "minWeight": 0.5, "maxWeight": 2.0, "price": 7.99,  "countries": ["US", "CA"] },
        { "name": "Heavy",    "minWeight": 2.0, "maxWeight": 10.0,"price": 12.99, "countries": ["US", "CA"] }
      ]
    },
    {
      "id": "express",
      "name": "Express Shipping",
      "deliveryTime": "2-3 business days",
      "freeThreshold": null,
      "rates": [
        { "name": "Express", "minWeight": 0, "maxWeight": 5.0, "price": 15.99, "countries": ["US"] }
      ]
    },
    {
      "id": "international",
      "name": "International Shipping",
      "deliveryTime": "10-20 business days",
      "freeThreshold": null,
      "rates": [
        { "name": "International",       "minWeight": 0,   "maxWeight": 2.0,  "price": 24.99, "countries": ["GB", "DE", "FR", "AU"] },
        { "name": "International Heavy", "minWeight": 2.0, "maxWeight": 10.0, "price": 39.99, "countries": ["GB", "DE", "FR", "AU"] }
      ]
    }
  ],
  "defaultProfile": "standard",
  "origin": { "country": "US", "zip": "10001" }
}
```

**Weight is in kilograms. Countries are ISO 3166-1 alpha-2 codes (uppercase).**

A customer ordering from Germany automatically matches the `international` profile because `"DE"` appears in that profile's country lists. The server picks the correct profile by destination country — you don't configure this per-order.

**Free shipping:** If a profile has `freeThreshold` set and the order subtotal meets or exceeds it, shipping is free for that profile regardless of weight.

**SPA usage — showing shipping options:**
```js
const shippingConfig = await client.getConfig('shipping');

// Show available methods for a given country
const country = 'US';
const availableProfiles = shippingConfig.profiles.filter(p =>
  p.rates.some(r => !r.countries || r.countries.includes(country))
);

availableProfiles.forEach(profile => {
  renderShippingOption(profile.id, profile.name, profile.deliveryTime);
});

// Then pass the chosen profile ID to checkout:
await client.createCheckout(cart, customer, { ...address, method: 'express' });
```

---

### `tax.json`

Tax rules matched by country and optionally state. Used by checkout server-side only — you don't need to compute tax in your SPA (it's calculated server-side and shown as a line item in Stripe checkout).

```json
{
  "defaultRate": 0.00,
  "includedInPrice": false,
  "rules": [
    { "country": "US", "state": "CA", "rate": 0.0725, "included": false, "name": "California Sales Tax" },
    { "country": "US", "state": "NY", "rate": 0.08,   "included": false, "name": "New York Sales Tax" },
    { "country": "GB",                "rate": 0.20,   "included": true,  "name": "UK VAT" },
    { "country": "DE",                "rate": 0.19,   "included": true,  "name": "German VAT" }
  ]
}
```

- `"included": true` — tax is already baked into the price (VAT style). Checkout extracts it from the subtotal, shows it informatively, doesn't add it on top.
- `"included": false` — tax is added on top of the subtotal (US sales tax style).
- `defaultRate` — applied to countries/states with no specific rule. `0.00` means tax-free by default.

---

### `coupons.json`

Discount codes. Used by checkout server-side for validation. Your SPA just passes the code string.

```json
{
  "active": ["WELCOME10", "FREESHIP", "VIP20"],
  "codes": {
    "WELCOME10": {
      "type": "percentage",
      "value": 10,
      "minOrder": 0,
      "usageLimit": null,
      "maxDiscount": 50.00,
      "expires": null,
      "description": "10% off for new customers"
    },
    "FREESHIP": {
      "type": "fixed",
      "value": 7.99,
      "minOrder": 50.00,
      "usageLimit": null,
      "maxDiscount": null,
      "expires": null,
      "description": "Covers standard shipping on orders over $50"
    },
    "VIP20": {
      "type": "percentage",
      "value": 20,
      "minOrder": 100.00,
      "usageLimit": 500,
      "maxDiscount": 100.00,
      "expires": "2026-12-31T23:59:59Z",
      "description": "VIP 20% off, max $100 discount"
    }
  }
}
```

- `active` — only codes in this array are valid; add a code to `codes` but not `active` to prepare it without activating it
- `type: "percentage"` — discounts by a percentage of the subtotal
- `type: "fixed"` — discounts by a flat dollar amount (capped at subtotal)
- `maxDiscount` — caps the discount amount for percentage coupons
- `usageLimit` — total number of times the code can be used across all orders (`null` = unlimited)
- `expires` — ISO 8601 timestamp after which the code is invalid

**SPA usage:**
```js
// Just pass the code string at checkout — server handles all validation
try {
  const result = await client.createCheckout(cart, customer, shipping, 'WELCOME10');
} catch (e) {
  if (e.message.includes('expired')) showError('This coupon has expired.');
  else if (e.message.includes('min_order')) showError('Minimum order not met for this coupon.');
  else showError('Invalid coupon code.');
}
```

---

### `sale.json`

Configures a global sale event. Applied at **build time** — not real-time. When active, the build pipeline applies discounts to matching products and syncs the sale prices to D1.

```json
{
  "active": true,
  "saleName": "Summer Sale 2026",
  "startDate": "2026-07-01T00:00:00Z",
  "endDate": "2026-07-31T23:59:59Z",
  "rules": [
    { "productId": "p-8392", "discountType": "percentage", "discountValue": 20 },
    { "tag": "sale",         "discountType": "percentage", "discountValue": 15 },
    { "category": "dresses", "discountType": "fixed",      "discountValue": 10 }
  ],
  "badgeText": "SALE",
  "badgeColor": "#ff0000",
  "badgeTextColor": "#ffffff"
}
```

- Rules match in order: `productId` → `tag` → `category`
- `discountType: "percentage"` — percentage off the base price
- `discountType: "fixed"` — fixed dollar amount off; proportionally applied to variants
- Category matching is prefix-based: `"dresses"` matches `"dresses"` and `"dresses/mini-dresses"`
- `startDate`/`endDate` are checked at build time — if today is outside the window, no discount is applied even if `active: true`

**To end a sale:** set `"active": false` and push. The next build reverts all prices.

---

### Custom config files

You can add any config file. Example — a homepage layout config:

```json
// data/config/home.json
{
  "hero": {
    "title": "New Summer Collection",
    "subtitle": "Fresh styles, just dropped.",
    "cta": "Shop Now",
    "ctaUrl": "/collection/new-arrivals",
    "image": "https://cdn.yourbrand.com/hero/summer.webp"
  },
  "featuredCollections": [
    { "id": "new-arrivals", "label": "New In", "image": "https://cdn...." },
    { "id": "sale",         "label": "Sale",   "image": "https://cdn...." }
  ],
  "bannerStrips": [
    "Free shipping over $75",
    "Easy 30-day returns",
    "New drops every Friday"
  ]
}
```

```js
// In your SPA
const home = await client.getConfig('home');
renderHero(home.hero);
home.featuredCollections.forEach(renderCollectionCard);
home.bannerStrips.forEach(addBannerStrip);
```

---

## 6. The StoreClient Library

`StoreClient` is the JavaScript library your SPA uses to talk to the backend. Import it once, initialize it, and use it everywhere. You don't write API fetch calls manually.

### Setup

```html
<script type="module">
  import { StoreClient } from '/lib/store-client.js';

  const client = new StoreClient(
    'https://yourbrand.pages.dev',         // Your Pages URL (static files)
    { apiUrl: 'https://lean-store-api.yourname.workers.dev/api' }  // Your Worker URL
  );

  await client.init();  // Loads index.json, sets up cache
</script>
```

Or with `store-config.js` for runtime configuration:
```html
<script src="/store-config.js"></script>  <!-- sets window.__STORE_URL__ and window.__API_URL__ -->
<script type="module">
  import { StoreClient } from '/lib/store-client.js';
  const STORE_URL = window.__STORE_URL__ || window.location.origin;
  const API_URL   = window.__API_URL__   || 'https://lean-store-api.yourname.workers.dev/api';
  const client = new StoreClient(STORE_URL, { apiUrl: API_URL });
  await client.init();
</script>
```

---

### `client.init()`

Loads the product index. Must be called before using any other method. Returns the index object.

```js
const index = await client.init();
// index.products    → { [productId]: { name, price, image, categories, tags, inStock } }
// index.categories  → { [categoryPath]: { name, productIds, heroImage, description } }
// index.collections → { [collectionId]: { name, productIds } }
// index.search      → { [productId]: { text, name, price, image, inStock } }
// index.version     → build timestamp string
```

The index is cached in `localStorage` for 30 minutes. On reload it checks a `.version` file to avoid serving stale cache.

---

### Products

```js
// Get a single product by ID
const product = await client.getProduct('p-8392');

// Get multiple products
const products = await client.getProducts(['p-8392', 'p-8391', 'p-8405']);

// Get a lightweight product reference from the index (no network call)
const ref = client.getProductRef('p-8392');
// ref → { name, price, image, categories, tags, inStock }
```

---

### Categories & Collections

```js
// Get category info from the index (no network call)
const info = client.getCategoryInfo('dresses/mini-dresses');
// info → { name, productIds, heroImage, description }

// Get a category's products (first batch of 24)
const batch = await client.getCategory('dresses', 1);
// batch → { key, batch, totalBatches, productIds, products, isLast }

// Paginate
if (!batch.isLast) {
  const nextBatch = await client.getCategory('dresses', 2);
}

// Collections work the same way
const collInfo = client.getCollectionInfo('new-arrivals');
const collBatch = await client.getCollection('new-arrivals', 1);
```

**Built-in collection IDs:**
- `"new-arrivals"` — products published in the last 30 days
- `"bestsellers"` — placeholder (populate via admin/data tools)
- `"sale"` — products with `pricing.sale.active === true`

**Custom collections** — define any collection you need in `data/config/collections.json`. The build merges them alongside the three built-in ones. Use any ID string as the key; it becomes the `collectionId` you pass to `client.getCollection()`.

```json
// data/config/collections.json
{
  "lookbook-summer-26": {
    "name": "Summer Lookbook",
    "description": "Our summer 2026 editorial picks.",
    "heroImage": "https://cdn.yourbrand.com/lookbook/summer-hero.webp",
    "productIds": ["p-8392", "p-pp-001", "p-gia-001"]
  },
  "staff-picks": {
    "name": "Staff Picks",
    "productIds": ["p-pp-003", "p-8392"]
  }
}
```

Product IDs that don't exist in the built catalog (draft, archived, or missing) are silently filtered out at build time. The collection is then available exactly like any built-in one:

```js
const batch = await client.getCollection('lookbook-summer-26', 1);
```

---

### Search

Client-side search against the pre-built search index. No network call after `init()`.

```js
const results = client.search('silk dress', { limit: 10 });
// results → [{ id, name, price, image, inStock, score }, ...]
// Sorted by relevance score (exact name match scores highest)
```

---

### Configs

```js
const store    = await client.getConfig('store');
const menus    = await client.getConfig('menus');
const shipping = await client.getConfig('shipping');
const home     = await client.getConfig('home');    // any custom config
```

Configs are in-memory cached for the page lifetime (not `localStorage`). One network fetch per config name per page load.

---

### Stock

```js
// Live stock check from D1 (real-time, not cached)
const stock = await client.getLiveStock('p-8392');
// stock → {
//   productId: 'p-8392',
//   total: 23,
//   variants: {
//     'v-8392-blk-s': { qty: 12, reserved: 2, available: 10, backorder: false },
//     'v-8392-red-s': { qty: 3,  reserved: 0, available: 3,  backorder: true  }
//   },
//   lastUpdated: '2026-08-10T...'
// }
```

Use this when you need real-time availability (e.g. right before checkout or on a product page that needs accurate inventory). Static product files show stock as of the last build; this shows the current live count.

---

### Checkout

```js
const result = await client.createCheckout(
  cart,        // array of cart items (see below)
  customer,    // customer info object
  shipping,    // shipping address + optional method
  coupon,      // optional coupon code string
  note         // optional customer note (gift message, delivery instructions)
);
// result → { checkoutUrl: 'https://checkout.stripe.com/...', orderId: 'ord_...' }
// Redirect to result.checkoutUrl
```

`note` is optional (max 1000 chars, HTML stripped). Stored on the order as `customerNote` (separate from admin internal `notes`).

Per-product shipping restrictions (`shipping.allowedCountries` / `blockedCountries` on the product JSON, ISO 3166-1 alpha-2) are enforced server-side. If a line cannot ship to the destination country, checkout returns `400` with `Product cannot be shipped to this destination`.

Product `sourcing` (dropship links/notes) is **snapshotted** onto each order line item at checkout for admin fulfillment. The product file remains the catalog source of truth; the order copy is frozen.

---

### Reviews

```js
// Approved reviews only (public)
const { reviews, count } = await client.getReviews('p-8392');

// Submit — always lands in pending moderation
await client.submitReview({
  productId: 'p-8392',
  customerName: 'Jane',
  rating: 5,
  title: 'Great fit',
  body: 'Wore it to dinner — fabric feels premium.'
});
// → { success: true, id: '…', status: 'pending', message: '…' }
```

Review **bodies are user-generated**. Escape or sanitize with DOMPurify when rendering; do not use `client.sanitizeHtml()` (that helper is for trusted product copy only).

---

### Email subscriptions

```js
await client.subscribe('jane@example.com', 'footer');
// → { success: true, email: 'jane@example.com', alreadySubscribed?: boolean, … }

await client.unsubscribe({ email: 'jane@example.com' });
// or token from an email link:
await client.unsubscribe({ token: '…' });
```

**Cart item shape:**
```js
{
  productId: 'p-8392',          // required
  variantId: 'v-8392-blk-s',   // required
  qty: 2,                       // required: positive integer, max 100
  price: 89.00,                 // required: must match server price within $0.01
  name: 'Silk Mini Dress — Midnight',  // shown in Stripe checkout
  image: 'https://cdn...'       // optional: shown in Stripe checkout
}
```

**Customer object:**
```js
{
  email: 'jane@example.com',    // required
  name: 'Jane Smith',           // shown in confirmation email
  firstName: 'Jane',
  lastName: 'Smith'
}
```

**Shipping object:**
```js
{
  country: 'US',                // required: ISO 3166-1 alpha-2 (case-insensitive, normalized server-side)
  state: 'CA',                  // recommended for US tax accuracy
  address1: '123 Main St',
  address2: 'Apt 4B',
  city: 'Los Angeles',
  zip: '90001',
  method: 'express'             // optional: shipping profile ID; omit to auto-select by country
}
```

---

### Variant Matrix

Prevents ghost variant selections — if Color=Black and Size=XL doesn't exist, XL is shown as unavailable when Black is selected.

```js
const { matrix, optionKeys, availability } = client.buildVariantMatrix(product);

// Get currently available options given a partial selection
const available = client.getAvailableOptions(product, { Color: 'Black' });
// available → { Color: ['Black', 'Red'], Size: ['S', 'M'] }
// (only sizes that exist for Black are included)

// Render options
optionKeys.forEach(key => {
  const values = [...new Set(product.variants.map(v => v.options[key]))];
  values.forEach(val => {
    const isAvailable = available[key].includes(val);
    renderOptionButton(key, val, isAvailable);
  });
});
```

---

### Variant Groups

When variants share a primary dimension (e.g. colour), `variantGroup` lets you retrieve the correct media images without duplicating them across every size. See [Key fields explained](#key-fields-explained) for how to set `variantGroup` on variants and media images.

```js
// Get a map of groupId → variant[] for building a colour-swatch UI
const groups = client.getVariantGroups(product);
// groups → {
//   "black": [{ id: "v-8392-blk-s", ... }, { id: "v-8392-blk-m", ... }],
//   "red":   [{ id: "v-8392-red-s", ... }],
//   null:    [...]  // variants with no variantGroup, if any
// }

// Render colour swatches
Object.entries(groups).forEach(([groupId, variants]) => {
  if (!groupId) return; // skip ungrouped
  const swatch = renderColorSwatch(groupId, variants[0].image);
  swatch.addEventListener('click', () => onGroupSelect(groupId));
});

// When a colour swatch is selected, get the correct images
function onGroupSelect(groupId) {
  // Returns images tagged for this group + all shared images (variantGroup: null), sorted by order
  const images = client.getMediaForGroup(product, groupId);
  renderGallery(images);

  // Also pre-select the first available size within this group
  const group = groups[groupId];
  const firstAvailable = group.find(v => (v.stock || 0) > 0 || v.backorder);
  if (firstAvailable) onOptionSelect('Size', firstAvailable.options['Size']);
}
```

---

### HTML Sanitization

For rendering product description HTML safely. Strips dangerous tags, event handlers, and script URLs.

```js
document.getElementById('product-desc').innerHTML =
  client.sanitizeHtml(product.description.full);
```

> **Note:** This is safe for product copy (trusted, store-authored content). Do NOT use it to render user-submitted content like reviews. Use [DOMPurify](https://github.com/cure53/DOMPurify) for that.

---

### Utility methods

```js
client.getAllCategories()    // → { [path]: categoryInfo }
client.getAllCollections()   // → { [id]: collectionInfo }
client.getProductCount()     // → number
```

---

## 7. Building Your SPA

Your SPA is a single HTML file at `data/index.html`. It's deployed to Cloudflare Pages alongside the static catalog. A typical SPA structure:

```js
import { StoreClient } from '/lib/store-client.js';

const client = new StoreClient(STORE_URL, { apiUrl: API_URL });

async function init() {
  // 1. Load index + configs in parallel
  const [index, store, menus, home] = await Promise.all([
    client.init(),
    client.getConfig('store'),
    client.getConfig('menus'),
    client.getConfig('home')
  ]);

  // 2. Set up brand from store config
  document.title = store.name;
  renderBanner(store.notifications.banner);
  renderNav(menus.main);

  // 3. Render the current "page" based on URL or hash
  renderPage(window.location.hash || '#home');
}

async function renderPage(route) {
  if (route === '#home')              return renderHome();
  if (route.startsWith('#category/')) return renderCategory(route.split('/')[1]);
  if (route.startsWith('#product/'))  return renderProduct(route.split('/')[1]);
  if (route === '#cart')              return renderCart();
  if (route === '#checkout')          return renderCheckout();
}

window.addEventListener('hashchange', () => renderPage(window.location.hash));
init();
```

### Cart persistence

The cart lives in `localStorage`. A reasonable cart item:

```js
const cartItem = {
  productId: product.id,
  variantId: variant.id,
  qty: 1,
  price: variant.price,              // used for display and sent to checkout
  name: product.identity.name,
  variantLabel: Object.entries(variant.options).map(([k,v]) => `${k}: ${v}`).join(', '),
  image: variant.image || product.media.images[0]?.url
};
```

**Price note:** The `price` in your cart item is sent to the checkout API and validated server-side. If it doesn't match within $0.01 of the D1 price, the checkout is rejected. So always read prices from the product data — never hardcode or compute them yourself.

### Checkout integration

```js
async function submitCheckout(cart, formData) {
  const cartPayload = cart.map(item => ({
    productId: item.productId,
    variantId: item.variantId,
    qty: item.qty,
    price: item.price,       // must match D1 price
    name: item.name,
    image: item.image || null
  }));

  try {
    const result = await client.createCheckout(
      cartPayload,
      {
        email: formData.email,
        name: `${formData.firstName} ${formData.lastName}`,
        firstName: formData.firstName,
        lastName: formData.lastName
      },
      {
        country: formData.country,
        state: formData.state,
        address1: formData.address1,
        address2: formData.address2,
        city: formData.city,
        zip: formData.zip,
        method: formData.shippingMethod || undefined  // optional
      },
      formData.couponCode || null
    );

    // On success, redirect to Stripe
    window.location.href = result.checkoutUrl;
  } catch (err) {
    showError(err.message);
  }
}
```

After Stripe payment, the customer is redirected to:
- `{STORE_URL}/checkout/success?session_id=...` on success
- `{STORE_URL}/cart` on cancel

Handle the success URL in your SPA to show an order confirmation screen.

---

## 8. The API — Complete Reference

Base URL: your Worker URL (e.g. `https://lean-store-api.yourname.workers.dev`)

All endpoints return JSON. All support CORS — you can call them from any origin.

---

### `GET /api/health`

Returns API status and version.

```
Response 200:
{ "status": "ok", "version": "2.3.0" }
```

---

### `POST /api/checkout`

Creates a Stripe Checkout Session. The main purchase endpoint.

**Request body:**
```json
{
  "cart": [
    {
      "productId": "p-8392",
      "variantId": "v-8392-blk-s",
      "qty": 2,
      "price": 89.00,
      "name": "Silk Mini Dress — Midnight",
      "image": "https://cdn.yourbrand.com/products/p-8392/blk.webp"
    }
  ],
  "customer": {
    "email": "jane@example.com",
    "name": "Jane Smith"
  },
  "shipping": {
    "country": "US",
    "state": "CA",
    "address1": "123 Main St",
    "city": "Los Angeles",
    "zip": "90001",
    "method": "standard"
  },
  "coupon": "WELCOME10"
}
```

**Success response `200`:**
```json
{
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_...",
  "orderId": "ord_1720000000000_abc1"
}
```

**Error responses:**

| Status | Meaning |
|---|---|
| `400` | Missing fields, invalid qty, price mismatch, unsupported shipping country, order total below Stripe $0.50 minimum |
| `409` | Out of stock for one or more items |
| `502` | Stripe API error (payment provider failure) |

**Price mismatch `400`:**
```json
{
  "error": "Price mismatch detected",
  "productId": "p-8392",
  "variantId": "v-8392-blk-s",
  "expected": 89.00,
  "received": 79.00
}
```

**Out of stock `409`:**
```json
{
  "error": "Out of stock",
  "productId": "p-8392",
  "variantId": "v-8392-blk-s",
  "requested": 5,
  "available": 2
}
```

---

### `GET /api/stock/:productId`

Returns live inventory for a product from D1. Not cached.

**Example:** `GET /api/stock/p-8392`

**Response `200`:**
```json
{
  "productId": "p-8392",
  "total": 23,
  "variants": {
    "v-8392-blk-s": {
      "qty": 12,
      "reserved": 2,
      "available": 10,
      "backorder": false
    },
    "v-8392-blk-m": {
      "qty": 8,
      "reserved": 0,
      "available": 8,
      "backorder": false
    },
    "v-8392-red-s": {
      "qty": 3,
      "reserved": 0,
      "available": 3,
      "backorder": true
    }
  },
  "lastUpdated": "2026-08-10T12:34:56.000Z"
}
```

- `qty` — physical units in stock
- `reserved` — units held by pending checkouts (not yet paid)
- `available` — `qty - reserved` (what a customer can actually buy right now)

**Response `404`:**
```json
{ "error": "Product not found" }
```

---

### Reviews (public)

Reviews are stored in D1 only. Product source JSON is never modified. Submitted reviews are always `pending` until an admin approves them. The public list endpoint returns **approved** reviews only.

#### `POST /api/reviews`

Submit a review (no auth). Body text is plain-text sanitized server-side (HTML stripped, length-capped).

**Request body:**
```json
{
  "productId": "p-8392",
  "customerName": "Jane",
  "rating": 5,
  "title": "Great fit",
  "body": "Wore it to a dinner — fabric feels premium.",
  "images": ["https://cdn.example.com/r1.webp"]
}
```

| Field | Required | Notes |
|---|---|---|
| `productId` | yes | Must match product id pattern |
| `customerName` (or `name`) | yes | 2–80 chars after sanitize |
| `rating` | yes | Integer 1–5 |
| `title` | no | Max 120 chars |
| `body` (or `text` / `review`) | yes | Min 5, max 2000 chars |
| `images` | no | Up to 5 `http(s)` URLs |

**Success `201`:**
```json
{
  "success": true,
  "id": "…uuid…",
  "status": "pending",
  "message": "Review submitted and awaiting moderation"
}
```

#### `GET /api/reviews/:productId`

List approved reviews for a product.

```json
{
  "productId": "p-8392",
  "reviews": [
    {
      "id": "…",
      "productId": "p-8392",
      "customerName": "Jane",
      "rating": 5,
      "title": "Great fit",
      "body": "…",
      "verified": false,
      "images": [],
      "helpful": 0,
      "createdAt": "2026-08-15T…",
      "status": "approved"
    }
  ],
  "count": 1
}
```

---

### Email subscriptions (public)

Subscribers live in D1. Email is normalized to lowercase; the primary key prevents duplicates. Unsubscribing is a soft delete (`unsubscribed_at` set). Re-subscribing reactivates the same row.

#### `POST /api/subscribe`

```json
{ "email": "jane@example.com", "source": "footer" }
```

**Success `201`** (new) or **`200`** (already subscribed):
```json
{
  "success": true,
  "email": "jane@example.com",
  "alreadySubscribed": false,
  "reactivated": false,
  "message": "Subscribed successfully"
}
```

The unsubscribe token is **not** returned in the public response (only stored for email links you may send via Resend).

#### `POST /api/unsubscribe`

Body: `{ "token": "…" }` **or** `{ "email": "…" }`.

#### `GET /api/unsubscribe?token=…`

One-click unsubscribe for links in emails.

**Success:**
```json
{
  "success": true,
  "email": "jane@example.com",
  "alreadyUnsubscribed": false,
  "message": "You have been unsubscribed"
}
```

---

### `POST /api/webhook/stripe`

Stripe webhook endpoint. **Do not call this manually.** Register it in your Stripe dashboard (Developers → Webhooks). Requires the `Stripe-Signature` header.

**Events handled:**
- `checkout.session.completed` — commits stock, records order as paid, sends confirmation email
- `checkout.session.expired` — releases reserved stock, marks order as cancelled
- `payment_intent.payment_failed` — acknowledged but no action taken

---

## 9. Admin API Reference

All admin routes require:
```
Authorization: Bearer YOUR_ADMIN_API_KEY
```

Base path: `/api/admin/`

---

### Stats

#### `GET /api/admin/stats`

Dashboard summary data.

```json
{
  "products": { "total": 47 },
  "orders": {
    "today": 12,
    "thisWeek": 84,
    "thisMonth": 312
  },
  "revenue": {
    "today": 1482.50,
    "thisWeek": 9847.20,
    "thisMonth": 38291.00
  },
  "inventory": {
    "lowStock": 3
  }
}
```

Low stock threshold is 5 units available (qty − reserved ≤ 5).

---

### Inventory

#### `GET /api/admin/inventory`

List all inventory.

Query params:
- `?lowStock=true` — filter to only products with at least one low-stock variant

```json
{
  "inventory": [
    {
      "productId": "p-8392",
      "variants": {
        "v-8392-blk-s": { "qty": 12, "reserved": 2, "backorder": false },
        "v-8392-red-s": { "qty": 3,  "reserved": 0, "backorder": true  }
      },
      "lastUpdated": "2026-08-10T..."
    }
  ],
  "count": 47
}
```

#### `GET /api/admin/inventory/:productId`

Single product inventory.

```json
{
  "productId": "p-8392",
  "variants": {
    "v-8392-blk-s": { "qty": 12, "reserved": 2, "backorder": false }
  },
  "lastUpdated": "2026-08-10T..."
}
```

#### `PUT /api/admin/inventory/:productId`

Update variant quantities. Send only the variants you want to change.

```json
{
  "variants": {
    "v-8392-blk-s": { "qty": 25 },
    "v-8392-red-s": { "qty": 10, "backorder": false }
  }
}
```

Updatable fields per variant: `qty`, `reserved`, `backorder`.

Response: `{ "success": true }`

---

### Orders

#### `GET /api/admin/orders`

Paginated order list.

Query params:
- `?page=1` — page number (default: 1)
- `?limit=20` — per page (default: 20, max: 100)
- `?status=paid` — filter by status

Status values: `pending`, `paid`, `cancelled`, `refunded`, `shipped`

```json
{
  "orders": [
    {
      "id": "ord_1720000000000_abc1",
      "items": [
        {
          "productId": "p-8392",
          "variantId": "v-8392-blk-s",
          "sku": "8392-BLK-S",
          "name": "Silk Mini Dress — Midnight",
          "qty": 1,
          "price": 89.00,
          "weight": 0.3
        }
      ],
      "customer": {
        "email": "jane@example.com",
        "name": "Jane Smith"
      },
      "shipping": {
        "country": "US",
        "state": "CA",
        "address1": "123 Main St",
        "city": "Los Angeles",
        "zip": "90001"
      },
      "subtotal": 89.00,
      "shippingCost": 7.99,
      "tax": 6.45,
      "total": 103.44,
      "status": "paid",
      "stripeSessionId": "cs_live_...",
      "stripePaymentIntentId": "pi_live_...",
      "coupon": "WELCOME10",
      "webhookProcessedAt": "2026-08-10T13:00:00Z",
      "trackingNumber": null,
      "carrier": null,
      "notes": null,
      "createdAt": "2026-08-10T12:58:00Z",
      "updatedAt": "2026-08-10T13:00:00Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 312
}
```

#### `GET /api/admin/orders/:id`

Single order by ID.

#### `PATCH /api/admin/orders/:id`

Update fulfillment fields.

```json
{
  "status": "shipped",
  "trackingNumber": "1Z999AA10123456784",
  "carrier": "UPS",
  "notes": "Left at door"
}
```

Updatable fields: `status`, `trackingNumber`, `carrier`, `notes`.

Response: `{ "success": true }`

#### `POST /api/admin/orders/:id/refund`

Record a refund.

```json
{
  "amount": 89.00,
  "reason": "Customer request — wrong size"
}
```

Sets order status to `"refunded"` and records amount and reason. **Note:** this only updates the database record — you still need to issue the actual refund in the Stripe dashboard.

Response: `{ "success": true }`

---

### Reviews (moderation)

#### `GET /api/admin/reviews`

Query params:
- `?status=pending|approved|rejected` — filter by status
- `?productId=p-8392` — filter by product
- `?page=1&limit=20` — pagination (max limit 100)

```json
{
  "reviews": [ /* same shape as public list, may include pending/rejected */ ],
  "total": 12,
  "page": 1,
  "limit": 20
}
```

#### `GET /api/admin/reviews/:id`

Single review or `404`.

#### `PATCH /api/admin/reviews/:id`

```json
{ "status": "approved" }
```

Allowed: `approved`, `rejected`, `pending`.

Response: `{ "success": true, "id": "…", "status": "approved" }`

#### `DELETE /api/admin/reviews/:id`

Hard delete. Response: `{ "success": true, "id": "…" }`

---

### Subscribers

#### `GET /api/admin/subscribers`

Query params:
- `?activeOnly=true` (default) or `false` to include unsubscribed
- `?page=1&limit=50` (max 200)

```json
{
  "subscribers": [
    {
      "email": "jane@example.com",
      "subscribedAt": "2026-08-15T…",
      "unsubscribedAt": null,
      "source": "footer",
      "active": true
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 50
}
```

#### `DELETE /api/admin/subscribers/:email`

Hard delete (URL-encode the email). Response: `{ "success": true, "email": "…" }`

---

### Products (note)

#### `GET /api/admin/products`

Returns a message explaining that products are file-managed:
```json
{
  "message": "Products are managed via static JSON files in data/source/products/",
  "note": "Edit the JSON files and push to GitHub to trigger a build.",
  "adminTip": "Use GET /api/admin/inventory to manage stock levels."
}
```

Product creation/editing is done by writing JSON files and pushing to GitHub. The admin dashboard handles this by committing to the repo (via GitHub API), not by calling this endpoint.

---

### Maintenance

#### `POST /api/admin/cleanup-reservations`

Manually release expired stock reservations. Usually runs automatically at the start of each checkout, but you can trigger it explicitly.

```json
{ "cleaned": 3 }
```

#### `POST /api/admin/build`

Trigger note (informational only — not a real build trigger):
```json
{
  "message": "Build triggered",
  "instruction": "Push changes to the main branch or use GitHub Actions dispatch."
}
```

---

## 10. The Database — D1 Schema

D1 is Cloudflare's managed SQLite. It's only accessed from the Worker — never from the browser. Schema file: `src/schema/d1-schema.sql`.

### Tables

**`inventory`** — live stock quantities

```sql
product_id TEXT PRIMARY KEY
variants TEXT              -- JSON: {"v-id": {"qty": 10, "reserved": 2, "backorder": false}}
last_updated TEXT
```

One row per product. All variant quantities stored as a single JSON blob. Updated atomically via compare-and-swap to prevent race conditions under concurrent checkouts.

**`orders`** — all orders

```sql
id TEXT PRIMARY KEY        -- e.g. "ord_1720000000000_abc1"
items TEXT                 -- JSON array
customer TEXT              -- JSON object
shipping TEXT              -- JSON object
subtotal REAL
shipping_cost REAL
tax REAL
total REAL
status TEXT                -- pending | paid | cancelled | refunded | shipped
stripe_session_id TEXT
stripe_payment_intent_id TEXT
coupon TEXT
webhook_processed_at TEXT  -- idempotency marker
tracking_number TEXT
carrier TEXT
notes TEXT
refund_amount REAL
refund_reason TEXT
refunded_at TEXT
created_at TEXT
updated_at TEXT
```

**`prices`** — server-side checkout validation table

```sql
product_id TEXT
variant_id TEXT
sku TEXT
price REAL                 -- regular (pre-sale) price
compare_at_price REAL
currency TEXT
sale_active INTEGER        -- 0 or 1
sale_price REAL            -- discounted price (null when no sale)
weight REAL                -- in kg, used for shipping calculation
updated_at TEXT
PRIMARY KEY (product_id, variant_id)
```

Populated by `sync-prices.js` at build time. **Checkout always reads prices from here, never trusts the client.**

**`reviews`**

```sql
id TEXT PRIMARY KEY
product_id TEXT
customer_name TEXT
rating INTEGER             -- 1–5
title TEXT
body TEXT
verified INTEGER           -- 0 or 1
images TEXT                -- JSON array of URLs
helpful INTEGER
created_at TEXT
status TEXT                -- pending | approved | rejected
```

Indexes: `(product_id, status)`, `(status, created_at)`.  
Public `GET /api/reviews/:productId` only returns `status = 'approved'`. New submissions always insert as `pending`.

**`subscribers`** — newsletter / email list

```sql
email TEXT PRIMARY KEY     -- normalized lowercase
subscribed_at TEXT
unsubscribed_at TEXT       -- null = currently subscribed
unsubscribe_token TEXT UNIQUE
source TEXT                -- e.g. footer, checkout, popup
```

Soft-unsubscribe sets `unsubscribed_at`. Re-subscribe clears it and rotates the token. The public subscribe response never returns the token.

**`coupon_usage`**

```sql
code TEXT
order_id TEXT
customer_email TEXT
used_at TEXT
PRIMARY KEY (code, order_id)
```

**`reservations`** — TTL stock holds

```sql
id TEXT PRIMARY KEY
order_id TEXT
product_id TEXT
variant_id TEXT
qty INTEGER
expires_at TEXT            -- ISO 8601; default TTL is 30 minutes
created_at TEXT
```

Created when checkout starts, deleted when payment completes or expires. Expired reservations are cleaned up at the start of each checkout, and also via `POST /api/admin/cleanup-reservations`.

### Initial setup

```bash
# Create the schema
npx wrangler d1 execute lean-store-db --file=src/schema/d1-schema.sql

# Seed inventory from your product files
node scripts/seed-inventory.js
```

Only needed once when setting up a new store.

---

## 11. Checkout Flow — End to End

This is the full lifecycle of a purchase.

```
1. Customer fills cart in SPA
   └── Cart stored in localStorage

2. Customer submits checkout form
   └── SPA calls POST /api/checkout

3. Worker validates input
   ├── Cart item shape (productId, variantId, positive integer qty)
   ├── Prices against D1 prices table (rejects spoofed prices)
   ├── Coupon code (expiry, min order, usage limit)
   ├── Shipping profile for destination country
   └── Tax rules for country/state

4. Worker reserves stock atomically
   └── Compare-and-swap loop in D1 inventory table
       If any item is out of stock → rollback all, return 409

5. Worker creates order record in D1
   └── Status: "pending"

6. Worker creates Stripe Checkout Session
   └── Line items: products + shipping + tax − discount
       Session expires in 30 minutes (matches reservation TTL)
       Returns checkoutUrl

7. SPA redirects customer to Stripe

8. Customer pays (or abandons)

   ── PAYMENT SUCCEEDS ──────────────────────────────────────────
   9a. Stripe sends POST /api/webhook/stripe (checkout.session.completed)
   10a. Worker atomically claims order (pending → paid)
       └── Only one concurrent webhook delivery can win this
   11a. Worker commits stock: decrements qty, clears reserved
   12a. Worker records coupon usage
   13a. Worker sends confirmation email via Resend
   14a. Customer is redirected to /checkout/success?session_id=...

   ── PAYMENT ABANDONED / EXPIRED ───────────────────────────────
   9b. Stripe sends POST /api/webhook/stripe (checkout.session.expired)
   10b. Worker claims order (pending → cancelled)
   11b. Worker releases reserved stock (reserved count decremented, qty unchanged)
   12b. Customer sees cart page (cancel_url)
```

### Reservation TTL

Stock is held for 30 minutes (configurable via `RESERVATION_TTL_MINUTES` in `wrangler.toml`). If a customer starts checkout but doesn't pay within that window, Stripe expires the session and sends the `checkout.session.expired` webhook, which triggers stock release.

**Minimum is 30 minutes** — Stripe rejects any session expiry less than 30 minutes in the future. Setting `RESERVATION_TTL_MINUTES` below 30 will be automatically clamped to 30 for the Stripe session, though reservations will still expire at your configured time.

---

## 12. Multi-Store Setup

Each store is completely isolated. No shared infrastructure except optionally a Stripe account and Resend account (separate webhook endpoints/domains).

### What each store needs

| Resource | Per-store | Shared OK |
|---|---|---|
| GitHub repo | ✅ Separate | ❌ |
| Cloudflare account | ✅ Separate (or same account, different projects) | One account can host multiple |
| Cloudflare Worker | ✅ Separate deployment | Different `name` in wrangler.toml |
| Cloudflare D1 database | ✅ Separate | Never share a database |
| Cloudflare Pages project | ✅ Separate | Different project name |
| Stripe account | Either | One account with multiple webhook endpoints is fine |
| Stripe webhook endpoint | ✅ Separate URL per store | Each endpoint has its own secret |
| Resend account | Either | One account, different `from` domains |
| Resend API key | Either | Same key works if using same account |
| `ADMIN_API_KEY` | ✅ Separate secret per store | Never reuse |

### Setting up store #2

```bash
# 1. Create a new GitHub repo from the template

# 2. In the new repo, set up Cloudflare with a different project name
# Edit wrangler.toml:
name = "store2-api"                    # was "lean-store-api"

# 3. Run setup.sh — it creates a new D1 database automatically
bash setup.sh

# 4. Create a new webhook in your Stripe dashboard
#    → Endpoint URL: https://store2-api.yourname.workers.dev/api/webhook/stripe
#    → Events: checkout.session.completed, checkout.session.expired

# 5. Set secrets for the new worker (setup.sh handles these automatically,
#    but if setting them manually after the fact:)
npx wrangler secret put STRIPE_SECRET_KEY      # same or different Stripe account
npx wrangler secret put STRIPE_WEBHOOK_SECRET  # NEW secret from new webhook endpoint
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put ADMIN_API_KEY          # generate a new one

# 6. Deploy the worker
# NOTE: npm run deploy:api will refuse to deploy if wrangler.toml still has
# placeholder values. setup.sh patches these automatically. If running manually,
# ensure STORE_URL, CDN_BASE_URL, and database_id are set in wrangler.toml first.
npm run deploy:api

# 7. Deploy the site
npm run build
# (GitHub Actions handles this on push)

# 8. Seed inventory
node scripts/seed-inventory.js
```

### Stripe webhook per store

Each store must have its own webhook endpoint registered in Stripe. The webhook secret (`STRIPE_WEBHOOK_SECRET`) is unique to each endpoint. **Do not reuse webhook secrets across stores** — the signature verification will fail or, worse, cross-contaminate order processing.

If using separate Stripe accounts per store, you also have separate `STRIPE_SECRET_KEY` values.

### Resend / email per store

You can use one Resend account for multiple stores. Set different `RESEND_FROM_EMAIL` values:
```
store1: orders@brand1.com
store2: orders@brand2.com
```

Each domain must be verified in Resend. The confirmation email HTML template is in `src/api/lib/resend.js` — customize it per store by editing that file.

**No Nodemailer.** The Worker runtime is not Node.js — it has no access to the filesystem, native modules, or TCP sockets. Email must go through an HTTP API. Resend is the built-in choice; you could also swap it for Mailgun, SendGrid, or any other service with an HTTP API by modifying `src/api/lib/resend.js`.

---

## 13. Asset Storage

Product images and other media need to be hosted somewhere. The URL just goes in your product JSON — the system is CDN-agnostic.

### Options

**Cloudflare R2 (recommended for starting out)**
- 10 GB free storage, 1 million free operations/month
- Same CDN as your site — very fast
- R2 objects are served via a custom domain or a `r2.dev` subdomain
- Folder structure maps to your product file paths (e.g. `products/p-8392/1.webp`)

**Migration when R2 fills up**

When you approach 10 GB, run the asset migration script:

```bash
export HF_TOKEN=hf_xxx
export R2_BUCKET=your-store-bucket
export HF_REPO=yourusername/store-assets
export R2_ACCESS_KEY=...
export R2_SECRET_KEY=...

# Dry run first — see what would be migrated (assets older than 90 days)
node scripts/migrate-assets-to-hf.js --older-than 90 --dry-run

# Actual migration (copies to HF, leaves R2 originals)
node scripts/migrate-assets-to-hf.js --older-than 90

# Migrate AND delete from R2 to free space (irreversible — dry-run first!)
node scripts/migrate-assets-to-hf.js --older-than 90 --delete-source
```

After migration, the script writes `data/config/asset-migration.json` with a URL map. The next build automatically rewrites product image URLs from R2 to Hugging Face. No manual URL editing needed.

**Other options:**
- **Cloudflare Images** — paid, adds automatic resizing/transforms
- **Bunny.net** — very cheap CDN/storage, ~$0.01/GB/month
- **Any public CDN** — just put the full URL in product JSON

### Uploading assets

The admin panel (`/admin`) has a built-in **Media** tab for uploading assets directly to R2 from the browser — no CLI needed after initial R2 setup. It auto-generates CDN URLs you can paste directly into product JSON.

For bulk uploads or automation:
- Use `rclone` or the AWS CLI (R2 is S3-compatible)
- Upload directly via the Cloudflare R2 dashboard

The `POST /api/admin/upload` endpoint backs the admin UI. Requires R2 to be configured (`ASSETS_BUCKET` binding in `wrangler.toml` and `CDN_BASE_URL` set).

Recommended folder structure in R2:
```
products/
  p-8392/
    1.webp
    2.webp
    blk.webp
    red.webp
    og.webp
    vid-1.mp4
    vid-1-thumb.webp
nav/
  dresses.webp
  tops.webp
ugc/
  1-thumb.webp
  2-thumb.webp
```

---

## 14. Email (Resend)

Order confirmation emails are sent automatically after successful payment. The template is in `src/api/lib/resend.js`.

### Customizing the template

Edit `sendOrderConfirmation()` in `src/api/lib/resend.js`:

```js
async sendOrderConfirmation(order, storeConfig) {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: sans-serif; color: #1a1a1a; }
        .header { background: #000; color: #fff; padding: 24px; }
        /* ... your brand styles ... */
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Your Brand</h1>
      </div>
      <div class="body">
        <p>Hi ${escapeHtml(order.customer.name)},</p>
        <p>Thanks for your order! We're getting it ready.</p>
        <!-- ... order details ... -->
      </div>
    </body>
    </html>
  `;

  return this.sendEmail({
    from: storeConfig.fromEmail || 'orders@yourbrand.com',
    to: order.customer.email,
    subject: `Order ${order.id} Confirmed — Your Brand`,
    html
  });
}
```

**Always use `escapeHtml(value)` on any customer or order data interpolated into HTML.** It escapes `<`, `>`, `&`, `"`, `'` to prevent XSS in email clients.

### Available order data

```js
order.id                    // "ord_1720000000000_abc1"
order.customer.name         // "Jane Smith"
order.customer.email        // "jane@example.com"
order.items[]               // array of { name, variantId, qty, price, sku, image }
order.subtotal              // 89.00
order.shippingCost          // 7.99
order.tax                   // 6.45
order.total                 // 103.44
order.coupon                // "WELCOME10" or null
order.shipping.address1
order.shipping.city
order.shipping.state
order.shipping.country
```

---

## 15. Migrating an Existing SPA

If you have a working SPA mockup and want to connect it to this backend, here's the process:

### Step 1 — Import StoreClient

Add to your `<head>` or before your main script:
```html
<script src="/store-config.js"></script>
<script type="module">
  import { StoreClient } from '/lib/store-client.js';
  const STORE_URL = window.__STORE_URL__ || window.location.origin;
  const API_URL   = window.__API_URL__   || 'https://your-worker.workers.dev/api';
  const client = new StoreClient(STORE_URL, { apiUrl: API_URL });
  await client.init();
  // Your SPA code here
</script>
```

### Step 2 — Replace hardcoded data with client calls

| Before (hardcoded) | After (dynamic) |
|---|---|
| `const products = [...]` | `const products = await client.getProducts(ids)` |
| `const product = catalog.find(...)` | `const product = await client.getProduct(id)` |
| `const results = localSearch(q)` | `const results = client.search(q)` |
| `const storeName = 'My Brand'` | `const store = await client.getConfig('store')` |
| `const navLinks = [...]` | `const menus = await client.getConfig('menus')` |

### Step 3 — Map your data model

Products from this backend look like:
```js
product.identity.name        // Product name
product.identity.slug        // URL slug
product.pricing.price        // Current price
product.pricing.compareAtPrice  // Was-price (optional)
product.pricing.sale         // { active, salePrice, badgeText, ... }
product.description.short    // Short description
product.description.full     // Full HTML description
product.media.images[0].url  // Primary image
product.variants             // Array of variant objects
product.categories           // Array of category path strings
product.tags                 // Array of tag strings
```

### Step 4 — Wire up variant selection

```js
// When a user selects an option
function onOptionSelect(key, value) {
  selectedOptions[key] = value;

  // Get available options given current selection
  const available = client.getAvailableOptions(product, selectedOptions);

  // Re-render all option buttons with availability
  renderOptions(product, selectedOptions, available);

  // Find the currently selected variant
  const variant = product.variants.find(v =>
    Object.entries(selectedOptions).every(([k, val]) => v.options[k] === val)
  );

  if (variant) {
    updatePrice(variant.price);
    updateImage(variant.image || product.media.images[0].url);
    updateStock(variant.stock, variant.backorder);
  }
}
```

### Step 5 — Wire up the cart → checkout

```js
// Build cart item from selected variant
function buildCartItem(product, variant, qty) {
  return {
    productId: product.id,
    variantId: variant.id,
    qty,
    price: variant.price,   // must match server — read from product data, don't compute
    name: product.identity.name,
    image: variant.image || product.media.images[0]?.url || null
  };
}

// Submit checkout
async function submitCheckout() {
  const result = await client.createCheckout(
    cart,
    { email, name: `${firstName} ${lastName}` },
    { country, state, address1, city, zip },
    couponCode || null
  );
  window.location.href = result.checkoutUrl;
}
```

### Step 6 — Drop your SPA into the repo

Replace `data/index.html` with your SPA file. Push to GitHub. The build deploys it automatically.

If your SPA has separate CSS or JS files, put them in `data/` and reference them with absolute paths from root (e.g. `/styles.css`, `/app.js`). They'll be deployed alongside the catalog.

> **Important:** `store-config.js` must exist in `data/` before deploying. It sets `window.__STORE_URL__` and `window.__API_URL__` so the SPA talks to the correct Worker. `setup.sh` generates this file automatically. If it's missing (the Pages SPA catch-all will serve HTML instead of JS), the store will fall back to hardcoded defaults in `index.html` — which may work, but is fragile. Verify it's present and contains your real URLs before going live.

---

## Appendix — Environment Variables & Secrets

### `wrangler.toml` vars (not secret)

```toml
[vars]
RESEND_FROM_EMAIL = "orders@yourdomain.com"
STORE_URL = "https://your-store.pages.dev"
CDN_BASE_URL = "https://your-store.pages.dev"   # points to Pages if no R2; set to R2 public URL if using R2
RESERVATION_TTL_MINUTES = "30"   # minimum 30
```

`setup.sh` patches `STORE_URL` and `CDN_BASE_URL` automatically. To update them later (e.g. when adding R2):

```bash
sed -i 's|CDN_BASE_URL = ".*"|CDN_BASE_URL = "https://pub-xxxx.r2.dev"|' wrangler.toml
npm run deploy:api
```

> **Note:** `wrangler vars put` does not exist in modern wrangler versions. Always update vars in `wrangler.toml` directly and redeploy. `npm run deploy:api` includes a pre-flight check that refuses to deploy if placeholder values are still present.

### Secrets (set via wrangler CLI)

```bash
npx wrangler secret put STRIPE_SECRET_KEY       # sk_live_... or sk_test_...
npx wrangler secret put STRIPE_WEBHOOK_SECRET   # whsec_... (from Stripe webhook endpoint)
npx wrangler secret put RESEND_API_KEY          # re_...
npx wrangler secret put ADMIN_API_KEY           # any strong random string
```

Generate a strong admin key:
```bash
openssl rand -hex 32
```

### GitHub Actions secrets

Set these in your repo → Settings → Secrets and variables → Actions:

```
CLOUDFLARE_ACCOUNT_ID    # From Cloudflare dashboard
CLOUDFLARE_API_TOKEN     # Token with D1 + Pages + Workers permissions
D1_DATABASE_ID           # From wrangler.toml after setup
PAGES_PROJECT_NAME       # Your Cloudflare Pages project name
CLOUDFLARE_ZONE_ID       # Optional: only needed for CDN cache purging on deploy
```

---

## Appendix — File Structure Reference

```
pteris-main/
│
├── data/
│   ├── source/
│   │   └── products/           ← EDIT THESE: one .json per product
│   │       └── p-8392.json
│   │
│   ├── config/                 ← EDIT THESE: store configuration
│   │   ├── store.json
│   │   ├── menus.json
│   │   ├── shipping.json
│   │   ├── tax.json
│   │   ├── coupons.json
│   │   └── sale.json
│   │
│   ├── products/               ← BUILD OUTPUT: don't edit
│   ├── batches/                ← BUILD OUTPUT: don't edit
│   ├── index.json              ← BUILD OUTPUT: don't edit
│   │
│   ├── lib/
│   │   └── store-client.js     ← Frontend library: import in your SPA
│   │
│   └── index.html              ← YOUR SPA: replace with your storefront
│
├── src/
│   ├── api/
│   │   ├── index.js            ← Worker entry point
│   │   ├── routes/
│   │   │   ├── checkout.js
│   │   │   ├── webhook-stripe.js
│   │   │   ├── admin.js
│   │   │   └── stock.js
│   │   └── lib/
│   │       ├── d1.js           ← Database layer
│   │       ├── stripe.js       ← Stripe client
│   │       └── resend.js       ← Email client
│   │
│   ├── build/                  ← Build pipeline scripts
│   │   ├── build-all.js
│   │   ├── build-products.js
│   │   ├── build-index.js
│   │   ├── build-configs.js
│   │   ├── sync-stock.js
│   │   └── sync-prices.js
│   │
│   └── schema/
│       ├── d1-schema.sql       ← Database schema
│       ├── product.schema.json ← Product JSON schema
│       └── types.ts            ← TypeScript types reference
│
├── scripts/
│   ├── seed-inventory.js       ← One-time: bootstrap D1 inventory
│   └── migrate-assets-to-hf.js ← Run when R2 fills up
│
├── .github/workflows/
│   └── build.yml               ← CI/CD: builds on push to main
│
├── wrangler.toml               ← Cloudflare Worker config
└── package.json
```
