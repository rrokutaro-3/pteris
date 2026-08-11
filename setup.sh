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

# If they gave a bucket name, ask for the public URL.
# Cloudflare's r2.dev public URL is only visible in the dashboard after enabling
# public access — we cannot derive it from the account ID alone. Users paste it here.
# It can also be set later by re-running: npx wrangler vars put CDN_BASE_URL https://...
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

# Export for wrangler
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
  # Use --json for reliable parsing — plain text table output is not safe to awk
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
# Note: R2 bucket bindings cannot be set via env vars or secrets — the bucket_name
# in [[r2_buckets]] must be hardcoded in wrangler.toml. This is a Cloudflare requirement.
# CDN_BASE_URL (the public URL for serving assets) is a regular [vars] entry and CAN
# be updated at any time without redeploying by running:
#   npx wrangler vars put CDN_BASE_URL https://your-r2-url
info "Updating wrangler.toml..."
STORE_URL="https://${PAGES_PROJECT}.pages.dev"

sed -i \
  -e "s|database_id = \"your-d1-database-id\"|database_id = \"${D1_ID}\"|" \
  -e "s|STORE_URL = \".*\"|STORE_URL = \"${STORE_URL}\"|" \
  -e "s|RESEND_FROM_EMAIL = \".*\"|RESEND_FROM_EMAIL = \"${RESEND_EMAIL}\"|" \
  wrangler.toml

if [ -n "$R2_BUCKET_NAME" ]; then
  # Patch the bucket name into [[r2_buckets]] — this is unavoidable, it's a binding not a var
  sed -i -e "s|bucket_name = \"your-store-assets\"|bucket_name = \"${R2_BUCKET_NAME}\"|" wrangler.toml

  if [ -n "$R2_PUBLIC_URL" ]; then
    # User provided the public URL — wire it up now
    R2_PUBLIC_URL="${R2_PUBLIC_URL%/}"   # strip trailing slash
    sed -i -e "s|CDN_BASE_URL = \".*\"|CDN_BASE_URL = \"${R2_PUBLIC_URL}\"|" wrangler.toml
    success "wrangler.toml updated (R2 bucket: ${R2_BUCKET_NAME}, CDN: ${R2_PUBLIC_URL})"
  else
    # No public URL yet — leave CDN_BASE_URL pointing to Pages for now
    # and remind the user to set it once they enable public access in the dashboard
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

# ── Resolve real Worker URL (immediately after deploy) ───────
info "Resolving Worker URL..."
WORKER_HOST=""

# 1) deployments list (best right after deploy)
WORKER_HOST=$(npx wrangler deployments list --name lean-store-api 2>/dev/null \
  | grep -oE 'lean-store-api\.[a-z0-9-]+\.workers\.dev' | head -1 || true)

# 2) whoami account subdomain
if [ -z "$WORKER_HOST" ]; then
  ACCOUNT_SUB=$(npx wrangler whoami 2>/dev/null \
    | grep -oE '[a-z0-9-]+\.workers\.dev' | head -1 || true)
  if [ -n "$ACCOUNT_SUB" ]; then
    WORKER_HOST="lean-store-api.${ACCOUNT_SUB}"
  fi
fi

# 3) workers.dev routes / list
if [ -z "$WORKER_HOST" ]; then
  WORKER_HOST=$(npx wrangler list 2>/dev/null \
    | grep -oE 'lean-store-api\.[a-z0-9-]+\.workers\.dev' | head -1 || true)
fi

# 4) never write a placeholder — ask once
if [ -z "$WORKER_HOST" ]; then
  warn "Could not auto-detect Worker hostname."
  prompt WORKER_HOST "Worker hostname (e.g. lean-store-api.youraccount.workers.dev)"
fi

WORKER_HOST=$(echo "\( WORKER_HOST" | sed -e 's|^https\?://||' -e 's|/.* \)||')
API_URL="https://${WORKER_HOST}/api"
success "API URL: ${API_URL}"

# ── Generate store-config.js BEFORE any Pages deploy ─────────
info "Generating store-config.js..."
mkdir -p data
cat > data/store-config.js << CONFIGEOF
// Auto-generated by setup.sh — do not edit manually.
window.__STORE_URL__ = '${STORE_URL}';
window.__API_URL__   = '${API_URL}';
CONFIGEOF
success "store-config.js → data/store-config.js"

# ── Create Pages project ─────────────────────────────────────
info "Creating Pages project (${PAGES_PROJECT})..."
echo "main" | npx wrangler pages project create "$PAGES_PROJECT" 2>/dev/null \
  || warn "Pages project may already exist"
success "Pages project ready"

# ── Build (prices → D1) with env forced ──────────────────────
# setup.sh already exported these earlier; re-export so npm run build
# children always see them even if the shell was weird.
export CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID
export D1_DATABASE_ID="$D1_ID"

info "Building catalog + syncing prices to D1..."
npm run build

# Hard fail if prices table is still empty (permanent guard)
PRICE_COUNT=$(npx wrangler d1 execute lean-store-db --remote --json \
  --command="SELECT COUNT(*) AS c FROM prices" 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['results'][0]['c'] if d else 0)" 2>/dev/null || echo "0")

if [ "${PRICE_COUNT:-0}" = "0" ]; then
  error "prices table is empty after build. Checkout will fail. Check CLOUDFLARE_* env and data/source/products."
fi
success "Prices in D1: ${PRICE_COUNT} rows"

# ── Deploy Pages (includes store-config.js + built catalog) ──
info "Deploying catalog to Pages..."
npx wrangler pages deploy data --project-name="$PAGES_PROJECT" --commit-dirty=true
success "Catalog deployed → ${STORE_URL}"

# ── Summary (real URLs only) ─────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║              Setup Complete!                             ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo -e "\( {GREEN}Your store: \){NC} ${STORE_URL}"
echo -e "\( {GREEN}Your API: \){NC}   ${API_URL}"
if [ -n "\( {R2_BUCKET_NAME:-}" ] && [ -n " \){R2_PUBLIC_URL:-}" ]; then
  echo -e "\( {GREEN}R2 bucket: \){NC} ${R2_BUCKET_NAME} → ${R2_PUBLIC_URL}"
elif [ -n "${R2_BUCKET_NAME:-}" ]; then
  echo -e "\( {YELLOW}R2 bucket: \){NC} ${R2_BUCKET_NAME} (public URL not set yet)"
  echo -e "  → Enable public access, then:"
  echo -e "    \( {BLUE}npx wrangler vars put CDN_BASE_URL https://pub-xxxx.r2.dev \){NC}"
  echo -e "    \( {BLUE}npm run deploy:api \){NC}"
else
  echo -e "\( {YELLOW}R2 bucket: \){NC} not configured — uploads disabled"
fi
echo ""
echo -e "\( {YELLOW}Add these secrets to GitHub (repo → Settings → Secrets → Actions): \){NC}"
echo ""
echo "  CLOUDFLARE_API_TOKEN  = $CF_API_TOKEN"
echo "  CLOUDFLARE_ACCOUNT_ID = $CF_ACCOUNT_ID"
echo "  D1_DATABASE_ID        = $D1_ID"
echo "  PAGES_PROJECT_NAME    = $PAGES_PROJECT"
echo ""
echo -e "\( {YELLOW}Save your admin key: \){NC} $ADMIN_KEY"
echo "" 
