/**
 * Pteris store runtime config
 * Loaded before the SPA module script so window.__STORE_URL__ / __API_URL__ exist at boot.
 *
 * STORE_URL  — Cloudflare Pages origin (static products, configs, index)
 * API_URL    — Cloudflare Worker origin (checkout, stock, webhooks)
 */
window.__STORE_URL__ = 'https://pteris-store.pages.dev';
window.__API_URL__   = 'https://lean-store-api.rrokutaro.workers.dev';
