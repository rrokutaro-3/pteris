/**
 * Stripe API + Webhook Verification for Cloudflare Workers
 * Uses Web Crypto API for HMAC-SHA256 verification.
 */

/**
 * Stripe's form-encoded API expects nested objects/arrays as bracketed
 * keys — e.g. `line_items: [{ price_data: { currency: 'usd' } }]` must be
 * sent as `line_items[0][price_data][currency]=usd`, not as a single
 * `line_items=<value>` field. `URLSearchParams.append(key, value)` calls
 * `String(value)` on whatever it's given, so passing an array or object
 * straight through (as a previous version of this function did) silently
 * serializes to the literal string "[object Object]" — every
 * createCheckoutSession() call with line_items or metadata (i.e. every
 * real checkout) would submit garbage for those fields and fail against
 * the live Stripe API. This recursively flattens nested
 * objects/arrays into Stripe's bracket notation.
 */
function encodeStripeParams(params, obj, prefix = '') {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const paramKey = prefix ? `${prefix}[${key}]` : key;

    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        const arrKey = `${paramKey}[${i}]`;
        if (item !== null && typeof item === 'object') {
          encodeStripeParams(params, item, arrKey);
        } else {
          params.append(arrKey, item);
        }
      });
    } else if (typeof value === 'object') {
      encodeStripeParams(params, value, paramKey);
    } else {
      params.append(paramKey, value);
    }
  }
  return params;
}

export class StripeAPI {
  constructor(secretKey) {
    this.secretKey = secretKey;
    this.baseUrl = 'https://api.stripe.com/v1';
  }

  async request(endpoint, method = 'GET', body = null) {
    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      }
    };

    if (body) {
      const params = encodeStripeParams(new URLSearchParams(), body);
      opts.body = params.toString();
    }

    const res = await fetch(`${this.baseUrl}${endpoint}`, opts);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(`Stripe error: ${data.error?.message || res.statusText}`);
    }

    return data;
  }

  async createCheckoutSession(params) {
    return this.request('/checkout/sessions', 'POST', params);
  }

  /**
   * Create a one-time Stripe coupon to represent an internal discount.
   * Stripe does not accept negative unit_amount on line items, so discounts
   * must be applied via the session's `discounts` array referencing a coupon
   * object created here. The coupon is duration: 'once' so it can't be
   * reused, and is identified by the internal coupon code for traceability
   * in the Stripe dashboard.
   */
  async createCoupon(params) {
    return this.request('/coupons', 'POST', params);
  }

  async retrieveSession(sessionId) {
    return this.request(`/checkout/sessions/${sessionId}`);
  }

  /**
   * Verify Stripe webhook signature using Web Crypto API.
   *
   * Stripe signs `${timestamp}.${rawBody}`, NOT the raw body alone.
   * Signing the payload by itself (as a previous version of this code did)
   * means the computed HMAC never matches what Stripe sent — every
   * legitimate webhook would be rejected as invalid (or, if an attacker
   * discovered the mismatch, the check could be bypassed by other means).
   * We also enforce a timestamp tolerance window to prevent replay of an
   * old, previously-valid signed payload.
   *
   * @param {string} payload - Raw request body
   * @param {string} signature - Stripe-Signature header
   * @param {string} secret - Webhook endpoint secret (whsec_...)
   * @param {number} toleranceSeconds - Max allowed age of the signature (default 5 min)
   */
  async verifyWebhook(payload, signature, secret, toleranceSeconds = 300) {
    if (!signature) return false;

    // Stripe signature format: t=TIMESTAMP,v1=HEX[,v1=HEX...]
    const sigParts = signature.split(',').reduce((acc, part) => {
      const [k, v] = part.split('=');
      if (k === 'v1') {
        acc.v1 = acc.v1 || [];
        acc.v1.push(v);
      } else {
        acc[k] = v;
      }
      return acc;
    }, {});

    if (!sigParts.t || !sigParts.v1?.length) return false;

    // Reject stale or clock-skewed signatures to prevent replay attacks.
    const timestamp = parseInt(sigParts.t, 10);
    if (!Number.isFinite(timestamp)) return false;
    const age = Math.abs(Date.now() / 1000 - timestamp);
    if (age > toleranceSeconds) return false;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify']
    );

    // Sign "timestamp.payload" — this is the exact string Stripe signs.
    const signedPayload = `${sigParts.t}.${payload}`;
    const expectedSig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
    const expectedHex = Array.from(new Uint8Array(expectedSig))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Stripe may send multiple v1 signatures during secret rotation;
    // accept if any of them match.
    return sigParts.v1.some(candidate => this._constantTimeEqual(candidate, expectedHex));
  }

  _constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let match = 0;
    for (let i = 0; i < a.length; i++) {
      match |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return match === 0;
  }
}
