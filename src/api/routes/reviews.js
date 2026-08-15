/**
 * Public review routes
 * POST /api/reviews          — submit a review (always pending)
 * GET  /api/reviews/:productId — list approved reviews for a product
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

/** Strip HTML tags and control characters; collapse whitespace; enforce max length. */
function sanitizePlainText(value, maxLen = 2000) {
  if (value == null) return '';
  let s = String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

function isValidProductId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id);
}

export async function handleReviews(request, env, { path, method }) {
  const db = new D1Store(env.DB);

  // GET /api/reviews/:productId
  const getMatch = path.match(/^\/api\/reviews\/([^/]+)$/);
  if (getMatch && method === 'GET') {
    const productId = decodeURIComponent(getMatch[1]);
    if (!isValidProductId(productId)) {
      return json({ error: 'Invalid product id' }, 400);
    }
    const reviews = await db.getApprovedReviews(productId);
    return json({ productId, reviews, count: reviews.length });
  }

  // POST /api/reviews
  if (path === '/api/reviews' && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const productId = body.productId;
    if (!isValidProductId(productId)) {
      return json({ error: 'productId is required and must be a valid id' }, 400);
    }

    const customerName = sanitizePlainText(body.customerName || body.name, 80);
    if (!customerName || customerName.length < 2) {
      return json({ error: 'customerName is required (min 2 characters)' }, 400);
    }

    // Accept numeric or numeric-string ratings; reject floats like 4.5.
    const rating = typeof body.rating === 'string' ? parseInt(body.rating, 10) : Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return json({ error: 'rating must be an integer from 1 to 5' }, 400);
    }

    const title = sanitizePlainText(body.title, 120) || null;
    const bodyText = sanitizePlainText(body.body || body.text || body.review, 2000);
    if (!bodyText || bodyText.length < 5) {
      return json({ error: 'Review body is required (min 5 characters)' }, 400);
    }

    // Optional images: only allow http(s) URLs, max 5
    let images = [];
    if (Array.isArray(body.images)) {
      images = body.images
        .filter(u => typeof u === 'string' && /^https?:\/\//i.test(u) && u.length < 500)
        .slice(0, 5);
    }

    const id = crypto.randomUUID();

    await db.createReview({
      id,
      productId,
      customerName,
      rating,
      title,
      body: bodyText,
      verified: false,
      images,
      helpful: 0
    });

    return json({
      success: true,
      id,
      status: 'pending',
      message: 'Review submitted and awaiting moderation'
    }, 201);
  }

  return json({ error: 'Not found' }, 404);
}
