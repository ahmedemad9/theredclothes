/**
 * Products.gs — reads the "Products" tab. The website never writes to it.
 *
 * Schema: one row per product + colour. Rows sharing a Product ID are one product.
 *   Product ID | Name | Description | Price | Category | Color | Image Link | S | M | L | XL | XXL
 * Size cells: 1 = available, 0 or empty = unavailable. Columns are found by header name.
 */

var PRODUCT_COLUMNS = {
  ID: 'Product ID',
  NAME: 'Name',
  DESCRIPTION: 'Description',
  PRICE: 'Price',
  CATEGORY: 'Category',
  COLOR: 'Color',
  IMAGE: 'Image Link',
  IMAGE_2: 'Image Link 2',  // optional column
  IMAGE_3: 'Image Link 3'   // optional column

};
var SIZE_COLUMNS = ['S', 'M', 'L', 'XL', 'XXL'];
var PRODUCT_HEADERS_V2 = ['Product ID', 'Name', 'Description', 'Price', 'Category', 'Color', 'Image Link'].concat(SIZE_COLUMNS);
var PRODUCT_ID_MAX = 50;
var COLOR_MAX = 50;

/**
 * Swatch colours for clothing colour names browsers don't know. Any CSS colour
 * name (red, navy, olive, "sky blue"…) works without being listed here.
 */
var COLOR_SWATCHES = {
  'burgundy': '#800020', 'charcoal': '#36454f', 'cream': '#f3ead8', 'heather grey': '#b8b8bd',
  'heather gray': '#b8b8bd', 'mustard': '#e1ad01', 'sand': '#d8c3a5', 'off white': '#f5f3ee',
  'mint': '#98d8c8', 'forest green': '#2f5d4a', 'stone': '#a8a39b', 'camel': '#c19a6b',
  'rust': '#b7410e', 'denim': '#1560bd', 'lilac': '#c8a2c8', 'bottle green': '#006a4e', 'ivory': '#fffff0'
};

function getSpreadsheet_() {
  var id = getProp_(PROPS.SPREADSHEET_ID);
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new StoreError_('Store spreadsheet not found. Set the SPREADSHEET_ID script property.', 'CONFIG');
  }
  return ss;
}

function getSheet_(name) {
  var sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) {
    throw new StoreError_('The "' + name + '" tab is missing from the spreadsheet.', 'CONFIG');
  }
  return sheet;
}

/** Throws unless row 1 of the sheet holds exactly the expected headers (case-insensitive). */
function assertHeaders_(sheet, expected) {
  var lastCol = Math.max(sheet.getLastColumn(), expected.length);
  var actual = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  for (var i = 0; i < expected.length; i++) {
    if (String(actual[i] || '').trim().toLowerCase() !== expected[i].toLowerCase()) {
      throw new StoreError_('The "' + sheet.getName() + '" tab must have the header "' + expected[i] +
        '" in column ' + String.fromCharCode(65 + i) + '.', 'CONFIG');
    }
  }
}

function headerKey_(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isLegacyProductsSheet_(headers) {
  var keys = headers.map(headerKey_);
  return keys.indexOf('sizes available') !== -1 || (keys.indexOf('in stock') !== -1 && keys.indexOf('product id') === -1);
}

/**
 * Finds each required column by its header. Returns { name → 0-based index }.
 * Throws a clear error for the old (one row per product) format or missing headers.
 */
function productHeaderMap_(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = lastCol ? sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0] : [];
  if (isLegacyProductsSheet_(headers)) {
    throw new StoreError_('The Products tab still uses the old format (Sizes Available / In Stock). ' +
      'Convert it to the Product ID + Color format described in README.md ("Migrating the Products tab").', 'OLD_SCHEMA');
  }
  var index = {};
  headers.forEach(function (h, i) {
    var k = headerKey_(h);
    if (k && !(k in index)) index[k] = i;
  });
  var missing = PRODUCT_HEADERS_V2.filter(function (h) { return !(headerKey_(h) in index); });
  if (missing.length) {
    throw new StoreError_('The Products tab is missing these column headers: ' + missing.join(', ') + '.', 'CONFIG');
  }
  var map = {};
  PRODUCT_HEADERS_V2.forEach(function (h) { map[h] = index[headerKey_(h)]; });
  map[PRODUCT_COLUMNS.IMAGE_2] = index[headerKey_(PRODUCT_COLUMNS.IMAGE_2)];   // undefined when the column is absent
  map[PRODUCT_COLUMNS.IMAGE_3] = index[headerKey_(PRODUCT_COLUMNS.IMAGE_3)];
  return map;
}

