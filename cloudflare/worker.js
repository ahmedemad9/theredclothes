/**
 * Cloudflare Worker entry point (wrangler.jsonc "main").
 *
 * /api/* is handled here; everything else is a static file from cloudflare/public/
 * (the "assets" setting), served by env.ASSETS. The API handlers are the modules in
 * api/: each exports onRequestGet / onRequestPost(context).
 */
import * as config from './api/config.js';
import * as products from './api/products.js';
import * as orders from './api/orders.js';

const ROUTES = {
  '/api/config': config,
  '/api/products': products,
  '/api/orders': orders
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const route = ROUTES[url.pathname];
      if (!route) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
      const method = request.method === 'HEAD' ? 'GET' : request.method;
      const handler = route['onRequest' + method.charAt(0) + method.slice(1).toLowerCase()];
      if (!handler) {
        const allow = Object.keys(route).filter((k) => /^onRequest[A-Z]/.test(k)).map((k) => k.slice(9).toUpperCase());
        return new Response('Method not allowed', { status: 405, headers: { Allow: allow.join(', ') } });
      }
      return handler({ request, env, waitUntil: (p) => ctx.waitUntil(p) });
    }
    return env.ASSETS.fetch(request);
  }
};
