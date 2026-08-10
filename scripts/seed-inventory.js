#!/usr/bin/env node
/**
 * seed-inventory.js
 * Seeds D1 inventory from data/source/products/*.json
 * Run after first migration or when adding new products manually.
 * 
 * Usage: node scripts/seed-inventory.js
 * 
 * Env required:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN
 *   D1_DATABASE_ID
 */

import fs from 'fs/promises';
import path from 'path';

const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN  = process.env.CLOUDFLARE_API_TOKEN;
const D1_DB_ID      = process.env.D1_DATABASE_ID;

if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !D1_DB_ID) {
  console.error('Missing env vars: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_ID');
  process.exit(1);
}

async function d1Query(sql, params = []) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DB_ID}/query`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ sql, params })
    }
  );
  const data = await res.json();
  if (!data.success) throw new Error(`D1 query failed: ${JSON.stringify(data.errors)}`);
  return data.result?.[0]?.results || [];
}

const SOURCE_DIR = './data/source/products';

async function main() {
  const files = (await fs.readdir(SOURCE_DIR)).filter(f => f.endsWith('.json'));
  let seeded = 0;
  let skipped = 0;

  for (const file of files) {
    const product = JSON.parse(await fs.readFile(path.join(SOURCE_DIR, file), 'utf-8'));
    
    // Skip draft/archived
    if (['draft', 'archived'].includes(product.identity?.status)) {
      skipped++;
      continue;
    }

    if (!product.variants?.length) {
      skipped++;
      continue;
    }

    const variants = {};
    for (const v of product.variants) {
      variants[v.id] = {
        qty: v.stock ?? 0,
        reserved: 0,
        backorder: v.backorder ?? false
      };
    }

    await d1Query(
      `INSERT INTO inventory (product_id, variants, last_updated)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(product_id) DO UPDATE SET
         variants = excluded.variants,
         last_updated = excluded.last_updated`,
      [product.id, JSON.stringify(variants)]
    );

    console.log(`  ✓ ${product.id} — ${product.identity?.name} (${product.variants.length} variants)`);
    seeded++;
  }

  console.log(`\nDone. Seeded: ${seeded}, Skipped: ${skipped}`);
}

main().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
