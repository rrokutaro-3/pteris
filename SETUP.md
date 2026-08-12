# Lean Store — Complete Setup & Operations Guide

This guide is based on actually going through the setup. Every gotcha, error, and workaround is documented here so you don't repeat them.

**What you're running:**
- **Cloudflare Pages** — hosts the storefront (static files)
- **Cloudflare Workers** — handles checkout, stock, payments (serverless API)
- **Cloudflare D1** — SQLite database for orders, inventory, prices
- **Stripe** — payment processing
- **Resend** — order confirmation emails

---

## Before You Start — Collect Everything First

Do all of this in your browser before opening Codespace. Going back and forth between browser and terminal is what makes setup painful.

### 1. GitHub account
Go to **github.com** and sign up or log in.

Upload the repo contents:
1. Click **+** → **New repository**
2. Name it anything (e.g. `my-store`), set to **Private**, click **Create repository**
3. Click **Add file → Upload files**
4. Extract the zip, open the inner folder, drag ALL contents into the upload box. You should see `src/`, `data/`, `spa/`, `scripts/`, `package.json`, `wrangler.toml`, `.github/` at the top level — not a nested folder
5. Click **Commit changes**

---

### 2. Cloudflare account + API token

Go to **cloudflare.com** → sign up (free).

#### Get your Account ID
Dashboard → left sidebar → **Compute (Workers)** → **Overview** → your Account ID is in the right sidebar. Copy it.

#### Create an API token
**Avatar (top right) → My Profile → API Tokens → Create Token → Create Custom Token**

Add these permissions:

| Category | Permission | Level | Required? |
|---|---|---|---|
| Developer Platform | Workers Scripts | Edit | Always |
| Developer Platform | Workers D1 | Edit | Always |
| Developer Platform | Pages | Edit | Always |
| Developer Platform | Workers R2 Storage | Edit | Only if using R2 for media uploads |
| Account & Billing | Account Settings | Read | Always |

Set **Account Resources** to your account. Click **Continue to summary → Create Token**.

**Copy the token immediately** — you only see it once.

> **Critical:** The token needs D1 Edit specifically. If you use the "Edit Cloudflare Workers" template it won't include D1 and everything will fail with auth errors.

> **R2 note:** `Workers R2 Storage: Edit` is only needed if you're using R2 for product media uploads (the admin panel's Media tab). If you skip R2 during setup, you can leave this permission out. You can always create a new token with it added later if you decide to enable R2. At runtime, the deployed Worker accesses R2 via its binding — your API token is never used by the live store, only during setup and deploys.

---

### 3. Stripe

Go to **stripe.com** → sign up.

Stay in **test mode** (toggle in the top left — make sure it says "Sandbox" or "Test").

Go to **Developers → API Keys** → copy the **Secret key** (starts with `sk_test_...`).

You'll set up the webhook after deploying — you need your Worker URL first.

---

### 4. Resend

Go to **resend.com** → sign up (free tier covers small volumes).

Go to **API Keys → Create API Key** → any name → copy the key.

**Domain verification (for sending from your own domain):**
1. **Domains → Add Domain** → enter your domain
2. They'll show you DNS records to add — go to wherever you bought your domain (GoDaddy, Namecheap, Cloudflare itself, etc.) and add them
3. Wait for verification (usually a few minutes)
4. Make sure `RESEND_FROM_EMAIL` in `wrangler.toml` matches an address on the verified domain

**No domain yet?** Resend has a shared test address you can use while getting everything else working. Look for their onboarding test mode.

---

### 5. Admin key

Make up any long random password (30+ characters). This protects your store's admin API endpoints (viewing orders, adjusting stock). Save it somewhere safe — a password manager, a note, anywhere.

---

## Setup — The One Command

Once you have everything above, open Codespace:

**GitHub repo → green Code button → Codespaces → Create codespace on main**

Then run:

```bash
export CLOUDFLARE_API_TOKEN="your-token-here"
export CLOUDFLARE_ACCOUNT_ID="your-account-id-here"
bash setup.sh
```

The script will prompt for everything else and handle:
- Installing dependencies
- Creating the D1 database
- Patching `wrangler.toml` with your real values
- Running the database migration (remotely, not locally)
- Seeding inventory from your product files
- Setting all Cloudflare Worker secrets
- Deploying the Worker
- Creating the Pages project
- Building and deploying the catalog + storefront
- Printing your GitHub secrets at the end

The whole thing takes about 3–5 minutes.

