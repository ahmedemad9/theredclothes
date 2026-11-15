/**
 * Frontend tests: StoreLogic (Logic.html) and StoreApi (Api.html) with a mocked google.script.run.
 * DOM behaviour (bubbles, image switching, disabled sizes) is covered by tests/ui_test.py.
 */

function memoryStorage() {
  var data = {};
  return {
    data: data,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; }
  };
}

function sizes(s, m, l, xl, xxl) { return { S: !!s, M: !!m, L: !!l, XL: !!xl, XXL: !!xxl }; }

var PRODUCTS = [
  { id: 'P001', name: 'Classic Hoodie', price: 29.99, description: 'Cotton hoodie', category: 'Hoodies', inStock: true, variants: [
    { color: 'Red', imageUrl: 'https://e.com/red.jpg', sizes: sizes(1, 1, 0, 0, 1) },
    { color: 'Blue', imageUrl: 'https://e.com/blue.jpg', sizes: sizes(1, 1, 1, 1, 1) },
    { color: 'Green', imageUrl: 'https://e.com/green.jpg', sizes: sizes(0, 0, 1, 1, 0) }] },
  { id: 'P002', name: 'Printed T-Shirt', price: 19.99, description: 'Vintage printed cotton', category: 'Printed', inStock: true, variants: [
    { color: 'Black', imageUrl: 'https://e.com/black.jpg', sizes: sizes(1, 1, 1, 0, 0) }] },
  { id: 'P003', name: 'Sold Out Shirt', price: 24.99, description: 'Relaxed fit', category: 'Shirt', inStock: false, variants: [
    { color: 'Navy', imageUrl: 'https://e.com/navy.jpg', sizes: sizes(0, 0, 0, 0, 0) },
    { color: 'Sand', imageUrl: 'https://e.com/sand.jpg', sizes: sizes(0, 0, 0, 0, 0) }] },
  { id: 'P004', name: 'Late Bloomer Tee', price: 15, description: 'Soft classic cotton tee', category: 'Tshirts', inStock: true, variants: [
    { color: 'White', imageUrl: 'https://e.com/white.jpg', sizes: sizes(0, 0, 0, 0, 0) },
    { color: 'Olive', imageUrl: 'https://e.com/olive.jpg', sizes: sizes(0, 1, 0, 0, 0) }] }
];
function ids(list) { return list.map(function (p) { return p.id; }); }
function product(id) { return StoreLogic.findProduct(PRODUCTS, id); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }

/* ---------------- Filtering ---------------- */

test('filter: categories (OR), search on name/description/colour, combined, reset', function () {
  assertEqual(StoreLogic.filterProducts(PRODUCTS, {}).length, 4);
  assertEqual(ids(StoreLogic.filterProducts(PRODUCTS, { categories: ['Hoodies'] })), ['P001']);
  assertEqual(ids(StoreLogic.filterProducts(PRODUCTS, { categories: ['Shirt', 'Tshirts'] })), ['P003', 'P004']);
  assertEqual(ids(StoreLogic.filterProducts(PRODUCTS, { query: 'HOODIE' })), ['P001']);
  assertEqual(ids(StoreLogic.filterProducts(PRODUCTS, { query: 'vintage' })), ['P002'], 'description match');
  assertEqual(ids(StoreLogic.filterProducts(PRODUCTS, { query: 'olive' })), ['P004'], 'colour match');
  assertEqual(ids(StoreLogic.filterProducts(PRODUCTS, { query: 'cotton', categories: ['Hoodies', 'Printed'] })), ['P001', 'P002']);
  assertEqual(StoreLogic.filterProducts(PRODUCTS, { query: 'zzz' }).length, 0);
});

