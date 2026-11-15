/**
 * Local test server for the Cloudflare build, used by `tests/ui_test.py --cloudflare`.
 * Every request goes through the real Worker (cloudflare/worker.js): /api/* to its
 * handlers, whose fetch() reaches the simulated Google (google-sim.mjs, the real .gs
 * backend on an in-memory spreadsheet), and the rest to env.ASSETS, imitated here by
 * serving cloudflare/public/ with its _headers (CSP included).
 *
 *   node tests/cloudflare/dev-server.mjs <products-rows.json> [port]
 *
 * Test-only routes under /__test/ let the browser tests read and change the mock sheets.
 * Prints "READY <url>" when listening.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBackend, googleFetch, EXEC_URL, SECRET } from './google-sim.mjs';
import worker from '../../cloudflare/worker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'cloudflare', 'public');
const IMAGES = path.join(ROOT, 'preview', 'img');   // sample product images from tools/build_preview.py
const ENV = { APPS_SCRIPT_URL: EXEC_URL, WEBHOOK_SECRET: SECRET };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

const rowsTemplate = fs.readFileSync(process.argv[2], 'utf8');
const sim = { delayMs: 0 };
let backend;

/** Headers from public/_headers, as Cloudflare adds them to static files. */
function staticHeaders(urlPath) {
  const out = {};
  let match = false;
  fs.readFileSync(path.join(PUBLIC, '_headers'), 'utf8').split('\n').forEach((line) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    if (!/^\s/.test(line)) {
      const pattern = new RegExp('^' + line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      match = pattern.test(urlPath);
    } else if (match) {
      const i = line.indexOf(':');
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  });
  return out;
}

function fileResponse(file, urlPath) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not found', { status: 404 });
  return new Response(fs.readFileSync(file),
    { headers: Object.assign({ 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }, staticHeaders(urlPath)) });
}

/** env.ASSETS: the static files of cloudflare/public/ ("/" → index.html). */
const ASSETS = {
  async fetch(request) {
    const urlPath = new URL(request.url).pathname;
    const rel = urlPath === '/' ? 'index.html' : path.normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
    if (rel.startsWith('..')) return new Response('Bad request', { status: 400 });
    return fileResponse(path.join(PUBLIC, rel), urlPath);
  }
};

async function send(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function testRoute(url, body, base) {
  const sheet = (name) => backend.run(`__mock.spreadsheet.getSheetByName(${JSON.stringify(name)})`);
  switch (url.pathname) {
    case '/__test/reset':
      backend = createBackend(JSON.parse(rowsTemplate.replace(/\{\{BASE\}\}/g, base)));
      globalThis.fetch = googleFetch(backend, sim);
      sim.delayMs = 700;   // like the preview: a visible "Reserving…" state
      return {};
    case '/__test/delay': sim.delayMs = Number(url.searchParams.get('ms')) || 0; return {};
    case '/__test/cells': return sheet(url.searchParams.get('sheet')).cells;
    case '/__test/row': return sheet(url.searchParams.get('sheet')).row(Number(url.searchParams.get('row')));
    case '/__test/lastRow': return sheet(url.searchParams.get('sheet')).getLastRow();
    case '/__test/set': {
      const { sheet: name, row, col, value } = JSON.parse(body);
      sheet(name).getRange(row, col).setValue(value);
      return {};
    }
    case '/__test/emails': return backend.mock().sentEmails;
    default: return undefined;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const base = `http://${req.headers.host}/`;
    const url = new URL(req.url, base);
    const body = await readBody(req);

    if (url.pathname.startsWith('/__test/')) {
      const out = testRoute(url, body.toString(), base);
      res.writeHead(out === undefined ? 404 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out === undefined ? null : out));
      return;
    }

    if (url.pathname.startsWith('/img/')) return send(res, fileResponse(path.join(IMAGES, path.basename(url.pathname)), url.pathname));

    const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    return send(res, await worker.fetch(request, Object.assign({ ASSETS }, ENV), { waitUntil() {} }));
  } catch (err) {
    process.stderr.write(String(err && err.stack || err) + '\n');
    res.writeHead(500);
    res.end(String(err));
  }
});

console.error = () => {};   // refused backend answers are logged by the functions; not needed here
server.listen(Number(process.argv[3]) || 0, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${server.address().port}/`;
  backend = createBackend(JSON.parse(rowsTemplate.replace(/\{\{BASE\}\}/g, base)));
  globalThis.fetch = googleFetch(backend, sim);
  process.stdout.write('READY ' + base + '\n');
});
