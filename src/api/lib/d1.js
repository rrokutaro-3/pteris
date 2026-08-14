/**
 * Cloudflare D1 Database Layer
 * Replaces the dead MongoDB Atlas Data API.
 * Uses D1's native SQLite with transaction support.
 */

export class D1Store {
  constructor(db) {
    this.db = db;
  }

  // ─── Inventory ───
  async getInventory(productId) {
    const row = await this.db.prepare(
      'SELECT * FROM inventory WHERE product_id = ?'
    ).bind(productId).first();
    if (!row) return null;
    return {
      productId: row.product_id,
      variants: JSON.parse(row.variants),
      lastUpdated: row.last_updated
    };
  }

  async setInventory(productId, variants) {
    await this.db.prepare(`
      INSERT INTO inventory (product_id, variants, last_updated)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(product_id) DO UPDATE SET
        variants = excluded.variants,
        last_updated = excluded.last_updated
    `).bind(productId, JSON.stringify(variants)).run();
  }

  /**
   * Atomically check stock and reserve it.
   * Returns { ok: true, newVariants } or { ok: false, available }.
   *
   * IMPORTANT: This does NOT read the row, decide in JS, then write —
   * that pattern has a TOCTOU gap under concurrent requests (two callers
   * can both read "5 available" and both reserve 5, over-selling stock).
   * Instead this retries a compare-and-swap loop: read current variants,
   * compute the candidate new value, then write it back with a WHERE
   * clause that also requires the row's `variants` blob to be unchanged
   * (`AND variants = ?`) since it was read. If another request updated
   * the row in between, the UPDATE affects 0 rows and we retry with a
   * fresh read. This makes the whole check-then-reserve sequence
   * equivalent to a single atomic operation without needing D1 to
   * support SELECT-then-UPDATE inside one batch/transaction.
   */
  async reserveStock(productId, variantId, qty, maxRetries = 5) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const row = await this.db.prepare(
        'SELECT variants FROM inventory WHERE product_id = ?'
      ).bind(productId).first();

      if (!row) return { ok: false, available: 0, reason: 'product_not_found' };

      const rawVariants = row.variants;
      const variants = JSON.parse(rawVariants);
      const v = variants[variantId];
      if (!v) return { ok: false, available: 0, reason: 'variant_not_found' };

      const available = (v.qty || 0) - (v.reserved || 0);
      if (available < qty) {
        return { ok: false, available, reason: 'insufficient_stock' };
      }

      // Compute candidate new state
      const nextVariants = { ...variants, [variantId]: { ...v, reserved: (v.reserved || 0) + qty } };
      const nextRaw = JSON.stringify(nextVariants);

      // Compare-and-swap: only write if the row hasn't changed since we read it.
      const result = await this.db.prepare(`
        UPDATE inventory SET variants = ?, last_updated = datetime('now')
        WHERE product_id = ? AND variants = ?
      `).bind(nextRaw, productId, rawVariants).run();

