/**
 * StoreApi for a static host (Cloudflare Pages, Netlify, your own server, ...).
 *
 * NOT used by the Apps Script deployment. When moving the frontend off Apps Script,
 * load this file instead of Api.html. It has the same interface, so Logic.html and
 * Scripts.html do not change.
 *
 * It talks to the same Apps Script deployment:
 *   GET  <API_URL>?action=products   → doGet  → getProducts()
 *   POST <API_URL>  (JSON as text)   → doPost → processOrder_()  (same pipeline as the website)
 *
 * Cross-origin notes (see README → "Cross-origin limitations"):
 *  - The POST uses Content-Type text/plain so the browser does not send a CORS
 *    preflight (Apps Script cannot answer OPTIONS requests).
 *  - Apps Script answers with a redirect to script.googleusercontent.com; fetch
 *    follows it automatically. HTTP status codes are always 200, so success is
 *    read from the JSON body only.
 *  - Do NOT set WEBHOOK_SECRET when the browser calls doPost directly: anything
 *    shipped to the browser is public.
 */
var StoreApi = (function () {
  'use strict';

  var API_URL = 'https://script.google.com/macros/s/DEPLOYMENT_ID/exec';

  function ApiError(kind, message) {
    var err = new Error(message);
    err.name = 'ApiError';
    err.kind = kind;
    return err;
  }

  function request(url, options, timeoutMs) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, timeoutMs);
    var opts = Object.assign({ redirect: 'follow', signal: controller && controller.signal }, options);
    return fetch(url, opts).then(function (res) {
      if (!res.ok) throw ApiError('network', 'HTTP ' + res.status);
      return res.json().catch(function () { throw ApiError('network', 'Unexpected server response.'); });
    }, function (err) {
      throw ApiError(err && err.name === 'AbortError' ? 'timeout' : 'network', 'Could not reach the server.');
    }).then(function (data) {
      clearTimeout(timer);
      if (!data || typeof data !== 'object') throw ApiError('network', 'Unexpected server response.');
      return data;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function withRetry(task, attempts, delayMs) {
    return task().catch(function (err) {
      if (attempts <= 1 || err.name !== 'ApiError') throw err;
      return wait(delayMs).then(function () { return withRetry(task, attempts - 1, delayMs * 2); });
    });
  }

  return {
    getProducts: function () {
      return withRetry(function () {
        return request(API_URL + '?action=products', { method: 'GET' }, 20000);
      }, 3, 800);
    },
    submitOrder: function (orderData) {
      var attempts = orderData && orderData.idempotencyKey ? 2 : 1;
      return withRetry(function () {
        return request(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(orderData)
        }, 60000);
      }, attempts, 1500);
    }
  };
})();
