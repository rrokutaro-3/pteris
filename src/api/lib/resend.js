/**
 * Resend email API helper for Cloudflare Workers.
 */

/**
 * Escape a value for safe interpolation into HTML markup.
 *
 * A previous version of sendOrderConfirmation() interpolated order/item
 * fields (customer name, item name, variant label) directly into an HTML
 * email template with no escaping. Those fields ultimately come from
 * customer-submitted checkout input or product data — if a customer
 * enters a name like `<img src=x onerror=alert(1)>`, or a product name
 * contains markup, it would be injected verbatim into the confirmation
 * email's HTML.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class ResendAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.resend.com';
  }

  async sendEmail({ from, to, subject, html, text }) {
    const res = await fetch(`${this.baseUrl}/emails`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html, text })
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Resend error: ${err}`);
    }

    return res.json();
  }

  async sendOrderConfirmation(order, storeConfig) {
    const items = order.items.map(i =>
      `<tr><td>${escapeHtml(i.name)}</td><td>${escapeHtml(i.variantLabel || i.variantId)}</td><td>${escapeHtml(i.qty)}</td><td>$${escapeHtml(i.price)}</td></tr>`
    ).join('');

    const html = `
      <h1>Order Confirmation</h1>
      <p>Thank you for your order, ${escapeHtml(order.customer.name)}!</p>
      <p><strong>Order ID:</strong> ${escapeHtml(order.id)}</p>
      <table border="1" cellpadding="8">
        <tr><th>Product</th><th>Variant</th><th>Qty</th><th>Price</th></tr>
        ${items}
      </table>
      <p><strong>Subtotal:</strong> $${escapeHtml(order.subtotal)}</p>
      <p><strong>Shipping:</strong> $${escapeHtml(order.shippingCost)}</p>
      ${order.tax > 0 ? `<p><strong>Tax:</strong> $${escapeHtml(order.tax)}</p>` : ''}
      <p><strong>Total:</strong> $${escapeHtml(order.total)}</p>
      <p>We'll send tracking info once your order ships.</p>
    `;

    return this.sendEmail({
      from: storeConfig.fromEmail || 'orders@yourbrand.com',
      to: order.customer.email,
      subject: `Order Confirmation — ${order.id}`,
      html
    });
  }
}