/** "T-Shirts", "tshirts " and "TSHIRTS" all become "tshirts". */
function categoryKey_(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function productKey_(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Product IDs are strings, compared without surrounding spaces and case. */
function idKey_(id) {
  return String(id == null ? '' : id).trim().toLowerCase();
}

function colorKey_(color) {
  return productKey_(color);
}

/** Returns the canonical size label ("xl" → "XL"), or '' when it is not a known size. */
function canonicalSize_(size) {
  var s = String(size || '').trim().toUpperCase();
  return SIZE_COLUMNS.indexOf(s) === -1 ? '' : s;
}

/** Accepts numbers or strings like "29.99", "€29,99", "1,299.00". Returns NaN when unusable. */
function parsePrice_(value) {
  if (typeof value === 'number') return value;
  var s = String(value || '').replace(/[^\d.,-]/g, '');
  if (!s) return NaN;
  if (s.indexOf(',') !== -1 && s.indexOf('.') !== -1) {
    s = s.replace(/,/g, '');                 // 1,299.00
  } else if (s.indexOf(',') !== -1) {
    s = s.replace(',', '.');                 // 29,99
  }
  return Number(s);
}

/**
 * Size cells: 1 / "1" → available; 0 / "0" / empty → unavailable.
 * Anything else (2, "yes", TRUE, "x") is invalid and treated as unavailable.
 */
function parseStockCell_(value) {
  if (value === 1) return { valid: true, available: true };
  if (value === 0 || value === null || value === undefined) return { valid: true, available: false };
  if (typeof value === 'string') {
    var s = value.trim();
    if (s === '1') return { valid: true, available: true };
    if (s === '0' || s === '') return { valid: true, available: false };
  }
  return { valid: false, available: false };
}

/**
 * Only http(s) links are used. Google Drive share links are converted to a
 * thumbnail URL that renders inside an <img>.
 */
function normalizeImageUrl_(value) {
  var url = String(value || '').trim();
  if (!/^https?:\/\/[^\s\/]+(\/\S*)?$/i.test(url)) return '';
  var m = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=|thumbnail\?(?:[^#]*&)?id=)([A-Za-z0-9_-]{10,})/);
  if (m) return 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w1000';
  return url;
}

/** Maps a sheet category to the configured filter label, or keeps the owner's text. */
function canonicalCategory_(value) {
  var key = categoryKey_(value);
  for (var i = 0; i < CONFIG.CATEGORIES.length; i++) {
    if (categoryKey_(CONFIG.CATEGORIES[i]) === key) return CONFIG.CATEGORIES[i];
  }
  return String(value || '').trim();
}

function variantInStock_(variant) {
  return SIZE_COLUMNS.some(function (s) { return variant.sizes[s]; });
}

/**
 * Reads the Products tab and groups rows by Product ID.
 * Returns { products: [...], problems: [...] }. Problems are for the owner
 * (checkCatalog / execution log), never shown to customers:
 *  - a product whose rows disagree on Name, Description, Price or Category is hidden;
 *  - duplicate Product ID + Color rows hide that colour;
 *  - invalid size cells count as unavailable; invalid image links show a placeholder.
 */
function readCatalog_() {
  var sheet = getSheet_(CONFIG.SHEETS.PRODUCTS);
  var col = productHeaderMap_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { products: [], problems: [] };
  var rows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  var problems = [];
  var groups = {};
  var order = [];

  rows.forEach(function (row, i) {
    var rowNumber = i + 2;
    if (row.every(function (cell) { return String(cell).trim() === ''; })) return;
    var id = String(row[col['Product ID']] == null ? '' : row[col['Product ID']]).trim();
    var color = String(row[col['Color']] || '').trim().replace(/\s+/g, ' ');
    if (!id) { problems.push('Row ' + rowNumber + ': missing Product ID — row ignored.'); return; }
    if (id.length > PRODUCT_ID_MAX) { problems.push('Row ' + rowNumber + ': Product ID is too long — row ignored.'); return; }
    if (!color) { problems.push('Row ' + rowNumber + ' (' + id + '): missing Color — row ignored.'); return; }
    if (color.length > COLOR_MAX) { problems.push('Row ' + rowNumber + ' (' + id + '): Color is too long — row ignored.'); return; }

    var key = idKey_(id);
    if (!groups[key]) { groups[key] = { id: id, rows: [] }; order.push(key); }
    groups[key].rows.push({ rowNumber: rowNumber, cells: row, color: color });
  });

  var products = [];
  order.forEach(function (key) {
    var product = buildProduct_(groups[key], col, problems);
    if (product) products.push(product);
  });
  return { products: products, problems: problems };
}

function buildProduct_(group, col, problems) {
  var label = 'Product ' + group.id;
  var first = group.rows[0].cells;
  var name = String(first[col['Name']] || '').trim().replace(/\s+/g, ' ');
  var description = String(first[col['Description']] || '').trim();
  var price = parsePrice_(first[col['Price']]);
  var category = canonicalCategory_(first[col['Category']]);

  if (!name) { problems.push(label + ' (row ' + group.rows[0].rowNumber + '): missing Name — product hidden.'); return null; }
  if (!isFinite(price) || price <= 0) {
    problems.push(label + ' (row ' + group.rows[0].rowNumber + '): price "' + first[col['Price']] + '" is not a positive number — product hidden.');
    return null;
  }

  // Shared fields must match on every row; never pick one of two conflicting values.
  var conflicts = [];
  group.rows.slice(1).forEach(function (r) {
    var c = r.cells;
    if (String(c[col['Name']] || '').trim().replace(/\s+/g, ' ') !== name) conflicts.push('Name (row ' + r.rowNumber + ')');
    if (String(c[col['Description']] || '').trim() !== description) conflicts.push('Description (row ' + r.rowNumber + ')');
    var p = parsePrice_(c[col['Price']]);
    if (!isFinite(p) || Math.round(p * 100) !== Math.round(price * 100)) conflicts.push('Price (row ' + r.rowNumber + ')');
    if (categoryKey_(c[col['Category']]) !== categoryKey_(category)) conflicts.push('Category (row ' + r.rowNumber + ')');
  });
  if (conflicts.length) {
    problems.push(label + ' (' + name + '): rows disagree with row ' + group.rows[0].rowNumber + ' on ' +
      conflicts.join(', ') + ' — product hidden until all its rows match.');
    return null;
  }

  var colorCounts = {};
  group.rows.forEach(function (r) { var k = colorKey_(r.color); colorCounts[k] = (colorCounts[k] || 0) + 1; });

  var variants = [];
  group.rows.forEach(function (r) {
    if (colorCounts[colorKey_(r.color)] > 1) {
      problems.push(label + ' row ' + r.rowNumber + ': colour "' + r.color + '" appears more than once — that colour is hidden until the duplicate is removed.');
      return;
    }
    var rawImage = String(r.cells[col['Image Link']] || '').trim();
    var imageUrl = normalizeImageUrl_(rawImage);
    if (rawImage && !imageUrl) {
      problems.push(label + ' row ' + r.rowNumber + ' (' + r.color + '): Image Link is not a valid http(s) URL — placeholder shown.');
    } else if (!rawImage) {
      problems.push(label + ' row ' + r.rowNumber + ' (' + r.color + '): no Image Link — placeholder shown.');
    }
    var extraImage = function (header, which) {
      var raw = col[header] === undefined ? '' : String(r.cells[col[header]] || '').trim();
      var url = normalizeImageUrl_(raw);
      if (raw && !url) {
        problems.push(label + ' row ' + r.rowNumber + ' (' + r.color + '): ' + header + ' is not a valid http(s) URL — ' + which + ' image skipped.');
      }
      return url;
    };
    var imageUrl2 = extraImage(PRODUCT_COLUMNS.IMAGE_2, 'second');
    var imageUrl3 = extraImage(PRODUCT_COLUMNS.IMAGE_3, 'third');
    var sizes = {};
    SIZE_COLUMNS.forEach(function (s) {
      var parsed = parseStockCell_(r.cells[col[s]]);
      if (!parsed.valid) {
        problems.push(label + ' row ' + r.rowNumber + ' (' + r.color + '): size ' + s + ' value "' + r.cells[col[s]] +
          '" is not 1 or 0 — treated as unavailable.');
      }
      sizes[s] = parsed.available;
    });
    variants.push({ color: r.color, imageUrl: imageUrl, imageUrl2: imageUrl2, imageUrl3: imageUrl3, sizes: sizes });
  });

  if (!variants.length) {
    problems.push(label + ' (' + name + '): no usable colours — product hidden.');
    return null;
  }
  return {
    id: group.id,
    name: name,
    description: description,
    price: Math.round(price * 100) / 100,
    category: category,
    categoryKey: categoryKey_(category),
    variants: variants,
    inStock: variants.some(variantInStock_)
  };
}

/** Lookup keyed by normalised Product ID. */
function indexCatalog_(products) {
  var index = {};
  products.forEach(function (p) { index[idKey_(p.id)] = p; });
  return index;
}

function findVariant_(product, color) {
  var key = colorKey_(color);
  for (var i = 0; i < product.variants.length; i++) {
    if (colorKey_(product.variants[i].color) === key) return product.variants[i];
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Old → new format conversion (read-only helper for the owner)
 * ------------------------------------------------------------------ */

/**
 * Converts rows of the old Products format (header row first) into rows of the
 * new format. Pure function: it never touches the spreadsheet.
 * Each old product becomes one row with colour "Standard" and sequential IDs
 * (P001, P002, …); sizes are 1 when listed in "Sizes Available" and "In Stock" is Yes.
 */
function convertLegacyProductRows_(rows) {
  var header = rows[0].map(headerKey_);
  var at = function (name) { return header.indexOf(name.toLowerCase()); };
  var c = { name: at('Name'), price: at('Price'), image: at('Image Link'), description: at('Description'),
    category: at('Category'), sizes: at('Sizes Available'), stock: at('In Stock') };
  var notes = [];
  var out = [PRODUCT_HEADERS_V2.slice()];
  var n = 0;
  rows.slice(1).forEach(function (row, i) {
    if (row.every(function (cell) { return String(cell).trim() === ''; })) return;
    n++;
    var id = 'P' + ('00' + n).slice(-3);
    var stock = String(row[c.stock] || '').trim().toLowerCase();
    var inStock = row[c.stock] === true || stock === 'yes' || stock === 'y' || stock === 'true' || stock === 'in stock';
    var listed = String(row[c.sizes] || '').split(/[,;\/|]/).map(function (s) { return s.trim().toUpperCase(); }).filter(String);
    listed.forEach(function (s) {
      if (SIZE_COLUMNS.indexOf(s) === -1) notes.push('Row ' + (i + 2) + ': size "' + s + '" has no column in the new format and was dropped.');
    });
    out.push([id, row[c.name], row[c.description], row[c.price], row[c.category], 'Standard', row[c.image]]
      .concat(SIZE_COLUMNS.map(function (s) { return inStock && listed.indexOf(s) !== -1 ? 1 : 0; })));
  });
  return { rows: out, notes: notes };
}

function toCsv_(rows) {
  return rows.map(function (row) {
    return row.map(function (cell) {
      var s = cell == null ? '' : String(cell);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }).join('\n');
}

