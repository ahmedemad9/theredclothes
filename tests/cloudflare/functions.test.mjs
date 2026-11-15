/**
 * Worker API tests: the real cloudflare/api/*.js handlers, talking to the real
 * .gs backend through a simulated Google (google-sim.mjs). No network, no real orders.
 *
 *   node --test tests/cloudflare/*.test.mjs      (or: cd cloudflare && npm test)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createBackend, googleFetch, EXEC_URL, SECRET } from './google-sim.mjs';
import { onRequestGet as getProducts } from '../../cloudflare/api/products.js';
import { onRequestPost as postOrder } from '../../cloudflare/api/orders.js';
import { onRequestGet as getConfig } from '../../cloudflare/api/config.js';
import { isTrustedRedirect, execUrl } from '../../cloudflare/lib/apps-script.js';

const HEADER = ['Product ID', 'Name', 'Description', 'Price', 'Category', 'Color', 'Image Link', 'Image Link 2', 'S', 'M', 'L', 'XL', 'XXL'];
const ROWS = [HEADER,
  ['P001', 'Classic Hoodie', 'Cotton hoodie', 899, 'Hoodies', 'Red', 'https://img.example/p1-red.jpg', 'https://img.example/p1-red-back.jpg', 1, 1, 0, 0, 1],
  ['P001', 'Classic Hoodie', 'Cotton hoodie', 899, 'Hoodies', 'Blue', 'https://img.example/p1-blue.jpg', '', 1, 1, 1, 1, 1],
  ['P002', 'Printed T-Shirt', 'Printed cotton', 449, 'Printed', 'Black', 'https://img.example/p2-black.jpg', '', 1, 1, 1, 0, 0]];
const ENV = { APPS_SCRIPT_URL: EXEC_URL, WEBHOOK_SECRET: SECRET };
const SITE = 'https://theredclothes.example.workers.dev';
console.error = () => {};   // the functions log every refused backend answer; expected here

let backend;
function setup(fetchOptions, props) {
  backend = createBackend(JSON.parse(JSON.stringify(ROWS)), props);
  globalThis.fetch = googleFetch(backend, fetchOptions);
  return globalThis.fetch;
}

function order(overrides) {
  return Object.assign({
    customer: { name: 'Jane Doe', phone: '+20 10 1234 5678', email: 'jane@example.com', address: '12 Tahrir Street\nCairo 11511\nEgypt' },
    items: [{ productId: 'P001', color: 'Blue', size: 'L', quantity: 2, unitPrice: 899 },
      { productId: 'P002', color: 'Black', size: 'S', quantity: 1, unitPrice: 449 }],
    idempotencyKey: 'abcdef0123456789abcdef0123456789',
    website: ''
  }, overrides || {});
}

function post(body, headers, env) {
  const request = new Request(SITE + '/api/orders', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', Origin: SITE }, headers || {}),
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  return postOrder({ request, env: env || ENV });
}

async function read(response) {
  return { status: response.status, body: await response.json(), type: response.headers.get('Content-Type') };
}

/* ---------------- products ---------------- */

test('GET /api/products: catalog with colours, per-colour images and sizes, through the 302', async () => {
  const fetchImpl = setup();
  const { status, body, type } = await read(await getProducts({ request: new Request(SITE + '/api/products'), env: ENV }));
  assert.equal(status, 200);
  assert.match(type, /^application\/json/);
  assert.equal(body.success, true);
  assert.equal(body.currency, 'EGP');
  assert.deepEqual(body.products.map((p) => p.id), ['P001', 'P002']);
  const red = body.products[0].variants.find((v) => v.color === 'Red');
  assert.equal(red.imageUrl, 'https://img.example/p1-red.jpg');
  assert.equal(red.imageUrl2, 'https://img.example/p1-red-back.jpg');
  assert.deepEqual(red.sizes, { S: true, M: true, L: false, XL: false, XXL: true });
  assert.equal(fetchImpl.calls[0].method, 'GET');
  assert.match(fetchImpl.calls[0].url, /\?action=products$/);
});

