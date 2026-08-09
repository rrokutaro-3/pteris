/**
 * Lean E-Commerce API v2 — Cloudflare Worker Entry Point
 * D1 database, Stripe checkout, Resend emails.
 */

import { handleCheckout } from './routes/checkout.js';
import { handleStripeWebhook } from './routes/webhook-stripe.js';
import { handleAdmin } from './routes/admin.js';
import { handleStockCheck } from './routes/stock.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === '/api/health') {
        return jsonResponse({ status: 'ok', version: '2.2.0' });
      }

      if (path === '/api/checkout' && method === 'POST') {
        return await handleCheckout(request, env);
      }

      if (path === '/api/webhook/stripe' && method === 'POST') {
        return await handleStripeWebhook(request, env);
      }

      if (path.startsWith('/api/stock/') && method === 'GET') {
        const productId = path.split('/api/stock/')[1];
        return await handleStockCheck(productId, env);
      }

      if (path.startsWith('/api/admin')) {
        return await handleAdmin(request, env, { path, method });
      }

      return jsonResponse({ error: 'Not found' }, 404);

    } catch (err) {
      // Log full detail server-side, but don't leak internal error
      // messages (which can reveal stack traces, file paths, DB errors,
      // etc.) to the client.
      console.error('API Error:', err);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  }
};
