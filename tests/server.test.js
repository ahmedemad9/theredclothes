/**
 * Backend tests: Products.gs, Orders.gs, Email.gs, Code.gs against gas-mocks.js.
 */

var HEADER = ['Product ID', 'Name', 'Description', 'Price', 'Category', 'Color', 'Image Link', 'S', 'M', 'L', 'XL', 'XXL'];
var PRODUCT_ROWS = [
  HEADER,
  ['P001', 'Classic Hoodie', 'Cotton hoodie', 29.99, 'Hoodies', 'Red', 'https://example.com/red.jpg', 1, 1, 0, 0, 1],
  ['P001', 'Classic Hoodie', 'Cotton hoodie', 29.99, 'Hoodies', 'Blue', 'https://example.com/blue.jpg', 1, 1, 1, 1, 1],
  ['P001', 'Classic Hoodie', 'Cotton hoodie', 29.99, 'Hoodies', 'Green', 'https://example.com/green.jpg', 0, 0, 1, 1, 0],
  ['P002', 'Printed T-Shirt', 'Printed cotton shirt', '19.99', 'Printed', 'Black', 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing', '1', ' 1 ', 1, 0, ''],
  ['', '', '', '', '', '', '', '', '', '', '', ''],
  ['P003', 'Sold Out Tee', 'Gone', 15, 'T-Shirts', 'White', 'https://example.com/white.jpg', 0, 0, 0, 0, 0],
  ['P004', 'Two Tone Shirt', 'One colour sold out', 24.99, 'Shirt', 'Navy', 'https://example.com/navy.jpg', 0, 0, 0, 0, 0],
  ['P004', 'Two Tone Shirt', 'One colour sold out', 24.99, 'Shirt', 'Sand', 'https://example.com/sand.jpg', 0, 1, 0, 0, 0]
];
var ORDER_HEADER_ROW = [['Timestamp', 'Order ID', 'Customer Name', 'Phone', 'Email', 'Shipping Address', 'Cart Items', 'Total Price', 'Order Status']];

function freshStore(extraProducts, base) {
  resetMocks({ sheets: { Products: (base || PRODUCT_ROWS).concat(extraProducts || []), Orders: ORDER_HEADER_ROW } });
}

function validOrder(overrides) {
  var o = {
    customer: { name: 'Jane Doe', phone: '+353 87 123 4567', email: 'Jane@Example.com', address: '12 Main Street\nDublin D02 XY12\nIreland' },
    items: [
      { productId: 'P001', color: 'Blue', size: 'L', quantity: 2, unitPrice: 29.99 },
      { productId: 'P002', color: 'Black', size: 'S', quantity: 1, unitPrice: 19.99 }
    ],
    idempotencyKey: 'abcdef0123456789abcdef0123456789'
  };
  Object.keys(overrides || {}).forEach(function (k) { o[k] = overrides[k]; });
  return o;
}

function item(productId, color, size, quantity) {
  return { productId: productId, color: color, size: size, quantity: quantity === undefined ? 1 : quantity };
}

function ordersSheet() { return __mock.spreadsheet.getSheetByName('Orders'); }
function productsSheet() { return __mock.spreadsheet.getSheetByName('Products'); }
function byId(products, id) { return products.filter(function (p) { return p.id === id; })[0]; }

var ORIGINAL_RATE_LIMITS = JSON.parse(JSON.stringify(CONFIG.RATE_LIMITS));
function beforeEachTest() {
  CONFIG.RATE_LIMITS = JSON.parse(JSON.stringify(ORIGINAL_RATE_LIMITS));
  freshStore();
}

/* ---------------- Product parsing ---------------- */

test('products: rows sharing a Product ID become one product with colour variants', function () {
  var res = getProducts();
  assert(res.success, JSON.stringify(res));
  assertEqual(res.products.map(function (p) { return p.id; }), ['P001', 'P002', 'P003', 'P004']);
  var hoodie = res.products[0];
  assertEqual(hoodie.name, 'Classic Hoodie');
  assertEqual(hoodie.price, 29.99);
  assertEqual(hoodie.category, 'Hoodies');
  assertEqual(hoodie.variants.map(function (v) { return v.color; }), ['Red', 'Blue', 'Green']);
  assertEqual(hoodie.variants[0], { color: 'Red', imageUrl: 'https://example.com/red.jpg', imageUrl2: '',
    sizes: { S: true, M: true, L: false, XL: false, XXL: true } });
  assertEqual(hoodie.variants[2].sizes, { S: false, M: false, L: true, XL: true, XXL: false });
  assertEqual(res.sizes, ['S', 'M', 'L', 'XL', 'XXL']);
  assertEqual(res.currency, 'EGP');
});

test('products: different Product IDs stay separate; IDs are strings', function () {
  freshStore([['42', 'Numbered Tee', 'x', 10, 'Classic', 'Red', 'https://e.com/a.jpg', 1, 0, 0, 0, 0],
    [42, 'Numbered Tee', 'x', 10, 'Classic', 'Blue', 'https://e.com/b.jpg', 1, 0, 0, 0, 0]]);
  var p = byId(getProducts().products, '42');
  assertEqual(typeof p.id, 'string');
  assertEqual(p.variants.length, 2, 'numeric 42 and text "42" are the same product');
});

test('products: stock cells — 1/"1" available; 0/"0"/empty unavailable; whitespace trimmed', function () {
  var tee = byId(getProducts().products, 'P002');
  assertEqual(tee.variants[0].sizes, { S: true, M: true, L: true, XL: false, XXL: false });
});

test('products: invalid stock values are never available and are reported', function () {
  freshStore([['P009', 'Odd Stock', 'x', 10, 'Classic', 'Red', 'https://e.com/a.jpg', 2, 'yes', true, 'x', -1]]);
  var report = readCatalog_();
  var p = byId(report.products, 'P009');
  assertEqual(p.variants[0].sizes, { S: false, M: false, L: false, XL: false, XXL: false }, 'quantities are not stock flags');
  assertEqual(p.inStock, false);
  assertEqual(report.problems.filter(function (m) { return /P009.*is not 1 or 0/.test(m); }).length, 5);
});

test('products: availability at product and colour level', function () {
  var products = getProducts().products;
  assertEqual(byId(products, 'P001').inStock, true);
  assertEqual(byId(products, 'P003').inStock, false, 'all sizes 0 → product out of stock');
  var two = byId(products, 'P004');
  assertEqual(two.inStock, true, 'one colour available is enough');
  assertEqual(two.variants.length, 2, 'sold-out colour is still listed');
});

test('products: inconsistent Name/Description/Price/Category hides the product and is reported', function () {
  ['Name', 'Description', 'Price', 'Category'].forEach(function (field) {
    var row = ['P010', 'Shared', 'Same text', 20, 'Classic', 'Red', 'https://e.com/r.jpg', 1, 1, 1, 1, 1];
    var other = row.slice();
    other[5] = 'Blue';
    other[HEADER.indexOf(field)] = field === 'Price' ? 21 : 'Different';
    freshStore([row, other]);
    var report = readCatalog_();
    assert(!byId(report.products, 'P010'), field + ' conflict must hide the product');
    assert(report.problems.some(function (m) { return m.indexOf('P010') !== -1 && m.indexOf(field) !== -1; }), field + ' reported');
  });
  // Equivalent formatting is not a conflict.
  freshStore([['P011', 'Same  Name', 'd', '20.00', 'T-Shirts', 'Red', 'https://e.com/r.jpg', 1, 1, 1, 1, 1],
    ['P011', 'Same Name', 'd', 20, 'tshirts', 'Blue', 'https://e.com/b.jpg', 1, 1, 1, 1, 1]]);
  assert(byId(getProducts().products, 'P011'), 'whitespace / number formatting / category spelling are fine');
});

test('products: duplicate Product ID + Color rows hide that colour only', function () {
  freshStore([['P001', 'Classic Hoodie', 'Cotton hoodie', 29.99, 'Hoodies', ' red ', 'https://e.com/other.jpg', 1, 1, 1, 1, 1]]);
  var report = readCatalog_();
  var hoodie = byId(report.products, 'P001');
  assertEqual(hoodie.variants.map(function (v) { return v.color; }), ['Blue', 'Green']);
  assert(report.problems.some(function (m) { return /appears more than once/.test(m); }));
  var res = submitOrder(validOrder({ items: [item('P001', 'Red', 'S')] }));
  assertEqual(res.code, 'CART_CHANGED', 'ambiguous colour cannot be ordered');
});

test('products: image links — http(s) kept, Drive converted, invalid reported and blanked', function () {
  freshStore([['P020', 'Img', 'x', 10, 'Classic', 'Red', 'not a url', 1, 0, 0, 0, 0],
    ['P020', 'Img', 'x', 10, 'Classic', 'Blue', 'ftp://example.com/a.jpg', 1, 0, 0, 0, 0],
    ['P020', 'Img', 'x', 10, 'Classic', 'Teal', '', 1, 0, 0, 0, 0]]);
  var report = readCatalog_();
  assertEqual(byId(report.products, 'P002').variants[0].imageUrl, 'https://drive.google.com/thumbnail?id=1AbCdEfGhIjKlMnOp&sz=w1000');
  var p = byId(report.products, 'P020');
  assertEqual(p.variants.map(function (v) { return v.imageUrl; }), ['', '', '']);
  assertEqual(report.problems.filter(function (m) { return /P020/.test(m); }).length, 3);
});

test('products: rows without Product ID or Color are ignored and reported', function () {
  freshStore([['', 'No ID', 'x', 10, 'Classic', 'Red', '', 1, 1, 1, 1, 1], ['P030', 'No Colour', 'x', 10, 'Classic', '', '', 1, 1, 1, 1, 1]]);
  var report = readCatalog_();
  assert(!byId(report.products, 'P030'));
  assert(report.problems.some(function (m) { return /missing Product ID/.test(m); }));
  assert(report.problems.some(function (m) { return /missing Color/.test(m); }));
});

test('products: columns are found by header name, not position', function () {
  var shuffled = [['Color', 'S', 'M', 'L', 'XL', 'XXL', 'Image Link', 'Category', 'Price', 'Description', 'Name', 'Product ID', 'Notes'],
    ['Red', 1, 0, 0, 0, 0, 'https://e.com/r.jpg', 'Hoodies', 30, 'Desc', 'Moved Hoodie', 'H1', 'owner note']];
  freshStore([], shuffled);
  var p = getProducts().products[0];
  assertEqual([p.id, p.name, p.price, p.variants[0].color, p.variants[0].sizes.S, p.variants[0].sizes.M], ['H1', 'Moved Hoodie', 30, 'Red', true, false]);
});

test('products: old format and missing headers give a clear error, not a broken store', function () {
  resetMocks({ sheets: { Products: [['Name', 'Price', 'Image Link', 'Description', 'Category', 'Sizes Available', 'In Stock'],
    ['Old Tee', 10, '', 'x', 'Classic', 'S,M', 'Yes']], Orders: ORDER_HEADER_ROW } });
  assertEqual(getProducts().success, false);
  assertThrows(function () { readCatalog_(); }, /old format/);
  resetMocks({ sheets: { Products: [['Product ID', 'Name', 'Price']], Orders: ORDER_HEADER_ROW } });
  assertThrows(function () { readCatalog_(); }, /missing these column headers: Description, Category, Color, Image Link, S, M, L, XL, XXL/);
  resetMocks({ sheets: { Orders: ORDER_HEADER_ROW } });
  assertEqual(getProducts().success, false);
});

test('products: reflects sheet edits on the next fetch and never writes', function () {
  var before = JSON.stringify(productsSheet().cells);
  getProducts(); getProducts();
  assertEqual(JSON.stringify(productsSheet().cells), before, 'read-only');
  productsSheet().getRange(3, 10).setValue(0); // Blue L → 0
  assertEqual(byId(getProducts().products, 'P001').variants[1].sizes.L, false);
});

/* ---------------- Orders: happy path ---------------- */

test('orders: valid order is saved to the exact Orders columns with Pending status', function () {
  var res = submitOrder(validOrder());
  assert(res.success, JSON.stringify(res));
  assert(/^\d{5}$/.test(res.orderId), 'five digits');
  assertEqual(res.total, 79.97);
  assertEqual(res.message, 'Order reserved successfully');

  var sheet = ordersSheet();
  assertEqual(sheet.getLastRow(), 2);
  var row = sheet.row(2);
  assertEqual(row.length, 9, 'nine columns');
  assert(row[0] instanceof Date, 'timestamp');
  assertEqual(row[1], res.orderId, 'order id stored as text');
  assertEqual(row[2], 'Jane Doe');
  assertEqual(row[3], '+353 87 123 4567');
  assertEqual(row[4], 'jane@example.com');
  assertEqual(row[5], '12 Main Street\nDublin D02 XY12\nIreland');
  assertEqual(row[6], 'P001 | Classic Hoodie | Blue | L | Qty: 2\nP002 | Printed T-Shirt | Black | S | Qty: 1');
  assertEqual(row[7], 79.97);
  assertEqual(row[8], 'Pending');
  assertEqual(sheet.formulaInjections, []);
  assert(!__mock.lockHeld, 'lock released');
});

test('orders: reservations never change stock cells', function () {
  var before = JSON.stringify(productsSheet().cells);
  CONFIG.RATE_LIMITS.ORDERS_PER_EMAIL_PER_HOUR = 100;
  for (var i = 0; i < 5; i++) {
    assert(submitOrder(validOrder({ idempotencyKey: 'stockunchanged00' + i, items: [item('P001', 'Red', 'M', 10)] })).success);
  }
  assertEqual(JSON.stringify(productsSheet().cells), before, 'Products tab untouched');
  assert(byId(getProducts().products, 'P001').variants[0].sizes.M, 'Red M still available — stock is managed by hand');
});

test('orders: same product in different colours and sizes stay separate lines; duplicates merge', function () {
  var res = submitOrder(validOrder({ items: [item('P001', 'Red', 'M', 1), item('P001', 'Blue', 'M', 2), item('P001', 'Red', 'S', 1), item('P001', 'red', 'm', 1)] }));
  assert(res.success, JSON.stringify(res));
  assertEqual(ordersSheet().row(2)[6], 'P001 | Classic Hoodie | Red | M | Qty: 2\nP001 | Classic Hoodie | Blue | M | Qty: 2\nP001 | Classic Hoodie | Red | S | Qty: 1');
  assertEqual(res.total, 149.95);
});

test('orders: Product ID, colour and size matching is case-insensitive but stores canonical values', function () {
  var res = submitOrder(validOrder({ items: [item(' p001 ', ' BLUE ', 'xxl', 1)] }));
  assert(res.success, JSON.stringify(res));
  assertEqual(ordersSheet().row(2)[6], 'P001 | Classic Hoodie | Blue | XXL | Qty: 1');
});

test('orders: order IDs keep leading zeros', function () {
  var orig = Math.random;
  Math.random = function () { return 0.04729; };
  try {
    var res = submitOrder(validOrder());
    assertEqual(res.orderId, '04729');
    assertEqual(ordersSheet().row(2)[1], '04729');
    assertEqual(ordersSheet().getRange(2, 2).getDisplayValues()[0][0], '04729');
  } finally { Math.random = orig; }
});

test('orders: totals use sheet prices, never browser prices', function () {
  var res = submitOrder(validOrder({ items: [item('P001', 'Blue', 'S', 3)] }));
  assertEqual(res.total, 89.97);
  var tampered = submitOrder(validOrder({ idempotencyKey: 'zzzzzzzzzzzzzzzz1', items: [{ productId: 'P001', color: 'Blue', size: 'S', quantity: 1, unitPrice: 0.01 }] }));
  assertEqual(tampered.success, false);
  assertEqual(tampered.code, 'CART_CHANGED');
  assertEqual(tampered.problems[0].reason, 'price_changed');
  assertEqual(tampered.problems[0].price, 29.99);
  assertEqual(ordersSheet().getLastRow(), 2, 'only the honest order saved');
});

test('orders: floating point totals are exact to the cent', function () {
  freshStore([['C1', 'Cheap Tee', 'x', 0.1, 'Classic', 'Red', '', 1, 1, 1, 1, 1], ['C2', 'Odd Tee', 'x', 0.2, 'Classic', 'Red', '', 1, 1, 1, 1, 1]]);
  var res = submitOrder(validOrder({ items: [item('C1', 'Red', 'M'), item('C2', 'Red', 'M')] }));
  assertEqual(res.total, 0.3);
});

/* ---------------- Orders: rejection ---------------- */

test('orders: unknown product, unknown colour, unavailable size and sold-out colour are rejected', function () {
  var cases = [
    [item('P999', 'Red', 'M'), 'not_found'],
    [item('P001', 'Purple', 'M'), 'color_unavailable'],
    [item('P001', 'Red', 'L'), 'size_unavailable'],          // Red L = 0
    [item('P001', 'Green', 'S'), 'size_unavailable'],        // Green S = 0
    [item('P004', 'Navy', 'M'), 'size_unavailable'],         // colour fully sold out
    [item('P003', 'White', 'S'), 'size_unavailable'],        // product fully sold out
    [item('P002', 'Black', 'XXL'), 'size_unavailable']       // empty cell
  ];
  cases.forEach(function (c, i) {
    var res = submitOrder(validOrder({ idempotencyKey: 'rejectcase000000' + i, items: [c[0]] }));
    assertEqual(res.success, false, JSON.stringify(c[0]));
    assertEqual(res.code, 'CART_CHANGED', JSON.stringify(c[0]));
    assertEqual(res.problems[0].reason, c[1], JSON.stringify(c[0]));
  });
  assertEqual(ordersSheet().getLastRow(), 1, 'nothing saved');
  assertEqual(__mock.sentEmails.length, 0, 'no email');
});

test('orders: available size in the same product but another colour is still accepted', function () {
  assert(submitOrder(validOrder({ items: [item('P001', 'Blue', 'L')] })).success, 'Blue L = 1 although Red L = 0');
  assert(submitOrder(validOrder({ idempotencyKey: 'sandmediumonly000', items: [item('P004', 'Sand', 'M')] })).success);
});

test('orders: one bad line rejects the whole order and lists every problem', function () {
  var res = submitOrder(validOrder({ items: [item('P001', 'Blue', 'L'), item('P001', 'Red', 'L'), item('P999', 'Red', 'S')] }));
  assertEqual(res.code, 'CART_CHANGED');
  assertEqual(res.problems.map(function (p) { return p.reason; }), ['size_unavailable', 'not_found']);
  assertEqual(res.problems[0].productId, 'P001');
  assertEqual(res.problems[0].color, 'Red');
  assertEqual(res.problems[0].size, 'L');
  assertEqual(ordersSheet().getLastRow(), 1);
});

test('orders: items in the old format (name only) or with unknown sizes are rejected', function () {
  assertEqual(submitOrder(validOrder({ items: [{ name: 'Classic Hoodie', size: 'M', quantity: 1 }] })).code, 'INVALID_CART');
  assertEqual(submitOrder(validOrder({ items: [item('P001', 'Red', 'XS')] })).code, 'INVALID_CART');
  assertEqual(submitOrder(validOrder({ items: [item('P001', '', 'M')] })).code, 'INVALID_CART');
  assertEqual(submitOrder(validOrder({ items: [item(new Array(60).join('x'), 'Red', 'M')] })).code, 'INVALID_CART');
});

test('orders: empty cart, bad quantities and oversized carts are rejected', function () {
  assertEqual(submitOrder(validOrder({ items: [] })).code, 'EMPTY_CART');
  assertEqual(submitOrder(validOrder({ items: 'nope' })).code, 'EMPTY_CART');
  [0, -1, 1.5, 11, 'two', null].forEach(function (q) {
    assertEqual(submitOrder(validOrder({ items: [item('P001', 'Blue', 'M', q)] })).code, 'INVALID_CART', 'qty ' + q);
  });
  var many = [];
  for (var i = 0; i < 21; i++) many.push(item('X' + i, 'Red', 'M'));
  assertEqual(submitOrder(validOrder({ items: many })).code, 'INVALID_CART', 'too many lines');
  var bulky = ['S', 'M', 'L', 'XL', 'XXL'].map(function (s) { return item('P001', 'Blue', s, 10); }).concat([item('P002', 'Black', 'S', 1)]);
  assertEqual(submitOrder(validOrder({ items: bulky })).code, 'INVALID_CART', 'too many units');
  assertEqual(submitOrder(validOrder({ items: [item('P001', 'Blue', 'M', 6), item('P001', 'blue', 'M', 5)] })).code, 'INVALID_CART', 'merged line over limit');
  assertEqual(ordersSheet().getLastRow(), 1);
});

test('orders: customer validation rejects bad input with field errors', function () {
  var bad = [
    [{ name: '' }, 'name'], [{ name: '   ' }, 'name'], [{ name: '123' }, 'name'], [{ name: new Array(102).join('a') }, 'name'],
    [{ phone: '' }, 'phone'], [{ phone: 'call me' }, 'phone'], [{ phone: '123' }, 'phone'], [{ phone: '0000000000' }, 'phone'],
    [{ phone: '+1 234 567 890 123 456 7' }, 'phone'], [{ phone: '12+3456789' }, 'phone'],
    [{ email: '' }, 'email'], [{ email: 'jane' }, 'email'], [{ email: 'jane@example' }, 'email'], [{ email: 'jane@@example.com' }, 'email'],
    [{ email: 'jane..doe@example.com' }, 'email'], [{ email: 'jane doe@example.com' }, 'email'],
    [{ address: '' }, 'address'], [{ address: 'Dublin' }, 'address'], [{ address: '1234567890 12' }, 'address'],
    [{ address: new Array(502).join('a b ') }, 'address']
  ];
  bad.forEach(function (c) {
    var customer = Object.assign({}, validOrder().customer, c[0]);
    var res = submitOrder(validOrder({ customer: customer }));
    assertEqual(res.code, 'VALIDATION', JSON.stringify(c[0]));
    assert(res.fieldErrors[c[1]], 'field error for ' + c[1] + ' / ' + JSON.stringify(c[0]));
  });
  assertEqual(submitOrder(validOrder({ customer: null })).code, 'VALIDATION');
  assertEqual(ordersSheet().getLastRow(), 1);
});

test('orders: accepts reasonable international phone formats and unicode names', function () {
  ['+20 10 1234 5678', '010 1234 5678', '(555) 123-4567', '+44 20 7946 0958', '+49-30-1234567', '0049.30.1234567'].forEach(function (phone, i) {
    CONFIG.RATE_LIMITS.ORDERS_PER_EMAIL_PER_HOUR = 100;
    var customer = Object.assign({}, validOrder().customer, { phone: phone, name: 'Zoë Ó\'Brien-Łukasz ' + i });
    var res = submitOrder(validOrder({ customer: customer, idempotencyKey: 'phoneformatkey00' + i }));
    assert(res.success, phone + ' ' + JSON.stringify(res));
  });
});

test('orders: invalid request shapes and honeypot are rejected', function () {
  [null, undefined, 'x', 42, []].forEach(function (v) { assertEqual(submitOrder(v).success, false); });
  assertEqual(submitOrder(validOrder({ idempotencyKey: 'short' })).code, 'INVALID_REQUEST');
  assertEqual(submitOrder(validOrder({ idempotencyKey: '<script>alert(1)</script>xxxx' })).code, 'INVALID_REQUEST');
  assertEqual(submitOrder(validOrder({ website: 'http://spam.example' })).success, false);
  assertEqual(ordersSheet().getLastRow(), 1);
});

/* ---------------- Security ---------------- */

test('security: customer input cannot inject spreadsheet formulas', function () {
  var payloads = ['=IMPORTXML("http://evil","//a")', '+SUM(1,2)', '-2+3', '@foo', '=HYPERLINK("http://evil","x")'];
  payloads.forEach(function (p, i) {
    var res = submitOrder(validOrder({
      idempotencyKey: 'injectionkey0000' + i,
      customer: { name: p + ' Smith', phone: '+353 87 123 456' + i, email: 'x' + i + '@example.com', address: p + '\n=1+1 Main Street, Dublin' }
    }));
    assert(res.success, JSON.stringify(res));
    var row = ordersSheet().row(ordersSheet().getLastRow());
    assertEqual(row[2], p + ' Smith', 'name stored literally');
    assertEqual(row[5], p + '\n=1+1 Main Street, Dublin', 'address stored literally');
  });
  assertEqual(ordersSheet().formulaInjections, [], 'no formulas created');
});

test('security: a product ID or colour that looks like a formula is stored as text', function () {
  freshStore([['=1+1', 'Formula Tee', 'x', 10, 'Classic', '+Red', '', 1, 1, 1, 1, 1]]);
  var res = submitOrder(validOrder({ items: [item('=1+1', '+Red', 'M')] }));
  assert(res.success, JSON.stringify(res));
  assertEqual(ordersSheet().row(2)[6], '=1+1 | Formula Tee | +Red | M | Qty: 1');
  assertEqual(ordersSheet().formulaInjections, []);
});

test('security: phone numbers keep leading zeros; control characters are stripped', function () {
  var res = submitOrder(validOrder({ customer: Object.assign({}, validOrder().customer, { phone: '01012345678', name: 'Jane\u0000\u0007 Doe' }) }));
  assert(res.success);
  assertEqual(ordersSheet().row(2)[3], '01012345678');
  assertEqual(ordersSheet().row(2)[2], 'Jane Doe');
});

test('security: owner utilities refuse anonymous callers', function () {
  __mock.activeUser = '';
  assertThrows(function () { setupSpreadsheet(); }, /owner/);
  assertThrows(function () { checkCatalog(); }, /owner/);
  assertThrows(function () { sendTestEmail(); }, /owner/);
  assertThrows(function () { previewProductsMigration(); }, /owner/);
  __mock.activeUser = 'someone@else.com';
  assertThrows(function () { checkCatalog(); }, /owner/);
  __mock.activeUser = 'owner@example.com';
  assert(/products loaded/.test(checkCatalog()));
});

test('security: public config and catalog expose no private settings', function () {
  __mock.props = { NOTIFICATION_EMAIL: 'secret-owner@example.com', WEBHOOK_SECRET: 's3cret', SPREADSHEET_ID: 'abc' };
  var json = JSON.stringify(getPublicConfig_()) + JSON.stringify(getProducts());
  assert(json.indexOf('secret-owner') === -1 && json.indexOf('s3cret') === -1 && json.indexOf('"abc"') === -1);
});

/* ---------------- Idempotency, locking, IDs ---------------- */

test('idempotency: resubmitting the same key returns the original order without a new row', function () {
  var first = submitOrder(validOrder());
  var second = submitOrder(validOrder());
  assert(first.success && second.success);
  assertEqual(second.orderId, first.orderId);
  assertEqual(ordersSheet().getLastRow(), 2);
  assertEqual(__mock.sentEmails.length, 1, 'one email');
});

test('idempotency: a duplicate that finishes while we wait for the lock is detected inside the lock', function () {
  var key = 'concurrentdup0000000000000000000';
  __mock.onLockAcquired = function () {
    __mock.cache[cacheKey_('order', key)] = JSON.stringify({ success: true, orderId: '11111', total: 1, message: 'Order reserved successfully' });
    __mock.onLockAcquired = null;
  };
  var res = submitOrder(validOrder({ idempotencyKey: key }));
  assertEqual(res.orderId, '11111');
  assertEqual(ordersSheet().getLastRow(), 1, 'no second row');
  assert(!__mock.lockHeld, 'lock released on early return');
});

test('locking: a busy lock returns a retryable error and saves nothing', function () {
  __mock.lockAvailable = false;
  var res = submitOrder(validOrder());
  assertEqual(res.code, 'BUSY');
  assertEqual(res.retryable, true);
  assertEqual(ordersSheet().getLastRow(), 1);
});

test('locking: stock is checked while holding the lock, and the lock is released after errors', function () {
  var checkedUnderLock = false;
  var original = readCatalog_;
  readCatalog_ = function () { checkedUnderLock = __mock.lockHeld; return original(); };
  try { submitOrder(validOrder()); } finally { readCatalog_ = original; }
  assert(checkedUnderLock, 'catalog read inside the lock');
  var sheet = ordersSheet();
  sheet.getLastRow = function () { throw new Error('boom'); };
  var res = submitOrder(validOrder({ idempotencyKey: 'anotherkey0000000' }));
  assertEqual(res.code, 'SERVER_ERROR');
  assert(!__mock.lockHeld, 'released after error');
});

test('ids: never reuses an existing order ID, even when random picks collide', function () {
  var sheet = ordersSheet();
  sheet.appendRow([new Date(), '00042', 'a', 'b', 'c', 'd', 'e', 1, 'Pending']);
  sheet.getRange(3, 2).setNumberFormat('@');
  sheet.appendRow([new Date(), '00043', 'a', 'b', 'c', 'd', 'e', 1, 'Pending']); // stored as number 43
  var seq = [0.00042, 0.00043, 0.00042, 0.5];
  var orig = Math.random;
  Math.random = function () { return seq.length ? seq.shift() : orig(); };
  try {
    assertEqual(submitOrder(validOrder()).orderId, '50000');
  } finally { Math.random = orig; }
});

test('ids: 300 sequential orders get unique five-digit IDs', function () {
  CONFIG.RATE_LIMITS.ORDERS_PER_EMAIL_PER_HOUR = 1000;
  CONFIG.RATE_LIMITS.ORDERS_PER_HOUR_TOTAL = 1000;
  var seen = {};
  for (var i = 0; i < 300; i++) {
    var res = submitOrder(validOrder({ idempotencyKey: 'bulkorderkey' + ('0000' + i).slice(-5) }));
    assert(res.success, JSON.stringify(res));
    assert(!seen[res.orderId], 'duplicate id ' + res.orderId);
    seen[res.orderId] = true;
  }
  assertEqual(ordersSheet().getLastRow(), 301);
});

test('ids: falls back to a sequential scan when the random picks keep colliding', function () {
  var orig = Math.random;
  Math.random = function () { return 0.12345; };
  try {
    assertEqual(submitOrder(validOrder({ idempotencyKey: 'scanfallback00001' })).orderId, '12345');
    assertEqual(submitOrder(validOrder({ idempotencyKey: 'scanfallback00002' })).orderId, '12346');
  } finally { Math.random = orig; }
});

test('rate limits: per-email hourly limit applies', function () {
  CONFIG.RATE_LIMITS.ORDERS_PER_EMAIL_PER_HOUR = 2;
  assert(submitOrder(validOrder({ idempotencyKey: 'ratelimitkey00001' })).success);
  assert(submitOrder(validOrder({ idempotencyKey: 'ratelimitkey00002' })).success);
  assertEqual(submitOrder(validOrder({ idempotencyKey: 'ratelimitkey00003' })).code, 'RATE_LIMITED');
  var other = validOrder({ idempotencyKey: 'ratelimitkey00004' });
  other.customer.email = 'someone.else@example.com';
  assert(submitOrder(other).success, 'other customers unaffected');
});

/* ---------------- Email ---------------- */

test('email: owner notification lists Product ID, name, colour, size, quantity and unit price', function () {
  var orig = Math.random;
  Math.random = function () { return 0.04729; };
  try { submitOrder(validOrder()); } finally { Math.random = orig; }
  assertEqual(__mock.sentEmails.length, 1);
  var mail = __mock.sentEmails[0];
  assertEqual(mail.to, 'owner@example.com');
  assertEqual(mail.subject, 'New T-Shirt Order #04729');
  assertEqual(mail.replyTo, 'jane@example.com');
  ['Order Reference: #04729', '- Name: Jane Doe', '- Phone: +353 87 123 4567', '- Email: jane@example.com', 'Dublin D02 XY12',
    '- P001 | Classic Hoodie | Color: Blue | Size: L | Qty: 2 | EGP 29.99 each = EGP 59.98',
    '- P002 | Printed T-Shirt | Color: Black | Size: S | Qty: 1 | EGP 19.99 each = EGP 19.99',
    'Total Price: EGP 79.97', 'Order Status: Pending'].forEach(function (s) {
    assert(mail.body.indexOf(s) !== -1, 'body contains ' + s);
  });
  ['#04729', '>P001<', '>Blue<', '>L<', '>Classic Hoodie<'].forEach(function (s) {
    assert(mail.htmlBody.indexOf(s) !== -1, 'html contains ' + s);
  });
});

test('email: user text and sheet text are HTML-escaped in the HTML body', function () {
  freshStore([['<b>X</b>', '<i>Tee</i>', 'x', 10, 'Classic', '<script>', '', 1, 1, 1, 1, 1]]);
  var customer = Object.assign({}, validOrder().customer, { name: '<img src=x onerror=alert(1)> Bob' });
  assert(submitOrder(validOrder({ customer: customer, items: [item('<b>X</b>', '<script>', 'M')] })).success);
  var html = __mock.sentEmails[0].htmlBody;
  assert(html.indexOf('<img src=x') === -1 && html.indexOf('<script>') === -1 && html.indexOf('<i>Tee') === -1, 'no raw tags');
  assert(html.indexOf('&lt;img src=x onerror=alert(1)&gt; Bob') !== -1);
  assert(html.indexOf('&lt;script&gt;') !== -1);
});

test('email: failure after saving still reports success and records a note', function () {
  __mock.mailFails = true;
  var res = submitOrder(validOrder());
  assert(res.success, 'order still confirmed');
  assert(/Email notification failed/.test(ordersSheet().getRange(2, 2).getNote()));
  assertEqual(ordersSheet().getLastColumn(), 9, 'no extra columns');
  assertEqual(submitOrder(validOrder()).orderId, res.orderId, 'retry returns the same order');
  assertEqual(ordersSheet().getLastRow(), 2);
});

test('email: exhausted quota is recorded; recipient falls back to the owner', function () {
  __mock.mailQuota = 0;
  assert(submitOrder(validOrder()).success);
  assert(/quota/.test(ordersSheet().getRange(2, 2).getNote()));
  freshStore();
  __mock.props = {};
  assert(submitOrder(validOrder()).success);
  assertEqual(__mock.sentEmails[0].to, 'owner@example.com');
});

/* ---------------- Webhook, web app, setup, migration ---------------- */

test('webhook: doPost uses the same pipeline and enforces WEBHOOK_SECRET when set', function () {
  var res = JSON.parse(doPost({ postData: { contents: JSON.stringify(validOrder()) } }).getContent());
  assert(res.success && /^\d{5}$/.test(res.orderId));
  assertEqual(submitOrder(validOrder()).orderId, res.orderId, 'same idempotency key → same order');
  assertEqual(JSON.parse(doPost({ postData: { contents: '{nope' } }).getContent()).code, 'INVALID_REQUEST');
  __mock.props = { WEBHOOK_SECRET: 'letmein' };
  assertEqual(JSON.parse(doPost({ postData: { contents: JSON.stringify(validOrder({ idempotencyKey: 'webhooksecretkey1' })) } }).getContent()).code, 'UNAUTHORIZED');
  var body = validOrder({ idempotencyKey: 'webhooksecretkey2' }); body.secret = 'letmein';
  assert(JSON.parse(doPost({ postData: { contents: JSON.stringify(body) } }).getContent()).success);
});

test('web app: doGet serves the page, and ?action=products serves grouped JSON', function () {
  assertEqual(doGet({ parameter: {} }).name, 'Index');
  var json = JSON.parse(doGet({ parameter: { action: 'products' } }).getContent());
  assert(json.success && json.products.length === 4 && json.products[0].variants.length === 3);
});

test('setup: fills an empty spreadsheet with the new format and is safe to re-run', function () {
  resetMocks({ sheets: { Sheet1: [] } });
  __mock.activeUser = 'owner@example.com';
  setupSpreadsheet();
  var ss = __mock.spreadsheet;
  assertEqual(ss.getSheets().map(function (s) { return s.getName(); }), ['Products', 'Orders']);
  assertEqual(ss.getSheetByName('Products').row(1), HEADER);
  assertEqual(ss.getSheetByName('Orders').row(1), CONFIG.ORDER_HEADERS);
  setupSpreadsheet();
  assertEqual(ss.getSheetByName('Products').getLastRow(), 5, 'no duplicate samples');
  var products = getProducts().products;
  assertEqual(products.length, 2);
  assertEqual(products[0].variants.length, 3);
});

test('setup: never touches an old-format Products tab', function () {
  var old = [['Name', 'Price', 'Image Link', 'Description', 'Category', 'Sizes Available', 'In Stock'], ['Old Tee', 10, '', 'x', 'Classic', 'S,M', 'Yes']];
  resetMocks({ sheets: { Products: old, Orders: ORDER_HEADER_ROW } });
  __mock.activeUser = 'owner@example.com';
  var before = JSON.stringify(productsSheet().cells);
  var summary = setupSpreadsheet();
  assertEqual(JSON.stringify(productsSheet().cells), before);
  assert(/old format/.test(summary), summary);
});

test('migration: preview converts the old format without writing anything', function () {
  var old = [['Name', 'Price', 'Image Link', 'Description', 'Category', 'Sizes Available', 'In Stock'],
    ['Black Hoodie', 29.99, 'https://e.com/h.jpg', 'Warm, soft', 'Hoodies', 'S,M,XL', 'Yes'],
    ['', '', '', '', '', '', ''],
    ['Old Shirt', 24.99, 'https://e.com/s.jpg', 'Plain', 'Shirt', 'xs, M', 'No']];
  resetMocks({ sheets: { Products: old, Orders: ORDER_HEADER_ROW } });
  __mock.activeUser = 'owner@example.com';
  var before = JSON.stringify(productsSheet().cells);
  var report = previewProductsMigration();
  assertEqual(JSON.stringify(productsSheet().cells), before, 'nothing written');
  assertEqual(__mock.spreadsheet.getSheets().length, 2, 'no new tabs');
  assert(report.indexOf('P001,Black Hoodie,"Warm, soft",29.99,Hoodies,Standard,https://e.com/h.jpg,1,1,0,1,0') !== -1, report);
  assert(report.indexOf('P002,Old Shirt,Plain,24.99,Shirt,Standard,https://e.com/s.jpg,0,0,0,0,0') !== -1, 'out of stock → all 0');
  assert(/size "XS" has no column/.test(report));
  // The converted rows load cleanly.
  var converted = convertLegacyProductRows_(old).rows;
  freshStore([], converted);
  assertEqual(getProducts().products.map(function (p) { return p.id + ':' + p.variants[0].color; }), ['P001:Standard', 'P002:Standard']);
});

test('config: background URLs — https and relative paths pass; anything else is blanked', function () {
  assertEqual(assetUrl_('https://cdn.example.com/bg/desktop.gif'), 'https://cdn.example.com/bg/desktop.gif');
  assertEqual(assetUrl_('  assets/background-mobile.gif '), 'assets/background-mobile.gif');
  ['', null, undefined, 'http://example.com/a.gif', 'javascript:alert(1)', 'data:image/gif;base64,AAAA',
    '//evil.example/a.gif', 'https://e.com/a.gif") ; x', "https://e.com/a'.gif", 'https://e.com/a b.gif',
    'assets/a b.gif', '/etc/passwd'].forEach(function (bad) {
    assertEqual(assetUrl_(bad), '', String(bad));
  });
});

test('config: public config carries the background settings and breakpoint', function () {
  var saved = JSON.stringify(CONFIG.BACKGROUND);
  CONFIG.BACKGROUND.DESKTOP_GIF = 'https://cdn.example.com/d.gif';
  CONFIG.BACKGROUND.MOBILE_GIF = 'bad url';
  CONFIG.BACKGROUND.MOBILE_BREAKPOINT = '640';
  var bg = getPublicConfig_().background;
  assertEqual(bg.desktop, 'https://cdn.example.com/d.gif');
  assertEqual(bg.mobile, '');
  assertEqual(bg.mobileBreakpoint, 640);
  CONFIG.BACKGROUND = JSON.parse(saved);
  assertEqual(getPublicConfig_().background.mobileBreakpoint, 768, 'default');
});

test('config: favicon — Drive share links become direct image links; others pass through assetUrl_', function () {
  assertEqual(faviconUrl_('https://drive.google.com/file/d/1BhWzKM4ont1NlEl77nOijnQu0e3inuYv/view?usp=drive_link'),
    'https://drive.google.com/uc?id=1BhWzKM4ont1NlEl77nOijnQu0e3inuYv&export=download&format=png');
  assertEqual(faviconUrl_('https://cdn.example.com/favicon.png'), 'https://cdn.example.com/favicon.png');
  assertEqual(faviconUrl_(''), '');
  assertEqual(faviconUrl_('javascript:alert(1)'), '');
});

test('config: contact details — text trimmed, links https only, WhatsApp digits, bad email dropped', function () {
  var c = publicContact_({ PHONE: ' +20 10 1234 5678 ', WHATSAPP: '+20 (10) 1234-5678', EMAIL: 'hi@shop.com',
    INSTAGRAM: 'https://www.instagram.com/theredshop', FACEBOOK: 'javascript:alert(1)', TIKTOK: 'http://tiktok.com/@x',
    ADDRESS: '12 Tahrir St\nCairo' });
  assertEqual(c, { phone: '+20 10 1234 5678', whatsapp: '201012345678', email: 'hi@shop.com',
    instagram: 'https://www.instagram.com/theredshop', facebook: '', tiktok: '', address: '12 Tahrir St\nCairo' });
  assertEqual(publicContact_({ EMAIL: 'not an email', WHATSAPP: '123' }).email, '');
  assertEqual(publicContact_({ WHATSAPP: '123' }).whatsapp, '', 'too short');
  assertEqual(getPublicConfig_().contact.phone, '', 'empty by default');
});

test('products: optional "Image Link 2" column — per colour, Drive links converted, invalid skipped and reported', function () {
  var header = HEADER.slice(0, 7).concat(['Image Link 2']).concat(HEADER.slice(7));
  freshStore([], [header,
    ['P001', 'Hoodie', 'Warm', 10, 'Hoodies', 'Red', 'https://e.com/red.jpg', 'https://e.com/red-back.jpg', 1, 1, 1, 1, 1],
    ['P001', 'Hoodie', 'Warm', 10, 'Hoodies', 'Blue', 'https://e.com/blue.jpg', '', 1, 0, 0, 0, 0],
    ['P001', 'Hoodie', 'Warm', 10, 'Hoodies', 'Green', 'https://e.com/green.jpg', 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view', 1, 0, 0, 0, 0],
    ['P001', 'Hoodie', 'Warm', 10, 'Hoodies', 'Black', 'https://e.com/black.jpg', 'not a link', 0, 1, 0, 0, 0]]);
  var report = readCatalog_();
  var v = report.products[0].variants;
  assertEqual(v.map(function (x) { return x.imageUrl2; }),
    ['https://e.com/red-back.jpg', '', 'https://drive.google.com/thumbnail?id=1AbCdEfGhIjKlMnOp&sz=w1000', '']);
  assertEqual(v[0].sizes, { S: true, M: true, L: true, XL: true, XXL: true }, 'size columns still found after the extra column');
  assert(report.problems.join('\n').indexOf('Image Link 2 is not a valid') !== -1, report.problems.join('\n'));
  assertEqual(report.problems.length, 1, 'an empty Image Link 2 is not a problem');
});
