import fs from 'fs/promises';

const CONFIG_SOURCE = './data/config';
const CONFIG_OUTPUT = './data/config';

export async function buildConfigs(timestamp) {
  // coupons.json is required for checkout's coupon feature to function
  // at all (see validateCoupon() in checkout.js) — it wasn't in this
  // list before, so a missing coupons.json would only surface as a
  // silent "coupon not found" at checkout time instead of failing the
  // build clearly.
  const required = ['store.json', 'menus.json', 'shipping.json', 'tax.json', 'coupons.json'];

  for (const file of required) {
    try {
      await fs.access(`${CONFIG_SOURCE}/${file}`);
    } catch {
      throw new Error(`Missing required config: ${file}`);
    }
  }

  const configsToStamp = ['store.json', 'menus.json'];
  for (const file of configsToStamp) {
    const raw = await fs.readFile(`${CONFIG_SOURCE}/${file}`, 'utf-8');
    const config = JSON.parse(raw);
    config._version = timestamp;
    config._updatedAt = new Date().toISOString();
    await fs.writeFile(`${CONFIG_OUTPUT}/${file}`, JSON.stringify(config, null, 2));
  }

  console.log(`   Validated ${required.length} required configs`);
}

if (process.argv[1].endsWith('build-configs.js')) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  buildConfigs(timestamp);
}
