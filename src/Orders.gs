/**
 * Orders.gs — validates, prices and saves orders. Both the website
 * (google.script.run → submitOrder) and the JSON webhook (doPost) end up in
 * processOrder_(), so there is exactly one order pipeline.
 */

function StoreError_(message, code, extra) {
  this.message = message;
  this.code = code || 'ERROR';
  this.extra = extra || {};
}
StoreError_.prototype = Object.create(Error.prototype);
StoreError_.prototype.name = 'StoreError';

/* ------------------------------------------------------------------ *
 * Input validation (mirrors validateCustomer in Logic.html)
 * ------------------------------------------------------------------ */

/** Removes control characters; keeps newlines only when allowed. */
function cleanText_(value, keepNewlines) {
  var s = String(value == null ? '' : value).normalize('NFC');
  s = keepNewlines
    ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    : s.replace(/[\u0000-\u001F\u007F]/g, ' ');
  if (keepNewlines) {
    return s.split('\n').map(function (line) { return line.replace(/[ \t]+/g, ' ').trim(); })
      .filter(function (line) { return line; }).join('\n');
  }
  return s.replace(/\s+/g, ' ').trim();
}

var EMAIL_PATTERN_ = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$/;
var PHONE_PATTERN_ = /^\+?[0-9 ().\-\/]+$/;

function validateCustomer_(raw) {
  var L = CONFIG.LIMITS;
  raw = raw && typeof raw === 'object' ? raw : {};
  var c = {
    name: cleanText_(raw.name),
    phone: cleanText_(raw.phone),
    email: cleanText_(raw.email).toLowerCase(),
    address: cleanText_(raw.address, true)
  };
  var errors = {};

  if (!c.name) errors.name = 'Please enter your name.';
  else if (c.name.length < L.NAME_MIN || c.name.length > L.NAME_MAX) errors.name = 'Name must be ' + L.NAME_MIN + '–' + L.NAME_MAX + ' characters.';
  else if (!/\p{L}/u.test(c.name)) errors.name = 'Please enter a valid name.';

  var digits = c.phone.replace(/\D/g, '');
  if (!c.phone) errors.phone = 'Please enter your phone number.';
  else if (c.phone.length > L.PHONE_MAX || !PHONE_PATTERN_.test(c.phone) ||
    digits.length < L.PHONE_DIGITS_MIN || digits.length > L.PHONE_DIGITS_MAX || /^(\d)\1+$/.test(digits)) {
    errors.phone = 'Please enter a valid phone number, e.g. +353 87 123 4567.';
  }

  if (!c.email) errors.email = 'Please enter your email address.';
  else if (c.email.length > L.EMAIL_MAX || !EMAIL_PATTERN_.test(c.email) || /\.\./.test(c.email)) {
    errors.email = 'Please enter a valid email address.';
  }

  var words = c.address.split(/[\s,]+/).filter(function (w) { return w; });
  if (!c.address) errors.address = 'Please enter your shipping address.';
  else if (c.address.length > L.ADDRESS_MAX) errors.address = 'Address must be under ' + L.ADDRESS_MAX + ' characters.';
  else if (c.address.length < L.ADDRESS_MIN || words.length < 2 || !/\p{L}/u.test(c.address)) {
    errors.address = 'Please enter your full address (street, city, postcode, country).';
  }

  return { values: c, errors: errors, valid: Object.keys(errors).length === 0 };
}

/**
 * Shape-checks the cart and merges duplicate Product ID + Color + Size lines.
 * Items: { productId, color, size, quantity, unitPrice? }.
 */
