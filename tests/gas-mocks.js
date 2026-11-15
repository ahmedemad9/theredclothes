/**
 * In-memory mocks of the Apps Script services used by the backend.
 *
 * The sheet mock imitates the Sheets behaviour that matters for this project:
 *  - a leading apostrophe marks literal text and is not part of the value
 *  - "=..." in a non-text cell becomes a formula (recorded as an injection)
 *  - numeric-looking strings in non-text cells are coerced to numbers
 *    (so "04729" would silently become 4729 unless the cell is formatted "@")
 */
var __mock;

function resetMocks(options) {
  options = options || {};
  __mock = {
    spreadsheet: new MockSpreadsheet(options.sheets || {}),
    cache: {},
    props: options.props || { NOTIFICATION_EMAIL: 'owner@example.com' },
    sentEmails: [],
    mailFails: false,
    mailQuota: 100,
    lockAvailable: true,
    lockHeld: false,
    lockAcquisitions: 0,
    onLockAcquired: null,
    activeUser: '',
    flushes: 0
  };
}

function MockRange(sheet, row, col, numRows, numCols) {
  this.sheet = sheet; this.row = row; this.col = col;
  this.numRows = numRows || 1; this.numCols = numCols || 1;
}
MockRange.prototype._each = function (fn) {
  var out = [];
  for (var r = 0; r < this.numRows; r++) {
    var line = [];
    for (var c = 0; c < this.numCols; c++) line.push(fn(this.row + r, this.col + c, r, c));
    out.push(line);
  }
  return out;
};
MockRange.prototype.getValues = function () {
  var s = this.sheet;
  return this._each(function (r, c) { var cell = s.cell(r, c); return cell ? cell.value : ''; });
};
MockRange.prototype.getDisplayValues = function () {
  var s = this.sheet;
  return this._each(function (r, c) {
    var cell = s.cell(r, c);
    if (!cell) return '';
    if (cell.value instanceof Date) return cell.value.toISOString();
    if (cell.formula) return '#FORMULA';
    return String(cell.value);
  });
};
MockRange.prototype.setValues = function (values) {
  var s = this;
  if (values.length !== this.numRows || values[0].length !== this.numCols) throw new Error('setValues: dimensions mismatch');
  this._each(function (r, c, i, j) { s.sheet.write(r, c, values[i][j]); });
  return this;
};
MockRange.prototype.setValue = function (v) { this.sheet.write(this.row, this.col, v); return this; };
MockRange.prototype.setNumberFormat = function (fmt) {
  var s = this.sheet;
  this._each(function (r, c) { s.formats[r + ':' + c] = fmt; });
  return this;
};
MockRange.prototype.setNumberFormats = function (fmts) {
  var s = this.sheet;
  this._each(function (r, c, i, j) { s.formats[r + ':' + c] = fmts[i][j]; });
  return this;
};
MockRange.prototype.setNote = function (note) { this.sheet.notes[this.row + ':' + this.col] = note; return this; };
MockRange.prototype.getNote = function () { return this.sheet.notes[this.row + ':' + this.col] || ''; };
MockRange.prototype.setDataValidation = function (rule) { this.sheet.validation = rule; return this; };

function MockSheet(name, rows) {
  this.name = name;
  this.cells = {};
  this.formats = {};
  this.notes = {};
  this.formulaInjections = [];
  this.frozen = 0;
  var self = this;
  (rows || []).forEach(function (row, i) {
    row.forEach(function (v, j) { if (v !== '' && v != null) self.cells[(i + 1) + ':' + (j + 1)] = { value: v }; });
  });
}
MockSheet.prototype.cell = function (r, c) { return this.cells[r + ':' + c]; };
MockSheet.prototype.write = function (r, c, v) {
  var fmt = this.formats[r + ':' + c];
  var cell = { value: v };
  if (typeof v === 'string') {
    if (v.charAt(0) === "'") {
      cell.value = v.slice(1);            // apostrophe = literal text marker
    } else if (fmt !== '@' && /^[=+\-@]/.test(v) && v.length > 1 && !/^[+-]?\d+(\.\d+)?$/.test(v)) {
      cell.formula = true;                // Sheets would evaluate this
      this.formulaInjections.push(v);
    } else if (fmt !== '@' && /^[+-]?\d+(\.\d+)?$/.test(v.trim())) {
      cell.value = Number(v);             // automatic number coercion
    }
  }
  if (v === '' || v == null) delete this.cells[r + ':' + c];
  else this.cells[r + ':' + c] = cell;
};
MockSheet.prototype.getName = function () { return this.name; };
MockSheet.prototype.setName = function (n) { this.name = n; return this; };
MockSheet.prototype.getLastRow = function () {
  var max = 0;
  Object.keys(this.cells).forEach(function (k) { max = Math.max(max, Number(k.split(':')[0])); });
  return max;
};
MockSheet.prototype.getLastColumn = function () {
  var max = 0;
  Object.keys(this.cells).forEach(function (k) { max = Math.max(max, Number(k.split(':')[1])); });
  return max;
};
MockSheet.prototype.getMaxRows = function () { return Math.max(1000, this.getLastRow()); };
MockSheet.prototype.getRange = function (r, c, nr, nc) { return new MockRange(this, r, c, nr, nc); };
MockSheet.prototype.setFrozenRows = function (n) { this.frozen = n; };
MockSheet.prototype.appendRow = function (values) {
  var r = this.getLastRow() + 1;
  var self = this;
  values.forEach(function (v, j) { self.write(r, j + 1, v); });
};
/** Test helper: the row as stored values. */
MockSheet.prototype.row = function (r) {
  return this.getRange(r, 1, 1, Math.max(this.getLastColumn(), 1)).getValues()[0];
};

