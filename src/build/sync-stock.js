import fs from 'fs/promises';
import path from 'path';

/**
 * Pulls live stock from D1 and updates source product files.
 * Uses D1 REST API since this runs in GitHub Actions (not a Worker).
 */

const SOURCE_DIR = './data/source/products';
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const D1_DB_ID = process.env.D1_DATABASE_ID;

async function d1Query(sql, params = []) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DB_ID}/query`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params })
    }
  );

  const data = await res.json();
  if (!data.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(data.errors)}`);
  }
  return data.result?.[0]?.results || [];
}

export async function syncStock() {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !D1_DB_ID) {
    console.log('   ⚠️ D1 credentials not set, skipping stock sync');
    return;
  }

  const files = await fs.readdir(SOURCE_DIR);
  const jsonFiles = files.filter(f => f.endsWith('.json'));

  let updated = 0;

  for (const file of jsonFiles) {
    const filePath = path.join(SOURCE_DIR, file);
    const raw = await fs.readFile(filePath, 'utf-8');
    const product = JSON.parse(raw);

    const rows = await d1Query(
      'SELECT variants FROM inventory WHERE product_id = ?',
      [product.id]
    );

    if (rows.length > 0) {
      const stockDoc = JSON.parse(rows[0].variants);
      let changed = false;

      for (const variant of product.variants || []) {
        const liveStock = stockDoc[variant.id];
        if (liveStock && liveStock.qty !== undefined && liveStock.qty !== variant.stock) {
          variant.stock = liveStock.qty;
          changed = true;
        }
      }

      if (changed) {
        product.meta = product.meta || {};
        product.meta.stockSyncedAt = new Date().toISOString();
        await fs.writeFile(filePath, JSON.stringify(product, null, 2));
        updated++;
      }
    }
  }

  console.log(`   Synced stock for ${updated} products from D1`);
}

if (process.argv[1].endsWith('sync-stock.js')) {
  syncStock().catch(err => {
    console.error('Stock sync failed:', err);
    process.exit(1);
  });
}
