/**
 * cloudflare/web/api.js — the browser StoreApi for the Cloudflare site, with a fake fetch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(new URL('../../cloudflare/web/api.js', import.meta.url), 'utf8');

function load(fetchImpl) {
  const calls = [];
  const context = vm.createContext({
    fetch: (url, opts) => { calls.push({ url, opts }); return fetchImpl(url, opts, calls.length); },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 30)),   // retries and timeouts sped up
    clearTimeout, AbortController, Promise, JSON, Object, Error
  });
  vm.runInContext(SOURCE, context);
  return { api: vm.runInContext('StoreApi', context), calls };
}

const reply = (status, body) => Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
const ORDER = { customer: {}, items: [], idempotencyKey: 'abcdef0123456789abcdef0123456789' };

test('adapter: products via GET /api/products', async () => {
  const { api, calls } = load(() => reply(200, { success: true, products: [] }));
  assert.deepEqual(await api.getProducts(), { success: true, products: [] });
  assert.equal(calls[0].url, '/api/products');
  assert.equal(calls[0].opts.method, 'GET');
});

test('adapter: order via same-origin JSON POST /api/orders with the idempotency key', async () => {
  const { api, calls } = load(() => reply(200, { success: true, orderId: '01234', total: 10 }));
  const res = await api.submitOrder(ORDER);
  assert.equal(res.orderId, '01234');
  assert.equal(calls[0].url, '/api/orders');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].opts.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(calls[0].opts.body), ORDER);
});

test('adapter: a 4xx JSON answer is a definite "no" (resolved, not retried)', async () => {
  const { api, calls } = load(() => reply(400, { success: false, code: 'INVALID_REQUEST', message: 'Invalid order request.' }));
  const res = await api.submitOrder(ORDER);
  assert.equal(res.code, 'INVALID_REQUEST');
  assert.equal(calls.length, 1);
});

test('adapter: 5xx = outcome unknown → one retry with the SAME body, then rejects', async () => {
  const { api, calls } = load(() => reply(502, { success: false, code: 'UNCONFIRMED' }));
  await assert.rejects(api.submitOrder(ORDER), (err) => err.name === 'ApiError' && err.kind === 'network');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.body, calls[1].opts.body);
});

test('adapter: an order without a key is never retried', async () => {
  const { api, calls } = load(() => reply(502, {}));
  await assert.rejects(api.submitOrder({ customer: {}, items: [] }));
  assert.equal(calls.length, 1);
});

test('adapter: retry after a lost answer returns the server result', async () => {
  const { api, calls } = load((url, opts, n) => n === 1 ? Promise.reject(new TypeError('offline')) : reply(200, { success: true, orderId: '55555', total: 1 }));
  assert.equal((await api.submitOrder(ORDER)).orderId, '55555');
  assert.equal(calls.length, 2);
});

test('adapter: products retried up to 3 times on 5xx/network', async () => {
  const { api, calls } = load((url, opts, n) => n < 3 ? reply(502, { success: false }) : reply(200, { success: true, products: [] }));
  assert.equal((await api.getProducts()).success, true);
  assert.equal(calls.length, 3);
});

test('adapter: non-JSON or shapeless answers are not treated as success', async () => {
  for (const body of ['<html>', '[]', '{"orderId":"12345"}', 'null']) {
    const { api } = load(() => reply(200, body));
    await assert.rejects(api.submitOrder({ customer: {}, items: [] }), (err) => err.name === 'ApiError', body);
  }
});

test('adapter: a call that never answers rejects with a timeout', async () => {
  const { api } = load((url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  await assert.rejects(api.submitOrder({ customer: {}, items: [] }), (err) => err.kind === 'timeout');
});
