import { buildProducts } from './build-products.js';
import { buildIndex } from './build-index.js';
import { buildConfigs } from './build-configs.js';
import { syncStock } from './sync-stock.js';
import { syncPrices } from './sync-prices.js';

/**
 * Master build orchestrator.
 * Run this in GitHub Actions to regenerate the entire static catalog.
 */

async function buildAll() {
  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n🚀 Build started at ${new Date().toISOString()}`);
  console.log(`Version stamp: ${timestamp}\n`);

  try {
    // Step 1: Sync stock from D1 into source products
    console.log('📦 Step 1/5: Syncing stock from D1...');
    await syncStock();
    console.log('   ✅ Stock synced\n');

    // Step 2: Generate individual product JSON files (applies sale pricing)
    //
    // NOTE: this MUST run before syncPrices(). A previous version of this
    // pipeline synced prices to D1 (step 2) before building products
    // (step 3), but syncPrices() reads from ./data/products — the OUTPUT
    // of buildProducts(). Running it first meant D1 always got the
    // *previous* build's prices (or nothing, on a first run), so
    // server-side checkout price verification was always one cycle stale.
    console.log('📦 Step 2/5: Building product files...');
    await buildProducts(timestamp);
    console.log('   ✅ Products built\n');

    // Step 3: Sync prices to D1 (for server-side checkout validation)
    // Runs AFTER buildProducts so sale prices reflect this build's output.
    console.log('📦 Step 3/5: Syncing prices to D1...');
    await syncPrices();
    console.log('   ✅ Prices synced\n');

    // Step 4: Generate index.json + batches
    console.log('📦 Step 4/5: Building index...');
    await buildIndex(timestamp);
    console.log('   ✅ Index built\n');

    // Step 5: Validate configs
    console.log('📦 Step 5/5: Building configs...');
    await buildConfigs(timestamp);
    console.log('   ✅ Configs built\n');

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✨ Build complete in ${duration}s`);
    console.log(`Version: ${timestamp}`);

    const fs = await import('fs');
    fs.writeFileSync('./data/.version', timestamp);

  } catch (err) {
    console.error('❌ Build failed:', err.message);
    process.exit(1);
  }
}

buildAll();