test('GET /api/products: reads the sheet fresh every time (stock change shows at once)', async () => {
  setup();
  backend.products().getRange(3, 11).setValue(0);   // P001 Blue L → 0
  const { body } = await read(await getProducts({ request: new Request(SITE + '/api/products'), env: ENV }));
  assert.equal(body.products[0].variants.find((v) => v.color === 'Blue').sizes.L, false);
});

test('GET /api/products: a missing or non-Apps-Script APPS_SCRIPT_URL is never called', async () => {
  const fetchImpl = setup();
  for (const url of ['', 'https://evil.example/exec', 'http://script.google.com/macros/s/AKfycbTESTdeployment000000000000/exec',
    'https://script.google.com.evil.example/macros/s/AKfycbTESTdeployment000000000000/exec']) {
    const res = await getProducts({ request: new Request(SITE + '/api/products'), env: { APPS_SCRIPT_URL: url } });
    assert.equal(res.status, 502, url);
    assert.equal((await res.json()).success, false);
  }
  assert.equal(fetchImpl.calls.length, 0);
  assert.throws(() => execUrl({ APPS_SCRIPT_URL: 'https://script.google.com/macros/s/x/exec' }));
  assert.equal(execUrl({ APPS_SCRIPT_URL: ' ' + EXEC_URL + ' ' }), EXEC_URL);
});

test('redirects: only https Google hosts are followed', () => {
  assert.ok(isTrustedRedirect('https://script.googleusercontent.com/macros/echo?user_content_key=x'));
  assert.ok(isTrustedRedirect('https://script.google.com/macros/s/abc/exec'));
  for (const bad of ['http://script.googleusercontent.com/x', 'https://evil.example/x', 'https://script.googleusercontent.com.evil.example/x',
    'https://user:pw@script.googleusercontent.com/x', 'https://script.googleusercontent.com:8443/x', '/relative', 'javascript:alert(1)', '']) {
    assert.equal(isTrustedRedirect(bad), false, bad);
  }
});

test('GET /api/products: an untrusted redirect is not followed', async () => {
  setup();
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response(null, { status: 302, headers: { Location: 'https://evil.example/steal' } });
  };
  const res = await getProducts({ request: new Request(SITE + '/api/products'), env: ENV });
  assert.equal(res.status, 502);
  assert.deepEqual(seen, [EXEC_URL + '?action=products']);
});

test('GET /api/products: Google HTML pages, opaque answers and odd JSON are not passed on', async () => {
  const answers = [
    () => new Response('<html>Sign in</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    () => new Response(null, { status: 204 }),
    () => new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    () => new Response('[1,2]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    () => new Response('{"products":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    () => new Response('{"success":true,"products":"x"}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    () => new Response('{}', { status: 500, headers: { 'Content-Type': 'application/json' } }),
    () => { throw new TypeError('network down'); }
  ];
  for (const answer of answers) {
    globalThis.fetch = async () => answer();
    const res = await getProducts({ request: new Request(SITE + '/api/products'), env: ENV });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { success: false, message: 'The product catalog is unavailable right now. Please try again shortly.' });
  }
});

test('GET /api/products: only known fields reach the browser', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, products: [], currency: 'EGP', debug: 'internal' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  const { body } = await read(await getProducts({ request: new Request(SITE + '/api/products'), env: ENV }));
  assert.deepEqual(body, { success: true, products: [], currency: 'EGP' });
});

/* ---------------- orders ---------------- */

test('POST /api/orders: saves to the Orders sheet, emails the owner, returns the reference', async () => {
  const fetchImpl = setup();
  const { status, body } = await read(await post(order()));
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.match(body.orderId, /^\d{5}$/);
  assert.equal(body.total, 2247);

  const row = backend.orders().row(2);
  assert.equal(row[1], body.orderId);
  assert.equal(row[6], 'P001 | Classic Hoodie | Blue | L | Qty: 2\nP002 | Printed T-Shirt | Black | S | Qty: 1');
  assert.equal(row[7], 2247);
  assert.equal(row[8], 'Pending');
  const mails = backend.mock().sentEmails;
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'owner@example.com');
  assert.equal(mails[0].subject, 'New T-Shirt Order #' + body.orderId);

  // One POST to /exec (never re-sent), then one GET of the echo link.
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].method, 'POST');
  const sent = JSON.parse(fetchImpl.calls[0].body);
  assert.equal(sent.secret, SECRET, 'secret added server-side');
});

