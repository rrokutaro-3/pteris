#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Lean Store — One-shot setup script
# Run this once from your Codespace after cloning the repo.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}→${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
warn()    { echo -e "${YELLOW}!${NC} $1"; }
error()   { echo -e "${RED}✗${NC} $1"; exit 1; }

echo ""
echo "╔══════════════════════════════════════╗"
echo "║      Lean Store Setup Wizard         ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── Collect inputs ──────────────────────────────────────────

prompt() {
  local var="$1" label="$2" default="${3:-}"
  if [ -n "$default" ]; then
    read -rp "$(echo -e "${BLUE}?${NC} ${label} [${default}]: ")" val
    val="${val:-$default}"
  else
    read -rp "$(echo -e "${BLUE}?${NC} ${label}: ")" val
    while [ -z "$val" ]; do
      warn "Required."
      read -rp "$(echo -e "${BLUE}?${NC} ${label}: ")" val
    done
  fi
  eval "$var=\"$val\""
}

prompt_secret() {
  local var="$1" label="$2"
  read -srp "$(echo -e "${BLUE}?${NC} ${label}: ")" val
  echo ""
  while [ -z "$val" ]; do
    warn "Required."
    read -srp "$(echo -e "${BLUE}?${NC} ${label}: ")" val
    echo ""
  done
  eval "$var=\"$val\""
}

echo "── Cloudflare ─────────────────────────────────────────"
prompt        CF_API_TOKEN    "Cloudflare API Token"
prompt        CF_ACCOUNT_ID   "Cloudflare Account ID"
prompt        PAGES_PROJECT   "Pages project name (becomes your-name.pages.dev)" "my-store"
prompt        R2_BUCKET_NAME  "R2 bucket name for product media (leave blank to skip)" ""

R2_PUBLIC_URL=""
if [ -n "$R2_BUCKET_NAME" ]; then
  echo ""
  echo -e "  ${YELLOW}R2 public URL — where to find it:${NC}"
  echo "  1. Cloudflare dashboard → R2 → your bucket → Settings → Public Access"
  echo "  2. Click 'Allow Access' to enable the r2.dev subdomain"
  echo "  3. Copy the URL that appears (looks like https://pub-xxxx.r2.dev)"
  echo "  Leave blank now and re-run the one-liner in SETUP.md later if you haven't done this yet."
  echo ""
  prompt R2_PUBLIC_URL "R2 public URL (https://pub-xxxx.r2.dev or your custom domain)" ""
fi

echo ""
echo "── Stripe ─────────────────────────────────────────────"
prompt_secret STRIPE_SECRET   "Stripe Secret Key (sk_test_...)"
prompt_secret STRIPE_WEBHOOK  "Stripe Webhook Secret (whsec_...) — set up later? Leave blank" || STRIPE_WEBHOOK=""

echo ""
echo "── Resend ─────────────────────────────────────────────"
prompt_secret RESEND_KEY      "Resend API Key — leave blank to skip" || RESEND_KEY=""
prompt        RESEND_EMAIL    "From email address" "orders@yourdomain.com"

echo ""
echo "── Admin ───────────────────────────────────────────────"
ADMIN_KEY=$(LC_ALL=C tr -dc 'A-Za-z0-9!@#$%^&*' </dev/urandom | head -c 32 2>/dev/null || echo "")
if [ -z "$ADMIN_KEY" ]; then
  prompt_secret ADMIN_KEY "Admin API Key (make up a long random password)"
else
  echo -e "${BLUE}?${NC} Admin API Key (auto-generated — save this!): ${GREEN}${ADMIN_KEY}${NC}"
fi

echo ""
echo "── Running setup ───────────────────────────────────────"

# Export for wrangler AND all child node processes (build pipeline, seed script)
export CLOUDFLARE_API_TOKEN="$CF_API_TOKEN"
export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"

# ── npm install ──────────────────────────────────────────────
info "Installing dependencies..."
npm install --silent
success "Dependencies installed"

# ── Create D1 database ───────────────────────────────────────
info "Creating D1 database..."
D1_OUTPUT=$(npx wrangler d1 create lean-store-db 2>&1 || true)

if echo "$D1_OUTPUT" | grep -q "database_id"; then
  D1_ID=$(echo "$D1_OUTPUT" | grep 'database_id' | sed 's/.*database_id = "\(.*\)"/\1/' | tr -d '[:space:]')
  success "D1 database created: $D1_ID"