function validateItems_(rawItems) {
  var L = CONFIG.LIMITS;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new StoreError_('Your cart is empty.', 'EMPTY_CART');
  }
  if (rawItems.length > L.MAX_LINES) {
    throw new StoreError_('Too many different items in one order (maximum ' + L.MAX_LINES + ').', 'INVALID_CART');
  }
  var merged = {};
  var order = [];
  rawItems.forEach(function (item) {
    item = item && typeof item === 'object' ? item : {};
    var productId = cleanText_(item.productId);
    var color = cleanText_(item.color);
    var size = canonicalSize_(cleanText_(item.size));
    var qty = Number(item.quantity);
    if (!productId || productId.length > PRODUCT_ID_MAX || !color || color.length > COLOR_MAX || !size) {
      throw new StoreError_('Your cart contains an invalid item. Please refresh the page and review your cart.', 'INVALID_CART');
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > L.MAX_QTY_PER_LINE) {
      throw new StoreError_('Quantity must be between 1 and ' + L.MAX_QTY_PER_LINE + ' for each item.', 'INVALID_CART');
    }
    var key = idKey_(productId) + '|' + colorKey_(color) + '|' + size;
    if (merged[key]) {
      merged[key].quantity += qty;
      if (merged[key].quantity > L.MAX_QTY_PER_LINE) {
        throw new StoreError_('Quantity must be between 1 and ' + L.MAX_QTY_PER_LINE + ' for each item.', 'INVALID_CART');
      }
    } else {
      var expected = item.unitPrice == null || item.unitPrice === '' ? null : Number(item.unitPrice);
      merged[key] = { productId: productId, color: color, size: size, quantity: qty, expectedPrice: isFinite(expected) ? expected : null };
      order.push(key);
    }
  });
  var lines = order.map(function (k) { return merged[k]; });
  var units = lines.reduce(function (sum, l) { return sum + l.quantity; }, 0);
  if (units > L.MAX_UNITS_PER_ORDER) {
    throw new StoreError_('Too many items in one order (maximum ' + L.MAX_UNITS_PER_ORDER + ').', 'INVALID_CART');
  }
  return lines;
}

/**
 * Checks every line against the live catalog — Product ID, then colour row, then
 * that colour's size cell, which must be 1 — and prices it from the sheet.
 * Prices sent by the browser are only used to detect that the customer saw an
 * out-of-date price; they never affect the total. Stock cells are never changed.
 */
function priceItems_(lines, catalog) {
  var index = indexCatalog_(catalog);
  var problems = [];
  var priced = [];
  lines.forEach(function (line) {
    var where = { productId: line.productId, color: line.color, size: line.size };
    var product = index[idKey_(line.productId)];
    if (!product) {
      problems.push(Object.assign(where, { reason: 'not_found',
        message: 'A product in your cart (' + line.productId + ') is no longer available.' }));
      return;
    }
    var variant = findVariant_(product, line.color);
    if (!variant) {
      problems.push(Object.assign(where, { reason: 'color_unavailable',
        message: '"' + product.name + '" is no longer available in ' + line.color + '.' }));
      return;
    }
    if (!variant.sizes[line.size]) {
      problems.push(Object.assign(where, { color: variant.color, reason: 'size_unavailable',
        message: '"' + product.name + '" in ' + variant.color + ', size ' + line.size + ' is out of stock.' }));
      return;
    }
    if (line.expectedPrice !== null && toCents_(line.expectedPrice) !== toCents_(product.price)) {
      problems.push(Object.assign(where, { color: variant.color, reason: 'price_changed', price: product.price,
        message: 'The price of "' + product.name + '" has changed to ' + formatMoney_(product.price) + '.' }));
      return;
    }
    var unitCents = toCents_(product.price);
    priced.push({
      productId: product.id,
      name: product.name,
      color: variant.color,
      size: line.size,
      quantity: line.quantity,
      unitPrice: unitCents / 100,
      lineTotal: unitCents * line.quantity / 100
    });
  });

  if (problems.length) {
    throw new StoreError_(problems.length === 1 ? problems[0].message
      : 'Some items in your cart have changed. Please review your cart.', 'CART_CHANGED', { problems: problems });
  }
  var totalCents = priced.reduce(function (sum, p) { return sum + toCents_(p.unitPrice) * p.quantity; }, 0);
  return { items: priced, total: totalCents / 100 };
}

function toCents_(amount) {
  return Math.round(Number(amount) * 100);
}

function formatMoney_(amount) {
  // Matches the website's Intl output for English locales, e.g. "EGP 1,299.50", "€29.99".
  var symbols = { EUR: '€', USD: '$', GBP: '£' };
  var parts = (toCents_(amount) / 100).toFixed(2).split('.');
  var fixed = parts[0].replace(/\B(?=(\d{3})+$)/g, ',') + '.' + parts[1];
  return (symbols[CONFIG.CURRENCY] || CONFIG.CURRENCY + ' ') + fixed;
}

