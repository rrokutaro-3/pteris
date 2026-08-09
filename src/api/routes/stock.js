/**
 * GET /api/stock/:productId
 * Returns live stock from D1.
 */

import { D1Store } from '../lib/d1.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export async function handleStockCheck(productId, env) {
  const db = new D1Store(env.DB);
  const inv = await db.getInventory(productId);

  if (!inv) {
    return new Response(JSON.stringify({ error: 'Product not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  const stock = {};
  let total = 0;

  for (const [variantId, data] of Object.entries(inv.variants)) {
    const available = Math.max(0, (data.qty || 0) - (data.reserved || 0));
    stock[variantId] = {
      qty: data.qty || 0,
      reserved: data.reserved || 0,
      available,
      backorder: data.backorder || false
    };
    total += data.qty || 0;
  }

  return new Response(JSON.stringify({
    productId,
    total,
    variants: stock,
    lastUpdated: inv.lastUpdated
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}
