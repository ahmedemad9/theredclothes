/**
 * Code.gs — web app entry points and the public server API.
 *
 * Every top-level function without a trailing underscore can be called from the
 * browser through google.script.run. Only getProducts and submitOrder are meant
 * for customers; the owner utilities at the bottom refuse to run for anyone but
 * the script owner.
 */

function doGet(e) {
  var action = e && e.parameter && e.parameter.action;
  if (action === 'products') return jsonOutput_(getProducts());
  // Public settings for a frontend hosted elsewhere (Cloudflare Pages); the same
  // object this page embeds below, so nothing private is exposed.
  if (action === 'config') return jsonOutput_({ success: true, config: getPublicConfig_() });

  var template = HtmlService.createTemplateFromFile('Index');
  // "<" is escaped so the JSON can sit safely inside a <script> tag.
  template.configJson = JSON.stringify(getPublicConfig_()).replace(/</g, '\\u003c');
  template.storeName = CONFIG.STORE_NAME;
var page = template.evaluate()
    .setTitle(CONFIG.STORE_NAME + ' — Shop')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
 var favicon = faviconUrl_(CONFIG.FAVICON_URL);
   if (favicon) {
    try {
      page.setFaviconUrl(favicon);
    } catch (err) {   // a rejected link must never take the shop down
      console.warn('FAVICON_URL ignored: ' + (err && err.message || err));
    }
  }
  return page;
}

/**
 * FAVICON_URL as a direct image link. A Drive share link opens a viewer page, so it
 * is rewritten to the file's direct download link; "format=png" makes the link end in
 * an image extension, which setFaviconUrl expects.
 */
function faviconUrl_(value) {
  var url = assetUrl_(value);
  var m = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([A-Za-z0-9_-]{10,})/);
  return m ? 'https://drive.google.com/uc?id=' + m[1] + '&export=download&format=png' : url;
}

/** Used by Index.html to pull in Styles, Logic, Api and Scripts. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** Public: the current catalog, read fresh from the Products tab on every call. */
function getProducts() {
  try {
    var catalog = readCatalog_();
    if (catalog.problems.length) console.warn('Catalog problems:\n' + catalog.problems.join('\n'));
    return { success: true, products: catalog.products, currency: CONFIG.CURRENCY,
      sizes: SIZE_COLUMNS.slice(), swatches: COLOR_SWATCHES };
  } catch (err) {
    console.error('getProducts failed: ' + (err && err.stack || err.message || err));
    return { success: false, message: 'The product catalog is unavailable right now. Please try again shortly.' };
  }
}

/** Public: called by the storefront through google.script.run. */
function submitOrder(orderData) {
  return processOrder_(orderData);
}

/**
 * JSON order endpoint, used server-side by the Cloudflare Pages Functions
 * (cloudflare/functions/api/orders.js) and by other integrations. Same pipeline as
 * submitOrder: { "customer": {...}, "items": [{ "productId", "color", "size", "quantity",
 * "unitPrice" }], "idempotencyKey": "..." }.
 * If the WEBHOOK_SECRET script property is set, the body must also include "secret".
 */
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e && e.postData && e.postData.contents || '');
  } catch (err) {
    return jsonOutput_({ success: false, code: 'INVALID_REQUEST', message: 'Request body must be JSON.' });
  }
  var secret = getProp_(PROPS.WEBHOOK_SECRET);
  if (secret && !(body && typeof body.secret === 'string' && sameSecret_(body.secret, secret))) {
    return jsonOutput_({ success: false, code: 'UNAUTHORIZED', message: 'Invalid webhook secret.' });
  }
  if (body && typeof body === 'object') delete body.secret;
  return jsonOutput_(processOrder_(body));
}

