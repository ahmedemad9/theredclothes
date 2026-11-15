#!/usr/bin/env node
/**
 * Builds cloudflare/public/: the storefront as plain static files for the Cloudflare
 * Worker's static assets, generated from the same src/ files the Apps Script site uses
 * (nothing is copied by hand, so both sites stay identical).
 *
 *     node tools/build_cloudflare.mjs        (also run by `wrangler deploy`, see wrangler.jsonc)
 *
 *   src/Index.html   → index.html   (template tags replaced, includes turned into links)
 *   src/Styles.html  → styles.css
 *   src/Logic.html   → logic.js
 *   src/Scripts.html → app.js
 *   cloudflare/web/api.js   → api.js   (fetch adapter; replaces src/Api.html)
 *   cloudflare/web/_headers → _headers (security and cache headers)
 *   assets/          → assets/ (backgrounds) and favicon.png
 *
 * window.STORE_CONFIG comes from /api/config at page load, so Config.gs stays the single
 * place for settings. The Products and Orders data are never part of the build.
 * Plain Node.js, no dependencies (Cloudflare's build image always has Node).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const WEB = path.join(ROOT, 'cloudflare', 'web');
const OUT = path.join(ROOT, 'cloudflare', 'public');
const MAX_ASSET_BYTES = 25 * 1024 * 1024;   // Cloudflare static asset file limit

const ASSETS = ['background-desktop.gif', 'background-mobile.gif',
  'background-desktop-static.jpg', 'background-mobile-static.jpg'];

function fail(message) {
  console.error('build_cloudflare: ' + message);
  process.exit(1);
}

const read = (file) => fs.readFileSync(file, 'utf8');

/** The body of a src/*.html file that is exactly one <script> or <style> element. */
function unwrap(name, tag) {
  const text = read(path.join(SRC, name)).trim();
  const m = text.match(new RegExp(`^<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>$`));
  if (!m || m[1].includes(`</${tag}`)) fail(`${name}: expected a single <${tag}> element`);
  return m[1].trim() + '\n';
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function storeName() {
  const m = read(path.join(SRC, 'Config.gs')).match(/STORE_NAME:\s*'((?:[^'\\]|\\.)*)'/);
  if (!m) fail('Config.gs: STORE_NAME not found');
  return m[1].replace(/\\'/g, "'");
}

function buildIndex() {
  let page = read(path.join(SRC, 'Index.html'));
  const name = escapeHtml(storeName());
  const replacements = [
    ['<script>window.STORE_CONFIG = <?!= configJson ?>;</script>',
      '<link rel="icon" type="image/png" href="/favicon.png">\n  <script src="/api/config"></script>'],
    ["<?!= include('Styles'); ?>", '<link rel="stylesheet" href="/styles.css">'],
    ["<?!= include('Logo'); ?>", read(path.join(SRC, 'Logo.html')).trim()],
    ["<?!= include('Logic'); ?>", '<script src="/logic.js"></script>'],
    ["<?!= include('Api'); ?>", '<script src="/api.js"></script>'],
    ["<?!= include('Scripts'); ?>", '<script src="/app.js"></script>'],
    ['<?= storeName ?>', name]
  ];
  for (const [from, to] of replacements) {
    if (!page.includes(from)) fail(`Index.html: expected ${JSON.stringify(from)}`);
    page = page.split(from).join(to);
  }
  if (page.includes('<?')) fail('Index.html: unhandled Apps Script template tag: ' + page.slice(page.indexOf('<?'), page.indexOf('<?') + 60));
  if (!/^<!DOCTYPE html>/i.test(page) || !page.includes('<div class="site-bg"') || !page.includes('</html>')) {
    fail('index.html does not look like the storefront page');
  }
  return page;
}

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });   // generated folder only
  fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });

  fs.writeFileSync(path.join(OUT, 'index.html'), buildIndex());
  fs.writeFileSync(path.join(OUT, 'styles.css'), unwrap('Styles.html', 'style'));
  fs.writeFileSync(path.join(OUT, 'logic.js'), unwrap('Logic.html', 'script'));
  fs.writeFileSync(path.join(OUT, 'app.js'), unwrap('Scripts.html', 'script'));
  fs.copyFileSync(path.join(WEB, 'api.js'), path.join(OUT, 'api.js'));
  fs.copyFileSync(path.join(WEB, '_headers'), path.join(OUT, '_headers'));

  for (const asset of ASSETS) {
    const file = path.join(ROOT, 'assets', asset);
    if (!fs.existsSync(file)) fail(`missing assets/${asset}`);
    if (fs.statSync(file).size > MAX_ASSET_BYTES) fail(`assets/${asset} is over the 25 MiB Cloudflare file limit`);
    fs.copyFileSync(file, path.join(OUT, 'assets', asset));
  }
  fs.copyFileSync(path.join(ROOT, 'assets', 'favicon.png'), path.join(OUT, 'favicon.png'));

  const files = fs.readdirSync(OUT, { recursive: true })
    .filter((f) => fs.statSync(path.join(OUT, f)).isFile()).map((f) => f.split(path.sep).join('/')).sort();
  console.log(`Wrote ${path.relative(ROOT, OUT)} (${files.length} files): ${files.join(', ')}`);
}

main();
