/**
 * Tiny test harness that runs in plain V8 (Node's vm or py_mini_racer).
 * Provides test(), assert helpers, a console stub and fake timers.
 */
var __tests = [];
var __results = [];
var __done = false;
var __logs = [];

var console = {
  log: function () { __logs.push(['log', Array.prototype.join.call(arguments, ' ')]); },
  info: function () { __logs.push(['info', Array.prototype.join.call(arguments, ' ')]); },
  warn: function () { __logs.push(['warn', Array.prototype.join.call(arguments, ' ')]); },
  error: function () { __logs.push(['error', Array.prototype.join.call(arguments, ' ')]); }
};

/* ---- fake timers: advanced by the host via __tick() ---- */
var __timers = [];
var __now = 0;
var __timerSeq = 0;
function setTimeout(fn, ms) {
  var id = ++__timerSeq;
  __timers.push({ id: id, at: __now + (ms || 0), fn: fn });
  return id;
}
function clearTimeout(id) {
  __timers = __timers.filter(function (t) { return t.id !== id; });
}

function test(name, fn) { __tests.push({ name: name, fn: fn }); }

function assert(cond, message) {
  if (!cond) throw new Error('Assertion failed: ' + (message || ''));
}
function assertEqual(actual, expected, message) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error((message ? message + ': ' : '') + 'expected ' + e + ' but got ' + a);
}
function assertThrows(fn, pattern, message) {
  try { fn(); } catch (err) {
    if (pattern && !pattern.test(String(err && err.message))) {
      throw new Error((message || 'wrong error') + ': ' + err.message);
    }
    return err;
  }
  throw new Error('Expected an exception: ' + (message || ''));
}

/** Starts running all tests sequentially; async tests may return promises. */
function __startTests() {
  var i = 0;
  function next() {
    if (i >= __tests.length) { __done = true; return; }
    var t = __tests[i++];
    var started;
    try {
      if (typeof beforeEachTest === 'function') beforeEachTest();
      started = Promise.resolve(t.fn());
    } catch (err) {
      started = Promise.reject(err);
    }
    started.then(function () {
      __results.push({ name: t.name, ok: true });
    }, function (err) {
      __results.push({ name: t.name, ok: false, error: String(err && err.stack || err) });
    }).then(next);
  }
  next();
}

/** Runs the next due timer. Returns JSON status for the host loop. */
function __tick() {
  if (!__done && __timers.length) {
    __timers.sort(function (a, b) { return a.at - b.at || a.id - b.id; });
    var t = __timers.shift();
    __now = Math.max(__now, t.at);
    t.fn();
  }
  return JSON.stringify({ done: __done, results: __done ? __results : null });
}
