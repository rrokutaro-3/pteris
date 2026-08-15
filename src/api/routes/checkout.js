/**
 * POST /api/checkout
 * Creates a Stripe Checkout Session with:
 * - Server-side price validation (no client-side spoofing)
 * - Atomic stock reservation with TTL
 * - Real shipping calculation from config
 * - Tax calculation from config
 * - Coupon validation
 * - Integer cents for Stripe
 */

import { D1Store } from '../lib/d1.js';
import { StripeAPI } from '../lib/stripe.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

/**
 * Normalize a country/state code for comparison against config data.
 *
 * shipping.json and tax.json both key their rules by exact-match country
 * ("US", "DE") and state ("CA", "NY") codes, but calculateShipping() and
 * calculateTax() compared them with strict `===`/`.includes()` against
 * whatever the client's shipping address form sent verbatim. A client
 * sending "us" or "ca" (lowercase, or a full state name) instead of "US"/
 * "CA" would silently fail to match any rule — falling through to 0%
 * default tax, or (if it also happened to fail every shipping profile's
 * country list) a 400 "Shipping not available" error — even though the
 * store does serve that country. This does not fix free-text state names
 * ("California"); it only guards against case/whitespace variants of the
 * same code, which is what a real-world address form is most likely to
 * produce inconsistently.
 */
function normalizeRegionCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

/**
 * Fetch shipping config from Pages (cached in Worker)
 *
 * NOTE: the path is `/config/shipping.json`, NOT `/data/config/shipping.json`.
 * The build workflow (.github/workflows/build.yml, "Stage deploy payload")
 * flattens `data/config/*` to the deployed site's root as `config/*` —
 * `store-client.js`'s `getConfig()` already fetches `${baseUrl}/config/
 * ${name}.json` on that basis. This function (and getTaxConfig/
 * getCouponConfig below) previously still had the pre-flatten `/data/`
 * prefix, which 404s against the real deployed structure and would fail
 * every checkout at the shipping-calculation step.
 *
 * Uses PAGES_URL (not CDN_BASE_URL) because config files are always deployed
 * to Cloudflare Pages — CDN_BASE_URL may point to an R2 bucket for media
 * assets and would 404 for config JSON files.
 */
async function getShippingConfig(env) {
  const cacheKey = 'shipping_config';
  const cached = await env.CACHE?.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const baseUrl = env.PAGES_URL || env.STORE_URL;
  const res = await fetch(`${baseUrl}/config/shipping.json`);
  if (!res.ok) throw new Error(`Failed to load shipping config (HTTP ${res.status}) from ${baseUrl}`);
  const config = await res.json();

  await env.CACHE?.put(cacheKey, JSON.stringify(config), { expirationTtl: 3600 });
  return config;
}

/**
 * Fetch tax config from Pages (cached in Worker). See the path note on
 * getShippingConfig() above — same `/config/` (not `/data/config/`) fix.
 * Uses PAGES_URL (not CDN_BASE_URL) for the same reason.
 */
async function getTaxConfig(env) {
  const cacheKey = 'tax_config';
  const cached = await env.CACHE?.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const baseUrl = env.PAGES_URL || env.STORE_URL;
  const res = await fetch(`${baseUrl}/config/tax.json`);
  if (!res.ok) throw new Error(`Failed to load tax config (HTTP ${res.status}) from ${baseUrl}`);
  const config = await res.json();

  await env.CACHE?.put(cacheKey, JSON.stringify(config), { expirationTtl: 3600 });
  return config;
}

/**
 * Calculate shipping cost based on weight tiers.
 *
 * `cart` items must already carry a server-verified `weight` (see
 * Step 1 in handleCheckout, which overwrites any client-submitted
 * weight with the value from the D1 prices table). Trusting a
 * client-submitted weight here would let a shopper set weight: 0 on
 * every item to get the cheapest shipping tier for free — the same
 * class of spoofing that price verification exists to prevent.
 *
 * `requestedMethod`, if provided, is a shipping profile `id` (e.g.
 * "express") the customer explicitly chose. Without this, profile
 * selection always fell through to the *first* profile in
 * shippingConfig.profiles whose rates cover the destination country —
 * for any US order that's always "standard", so "express" was
 * unreachable dead configuration even though its rates were valid and
 * present, the same class of problem international shipping had before
 * being fixed. If the requested profile doesn't actually serve the
 * destination country, fall back to auto-selection rather than silently
 * mis-charging or rejecting the order.
 */