test('sort: price and name; default keeps sheet order', function () {
  assertEqual(StoreLogic.sortProducts(PRODUCTS, 'price-asc')[0].id, 'P004');
  assertEqual(StoreLogic.sortProducts(PRODUCTS, 'price-desc')[0].id, 'P001');
  assertEqual(StoreLogic.sortProducts(PRODUCTS, 'name')[0].id, 'P001');
  assertEqual(ids(StoreLogic.sortProducts(PRODUCTS, 'default')), ids(PRODUCTS));
});

test('money: EGP formatting matches the server', function () {
  assertEqual(StoreLogic.formatMoney(1299.5, 'EGP', 'en-EG').replace(/ /g, ' '), 'EGP 1,299.50');
  assertEqual(formatMoney_(1299.5), 'EGP 1,299.50');
  assertEqual(formatMoney_(1234567.891), 'EGP 1,234,567.89');
  assert(StoreLogic.formatMoney(79.97, 'EUR', 'not-a-locale!').indexOf('79.97') !== -1, 'bad locale falls back');
  assertEqual(StoreLogic.toCents(0.1 + 0.2), 30);
});

/* ---------------- Variants ---------------- */

test('variants: lookup by Product ID and colour is case-insensitive', function () {
  assertEqual(StoreLogic.findProduct(PRODUCTS, ' p001 ').name, 'Classic Hoodie');
  assertEqual(StoreLogic.findVariant(product('P001'), 'BLUE').imageUrl, 'https://e.com/blue.jpg');
  assertEqual(StoreLogic.findVariant(product('P001'), 'Purple'), null);
});

test('variants: each colour has its own size availability', function () {
  var hoodie = product('P001');
  assertEqual(StoreLogic.availableSizes(StoreLogic.findVariant(hoodie, 'Red')), ['S', 'M', 'XXL']);
  assertEqual(StoreLogic.availableSizes(StoreLogic.findVariant(hoodie, 'Blue')), ['S', 'M', 'L', 'XL', 'XXL']);
  assertEqual(StoreLogic.availableSizes(StoreLogic.findVariant(hoodie, 'Green')), ['L', 'XL']);
  assert(StoreLogic.isSizeAvailable(StoreLogic.findVariant(hoodie, 'Blue'), 'L'));
  assert(!StoreLogic.isSizeAvailable(StoreLogic.findVariant(hoodie, 'Red'), 'L'));
});

test('variants: colour and product availability levels', function () {
  assert(!StoreLogic.isVariantAvailable(StoreLogic.findVariant(product('P004'), 'White')), 'all sizes 0 → colour out');
  assert(StoreLogic.isPurchasable(product('P004')), 'one colour in stock → product purchasable');
  assert(!StoreLogic.isPurchasable(product('P003')), 'every size of every colour 0 → product out');
});

test('variants: default colour is the first with stock, else the first colour', function () {
  assertEqual(StoreLogic.defaultVariant(product('P001')).color, 'Red');
  assertEqual(StoreLogic.defaultVariant(product('P004')).color, 'Olive', 'skips sold-out White');
  assertEqual(StoreLogic.defaultVariant(product('P003')).color, 'Navy', 'all sold out → first colour');
});

/* ---------------- Cart ---------------- */

function newCart(store) { return StoreLogic.createCart(store || memoryStorage(), 'store.cart.v2', 10, 'store.cart.v1'); }
function keys(cart) { return cart.items().map(function (i) { return i.productId + '|' + i.color + '|' + i.size + ':' + i.quantity; }); }

test('cart: identity is Product ID + Color + Size', function () {
  var cart = newCart();
  cart.add(product('P001'), 'Red', 'M', 1);
  cart.add(product('P001'), 'Blue', 'M', 2);
  cart.add(product('P001'), 'Red', 'S', 1);
  cart.add(product('P001'), 'red', 'M', 2);
  assertEqual(keys(cart), ['P001|Red|M:3', 'P001|Blue|M:2', 'P001|Red|S:1']);
  assertEqual(cart.count(), 6);
  assertEqual(cart.subtotalCents(), 17994);
});