/** Compares in time that does not depend on where the strings differ. */
function sameSecret_(given, expected) {
  if (given.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function jsonOutput_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ *
 * Owner utilities — run these from the Apps Script editor (Run ▶).
 * ------------------------------------------------------------------ */

function assertOwner_() {
  var active = '';
  try { active = Session.getActiveUser().getEmail(); } catch (err) { active = ''; }
  var owner = Session.getEffectiveUser().getEmail();
  if (!active || active !== owner) throw new Error('Only the store owner can run this function.');
}

/**
 * Creates the Products and Orders tabs with the exact headers if they are
 * missing, adds sample products to an empty Products tab, and formats Orders.
 * Safe to run more than once; it never deletes or overwrites existing data.
 */
function setupSpreadsheet() {
  assertOwner_();
  var ss = getSpreadsheet_();
  var sheets = ss.getSheets();

  // A brand-new spreadsheet has one empty "Sheet1": reuse it as Products.
  if (!ss.getSheetByName(CONFIG.SHEETS.PRODUCTS) && sheets.length === 1 && sheets[0].getLastRow() === 0) {
    sheets[0].setName(CONFIG.SHEETS.PRODUCTS);
  }

  // Only an EMPTY Products tab is filled in. Existing data — including the old
  // format — is never changed here; see previewProductsMigration().
  var products = ss.getSheetByName(CONFIG.SHEETS.PRODUCTS) || ss.insertSheet(CONFIG.SHEETS.PRODUCTS);
  if (products.getLastRow() === 0) {
    products.getRange(1, 1, 1, PRODUCT_HEADERS_V2.length).setValues([PRODUCT_HEADERS_V2]);
    products.getRange(2, 1, 4, PRODUCT_HEADERS_V2.length).setValues([
      ['P001', 'Classic Hoodie', 'Cotton hoodie', 29.99, 'Hoodies', 'Red', '', 1, 1, 0, 0, 1],
      ['P001', 'Classic Hoodie', 'Cotton hoodie', 29.99, 'Hoodies', 'Blue', '', 1, 1, 1, 1, 1],
      ['P001', 'Classic Hoodie', 'Cotton hoodie', 29.99, 'Hoodies', 'Green', '', 0, 0, 1, 1, 0],
      ['P002', 'Printed T-Shirt', 'Printed cotton shirt', 19.99, 'Printed', 'Black', '', 1, 1, 1, 0, 0]
    ]);
  }
  products.setFrozenRows(1);
  var productsNote = '';
  try {
    productHeaderMap_(products);
  } catch (err) {
    productsNote = ' Products tab: ' + err.message;
  }

  var orders = ss.getSheetByName(CONFIG.SHEETS.ORDERS) || ss.insertSheet(CONFIG.SHEETS.ORDERS);
  if (orders.getLastRow() === 0) {
    orders.getRange(1, 1, 1, CONFIG.ORDER_HEADERS.length).setValues([CONFIG.ORDER_HEADERS]);
  }
  orders.setFrozenRows(1);
  var maxRows = orders.getMaxRows();
  if (maxRows > 1) {
    orders.getRange(2, 2, maxRows - 1, 1).setNumberFormat('@');
    var statuses = SpreadsheetApp.newDataValidation()
      .requireValueInList(['Pending', 'Confirmed', 'Paid', 'Shipped', 'Delivered', 'Cancelled'], true)
      .setAllowInvalid(true)
      .build();
    orders.getRange(2, 9, maxRows - 1, 1).setDataValidation(statuses);
  }

  assertHeaders_(orders, CONFIG.ORDER_HEADERS);
  var extra = ss.getSheets().map(function (s) { return s.getName(); })
    .filter(function (n) { return n !== CONFIG.SHEETS.PRODUCTS && n !== CONFIG.SHEETS.ORDERS; });
  var summary = 'Spreadsheet ready: "' + ss.getName() + '".' + productsNote +
    (extra.length ? ' Note: the store only uses Products and Orders; other tabs are ignored: ' + extra.join(', ') : '');
  console.log(summary);
  return summary;
}

/** Lists catalog rows the website is hiding or cannot sell, with the reason. */
function checkCatalog() {
  assertOwner_();
  var catalog = readCatalog_();
  var report = catalog.products.length + ' products loaded.\n' +
    (catalog.problems.length ? catalog.problems.join('\n') : 'No problems found.');
  console.log(report);
  return report;
}

/**
 * Read-only migration helper for the old Products format (Name, Price, Image Link,
 * Description, Category, Sizes Available, In Stock). Writes NOTHING: it logs the
 * converted rows as CSV, which you review and paste in yourself (README → "Migrating
 * the Products tab").
 */
function previewProductsMigration() {
  assertOwner_();
  var sheet = getSheet_(CONFIG.SHEETS.PRODUCTS);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1) return 'The Products tab is empty — nothing to convert.';
  var rows = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  if (!isLegacyProductsSheet_(rows[0])) return 'The Products tab already uses the new format — nothing to convert.';
  var result = convertLegacyProductRows_(rows);
  var report = 'Converted ' + (result.rows.length - 1) + ' products. Nothing in the spreadsheet was changed.\n' +
    'Each product got colour "Standard" — rename it and add one row per extra colour.\n' +
    (result.notes.length ? result.notes.join('\n') + '\n' : '') + '\n' + toCsv_(result.rows);
  console.log(report);
  return report;
}

/** Sends a sample order email to the notification address (no order is saved). */
function sendTestEmail() {
  assertOwner_();
  var sample = {
    orderId: '00000',
    customer: { name: 'Test Customer', phone: '+353 87 123 4567', email: Session.getEffectiveUser().getEmail(),
      address: '1 Example Street\nDublin D01 F5P2\nIreland' },
    items: [{ productId: 'P001', name: 'Sample T-Shirt', color: 'Blue', size: 'M', quantity: 2, unitPrice: 19.99, lineTotal: 39.98 }],
    total: 39.98
  };
  var email = buildOrderEmail_(sample);
  MailApp.sendEmail({ to: notificationRecipient_(), subject: '[TEST] ' + email.subject,
    body: email.body, htmlBody: email.htmlBody });
  var message = 'Test email sent to ' + notificationRecipient_() +
    '. Remaining daily quota: ' + MailApp.getRemainingDailyQuota();
  console.log(message);
  return message;
}
function testFavicon() {
  var url = faviconUrl_(CONFIG.FAVICON_URL);
  console.log('Icon link used: ' + (url || '(empty — FAVICON_URL not set)'));
  HtmlService.createHtmlOutput('test').setFaviconUrl(url);
  console.log('Google accepted the icon link.');
}
