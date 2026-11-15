/**
 * GET /api/config → a small script that sets window.STORE_CONFIG, loaded by index.html
 * before the storefront (the Apps Script page embeds the same object server-side).
 * Source: Apps Script doGet(?action=config) → getPublicConfig_(), which holds nothing
 * private. Cached at the edge for a few minutes, so Config.gs changes appear after up
 * to CACHE_SECONDS once the Apps Script deployment is updated.
 */
import { callAppsScript, logBackendError } from '../lib/apps-script.js';
import { configScript, withLocalBackground } from '../lib/store-config.js';

const CACHE_SECONDS = 300;

function script(body, maxAge) {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': maxAge ? 'public, max-age=' + maxAge : 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export async function onRequestGet(context) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(new URL('/api/config', context.request.url).toString());
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch (err) { /* cache unavailable: fetch fresh */ }
  }

  try {
    const data = await callAppsScript(context.env, { query: { action: 'config' }, timeoutMs: 15000 });
    if (!data.success || !data.config || typeof data.config !== 'object') throw new Error('no config in answer');
    const response = script(configScript(withLocalBackground(data.config)), CACHE_SECONDS);
    if (cache) {
      const put = cache.put(cacheKey, response.clone()).catch(() => {});
      if (context.waitUntil) context.waitUntil(put);
    }
    return response;
  } catch (err) {
    logBackendError('GET /api/config', err);
    // The page still works with built-in defaults; the catalog shows its own error.
    return script(configScript(withLocalBackground({})), 0);
  }
}