test('cart: each line stores the image of its own colour', function () {
  var cart = newCart();
  cart.add(product('P001'), 'Red', 'M', 1);
  cart.add(product('P001'), 'Blue', 'L', 1);
  assertEqual(cart.items().map(function (i) { return i.imageUrl; }), ['https://e.com/red.jpg', 'https://e.com/blue.jpg']);
  assertEqual(cart.items()[1], { productId: 'P001', productName: 'Classic Hoodie', color: 'Blue', size: 'L', quantity: 1,
    unitPrice: 29.99, imageUrl: 'https://e.com/blue.jpg' });
});

test('cart: unavailable sizes, sold-out colours and unknown colours cannot be added', function () {
  var cart = newCart();
  assertThrows(function () { cart.add(product('P001'), 'Red', 'L', 1); }, /out of stock in Red/);
  assertThrows(function () { cart.add(product('P001'), 'Red', '', 1); }, /select a size/);
  assertThrows(function () { cart.add(product('P004'), 'White', 'M', 1); }, /colour is out of stock/);
  assertThrows(function () { cart.add(product('P003'), 'Navy', 'S', 1); }, /out of stock/);
  assertThrows(function () { cart.add(product('P001'), 'Purple', 'M', 1); }, /select a colour/);
  assertThrows(function () { cart.add(product('P001'), 'Blue', 'M', 0); }, /quantity/);
  assertEqual(cart.count(), 0);
  cart.add(product('P001'), 'Green', 'L', 1);
  assertEqual(cart.count(), 1, 'size available in another colour works');
});

test('cart: quantity changes, per-line limit and removal', function () {
  var cart = newCart();
  cart.add(product('P002'), 'Black', 'M', 8);
  assertEqual(cart.add(product('P002'), 'Black', 'M', 5), 2, 'only adds up to the limit');
  assertThrows(function () { cart.add(product('P002'), 'Black', 'M', 1); }, /at most 10/);
  var key = StoreLogic.cartKey('P002', 'Black', 'M');
  cart.setQuantity(key, 4);
  assertEqual(cart.count(), 4);
  cart.setQuantity(key, 99);
  assertEqual(cart.count(), 10, 'clamped');
  cart.setQuantity(key, 0);
  assertEqual(cart.count(), 0, 'decrease to zero removes');
  cart.add(product('P002'), 'Black', 'M', 1);
  cart.add(product('P001'), 'Blue', 'S', 1);
  cart.remove(key);
  assertEqual(keys(cart), ['P001|Blue|S:1']);
});

test('cart: persists to storage and survives a reload', function () {
  var store = memoryStorage();
  newCart(store).add(product('P001'), 'Blue', 'L', 2);
  var reloaded = newCart(store);
  assertEqual(keys(reloaded), ['P001|Blue|L:2']);
  assertEqual(reloaded.items()[0].imageUrl, 'https://e.com/blue.jpg');
  reloaded.clear();
  assertEqual(newCart(store).count(), 0);
});

test('cart: corrupted, tampered or throwing storage is handled safely', function () {
  var store = memoryStorage();
  store.setItem('store.cart.v2', '{not json');
  assertEqual(newCart(store).count(), 0);
  store.setItem('store.cart.v2', JSON.stringify({ items: [
    { productId: 'P001', color: 'Red', size: 'M', quantity: -3, unitPrice: 1 },
    { productId: 'P001', color: '', size: 'M', quantity: 1, unitPrice: 1 },
    { productId: 'P001', productName: 'Classic Hoodie', color: 'Red', size: 'M', quantity: 50, unitPrice: 2 }, 'junk'] }));
  assertEqual(keys(newCart(store)), ['P001|Red|M:10']);
  var broken = { getItem: function () { throw new Error('denied'); }, setItem: function () { throw new Error('full'); }, removeItem: function () {} };
  var cart = newCart(broken);
  cart.add(product('P002'), 'Black', 'S', 1);
  assertEqual(cart.count(), 1);
});