test('POST /api/orders: the same idempotency key never saves a second order', async () => {
  setup();
  const first = await read(await post(order()));
  const again = await read(await post(order()));
  assert.equal(again.body.orderId, first.body.orderId);
  assert.equal(backend.orders().getLastRow(), 2);
  assert.equal(backend.mock().sentEmails.length, 1);
});

test('POST /api/orders: prices come from the sheet — a tampered price is refused, nothing saved', async () => {
  setup();
  const tampered = order({ items: [{ productId: 'P001', color: 'Blue', size: 'L', quantity: 1, unitPrice: 1 }] });
  const { status, body } = await read(await post(tampered));
  assert.equal(status, 200);
  assert.equal(body.success, false);
  assert.equal(body.code, 'CART_CHANGED');
  assert.equal(body.problems[0].reason, 'price_changed');
  assert.equal(backend.orders().getLastRow(), 1);

  const noPrice = order({ items: [{ productId: 'P001', color: 'Blue', size: 'L', quantity: 1 }], idempotencyKey: 'noprice0123456789abc' });
  const ok = await read(await post(noPrice));
  assert.equal(ok.body.total, 899, 'total computed by the backend');
});

test('POST /api/orders: out-of-stock size and unknown colour are refused', async () => {
  setup();
  const sold = await read(await post(order({ items: [{ productId: 'P001', color: 'Red', size: 'L', quantity: 1, unitPrice: 899 }] })));
  assert.equal(sold.body.problems[0].reason, 'size_unavailable');
  const colour = await read(await post(order({ items: [{ productId: 'P001', color: 'Green', size: 'S', quantity: 1, unitPrice: 899 }], idempotencyKey: 'colour0123456789abcd' })));
  assert.equal(colour.body.problems[0].reason, 'color_unavailable');
  assert.equal(backend.orders().getLastRow(), 1);
});

test('POST /api/orders: field errors come back for the form', async () => {
  setup();
  const { status, body } = await read(await post(order({ customer: { name: 'J', phone: '1', email: 'x', address: '' } })));
  assert.equal(status, 200);
  assert.equal(body.code, 'VALIDATION');
  assert.deepEqual(Object.keys(body.fieldErrors).sort(), ['address', 'email', 'name', 'phone']);
});

test('POST /api/orders: a client-sent "secret" or extra field is never forwarded', async () => {
  const fetchImpl = setup();
  await post(Object.assign(order(), { secret: 'guess', admin: true }));
  const sent = JSON.parse(fetchImpl.calls[0].body);
  assert.equal(sent.secret, SECRET);
  assert.deepEqual(Object.keys(sent).sort(), ['customer', 'idempotencyKey', 'items', 'secret', 'website']);
});