function calculateShipping(cart, shippingConfig, country, requestedMethod = null) {
  // Normalize defensively even though handleCheckout() already does this
  // before calling in — keeps this function correct if it's ever called
  // from elsewhere without going through that normalization first.
  country = normalizeRegionCode(country);

  // Calculate total weight
  let totalWeight = 0;
  for (const item of cart) {
    totalWeight += (item.weight || 0) * item.qty;
  }

  const profiles = shippingConfig.profiles || [];
  const servesCountry = (p) => p.rates?.some(r => !r.countries || r.countries.includes(country));

  // Prefer the customer's explicitly requested profile, but only if it
  // actually has a rate for this destination country.
  const requested = requestedMethod
    ? profiles.find(p => p.id === requestedMethod && servesCountry(p))
    : null;

  // Otherwise, pick the first profile that serves this country.
  //
  // A previous version always used the "standard" profile regardless of
  // destination country. Since "standard"'s rates are scoped to
  // ["US", "CA"], any other country (e.g. "DE") never matched a rate and
  // fell through to profile.rates[0].price — the cheapest *US* rate —
  // silently undercharging every international order and leaving the
  // "international" profile in shipping.json unreachable.
  const profile =
    requested ||
    profiles.find(servesCountry) ||
    profiles.find(p => p.id === shippingConfig.defaultProfile) ||
    profiles[0];

  if (!profile) return { cost: 0, profile: null };

  // Find matching rate by weight and country
  const ratesForCountry = profile.rates?.filter(r => !r.countries || r.countries.includes(country)) || [];
  const rate = ratesForCountry.find(r => {
    return totalWeight >= (r.minWeight || 0) && totalWeight <= (r.maxWeight || Infinity);
  });

  // No weight tier matches (e.g. package heavier than any defined tier) —
  // fall back to the heaviest available rate for this country rather than
  // an arbitrary first rate that might belong to a different country.
  if (!rate) {
    const heaviest = ratesForCountry[ratesForCountry.length - 1];
    if (!heaviest) return { cost: 0, profile, unsupportedCountry: true };
    return { cost: heaviest.price, profile };
  }

  // Check free shipping threshold
  const subtotal = cart.reduce((s, i) => s + (i.price * i.qty), 0);
  if (profile.freeThreshold && subtotal >= profile.freeThreshold) {
    return { cost: 0, profile };
  }

  return { cost: rate.price, profile };
}

/**
 * Calculate tax
 */
function calculateTax(subtotal, taxConfig, country, state) {
  // Normalize defensively — see normalizeRegionCode() and the note in
  // handleCheckout() where country/state are normalized up front.
  country = normalizeRegionCode(country);
  state = normalizeRegionCode(state);

  const rule = taxConfig.rules?.find(r => {
    if (normalizeRegionCode(r.country) !== country) return false;
    if (r.state && normalizeRegionCode(r.state) !== state) return false;
    return true;
  });

  // Fall back to the config's defaultRate for countries/states with no
  // specific rule, instead of silently treating everything unmatched as
  // 0% tax. A previous version ignored `taxConfig.defaultRate` entirely.
  if (!rule) {
    const defaultRate = taxConfig.defaultRate || 0;
    if (defaultRate === 0) return { amount: 0, rate: 0, included: false };
    const included = !!taxConfig.includedInPrice;
    const taxAmount = included
      ? subtotal - (subtotal / (1 + defaultRate))
      : subtotal * defaultRate;
    return { amount: +taxAmount.toFixed(2), rate: defaultRate, included };
  }

  if (rule.included) {
    // Tax included in price (e.g., VAT)
    const taxAmount = subtotal - (subtotal / (1 + rule.rate));
    return { amount: +taxAmount.toFixed(2), rate: rule.rate, included: true };
  } else {
    // Tax added to price (e.g., US sales tax)
    const taxAmount = subtotal * rule.rate;
    return { amount: +taxAmount.toFixed(2), rate: rule.rate, included: false };
  }
}