> **If Codespace disconnects mid-way:** Open a new one, re-export the two env vars at the top, and re-run `bash setup.sh`. Everything uses upserts so it's safe to run again.

---

## After Setup — R2 Media Uploads (optional)

R2 powers the **Media** tab in the admin panel — you can upload, resize, and get a CDN URL for product images without leaving the browser.

**You already created the bucket** (good). Now there are two small things to finish:

### 1. Enable public access on the bucket

The bucket needs a public URL so images are actually reachable from the web.

Cloudflare dashboard → **R2** → click your bucket → **Settings** tab → **Public Access** → click **Allow Access**.

A URL will appear — it looks like `https://pub-abcdef1234567890.r2.dev`. Copy it.

### 2. Tell your Worker the public URL

Run this from your Codespace (no file editing required):

```bash
sed -i 's|CDN_BASE_URL = ".*"|CDN_BASE_URL = "https://pub-xxxx.r2.dev"|' wrangler.toml
npm run deploy:api
```

Replace `https://pub-xxxx.r2.dev` with the URL you copied. That's it — uploads in the admin panel will now return usable public URLs.

> **Note:** `CDN_BASE_URL` lives in `wrangler.toml` under `[vars]`. Always update it there and redeploy — `wrangler vars put` no longer exists in modern wrangler versions.

### Using a custom domain instead of r2.dev

If you'd rather serve images from `cdn.yourdomain.com` instead of the r2.dev subdomain:

1. R2 dashboard → your bucket → **Settings → Custom Domains → Connect Domain**
2. Enter your subdomain (e.g. `cdn.yourdomain.com`)
3. Cloudflare adds the DNS record automatically (domain must be on Cloudflare)
4. Once active, update `wrangler.toml` and redeploy:
   ```bash
   sed -i 's|CDN_BASE_URL = ".*"|CDN_BASE_URL = "https://cdn.yourdomain.com"|' wrangler.toml
   npm run deploy:api
   ```

### If you skipped R2 during setup

You can add it at any time:

```bash
export CLOUDFLARE_API_TOKEN="your-token"
export CLOUDFLARE_ACCOUNT_ID="your-account-id"

# 1. Create the bucket
npx wrangler r2 bucket create your-bucket-name

# 2. Add the binding to wrangler.toml — edit this section:
#    [[r2_buckets]]
#    binding = "ASSETS_BUCKET"
#    bucket_name = "your-bucket-name"   ← put your actual name here

# 3. Enable public access in the dashboard (see above), then:
sed -i 's|CDN_BASE_URL = ".*"|CDN_BASE_URL = "https://pub-xxxx.r2.dev"|' wrangler.toml
npm run deploy:api
```

---

## After Setup — Stripe Webhook

This has to happen after deploying because you need the Worker URL.

Your Worker URL is printed at the end of `setup.sh`. It looks like:
```
https://lean-store-api.yourname.workers.dev
```

1. Stripe dashboard → **Developers → Webhooks → Add endpoint** (or "Add destination" in newer UI)
2. Select **Your account** (not Connected accounts)
3. **Endpoint URL:**
   ```
   https://lean-store-api.yourname.workers.dev/api/webhook/stripe
   ```
4. **Events** — select both:
   - `checkout.session.completed`
   - `checkout.session.expired`
5. Click **Create destination / Add endpoint**
6. On the webhook page, click **Reveal** next to Signing secret → copy it (starts with `whsec_...`)

Then in Codespace:
```bash
export CLOUDFLARE_API_TOKEN="your-token"
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```
Paste the `whsec_...` key when prompted.

> **Without the webhook secret set, orders will stay in "pending" forever.** The webhook is what flips them to "paid" after a customer pays.

---

## GitHub Actions Secrets

Go to your repo → **Settings → Secrets and variables → Actions → New repository secret**

Add these (the setup script prints exact values at the end):

| Secret name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Your Cloudflare API token |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare Account ID |
| `D1_DATABASE_ID` | Printed by setup.sh |
| `PAGES_PROJECT_NAME` | Whatever you named the Pages project (e.g. `my-store`) |
| `CLOUDFLARE_ZONE_ID` | Optional — only if you have a custom domain on Cloudflare. Skip if not. |

Once these are set, every push to `data/source/` or `data/config/` automatically rebuilds and redeploys your store.

---

## Trigger the First Deploy

GitHub repo → **Actions** tab → **Build & Deploy Catalog** → **Run workflow** → **Run workflow**

