#!/usr/bin/env node
/**
 * Runs the test suites with Node.js:  node tests/run-tests.js
 * Each suite gets a fresh V8 context, so it mirrors the Apps Script global scope.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const suites = JSON.parse(fs.readFileSync(path.join(__dirname, 'suites.json'), 'utf8'));

function source(rel) {
  let text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (rel.endsWith('.html')) text = text.match(/<script>([\s\S]*)<\/script>/)[1];
  return text;
}

async function runSuite(suite) {
  const ctx = vm.createContext({});
  for (const rel of suite.files) vm.runInContext(source(rel), ctx, { filename: rel });
  vm.runInContext('__startTests()', ctx);
  let status;
  for (let i = 0; i < 100000; i++) {
    await new Promise((r) => setImmediate(r));     // let promise callbacks run
    status = JSON.parse(vm.runInContext('__tick()', ctx));
    if (status.done) break;
  }
  let passed = 0;
  let failed = 0;
  for (const r of status.results || []) {
    if (r.ok) { passed++; console.log('  ✓ ' + r.name); }
    else { failed++; console.log('  ✗ ' + r.name + '\n      ' + r.error.split('\n')[0]); }
  }
  if (!status.done) { failed++; console.log('  ✗ suite did not finish'); }
  return { passed, failed };
}

(async () => {
  let passed = 0;
  let failed = 0;
  for (const suite of suites) {
    console.log('\n' + suite.name);
    const r = await runSuite(suite);
    passed += r.passed;
    failed += r.failed;
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