/* ------------------------------------------------------------------ *
 * Spreadsheet helpers
 * ------------------------------------------------------------------ */

/**
 * Customer text is written with a leading apostrophe. Sheets hides the
 * apostrophe and stores the rest as literal text, which blocks formula
 * injection (=, +, -, @) and stops phone numbers losing leading zeros.
 */
function asSheetText_(value) {
  return "'" + String(value);
}

function formatCartItems_(items) {
  return items.map(function (i) {
    return i.productId + ' | ' + i.name + ' | ' + i.color + ' | ' + i.size + ' | Qty: ' + i.quantity;
  }).join('\n');
}

function existingOrderIds_(sheet) {
  var lastRow = sheet.getLastRow();
  var ids = {};
  if (lastRow < 2) return ids;
  sheet.getRange(2, 2, lastRow - 1, 1).getDisplayValues().forEach(function (r) {
    var id = String(r[0]).trim().replace(/^'/, '');
    if (/^\d{1,5}$/.test(id)) ids[('00000' + id).slice(-5)] = true;
  });
  return ids;
}

/** A random, unused five-digit ID ("00000"–"99999"). Must be called while holding the script lock. */
function generateOrderId_(sheet) {
  var used = existingOrderIds_(sheet);
  var usedCount = Object.keys(used).length;
  if (usedCount >= 100000) throw new StoreError_('No order numbers are left. Please contact the store.', 'IDS_EXHAUSTED');
  for (var attempt = 0; attempt < 50; attempt++) {
    var id = ('00000' + Math.floor(Math.random() * 100000)).slice(-5);
    if (!used[id]) return id;
  }
  // Extremely full sheet: walk forward from a random start to the next free number.
  var start = Math.floor(Math.random() * 100000);
  for (var n = 0; n < 100000; n++) {
    var candidate = ('00000' + ((start + n) % 100000)).slice(-5);
    if (!used[candidate]) return candidate;
  }
  throw new StoreError_('No order numbers are left. Please contact the store.', 'IDS_EXHAUSTED');
}

function appendOrderRow_(sheet, order) {
  var row = sheet.getLastRow() + 1;
  // Order ID is plain text ("@") so leading zeros survive. Customer columns keep the
  // automatic format so the apostrophe prefix is treated as a text marker and hidden.
  sheet.getRange(row, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange(row, 2).setNumberFormat('@');
  sheet.getRange(row, 8).setNumberFormat('0.00');
  sheet.getRange(row, 1, 1, CONFIG.ORDER_HEADERS.length).setValues([[
    order.timestamp,
    order.orderId,
    asSheetText_(order.customer.name),
    asSheetText_(order.customer.phone),
    asSheetText_(order.customer.email),
    asSheetText_(order.customer.address),
    asSheetText_(formatCartItems_(order.items)),
    order.total,
    CONFIG.DEFAULT_ORDER_STATUS
  ]]);
  return row;
}

/* ------------------------------------------------------------------ *
 * Idempotency and rate limiting (CacheService)
 * ------------------------------------------------------------------ */

function cacheKey_(prefix, value) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8);
  return prefix + ':' + Utilities.base64EncodeWebSafe(digest);
}

function cachedResult_(cache, idempotencyKey) {
  if (!idempotencyKey) return null;
  try {
    var hit = cache.get(cacheKey_('order', idempotencyKey));
    return hit ? JSON.parse(hit) : null;
  } catch (err) {
    return null;
  }
}

function hourBucket_() {
  return Math.floor(Date.now() / 3600000);
}

function checkRateLimits_(cache, email) {
  var R = CONFIG.RATE_LIMITS;
  var bucket = hourBucket_();
  var perEmail = Number(cache.get(cacheKey_('rl-email-' + bucket, email)) || 0);
  var total = Number(cache.get('rl-total:' + bucket) || 0);
  if (perEmail >= R.ORDERS_PER_EMAIL_PER_HOUR || total >= R.ORDERS_PER_HOUR_TOTAL) {
    throw new StoreError_('We are receiving a lot of orders right now. Please try again later or contact us directly.', 'RATE_LIMITED');
  }
}