Wait ~2 minutes. Your store is live at `https://your-project-name.pages.dev`.

---

## Test Before Going Live

Run through this before telling anyone your store is open:

**1. Turn off the sample sale**

Open `data/config/sale.json` on GitHub. The file ships with `"active": false` in the updated version. Confirm it's off or you'll accidentally discount things.

**2. Check the store loads**

Visit your Pages URL. Products should appear. If you see "Loading products..." forever, check the browser console for errors.

**3. Test checkout with a fake card**

Add something to cart, go through checkout, use Stripe's test card:
- Card number: `4242 4242 4242 4242`
- Expiry: any future date
- CVC: any 3 digits

This charges nothing in test mode.

**4. Verify the order was recorded**

In Codespace:
```bash
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."
npx wrangler d1 execute lean-store-db --remote --command="SELECT id, status, total FROM orders ORDER BY created_at DESC LIMIT 5"
```

The last order should show `status: "paid"` and have a `stripe_payment_intent_id`.

**5. Confirm webhook is working**

In the Stripe dashboard → Developers → Webhooks → click your endpoint → look at recent deliveries. They should show green 200 responses.

**6. Go live**

Stripe dashboard → **Activate your account** → complete identity verification and add your bank details for payouts.

---

## Adding Products

Products live in `data/source/products/` as individual JSON files. The filename doesn't matter — the `id` field inside does.

### File structure (minimum required fields)

```json
{
  "id": "p-1234",
  "type": "physical",
  "identity": {
    "name": "Product Name",
    "slug": "product-name",
    "sku": "SKU-1234",
    "status": "active"
  },
  "pricing": {
    "currency": "USD",
    "price": 49.00,
    "compareAtPrice": 69.00
  },
  "description": {
    "short": "One sentence description.",
    "full": "<p>Full HTML description.</p>"
  },
  "categories": ["category-name"],
  "variants": [
    {
      "id": "v-1234-s",
      "sku": "SKU-1234-S",
      "options": { "Size": "S" },
      "price": 49.00,
      "stock": 10,
      "weight": 0.3,
      "backorder": false
    }
  ],
  "media": {
    "images": [
      { "url": "https://your-cdn.com/image.jpg", "alt": "Product image", "order": 1 }
    ]
  },
  "shipping": {
    "profile": "standard",
    "weight": 0.3,
    "requiresShipping": true
  },
  "seo": {
    "title": "Product Name | Store",
    "description": "SEO description."
  },
  "meta": {
    "createdAt": "2026-01-01T00:00:00Z",
    "updatedAt": "2026-01-01T00:00:00Z"
  }
}
```

### Status values
- `"active"` — live on the store, purchasable
- `"draft"` — not shown anywhere, not purchasable
- `"archived"` — removed from store, kept for records

### Adding products via your pipeline

Your pipeline drops JSON files into `data/source/products/`, then:

1. Push to GitHub → the workflow automatically rebuilds and redeploys
2. Run `node scripts/seed-inventory.js` to seed stock for any new products into D1 (this is what makes checkout actually work — without it everything shows "out of stock")

Or add seed-inventory to your pipeline:
```bash
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."
export D1_DATABASE_ID="..."
node scripts/seed-inventory.js
```

### Product images

The product JSON just stores image URLs — the actual image files need to live somewhere.

**Cloudflare R2 (recommended — same CDN, 10 GB free)**  
Set up via the admin panel's **Media** tab once R2 is configured (see the R2 section above). You can upload, auto-resize, and copy the URL directly from the browser. No CLI needed after initial setup.

**Any public CDN** also works — Cloudinary, Bunny.net, Imgur, etc. Just paste the URL into `media.images[].url` and `variants[].image` in the product JSON.

---

## Shipping Configuration

Edit `data/config/shipping.json` to match where you actually ship.

The default only covers US, CA, GB, DE, FR, AU. Orders from any other country get a "Shipping not available" error.

```json
{
  "profiles": [
    {
      "id": "standard",
      "name": "Standard Shipping",
      "rates": [
        {
          "name": "Standard",
          "minWeight": 0,
          "maxWeight": 5.0,
          "price": 9.99,
          "countries": ["US", "CA", "ZA", "NG", "KE"]
        }
      ],
      "freeThreshold": 100.00
    }
  ],
  "defaultProfile": "standard"
}
```

Country codes are 2-letter ISO codes (US, GB, ZA, etc.). Weight is in kg.

---

