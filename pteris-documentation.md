# Lean E-Commerce Engine v2.2
## Complete Documentation (Post-Review, Post-Fix)

> **Version:** 2.2.0
> **Status:** All v2.1 documentation claims re-verified against the v2.2 code;
> v2.2's own changes documented below; remaining known limitations documented
> honestly below.
> **Patch note (second pass):** This document was re-reviewed file-by-file
> against the delivered v2.2 code a second time, alongside runnable tests
> where possible. Three issues are now patched in the companion
> `lean-ecommerce-engine-v2_2-patched.zip`:
> 1. Three hardcoded `2.0.0` version strings (`package.json`, `/api/health`,
>    `build-index.js`'s `_meta.builder`) — bumped to `2.2.0`.
> 2. `admin.js`'s low-stock filter not defaulting a missing `qty` — fixed
>    to match `getStats()`'s pattern.
> 3. **New finding from this pass:** `build-products.js` only excluded
>    `identity.status: "archived"` products from the build — never
>    `"draft"`, despite the schema defining `draft` as a real, documented
>    state. A draft product built successfully, appeared in the public
>    `index.json`/batches, and — because `sync-prices.js` reads the same
>    build output — had its price synced to D1, making it **fully
>    purchasable through checkout** even though nothing in the storefront
>    UI linked to it. Verified with a live test (built a draft-status
>    product, confirmed it appeared in `index.json`). Now fixed:
>    `build-products.js` skips both `"archived"` and `"draft"` products.
>    An earlier version of this document incorrectly stated the build
>    "deliberately excludes" draft products — that was wrong; it's
>    corrected below and in the "What Changed" section.
>
> **Patch note (third pass):** A follow-up cross-file review — tracing
> values across file boundaries instead of reviewing each file in
> isolation — found four more issues, two of them severe enough that
> checkout would not have worked at all against a real Stripe/CDN setup.
> All four are fixed in the patched zip:
> 1. **`StripeAPI.request()`'s body encoder produced invalid Stripe
>    requests for every checkout.** Nested fields (`line_items`,
>    `metadata`) were passed straight into `URLSearchParams.append(key,
>    value)`, which stringifies an object/array to the literal text
>    `[object Object]` instead of Stripe's required bracket notation
>    (`line_items[0][price_data][currency]=usd`). This is a different,
>    more fundamental problem than the rounding edge case described below
>    in "A rounding edge case in the Stripe line items" — that section
>    assumes the request reaches Stripe in a valid shape and only
>    disagrees with it by a cent; this bug meant the request's `line_items`
>    and `metadata` fields never had a valid shape to begin with, so
>    **`createCheckoutSession()` would have failed against the real Stripe
>    API on every checkout**, coupon or no coupon, sale or no sale. Fixed
>    by replacing the flat encoder with one that recursively flattens
>    nested objects/arrays into Stripe's bracket notation. Verified by
>    simulating the exact payload `handleCheckout()` builds and confirming
>    the encoded output matches Stripe's documented format.
> 2. **`checkout.js` fetched shipping/tax/coupon config from the wrong
>    path.** `getShippingConfig()`, `getTaxConfig()`, and
>    `getCouponConfig()` all fetched `${CDN_BASE_URL}/data/config/*.json`,
>    but `.github/workflows/build.yml`'s "Stage deploy payload" step
>    flattens `data/config/*` to the deployed site's root as `config/*` —
>    `StoreClient.getConfig()` already correctly fetches
>    `${baseUrl}/config/${name}.json` on that basis (see [SPA
>    Integration](#spa-integration)), but `checkout.js` still had the
>    pre-flatten `/data/` prefix. Since `getShippingConfig()`/
>    `getTaxConfig()` both throw on a non-2xx response, this 404 would have
>    failed shipping calculation — and therefore every checkout — at step 4
>    of the [Checkout Flow](#checkout-flow-detailed). Fixed by dropping the
>    `/data` prefix from all three fetch URLs. This confirms the setup
>    guide's existing "`CDN_BASE_URL` is usually the same address as
>    `STORE_URL`" guidance was correct — the code just wasn't fetching the
>    right path under that address.
> 3. **No validation of cart line item shape, especially `qty`.**
>    `handleCheckout()` never checked that `cart[].qty` was a positive
>    integer, or that `productId`/`variantId` were present strings. A
>    negative `qty` passes `reserveStock()`'s `available < qty` check
>    unconditionally (any negative number is less than a non-negative
>    `available`), which then *decrements* `reserved` instead of
>    incrementing it, and later has `commitStock()` *increase* on-hand
>    stock instead of decreasing it on webhook fulfillment — while also
>    dragging down `subtotal += unitPrice * item.qty`. A cart mixing a
>    large positive `qty` on one line with a negative `qty` on another
>    could pay for a handful of units while reserving/receiving far more.
>    Fixed by requiring every cart line to have a string `productId`, a
>    string `variantId`, and an integer `qty` between 1 and 100 (a sanity
>    cap against absurd values, not a business rule — raise it if you sell
>    in bulk), checked before any price lookup or stock reservation runs.
> 4. **`data/config/sale.json`'s sample data was live.** It shipped with
>    `"active": true` and a `2020`–`2030` date window, which would apply a
>    real 20%-off rule to `p-8392` the moment a store went live with the
>    file unedited — not a code bug, but exactly the kind of leftover demo
>    state the "Test everything before going live" checklist in the setup
>    guide should catch and didn't call out explicitly. Set to `"active":
>    false` in the patched zip and relabeled as an example; the setup
>    guide now flags it explicitly (see its launch checklist).
>
> None of these four were caught by the second pass because that pass (and
> the original review) checked each file's internal logic correctly but
> didn't trace a value's exact contract across a file boundary — e.g.
> whether the literal path string one file fetches matches the literal
> path string another file deploys to. Items 1 and 2 in particular are a
> reminder that "each file is individually well-written" does not imply
> "the seams between files are correct" — worth keeping in mind for any
> future changes to `checkout.js` or `stripe.js`.
>
> The rest of this document is left as-is since it accurately describes
> what was found; the "Open Items" entries for all three second-pass fixes
> are still resolved, and this third pass's findings are cross-referenced
> from the relevant sections below rather than duplicated in full.
> **Philosophy:** Zero server bills. Maximum flexibility. JSON is the API.
> **Stack:** Static JSON catalog + Cloudflare D1 (stock/orders/prices) + Cloudflare Workers (checkout/webhooks) + Vanilla JS SPA

---

## How to read this document

The v2 release notes claimed every finding from an earlier audit was fixed. An
independent code review found that several of those claims didn't match the
actual code — some "fixes" were incomplete, one was entirely absent, and a
few files referenced things (config files, exports, database columns) that
didn't exist. v2.1 was the corrected reference for that round. v2.2 fixes a
further set of real, mostly concurrency- and deployment-related problems
found since — see **"What Changed Since v2.1"** below — and this document
describes what the code **actually does now**, not what an earlier changelog
said it did. Every claim below was checked against the source in this
repository, and the concurrency-sensitive claims were additionally verified
against runnable simulations (compare-and-swap under concurrent calls,
webhook double-delivery, sale pricing math), not just read by eye.

If you're upgrading from a v2 or v2.1 deployment, read **"What Changed Since
v2.1"** first, then the "What Changed Since v2" section further down if
you're coming from v2 directly — v2.1's D1 schema and `prices` table changes
still apply and still require the migration step described there.

---

## Table of Contents

1. [What Changed Since v2.1](#what-changed-since-v21)
2. [What Changed Since v2](#what-changed-since-v2)
3. [Architecture](#architecture)
4. [Database Schema (Cloudflare D1)](#database-schema-cloudflare-d1)
5. [API Endpoints](#api-endpoints)
6. [Checkout Flow (Detailed)](#checkout-flow-detailed)
7. [Stock Reservation Concurrency Model](#stock-reservation-concurrency-model)
8. [Stripe Webhook Verification](#stripe-webhook-verification)
9. [Pricing & Sales](#pricing--sales)
10. [Shipping Calculation](#shipping-calculation)
11. [Tax Calculation](#tax-calculation)
12. [Coupons](#coupons)
13. [Build Pipeline](#build-pipeline)
14. [SPA Integration](#spa-integration)
15. [HTML Sanitization — Scope and Limits](#html-sanitization--scope-and-limits)
16. [Admin API](#admin-api)
17. [Deployment Checklist](#deployment-checklist)
18. [Environment Variables & Secrets Reference](#environment-variables--secrets-reference)
19. [Cost Breakdown](#cost-breakdown)
20. [Known Limitations (Accepted)](#known-limitations-accepted)
21. [Security Checklist](#security-checklist)
22. [Open Items / Not Yet Fixed](#open-items--not-yet-fixed)
23. [File Map](#file-map)

---

## What Changed Since v2.1

### Critical fixes

| Area | Problem in v2.1 | Fix in v2.2 |
|---|---|---|
| Webhook idempotency race | `webhook-stripe.js`'s duplicate-delivery check (read the order, inspect `status`/`webhook_processed_at`, then call `updateOrderStatus()`) was a plain read-then-write — the exact TOCTOU pattern the v2.1 stock-reservation fix was written to eliminate, just unprotected here. Stripe does retry webhook delivery; two near-simultaneous deliveries for the same session could both pass the check before either write landed, double-committing stock and re-sending the confirmation email. | Added `D1Store.claimOrderStatus(id, expectedStatus, updates)` — the same compare-and-swap pattern as `reserveStock`, but on `orders.status` instead of `inventory.variants`. The `UPDATE ... WHERE id = ? AND status = ?` only succeeds if the order's status still matches what was read; a losing concurrent delivery gets `false` back and treats it as already-handled. Wired into both `checkout.session.completed` and `checkout.session.expired`. Verified with a simulated concurrent double-delivery: exactly one caller wins the claim. |
| Reservation TTL below Stripe's minimum | `RESERVATION_TTL_MINUTES` defaulted to a value that, combined with `checkout.js` computing the Stripe Checkout Session's `expires_at` directly from it, could fall under Stripe's hard 30-minute floor for `expires_at` — Stripe rejects session creation outright when that happens, so **every checkout would fail** with a store running the shipped default. | `wrangler.toml`'s default `RESERVATION_TTL_MINUTES` is now `"30"`. `checkout.js` also independently clamps: `stripeExpiryMinutes = Math.max(ttlMinutes, 30)` is used only for the Stripe session's `expires_at`, while the reservation's own TTL still uses the configured `ttlMinutes` unclamped — so a misconfigured env var can no longer break checkout outright, but you should still set `RESERVATION_TTL_MINUTES` to 30 or higher deliberately rather than relying on the clamp. |
| CI publishes the whole repo | `.github/workflows/build.yml`'s deploy job checked out the repo, downloaded the build artifact into `./data`, and ran `pages deploy .` — deploying the entire working directory. That published `src/`, `scripts/`, `package.json`, `wrangler.toml`, and raw pre-build `data/source/` product data to the public Cloudflare Pages site, alongside the intended `index.json`/`products/`/`batches/`/`config/` output. None of that was meant to be public, and `data/source/` in particular could include unpublished/draft product data (`identity.status: "draft"`) — see the note directly below on why "draft" wasn't actually excluded from the *built* catalog either, which made this doubly exposed. | The build job now stages a flattened `site/` directory (`index.json`, `products/`, `batches/`, `config/`, `.version` at the top level, matching what `StoreClient` actually fetches) and uploads *that* as the artifact. The deploy job no longer checks out the repo at all — it only downloads and deploys the already-flattened artifact, so there is no working directory to accidentally publish. |
| **Draft products were built and published, not just present in raw source** | `build-products.js` only skipped `identity.status === 'archived'` — never `'draft'`, despite `product.schema.json` explicitly declaring `draft` as one of three valid statuses. A draft product built successfully, appeared in the public `index.json` and category/collection batches, and — since `sync-prices.js` reads the same `./data/products` build output — had its price synced to the live D1 `prices` table, making it **fully purchasable through checkout**. `checkout.js` never checks `identity.status`, only whether a price row exists. Verified live: built a product with `status: "draft"`, confirmed it appeared in `index.json` and was purchasable in principle. This is a correctness bug independent of the CI issue above — it would have leaked drafts into the public catalog even with a correctly-scoped CI deploy. | `build-products.js` now skips both `'archived'` and `'draft'` products, same as it already skipped `'archived'`. If you want draft products to be admin-previewable before going live, that would need a separate authenticated preview path — this fix only makes the public build correctly exclude them, it doesn't add a preview mechanism. |
| **`StripeAPI.request()`'s body encoder produced invalid Stripe requests** | Nested fields in the Checkout Session payload (`line_items`, `metadata`) were passed straight into `URLSearchParams.append(key, value)`, which calls `String(value)` on whatever it's given — an object or array serializes to the literal text `[object Object]`, not Stripe's required bracket notation. This meant `createCheckoutSession()` — and therefore every checkout — would fail against the real Stripe API. See the third-pass patch note at the top of this document for the full writeup and how it differs from the (separately real) rounding edge case below. | Replaced the flat encoder with a recursive one (`encodeStripeParams()`) that flattens nested objects/arrays into Stripe's `key[0][nested][key]=value` bracket notation. Verified against the exact payload shape `handleCheckout()` builds. |
| **`checkout.js` fetched shipping/tax/coupon config from the wrong path** | `getShippingConfig()`/`getTaxConfig()`/`getCouponConfig()` fetched `${CDN_BASE_URL}/data/config/*.json`, but the deployed site has these flattened to `${CDN_BASE_URL}/config/*.json` (see `.github/workflows/build.yml`'s "Stage deploy payload" step and `StoreClient.getConfig()`, which already used the correct path). The mismatched shipping/tax fetches throw on their 404, failing every checkout at the shipping-calculation step. See the third-pass patch note for details. | Dropped the `/data` prefix from all three fetch URLs in `checkout.js`. |
| **No validation of cart line item shape (`qty` especially)** | `handleCheckout()` trusted `cart[].qty`, `productId`, and `variantId` as submitted, with no type or range check. A negative `qty` passes `reserveStock()`'s availability check unconditionally and then moves `reserved`/on-hand stock in the wrong direction; combined with a positive-`qty` line elsewhere in the same cart, this could pay for a handful of units while reserving/receiving far more. See the third-pass patch note for the full mechanism. | Added a validation pass before any price lookup or reservation: every cart line now requires string `productId`/`variantId` and an integer `qty` between 1 and 100. |

### High-severity fixes

| Area | Problem | Fix |
|---|---|---|
| Unreachable Express shipping | `calculateShipping()` always auto-selected the first shipping profile that served the destination country, with no way for a customer's chosen method to take precedence. For any US order that's always `standard`, so the `express` profile in `shipping.json` had valid rates that could never be charged — the same class of "config present but unreachable" problem international shipping had before its v2.1 fix. | `calculateShipping()` now takes an optional `requestedMethod` (a shipping profile `id`, e.g. `"express"`) and prefers it over auto-selection — but only if that profile actually has a rate for the destination country; otherwise it falls back to auto-selection rather than mis-charging or rejecting the order. `checkout.js` reads this from `shipping.method` in the request body; `StoreClient.createCheckout()`'s `shipping` argument passes it through as-is (no client-side change needed — just include `method` in the `shipping` object you already send). |
| Case-sensitive region matching | `calculateShipping()` and `calculateTax()` compared `shipping.country`/`shipping.state` against `shipping.json`/`tax.json`'s rule tables with strict equality/`.includes()`, against whatever a client's address form sent verbatim. A form sending `"us"` or `"ca"` instead of `"US"`/`"CA"` would silently fail to match any rule — falling through to 0% default tax, or a `400 "Shipping not available"` error, even for a country the store does serve. | Added `normalizeRegionCode()`, applied once in `handleCheckout()` to `shipping.country`/`shipping.state` before any downstream lookup, and defensively again inside `calculateShipping()`/`calculateTax()` themselves. This only fixes case/whitespace variants of the same code — it does not resolve free-text state names like `"California"` to `"CA"`; that would need a lookup table this version doesn't have. |
| Unvalidated product data reaching the build | Nothing in the build pipeline checked a source product file against `src/schema/product.schema.json` (or any structural rules) before building it. A malformed product — a variant missing `price`, `variants` as a non-array, a missing `pricing.currency` — would build silently and only fail later in less obvious ways: `undefined`/`NaN` reaching Stripe as integer cents, or `sync-prices.js` writing garbage rows to D1. | `build-products.js` now runs each product through `validateProduct()` before building it — a hand-rolled check (intentionally not a full JSON Schema library, to keep the project dependency-free) covering the same required fields `product.schema.json` declares as required at the top level and per-variant. A malformed product now fails the build with a clear per-field error message instead of producing bad output. This is **not** full JSON Schema validation — it doesn't check patterns, enums, or nested optional-object shapes the way `product.schema.json` formally does; see [Known Limitations](#known-limitations-accepted). |
| Asset-migration deletion had no safety check | `scripts/migrate-assets-to-hf.js` could copy assets to Hugging Face, but had no way to actually remove them from R2 afterward — meaning it never relieved R2 storage pressure, defeating the script's stated purpose. | Added an opt-in `--delete-source` flag. When passed, each asset's destination HF URL is verified retrievable (`HEAD` request) **before** its R2 original is deleted; unverified assets are skipped and logged rather than deleted. Without the flag, behavior is unchanged from v2.1 (copy only, originals left in place). |

### Medium / hygiene fixes

- `wrangler.toml` now documents, inline, why `RESERVATION_TTL_MINUTES` must stay at or above 30.
- `.github/workflows/build.yml` has an inline comment explaining why the sync steps must not be duplicated outside `build-all.js` (a previous version of the workflow ran `sync-stock`/`sync-prices` as a separate step before calling `npm run build`, doubling D1 write-quota usage for no benefit — this was already fixed by the time of the v2.1 review, but the comment explaining *why* was added in v2.2 to stop it from regressing).

### Known issues found in this review, not yet fixed in v2.2

- **`package.json`'s `"version"` field, the `/api/health` endpoint's `version: '2.0.0'` response, and `build-index.js`'s `index._meta.builder` string are all still hardcoded to `2.0.0`.** None of these were bumped through v2.1 or v2.2. This has no functional effect on checkout, stock, or pricing, but it means `/api/health` and the build's own `_meta` block are actively misleading about which version of the code is actually running — worth fixing before you rely on either for deployment verification. See [Open Items](#open-items--not-yet-fixed).
- **`admin.js`'s low-stock inventory filter doesn't guard against a missing `qty`.** `GET /api/admin/inventory?lowStock=true` filters with `(v.qty - (v.reserved || 0)) <= 5`, which does not default `v.qty` to `0` the way `D1Store.getStats()`'s equivalent low-stock computation does (`(v.qty || 0) - (v.reserved || 0)`). If `v.qty` is ever missing or `null` on a variant (malformed inventory row), this evaluates to `NaN <= 5`, which is `false` — the variant is silently *excluded* from the low-stock list instead of being flagged or erroring. `getStats()`'s low-stock **count** doesn't have this bug (it was fixed in v2.1); only this specific admin list filter does. Low practical impact if your inventory rows are always written through `D1Store.setInventory()`/`reserveStock()`/`commitStock()` (which always populate `qty`), but worth aligning to `getStats()`'s defensive pattern.

### Migration notes if you're running a live v2.1 deployment

No new D1 schema changes in v2.2 — the `ALTER TABLE` migration under "Migration
notes if you're running a live v2 deployment" below is still the complete set
of schema changes needed if you haven't already applied it. If you have, no
further schema migration is required for v2.2.

The one operational change to make: if your Worker's `RESERVATION_TTL_MINUTES`
secret/var is currently set below `30`, raise it to `30` or higher before
deploying v2.2's Worker code — v2.2 clamps the *Stripe session* expiry
defensively, but a value below 30 will still create reservations with a
shorter TTL than the Stripe session that's supposed to match it, which is
confusing even though it no longer breaks checkout outright.

---

## What Changed Since v2

### Critical fixes (v2 claimed these were done; they weren't, or weren't fully)

| Area | v2 claim | What was actually true | Fix in v2.1 |
|---|---|---|---|
| Stock reservation | "Uses D1 atomic transactions: check availability, then update in same batch. No gap between read and write." | The `db.batch([...])` call wrapped only the `SELECT`. The availability check ran in JavaScript, and the `UPDATE` was a separate, later call outside any transaction — a textbook check-then-act race. Two concurrent checkouts could both reserve the same last unit of stock. | Rewrote `reserveStock`/`commitStock` as a compare-and-swap retry loop (see [Stock Reservation Concurrency Model](#stock-reservation-concurrency-model)). |
| Stripe webhook HMAC | "Implemented full Web Crypto API HMAC-SHA256 verification." | The code HMAC'd the raw payload only. Stripe signs `${timestamp}.${payload}`, not the payload alone — every genuine webhook would fail verification. There was also no timestamp tolerance check (replay risk once "fixed" naively). | Signs the correct string; added a 5-minute default tolerance window; supports multiple `v1` signatures for secret rotation. |
| Coupon usage tracking | "Full coupon validation... Discount applied to Stripe line items." | `db.prepare(...)` was called directly in the webhook handler on a `D1Store` instance, which has no `.prepare()` method — this threw at runtime, *after* stock had already been committed, leaving the order in an inconsistent state. Separately, `validateCoupon()` referenced a bare `env` variable that was never passed into the function, throwing a `ReferenceError` on every checkout that included a coupon code. And `data/config/coupons.json` — the file the whole feature reads from — didn't exist anywhere in the repository. | Added `D1Store.recordCouponUsage()` / `getCouponUsageCount()`; `env` is now passed explicitly into `validateCoupon()`; created `data/config/coupons.json` with two working example coupons. |
| Build pipeline order | Implied prices sync correctly reflects sale pricing. | `syncPrices()` ran *before* `buildProducts()` in the orchestrator, but `syncPrices()` reads from `data/products/`, which is `buildProducts()`'s output. D1 always received the *previous* build's prices (or nothing, on a first run). | Reordered `build-all.js` so products build before prices sync. |
| Sale pricing in D1 | "Variant Price Destruction — FIXED. Sale discounts applied proportionally per variant." | The proportional math in `build-products.js` was correct, but `sync-prices.js` threw it away: it synced the already-discounted `variant.price` as the "regular" price, and the discounted **base product** price (not the variant's own price) as the "sale" price. Any variant priced differently from the base product got billed the wrong amount server-side during a sale. | `build-products.js` now retains `variant.originalPrice`; `sync-prices.js` syncs the correct per-variant regular/sale price pair. |
| SPA client import | Documented `import { StoreClient } from './lib/store-client.js'` in a `<script type="module">`. | `store-client.js` only had `module.exports` (CommonJS), which is `undefined` in a browser ES module context. The documented import would throw. | Added `export class StoreClient`. CommonJS export retained for Node/bundler interop. |

### High-severity fixes (real, but not previously claimed as "fixed")

| Area | Problem | Fix |
|---|---|---|
| Shipping weight | Checkout trusted `item.weight` as submitted by the client cart payload — a shopper could set `weight: 0` on every item to always land in the cheapest shipping tier, the same class of exploit price verification exists to prevent. | Weight is now synced to the D1 `prices` table at build time and checkout uses the server-verified value, never the client's. |
| International shipping | `calculateShipping()` hardcoded a lookup for the `"standard"` shipping profile regardless of destination country. Any country not in `standard`'s `countries` list (e.g. Germany) fell through to `profile.rates[0].price` — the cheapest **US** rate — silently undercharging every international order. The `international` profile in `shipping.json` was unreachable dead configuration. | Picks the profile that actually has a rate for the destination country. If none exists, checkout returns a clear `400` instead of guessing. |
| Admin order updates | `PATCH /api/admin/orders/:id/status` and the refund endpoint wrote fields (`trackingNumber`, `carrier`, `notes`, `refundAmount`, `refundReason`, `refundedAt`) that had no matching columns in `d1-schema.sql` at all — every such request threw a raw SQLite "no such column" error. | Added the missing columns to the schema; fixed field names to the correct snake_case; added a column allowlist to `updateOrderStatus()` so any future mismatch fails with a clear error instead of a raw DB error. |
| Product description sanitization | `sanitizeHtml()` stripped only `<script>` tags and `on*` attributes — `javascript:` URLs in `href`, `<iframe>`, `<object>`, `<style>` (CSS-exfiltration), and `<form>` all passed through untouched. | Denylists dangerous tags and strips dangerous URL schemes from URL-bearing attributes. Still not a substitute for a real sanitizer if you ever render *user-generated* HTML — see [HTML Sanitization](#html-sanitization--scope-and-limits). |
| Order confirmation emails | Customer name and item names were interpolated unescaped into the confirmation email's HTML. | Added `escapeHtml()`, applied throughout the email template. |

### Medium / hygiene fixes

- Admin API key comparison is now constant-time (was `!==`, a timing side channel).
- API error responses no longer leak `err.message` (stack traces, DB errors, internal details) to clients; full detail is still logged server-side via `console.error`.
- Removed the unused `stripe` npm dependency (the code has always used a hand-rolled `fetch`-based Stripe client, never the SDK). Added `@aws-sdk/client-s3`, which the asset-migration script imports but which was missing from `package.json` — that script would have failed with a module-not-found error on a clean install.
- `data/config/sale.json` sample data no longer contains stale `salePrice` fields that the v2 docs claimed were removed from the rule format (the code already ignored them; only the sample data was out of date).
- `calculateTax()` now honors `tax.json`'s top-level `defaultRate` / `includedInPrice` fields as a fallback for unmatched regions, instead of silently treating everything unmatched as 0% tax (that field existed in the config file and was always ignored by the code).
- `D1Store.getStats()`'s low-stock query used `json_extract(variants, '$[0].qty')`, which treats the `variants` JSON **object** as an array — malformed against the real data shape, and moot anyway since `lowStock` was hardcoded to `0`. Replaced with a correct per-variant computation.
- `scripts/migrate-assets-to-hf.js` writes `data/config/asset-migration.json` and its own log output promises "next build will update product URLs to point to HF" — but nothing in the build pipeline ever read that file. `build-products.js` now loads it and rewrites migrated asset URLs in product media, variant images, and SEO `ogImage`.
- Checkout now marks an order `cancelled` when it's rejected for being under Stripe's $0.50 minimum. Previously the order was left in `pending` forever with its stock already released, and nothing else in the system (the reservation-expiry cleanup only touches reservations, not orphaned orders) would ever resolve it.

### Migration notes if you're running a live v2 deployment

If you already have a production D1 database from v2, apply these changes before deploying v2.1's Worker code:

```sql
ALTER TABLE orders ADD COLUMN tracking_number TEXT;
ALTER TABLE orders ADD COLUMN carrier TEXT;
ALTER TABLE orders ADD COLUMN notes TEXT;
ALTER TABLE orders ADD COLUMN refund_amount REAL;
ALTER TABLE orders ADD COLUMN refund_reason TEXT;
ALTER TABLE orders ADD COLUMN refunded_at TEXT;
ALTER TABLE prices ADD COLUMN weight REAL DEFAULT 0;
```

Then re-run `npm run build` (or trigger the GitHub Action) once so `sync-prices.js`
backfills the new `weight` column and corrects any `price`/`sale_price` values that
were written under the old, buggy sync logic. Until you do this, checkout will
work but will price international shipping and sale variants using the old
(buggy) D1 data — see the corresponding rows in the table above.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  LAYER 1: SOURCE OF TRUTH                                               │
│  data/source/products/*.json  +  data/config/*.json                     │
│  (Git repo — edit these, push to trigger build)                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  LAYER 2: BUILD PIPELINE (GitHub Actions / npm run build)                │
│  1. sync-stock.js     → Pull stock from D1 via REST API                 │
│  2. build-products.js → Apply sales, rewrite migrated asset URLs,       │
│                          write to data/products/                        │
│  3. sync-prices.js    → Push verified prices+weight to D1 (runs AFTER   │
│                          build-products so it reflects THIS build)      │
│  4. build-index.js    → Build index from BUILT products + batch files   │
│  5. build-configs.js  → Validate configs                                │
│  6. Deploy to Cloudflare Pages                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  LAYER 3: STATIC HOST (Cloudflare Pages + R2)                           │
│  index.json, products/*.json, batches/*.json, config/*.json             │
│  Globally cached, version-stamped URLs                                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  LAYER 4: THE SPA (Vanilla JS)                                          │
│  StoreClient: variant matrix, hardened HTML sanitization,               │
│  ghost cache fix, real ES export, optional shipping-method selection    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼ (Checkout only)
┌─────────────────────────────────────────────────────────────────────────┐
│  LAYER 5: SERVERLESS API (Cloudflare Workers)                           │
│  D1Store: SQLite compare-and-swap stock AND order-status ops,           │
│  price+weight verification                                              │
│  Stripe: correct HMAC webhook verification, integer cents, coupons      │
│  Resend: escaped-HTML order confirmation emails                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  LAYER 6: CLOUDFLARE D1 (Free Tier)                                     │
│  inventory, orders, prices (+weight), reviews, reservations,            │
│  coupon_usage — SQLite with full transaction support                   │
└─────────────────────────────────────────────────────────────────────────┘
```

Build order matters and is enforced by `src/build/build-all.js`. Do not run
`sync:prices` manually before `build:products` — it will sync stale or
incorrect prices. Always run `npm run build` (the full orchestrator) rather
than the individual `build:*`/`sync:*` scripts unless you specifically know
you want a partial rebuild.

---

## Database Schema (Cloudflare D1)

Run once to initialize (or apply the `ALTER TABLE` migration above if
upgrading an existing database):

```bash
wrangler d1 execute lean-store-db --file=src/schema/d1-schema.sql
```

### `inventory` — Live stock per product

```sql
CREATE TABLE inventory (
  product_id TEXT PRIMARY KEY,
  variants TEXT NOT NULL,     -- JSON: {"v-xxx": {"qty": 10, "reserved": 0, "backorder": false}}
  last_updated TEXT
);
```

`variants` is a JSON **object** keyed by variant ID, not an array. Every
place in the codebase that reads this column must treat it as an object
(`Object.entries(variants)` / `Object.values(variants)`), not index into it
as an array — a previous version of `getStats()` did the latter and was
fixed in v2.1.

### `orders` — Purchase history

```sql
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  items TEXT, customer TEXT, shipping TEXT,
  subtotal REAL, shipping_cost REAL, tax REAL, total REAL,
  status TEXT DEFAULT 'pending',
  stripe_session_id TEXT,
  stripe_payment_intent_id TEXT,
  webhook_processed_at TEXT,  -- Idempotency key
  coupon TEXT,
  tracking_number TEXT,       -- NEW in v2.1
  carrier TEXT,                -- NEW in v2.1
  notes TEXT,                  -- NEW in v2.1
  refund_amount REAL,          -- NEW in v2.1
  refund_reason TEXT,          -- NEW in v2.1
  refunded_at TEXT,            -- NEW in v2.1
  created_at TEXT, updated_at TEXT
);
```

`status` values used across the codebase: `pending`, `paid`, `cancelled`,
`refunded`. Nothing enforces this as a `CHECK` constraint at the SQL level —
if you add new statuses, do it consistently across `checkout.js`,
`webhook-stripe.js`, and `admin.js`.

**`updateOrderStatus(id, updates)` only accepts an allowlisted set of
columns** (`status`, `stripe_session_id`, `stripe_payment_intent_id`,
`webhook_processed_at`, `tracking_number`, `carrier`, `notes`,
`refund_amount`, `refund_reason`, `refunded_at`). It builds SQL by
interpolating object keys as column names (`` `${k} = ?` ``), so this
allowlist exists specifically to stop an unexpected or attacker-influenced
key from becoming part of a SQL statement. If you add a new updatable
order field, add it to `D1Store.ORDER_UPDATABLE_COLUMNS` in `src/api/lib/d1.js`
**and** to the schema — the function throws if you don't.

**`claimOrderStatus(id, expectedStatus, updates)` (new in v2.2)** is a
compare-and-swap sibling of `updateOrderStatus()` — same column allowlist,
same SQL-building approach, but the `WHERE` clause additionally requires
`status = expectedStatus`, and it returns `true`/`false` depending on
whether the update actually applied. Use this instead of
`updateOrderStatus()` anywhere a caller needs to atomically "claim" an order
transition (i.e. anywhere more than one process could plausibly be racing to
make the same transition — currently `webhook-stripe.js`'s two event
handlers). Use plain `updateOrderStatus()` for updates where no such race
exists, like the admin PATCH/refund routes, which are gated by a single
authenticated request and don't need the extra `WHERE` condition. See [Stock
Reservation Concurrency Model](#stock-reservation-concurrency-model) for the
same pattern applied to inventory.

### `prices` — Server-side price and weight verification

```sql
CREATE TABLE prices (
  product_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  sku TEXT, price REAL, compare_at_price REAL,
  currency TEXT, sale_active INTEGER, sale_price REAL,
  weight REAL DEFAULT 0,      -- NEW in v2.1
  updated_at TEXT,
  PRIMARY KEY (product_id, variant_id)
);
```

- `price` is always the true regular (pre-sale) price for this specific variant.
- `sale_price` is this variant's own discounted price (not the base product's), populated only when a sale is active for this product.
- `weight` is this variant's weight in kg, used by checkout for shipping calculation instead of any client-submitted weight.

This table is the single source of truth checkout uses to validate every
cart line item's price and weight. If a `(product_id, variant_id)` pair
isn't in this table, checkout rejects the item with `400 Invalid product or
variant` — this is expected behavior for products that haven't been through
a build yet, or that were removed from the catalog.

### `reservations` — Stock holds with TTL

```sql
CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  order_id TEXT, product_id TEXT, variant_id TEXT,
  qty INTEGER, expires_at TEXT, created_at TEXT
);
```

### `reviews` — Product reviews

```sql
CREATE TABLE reviews (
  id TEXT PRIMARY KEY, product_id TEXT,
  customer_name TEXT, rating INTEGER,
  title TEXT, body TEXT, verified INTEGER,
  images TEXT, helpful INTEGER,
  created_at TEXT, status TEXT
);
```

`status` is constrained by a `CHECK` to `pending`, `approved`, `rejected`.
Reviews require manual moderation — see [Known Limitations](#known-limitations-accepted).
Review `body`/`title` are **not** run through any server-side sanitization
before storage or retrieval — if you build a review submission UI, sanitize
on render using the same approach as [product description sanitization](#html-sanitization--scope-and-limits),
or better, escape rather than allow any HTML in review content at all,
since reviews are genuinely user-generated (unlike product copy, which is
store-owner controlled).

### `coupon_usage` — Coupon redemption tracking

```sql
CREATE TABLE coupon_usage (
  code TEXT, order_id TEXT, customer_email TEXT, used_at TEXT,
  PRIMARY KEY (code, order_id)
);
```

Written via `D1Store.recordCouponUsage()`, which uses
`ON CONFLICT(code, order_id) DO NOTHING` — safe to call more than once for
the same order (e.g. if a webhook is retried by Stripe) without double-counting
usage.

---

## API Endpoints

### Public

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/health` | None | Health check. **Currently returns `{status: 'ok', version: '2.0.0'}` regardless of the code's actual version** — this string was never updated across v2.1 or v2.2; see [Open Items](#open-items--not-yet-fixed). Don't rely on it to verify which build is deployed. |
| GET | `/api/stock/:productId` | None | Live stock levels per variant |
| POST | `/api/checkout` | None | Create Stripe session (validates price, weight, stock, coupon server-side) |
| POST | `/api/webhook/stripe` | Stripe signature | Payment events (HMAC verified, idempotent) |

### Admin (Bearer `ADMIN_API_KEY`, constant-time compared)

| Method | Endpoint | Description |
|--------|----------|--------------|
| GET | `/api/admin/products` | Informational only — products are static files, not in D1 |
| GET | `/api/admin/inventory` | List inventory (`?lowStock=true` to filter to variants at/below threshold 5) |
| GET | `/api/admin/inventory/:id` | Get one product's inventory |
| PUT | `/api/admin/inventory/:id` | Update stock levels (`qty`, `reserved`, `backorder` per variant) |
| GET | `/api/admin/orders` | List orders (`?page=`, `?limit=` capped at 100, `?status=`) |
| GET | `/api/admin/orders/:id` | Get one order |
| PATCH | `/api/admin/orders/:id/status` | Update `status`, `trackingNumber`, `carrier`, `notes` (mapped to snake_case columns server-side) |
| POST | `/api/admin/orders/:id/refund` | Mark refunded; records `refund_amount`, `refund_reason`, `refunded_at` |
| GET | `/api/admin/stats` | Store statistics: product count, order/revenue rollups, low-stock count |
| POST | `/api/admin/build` | Informational only — actual builds run via GitHub Actions, not this endpoint |
| POST | `/api/admin/cleanup-reservations` | Manually trigger expired-reservation cleanup, returns `{cleaned: <count>}` |

All admin routes require `Authorization: Bearer <ADMIN_API_KEY>`. A missing
or incorrect key returns `401 {"error": "Unauthorized"}`. If
`ADMIN_API_KEY` isn't set as a Worker secret at all, every admin request is
rejected (the auth check treats an unset key as always-fail, not
always-pass).

---

## Checkout Flow (Detailed)

```
1. SPA sends cart to POST /api/checkout
   ├─ Each item has: productId, variantId, qty, price (client's guess),
   │  weight (client's guess — IGNORED, see step 2)
   ├─ Worker validates cart shape FIRST, before any lookup: productId and
   │  variantId must be non-empty strings, qty must be a whole number from
   │  1–100 — invalid values return 400 immediately (see the third-pass
   │  patch note at the top of this document for why this matters)
   └─ Also: customer info, shipping address (country/state normalized
      to uppercase/trimmed server-side — see step 4), optional shipping
      method, coupon code

2. Worker fetches each item's TRUE price AND weight from D1 `prices` table
   ├─ Compares client price vs server price
   ├─ Mismatch > $0.01 → returns 400 "Price mismatch detected"
   ├─ Replaces item.weight with the server-verified value unconditionally
   │  (the client's submitted weight is never used for anything)
   └─ Uses server-verified price for all calculations

3. Worker validates the coupon (if any) against data/config/coupons.json:
   expiry, minOrder, usageLimit (checked via coupon_usage table),
   percentage/fixed discount type, maxDiscount cap

4. Worker calculates shipping:
   ├─ Fetches shipping.json (cached in Worker KV if CACHE binding present)
   ├─ If the request included shipping.method (a shipping profile id,
   │  e.g. "express"), prefers that profile — but only if it actually has
   │  a rate for the destination country; otherwise falls back to
   │  auto-selection rather than mis-charging or rejecting the order
   ├─ Otherwise picks the first shipping profile that actually serves the
   │  destination country (NOT hardcoded to "standard" — see Shipping
   │  Calculation)
   ├─ Country/state codes are normalized (trimmed, uppercased) before
   │  matching, so a client sending "us" instead of "US" still matches —
   │  see Shipping Calculation for what this does and doesn't cover
   ├─ If no profile serves the country at all → 400 "Shipping not
   │  available for this destination" (fails BEFORE any stock is reserved)
   └─ Applies weight tiers and free-shipping threshold using
      server-verified item weights

5. Worker calculates tax:
   ├─ Fetches tax.json
   ├─ Matches country/state rule, or falls back to defaultRate
   └─ Handles included (VAT-style) vs added (US sales-tax-style) tax

6. Worker calculates:
   Total = subtotal - discount + shipping + (tax, if not price-included)

7. Worker checks and reserves stock via compare-and-swap (see Stock
   Reservation Concurrency Model) — genuinely atomic per variant, retries
   automatically on concurrent conflicts, gives up after 5 attempts
   ├─ Any item out of stock → 409, all prior reservations in this
   │  request are rolled back
   └─ Any unexpected error → all prior reservations rolled back, error re-thrown

8. Worker creates reservation record(s) with TTL (default 30 min,
   configurable via RESERVATION_TTL_MINUTES — must stay ≥30, see
   [What Changed Since v2.1](#what-changed-since-v21))

9. Worker creates order in D1 with status "pending"

10. Worker creates Stripe Checkout Session:
    ├─ All prices in INTEGER CENTS (Math.round(amount * 100))
    ├─ Shipping added as its own line item (only if cost > 0)
    ├─ Tax added as its own line item (only if not price-included and > 0)
    ├─ Coupon discount added as a negative line item
    ├─ Session expires in RESERVATION_TTL_MINUTES (matches the reservation)
    └─ If total < $0.50 (Stripe's minimum): all reservations released,
       order marked "cancelled", returns 400 — BEFORE calling Stripe

11. If Stripe session creation fails for any other reason:
    ├─ All reserved stock released
    ├─ Reservation records deleted
    ├─ Order marked "cancelled"
    └─ Returns 502 (raw Stripe error message is logged server-side only,
       never returned to the client)

12. SPA redirects customer to session.url

13. Customer pays on Stripe's hosted checkout page

14. Stripe sends webhook to /api/webhook/stripe:
    ├─ Signature verified against `${timestamp}.${rawBody}` (see Stripe
    │  Webhook Verification) with a 5-minute replay-tolerance window
    ├─ checkout.session.completed:
    │   ├─ Fast-path check: order.status === 'paid' or
    │   │  webhook_processed_at already set → 200 "Already processed"
    │   │  (cheap short-circuit for the common case of a genuinely
    │   │  duplicate delivery long after the fact)
    │   ├─ Atomic claim: `db.claimOrderStatus(orderId, 'pending', {...})`
    │   │  only applies the paid/payment-intent/webhook_processed_at
    │   │  update if status is STILL 'pending' at write time — this closes
    │   │  the gap the fast-path check alone doesn't (two near-simultaneous
    │   │  deliveries could both pass the fast-path check before either
    │   │  write lands). If the claim fails (another delivery already won
    │   │  it), returns 200 "Already processed" without touching stock or
    │   │  sending an email.
    │   ├─ Commits stock (decrements qty, clears reserved) via the same
    │   │  compare-and-swap path as reservation
    │   ├─ Deletes reservation records
    │   ├─ Records coupon usage (idempotent — ON CONFLICT DO NOTHING)
    │   └─ Sends confirmation email via Resend (escaped HTML); email
    │       failure is logged but does NOT fail the webhook response
    ├─ checkout.session.expired:
    │   ├─ Fast-path check: order.status !== 'pending' → 200 already handled
    │   ├─ Atomic claim: `db.claimOrderStatus(orderId, 'pending',
    │   │  {status: 'cancelled'})` — same reasoning as above; only actually
    │   │  releases stock if this call won the pending→cancelled
    │   │  transition, so a concurrent duplicate delivery (or a race with
    │   │  the reservation-expiry cleanup path) can't release the same
    │   │  reservation's stock twice
    │   └─ On a successful claim: releases reserved stock, deletes
    │       reservations
    └─ payment_intent.payment_failed: acknowledged (200), no action taken
        — Stripe doesn't reliably include order metadata on this event

15. If a reservation expires before any webhook arrives (customer
    abandoned checkout without Stripe ever sending session.expired):
    ├─ The next checkout request's cleanupExpiredReservations() call,
    │  OR a manual POST /api/admin/cleanup-reservations, OR a scheduled
    │  cron you configure, finds it
    ├─ DELETE FROM reservations WHERE expires_at < now()
    ├─ Stock is released for each expired reservation
    └─ The order itself is NOT automatically updated to "cancelled" by
       this path — only the reservation and stock are cleaned up. See
       Known Limitations for the implication.
```

### A rounding edge case in the Stripe line items (found in review, not yet fixed)

> **Distinct from a more severe issue, now fixed:** this section assumes
> the Checkout Session request reaches Stripe with a valid shape and only
> disagrees with `order.total` by a cent or two. A separate, more
> fundamental bug — `StripeAPI.request()`'s body encoder producing the
> literal string `[object Object]` for `line_items` and `metadata` instead
> of Stripe's bracket notation — meant the request never had a valid shape
> to begin with, so `createCheckoutSession()` would fail outright rather
> than merely round differently. That's fixed in the patched zip; see the
> third-pass patch note at the top of this document. The rounding
> discrepancy described below is real and independent of that fix, and
> remains open.

`handleCheckout()` computes the order's `total` by rounding the whole
expression once (`+(subtotal - discount + shippingCost + tax).toFixed(2)`),
but the actual Stripe Checkout Session is built as a list of **separate**
line items, each independently converted to integer cents via
`toCents = Math.round(amount * 100)` — one call per cart item, one for
shipping, one for tax, one for the discount. Because rounding happens
per-line instead of once on the sum, **the sum Stripe actually charges the
customer (its line items added together) can differ from the stored
`order.total` by a cent or two**, in cases where a price isn't already
cent-precise.

This is reachable in practice, not just a contrived edge case: neither
`product.schema.json` nor `validateProduct()` require `pricing.price` or
`variants[].price` to have at most 2 decimal places — only that they're
non-negative numbers. A merchant entering `19.995` as a base price (a typo,
or an average computed elsewhere and pasted in) would pass validation and
build normally; verified this concretely:

```
3 items at $19.995 each
  order.total path:    subtotal rounded once →  $59.98
  Stripe line-items path: 3 × round($19.995 → $20.00) → $60.00
  Difference: $0.02 — the order record says $59.98, Stripe charges $60.00
```

The sale-pricing path in `build-products.js` already rounds with
`.toFixed(2)` when it computes a discounted price, so this specific
scenario only bites on **manually-entered, non-cent-precise base prices**
in source product JSON — not on anything the sale/discount math itself
produces. Low likelihood in a store that always enters prices to the cent
(as the sample data does), but nothing currently stops a non-cent price
from reaching checkout, and the two numbers (`order.total` in D1 vs. what
Stripe's session will actually charge) can then legitimately disagree.
**Not yet fixed** — see [Open Items](#open-items--not-yet-fixed). The
cleanest fix would be validating `pricing.price` and `variants[].price` to
at most 2 decimal places in `validateProduct()`, since that stops the
problem at the source rather than trying to reconcile two different
rounding strategies at checkout time.

---

## Stock Reservation Concurrency Model

This is the most important correctness property in the system, and the one
that was silently broken in v2 despite being documented as fixed. Read this
section if you're modifying `D1Store.reserveStock()` or `commitStock()`.

### The problem

Two customers try to buy the last unit of the same variant at the same
moment. Both checkout requests:

1. Read the inventory row: `qty: 5, reserved: 4` → 1 available.
2. Both see "1 available, request 1" → both decide "OK, reserve it."
3. Both write `reserved: 5`.

Now `reserved` is 5 but only one of the two orders should have succeeded —
the store has oversold by one unit. This happens whenever the
check-availability step and the write-the-new-value step are not the same
atomic operation.

### Why a D1 `batch()` of `[SELECT]` doesn't fix this

Cloudflare D1's `batch()` guarantees that the **statements inside one batch
call** execute atomically as a unit. A batch containing a single `SELECT`
gives you nothing — the atomicity only helps if the read and the write are
*both* inside the same batch, and D1 doesn't support making a conditional
write depend on a value read earlier in the same batch (there's no
in-database branching). So "batch the select" was never sufficient on its
own.

### The fix: single-statement compare-and-swap

```js
async reserveStock(productId, variantId, qty, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const row = await this.db.prepare(
      'SELECT variants FROM inventory WHERE product_id = ?'
    ).bind(productId).first();

    // ... compute nextVariants in JS from row.variants ...

    const result = await this.db.prepare(`
      UPDATE inventory SET variants = ?, last_updated = datetime('now')
      WHERE product_id = ? AND variants = ?
    `).bind(nextRaw, productId, rawVariants).run();

    if ((result.meta?.changes ?? 0) > 0) {
      return { ok: true, newVariants: nextVariants };
    }
    // 0 rows changed means someone else wrote to this row between our
    // SELECT and our UPDATE — retry with a fresh read.
  }
  return { ok: false, reason: 'concurrent_update_conflict' };
}
```

The key idea: the `UPDATE ... WHERE product_id = ? AND variants = ?` only
succeeds if the row's `variants` blob is byte-for-byte identical to what we
read. A single `UPDATE` statement is atomic in SQLite regardless of how many
other connections are hitting the same table concurrently — so this is a
true compare-and-swap, not an approximation of one. If a concurrent writer
got there first, our `UPDATE` matches zero rows, `result.meta.changes` is
`0`, and we loop back to a fresh `SELECT` and try again.

`commitStock()` (used both for committing a paid order and for releasing an
expired/cancelled reservation) uses the identical pattern, since it's
exposed to the same class of race (e.g. a webhook retry and a cleanup cron
both touching the same product's inventory row at once).

### Practical implications

- **`maxRetries` defaults to 5.** Under realistic contention (a handful of
  concurrent checkouts for the same popular variant) this is enough. Under
  extreme contention (a flash sale on a single low-stock item hit by
  hundreds of simultaneous requests) you may see `concurrent_update_conflict`
  results more often — that's the system correctly refusing to oversell
  rather than a bug. If you need higher throughput for a single hot row,
  consider Cloudflare Durable Objects instead of D1 for that specific
  variant's stock counter; that's a larger architectural change outside
  the scope of this engine.
- **This adds one extra SELECT + UPDATE round trip per retry**, which
  counts toward D1's free-tier write limits (1,000 writes/day). A checkout
  under contention that retries 2–3 times costs 2–3x the writes of an
  uncontended one. For a "small brand" traffic profile this is a rounding
  error; for a genuine flash-sale spike, budget for it.
- **`result.meta?.changes ?? result.changes ?? 0`** — the code reads the
  changed-row-count defensively from either `result.meta.changes` (current
  D1 client shape) or `result.changes` (older/alternate shape), since this
  was verified against D1's documented behavior but not against a live D1
  instance in this review. If you see `reserveStock` always failing with
  `concurrent_update_conflict` even with no real contention, check that
  your `wrangler` version's D1 `.run()` result actually populates one of
  those two fields — that would indicate an SDK version mismatch, not a
  logic bug.

### The same pattern, applied to order status (new in v2.2)

`webhook-stripe.js`'s own duplicate-delivery handling had the identical
read-then-write gap `reserveStock`/`commitStock` used to have, just on the
`orders` table instead of `inventory`: read the order, check
`status`/`webhook_processed_at`, then call `updateOrderStatus()`. Stripe
retries webhook delivery on non-2xx responses and on its own timeouts, so
two near-simultaneous deliveries for the same session were a real
possibility, not just a theoretical race — both could pass the idempotency
check before either write landed, resulting in stock being committed twice
(decrementing `qty` twice for the same paid order) and the confirmation
email being sent twice.

`D1Store.claimOrderStatus(id, expectedStatus, updates)` closes this the same
way: `UPDATE orders SET ... WHERE id = ? AND status = ?` only succeeds if
the order's `status` column still equals `expectedStatus` at write time.
Exactly one concurrent caller can ever see `rowsChanged > 0`; every other
concurrent caller sees `0` and treats it as already-handled. This was
verified with a simulated concurrent double-delivery against a mock D1
binding: of two simultaneous `claimOrderStatus('ord-1', 'pending', {...})`
calls, exactly one returned `true`.

Note that `claimOrderStatus()` uses the *same* `ORDER_UPDATABLE_COLUMNS`
allowlist as `updateOrderStatus()` (see [Database
Schema](#database-schema-cloudflare-d1)) — it throws on an unrecognized
update key for the same SQL-injection-prevention reason, not because the
two methods are otherwise related.

---

## Stripe Webhook Verification

Stripe signs webhook payloads as HMAC-SHA256 of the string
`"{timestamp}.{raw_request_body}"`, using the webhook endpoint secret
(`whsec_...`) as the HMAC key, and sends the result in the
`Stripe-Signature` header as `t=<timestamp>,v1=<hex_signature>[,v1=<hex>...]`
(multiple `v1` values appear during secret rotation — Stripe signs with
both the old and new secret briefly).

`StripeAPI.verifyWebhook(payload, signature, secret, toleranceSeconds = 300)`:

1. Parses `t` and all `v1` values out of the signature header.
2. Rejects if `t` is missing/unparseable, or if `|now - t| > toleranceSeconds`
   (default 5 minutes) — this is what prevents an attacker from replaying a
   previously-valid signed payload indefinitely.
3. Computes HMAC-SHA256 of `"{t}.{payload}"` using the webhook secret.
4. Accepts if **any** provided `v1` value matches the computed signature,
   using a constant-time comparison (`_constantTimeEqual`).

**This must receive the exact raw request body** — `request.text()`, not a
parsed-then-restringified JSON object, since re-serializing JSON can change
whitespace/key order and invalidate the signature. `webhook-stripe.js`
already does this correctly (`const payload = await request.text();`
before any JSON parsing).

If you rotate your Stripe webhook secret, Stripe sends both old- and
new-secret signatures during the transition window automatically — no code
change is needed here, since `verifyWebhook` already checks every `v1`
value present.

---

## Pricing & Sales

### Structural validation, before any sale logic runs (new in v2.2)

Before `build-products.js` applies sale pricing to a product, it runs the
source file through `validateProduct()` — a check that the required fields
`src/schema/product.schema.json` declares are actually present and roughly
the right type (a non-empty `id`, `identity.name`/`slug`/`sku`/`status`,
`pricing.currency`/`price`, `categories` and `variants` as arrays with
`variants` non-empty, each variant having `id`/`sku`/`options`/`price`/
`stock`, `media.images` as an array). A file that fails this throws
immediately with a per-field error list and stops the whole build — it does
not build every other valid product and silently skip the bad one. This
exists because, previously, a malformed product (a variant missing `price`,
`variants` as an object instead of an array, etc.) would build without
error and only surface as a problem later in a much less obvious place —
`undefined`/`NaN` reaching Stripe as integer cents at checkout time, or
`sync-prices.js` writing a garbage row to D1. See [Known
Limitations](#known-limitations-accepted) for what this check does **not**
cover (it's not full JSON Schema validation).

### How a sale is applied at build time

`sale.json` defines a single active sale window with `rules` matched by
`productId`, `tag`, or `category` (first match in the array wins — there's
no explicit priority field, so if a product could match multiple rules,
order them deliberately in the array).

For a matching product, `build-products.js`:

1. Computes a `discountRatio` from `discountType` (`percentage` or `fixed`)
   and `discountValue`.
2. Sets `pricing.originalPrice` = the pre-sale base price, and discounts
   `pricing.price` by that ratio.
3. For **each variant**, discounts `variant.price` by the same ratio and
   stores the pre-sale value as `variant.originalPrice`.

This means Small=$80/Large=$90 with a 20% sale becomes Small=$64/Large=$72
— the price *delta* between variants is preserved, not collapsed to a
single sale price for the whole product. `variant.originalPrice` is new in
v2.1; a previous version discarded it, which is what caused the D1 sync bug
described above.

### How D1 gets these prices

`sync-prices.js` reads the **built** product files (`data/products/*.json`,
i.e. after `build-products.js` has run) and for each variant writes:

- `price` = `variant.originalPrice` if a sale is active, else `variant.price` (the true regular price either way)
- `sale_price` = `variant.price` if a sale is active, else `null` (this variant's own discounted price)
- `sale_active` = `1` if the product's sale is active, else `0`
- `weight` = `variant.weight` (falling back to `product.shipping.weight`)

Checkout's price-verification step reads this table and uses `sale_price`
when `sale_active` is true, else `price` — so the customer is always billed
the correct per-variant amount, sale or not.

### Removing `salePrice` from sale rules

`sale.json` rules use only `discountType` + `discountValue`. A `salePrice`
field on a rule is not read by any code and has no effect — if you see one
in older sale configs, it's safe to delete (v2.1's sample `sale.json` no
longer includes it).

### Sale rule precedence (not fixed, documented)

`saleConfig.rules.find(...)` returns the **first** rule in the array that
matches a given product — by `productId`, then implicitly whichever comes
first if a product matches by `tag` or `category` too. There's no numeric
priority field. If you rely on more than one rule type simultaneously,
order the array so the most specific rule (usually `productId`) comes
before broader ones (`tag`, `category`).

---

## Shipping Calculation

`calculateShipping(cart, shippingConfig, country, requestedMethod = null)` in
`checkout.js`:

1. Normalizes `country` via `normalizeRegionCode()` (trim + uppercase)
   defensively, even though `handleCheckout()` already normalizes
   `shipping.country`/`shipping.state` once, up front, before calling in —
   this keeps the function correct if it's ever called from elsewhere
   without going through that normalization first. This only fixes
   case/whitespace variants of the same code (`"us"` → `"US"`); it does
   **not** resolve free-text state or country names (`"California"` won't
   match `"CA"`) — that would need an actual name→code lookup table, which
   this version doesn't have.
2. Sums `weight × qty` across all cart items, using the **server-verified**
   weight from the `prices` table (never the client-submitted cart weight).
3. Selects the shipping profile, in this order:
   - The profile matching `requestedMethod` (a shipping profile `id`, e.g.
     `"express"`, sent as `shipping.method` in the checkout request) — but
     **only** if that profile actually has a rate for the destination
     country. `requestedMethod` lets a customer explicitly choose Express
     instead of always getting whichever profile happens to match first;
     previously there was no way to reach a non-default profile at all for
     a country served by more than one profile (e.g. "express" was
     unreachable dead configuration for every US order, since "standard"
     always matched first).
   - Otherwise, the first profile in `shippingConfig.profiles` that has at
     least one rate whose `countries` list includes the destination
     country (or has no `countries` restriction at all).
   - Falls back to `shippingConfig.defaultProfile` by ID, then to the first
     profile in the list, only if literally nothing matches the country.
4. Filters that profile's rates to ones valid for the country, then finds
   the one whose `[minWeight, maxWeight]` range contains the total weight.
5. If no weight tier matches (package heavier than every defined tier),
   falls back to the heaviest available rate for that country rather than
   an arbitrary first rate.
6. If **no rate for this country exists in any profile at all**, returns
   `{ cost: 0, profile, unsupportedCountry: true }`. `handleCheckout()`
   checks this flag and returns `400 "Shipping not available for this
   destination"` **before reserving any stock** — it does not silently
   charge $0 or fall back to a wrong country's rate.
7. Applies `profile.freeThreshold` (subtotal-based free shipping) if set
   and met.

`shipping.json`'s `origin` field (warehouse country/zip) is metadata only —
it isn't currently used in rate calculation (all rates are flat by
destination-country + weight tier, not distance-based). If you need
distance-based shipping, that's a larger change to both `shipping.json`'s
schema and `calculateShipping()`.

**To let customers pick a shipping method in the SPA:** include
`method: "<profile id>"` in the `shipping` object passed to
`StoreClient.createCheckout()` — no client-side code change is needed
beyond that, since the method just passes through to the request body
already. Omit it to keep the previous auto-select-by-country behavior.

---

## Tax Calculation

`calculateTax(subtotal, taxConfig, country, state)`:

1. Looks for a rule matching `country` (and `state`, if the rule specifies
   one).
2. If no rule matches, falls back to `taxConfig.defaultRate` /
   `taxConfig.includedInPrice` (both top-level fields in `tax.json`) rather
   than assuming 0% tax for every unmatched region. If `defaultRate` is `0`
   (the shipped default), unmatched regions are untaxed, same as before —
   but this is now an explicit, configurable choice rather than an
   accidental one.
3. `included: true` rules (VAT-style, e.g. UK/DE/FR in the sample config)
   back the tax amount out of a tax-inclusive subtotal:
   `tax = subtotal - (subtotal / (1 + rate))`. The tax is **not** added as
   a separate Stripe line item in this case, since it's already inside the
   product price.
4. `included: false` rules (US sales-tax-style) add tax on top:
   `tax = subtotal * rate`, and it **is** added as a separate Stripe line
   item.

This is not a substitute for a real tax compliance service (e.g. Stripe
Tax, TaxJar, Avalara) if you have real nexus obligations across many
jurisdictions — `tax.json` is a flat, manually maintained rate table
suitable for a small number of known jurisdictions.

---

## Coupons

`data/config/coupons.json` (new in v2.1 — this file did not exist before
and the feature was completely non-functional without it):

```json
{
  "active": ["WELCOME10", "FREESHIP"],
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
    }
  }
}
```

- A code must be present in **both** `codes` (its definition) and `active`
  (the enabled-codes list) to validate — this lets you define a coupon
  ahead of time and toggle it on/off without deleting its config.
- `type: "percentage"` discounts `subtotal * (value / 100)`; `type: "fixed"`
  discounts a flat dollar amount, capped at the subtotal (can't go negative).
- `maxDiscount` caps the computed discount regardless of type.
- `usageLimit`, if set, is enforced via `D1Store.getCouponUsageCount()`
  against the `coupon_usage` table — this is checked at checkout time
  (before payment), so it's a soft limit: two customers redeeming the last
  available use of a limited coupon in the same instant could both pass the
  check before either one's `coupon_usage` row is written (webhook
  processing, not the checkout call itself, is what writes that row). For a
  small store this is an acceptable, rare edge case; if you need a hard
  guarantee, it would need to move into the same compare-and-swap pattern
  used for stock.
- `expires` and `minOrder` are checked as documented, no changes from v2.

Edit `coupons.json`, no build step is required — checkout fetches it
directly from the CDN (with a 5-minute Worker-side cache if a `CACHE` KV
binding is configured; see [Environment Variables](#environment-variables--secrets-reference)).

---

## Build Pipeline

Run the whole thing with `npm run build` (`src/build/build-all.js`), which
executes, **in this order**:

1. **`sync-stock.js`** — Pulls live stock quantities from D1 (via the
   Cloudflare REST API, since this runs in GitHub Actions, not inside a
   Worker) and writes them back into `data/source/products/*.json`. This
   *does* write to disk, but the GitHub Actions workflow does **not**
   commit these changes back to git (see `.github/workflows/build.yml` —
   the `push` trigger's `paths` filter and the absence of any `git commit`
   step are what prevent the infinite-rebuild loop the earlier audit
   flagged). The sync only affects the ephemeral build environment.
2. **`build-products.js`** — For each non-archived source product: rewrites
   any migrated asset URLs (via `data/config/asset-migration.json`, if
   present), applies the active sale (if any, proportionally per variant —
   see [Pricing & Sales](#pricing--sales)), stamps a build version, and
   writes to `data/products/*.json`. **Must run before `sync-prices.js`.**
3. **`sync-prices.js`** — Reads the just-built `data/products/*.json` and
   pushes price + weight + sale data to the D1 `prices` table via the
   Cloudflare REST API, batched in chunks of 10 rows (9 bound params per
   row) to stay under D1's per-query parameter limit.
4. **`build-index.js`** — Reads the built product files (not the source
   files — this was an earlier audit fix and remains correct), builds
   `index.json` (search index, category map, collection map), and
   generates paginated batch files for both categories and collections
   (`collection:new-arrivals-batch-1.json`, etc.), deleting old batch files
   first so removed/renamed batches don't linger.
5. **`build-configs.js`** — Validates that required config files exist
   (`store.json`, `menus.json`, `shipping.json`, `tax.json`) and stamps
   `store.json`/`menus.json` with a build version.
6. Writes `data/.version` with the build timestamp — the SPA's cache-busting
   mechanism (see [SPA Integration](#spa-integration)) depends on this file
   existing at the site root.

If any step throws, `build-all.js` logs the error and exits with a non-zero
code (`process.exit(1)`), which fails the GitHub Actions job and blocks
deployment — a partially-built catalog is never deployed.

You can run individual steps (`npm run build:products`, `npm run
sync:prices`, etc.) for local debugging, but always run the full `npm run
build` before deploying, and never run `sync:prices` without having just
run `build:products` first in the same session.

### CI/CD (`.github/workflows/build.yml`)

Triggers: push to `main` touching `data/source/**`, `data/config/**`,
`src/build/**`, or `src/schema/**`; a 6-hour cron; or manual dispatch. Note
this means pushing changes to `src/api/**` or `spa/**` does **not**
automatically trigger a catalog rebuild or deploy — those are deployed
separately (`wrangler deploy` for the Worker; the SPA is static and served
however you host it, e.g. alongside the Pages catalog or from a separate
static host).

The `build` job syncs stock/prices, builds the catalog, and uploads it as a
GitHub Actions artifact. The `deploy` job downloads that artifact and runs
`wrangler pages deploy` — it does **not** check out and rebuild from source,
so the deployed catalog is guaranteed to be exactly what the build job
produced, not a second independent build. There's no `wrangler deploy` step
for the Worker API in this workflow; deploying the API is a manual
`npm run deploy:api` step (see [Deployment Checklist](#deployment-checklist)).

---

## SPA Integration

### Including the client

```html
<script type="module">
  import { StoreClient } from './lib/store-client.js';

  const client = new StoreClient('https://yourbrand.pages.dev/data', {
    apiUrl: 'https://your-worker.your-subdomain.workers.dev/api'
  });

  await client.init();
</script>
```

`StoreClient` is now a real ES module export (`export class StoreClient`),
so this import works as documented. A CommonJS `module.exports` fallback is
still present for Node-based tooling (tests, bundlers configured for CJS
interop) and doesn't conflict with the ES export.

### Cache-busting ("ghost cache" handling)

`client.init()`:

1. Checks `localStorage` for a cached index.
2. If found, fetches `/.version` (written by the build pipeline, cache
   disabled on this specific fetch) and compares it to the cached index's
   version.
3. If they match, uses the cached index — no `index.json` fetch needed.
4. If they don't match (or the version file is unreachable), fetches a
   fresh `index.json` and re-caches it.

This means a stale browser cache self-heals on the next page load once a
new build has deployed, without needing the user to hard-refresh.

### Variant selection (no ghost variants)

```javascript
const product = await client.getProduct('p-8392');
const matrix = client.buildVariantMatrix(product);

const available = client.getAvailableOptions(product, { Color: 'Black' });
// e.g. { Size: ['S', 'M'] } — 'L' is disabled because Black/L doesn't exist

document.querySelectorAll('.option-btn').forEach(btn => {
  const option = btn.dataset.option;
  const value = btn.dataset.value;
  const isAvailable = available[option]?.includes(value);
  btn.disabled = !isAvailable;
  btn.classList.toggle('unavailable', !isAvailable);
});
```

Unchanged from v2 — this logic was already correct.

### Rendering product descriptions

```javascript
const product = await client.getProduct('p-8392');
const safeHtml = client.sanitizeHtml(product.description.full);
document.getElementById('description').innerHTML = safeHtml;
```

See [HTML Sanitization](#html-sanitization--scope-and-limits) for exactly
what this does and doesn't protect against — read that section before
using `sanitizeHtml()` for anything other than store-owner-authored product
copy.

### Collection pages

```javascript
const newArrivals = await client.getCollection('new-arrivals', 1);
renderProductGrid(newArrivals.products);

if (!newArrivals.isLast) {
  const nextBatch = await client.getCollection('new-arrivals', 2);
  appendProducts(nextBatch.products);
}
```

Unchanged from v2 — batch routing for both categories and collections was
already correct.

### Checkout

```javascript
const { checkoutUrl, orderId } = await client.createCheckout(cart, customer, shipping, couponCode);
window.location.href = checkoutUrl;
```

`cart` items should include `productId`, `variantId`, `qty`, and `price`
(the price is only used client-side for optimistic UI — it's re-verified
server-side and any client-submitted `weight` is discarded and replaced
with the server-verified value, so there's no need to compute or send an
accurate weight from the SPA at all).

---

## HTML Sanitization — Scope and Limits

**Read this before rendering any HTML that isn't store-owner-authored
product copy.**

`StoreClient.sanitizeHtml()` is intended for the kind of HTML that lives in
`data/source/products/*.json` (`description.full`) — content the store
owner writes and controls, not arbitrary user input. It:

- Removes `<script>`, `<iframe>`, `<object>`, `<embed>`, `<style>`,
  `<form>`, `<base>`, `<link>`, and `<meta>` tags entirely.
- Removes every `on*` event-handler attribute (`onclick`, `onerror`, etc.).
- Removes inline `style` attributes (a CSS-based data-exfiltration vector,
  e.g. `background: url(https://attacker.example/?leaked-data)`).
- Strips `javascript:`, `data:`, and `vbscript:` URL schemes from
  `href`, `src`, `action`, `formaction`, and `xlink:href` attributes.

It does **not** implement a full allowlist-based sanitizer, doesn't handle
every conceivable HTML/SVG-based XSS vector, and is not a replacement for a
maintained library. **If you ever render genuinely user-generated
content** — customer review bodies, for instance, which are stored
unsanitized in the `reviews` table — use a real sanitizer (e.g. DOMPurify)
for that content specifically, or render it as plain text
(`textContent`, not `innerHTML`) rather than extending this method's
denylist further. Denylists are inherently a losing game against
user-generated input; they're an acceptable, pragmatic tradeoff only
because product descriptions are store-owner-controlled, not
customer-controlled.

---

## Admin API

All routes under `/api/admin/*` require `Authorization: Bearer
<ADMIN_API_KEY>`, checked with a constant-time comparison. If
`ADMIN_API_KEY` is unset, every admin request is rejected.

### Inventory

- `GET /api/admin/inventory?lowStock=true` — filters to products where any
  variant's `qty - reserved <= 5`. **Known gap:** this filter computes
  `v.qty - (v.reserved || 0)` without defaulting `v.qty` itself — unlike
  `GET /api/admin/stats`'s low-stock count (below), which uses
  `(v.qty || 0) - (v.reserved || 0)`. A variant with a missing/`null` `qty`
  (a malformed inventory row) evaluates to `NaN <= 5` → `false`, so it's
  silently left out of this list rather than flagged as low-stock or
  erroring. In practice this only matters if an inventory row was written
  outside `D1Store.setInventory()`/`reserveStock()`/`commitStock()` (all of
  which always populate `qty`), but if you see this endpoint under-report
  compared to `/api/admin/stats`, this is why.
- `PUT /api/admin/inventory/:id` — body: `{ variants: { "<variantId>": { qty, reserved, backorder } } }`. Only variants present in the body are updated; existing variants not mentioned are left untouched. This write goes directly to D1 and bypasses the compare-and-swap reservation logic — intended for manual stock corrections, not for use under concurrent checkout load on the same product.

### Orders

- `PATCH /api/admin/orders/:id/status` — body may include `status`,
  `trackingNumber`, `carrier`, `notes` (camelCase in the request; mapped to
  the matching snake_case D1 columns internally). A request with none of
  these fields returns `400 "No valid fields to update"`.
- `POST /api/admin/orders/:id/refund` — body: `{ amount, reason }`. Sets
  `status: 'refunded'`, `refund_amount`, `refund_reason`,
  `refunded_at`. **This does not call the Stripe Refunds API** — it only
  records the refund in your own database. If you need to actually refund
  the customer's payment method, you must also call Stripe (e.g. via
  `stripe.refunds.create` or an equivalent request through `StripeAPI`,
  which doesn't currently implement this endpoint — see [Open
  Items](#open-items--not-yet-fixed)).

### Stats

`GET /api/admin/stats` returns:

```json
{
  "products": { "total": 42 },
  "orders": { "today": 3, "thisWeek": 19, "thisMonth": 71 },
  "revenue": { "today": 267.00, "thisWeek": 1904.50, "thisMonth": 6210.25 },
  "inventory": { "lowStock": 4 }
}
```

`lowStock` now reflects a real per-variant computation (threshold: 5 units
available) rather than a hardcoded `0`.

---

## Deployment Checklist

### 1. Cloudflare D1

```bash
wrangler d1 create lean-store-db
wrangler d1 execute lean-store-db --file=src/schema/d1-schema.sql
# Note the database_id, add to wrangler.toml
```

If migrating an existing v2 database rather than creating fresh, run the
`ALTER TABLE` statements in [What Changed Since v2](#what-changed-since-v2)
instead of re-running the full schema file.

### 2. Environment Variables

**`wrangler.toml`:**

```toml
[[d1_databases]]
binding = "DB"
database_name = "lean-store-db"
database_id = "your-d1-database-id"

[vars]
RESEND_FROM_EMAIL = "orders@yourbrand.com"
STORE_URL = "https://yourbrand.pages.dev"
CDN_BASE_URL = "https://cdn.yourbrand.com"
# Must stay >= 30: this also sets the Stripe Checkout Session's expires_at,
# and Stripe rejects any expires_at less than 30 minutes out. Raised from
# 15 to 30 in v2.2 — the old default broke every checkout at Stripe session
# creation. checkout.js additionally clamps the Stripe-facing value
# defensively, but don't rely on that; set this correctly.
RESERVATION_TTL_MINUTES = "30"

# Optional but recommended: Workers KV namespace for caching
# shipping.json / tax.json / coupons.json fetches. Without this binding,
# checkout.js still works correctly — env.CACHE?.get()/.put() calls are
# optional-chained — it just re-fetches these config files from the CDN
# on every checkout instead of serving from a 5–60 minute cache.
# [[kv_namespaces]]
# binding = "CACHE"
# id = "your-kv-namespace-id"
```

**Wrangler secrets:**

```bash
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put RESEND_API_KEY
wrangler secret put ADMIN_API_KEY
```

**GitHub repository secrets:**

```
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_ZONE_ID
D1_DATABASE_ID
```

### 3. Stripe Setup

1. Create a webhook endpoint pointing to
   `https://your-worker.your-subdomain.workers.dev/api/webhook/stripe`.
2. Select events: `checkout.session.completed`, `checkout.session.expired`.
3. Copy the **webhook signing secret** (`whsec_...`) and set it as
   `STRIPE_WEBHOOK_SECRET`.
4. Verify the fix: send a test webhook from the Stripe dashboard and
   confirm your Worker returns `200`, not `401 Invalid signature` — this
   is the check that would have failed under the old (broken) verification
   logic.

### 4. Initial Data

```bash
wrangler d1 execute lean-store-db --command="
  INSERT INTO inventory (product_id, variants, last_updated)
  VALUES ('p-8392', '{\"v-8392-blk-s\":{\"qty\":12,\"reserved\":0,\"backorder\":false},\"v-8392-blk-m\":{\"qty\":8,\"reserved\":0,\"backorder\":false},\"v-8392-red-s\":{\"qty\":3,\"reserved\":0,\"backorder\":true}}', datetime('now'));
"

npm run build      # runs sync-stock -> build-products -> sync-prices -> build-index -> build-configs, in that order
wrangler deploy src/api/index.js
```

### 5. Verify before going live

- [ ] `npm run build` completes without errors and produces `data/index.json`, `data/products/*.json`, `data/batches/*.json`, `data/.version`.
- [ ] Query D1's `prices` table after a build and confirm `weight` is populated (not `0` for products that have real weights) and, if a sale is active, `sale_price` differs per variant where variant prices differ.
- [ ] Send a test Stripe webhook and confirm `200`, not `401`.
- [ ] Attempt a checkout with a deliberately wrong client-submitted price — confirm `400 Price mismatch detected`.
- [ ] Attempt a checkout to a country with no matching shipping profile — confirm `400 Shipping not available for this destination`, not a silently-wrong charge.
- [ ] Attempt an admin request with no `Authorization` header — confirm `401`, not a crash.

---

## Environment Variables & Secrets Reference

| Name | Type | Required | Used by | Notes |
|---|---|---|---|---|
| `DB` | D1 binding | Yes | All API routes | Bound in `wrangler.toml` under `[[d1_databases]]` |
| `CACHE` | KV binding | No | `checkout.js` | Optional. Caches shipping/tax/coupon config fetches. All `env.CACHE?.` calls degrade gracefully to "always fetch fresh" if unbound. |
| `STRIPE_SECRET_KEY` | Secret | Yes | `checkout.js`, `webhook-stripe.js` | Server-side Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | Secret | Yes | `webhook-stripe.js` | `whsec_...`, used for HMAC verification |
| `RESEND_API_KEY` | Secret | Yes (if sending emails) | `resend.js` | Order confirmation emails |
| `RESEND_FROM_EMAIL` | Var | Yes | `webhook-stripe.js` | From-address for confirmation emails |
| `ADMIN_API_KEY` | Secret | Yes | `admin.js` | ≥32 random characters recommended; unset = all admin requests rejected |
| `STORE_URL` | Var | Yes | `checkout.js` | Used for Stripe success/cancel redirect URLs |
| `CDN_BASE_URL` | Var | Yes | `checkout.js` | Where the Worker fetches `shipping.json`/`tax.json`/`coupons.json` from at request time — the actual paths are `${CDN_BASE_URL}/config/shipping.json` etc. (no `/data` prefix), matching the flattened structure the build workflow deploys. Usually the same address as `STORE_URL`. |
| `RESERVATION_TTL_MINUTES` | Var | No (default `30`, raised from `15` in v2.2 — see [What Changed Since v2.1](#what-changed-since-v21)) | `checkout.js` | Also sets the Stripe Checkout Session expiry (clamped to Stripe's 30-min floor defensively; set this to ≥30 explicitly rather than relying on the clamp) |
| `CLOUDFLARE_ACCOUNT_ID` | GH Actions secret | Yes (for build) | `sync-stock.js`, `sync-prices.js` | Cloudflare REST API access for build-time D1 writes |
| `CLOUDFLARE_API_TOKEN` | GH Actions secret | Yes | build scripts, deploy | |
| `CLOUDFLARE_ZONE_ID` | GH Actions secret | Yes | `.github/workflows/build.yml` | Cache purge after deploy |
| `D1_DATABASE_ID` | GH Actions secret | Yes | `sync-stock.js`, `sync-prices.js` | |

Never commit any of the "Secret" rows to git — they're set via `wrangler
secret put` (Worker) or GitHub repository secrets (Actions), never in
`wrangler.toml`'s `[vars]` block, which is plaintext and version-controlled.

---

## Cost Breakdown

| Service | Cost | Limit |
|---------|------|-------|
| Cloudflare Pages | $0 | Unlimited bandwidth |
| Cloudflare Workers | $0 | 100k requests/day |
| Cloudflare D1 | $0 | 100k reads/day, 1k writes/day, 500MB |
| Cloudflare R2 | $0 | 10GB storage, $0 egress |
| Cloudflare Workers KV (optional, for `CACHE`) | $0 | 100k reads/day, 1k writes/day |
| Resend | $0 | 100 emails/day |
| Stripe | $0 fixed | 2.9% + 30¢ per transaction |
| GitHub Actions | $0 | 2,000 minutes/month |
| **Total Fixed** | **$0/month** | |

**D1 write limit note:** 1,000 writes/day ≈ 40 orders/hour average. The
compare-and-swap retry logic (see [Stock Reservation Concurrency
Model](#stock-reservation-concurrency-model)) can consume 2–3x the writes
per checkout under contention — budget accordingly if you expect flash-sale
traffic patterns, or upgrade to D1's paid tier ($1/million writes) ahead of
a known high-traffic event rather than during one.

---

## Known Limitations (Accepted)

| Limitation | Reason | Mitigation |
|-----------|--------|------------|
| Sale prices update only at build time | Static file architecture | Trigger a manual build for flash sales, or accept up to a 6-hour delay (the scheduled cron interval) |
| D1 free tier: 1,000 writes/day | Free tier constraint | Sufficient for ~40 orders/hour; retries under stock contention consume more — see Cost Breakdown |
| Product data cached up to 30 min in SPA | Performance optimization | `.version` check on `init()` catches a stale index sooner if a build has completed |
| No real-time inventory on product pages | Static JSON files | Live check at "Add to Cart" via `GET /api/stock/:id` |
| Weight-based shipping requires accurate variant weight in the source product JSON | Server computes shipping from D1-synced weight, not the SPA | Set `variants[].weight` (or `shipping.weight` as a per-product fallback) accurately in `data/source/products/*.json` — an inaccurate source weight will produce an inaccurate (but not spoofable) shipping charge |
| Reviews require manual approval | No automated moderation | Admin API — approve/reject via direct D1 access or a future `PATCH /api/admin/reviews/:id` endpoint (not yet implemented, see Open Items) |
| Refund endpoint doesn't call Stripe | Recordkeeping only, by design in this version | Manually process the refund in the Stripe dashboard, or extend `StripeAPI` with a `refund()` method (see Open Items) |
| Coupon `usageLimit` is a soft limit under concurrent redemption | Usage is recorded at webhook time (post-payment), not at the checkout-request compare-and-swap layer used for stock | Acceptable for small-scale usage limits; not suitable as a hard cap for something like a single-use, high-value promo code without further work |
| No automatic recovery for an order whose reservation expired before any Stripe webhook arrived | Cleanup releases the reservation and stock, but doesn't reach into the `orders` table to mark that order `cancelled` | Run `POST /api/admin/cleanup-reservations` regularly (or wire it to a scheduled Worker Cron Trigger) and separately sweep `orders` where `status = 'pending'` and `created_at` is older than the reservation TTL |
| `shipping.json`'s `origin` field is unused | Rates are flat per destination-country + weight tier, not distance-based | Fine for most small-catalog stores; a distance/zone-based carrier integration would be a larger change |
| `validateProduct()` (v2.2) is a partial structural check, not full JSON Schema validation | Intentionally dependency-free, hand-rolled check | It verifies the same required fields `product.schema.json` declares (id, type, identity.*, pricing.currency/price, categories is an array, variants is a non-empty array with id/sku/options/price/stock, media.images is an array) but does not check patterns (e.g. `id` matching `^p-[a-zA-Z0-9_-]+$`), enums (e.g. `type` being one of the five allowed values), or nested optional-object shapes the schema formally declares. A product with an invalid `type` value or malformed `id` pattern will still build successfully. If you need the full schema enforced, add a JSON Schema library (e.g. `ajv`) and validate against `product.schema.json` directly instead of relying on `validateProduct()`. |
| `normalizeRegionCode()` (v2.2) only fixes case/whitespace, not free-text names | No name→code lookup table included | A shipping/tax form that lets someone type `"California"` instead of selecting `"CA"` from a dropdown will still fail to match. Use a real address form component with code-based dropdowns/autocomplete, not free-text country/state fields, if you haven't already. |

---

## Security Checklist

- [x] Stripe webhook secret set and HMAC verification enabled — **and verified to sign the correct `timestamp.payload` string**, not just present
- [x] Admin API key comparison is constant-time
- [x] Admin API key is a long random string (≥32 chars) — *operator responsibility, not enforced by code*
- [x] D1 database not publicly accessible (only via Worker binding)
- [x] Product descriptions sanitized before `innerHTML` injection — **scope-limited to store-owned content; see [HTML Sanitization](#html-sanitization--scope-and-limits) before extending to user-generated content**
- [x] Prices validated server-side against the D1 `prices` table
- [x] **Shipping weight validated server-side against the D1 `prices` table** (new in v2.1 — previously trusted from the client)
- [x] Stock reservations have TTL and auto-cleanup
- [x] Stock reservation and commit are genuinely atomic under concurrency (compare-and-swap; new in v2.1 — previously a TOCTOU race)
- [x] Coupon usage tracked to prevent reuse abuse — **soft limit, see Known Limitations**
- [x] Order webhook idempotency prevents double-processing — **and is now genuinely atomic under concurrent webhook deliveries** (`claimOrderStatus()`, new in v2.2 — previously a TOCTOU race identical in shape to the one stock reservation had before v2.1; verified with a simulated concurrent double-delivery)
- [x] API errors don't leak internal error messages to clients (new in v2.1)
- [x] **CI/CD deploy no longer publishes the whole repository** (new in v2.2 — previously `pages deploy .` published `src/`, `wrangler.toml`, `package.json`, and raw `data/source/` alongside the intended built catalog; the deploy job now only has access to a pre-flattened build artifact, not the repo)
- [ ] CDN images use Cloudflare's image optimization (not direct R2 URLs) — *not verified in this review; depends on your CDN configuration, not this codebase*
- [x] No secrets committed to git (all in Wrangler/GitHub secrets)

---

## Open Items / Not Yet Fixed

These were identified during review but intentionally left for a future
change, since they're design decisions or scope expansions rather than
bugs in the existing feature set:

1. **`StripeAPI` has no `refund()` method.** The admin refund endpoint only
   records the refund in D1; it doesn't call Stripe's Refunds API. Anyone
   relying on the admin refund endpoint to actually return money to a
   customer needs to also process the refund in the Stripe dashboard (or
   extend `src/api/lib/stripe.js` with a `refund(paymentIntentId, amount)`
   method and call it from `admin.js`).
2. **No `PATCH /api/admin/reviews/:id` endpoint** to approve/reject
   submitted reviews — `D1Store.createReview()` and `getApprovedReviews()`
   exist, but there's no admin route wired up to move a review from
   `pending` to `approved`/`rejected`. Currently requires direct D1 access.
3. **Review content (`title`, `body`) is stored without any sanitization.**
   Unlike product descriptions, review bodies are genuinely
   customer-submitted. If you build a review submission and display flow,
   sanitize or escape review content specifically — do not reuse
   `sanitizeHtml()`'s denylist approach for this; see [HTML
   Sanitization](#html-sanitization--scope-and-limits).
4. **Sale rule precedence is implicit (array order), not explicit.** Fine
   for the current single-sale-at-a-time model; would need a real priority
   field if you ever support overlapping/stacked promotions.
5. **No scheduled Worker Cron Trigger for reservation cleanup** is
   configured in `wrangler.toml` — cleanup currently only runs inline at
   the start of every checkout request (`cleanupExpiredReservations()`) or
   via manual `POST /api/admin/cleanup-reservations`. For a low-traffic
   store this is sufficient (reservations get cleaned up whenever the next
   customer checks out), but a store with long gaps between orders would
   benefit from a `[triggers] crons = [...]` entry calling the cleanup
   endpoint on a schedule.
6. **`reserveStock`'s compare-and-swap result shape
   (`result.meta?.changes ?? result.changes ?? 0`) was written defensively
   but not executed against a live D1 instance** in this review — verify
   this against your actual `wrangler`/D1 client version before relying on
   it in production, per the note in [Stock Reservation Concurrency
   Model](#stock-reservation-concurrency-model).
7. ~~**Three hardcoded `"2.0.0"` version strings were never bumped**~~ —
   **FIXED in the patched zip.** Across v2.1 and v2.2 both: `package.json`'s
   `"version"` field, `/api/health`'s JSON response, and `build-index.js`'s
   `index._meta.builder` string all claimed to be running code that was two
   feature releases behind what was actually deployed. All three are now
   `2.2.0` in `lean-ecommerce-engine-v2_2-patched.zip`. Consider deriving
   them from a single source (e.g. `package.json`) instead of hardcoding
   the string in three places, so they can't drift independently again on
   the next release.
8. ~~**`admin.js`'s `GET /api/admin/inventory?lowStock=true` filter doesn't
   default a missing `qty` to `0`**~~ — **FIXED in the patched zip.** Now
   uses `Math.max(0, (v.qty || 0) - (v.reserved || 0))`, matching
   `D1Store.getStats()`'s pattern — see the note under [Admin
   API](#admin-api).
9. ~~**Draft products were built and published, fully purchasable**~~ —
   **FIXED in the patched zip.** `build-products.js` only excluded
   `identity.status === 'archived'`, never `'draft'` — despite the schema
   declaring `draft` as one of three valid statuses. Verified live: a
   draft-status product built successfully, appeared in `index.json`, and
   would have had its price synced to D1 (making it purchasable) since
   `sync-prices.js` reads the same build output. `build-products.js` now
   skips `'draft'` alongside `'archived'`. This is unrelated to the CI fix
   above — it would have leaked drafts into the public catalog even with a
   correctly-scoped deploy. **Not covered:** this only makes the public
   build correctly exclude drafts; it does not add any authenticated
   preview mechanism for viewing a draft before publishing it. If you want
   staff to preview drafts, that needs a separate route/flow.
10. **Order total vs. Stripe's actual charge can differ by a cent or two
    on non-cent-precise prices.** `handleCheckout()` rounds `order.total`
    once on the full expression, but builds the Stripe session's line
    items by rounding each one (`toCents = Math.round(amount * 100)`)
    independently. Verified with a concrete case: three items at $19.995
    each produce `order.total = $59.98` but Stripe's line items sum to
    $60.00. Reachable because neither `product.schema.json` nor
    `validateProduct()` require prices to have at most 2 decimal places.
    **Not yet fixed** — see the full writeup under [Checkout Flow
    (Detailed)](#checkout-flow-detailed). The cleanest fix is validating
    price precision at build time (in `validateProduct()`), which stops
    the problem at the source rather than reconciling two rounding
    strategies at checkout time.

---

## File Map

```
lean-ecommerce-engine-v2/
├── .github/workflows/build.yml       CI: build catalog, deploy to Pages. NEW in v2.2 — deploy job now stages a flattened site/ artifact and no longer checks out the repo, so src/, wrangler.toml, and raw data/source/ can no longer be accidentally published (Worker API deploy is still manual)
├── data/
│   ├── config/
│   │   ├── coupons.json              Added in v2.1 — was missing entirely
│   │   ├── menus.json
│   │   ├── sale.json                 Stale `salePrice` fields removed in v2.1
│   │   ├── shipping.json             `express` profile now actually reachable via requestedMethod (v2.2)
│   │   ├── store.json
│   │   └── tax.json
│   └── source/products/*.json        Source-of-truth product data (edit these). NEW in v2.2 — malformed files now fail the build via validateProduct() instead of silently producing bad output
├── package.json                      `stripe` dep removed (unused); `@aws-sdk/client-s3` added. `"version"` field still hardcoded to 2.0.0 — not bumped in v2.1 or v2.2, see Open Items
├── scripts/migrate-assets-to-hf.js   R2→HF asset archival; output consumed by build-products.js (v2.1). NEW in v2.2 — `--delete-source` flag verifies HF availability before deleting R2 originals
├── spa/lib/store-client.js           `export class StoreClient` added; sanitizeHtml() hardened (v2.1). `createCheckout()`'s shipping argument now supports an optional `method` field (v2.2, passthrough — no client code change required)
├── src/
│   ├── api/
│   │   ├── index.js                  Error responses no longer leak err.message (v2.1). `/api/health`'s `version` field still hardcoded to 2.0.0 — see Open Items
│   │   ├── lib/
│   │   │   ├── d1.js                 reserveStock/commitStock rewritten as compare-and-swap; getStats() fixed (v2.1). NEW in v2.2 — claimOrderStatus() applies the same compare-and-swap pattern to orders.status for webhook idempotency
│   │   │   ├── resend.js             escapeHtml() added throughout the email template (v2.1). Unchanged in v2.2
│   │   │   └── stripe.js             verifyWebhook() signs timestamp.payload correctly; adds replay tolerance (v2.1). Unchanged in v2.2 — still no refund() method, see Open Items
│   │   └── routes/
│   │       ├── admin.js              Constant-time auth; fixed field names; column allowlist (v2.1). Known gap in v2.2 — lowStock inventory filter doesn't default a missing qty, see Admin API
│   │       ├── checkout.js           env passed to validateCoupon; server-verified weight; fixed shipping profile selection (v2.1). NEW in v2.2 — requestedMethod shipping selection, normalizeRegionCode(), stripeExpiryMinutes clamp to Stripe's 30-min floor
│   │       ├── stock.js              Unchanged
│   │       └── webhook-stripe.js     Fixed coupon-usage recording (was calling db.prepare on the wrong object) (v2.1). NEW in v2.2 — uses claimOrderStatus() to close a webhook double-delivery race
│   ├── build/
│   │   ├── build-all.js              Reordered: build-products now runs BEFORE sync-prices (v2.1). Unchanged in v2.2
│   │   ├── build-configs.js          Unchanged in v2.1; unchanged in v2.2
│   │   ├── build-index.js            Unchanged in v2.1 (already correct in v2). `index._meta.builder` string still hardcoded to v2.0.0 — see Open Items
│   │   ├── build-products.js         Preserves variant.originalPrice; rewrites migrated asset URLs (v2.1). NEW in v2.2 — validateProduct() rejects malformed source files at build time. PATCHED — now also excludes identity.status: "draft" (previously only "archived" was excluded, so drafts were built, published, and purchasable)
│   │   ├── sync-prices.js            Syncs correct per-variant regular/sale price + weight (v2.1). Unchanged in v2.2
│   │   └── sync-stock.js             Unchanged
│   └── schema/
│       ├── d1-schema.sql             Added orders fulfillment/refund columns; added prices.weight (v2.1). No schema changes in v2.2
│       ├── product.schema.json       Unchanged. Now actually partially enforced at build time via validateProduct() (v2.2) — see Known Limitations for what "partially" means
│       └── types.ts                  Unchanged
└── wrangler.toml                     NEW in v2.2 — RESERVATION_TTL_MINUTES default raised 15→30 (below 30 broke every checkout at Stripe session creation). Add an optional [[kv_namespaces]] CACHE binding if you want config caching
```
