/**
 * Public email subscription routes
 * POST /api/subscribe     — { email, source? }
 * POST /api/unsubscribe   — { token } or { email }
 * GET  /api/unsubscribe?token=...  — one-click unsubscribe from email links
 */

import { D1Store } from '../lib/d1.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export async function handleSubscribe(request, env, { path, method }) {
  const db = new D1Store(env.DB);
  const url = new URL(request.url);

  // GET /api/unsubscribe?token=...
  if (path === '/api/unsubscribe' && method === 'GET') {
    const token = url.searchParams.get('token');
    if (!token) {
      return json({ error: 'token query parameter is required' }, 400);
    }
    const result = await db.unsubscribeByToken(token);
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : 400;
      return json({ error: result.error || 'Unsubscribe failed' }, status);
    }
    return json({
      success: true,
      email: result.email,
      alreadyUnsubscribed: !!result.alreadyUnsubscribed,
      message: result.alreadyUnsubscribed
        ? 'Already unsubscribed'
        : 'You have been unsubscribed'
    });
  }

  // POST /api/unsubscribe
  if (path === '/api/unsubscribe' && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    let result;
    if (body.token) {
      result = await db.unsubscribeByToken(body.token);
    } else if (body.email) {
      result = await db.unsubscribeByEmail(body.email);
    } else {
      return json({ error: 'Provide token or email' }, 400);
    }

    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : 400;
      return json({ error: result.error || 'Unsubscribe failed' }, status);
    }
    return json({
      success: true,
      email: result.email,
      alreadyUnsubscribed: !!result.alreadyUnsubscribed
    });
  }

  // POST /api/subscribe
  if (path === '/api/subscribe' && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const email = (body.email || '').trim();
    if (!isValidEmail(email)) {
      return json({ error: 'A valid email is required' }, 400);
    }

    const source = typeof body.source === 'string'
      ? body.source.slice(0, 64).replace(/[^\w\s.-]/g, '')
      : null;

    const result = await db.addSubscriber(email, source);
    if (!result.ok) {
      return json({ error: result.error || 'Subscribe failed' }, 400);
    }

    // Do not return the unsubscribe token to the public response — it is
    // only needed in confirmation emails (which the SPA / Resend can send
    // separately if desired). Returning it here would let anyone who can
    // POST subscribe also obtain a valid unsubscribe token for that address.
    return json({
      success: true,
      email: result.email,
      alreadySubscribed: !!result.alreadySubscribed,
      reactivated: !!result.reactivated,
      message: result.alreadySubscribed
        ? 'Already subscribed'
        : result.reactivated
          ? 'Subscription reactivated'
          : 'Subscribed successfully'
    }, result.alreadySubscribed ? 200 : 201);
  }

  return json({ error: 'Not found' }, 404);
}