test('cart: reconcile removes vanished products/colours and sold-out sizes, updates price and image', function () {
  var cart = newCart();
  cart.add(product('P001'), 'Red', 'M', 1);
  cart.add(product('P001'), 'Blue', 'XL', 1);
  cart.add(product('P001'), 'Green', 'L', 1);
  cart.add(product('P002'), 'Black', 'S', 2);
  cart.add(product('P004'), 'Olive', 'M', 1);
  var updated = clone(PRODUCTS);
  updated[0].variants[1].sizes.XL = false;               // Blue XL sold out
  updated[0].variants.splice(2, 1);                       // Green removed
  updated[0].variants[0].imageUrl = 'https://e.com/red-v2.jpg';
  updated[1].price = 17.5;                                // price change
  updated.pop();                                          // P004 removed
  var changes = cart.reconcile(updated);
  assertEqual(changes.length, 4, JSON.stringify(changes));
  assertEqual(cart.items().map(function (i) { return i.color + '/' + i.size + '@' + i.unitPrice + ' ' + i.imageUrl; }),
    ['Red/M@29.99 https://e.com/red-v2.jpg', 'Black/S@17.5 https://e.com/black.jpg']);
  assertEqual(cart.reconcile(updated), [], 'second reconcile is a no-op');
});

/* ---------------- Old cart migration ---------------- */

function legacyStore(lines) {
  var store = memoryStorage();
  store.setItem('store.cart.v1', JSON.stringify({ items: lines }));
  return store;
}

test('migration: old cart lines are imported as needing review, never with a guessed colour', function () {
  var store = legacyStore([{ name: 'Classic Hoodie', size: 'M', quantity: 2, unitPrice: 29.99 }]);
  var cart = newCart(store);
  var line = cart.items()[0];
  assertEqual(line.needsReview, true);
  assertEqual(line.color, '');
  assertEqual(line.productId, '');
  assert(cart.needsReview());
  assertEqual(cart.orderable(), [], 'review lines are not orderable');
  assertEqual(cart.subtotalCents(), 0);
  assertEqual(store.getItem('store.cart.v1'), null, 'old key cleaned up');
  assert(store.getItem('store.cart.v2'), 'saved in new format');
});

test('migration: unambiguous lines (one product, one colour) are converted on catalog load', function () {
  var cart = newCart(legacyStore([{ name: 'printed t-shirt', size: 'M', quantity: 1, unitPrice: 19.99 }]));
  var changes = cart.reconcile(PRODUCTS);
  assertEqual(changes, []);
  assertEqual(keys(cart), ['P002|Black|M:1']);
  assertEqual(cart.items()[0].imageUrl, 'https://e.com/black.jpg');
  assert(!cart.needsReview());
});

test('migration: product with several colours stays in review with its Product ID', function () {
  var cart = newCart(legacyStore([{ name: 'Classic Hoodie', size: 'M', quantity: 1, unitPrice: 29.99 }]));
  var changes = cart.reconcile(PRODUCTS);
  assertEqual(changes.length, 1);
  var line = cart.items()[0];
  assertEqual([line.needsReview, line.reviewReason, line.productId, line.color], [true, 'choose-color', 'P001', '']);
  assertEqual(cart.reconcile(PRODUCTS), [], 'message is not repeated');
});

test('migration: ambiguous names stay in review; missing products are removed', function () {
  var twins = clone(PRODUCTS).concat([{ id: 'P099', name: 'Classic Hoodie', price: 9, description: '', category: 'Hoodies', inStock: true,
    variants: [{ color: 'Red', imageUrl: '', sizes: sizes(1, 1, 1, 1, 1) }] }]);
  var cart = newCart(legacyStore([{ name: 'Classic Hoodie', size: 'M', quantity: 1, unitPrice: 29.99 },
    { name: 'Deleted Tee', size: 'S', quantity: 1, unitPrice: 5 }]));
  var changes = cart.reconcile(twins);
  assertEqual(cart.items().length, 1);
  assertEqual([cart.items()[0].reviewReason, cart.items()[0].productId], ['ambiguous', '']);
  assert(changes.some(function (c) { return /Deleted Tee/.test(c); }));
});

