#!/usr/bin/env python3
"""
Runs the test suites in V8 via py_mini_racer (for machines without Node.js).

    python3 -m venv .venv && .venv/bin/pip install mini-racer
    .venv/bin/python tests/run_tests.py

With Node.js installed, `node tests/run-tests.js` runs the same suites.
"""
import json
import pathlib
import re
import sys

from py_mini_racer import MiniRacer

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
TESTS = ROOT / "tests"

SUITES = json.loads((TESTS / "suites.json").read_text())


def source(rel):
    text = (ROOT / rel).read_text(encoding="utf-8")
    if rel.endswith(".html"):
        # Logic.html / Api.html: keep only the <script> body.
        m = re.search(r"<script>(.*)</script>", text, re.S)
        text = m.group(1)
    return text


def run_suite(name, files):
    ctx = MiniRacer()
    for rel in files:
        try:
            ctx.eval(source(rel))
        except Exception as exc:  # noqa: BLE001
            print(f"  ✗ failed to load {rel}: {exc}")
            return 0, 1
    ctx.eval("__startTests()")
    status = None
    for _ in range(100000):
        status = json.loads(ctx.eval("__tick()"))
        if status["done"]:
            break
    results = status["results"] or []
    passed = 0
    for r in results:
        if r["ok"]:
            passed += 1
            print(f"  ✓ {r['name']}")
        else:
            print(f"  ✗ {r['name']}\n      {r['error'].splitlines()[0]}")
    if not status["done"]:
        print("  ✗ suite did not finish")
        return passed, len(results) - passed + 1
    return passed, len(results) - passed


def main():
    total_pass = total_fail = 0
    for suite in SUITES:
        print(f"\n{suite['name']}")
        p, f = run_suite(suite["name"], suite["files"])
        total_pass += p
        total_fail += f
    print(f"\n{total_pass} passed, {total_fail} failed")
    sys.exit(1 if total_fail else 0)


if __name__ == "__main__":
    main()
