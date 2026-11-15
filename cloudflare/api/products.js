/**
 * GET /api/products → Apps Script doGet(?action=products) → getProducts().
 * Read fresh on every request (stock changes in the sheet show up immediately).
 */
import { callAppsScript, json, logBackendError, pick } from '../lib/apps-script.js';

const FIELDS = ['success', 'products', 'currency', 'sizes', 'swatches', 'message'];

export async function onRequestGet(context) {
  try {
    const data = await callAppsScript(context.env, { query: { action: 'products' }, timeoutMs: 25000 });
    if (data.success && !Array.isArray(data.products)) throw new Error('products is not a list');
    return json(pick(data, FIELDS));
  } catch (err) {
    logBackendError('GET /api/products', err);
    // 502 lets the browser adapter retry; a read has no side effects.
    return json({ success: false, message: 'The product catalog is unavailable right now. Please try again shortly.' }, 502);
  }
}
