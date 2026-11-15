/**
 * A stand-in for Google, for tests only: the real .gs backend (src/) running in a
 * Node vm on the in-memory spreadsheet from tests/gas-mocks.js, behind a fetch()
 * that behaves like the Apps Script web app:
 *   GET/POST https://script.google.com/macros/s/<id>/exec → runs doGet/doPost, then
 *   302 → https://script.googleusercontent.com/macros/echo?user_content_key=… (one use)
 * No request ever leaves the machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEPLOYMENT_ID = 'AKfycbTESTdeployment000000000000';
export const EXEC_URL = `https://script.google.com/macros/s/${DEPLOYMENT_ID}/exec`;
export const SECRET = 'test-webhook-secret-0123456789';

/** Loads the backend into a fresh vm. `rows` = Products tab (header + rows). */
export function createBackend(rows, props) {
  const context = vm.createContext({ console: { log() {}, warn() {}, error() {}, info() {} } });
  const files = ['tests/gas-mocks.js', 'src/Config.gs', 'src/Products.gs', 'src/Orders.gs', 'src/Email.gs', 'src/Code.gs'];
  files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), context, { filename: f }));
  context.__rows = rows;
  context.__props = Object.assign({ NOTIFICATION_EMAIL: 'owner@example.com', WEBHOOK_SECRET: SECRET }, props || {});
  vm.runInContext('resetMocks({ sheets: { Products: __rows, Orders: [CONFIG.ORDER_HEADERS] }, props: __props })', context);
  const run = (code) => vm.runInContext(code, context);
  return {
    context,
    run,
    mock: () => run('__mock'),
    orders: () => run('__mock.spreadsheet.getSheetByName("Orders")'),
    products: () => run('__mock.spreadsheet.getSheetByName("Products")')
  };
}

/**
 * fetch() as Google would answer it. Options:
 *   delayMs        wait before running doPost (slow script)
 *   onExec(req)    observe each /exec call: { method, url, body, headers }
 */
export function googleFetch(backend, options = {}) {
  const echoes = new Map();
  let counter = 0;
  const calls = [];

  async function fetchImpl(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    if (init.redirect !== 'manual') throw new Error('test: redirects must be followed by hand');

    if (url.hostname === 'script.google.com' && url.pathname === `/macros/s/${DEPLOYMENT_ID}/exec`) {
      const body = init.body == null ? '' : String(init.body);
      const call = { method, url: url.toString(), body, headers: new Headers(init.headers || {}) };
      calls.push(call);
      if (options.onExec) options.onExec(call);
      if (method === 'POST' && options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      const parameter = Object.fromEntries(url.searchParams);
      backend.context.__event = method === 'POST'
        ? { parameter, postData: { contents: body, type: 'text/plain' } }
        : { parameter };
      const output = backend.run(method === 'POST' ? 'doPost(__event)' : 'doGet(__event)');
      const key = 'k' + (++counter);
      echoes.set(key, typeof output.getContent === 'function'
        ? { body: output.getContent(), type: 'application/json; charset=utf-8' }
        : { body: '<!DOCTYPE html><title>The Red</title>', type: 'text/html; charset=utf-8' });
      return new Response(null, { status: 302,
        headers: { Location: `https://script.googleusercontent.com/macros/echo?user_content_key=${key}&lib=MTEST` } });
    }

    if (url.hostname === 'script.googleusercontent.com' && url.pathname === '/macros/echo') {
      if (method !== 'GET') throw new Error('test: the echo link must be read with GET');
      const hit = echoes.get(url.searchParams.get('user_content_key'));
      echoes.delete(url.searchParams.get('user_content_key'));   // one-time, like Google's
      if (!hit) return new Response('<html>Sorry, unable to open the file at this time.</html>', { status: 404, headers: { 'Content-Type': 'text/html' } });
      return new Response(hit.body, { status: 200, headers: { 'Content-Type': hit.type } });
    }

    throw new Error('test: unexpected request to ' + url);
  }

  fetchImpl.calls = calls;
  return fetchImpl;
}