function MockSpreadsheet(sheets) {
  var self = this;
  this.sheets = [];
  Object.keys(sheets).forEach(function (name) { self.sheets.push(new MockSheet(name, sheets[name])); });
}
MockSpreadsheet.prototype.getSheetByName = function (n) {
  return this.sheets.filter(function (s) { return s.name === n; })[0] || null;
};
MockSpreadsheet.prototype.getSheets = function () { return this.sheets.slice(); };
MockSpreadsheet.prototype.insertSheet = function (n) { var s = new MockSheet(n, []); this.sheets.push(s); return s; };
MockSpreadsheet.prototype.getName = function () { return 'Test Store'; };

var SpreadsheetApp = {
  getActiveSpreadsheet: function () { return __mock.spreadsheet; },
  openById: function () { return __mock.spreadsheet; },
  flush: function () { __mock.flushes++; },
  newDataValidation: function () {
    var rule = {};
    var builder = {
      requireValueInList: function (list) { rule.list = list; return builder; },
      setAllowInvalid: function (v) { rule.allowInvalid = v; return builder; },
      build: function () { return rule; }
    };
    return builder;
  }
};

var LockService = {
  getScriptLock: function () {
    return {
      tryLock: function () {
        if (!__mock.lockAvailable || __mock.lockHeld) return false;
        __mock.lockHeld = true;
        __mock.lockAcquisitions++;
        if (__mock.onLockAcquired) __mock.onLockAcquired();
        return true;
      },
      releaseLock: function () { __mock.lockHeld = false; }
    };
  }
};

var CacheService = {
  getScriptCache: function () {
    return {
      get: function (k) { return Object.prototype.hasOwnProperty.call(__mock.cache, k) ? __mock.cache[k] : null; },
      put: function (k, v) {
        if (String(k).length > 250) throw new Error('Cache key too long');
        __mock.cache[k] = String(v);
      }
    };
  }
};

var PropertiesService = {
  getScriptProperties: function () {
    return { getProperty: function (k) { return Object.prototype.hasOwnProperty.call(__mock.props, k) ? __mock.props[k] : null; } };
  }
};

var MailApp = {
  sendEmail: function (msg) {
    if (__mock.mailFails) throw new Error('Service invoked too many times for one day: email.');
    __mock.sentEmails.push(msg);
    __mock.mailQuota--;
  },
  getRemainingDailyQuota: function () { return __mock.mailQuota; }
};

var Session = {
  getEffectiveUser: function () { return { getEmail: function () { return 'owner@example.com'; } }; },
  getActiveUser: function () { return { getEmail: function () { return __mock.activeUser; } }; }
};

var Utilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  computeDigest: function (alg, s) {
    // FNV-1a variants — collision-resistant enough for tests.
    var out = [];
    for (var seed = 0; seed < 4; seed++) {
      var h = 2166136261 ^ seed;
      for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
      out.push(h >>> 0);
    }
    return out;
  },
  base64EncodeWebSafe: function (arr) { return arr.map(function (n) { return n.toString(36); }).join('-'); }
};

var ContentService = {
  MimeType: { JSON: 'application/json' },
  createTextOutput: function (s) {
    return { content: s, mime: null, setMimeType: function (m) { this.mime = m; return this; }, getContent: function () { return this.content; } };
  }
};

var HtmlService = {
  XFrameOptionsMode: { DEFAULT: 'DEFAULT', ALLOWALL: 'ALLOWALL' },
  createTemplateFromFile: function (name) {
    return {
      evaluate: function () {
        var out = { name: name, title: '', meta: {}, setTitle: function (t) { this.title = t; return this; },
          addMetaTag: function (k, v) { this.meta[k] = v; return this; }, setXFrameOptionsMode: function () { return this; } };
        return out;
      }
    };
  },
  createHtmlOutputFromFile: function (name) { return { getContent: function () { return '<!-- ' + name + ' -->'; } }; }
};

resetMocks();