## Tax Configuration

Edit `data/config/tax.json`. Default is 0% for most countries.

```json
{
  "defaultRate": 0.00,
  "includedInPrice": false,
  "rules": [
    { "country": "ZA", "rate": 0.15, "included": false, "name": "South Africa VAT" },
    { "country": "GB", "rate": 0.20, "included": true, "name": "UK VAT" }
  ]
}
```

`"included": true` means the price already includes tax (common in EU/UK). `"included": false` means tax is added on top at checkout.

---

## Running a Sale

Edit `data/config/sale.json` on GitHub:

```json
{
  "active": true,
  "saleName": "Summer Sale",
  "startDate": "2026-09-01T00:00:00Z",
  "endDate": "2026-09-07T00:00:00Z",
  "rules": [
    { "productId": "p-1234", "discountType": "percentage", "discountValue": 20 },
    { "productId": "p-5678", "discountType": "fixed", "discountValue": 10 }
  ],
  "badgeText": "SALE",
  "badgeColor": "#e00",
  "badgeTextColor": "#fff"
}
```

Commit the change → store rebuilds within minutes → sale goes live. Set `"active": false` to end it.

---

## Viewing Orders

There's no built-in order dashboard yet. Query D1 directly:

```bash
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."

# Save output to a readable file
npx wrangler d1 execute lean-store-db --remote \
  --command="SELECT id, status, total, created_at FROM orders ORDER BY created_at DESC LIMIT 20" \
  > orders.txt 2>&1
```

Or hit the admin API directly:
```
GET https://lean-store-api.yourname.workers.dev/api/admin/inventory
Authorization: Bearer your-admin-key
```

---

## If Something Breaks

**Store shows blank / 404:**
Check that the GitHub Actions workflow ran successfully. Go to repo → Actions tab → look for red failures.

**Checkout says "out of stock" when it shouldn't:**
Stock isn't seeded in D1. Run:
```bash
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."
export D1_DATABASE_ID="..."
node scripts/seed-inventory.js
```

**Checkout says "Payment provider error":**
Check Stripe dashboard → Developers → Workbench → Errors. Common causes:
- Wrong Stripe secret key (re-run `npx wrangler secret put STRIPE_SECRET_KEY`)
- Cart payload missing `name` field (check index.html sends name + image in cartPayload)

**Orders stuck in "pending" after payment:**
Webhook isn't set up or the secret is wrong. Check Stripe → Developers → Webhooks → your endpoint → recent deliveries. If you see failures, re-run `npx wrangler secret put STRIPE_WEBHOOK_SECRET` with the correct `whsec_...` value.

**"D1 credentials not set, skipping stock sync" in build:**
The GitHub Actions secrets are missing `D1_DATABASE_ID`. Add it under repo → Settings → Secrets → Actions.

**Worker health check:**
```
https://lean-store-api.yourname.workers.dev/api/health
```
Should return `{"status":"ok", ...}`. If it 404s or errors, redeploy the Worker:
```bash
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."
npm run deploy:api
```

---

## Switching to Live Payments

When you're ready to accept real money:

1. Stripe dashboard → **Activate your account** → complete identity + bank details
2. Switch the Stripe dashboard toggle from **Sandbox** to **Live**
3. Go to **Developers → API Keys** → copy the **Live** secret key (starts with `sk_live_...`)
4. In Codespace:
   ```bash
   export CLOUDFLARE_API_TOKEN="..."
   export CLOUDFLARE_ACCOUNT_ID="..."
   npx wrangler secret put STRIPE_SECRET_KEY
   ```
   Paste the live key.
5. Set up a **new webhook** in Stripe under the Live section (separate from the test webhook) pointing to the same URL, and update `STRIPE_WEBHOOK_SECRET` with the new `whsec_...`.

---

## Day-to-Day Operations

| Task | How |
|---|---|
| Add/edit products | Edit files in `data/source/products/` on GitHub, commit → auto-rebuilds |
| Add new product stock to D1 | Run `node scripts/seed-inventory.js` |
| Run a sale | Edit `data/config/sale.json` on GitHub |
| Change shipping rates | Edit `data/config/shipping.json` on GitHub |
| Change tax rates | Edit `data/config/tax.json` on GitHub |
| View orders | Query D1 or hit admin API |
| Update Stripe keys | `npx wrangler secret put STRIPE_SECRET_KEY` |
| Force a rebuild | GitHub → Actions → Build & Deploy Catalog → Run workflow |