/**
 * Fetch coupon config from Pages (cached in Worker, mirrors shipping/tax
 * config caching). See the path note on getShippingConfig() above — same
 * `/config/` (not `/data/config/`) fix. Uses PAGES_URL (not CDN_BASE_URL)
 * for the same reason as getShippingConfig.
 */
async function getCouponConfig(env) {
  const cacheKey = 'coupon_config';
  const cached = await env.CACHE?.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const baseUrl = env.PAGES_URL || env.STORE_URL;
  const res = await fetch(`${baseUrl}/config/coupons.json`);
  if (!res.ok) return null;
  const config = await res.json();

  await env.CACHE?.put(cacheKey, JSON.stringify(config), { expirationTtl: 300 });
  return config;
}

/**
 * Validate and apply coupon
 */
async function validateCoupon(code, cart, subtotal, db, env) {
  if (!code) return { valid: false, discount: 0 };

  // NOTE: a previous version of this function referenced a bare `env`
  // that was never passed in, throwing a ReferenceError on every
  // checkout that included a coupon code. `env` must be passed explicitly.
  const coupons = await getCouponConfig(env);
  if (!coupons) return { valid: false, discount: 0 };

  const coupon = coupons.codes?.[code.toUpperCase()];
  if (!coupon) return { valid: false, discount: 0 };
  if (!coupons.active?.includes(code.toUpperCase())) return { valid: false, discount: 0 };

  // Check expiry
  if (coupon.expires && new Date() > new Date(coupon.expires)) {
    return { valid: false, discount: 0, reason: 'expired' };
  }

  // Check min order
  if (coupon.minOrder && subtotal < coupon.minOrder) {
    return { valid: false, discount: 0, reason: 'min_order_not_met' };
  }

  // Check usage limit
  if (coupon.usageLimit) {
    // NOTE: `db` is a D1Store instance, not the raw D1 binding — it has
    // no `.prepare()` method. A previous version called db.prepare(...)
    // directly here, which would throw at runtime.
    const usageCount = await db.getCouponUsageCount(code);
    if (usageCount >= coupon.usageLimit) {
      return { valid: false, discount: 0, reason: 'usage_limit_reached' };
    }
  }

  // Calculate discount
  let discount = 0;
  if (coupon.type === 'percentage') {
    discount = subtotal * (coupon.value / 100);
  } else if (coupon.type === 'fixed') {
    discount = Math.min(coupon.value, subtotal);
  }

  if (coupon.maxDiscount) {
    discount = Math.min(discount, coupon.maxDiscount);
  }

  return { valid: true, discount: +discount.toFixed(2), coupon };
}

