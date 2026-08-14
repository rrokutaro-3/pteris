/**
 * Admin API Routes
 * All routes require Authorization: Bearer ADMIN_API_KEY
 */

import { D1Store } from '../lib/d1.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

/**
 * Constant-time string comparison to avoid leaking how many leading
 * characters of the admin key were guessed correctly via response-time
 * differences. A previous version used `!==`, which short-circuits on
 * the first mismatched character.
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function requireAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!env.ADMIN_API_KEY || !timingSafeEqual(token, env.ADMIN_API_KEY)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  return null;
}

export async function handleAdmin(request, env, { path, method }) {
  const authError = requireAuth(request, env);
  if (authError) return authError;

  const db = new D1Store(env.DB);
  const url = new URL(request.url);

  // ─── PRODUCTS (read from static JSON, not D1) ───
  if (path === '/api/admin/products' && method === 'GET') {
    // Products are static files — admin UI lists them from Pages index.json
    return json({
      message: 'Products are managed via static JSON files in data/source/products/',
      note: 'Edit the JSON files and push to GitHub to trigger a build.',
      adminTip: 'The admin Products page loads the catalog from {STORE_URL}/index.json and full product JSON from {STORE_URL}/products/{id}.json. Use GET /api/admin/inventory to manage live stock levels in D1.'
    });
  }

  // ─── INVENTORY ───
  if (path === '/api/admin/inventory' && method === 'GET') {
    const lowStock = url.searchParams.get('lowStock') === 'true';
    const { results } = await db.db.prepare('SELECT * FROM inventory').all();

    const items = results.map(r => ({
      productId: r.product_id,
      variants: JSON.parse(r.variants),
      lastUpdated: r.last_updated
    }));

    if (lowStock) {
      // Default `qty` to 0, same as D1Store.getStats()'s equivalent
      // low-stock computation — without this, a variant with a missing
      // or null `qty` (a malformed inventory row) evaluates to
      // `NaN <= 5` (false) and is silently excluded from this list
      // instead of being flagged as low-stock.
      const filtered = items.filter(item => {
        return Object.values(item.variants).some(v => Math.max(0, (v.qty || 0) - (v.reserved || 0)) <= 5);
      });
      return json({ inventory: filtered, count: filtered.length });
    }

    return json({ inventory: items, count: items.length });
  }

  const invMatch = path.match(/^\/api\/admin\/inventory\/(.+)$/);
  if (invMatch) {
    const id = invMatch[1];

    if (method === 'GET') {
      const inv = await db.getInventory(id);
      if (!inv) return json({ error: 'Not found' }, 404);
      return json(inv);
    }

    if (method === 'PUT') {
      const body = await request.json();
      const current = await db.getInventory(id);
      if (!current) return json({ error: 'Not found' }, 404);

      // `{ ...current.variants }` is only a shallow copy — the per-variant
      // objects inside it are the same references returned by
      // getInventory(). Mutating them in place (as a previous version did
      // with `variants[variantId].qty = ...`) means any other code in the
      // same request holding a reference to `current` would see the
      // "before" object change out from under it mid-request. Copy each
      // variant object too, not just the top-level container.
      const variants = {};
      for (const [variantId, v] of Object.entries(current.variants)) {
        variants[variantId] = { ...v };
      }
      for (const [variantId, data] of Object.entries(body.variants || {})) {
        if (variants[variantId]) {
          if (data.qty !== undefined) variants[variantId].qty = data.qty;
          if (data.reserved !== undefined) variants[variantId].reserved = data.reserved;
          if (data.backorder !== undefined) variants[variantId].backorder = data.backorder;
        }
      }

      await db.setInventory(id, variants);
      return json({ success: true });
    }
  }

  // ─── ORDERS ───
  if (path === '/api/admin/orders' && method === 'GET') {
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);
    const status = url.searchParams.get('status');

    const { orders, total } = await db.listOrders({ page, limit, status });
    return json({ orders, page, limit, total });
  }

  // Refund must be matched before the generic /orders/:id pattern so the
  // order id is not polluted with a trailing "/refund" segment.
  const refundMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/refund$/);
  if (refundMatch && method === 'POST') {
    const id = refundMatch[1];
    const order = await db.getOrder(id);
    if (!order) return json({ error: 'Not found' }, 404);
    const body = await request.json().catch(() => ({}));
    await db.updateOrderStatus(id, {
      status: 'refunded',
      refund_amount: body.amount,
      refund_reason: body.reason || 'Refund',
      refunded_at: new Date().toISOString()
    });
    return json({ success: true });
  }

  const orderMatch = path.match(/^\/api\/admin\/orders\/([^/]+)$/);
  if (orderMatch) {
    const id = orderMatch[1];

    if (method === 'GET') {
      const order = await db.getOrder(id);
      if (!order) return json({ error: 'Not found' }, 404);
      return json(order);
    }

    if (method === 'PATCH') {
      const body = await request.json();
      // NOTE: updateOrderStatus() builds `${key} = ?` directly from these
      // object keys as SQL column names. A previous version used
      // camelCase keys (trackingNumber, carrier) that don't match any
      // column in d1-schema.sql, which threw "no such column" at request
      // time. Map the request's camelCase API fields to the actual
      // snake_case column names here.
      const fieldMap = {
        status: 'status',
        trackingNumber: 'tracking_number',
        carrier: 'carrier',
        notes: 'notes',
      };
      const updates = {};
      for (const [apiKey, column] of Object.entries(fieldMap)) {
        if (body[apiKey] !== undefined) updates[column] = body[apiKey];
      }
      if (Object.keys(updates).length === 0) {
        return json({ error: 'No valid fields to update' }, 400);
      }
      await db.updateOrderStatus(id, updates);
      return json({ success: true });
    }
  }

  // ─── STATS ───
  if (path === '/api/admin/stats' && method === 'GET') {
    const stats = await db.getStats();
    return json(stats);
  }

  // ─── BUILD TRIGGER ───
  if (path === '/api/admin/build' && method === 'POST') {
    return json({
      message: 'Build triggered',
      instruction: 'Push changes to the main branch or use GitHub Actions dispatch.'
    });
  }

  // ─── RESERVATION CLEANUP ───
  if (path === '/api/admin/cleanup-reservations' && method === 'POST') {
    const cleaned = await db.cleanupExpiredReservations();
    return json({ cleaned });
  }

  // ─── MEDIA UPLOAD (R2) ───
  // Accepts multipart/form-data with a single `file` field.
  // Requires env.ASSETS_BUCKET (R2 binding) and env.CDN_BASE_URL.
  // Optional env.UPLOAD_PATH_PREFIX (default: "uploads") sets the key prefix.
  //
  // The key is: {prefix}/{YYYY-MM}/{original-filename}
  // so uploads stay organised without collisions by date.
  //
  // Returns: { url: "https://cdn.yourdomain.com/uploads/2026-08/image.webp" }
  if (path === '/api/admin/upload' && method === 'POST') {
    if (!env.ASSETS_BUCKET) {
      return json({
        error: 'R2 not configured',
        hint: 'Bind an R2 bucket to the Worker as ASSETS_BUCKET in wrangler.toml, then set CDN_BASE_URL to the bucket\'s public URL.'
      }, 501);
    }

    let formData;
    try {
      formData = await request.formData();
    } catch {
      return json({ error: 'Could not parse form data. Send multipart/form-data with a "file" field.' }, 400);
    }

    const file = formData.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') {
      return json({ error: 'Missing "file" field in form data.' }, 400);
    }

    // Validate file type — only allow images and videos.
    const ALLOWED_TYPES = new Set([
      'image/webp', 'image/jpeg', 'image/png', 'image/gif', 'image/avif',
      'video/mp4', 'video/webm',
    ]);
    const contentType = file.type || 'application/octet-stream';
    if (!ALLOWED_TYPES.has(contentType)) {
      return json({ error: `File type "${contentType}" is not allowed. Allowed: ${[...ALLOWED_TYPES].join(', ')}` }, 415);
    }

    // Cap upload size at 50 MB.
    const MAX_BYTES = 50 * 1024 * 1024;
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) {
      return json({ error: `File too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB). Maximum is 50 MB.` }, 413);
    }

    // Build a date-prefixed R2 key.
    const prefix = (env.UPLOAD_PATH_PREFIX || 'uploads').replace(/^\/|\/$/g, '');
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    // Sanitise the original filename: lowercase, strip non-alphanumeric except dots and hyphens.
    const rawName = (file.name || `file-${Date.now()}`).toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    const key = `${prefix}/${month}/${rawName}`;

    try {
      await env.ASSETS_BUCKET.put(key, buffer, {
        httpMetadata: { contentType },
      });
    } catch (err) {
      console.error('R2 put failed:', err);
      return json({ error: 'Upload to R2 failed. Check the bucket binding and permissions.' }, 502);
    }

    const cdnBase = (env.CDN_BASE_URL || '').replace(/\/$/, '');
    const url = cdnBase ? `${cdnBase}/${key}` : `/${key}`;

    return json({ url, key, contentType, size: buffer.byteLength });
  }

  return json({ error: 'Admin route not found' }, 404);
}