test('migration: a converted line whose size is sold out is removed with a message', function () {
  var cart = newCart(legacyStore([{ name: 'Printed T-Shirt', size: 'XL', quantity: 1, unitPrice: 19.99 }]));
  var changes = cart.reconcile(PRODUCTS);
  assertEqual(cart.count(), 0);
  assert(/out of stock/.test(changes[0]));
});

/* ---------------- Checkout validation ---------------- */

var GOOD = { name: 'Jane Doe', phone: '+353 87 123 4567', email: 'jane@example.com', address: '12 Main Street\nDublin D02 XY12' };
function withField(k, v) { var c = Object.assign({}, GOOD); c[k] = v; return c; }

test('validate: a complete form passes and is normalised; required fields', function () {
  var r = StoreLogic.validateCustomer(Object.assign({}, GOOD, { email: ' Jane@Example.COM ', name: '  Jane   Doe ' }));
  assert(r.valid, JSON.stringify(r.errors));
  assertEqual(r.values.email, 'jane@example.com');
  assertEqual(r.values.name, 'Jane Doe');
  assertEqual(Object.keys(StoreLogic.validateCustomer({}).errors).sort(), ['address', 'email', 'name', 'phone']);
});

test('validate: invalid emails and phones are rejected, valid ones accepted', function () {
  ['jane', 'jane@', '@example.com', 'jane@example', 'jane@exa mple.com', 'jane..x@example.com', 'jane@example.c'].forEach(function (e) {
    assert(StoreLogic.validateCustomer(withField('email', e)).errors.email, e);
  });
  ['a@b.co', 'first.last+tag@sub.example.org', "o'neil@example.ie"].forEach(function (e) {
    assert(!StoreLogic.validateCustomer(withField('email', e)).errors.email, e);
  });
  ['abc', '12345', '1111111111', '++353 1 234 5678', '353-ABC-1234', '1234567890123456'].forEach(function (p) {
    assert(StoreLogic.validateCustomer(withField('phone', p)).errors.phone, p);
  });
  ['+20 10 1234 5678', '010-1234-5678', '(212) 555-0199', '+44 (0)20 7946 0958'].forEach(function (p) {
    assert(!StoreLogic.validateCustomer(withField('phone', p)).errors.phone, p);
  });
  ['', 'Cairo', 'a b', '12345 67890'].forEach(function (a) {
    assert(StoreLogic.validateCustomer(withField('address', a)).errors.address, JSON.stringify(a));
  });
});

test('validate: frontend and backend rules agree', function () {
  var samples = [GOOD, withField('email', 'bad@'), withField('phone', '+1 (555) 010-9999'), withField('phone', '0000000'),
    withField('name', 'A'), withField('name', 'Łucja Øster'), withField('address', 'Short'),
    withField('address', 'Flat 2, 5 Long Road, Cork'), withField('email', 'x@y.io')];
  samples.forEach(function (s) {
    assertEqual(Object.keys(StoreLogic.validateCustomer(s).errors).sort(), Object.keys(validateCustomer_(s).errors).sort(), JSON.stringify(s));
  });
});

/* ---------------- Idempotency key ---------------- */

test('idempotency: same order reuses the key; a different colour gets a new one', function () {
  var store = memoryStorage();
  var a = [{ productId: 'P001', color: 'Red', size: 'M', quantity: 1 }];
  var b = [{ productId: 'P001', color: 'Blue', size: 'M', quantity: 1 }];
  var fp = StoreLogic.orderFingerprint(a, GOOD);
  var k1 = StoreLogic.idempotencyKeyFor(store, 'chk', fp);
  assert(/^[a-f0-9]{32}$/.test(k1), k1);
  assertEqual(StoreLogic.idempotencyKeyFor(store, 'chk', fp), k1);
  assert(StoreLogic.idempotencyKeyFor(store, 'chk', StoreLogic.orderFingerprint(b, GOOD)) !== k1, 'colour is part of the order identity');
});

