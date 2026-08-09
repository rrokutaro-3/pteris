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
    // Products are static files — admin reads from CDN or source
    return json({
      message: 'Products are managed via static JSON files in data/source/products/',
      note: 'Edit the JSON files and push to GitHub to trigger a build.',
      adminTip: 'Use GET /api/admin/inventory to manage stock levels.'
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

  const orderMatch = path.match(/^\/api\/admin\/orders\/(.+)$/);
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

    if (method === 'POST' && path.endsWith('/refund')) {
      const body = await request.json();
      await db.updateOrderStatus(id, {
        status: 'refunded',
        refund_amount: body.amount,
        refund_reason: body.reason,
        refunded_at: new Date().toISOString()
      });
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

  return json({ error: 'Admin route not found' }, 404);
}
