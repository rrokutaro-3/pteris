-- Cloudflare D1 Schema for Lean E-Commerce Engine
-- Run: wrangler d1 execute lean-store-db --file=src/schema/d1-schema.sql

-- Inventory: live stock quantities
CREATE TABLE IF NOT EXISTS inventory (
  product_id TEXT PRIMARY KEY,
  variants TEXT NOT NULL,           -- JSON: {"v-xxx": {"qty": 10, "reserved": 0, "backorder": false}}
  last_updated TEXT NOT NULL
);

-- Orders: purchase history
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  items TEXT NOT NULL,              -- JSON array of line items
  customer TEXT NOT NULL,           -- JSON: {"name": "...", "email": "..."}
  shipping TEXT NOT NULL,           -- JSON: {"address": "...", ...}
  subtotal REAL NOT NULL,
  shipping_cost REAL NOT NULL,
  tax REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  stripe_session_id TEXT,
  stripe_payment_intent_id TEXT,
  coupon TEXT,
  webhook_processed_at TEXT,        -- For idempotency
  -- Fulfillment fields, set via PATCH /api/admin/orders/:id/status.
  -- Previously the admin route wrote camelCase keys (trackingNumber,
  -- carrier, notes) that had no matching columns at all, so any PATCH
  -- with those fields threw a "no such column" SQL error.
  tracking_number TEXT,
  carrier TEXT,
  notes TEXT,
  -- Customer-facing note from checkout (gift message, delivery instructions).
  -- Separate from admin `notes` which are internal fulfillment comments.
  customer_note TEXT,
  -- Refund fields, set via POST /api/admin/orders/:id/refund.
  -- Same issue: refundAmount/refundReason/refundedAt had no columns.
  refund_amount REAL,
  refund_reason TEXT,
  refunded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Existing databases created before customer_note was added need:
--   wrangler d1 execute lean-store-db --remote --command "ALTER TABLE orders ADD COLUMN customer_note TEXT"

-- Price verification table (populated at build time)
CREATE TABLE IF NOT EXISTS prices (
  product_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  price REAL NOT NULL,
  compare_at_price REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  sale_active INTEGER DEFAULT 0,
  sale_price REAL,
  -- Weight in kg, synced from the built product data. Checkout uses this
  -- (not the client-submitted cart weight) to compute shipping, since a
  -- client can set any weight it wants on a cart item — the same
  -- spoofing risk that price verification exists to prevent.
  weight REAL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product_id, variant_id)
);

-- Reviews
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  title TEXT,
  body TEXT,
  verified INTEGER DEFAULT 0,
  images TEXT,                      -- JSON array of image URLs
  helpful INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected'))
);

-- Coupon usage tracking
CREATE TABLE IF NOT EXISTS coupon_usage (
  code TEXT NOT NULL,
  order_id TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  used_at TEXT NOT NULL,
  PRIMARY KEY (code, order_id)
);

-- Stock reservations with TTL (for cleanup)
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  qty INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Email / newsletter subscribers
CREATE TABLE IF NOT EXISTS subscribers (
  email TEXT PRIMARY KEY,                 -- normalized lowercase
  subscribed_at TEXT NOT NULL,
  unsubscribed_at TEXT,                   -- null = currently subscribed
  unsubscribe_token TEXT NOT NULL UNIQUE,
  source TEXT                             -- e.g. 'footer', 'checkout', 'popup'
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id, status);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status, created_at);
CREATE INDEX IF NOT EXISTS idx_reservations_expires ON reservations(expires_at);
CREATE INDEX IF NOT EXISTS idx_reservations_order ON reservations(order_id);
CREATE INDEX IF NOT EXISTS idx_subscribers_token ON subscribers(unsubscribe_token);
CREATE INDEX IF NOT EXISTS idx_subscribers_active ON subscribers(subscribed_at) WHERE unsubscribed_at IS NULL;