export async function handleCheckout(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const body = await request.json();
  const { cart, customer, shipping, coupon: couponCode } = body;

  if (!cart?.length || !customer?.email || !shipping?.country) {
    return json({ error: 'Missing required fields: cart, customer.email, shipping.country' }, 400);
  }

  // Validate every cart line's productId/variantId/qty shape up front,
  // before any price lookups, stock reservations, or subtotal math touch
  // them.
  //
  // `qty` in particular was previously trusted as-is. `reserveStock`'s
  // availability check is `available < qty`, which a negative qty always
  // passes (e.g. -99 < 5 is false), so a negative-qty line "reserved"
  // stock by *decrementing* `reserved` instead of incrementing it, and
  // later had `commitStock` *increase* on-hand qty instead of decreasing
  // it. Combined with `subtotal += unitPrice * item.qty`, a cart mixing a
  // large positive qty on one line with a large negative qty on another
  // (same or different product) could pay for a handful of units while
  // reserving/receiving far more, and corrupt inventory counts in the
  // same request. Non-integer qty (e.g. 0.5) was similarly unchecked.
  // MAX_ITEM_QTY is a sanity cap, not a business rule — it exists so a
  // single absurd value (e.g. 1e9) can't blow up reservation loops or
  // Stripe line items; raise it if you legitimately sell in bulk.
  const MAX_ITEM_QTY = 100;
  for (const item of cart) {
    if (typeof item?.productId !== 'string' || !item.productId) {
      return json({ error: 'Each cart item requires a productId' }, 400);
    }
    if (typeof item?.variantId !== 'string' || !item.variantId) {
      return json({ error: 'Each cart item requires a variantId' }, 400);
    }
    if (!Number.isInteger(item?.qty) || item.qty < 1 || item.qty > MAX_ITEM_QTY) {
      return json({
        error: `Invalid quantity: must be a whole number between 1 and ${MAX_ITEM_QTY}`,
        productId: item.productId,
        variantId: item.variantId,
        received: item?.qty
      }, 400);
    }
  }

  // Normalize once, up front, so every downstream shipping/tax lookup
  // compares against the same case/whitespace-consistent codes the
  // config files use. See normalizeRegionCode() for why this matters.
  shipping.country = normalizeRegionCode(shipping.country);
  if (shipping.state) shipping.state = normalizeRegionCode(shipping.state);

  const db = new D1Store(env.DB);
  const stripe = new StripeAPI(env.STRIPE_SECRET_KEY);
  const ttlMinutes = parseInt(env.RESERVATION_TTL_MINUTES || '30');
  // Stripe requires expires_at to be at least 30 minutes in the future.
  // ttlMinutes also drives the reservation TTL, so if it's misconfigured
  // below Stripe's floor, clamp only the value used for the Stripe
  // session — don't let a bad env var make every checkout fail outright.
  const stripeExpiryMinutes = Math.max(ttlMinutes, 30);

  // Clean up expired reservations first
  await db.cleanupExpiredReservations();

  // ─── Step 1: Validate prices server-side ───
  const validatedCart = [];
  let subtotal = 0;

  for (const item of cart) {
    const priceRow = await db.getPrice(item.productId, item.variantId);
    if (!priceRow) {
      return json({ error: 'Invalid product or variant', productId: item.productId, variantId: item.variantId }, 400);
    }

    // Use sale price if active, otherwise regular price.
    // Coerce to Number so a null/undefined/string from D1 cannot produce
    // NaN later in toCents() (Stripe rejects non-integer unit_amount).
    const rawUnit = priceRow.sale_active && priceRow.sale_price != null
      ? priceRow.sale_price
      : priceRow.price;
    const unitPrice = Number(rawUnit);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      console.error('Invalid catalog price', {
        productId: item.productId,
        variantId: item.variantId,
        priceRow,
        rawUnit
      });
      return json({
        error: 'Invalid product price in catalog',
        productId: item.productId,
        variantId: item.variantId
      }, 500);
    }

    // Validate client-sent price (allow small rounding tolerance)
    if (Math.abs(Number(item.price) - unitPrice) > 0.01) {
      return json({
        error: 'Price mismatch detected',
        productId: item.productId,
        variantId: item.variantId,
        expected: unitPrice,
        received: item.price
      }, 400);
    }

    validatedCart.push({
      ...item,
      price: unitPrice, // Use server-verified price
      sku: priceRow.sku,
      currency: (priceRow.currency || 'USD').toLowerCase(),
      // Use server-verified weight, not whatever the client cart sent.
      // A previous version trusted item.weight as submitted by the
      // client, which meant a shopper could set weight: 0 on every item
      // to always land in the cheapest shipping tier — the exact class
      // of spoofing that price verification (above) exists to prevent.
      weight: Number(priceRow.weight) || 0
    });

    subtotal += unitPrice * item.qty;
  }

  subtotal = +subtotal.toFixed(2);

  // ─── Step 2: Validate coupon ───
  const couponResult = await validateCoupon(couponCode, validatedCart, subtotal, db, env);
  const discount = couponResult.valid ? couponResult.discount : 0;

  // ─── Step 3: Calculate shipping ───
  const shippingConfig = await getShippingConfig(env);
  const shippingCalc = calculateShipping(validatedCart, shippingConfig, shipping.country, shipping.method || null);

  // If no shipping profile actually serves this country, don't silently
  // fall back to the standard/default profile's cost — that would ship
  // (or worse, undercharge for shipping) an order the store has no
  // configured rate for. Fail clearly instead, before any stock is
  // reserved.
  if (shippingCalc.unsupportedCountry) {
    return json({
      error: 'Shipping not available for this destination',
      country: shipping.country
    }, 400);
  }

  const shippingCost = Number(shippingCalc.cost) || 0;

  // ─── Step 4: Calculate tax ───
  const taxConfig = await getTaxConfig(env);
  const taxCalc = calculateTax(subtotal - discount, taxConfig, shipping.country, shipping.state);
  const taxAmount = Number(taxCalc.amount) || 0;

  // ─── Step 5: Calculate total ───
  const total = +(subtotal - discount + shippingCost + (taxCalc.included ? 0 : taxAmount)).toFixed(2);
  if (!Number.isFinite(total)) {
    console.error('Computed non-finite order total', { subtotal, discount, shippingCost, taxAmount, taxCalc });
    return json({ error: 'Unable to calculate order total' }, 500);
  }

  // ─── Step 6: Atomic stock reservation ───
  const reservations = [];
  try {
    for (const item of validatedCart) {
      const result = await db.reserveStock(item.productId, item.variantId, item.qty);
      if (!result.ok) {
        // Rollback previous reservations
        for (const r of reservations) {
          await db.commitStock(r.productId, r.variantId, r.qty, false);
        }
        return json({
          error: 'Out of stock',
          productId: item.productId,
          variantId: item.variantId,
          requested: item.qty,
          available: result.available
        }, 409);
      }
      reservations.push({ productId: item.productId, variantId: item.variantId, qty: item.qty });
    }
  } catch (err) {
    // Rollback on error
    for (const r of reservations) {
      await db.commitStock(r.productId, r.variantId, r.qty, false);
    }
    throw err;
  }

  // ─── Step 7: Create order record ───
  const orderId = `ord_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  // Create reservations with TTL
  for (const item of validatedCart) {
    await db.createReservation(orderId, item.productId, item.variantId, item.qty, ttlMinutes);
  }

  await db.createOrder({
    id: orderId,
    items: validatedCart.map(i => ({
      productId: i.productId,
      variantId: i.variantId,
      sku: i.sku,
      name: i.name,
      qty: i.qty,
      price: i.price,
      image: i.image,
      weight: i.weight || 0
    })),
    customer,
    shipping,
    subtotal,
    shippingCost,
    tax: taxAmount,
    total,
    status: 'pending',
    stripeSessionId: null,
    coupon: couponCode || null
  });

  // ─── Step 8: Create Stripe Checkout Session ───
  // Convert to integer cents. Stripe requires a non-negative integer;
  // NaN / undefined / negative values produce "Invalid non-negative integer"
  // on line_items[N][price_data][unit_amount].
  const toCents = (amount, label = 'amount') => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Invalid non-negative amount for ${label}: ${JSON.stringify(amount)}`);
    }
    return Math.round(n * 100);
  };

  const lineItems = [];
  const sessionCurrency = validatedCart[0]?.currency || 'usd';

  for (const item of validatedCart) {
    lineItems.push({
      price_data: {
        currency: item.currency || sessionCurrency,
        product_data: {
          name: item.name || 'Item',
          images: item.image ? [item.image] : [],
        },
        unit_amount: toCents(item.price, `product ${item.productId}/${item.variantId}`),
      },
      quantity: item.qty,
    });
  }

  // Add shipping as line item
  const safeShippingCost = Number(shippingCost) || 0;
  if (safeShippingCost > 0) {
    lineItems.push({
      price_data: {
        currency: sessionCurrency,
        product_data: { name: `Shipping (${shippingCalc.profile?.name || 'Standard'})` },
        unit_amount: toCents(safeShippingCost, 'shipping'),
      },
      quantity: 1,
    });
  }

  // Add tax as line item (if not included in price)
  const safeTaxAmount = Number(taxAmount) || 0;
  if (!taxCalc.included && safeTaxAmount > 0) {
    lineItems.push({
      price_data: {
        currency: sessionCurrency,
        product_data: { name: `Tax (${(Number(taxCalc.rate) * 100).toFixed(1)}%)` },
        unit_amount: toCents(safeTaxAmount, 'tax'),
      },
      quantity: 1,
    });
  }

  // Apply coupon discount via Stripe's native coupon system.
  // Stripe does NOT accept negative unit_amount on line items — passing
  // unit_amount: -690 causes a hard API rejection. Instead, create a
  // one-time coupon and attach it via the session's `discounts` array.
  // This also displays the discount properly in the Stripe-hosted checkout UI.
  let stripeDiscounts = [];
  const safeDiscount = Number(discount) || 0;
  if (safeDiscount > 0) {
    try {
      const stripeCoupon = await stripe.createCoupon({
        amount_off: toCents(safeDiscount, 'discount'),
        currency: sessionCurrency,
        duration: 'once',
        name: `${couponCode} discount`,
      });
      stripeDiscounts = [{ coupon: stripeCoupon.id }];
    } catch (err) {
      // Coupon creation failed — rollback reservations and bail out cleanly
      // rather than passing a broken session to Stripe.
      console.error('Stripe coupon creation failed:', err);
      for (const r of reservations) {
        await db.commitStock(r.productId, r.variantId, r.qty, false);
      }
      await db.releaseReservation(orderId);
      await db.updateOrderStatus(orderId, { status: 'cancelled' });
      return json({ error: 'Payment provider error' }, 502);
    }
  }

  // Ensure total is at least $0.50 (Stripe minimum)
  if (total < 0.50) {
    // Rollback reservations
    for (const r of reservations) {
      await db.commitStock(r.productId, r.variantId, r.qty, false);
    }
    await db.releaseReservation(orderId);
    // Mark the order cancelled too — otherwise it's left stuck in
    // "pending" forever with its stock already released, and nothing
    // else (the reservation-expiry cron only cleans up reservations,
    // not orphaned orders) will ever mark it as done.
    await db.updateOrderStatus(orderId, { status: 'cancelled' });
    return json({ error: 'Order total below Stripe minimum ($0.50)' }, 400);
  }

  let session;
  try {
    session = await stripe.createCheckoutSession({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${env.STORE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.STORE_URL}/cart`,
      customer_email: customer.email,
      metadata: {
        order_id: orderId,
        order_items: JSON.stringify(validatedCart.map(i => ({ productId: i.productId, variantId: i.variantId, qty: i.qty }))),
      },
      expires_at: Math.floor(Date.now() / 1000) + (stripeExpiryMinutes * 60),
      // Only include discounts key when a coupon exists — Stripe rejects
      // an empty discounts array alongside allow_promotion_codes.
      ...(stripeDiscounts.length > 0 ? { discounts: stripeDiscounts } : {}),
    });
  } catch (err) {
    // CRITICAL: Release stock if Stripe fails
    console.error('Stripe session creation failed:', err);
    // Log the unit_amounts that Stripe rejected so we can diagnose
    // "Invalid non-negative integer" without replaying the request.
    console.error('line_items unit_amounts:', lineItems.map((li, i) => ({
      i,
      unit_amount: li.price_data?.unit_amount,
      currency: li.price_data?.currency,
      name: li.price_data?.product_data?.name,
      qty: li.quantity
    })));
    for (const r of reservations) {
      await db.commitStock(r.productId, r.variantId, r.qty, false);
    }
    await db.releaseReservation(orderId);
    // NOTE: updateOrderStatus() now allowlists updatable columns and
    // recomputes updated_at itself — don't pass it here.
    await db.updateOrderStatus(orderId, { status: 'cancelled' });
    // Don't leak the raw provider error (`err.message`) to the client —
    // it can contain internal details about the Stripe integration.
    return json({ error: 'Payment provider error' }, 502);
  }

  // Update order with Stripe session ID
  await db.updateOrderStatus(orderId, { stripe_session_id: session.id });

  return json({ checkoutUrl: session.url, orderId });
}
