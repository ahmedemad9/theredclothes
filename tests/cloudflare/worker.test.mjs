/**
 * cloudflare/worker.js routing: /api/* to the handlers, everything else to static assets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../../cloudflare/worker.js';
import { createBackend, googleFetch, EXEC_URL, SECRET } from './google-sim.mjs';

const SITE = 'https://theredclothes.example.workers.dev';
console.error = () => {};

function env() {
  const assetCalls = [];
  return {
    assetCalls,
    APPS_SCRIPT_URL: EXEC_URL,
    WEBHOOK_SECRET: SECRET,
    ASSETS: { fetch: async (request) => { assetCalls.push(new URL(request.url).pathname); return new Response('asset'); } }
  };
}
const ctx = { waitUntil() {} };

test('worker: pages and files are served from static assets', async () => {
  const e = env();
  for (const p of ['/', '/index.html', '/styles.css', '/assets/background-desktop.gif', '/favicon.png']) {
    const res = await worker.fetch(new Request(SITE + p), e, ctx);
    assert.equal(await res.text(), 'asset', p);
  }
  assert.deepEqual(e.assetCalls, ['/', '/index.html', '/styles.css', '/assets/background-desktop.gif', '/favicon.png']);
});

test('worker: /api routes reach the handlers, never the assets', async () => {
  globalThis.fetch = googleFetch(createBackend([['Product ID', 'Name', 'Description', 'Price', 'Category', 'Color', 'Image Link', 'S', 'M', 'L', 'XL', 'XXL'],
    ['P001', 'Tee', 'Soft tee', 100, 'Tshirts', 'Black', 'https://img.example/a.jpg', 1, 1, 1, 1, 1]]));
  const e = env();
  const products = await worker.fetch(new Request(SITE + '/api/products'), e, ctx);
  assert.equal(products.status, 200);
  assert.equal((await products.json()).products[0].id, 'P001');
  const config = await worker.fetch(new Request(SITE + '/api/config'), e, ctx);
  assert.match(await config.text(), /^window\.STORE_CONFIG = /);
  const order = await worker.fetch(new Request(SITE + '/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: SITE },
    body: JSON.stringify({ customer: { name: 'Jane Doe', phone: '+20 10 1234 5678', email: 'jane@example.com', address: '12 Tahrir Street\nCairo 11511' },
      items: [{ productId: 'P001', color: 'Black', size: 'M', quantity: 1, unitPrice: 100 }], idempotencyKey: 'workertest0123456789' }) }), e, ctx);
  const saved = await order.json();
  assert.equal(saved.success, true);
  assert.match(saved.orderId, /^\d{5}$/);
  assert.deepEqual(e.assetCalls, []);
});

test('worker: unknown /api paths are 404 and wrong methods 405', async () => {
  const e = env();
  assert.equal((await worker.fetch(new Request(SITE + '/api/secret'), e, ctx)).status, 404);
  assert.equal((await worker.fetch(new Request(SITE + '/api/'), e, ctx)).status, 404);
  const get = await worker.fetch(new Request(SITE + '/api/orders'), e, ctx);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('Allow'), 'POST');
  assert.equal((await worker.fetch(new Request(SITE + '/api/products', { method: 'POST', body: '{}' }), e, ctx)).status, 405);
  assert.equal((await worker.fetch(new Request(SITE + '/api/products', { method: 'DELETE' }), e, ctx)).status, 405);
  assert.deepEqual(e.assetCalls, []);
});
