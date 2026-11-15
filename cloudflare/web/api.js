/**
 * StoreApi for the Cloudflare site. Same interface as src/Api.html (the Apps
 * Script version), so Logic and Scripts are shared unchanged:
 *   StoreApi.getProducts()          → GET  /api/products
 *   StoreApi.submitOrder(orderData) → POST /api/orders
 * Both go to this site's own Worker (cloudflare/worker.js), which calls Apps Script server-side;
 * the browser never sees the Apps Script URL or any secret.
 *
 * A server answer (HTTP 200 or 4xx with a JSON body) resolves, even when it is a "no".
 * A 5xx, a non-JSON answer, a network error or a timeout rejects with an ApiError
 * (kind: 'network' | 'timeout'): for an order that means "outcome unknown".
 */
var StoreApi = (function () {
  'use strict';

  var BASE = '/api';

  function ApiError(kind, message) {
    var err = new Error(message);
    err.name = 'ApiError';
    err.kind = kind;
    return err;
  }

  function request(path, options, timeoutMs) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; if (controller) controller.abort(); }, timeoutMs);
    var opts = Object.assign({ credentials: 'same-origin', cache: 'no-store', signal: controller && controller.signal }, options);
    return fetch(BASE + path, opts).then(function (res) {
      if (res.status >= 500) throw ApiError('network', 'HTTP ' + res.status);
      return res.json().catch(function () { throw ApiError('network', 'Unexpected server response.'); });
    }, function () {
      throw ApiError(timedOut ? 'timeout' : 'network', timedOut ? 'The server took too long to respond.' : 'Could not reach the server.');
    }).then(function (data) {
      clearTimeout(timer);
      if (!data || typeof data !== 'object' || typeof data.success !== 'boolean') throw ApiError('network', 'Unexpected server response.');
      return data;
    }, function (err) {
      clearTimeout(timer);
      throw err.name === 'ApiError' ? err : ApiError(timedOut ? 'timeout' : 'network', 'Could not reach the server.');
    });
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** Retries transport failures only. Server answers (even failures) are returned as-is. */
  function withRetry(task, attempts, delayMs) {
    return task().catch(function (err) {
      if (attempts <= 1 || err.name !== 'ApiError') throw err;
      return wait(delayMs).then(function () { return withRetry(task, attempts - 1, delayMs * 2); });
    });
  }

  return {
    getProducts: function () {
      // Reading the catalog has no side effects, so retrying is always safe.
      return withRetry(function () { return request('/products', { method: 'GET' }, 30000); }, 3, 800);
    },
    submitOrder: function (orderData) {
      // Safe to retry only because every order carries an idempotency key: the
      // server returns the original result instead of saving a second order.
      var attempts = orderData && orderData.idempotencyKey ? 2 : 1;
      return withRetry(function () {
        return request('/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(orderData)
        }, 95000);
      }, attempts, 1500);
    }
  };
})();