elif echo "$D1_OUTPUT" | grep -qi "already exists\|already created"; then
  info "Database already exists, fetching ID..."
  D1_ID=$(npx wrangler d1 list --json 2>/dev/null | python3 -c "
import sys, json
dbs = json.load(sys.stdin)
match = [d for d in dbs if d.get('name') == 'lean-store-db']
print(match[0]['uuid'] if match else '')
" 2>/dev/null | tr -d '[:space:]')
  if [ -z "$D1_ID" ]; then
    error "Could not determine D1 database ID. Run: npx wrangler d1 list --json"
  fi
  success "Using existing D1 database: $D1_ID"
else
  echo "$D1_OUTPUT"
  error "D1 creation failed. Check your API token permissions (needs Workers D1: Edit)."
fi

export D1_DATABASE_ID="$D1_ID"

# ── Resolve Worker subdomain early ──────────────────────────
# wrangler whoami must succeed before we write store-config.js or
# print "Your API" — if we can't get it here, fail loudly rather than
# silently writing a broken placeholder URL that causes 500s on checkout.
info "Resolving Worker subdomain..."
WHOAMI_OUTPUT=$(npx wrangler whoami 2>&1 || true)
WORKER_SUBDOMAIN=$(echo "$WHOAMI_OUTPUT" | grep -o '[a-z0-9-]*\.workers\.dev' | head -1 || true)

if [ -z "$WORKER_SUBDOMAIN" ]; then
  echo ""
  echo -e "${RED}✗ Could not detect your Workers subdomain from 'wrangler whoami'.${NC}"
  echo ""
  echo "  This usually means your API token doesn't have the right permissions."
  echo "  Your token needs: Workers Scripts:Edit, D1:Edit, Pages:Edit"
  echo ""
  echo "  Alternatively, enter your subdomain manually."
  echo "  Find it at: Cloudflare dashboard → Workers → Overview (shown as 'yourname.workers.dev')"
  echo ""
  prompt WORKER_SUBDOMAIN "Your workers.dev subdomain (e.g. 'rrokutaro-3.workers.dev')"
  # Strip any https:// or trailing slashes they may have pasted
  WORKER_SUBDOMAIN="${WORKER_SUBDOMAIN#https://}"
  WORKER_SUBDOMAIN="${WORKER_SUBDOMAIN%/}"
fi

success "Worker subdomain: ${WORKER_SUBDOMAIN}"
API_URL="https://lean-store-api.${WORKER_SUBDOMAIN}/api"

# ── Create R2 bucket (if requested) ─────────────────────────
if [ -n "$R2_BUCKET_NAME" ]; then
  info "Creating R2 bucket: ${R2_BUCKET_NAME}..."
  R2_OUTPUT=$(npx wrangler r2 bucket create "$R2_BUCKET_NAME" 2>&1 || true)

  if echo "$R2_OUTPUT" | grep -qi "created\|success"; then
    success "R2 bucket created: ${R2_BUCKET_NAME}"
  elif echo "$R2_OUTPUT" | grep -qi "already exists"; then
    info "R2 bucket already exists — using it"
  else
    echo "$R2_OUTPUT"
    warn "R2 bucket creation may have failed — continuing anyway. Check: npx wrangler r2 bucket list"
  fi
fi

# ── Patch wrangler.toml ──────────────────────────────────────
info "Updating wrangler.toml..."
STORE_URL="https://${PAGES_PROJECT}.pages.dev"

sed -i \
  -e "s|database_id = \"your-d1-database-id\"|database_id = \"${D1_ID}\"|" \
  -e "s|STORE_URL = \".*\"|STORE_URL = \"${STORE_URL}\"|" \
  -e "s|RESEND_FROM_EMAIL = \".*\"|RESEND_FROM_EMAIL = \"${RESEND_EMAIL}\"|" \
  wrangler.toml

if [ -n "$R2_BUCKET_NAME" ]; then
  sed -i -e "s|bucket_name = \"your-store-assets\"|bucket_name = \"${R2_BUCKET_NAME}\"|" wrangler.toml

  if [ -n "$R2_PUBLIC_URL" ]; then
    R2_PUBLIC_URL="${R2_PUBLIC_URL%/}"
    sed -i -e "s|CDN_BASE_URL = \".*\"|CDN_BASE_URL = \"${R2_PUBLIC_URL}\"|" wrangler.toml
    success "wrangler.toml updated (R2 bucket: ${R2_BUCKET_NAME}, CDN: ${R2_PUBLIC_URL})"
  else
    sed -i -e "s|CDN_BASE_URL = \".*\"|CDN_BASE_URL = \"${STORE_URL}\"|" wrangler.toml
    success "wrangler.toml updated (R2 bucket: ${R2_BUCKET_NAME}, CDN: pending — see below)"
    warn "CDN_BASE_URL not set yet. Once you enable public access on the R2 bucket:"
    warn "  Run: npx wrangler vars put CDN_BASE_URL https://pub-xxxx.r2.dev"
    warn "  Then redeploy: npm run deploy:api"
  fi
else
  sed -i -e "s|CDN_BASE_URL = \".*\"|CDN_BASE_URL = \"${STORE_URL}\"|" wrangler.toml
  success "wrangler.toml updated (no R2 — CDN points to Pages)"
fi

# ── Run DB migration ─────────────────────────────────────────
info "Running database migration..."
npm run db:migrate -- --remote
success "Database migrated"

# ── Seed inventory from product files ───────────────────────
info "Seeding inventory from product files..."
node - << 'JSEOF'
import fs from 'fs/promises';
import path from 'path';

const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN  = process.env.CLOUDFLARE_API_TOKEN;
const D1_DB_ID      = process.env.D1_DATABASE_ID;

async function d1Query(sql, params = []) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DB_ID}/query`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params })
    }
  );
  const data = await res.json();
  if (!data.success) throw new Error(`D1 query failed: ${JSON.stringify(data.errors)}`);
  return data.result?.[0]?.results || [];
}

const SOURCE_DIR = './data/source/products';
const files = (await fs.readdir(SOURCE_DIR)).filter(f => f.endsWith('.json'));
let seeded = 0;

for (const file of files) {
  const product = JSON.parse(await fs.readFile(path.join(SOURCE_DIR, file), 'utf-8'));
  if (!product.variants?.length) continue;

  const variants = {};
  for (const v of product.variants) {
    variants[v.id] = { qty: v.stock ?? 0, reserved: 0, backorder: v.backorder ?? false };
  }

  await d1Query(
    `INSERT INTO inventory (product_id, variants, last_updated)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(product_id) DO UPDATE SET variants = excluded.variants, last_updated = excluded.last_updated`,
    [product.id, JSON.stringify(variants)]
  );
  seeded++;
}
console.log(`   Seeded inventory for ${seeded} products`);
JSEOF
success "Inventory seeded"

# ── Set Wrangler secrets ─────────────────────────────────────
info "Setting Cloudflare Worker secrets..."

echo "$STRIPE_SECRET" | npx wrangler secret put STRIPE_SECRET_KEY --name lean-store-api 2>/dev/null
success "STRIPE_SECRET_KEY set"

if [ -n "$STRIPE_WEBHOOK" ]; then
  echo "$STRIPE_WEBHOOK" | npx wrangler secret put STRIPE_WEBHOOK_SECRET --name lean-store-api 2>/dev/null
  success "STRIPE_WEBHOOK_SECRET set"
else
  warn "STRIPE_WEBHOOK_SECRET skipped — set it later with: npx wrangler secret put STRIPE_WEBHOOK_SECRET"
fi

if [ -n "$RESEND_KEY" ]; then
  echo "$RESEND_KEY" | npx wrangler secret put RESEND_API_KEY --name lean-store-api 2>/dev/null
  success "RESEND_API_KEY set"
else
  warn "RESEND_API_KEY skipped — set it later with: npx wrangler secret put RESEND_API_KEY"
fi

echo "$ADMIN_KEY" | npx wrangler secret put ADMIN_API_KEY --name lean-store-api 2>/dev/null
success "ADMIN_API_KEY set"

# ── Deploy Worker ────────────────────────────────────────────
info "Deploying Worker (lean-store-api)..."
npm run deploy:api
success "Worker deployed"

# ── Create Pages project ─────────────────────────────────────
info "Creating Pages project (${PAGES_PROJECT})..."
echo "main" | npx wrangler pages project create "$PAGES_PROJECT" 2>/dev/null || warn "Pages project may already exist"
success "Pages project ready"

# ── Write store-config.js before build so catalog deploy picks it up ──
# This must happen BEFORE npm run build + pages deploy so the correct
# API_URL is baked into the deployed static files. The original script
# wrote it AFTER the deploy, meaning every first setup shipped a broken
# store-config.js (or none at all if whoami failed).
info "Writing store-config.js..."
mkdir -p data
cat > data/store-config.js << CONFIGEOF
// Auto-generated by setup.sh — do not edit manually.
// Re-run setup.sh or update these values if your URLs change.
window.__STORE_URL__ = '${STORE_URL}';
window.__API_URL__   = '${API_URL}';
CONFIGEOF
success "store-config.js written (API: ${API_URL})"

# ── Build catalog & sync prices to D1 ───────────────────────
# npm run build runs the full pipeline:
#   1. sync-stock  — pull live stock from D1 into source files
#   2. build-products — compile source → data/products/
#   3. sync-prices — push prices from data/products/ to D1   ← critical for checkout
#   4. build-index — generate index.json + batches
#   5. build-configs — validate & stamp configs
#
# CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and D1_DATABASE_ID must
# be exported before this runs or sync-stock and sync-prices silently
# skip (they log a warning and return early), leaving the D1 prices table
# empty and breaking checkout with "Invalid product or variant" errors.
# All three are exported above — verified here as a safety net.
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ] || [ -z "${D1_DATABASE_ID:-}" ]; then
  error "Missing required env vars before build. This is a bug in setup.sh — please report it."
fi

info "Building catalog and syncing prices to D1..."
npm run build
success "Catalog built and prices synced to D1"

# ── Verify prices were actually written ─────────────────────
# If sync-prices silently skipped (e.g. data/products/ was empty because
# build-products failed), checkout will 500 on every request. Catch it here
# while the user is still watching, not after they deploy and wonder why
# nothing works.
info "Verifying D1 prices table..."
PRICE_COUNT=$(npx wrangler d1 execute lean-store-db --remote \
  --command="SELECT COUNT(*) as c FROM prices" --json 2>/dev/null \
  | python3 -c "
import sys, json
try:
  data = json.load(sys.stdin)
  # wrangler --json wraps results in an array
  results = data[0].get('results', []) if isinstance(data, list) else data.get('results', [])
  print(results[0].get('c', 0) if results else 0)
except Exception:
  print(0)
" 2>/dev/null || echo "0")

if [ "$PRICE_COUNT" -eq 0 ] 2>/dev/null; then
  echo ""
  error "Prices table is empty after build. sync-prices did not run or data/products/ is empty.
  Run manually:
    npm run build:products
    npm run sync:prices
  Then redeploy:
    npx wrangler pages deploy data --project-name=\"${PAGES_PROJECT}\" --commit-dirty=true"
fi
success "Prices table OK (${PRICE_COUNT} rows)"

# ── Deploy Pages ─────────────────────────────────────────────
info "Deploying to Cloudflare Pages..."
npx wrangler pages deploy data --project-name="$PAGES_PROJECT" --commit-dirty=true 2>/dev/null
success "Catalog deployed to Pages"

# ── Print summary ────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║              Setup Complete!                             ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo -e "${GREEN}Your store:${NC} ${STORE_URL}"
echo -e "${GREEN}Your API:${NC}   ${API_URL}"
if [ -n "$R2_BUCKET_NAME" ] && [ -n "$R2_PUBLIC_URL" ]; then
echo -e "${GREEN}R2 bucket:${NC} ${R2_BUCKET_NAME} → ${R2_PUBLIC_URL}"
elif [ -n "$R2_BUCKET_NAME" ]; then
echo -e "${YELLOW}R2 bucket:${NC} ${R2_BUCKET_NAME} (public URL not set yet)"
echo -e "  → Enable public access in the Cloudflare dashboard, then run:"
echo -e "    ${BLUE}npx wrangler vars put CDN_BASE_URL https://pub-xxxx.r2.dev${NC}"
echo -e "    ${BLUE}npm run deploy:api${NC}"
else
echo -e "${YELLOW}R2 bucket:${NC} not configured — uploads disabled"
echo -e "  → To add R2 later, see the R2 section in SETUP.md"
fi
echo ""
echo -e "${YELLOW}Add these secrets to GitHub (repo → Settings → Secrets → Actions):${NC}"
echo ""
echo "  CLOUDFLARE_API_TOKEN  = $CF_API_TOKEN"
echo "  CLOUDFLARE_ACCOUNT_ID = $CF_ACCOUNT_ID"
echo "  D1_DATABASE_ID        = $D1_ID"
echo "  PAGES_PROJECT_NAME    = $PAGES_PROJECT"
echo ""
echo -e "${YELLOW}Save your admin key:${NC} $ADMIN_KEY"
echo ""