test('POST /api/orders: requests without a valid idempotency key are refused before the backend', async () => {
  const fetchImpl = setup();
  for (const key of [undefined, '', 'short', 'x'.repeat(65), 'has spaces in it 1234', 12345678901234567]) {
    const res = await post(order({ idempotencyKey: key }));
    assert.equal(res.status, 400, String(key));
    assert.equal((await res.json()).success, false);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('POST /api/orders: cross-site, non-JSON, oversized and malformed requests are refused', async () => {
  const fetchImpl = setup();
  assert.equal((await post(order(), { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(order(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(order(), { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await post('{"a":"' + 'x'.repeat(40000) + '"}')).status, 413);
  assert.equal((await post('{nope')).status, 400);
  assert.equal((await post('[1]')).status, 400);
  assert.equal(fetchImpl.calls.length, 0);
  const noOrigin = new Request(SITE + '/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(order()) });
  assert.equal((await postOrder({ request: noOrigin, env: ENV })).status, 200, 'no Origin header (non-browser) still goes through the backend checks');
});

test('POST /api/orders: missing WEBHOOK_SECRET or a mismatch → "unavailable", not an order', async () => {
  let fetchImpl = setup();
  const missing = await read(await post(order(), {}, { APPS_SCRIPT_URL: EXEC_URL }));
  assert.equal(missing.body.code, 'UNAVAILABLE');
  assert.equal(fetchImpl.calls.length, 0);

  fetchImpl = setup({}, { WEBHOOK_SECRET: 'a-different-secret-value' });
  const mismatch = await read(await post(order()));
  assert.equal(mismatch.status, 200);
  assert.equal(mismatch.body.success, false);
  assert.equal(mismatch.body.code, 'UNAVAILABLE');
  assert.equal(backend.orders().getLastRow(), 1);
});

test('POST /api/orders: a lost or odd answer is "unconfirmed" (5xx), never a reference', async () => {
  const cases = [
    () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/x' } }),
    () => new Response('<html>Error</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    () => new Response(null, { status: 204 }),
    () => new Response('{"success":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    () => new Response('{"success":true,"orderId":"12AB5","total":1}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    () => new Response('{"success":true,"orderId":"12345","total":"lots"}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    () => { throw new TypeError('connection reset'); }
  ];
  for (const answer of cases) {
    globalThis.fetch = async () => answer();
    const res = await post(order());
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'UNCONFIRMED');
    assert.equal(body.orderId, undefined);
  }
});

test('POST /api/orders: if the answer is lost after saving, the retry returns the same order', async () => {
  setup();
  const real = globalThis.fetch;
  let dropEcho = true;
  globalThis.fetch = async (url, init) => {
    const res = await real(url, init);
    if (dropEcho && String(url).includes('googleusercontent')) { dropEcho = false; throw new TypeError('connection reset'); }
    return res;
  };
  const lost = await post(order());
  assert.equal(lost.status, 502);
  assert.equal(backend.orders().getLastRow(), 2, 'the script had already saved it');
  const retry = await read(await post(order()));
  assert.equal(retry.body.success, true);
  assert.equal(retry.body.orderId, backend.orders().row(2)[1]);
  assert.equal(backend.orders().getLastRow(), 2, 'no duplicate');
});

/* ---------------- config ---------------- */

test('GET /api/config: public config as a script, local backgrounds filled in, nothing private', async () => {
  setup();
  const res = await getConfig({ request: new Request(SITE + '/api/config'), env: ENV });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /^text\/javascript/);
  const text = await res.text();
  assert.doesNotMatch(text, /</);
  for (const leak of [SECRET, 'owner@example.com', EXEC_URL]) assert.ok(!text.includes(leak), leak);
  const window = {};
  new Function('window', text)(window);
  assert.equal(window.STORE_CONFIG.storeName, 'The Red');
  assert.equal(window.STORE_CONFIG.currency, 'EGP');
  assert.equal(window.STORE_CONFIG.background.desktop, 'assets/background-desktop.gif');
  assert.equal(window.STORE_CONFIG.background.mobileStatic, 'assets/background-mobile-static.jpg');
  assert.equal(window.STORE_CONFIG.background.mobileBreakpoint, 768);
});

test('GET /api/config: backend down → defaults (page still loads), not cached', async () => {
  globalThis.fetch = async () => { throw new TypeError('down'); };
  const res = await getConfig({ request: new Request(SITE + '/api/config'), env: ENV });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const window = {};
  new Function('window', await res.text())(window);
  assert.equal(window.STORE_CONFIG.background.desktop, 'assets/background-desktop.gif');
});