function recordRateLimits_(cache, email) {
  var bucket = hourBucket_();
  var emailKey = cacheKey_('rl-email-' + bucket, email);
  cache.put(emailKey, String(Number(cache.get(emailKey) || 0) + 1), 3700);
  cache.put('rl-total:' + bucket, String(Number(cache.get('rl-total:' + bucket) || 0) + 1), 3700);
}

/* ------------------------------------------------------------------ *
 * Pipeline
 * ------------------------------------------------------------------ */

/**
 * The single order pipeline. Never throws: always returns
 * { success: true, orderId, total, message } or { success: false, code, message, ... }.
 */
function processOrder_(orderData) {
  try {
    return processOrderUnsafe_(orderData);
  } catch (err) {
    if (err instanceof StoreError_) {
      var failure = { success: false, code: err.code, message: err.message };
      Object.keys(err.extra).forEach(function (k) { failure[k] = err.extra[k]; });
      return failure;
    }
    console.error('Order processing failed: ' + (err && err.stack || err));
    return { success: false, code: 'SERVER_ERROR', retryable: true,
      message: 'Something went wrong on our side and your order was not placed. Please try again.' };
  }
}

function processOrderUnsafe_(orderData) {
  if (!orderData || typeof orderData !== 'object' || Array.isArray(orderData)) {
    throw new StoreError_('Invalid order request.', 'INVALID_REQUEST');
  }

  // Honeypot: a hidden field that people never fill in but naive bots do.
  if (orderData.website) {
    throw new StoreError_('Your order could not be submitted.', 'REJECTED');
  }

  var idempotencyKey = orderData.idempotencyKey == null ? '' : String(orderData.idempotencyKey);
  if (idempotencyKey && !/^[A-Za-z0-9_-]{16,64}$/.test(idempotencyKey)) {
    throw new StoreError_('Invalid order request.', 'INVALID_REQUEST');
  }

  var customer = validateCustomer_(orderData.customer);
  if (!customer.valid) {
    throw new StoreError_('Please correct the highlighted fields.', 'VALIDATION', { fieldErrors: customer.errors });
  }
  var lines = validateItems_(orderData.items);

  var cache = CacheService.getScriptCache();
  var previous = cachedResult_(cache, idempotencyKey);
  if (previous) return previous;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    throw new StoreError_('The store is busy right now. Please try again in a moment.', 'BUSY', { retryable: true });
  }

  var saved;
  try {
    // Re-check inside the lock: a concurrent duplicate may have just finished.
    previous = cachedResult_(cache, idempotencyKey);
    if (previous) return previous;

    checkRateLimits_(cache, customer.values.email);

    var pricing = priceItems_(lines, readCatalog_().products);
    var sheet = getSheet_(CONFIG.SHEETS.ORDERS);
    assertHeaders_(sheet, CONFIG.ORDER_HEADERS);

    saved = {
      orderId: generateOrderId_(sheet),
      timestamp: new Date(),
      customer: customer.values,
      items: pricing.items,
      total: pricing.total
    };
    saved.row = appendOrderRow_(sheet, saved);
    SpreadsheetApp.flush();

    var response = {
      success: true,
      orderId: saved.orderId,
      total: saved.total,
      currency: CONFIG.CURRENCY,
      message: 'Order reserved successfully'
    };
    try {
      if (idempotencyKey) {
        cache.put(cacheKey_('order', idempotencyKey), JSON.stringify(response), CONFIG.IDEMPOTENCY_TTL_SECONDS);
      }
      recordRateLimits_(cache, customer.values.email);
    } catch (cacheErr) {
      console.warn('Cache write failed for order ' + saved.orderId + ': ' + cacheErr);
    }
  } finally {
    lock.releaseLock();
  }

  // The order is saved. Email problems are recorded but never turn this into a failure,
  // otherwise the customer would be invited to submit the same order again.
  notifyOwnerSafely_(saved, sheet);
  return response;
}

