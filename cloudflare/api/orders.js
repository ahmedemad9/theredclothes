/**
 * POST /api/orders → Apps Script doPost → processOrder_() (the same pipeline as the
 * Apps Script website). The backend re-validates, re-prices from the sheet, takes the
 * script lock and de-duplicates by idempotency key; this function only screens the
 * request, adds the shared secret and checks the answer.
 *
 * Status codes the browser adapter (cloudflare/web/api.js) relies on:
 *   200 / 4xx  definite answer: either saved (success: true + orderId) or NOT saved
 *   5xx        outcome unknown: the customer is told to retry with the same key
 */
import { callAppsScript, json, logBackendError, pick } from '../lib/apps-script.js';

const MAX_BODY_BYTES = 32 * 1024;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const REQUEST_FIELDS = ['customer', 'items', 'idempotencyKey', 'website'];
const RESPONSE_FIELDS = ['success', 'orderId', 'total', 'currency', 'message', 'code', 'fieldErrors', 'problems', 'retryable'];

function rejected(status, code, message) {
  return json({ success: false, code, message }, status);
}

function unconfirmed(status) {
  return json({ success: false, code: 'UNCONFIRMED',
    message: 'We could not confirm your order. Please press Reserve Order again; it will not create a duplicate.' }, status);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // Only this site's own pages may post orders (browsers always send Origin on POST).
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return rejected(403, 'FORBIDDEN', 'Orders can only be placed from this website.');
  }
  // A JSON content type cannot be sent by a plain cross-site form.
  if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) {
    return rejected(415, 'INVALID_REQUEST', 'Invalid order request.');
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return rejected(413, 'INVALID_REQUEST', 'Your order is too large.');
  let body;
  try { body = JSON.parse(raw); } catch (err) { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return rejected(400, 'INVALID_REQUEST', 'Invalid order request.');
  }
  // Every write carries a key, so a retry can never save a second order.
  if (typeof body.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(body.idempotencyKey)) {
    return rejected(400, 'INVALID_REQUEST', 'Invalid order request. Please refresh the page and try again.');
  }

  const secret = String(env.WEBHOOK_SECRET || '');
  if (secret.length < 16) {
    logBackendError('POST /api/orders', { kind: 'config', message: 'WEBHOOK_SECRET is missing or shorter than 16 characters.' });
    return json({ success: false, code: 'UNAVAILABLE', message: 'Ordering is temporarily unavailable. Please try again later or contact us.' });
  }

  let data;
  try {
    data = await callAppsScript(env, {
      method: 'POST',
      body: Object.assign(pick(body, REQUEST_FIELDS), { secret }),
      timeoutMs: 85000
    });
  } catch (err) {
    logBackendError('POST /api/orders', err);
    // The script may have saved the order before the answer was lost.
    if (err.kind === 'config') {
      return json({ success: false, code: 'UNAVAILABLE', message: 'Ordering is temporarily unavailable. Please try again later or contact us.' });
    }
    return unconfirmed(err.kind === 'timeout' ? 504 : 502);
  }

  if (data.success) {
    // An order reference is shown only for a well-formed, confirmed save.
    if (!/^\d{5}$/.test(String(data.orderId)) || typeof data.total !== 'number' || !isFinite(data.total)) {
      logBackendError('POST /api/orders', { kind: 'unreachable', message: 'success without a valid orderId/total' });
      return unconfirmed(502);
    }
    return json(pick(data, RESPONSE_FIELDS));
  }
  if (data.code === 'UNAUTHORIZED') {
    logBackendError('POST /api/orders', { kind: 'config', message: 'WEBHOOK_SECRET differs from the script property.' });
    return json({ success: false, code: 'UNAVAILABLE', message: 'Ordering is temporarily unavailable. Please try again later or contact us.' });
  }
  return json(pick(data, RESPONSE_FIELDS));
}
