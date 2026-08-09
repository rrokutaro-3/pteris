/**
 * POST /api/webhook/stripe
 * Handles Stripe payment events with:
 * - HMAC signature verification
 * - Idempotency (webhook_processed_at check)
 * - Atomic stock commit/release
 * - Duplicate protection
 */

import { D1Store } from '../lib/d1.js';
import { StripeAPI } from '../lib/stripe.js';
import { ResendAPI } from '../lib/resend.js';

export async function handleStripeWebhook(request, env) {
  const payload = await request.text();
  const sig = request.headers.get('stripe-signature');

  if (!sig) {
    return new Response('Missing signature', { status: 400 });
  }

  // Verify HMAC signature
  const stripe = new StripeAPI(env.STRIPE_SECRET_KEY);
  const isValid = await stripe.verifyWebhook(payload, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!isValid) {
    return new Response('Invalid signature', { status: 401 });
  }

  const event = JSON.parse(payload);
  const db = new D1Store(env.DB);
  const resend = new ResendAPI(env.RESEND_API_KEY);

  // ─── checkout.session.completed ───
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata?.order_id;

    if (!orderId) {
      console.error('Webhook missing order_id in metadata');
      return new Response('Missing order_id', { status: 400 });
    }

    const order = await db.getOrder(orderId);
    if (!order) {
      console.error('Order not found:', orderId);
      return new Response('Order not found', { status: 404 });
    }

    // Fast-path check first (cheap, avoids a wasted UPDATE for the
    // common case of a genuinely duplicate delivery long after the fact).
    if (order.status === 'paid' || order.webhookProcessedAt) {
      console.log('Webhook already processed for order:', orderId);
      return new Response('Already processed', { status: 200 });
    }

    // IDEMPOTENCY: atomically claim this order for processing. The
    // fast-path check above has the same read-then-write gap the stock
    // reservation logic used to have — two near-simultaneous webhook
    // deliveries for the same session (Stripe does retry) could both
    // pass it before either write lands. claimOrderStatus() only applies
    // the update if status is still 'pending' at write time, so only one
    // concurrent delivery can win; the loser treats it as already handled
    // instead of double-committing stock and double-sending the email.
    const claimed = await db.claimOrderStatus(orderId, 'pending', {
      status: 'paid',
      stripe_payment_intent_id: session.payment_intent,
      webhook_processed_at: new Date().toISOString()
    });
    if (!claimed) {
      console.log('Webhook already claimed by a concurrent delivery for order:', orderId);
      return new Response('Already processed', { status: 200 });
    }

    // Commit stock (decrement qty, clear reserved)
    for (const item of order.items) {
      await db.commitStock(item.productId, item.variantId, item.qty, true);
    }

    // Release reservation records
    await db.releaseReservation(orderId);

    // Track coupon usage
    if (order.coupon) {
      // NOTE: `db` here is a D1Store instance, not the raw D1 binding —
      // it has no `.prepare()` method. A previous version of this code
      // called db.prepare(...) directly, which threw at runtime and
      // crashed the webhook handler *after* stock had already been
      // committed, leaving the order in an inconsistent state.
      await db.recordCouponUsage(order.coupon, orderId, order.customer.email);
    }

    // Send confirmation email
    try {
      await resend.sendOrderConfirmation(order, { fromEmail: env.RESEND_FROM_EMAIL });
    } catch (err) {
      console.error('Email failed:', err);
      // Don't fail the webhook — email can be retried manually
    }

    return new Response('Payment processed', { status: 200 });
  }

  // ─── checkout.session.expired ───
  if (event.type === 'checkout.session.expired') {
    const session = event.data.object;
    const orderId = session.metadata?.order_id;

    if (!orderId) return new Response('Missing order_id', { status: 400 });

    const order = await db.getOrder(orderId);
    if (!order) return new Response('Order not found', { status: 404 });

    // Fast-path check, then atomic claim — same reasoning as
    // checkout.session.completed above. Only proceed to release stock if
    // this call actually won the transition from 'pending' to
    // 'cancelled'; a concurrent duplicate delivery (or a race with the
    // reservation-expiry cleanup path) shouldn't release the same
    // reservation's stock twice.
    if (order.status !== 'pending') {
      return new Response('Already handled', { status: 200 });
    }

    const claimed = await db.claimOrderStatus(orderId, 'pending', { status: 'cancelled' });
    if (!claimed) {
      return new Response('Already handled', { status: 200 });
    }

    // Release reserved stock
    for (const item of order.items) {
      await db.commitStock(item.productId, item.variantId, item.qty, false);
    }

    await db.releaseReservation(orderId);

    return new Response('Order cancelled', { status: 200 });
  }

  // ─── payment_intent.payment_failed ───
  if (event.type === 'payment_intent.payment_failed') {
    const paymentIntent = event.data.object;
    // Find order by payment intent (if available) or skip
    // Stripe doesn't always include metadata here, so we may need to look up by session
    return new Response('Ignored', { status: 200 });
  }

  return new Response('Event ignored', { status: 200 });
}