/* ---------------- API adapter ---------------- */

/** Minimal google.script.run mock: behaviours[fn] is a list of 'ok:<json>' / 'fail' / 'hang' for successive calls. */
var __gsrCalls = [];
var __gsrBehaviours = {};
var google = {
  script: {
    get run() {
      var success = null, failure = null;
      var runner = {
        withSuccessHandler: function (fn) { success = fn; return runner; },
        withFailureHandler: function (fn) { failure = fn; return runner; }
      };
      ['getProducts', 'submitOrder'].forEach(function (name) {
        runner[name] = function (arg) {
          __gsrCalls.push({ fn: name, arg: arg, argc: arguments.length });
          var b = (__gsrBehaviours[name] || []).shift() || 'hang';
          setTimeout(function () {
            if (b === 'fail') failure(new Error('NetworkError: Connection failure due to HTTP 0'));
            else if (b.indexOf('ok:') === 0) success(JSON.parse(b.slice(3)));
          }, 10);
        };
      });
      return runner;
    }
  }
};

function apiTest(name, behaviours, fn) {
  test(name, function () {
    __gsrCalls = [];
    __gsrBehaviours = behaviours;
    return fn();
  });
}

apiTest('api: getProducts resolves with the server payload (called without arguments)', { getProducts: ['ok:{"success":true,"products":[],"currency":"EGP"}'] }, function () {
  return StoreApi.getProducts().then(function (res) {
    assertEqual(res.success, true);
    assertEqual(__gsrCalls.length, 1);
    assertEqual(__gsrCalls[0].argc, 0);
  });
});

apiTest('api: getProducts retries transport failures, then gives up with an ApiError', { getProducts: ['fail', 'fail', 'fail'] }, function () {
  return StoreApi.getProducts().then(function () { throw new Error('should fail'); }, function (err) {
    assertEqual(err.name, 'ApiError');
    assertEqual(err.kind, 'network');
    assertEqual(__gsrCalls.length, 3);
  });
});

apiTest('api: server-side rejections are returned, not retried', { submitOrder: ['ok:{"success":false,"code":"CART_CHANGED"}'] }, function () {
  return StoreApi.submitOrder({ idempotencyKey: 'k'.repeat(32) }).then(function (res) {
    assertEqual(res.code, 'CART_CHANGED');
    assertEqual(__gsrCalls.length, 1);
  });
});

apiTest('api: submitOrder retries once with the SAME idempotency key', { submitOrder: ['fail', 'ok:{"success":true,"orderId":"04729","total":79.97}'] }, function () {
  return StoreApi.submitOrder({ idempotencyKey: 'abc'.repeat(8) }).then(function (res) {
    assertEqual(res.orderId, '04729');
    assertEqual(__gsrCalls.length, 2);
    assertEqual(__gsrCalls[0].arg.idempotencyKey, __gsrCalls[1].arg.idempotencyKey);
  });
});

apiTest('api: submitOrder without an idempotency key is never retried', { submitOrder: ['fail', 'ok:{"success":true}'] }, function () {
  return StoreApi.submitOrder({}).then(function () { throw new Error('should fail'); }, function (err) {
    assertEqual(__gsrCalls.length, 1);
  });
});

apiTest('api: a call that never answers rejects with a timeout (outcome uncertain)', { submitOrder: ['hang', 'hang'] }, function () {
  return StoreApi.submitOrder({ idempotencyKey: 'abc'.repeat(8) }).then(function () { throw new Error('should time out'); }, function (err) {
    assertEqual(err.kind, 'timeout');
  });
});
