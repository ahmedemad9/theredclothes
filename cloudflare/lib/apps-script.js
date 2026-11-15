/**
 * Server-side client for the Apps Script web app. Used only by the Worker's API
 * handlers in cloudflare/api/; nothing here is sent to the browser.
 *
 * Apps Script answers every /exec request with a 302 to a one-time
 * script.googleusercontent.com link that holds the output. Redirects are followed by
 * hand so only Google hosts are ever contacted, and a POST is never re-sent: the
 * script has already run when the 302 arrives, the follow-up GET only reads the result.
 *
 * Environment (Cloudflare secrets, see CLOUDFLARE.md):
 *   APPS_SCRIPT_URL  https://script.google.com/macros/s/<deployment id>/exec
 *   WEBHOOK_SECRET   same value as the WEBHOOK_SECRET script property
 */

const EXEC_URL = /^https:\/\/script\.google\.com\/(?:a\/macros\/[A-Za-z0-9.-]+|macros)\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
const REDIRECT_HOSTS = ['script.googleusercontent.com', 'script.google.com'];
const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class BackendError extends Error {
  /** kind: 'config' (our setup is wrong), 'unreachable' (no usable answer), 'timeout'. */
  constructor(kind, message) {
    super(message);
    this.name = 'BackendError';
    this.kind = kind;
  }
}

/** The configured /exec URL, or a 'config' error. Never taken from the request. */
export function execUrl(env) {
  const url = String((env && env.APPS_SCRIPT_URL) || '').trim();
  if (!EXEC_URL.test(url)) {
    throw new BackendError('config', 'APPS_SCRIPT_URL is missing or is not an Apps Script /exec URL.');
  }
  return url;
}

export function isTrustedRedirect(location) {
  let url;
  try { url = new URL(location); } catch (err) { return false; }
  return url.protocol === 'https:' && !url.username && !url.password && url.port === '' &&
    REDIRECT_HOSTS.includes(url.hostname);
}

/**
 * Calls the web app and returns its JSON body as an object.
 *   options: { method: 'GET' | 'POST', query: {...}, body: object, timeoutMs, fetchImpl }
 * Throws BackendError unless a JSON object comes back from a trusted Google host.
 */
export async function callAppsScript(env, options) {
  const fetchImpl = options.fetchImpl || fetch;
  const target = new URL(execUrl(env));
  Object.entries(options.query || {}).forEach(([k, v]) => target.searchParams.set(k, v));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 25000);
  try {
    let response = await fetchImpl(target.toString(), {
      method: options.method || 'GET',
      // text/plain: what Apps Script expects in e.postData.contents.
      headers: options.body ? { 'Content-Type': 'text/plain;charset=utf-8' } : {},
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect: 'manual',
      signal: controller.signal
    });

    for (let hops = 0; isRedirect(response.status); hops++) {
      const location = response.headers.get('Location') || '';
      if (hops >= MAX_REDIRECTS || !isTrustedRedirect(location)) {
        throw new BackendError('unreachable', 'Untrusted or too many redirects from the backend.');
      }
      response = await fetchImpl(location, { method: 'GET', redirect: 'manual', signal: controller.signal });
    }

    if (response.status !== 200) {
      throw new BackendError('unreachable', 'Backend answered HTTP ' + response.status + '.');
    }
    // An HTML page here is a Google error or sign-in page, never our data.
    const type = response.headers.get('Content-Type') || '';
    if (!/^application\/json\b/i.test(type)) {
      throw new BackendError('unreachable', 'Backend did not answer with JSON (' + (type || 'no type') + ').');
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new BackendError('unreachable', 'Backend answer too large.');
    let data;
    try { data = JSON.parse(text); } catch (err) { throw new BackendError('unreachable', 'Backend answer is not valid JSON.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.success !== 'boolean') {
      throw new BackendError('unreachable', 'Backend answer has an unexpected shape.');
    }
    return data;
  } catch (err) {
    if (err instanceof BackendError) throw err;
    if (controller.signal.aborted) throw new BackendError('timeout', 'Backend did not answer in time.');
    throw new BackendError('unreachable', 'Could not reach the backend: ' + (err && err.message || err));
  } finally {
    clearTimeout(timer);
  }
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Copies only the listed keys that are present. */
export function pick(source, keys) {
  const out = {};
  keys.forEach((k) => { if (source[k] !== undefined) out[k] = source[k]; });
  return out;
}

export function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }, extraHeaders || {})
  });
}

/** Logs the detail for `wrangler pages deployment tail`; the browser gets a generic message. */
export function logBackendError(where, err) {
  console.error(where + ': ' + (err && err.kind ? err.kind + ' — ' : '') + (err && err.message || err));
}