      const rowsChanged = result.meta?.changes ?? result.changes ?? 0;
      if (rowsChanged > 0) {
        return { ok: true, newVariants: nextVariants };
      }
      // Someone else updated the row between our read and write — retry.
    }

    return { ok: false, available: 0, reason: 'concurrent_update_conflict' };
  }

  /**
   * Commit reserved stock (payment succeeded) or release it (payment failed).
   * Uses the same compare-and-swap retry pattern as reserveStock to avoid
   * clobbering concurrent updates to the same product's inventory row.
   */
  async commitStock(productId, variantId, qty, commit = true, maxRetries = 5) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const row = await this.db.prepare(
        'SELECT variants FROM inventory WHERE product_id = ?'
      ).bind(productId).first();

      if (!row) return false;
      const rawVariants = row.variants;
      const variants = JSON.parse(rawVariants);
      const v = variants[variantId];
      if (!v) return false;

      const nextV = { ...v };
      if (commit) {
        // Decrement qty, clear reserved
        nextV.qty = Math.max(0, (v.qty || 0) - qty);
        nextV.reserved = Math.max(0, (v.reserved || 0) - qty);
      } else {
        // Just release reservation
        nextV.reserved = Math.max(0, (v.reserved || 0) - qty);
      }

      const nextVariants = { ...variants, [variantId]: nextV };
      const nextRaw = JSON.stringify(nextVariants);

      const result = await this.db.prepare(`
        UPDATE inventory SET variants = ?, last_updated = datetime('now')
        WHERE product_id = ? AND variants = ?
      `).bind(nextRaw, productId, rawVariants).run();

      const rowsChanged = result.meta?.changes ?? result.changes ?? 0;
      if (rowsChanged > 0) return true;
      // Row changed since read — retry with fresh data.
    }

    return false;
  }

  // ─── Orders ───
  async createOrder(order) {
    await this.db.prepare(`
      INSERT INTO orders (id, items, customer, shipping, subtotal, shipping_cost, tax, total, status, stripe_session_id, coupon, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).bind(
      order.id,
      JSON.stringify(order.items),
      JSON.stringify(order.customer),
      JSON.stringify(order.shipping),
      order.subtotal,
      order.shippingCost,
      order.tax,
      order.total,
      order.status,
      order.stripeSessionId,
      order.coupon || null
    ).run();
  }

  async getOrder(id) {
    const row = await this.db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
    if (!row) return null;
    return this._hydrateOrder(row);
  }

  async getOrderBySession(sessionId) {
    const row = await this.db.prepare('SELECT * FROM orders WHERE stripe_session_id = ?').bind(sessionId).first();
    if (!row) return null;
    return this._hydrateOrder(row);
  }

  // Columns updateOrderStatus is allowed to write. This SQL is built by
  // interpolating object keys as column names, so anything reachable from
  // request input must be constrained to a known-safe allowlist — both to
  // avoid SQL injection via unexpected keys and to fail fast with a clear
  // error instead of a raw "no such column" from SQLite.
  static ORDER_UPDATABLE_COLUMNS = new Set([
    'status', 'stripe_session_id', 'stripe_payment_intent_id',
    'webhook_processed_at', 'tracking_number', 'carrier', 'notes',
    'refund_amount', 'refund_reason', 'refunded_at'
  ]);

  async updateOrderStatus(id, updates) {
    const fields = [];
    const values = [];
    for (const [k, v] of Object.entries(updates)) {
      if (!D1Store.ORDER_UPDATABLE_COLUMNS.has(k)) {
        throw new Error(`updateOrderStatus: "${k}" is not an updatable order column`);
      }
      fields.push(`${k} = ?`);
      values.push(v);
    }
    if (fields.length === 0) return;

    fields.push("updated_at = datetime('now')");
    values.push(id);

    await this.db.prepare(`UPDATE orders SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  }

  /**
   * Atomically claim an order for webhook processing: only applies
   * `updates` if the order's current `status` still equals
   * `expectedStatus` at the moment of the write.
   *
   * The stock reservation path (reserveStock/commitStock) was rewritten
   * as compare-and-swap specifically to close a check-then-act race, but
   * webhook-stripe.js's own idempotency check — read order, inspect
   * status/webhook_processed_at, then call plain updateOrderStatus() —
   * is the identical read-then-write pattern, unprotected. Stripe does
   * retry webhook delivery; two near-simultaneous deliveries for the
   * same session could both pass the idempotency check before either
   * write lands, double-committing stock (commitStock's own CAS prevents
   * corruption there, but qty would still be decremented twice) and
   * re-sending the confirmation email. This method closes that gap the
   * same way reserveStock closes it for inventory: the UPDATE's WHERE
   * clause requires status to still match what was read, so only one
   * concurrent caller can ever win the claim.
   *
   * Returns true if this call won the claim (and the update was
   * applied), false if another call already claimed it first.
   */
  async claimOrderStatus(id, expectedStatus, updates) {
    const fields = [];
    const values = [];
    for (const [k, v] of Object.entries(updates)) {
      if (!D1Store.ORDER_UPDATABLE_COLUMNS.has(k)) {
        throw new Error(`claimOrderStatus: "${k}" is not an updatable order column`);
      }
      fields.push(`${k} = ?`);
      values.push(v);
    }
    fields.push("updated_at = datetime('now')");
    values.push(id, expectedStatus);

    const result = await this.db.prepare(
      `UPDATE orders SET ${fields.join(', ')} WHERE id = ? AND status = ?`
    ).bind(...values).run();

    const rowsChanged = result.meta?.changes ?? result.changes ?? 0;
    return rowsChanged > 0;
  }

  // Returns { orders, total } — `total` is the true count of orders
  // matching the filter (across all pages), not the page size. A
  // previous version of the admin route reported `orders.length` (i.e.
  // at most `limit`) as "total", which meant an admin UI paginating on
  // it could never tell how many pages actually existed.
  async listOrders({ page = 1, limit = 20, status = null } = {}) {
    const where = status ? ' WHERE status = ?' : '';
    const whereParams = status ? [status] : [];

    let sql = 'SELECT * FROM orders' + where;
    const params = [...whereParams];
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, (page - 1) * limit);

    const [{ results }, countRow] = await this.db.batch([
      this.db.prepare(sql).bind(...params),
      this.db.prepare('SELECT COUNT(*) as c FROM orders' + where).bind(...whereParams),
    ]);

    return {
      orders: results.map(r => this._hydrateOrder(r)),
      total: countRow.results?.[0]?.c || 0,
    };
  }

  _hydrateOrder(row) {
    return {
      id: row.id,
      items: JSON.parse(row.items),
      customer: JSON.parse(row.customer),
      shipping: JSON.parse(row.shipping),
      subtotal: row.subtotal,
      shippingCost: row.shipping_cost,
      tax: row.tax,
      total: row.total,
      status: row.status,
      stripeSessionId: row.stripe_session_id,
      stripePaymentIntentId: row.stripe_payment_intent_id,
      coupon: row.coupon,
      webhookProcessedAt: row.webhook_processed_at,
      // Fulfillment + refund fields (admin UI reads these)
      trackingNumber: row.tracking_number || null,
      carrier: row.carrier || null,
      notes: row.notes || null,
      refundAmount: row.refund_amount ?? null,
      refundReason: row.refund_reason || null,
      refundedAt: row.refunded_at || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  // ─── Prices (server-side verification) ───
  async getPrice(productId, variantId) {
    return this.db.prepare(
      'SELECT * FROM prices WHERE product_id = ? AND variant_id = ?'
    ).bind(productId, variantId).first();
  }

  async setPrices(prices) {
    const stmt = this.db.prepare(`
      INSERT INTO prices (product_id, variant_id, sku, price, compare_at_price, currency, sale_active, sale_price, weight, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(product_id, variant_id) DO UPDATE SET
        sku = excluded.sku,
        price = excluded.price,
        compare_at_price = excluded.compare_at_price,
        currency = excluded.currency,
        sale_active = excluded.sale_active,
        sale_price = excluded.sale_price,
        weight = excluded.weight,
        updated_at = excluded.updated_at
    `);

    const batch = prices.map(p => stmt.bind(
      p.productId, p.variantId, p.sku, p.price, p.compareAtPrice, p.currency,
      p.saleActive ? 1 : 0, p.salePrice, p.weight || 0
    ));

    await this.db.batch(batch);
  }

  // ─── Reservations (TTL) ───
  async createReservation(orderId, productId, variantId, qty, ttlMinutes) {
    const id = `res_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

    await this.db.prepare(`
      INSERT INTO reservations (id, order_id, product_id, variant_id, qty, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(id, orderId, productId, variantId, qty, expiresAt).run();

    return id;
  }

  async releaseReservation(orderId) {
    await this.db.prepare('DELETE FROM reservations WHERE order_id = ?').bind(orderId).run();
  }

  async cleanupExpiredReservations() {
    // Find expired reservations
    const { results } = await this.db.prepare(`
      SELECT * FROM reservations WHERE expires_at < datetime('now')
    `).all();

    for (const row of results) {
      // Release stock
      await this.commitStock(row.product_id, row.variant_id, row.qty, false);
    }

    // Delete them
    await this.db.prepare(`DELETE FROM reservations WHERE expires_at < datetime('now')`).run();
    return results.length;
  }

  // ─── Coupons ───
  async recordCouponUsage(code, orderId, customerEmail) {
    await this.db.prepare(`
      INSERT INTO coupon_usage (code, order_id, customer_email, used_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(code, order_id) DO NOTHING
    `).bind(code.toUpperCase(), orderId, customerEmail).run();
  }

  async getCouponUsageCount(code) {
    const row = await this.db.prepare(
      'SELECT COUNT(*) as c FROM coupon_usage WHERE code = ?'
    ).bind(code.toUpperCase()).first();
    return row?.c || 0;
  }

  // ─── Reviews ───
  async createReview(review) {
    await this.db.prepare(`
      INSERT INTO reviews (id, product_id, customer_name, rating, title, body, verified, images, helpful, created_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'pending')
    `).bind(
      review.id, review.productId, review.customerName, review.rating,
      review.title, review.body, review.verified ? 1 : 0,
      JSON.stringify(review.images || []), review.helpful || 0
    ).run();
  }

  async getApprovedReviews(productId) {
    const { results } = await this.db.prepare(`
      SELECT * FROM reviews WHERE product_id = ? AND status = 'approved' ORDER BY created_at DESC
    `).bind(productId).all();
    return results;
  }

  // ─── Stats ───
  async getStats(lowStockThreshold = 5) {
    // NOTE: `variants` is a JSON *object* keyed by variant ID
    // (e.g. {"v-1": {"qty": 10, ...}}), not an array. A previous version
    // of this query used json_extract(variants, '$[0].qty'), which treats
    // it as an array and either errors or silently returns NULL against
    // the real data — so low-stock counting never worked. SQLite doesn't
    // have a clean way to test "any object value's qty is below N"
    // without json_each, so we just fetch the (small) inventory table and
    // compute it in JS, same as the admin lowStock filter already does.
    const [products, ordersToday, ordersWeek, ordersMonth, inventoryRows] = await this.db.batch([
      this.db.prepare("SELECT COUNT(*) as c FROM inventory"),
      this.db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(total), 0) as rev FROM orders WHERE status = 'paid' AND date(created_at) = date('now')"),
      this.db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(total), 0) as rev FROM orders WHERE status = 'paid' AND created_at >= datetime('now', '-7 days')"),
      this.db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(total), 0) as rev FROM orders WHERE status = 'paid' AND created_at >= datetime('now', '-30 days')"),
      this.db.prepare("SELECT variants FROM inventory"),
    ]);

    let lowStockCount = 0;
    for (const row of inventoryRows.results || []) {
      try {
        const variants = JSON.parse(row.variants);
        const isLow = Object.values(variants).some(
          v => Math.max(0, (v.qty || 0) - (v.reserved || 0)) <= lowStockThreshold
        );
        if (isLow) lowStockCount++;
      } catch {
        // Skip malformed rows rather than failing the whole stats call.
      }
    }

    return {
      products: { total: products.results[0]?.c || 0 },
      orders: {
        today: ordersToday.results[0]?.c || 0,
        thisWeek: ordersWeek.results[0]?.c || 0,
        thisMonth: ordersMonth.results[0]?.c || 0
      },
      revenue: {
        today: +(ordersToday.results[0]?.rev || 0).toFixed(2),
        thisWeek: +(ordersWeek.results[0]?.rev || 0).toFixed(2),
        thisMonth: +(ordersMonth.results[0]?.rev || 0).toFixed(2)
      },
      inventory: {
        lowStock: lowStockCount
      }
    };
  }
}
