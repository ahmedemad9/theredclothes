#!/usr/bin/env python3
"""
Browser tests for the storefront UI: real Chromium driving the local preview
(real frontend + real .gs backend on a mock spreadsheet).

    python3 -m venv .venv && .venv/bin/pip install playwright && .venv/bin/python -m playwright install chromium
    .venv/bin/python tests/ui_test.py            # add --screenshots DIR to save screenshots
    .venv/bin/python tests/ui_test.py --cloudflare   # same tests against the Cloudflare build (needs Node.js)

--cloudflare builds cloudflare/public/ and serves it with tests/cloudflare/dev-server.mjs:
the real Worker (static files + API routes) in front of the real .gs backend (mock spreadsheet, simulated
Google redirects). The page reaches the mock sheets through test-only /__test/ routes.

Covers colour bubbles, image switching, per-colour sizes, cart/checkout images,
old-cart migration, out-of-stock handling and the full order flow.
"""
import functools
import http.server
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import urllib.request
import sys
import threading
import time
import traceback

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
PREVIEW = ROOT / "preview"
TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


def check(cond, message):
    if not cond:
        raise AssertionError(message)


def eq(actual, expected, message=""):
    if actual != expected:
        raise AssertionError(f"{message}: expected {expected!r}, got {actual!r}")


# ---------------------------------------------------------------- helpers

def card(page, pid):
    return page.locator(f'.product-card[data-card-id="{pid.lower()}"]')


def card_image(page, pid):
    return card(page, pid).locator("img.card-image").get_attribute("src")


def click_swatch(scope, color):
    scope.locator(f'.swatch:has(input[value="{color}"])').click()


def open_product(page, pid):
    card(page, pid).get_by_role("button", name="View").click()
    page.wait_for_selector("#product-modal[open]")


def modal_sizes(page):
    """{size: enabled?} for the size buttons in the modal."""
    return page.eval_on_selector_all("#modal-sizes input", "els => Object.fromEntries(els.map(e => [e.value, !e.disabled]))")


def checked_size(page):
    return page.eval_on_selector_all("#modal-sizes input:checked", "els => els.map(e => e.value)")


def choose_size(page, size):
    page.locator(f'#modal-sizes .size-option:has(input[value="{size}"])').click()


def add_to_cart(page, pid, color, size, qty=1):
    open_product(page, pid)
    click_swatch(page.locator("#modal-colors"), color)
    choose_size(page, size)
    page.fill("#modal-qty", str(qty))
    page.dispatch_event("#modal-qty", "change")
    page.click("#modal-add")
    page.wait_for_selector("#product-modal:not([open])", state="attached")


def fresh(page, base):
    page.goto(base)
    page.evaluate("localStorage.clear()")
    page.goto(base)
    page.wait_for_selector(".product-card:not(.skeleton)")


def products_snapshot(page):
    return page.evaluate("JSON.stringify(__preview.products().cells)")


# ---------------------------------------------------------------- tests

@test
def one_card_per_product_id(page, base):
    fresh(page, base)
    ids = page.eval_on_selector_all(".product-card", "els => els.map(e => e.dataset.cardId)")
    eq(ids, ["p001", "p002", "p003", "p004", "p005", "p006", "p007", "p008"], "cards")
    eq(card(page, "P001").locator(".swatch").count(), 3, "P001 bubbles")
    eq(page.text_content("#result-count").strip(), "Showing all 8 results")


@test
def default_colour_and_stock_status(page, base):
    fresh(page, base)
    check(card_image(page, "P001").endswith("P001-red.svg"), "P001 defaults to first colour with stock (Red)")
    # P005: every colour sold out → first colour, badge, not purchasable.
    check(card_image(page, "P005").endswith("P005-sand.svg"), "P005 shows first colour")
    check(card(page, "P005").locator(".badge-out").is_visible(), "P005 badge")
    eq(card(page, "P005").locator(".stock").text_content(), "Out of stock")
    # Sold-out colour bubble is still shown, struck through.
    check(card(page, "P003").locator('.swatch.is-out:has(input[value="Burgundy"])').count() == 1, "Burgundy shown as out")


@test
def card_bubble_switches_image_immediately_without_opening_modal(page, base):
    fresh(page, base)
    before_p002 = card_image(page, "P002")
    click_swatch(card(page, "P001"), "Blue")
    check(card_image(page, "P001").endswith("P001-blue.svg"), "blue image")
    check(card(page, "P001").locator('input[value="Blue"]').is_checked(), "blue bubble selected")
    check(not page.locator("#product-modal[open]").count(), "modal stays closed")
    click_swatch(card(page, "P001"), "Green")
    check(card_image(page, "P001").endswith("P001-green.svg"), "green image")
    eq(card_image(page, "P002"), before_p002, "other cards unaffected")
    page.wait_for_function("() => { const i = document.querySelector('.product-card[data-card-id=p001] img');"
                           " return i.complete && i.naturalWidth > 0 && i.src.endsWith('P001-green.svg'); }")


@test
def card_selection_is_independent_and_survives_filtering(page, base):
    # Categories come from Config.gs; use the sample products' categories so the test does not depend on it.
    page.add_init_script("""Object.defineProperty(window, 'STORE_CONFIG', { configurable: true,
        get() { return this.__cfg; }, set(v) { v.categories = ['Hoodies', 'Printed', 'Shirt']; this.__cfg = v; } });""")
    fresh(page, base)
    click_swatch(card(page, "P001"), "Green")
    click_swatch(card(page, "P002"), "White")
    check(card_image(page, "P001").endswith("green.svg") and card_image(page, "P002").endswith("white.svg"), "independent")
    page.check('#category-list input[value="Hoodies"]')
    eq(page.eval_on_selector_all(".product-card", "els => els.map(e => e.dataset.cardId)"), ["p001"], "Hoodies only")
    page.check('#category-list input[value="Printed"]')
    eq(page.eval_on_selector_all(".product-card", "els => els.map(e => e.dataset.cardId)"), ["p001", "p002"], "Hoodies or Printed")
    page.uncheck('#category-list input[value="Hoodies"]')
    page.uncheck('#category-list input[value="Printed"]')
    eq(page.locator(".product-card").count(), 8, "all products again")
    check(card_image(page, "P001").endswith("green.svg"), "selection kept after re-render")


@test
def selecting_sold_out_colour_on_card_shows_its_image_and_badge(page, base):
    fresh(page, base)
    click_swatch(card(page, "P003"), "Burgundy")
    check(card_image(page, "P003").endswith("P003-burgundy.svg"), "burgundy image")
    check(card(page, "P003").locator(".badge-out").is_visible(), "badge for sold-out colour")
    eq(card(page, "P003").locator(".stock").text_content(), "Burgundy is out of stock")
    click_swatch(card(page, "P003"), "Navy")
    check(not card(page, "P003").locator(".badge-out").is_visible(), "badge hidden again")


@test
def modal_preserves_card_colour_and_shows_its_sizes(page, base):
    fresh(page, base)
    click_swatch(card(page, "P001"), "Green")
    open_product(page, "P001")
    check(page.get_attribute("#modal-image", "src").endswith("P001-green.svg"), "modal image green")
    eq(page.text_content("#modal-color-name"), "Green")
    eq(modal_sizes(page), {"S": False, "M": False, "L": True, "XL": True, "XXL": False}, "Green sizes")
    check(page.is_disabled("#modal-add"), "Add disabled before choosing a size")
    eq(page.text_content("#modal-add"), "Select a size")


@test
def modal_colour_switch_updates_image_sizes_label_and_card(page, base):
    fresh(page, base)
    open_product(page, "P001")
    click_swatch(page.locator("#modal-colors"), "Blue")
    check(page.get_attribute("#modal-image", "src").endswith("P001-blue.svg"), "blue")
    eq(page.text_content("#modal-color-name"), "Blue")
    eq(modal_sizes(page), {"S": True, "M": True, "L": True, "XL": True, "XXL": True}, "Blue sizes")
    click_swatch(page.locator("#modal-colors"), "Red")
    check(page.get_attribute("#modal-image", "src").endswith("P001-red.svg"), "red")
    eq(modal_sizes(page), {"S": True, "M": True, "L": False, "XL": False, "XXL": True}, "Red sizes")
    page.keyboard.press("Escape")
    check(card_image(page, "P001").endswith("P001-red.svg"), "card follows modal choice")


@test
def size_resets_only_when_unavailable_in_new_colour(page, base):
    fresh(page, base)
    open_product(page, "P001")
    click_swatch(page.locator("#modal-colors"), "Blue")
    choose_size(page, "L")
    eq(checked_size(page), ["L"])
    check(page.is_enabled("#modal-add"), "enabled with colour + size")
    click_swatch(page.locator("#modal-colors"), "Red")          # Red L = 0
    eq(checked_size(page), [], "L cleared")
    check("Size L is not available in Red" in page.text_content("#modal-size-error"), "explains reset")
    check(page.is_disabled("#modal-add"), "disabled again")
    choose_size(page, "M")
    click_swatch(page.locator("#modal-colors"), "Blue")         # Blue M = 1
    eq(checked_size(page), ["M"], "M kept")


@test
def unavailable_sizes_cannot_be_selected(page, base):
    fresh(page, base)
    open_product(page, "P001")                                   # Red
    page.locator('#modal-sizes .size-option:has(input[value="L"])').click(force=True)
    eq(checked_size(page), [], "disabled L not selectable")
    check(page.is_disabled("#modal-add"), "still disabled")
    deco = page.eval_on_selector('#modal-sizes input[value="L"] + span', "e => getComputedStyle(e).textDecorationLine")
    eq(deco, "line-through", "crossed out")


@test
def sold_out_colour_in_modal_disables_everything(page, base):
    fresh(page, base)
    open_product(page, "P003")
    click_swatch(page.locator("#modal-colors"), "Burgundy")
    check(page.get_attribute("#modal-image", "src").endswith("P003-burgundy.svg"), "shows its image")
    check(page.is_visible("#modal-badge"), "badge")
    check(page.is_visible("#modal-color-note"), "out of stock label")
    check(not any(modal_sizes(page).values()), "all sizes disabled")
    check(page.is_disabled("#modal-add"), "add disabled")
    eq(page.text_content("#modal-add"), "Out of Stock")
    # Forcing a submit still adds nothing.
    page.evaluate("document.getElementById('modal-form').requestSubmit()")
    eq(page.text_content("#cart-count"), "0")


@test
def cart_identity_and_colour_images(page, base):
    fresh(page, base)
    add_to_cart(page, "P001", "Blue", "L", 2)
    add_to_cart(page, "P001", "Red", "M", 1)
    add_to_cart(page, "P001", "Blue", "L", 1)                   # merges
    add_to_cart(page, "P001", "Red", "S", 1)
    eq(page.text_content("#cart-count"), "5")
    page.click("#cart-button")
    lines = page.eval_on_selector_all(".cart-item", """els => els.map(e => ({
        meta: e.querySelector('.cart-item-meta').textContent,
        qty: e.querySelector('output').textContent,
        img: e.querySelector('img').getAttribute('src').split('/').pop() }))""")
    eq([l["img"] for l in lines], ["P001-blue.svg", "P001-red.svg", "P001-red.svg"], "line images")
    eq([l["qty"] for l in lines], ["3", "1", "1"])
    check(lines[0]["meta"].startswith("Color: Blue · Size: L"), lines[0]["meta"])
    stored = json.loads(page.evaluate("localStorage.getItem('store.cart.v2')"))["items"]
    eq([(i["productId"], i["color"], i["size"], i["quantity"]) for i in stored],
       [("P001", "Blue", "L", 3), ("P001", "Red", "M", 1), ("P001", "Red", "S", 1)], "stored identity")
    page.reload()
    page.wait_for_selector(".product-card:not(.skeleton)")
    eq(page.text_content("#cart-count"), "5", "persists across reload")


@test
def checkout_review_and_successful_reservation_leave_stock_unchanged(page, base):
    fresh(page, base)
    page.evaluate("__preview.delayMs = 0")
    add_to_cart(page, "P001", "Blue", "L", 2)
    add_to_cart(page, "P002", "White", "XL", 1)
    page.click("#cart-button")
    page.click("#checkout-button")
    page.wait_for_selector("#view-checkout:not([hidden])")
    rows = page.eval_on_selector_all("#summary-body tr", """els => els.map(r => ({
        img: r.querySelector('img').getAttribute('src').split('/').pop(),
        text: r.querySelector('td').textContent, qty: r.children[1].textContent }))""")
    eq([r["img"] for r in rows], ["P001-blue.svg", "P002-white.svg"], "summary images")
    check("Color: Blue · Size: L" in rows[0]["text"], rows[0]["text"])
    eq(page.text_content("#summary-subtotal").replace("\xa0", " "), "EGP 2,247.00")

    before = products_snapshot(page)
    page.fill("#f-name", "Jane Doe")
    page.fill("#f-phone", "+20 10 1234 5678")
    page.fill("#f-email", "jane@example.com")
    page.fill("#f-address", "12 Tahrir Street\nCairo 11511\nEgypt")
    page.click("#reserve-button")
    page.wait_for_selector("#view-thanks:not([hidden])")
    ref = page.text_content("#thanks-ref")
    check(len(ref) == 6 and ref[0] == "#" and ref[1:].isdigit(), ref)
    row = page.evaluate("__preview.orders().row(2)")
    eq(row[1], ref[1:], "order id")
    eq(row[6], "P001 | Classic Hoodie | Blue | L | Qty: 2\nP002 | Printed T-Shirt | White | XL | Qty: 1", "Cart Items")
    eq(row[7], 2247, "total")
    eq(row[8], "Pending")
    eq(products_snapshot(page), before, "stock cells unchanged")
    eq(page.text_content("#cart-count"), "0", "cart cleared after success")


@test
def stock_change_before_checkout_is_reconciled(page, base):
    fresh(page, base)
    add_to_cart(page, "P002", "Black", "S", 1)
    add_to_cart(page, "P002", "Black", "M", 1)
    # Owner sets P002 Black S to 0 (row 5 = P002 Black, column I = S).
    page.evaluate("__preview.products().getRange(5, 9).setValue(0)")
    page.click("#cart-button")
    page.click("#checkout-button")
    page.wait_for_function("() => document.querySelectorAll('#summary-body tr').length === 1")
    check("size S is out of stock" in page.text_content("#summary-notices"), page.text_content("#summary-notices"))


@test
def server_rejects_combination_sold_out_after_page_loaded(page, base):
    fresh(page, base)
    page.evaluate("__preview.delayMs = 0")
    add_to_cart(page, "P001", "Blue", "M", 1)
    page.click("#cart-button")
    page.click("#checkout-button")
    page.wait_for_selector("#view-checkout:not([hidden])")
    page.wait_for_timeout(100)
    page.evaluate("__preview.products().getRange(3, 10).setValue(0)")   # P001 Blue M → 0 after checkout opened
    page.fill("#f-name", "Jane Doe")
    page.fill("#f-phone", "+20 10 1234 5678")
    page.fill("#f-email", "jane@example.com")
    page.fill("#f-address", "12 Tahrir Street\nCairo 11511\nEgypt")
    page.click("#reserve-button")
    page.wait_for_selector("#checkout-alert:not([hidden])")
    check("in Blue, size M is out of stock" in page.text_content("#checkout-alert"), page.text_content("#checkout-alert"))
    eq(page.evaluate("__preview.orders().getLastRow()"), 1, "nothing saved")
    page.wait_for_function("() => document.querySelectorAll('#summary-body tr').length === 0")


@test
def broken_image_shows_fallback(page, base):
    fresh(page, base)
    page.wait_for_function("() => document.querySelector('.product-card[data-card-id=p008] img').src.startsWith('data:image/svg')")


@test
def slow_failing_image_never_overrides_a_later_colour(page, base):
    def slow_fail(route):
        time.sleep(0.8)
        route.abort()
    fresh(page, base)
    page.route("**/P001-green.svg", slow_fail)
    click_swatch(card(page, "P001"), "Green")
    click_swatch(card(page, "P001"), "Blue")
    page.wait_for_timeout(1300)
    check(card_image(page, "P001").endswith("P001-blue.svg"), "still blue after green failed: " + card_image(page, "P001"))
    page.unroute("**/P001-green.svg")


@test
def old_cart_entries_require_review_and_are_never_guessed(page, base):
    page.goto(base)
    page.evaluate("""localStorage.clear(); localStorage.setItem('store.cart.v1', JSON.stringify({ items: [
        { name: 'Classic Hoodie', size: 'M', quantity: 2, unitPrice: 899 },
        { name: 'Classic Pocket Tee', size: 'S', quantity: 1, unitPrice: 399 } ] }))""")
    page.goto(base)
    page.wait_for_selector(".product-card:not(.skeleton)")
    page.click("#cart-button")
    review = page.locator(".cart-item.needs-review")
    eq(review.count(), 1, "multi-colour product needs review")
    check("Please choose a colour" in review.text_content(), review.text_content())
    lines = page.eval_on_selector_all(".cart-item:not(.needs-review) .cart-item-meta", "els => els.map(e => e.textContent)")
    check(lines and lines[0].startswith("Color: Forest Green · Size: S"), f"single-colour product converted: {lines}")
    check(page.is_disabled("#checkout-button"), "checkout blocked while review pending")
    # Resolve it by choosing a colour.
    review.get_by_role("button", name="Choose colour").click()
    page.wait_for_selector("#product-modal[open]")
    click_swatch(page.locator("#modal-colors"), "Blue")
    choose_size(page, "M")
    eq(page.input_value("#modal-qty"), "2", "quantity carried over")
    page.click("#modal-add")
    page.click("#cart-button")
    eq(page.locator(".cart-item.needs-review").count(), 0, "review line replaced")
    check(page.is_enabled("#checkout-button"), "checkout enabled")
    stored = json.loads(page.evaluate("localStorage.getItem('store.cart.v2')"))["items"]
    eq(sorted((i["productId"], i["color"], i["size"], i["quantity"]) for i in stored),
       [("P001", "Blue", "M", 2), ("P007", "Forest Green", "S", 1)])


@test
def mobile_layout_has_no_horizontal_overflow(page, base):
    page.set_viewport_size({"width": 360, "height": 800})
    fresh(page, base)
    eq(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), True, "no overflow on shop")
    open_product(page, "P001")
    eq(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), True, "no overflow with modal")
    page.set_viewport_size({"width": 1366, "height": 900})


def background_requests(page):
    seen = []
    page.on("request", lambda r: seen.append(r.url.rsplit("/", 1)[-1]) if "/assets/" in r.url else None)
    return seen


def wait_for_background(page, name):
    page.wait_for_function(f"() => (document.getElementById('site-bg').dataset.bg || '').endsWith('{name}')")


@test
def desktop_gets_landscape_gif_only(page, base):
    seen = background_requests(page)
    fresh(page, base)
    wait_for_background(page, "background-desktop.gif")
    check(not [s for s in seen if "mobile" in s], f"mobile files not downloaded: {seen}")


@test
def mobile_gets_portrait_gif_only(page, base):
    page.set_viewport_size({"width": 390, "height": 844})
    seen = background_requests(page)
    fresh(page, base)
    wait_for_background(page, "background-mobile.gif")
    check(not [s for s in seen if "desktop" in s], f"desktop files not downloaded: {seen}")
    page.set_viewport_size({"width": 1366, "height": 900})
    wait_for_background(page, "background-desktop.gif")   # switches when the window crosses the breakpoint


@test
def background_covers_viewport_stays_fixed_and_ignores_clicks(page, base):
    fresh(page, base)
    wait_for_background(page, "background-desktop.gif")
    info = page.evaluate("""() => {
        const bg = document.getElementById('site-bg'), cs = getComputedStyle(bg), r = bg.getBoundingClientRect();
        return { pos: cs.position, z: cs.zIndex, events: cs.pointerEvents, size: cs.backgroundSize,
                 at: cs.backgroundPosition, repeat: cs.backgroundRepeat,
                 covers: r.left <= 0 && r.top <= 0 && r.right >= innerWidth && r.bottom >= innerHeight };
    }""")
    eq(info, {"pos": "fixed", "z": "-1", "events": "none", "size": "cover", "at": "50% 50%",
              "repeat": "no-repeat", "covers": True}, "background layer")
    # Content above it still receives clicks.
    hit = page.evaluate("""() => { const b = document.querySelector('.product-card .btn').getBoundingClientRect();
        return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2).closest('.product-card') !== null; }""")
    eq(hit, True, "card button is clickable above the background")
    page.mouse.wheel(0, 1500)
    page.wait_for_timeout(300)
    eq(page.evaluate("document.getElementById('site-bg').getBoundingClientRect().top"), 0, "fixed while scrolling")


@test
def reduced_motion_gets_still_image_only(page, base):
    page.emulate_media(reduced_motion="reduce")
    seen = background_requests(page)
    fresh(page, base)
    wait_for_background(page, "background-desktop-static.jpg")
    page.wait_for_timeout(500)
    check(not [s for s in seen if s.endswith(".gif")], f"no GIF downloaded: {seen}")


@test
def failed_gif_keeps_still_and_store_works(page, base):
    page.route("**/*.gif", lambda route: route.abort())
    fresh(page, base)
    wait_for_background(page, "background-desktop-static.jpg")
    page.wait_for_timeout(500)
    wait_for_background(page, "background-desktop-static.jpg")
    add_to_cart(page, "P001", "Blue", "L")
    eq(page.text_content("#cart-count"), "1", "cart still works")


@test
def background_stays_behind_drawer_modal_and_checkout(page, base):
    fresh(page, base)
    wait_for_background(page, "background-desktop.gif")
    open_product(page, "P001")
    page.keyboard.press("Escape")
    add_to_cart(page, "P001", "Blue", "L")
    page.click("#cart-button")
    page.wait_for_timeout(300)
    check(page.evaluate("() => !!document.elementFromPoint(innerWidth - 50, 200).closest('#cart-drawer')"),
          "drawer is on top")
    page.click("#checkout-button")
    page.wait_for_selector("#view-checkout:not([hidden])")
    page.fill("#f-name", "Jane Doe")   # form inputs still usable
    eq(page.input_value("#f-name"), "Jane Doe")
    eq(page.evaluate("document.getElementById('site-bg').dataset.bg.endsWith('background-desktop.gif')"), True,
       "same background across views")


@test
def contact_details_hidden_when_empty_and_listed_when_set(page, base):
    # Contact details come from Config.gs; force them empty, then set, so the test does not depend on it.
    page.add_init_script("""Object.defineProperty(window, 'STORE_CONFIG', { configurable: true,
        get() { return this.__cfg; }, set(v) { v.contact = {}; this.__cfg = v; } });""")
    fresh(page, base)
    check(page.is_hidden("#contact-us"), "no Contact us column without details")
    eq(page.text_content("#contact h2"), "Ordering", "menu Contact link still has a target")
    page.add_init_script("""Object.defineProperty(window, 'STORE_CONFIG', { configurable: true,
        get() { return this.__cfg; },
        set(v) { v.contact = { phone: '+20 10 1234 5678', whatsapp: '201012345678', email: 'hi@shop.com',
                 instagram: 'https://www.instagram.com/theredshop', facebook: '', tiktok: '', address: '12 Tahrir St\\nCairo' };
                 this.__cfg = v; } });""")
    page.goto(base)
    page.wait_for_selector("#contact-list li")
    links = page.eval_on_selector_all("#contact a", "els => els.map(a => [a.textContent, a.getAttribute('href')])")
    eq(links, [["+20 10 1234 5678", "tel:+201012345678"], ["+201012345678", "https://wa.me/201012345678"],
               ["hi@shop.com", "mailto:hi@shop.com"], ["Instagram", "https://www.instagram.com/theredshop"]], "contact links")
    check("Cairo" in page.text_content("#contact"), "address shown")
    eq(page.locator("[id=contact]").count(), 1, "one #contact anchor")


def modal_thumbs(page):
    """[(image file, highlighted?)] for the popup thumbnails, or None when hidden."""
    if page.is_hidden("#modal-thumbs"):
        return None
    return page.eval_on_selector_all("#modal-thumbs .modal-thumb", """els => els.map(b =>
        [b.querySelector('img').getAttribute('src').split('/').pop(), b.getAttribute('aria-pressed') === 'true'])""")


def modal_image(page):
    return page.get_attribute("#modal-image", "src").split("/").pop()


@test
def second_image_only_in_product_page_with_selectable_thumbnails(page, base):
    fresh(page, base)
    check(not page.locator(".product-card img[src*='-back']").count(), "main page never shows Image Link 2")
    open_product(page, "P001")   # card default colour: Red
    eq(modal_image(page), "P001-red.svg", "opens on Image Link")
    eq(modal_thumbs(page), [["P001-red.svg", True], ["P001-red-back.svg", False]], "two thumbnails, current highlighted")
    page.click("#modal-thumbs .modal-thumb[data-image='2']")
    eq(modal_image(page), "P001-red-back.svg", "second image shown")
    eq(modal_thumbs(page), [["P001-red.svg", False], ["P001-red-back.svg", True]], "highlight moves")
    check(card_image(page, "P001").endswith("P001-red.svg"), "card keeps Image Link")
    page.click("#modal-thumbs .modal-thumb[data-image='1']")
    eq(modal_image(page), "P001-red.svg", "back to first image")
    page.click("#modal-thumbs .modal-thumb[data-image='2']")
    click_swatch(page.locator("#modal-colors"), "Blue")
    eq(modal_image(page), "P001-blue.svg", "new colour starts on its main image")
    eq(modal_thumbs(page), [["P001-blue.svg", True], ["P001-blue-back.svg", False]], "thumbnails follow colour")
    page.keyboard.press("Escape")
    page.wait_for_selector("#product-modal:not([open])", state="attached")
    open_product(page, "P007")   # no Image Link 2
    eq(modal_thumbs(page), None, "no thumbnails without a second image")
    eq(modal_image(page), "P007-forest-green.svg")


def swipe(page, selector, dx, dy=0):
    """A real one-finger touch drag across the element's centre (Chrome DevTools touch events)."""
    box = page.locator(selector).bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    cdp = page.context.new_cdp_session(page)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
    for i in range(1, 6):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x + dx * i / 5, "y": y + dy * i / 5}]})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(50)


@test
def phone_swipe_switches_between_the_two_images(page, base):
    phone = page.context.browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    try:
        page = phone.new_page()
        fresh(page, base)
        open_product(page, "P001")
        eq(modal_image(page), "P001-red.svg", "starts on Image Link")
        swipe(page, "#modal-image", -150)
        eq(modal_image(page), "P001-red-back.svg", "swipe left → image 2")
        eq(modal_thumbs(page), [["P001-red.svg", False], ["P001-red-back.svg", True]], "highlight follows the swipe")
        swipe(page, "#modal-image", -150)
        eq(modal_image(page), "P001-red.svg", "swipe left on the last image wraps around to image 1")
        swipe(page, "#modal-image", 150)
        eq(modal_image(page), "P001-red-back.svg", "swipe right on image 1 wraps around to image 2")
        swipe(page, "#modal-image", 150)
        eq(modal_image(page), "P001-red.svg", "swipe right → image 1")
        swipe(page, "#modal-image", -20)
        eq(modal_image(page), "P001-red.svg", "a tiny drag is not a swipe")
        swipe(page, "#modal-image", -60, 200)
        eq(modal_image(page), "P001-red.svg", "a mostly vertical drag (scrolling) is not a swipe")
        page.keyboard.press("Escape")
        page.wait_for_selector("#product-modal:not([open])", state="attached")
        open_product(page, "P007")   # no Image Link 2
        swipe(page, "#modal-image", -150)
        eq(modal_image(page), "P007-forest-green.svg", "nothing to swipe to without a second image")
    finally:
        phone.close()


def lightbox_state(page):
    return page.evaluate("""() => {
        const box = document.getElementById('lightbox');
        const f = document.getElementById('lightbox-frame').getBoundingClientRect();
        const img = document.getElementById('lightbox-image');
        const r = img.getBoundingClientRect();
        return { open: box.open, productOpen: document.getElementById('product-modal').open,
                 rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
                 frame: { width: f.width, height: f.height }, vw: innerWidth, vh: innerHeight,
                 img: (img.getAttribute('src') || '').split('/').pop(),
                 transform: img.style.transform,
                 widthPct: Math.round(f.width / innerWidth * 100), heightPct: Math.round(f.height / innerHeight * 100),
                 blur: getComputedStyle(box, '::backdrop').backdropFilter };
    }""")


def settle(page):
    """Waits until the enlarged-image layer has no running animation or transition."""
    page.wait_for_function("""() => document.getElementById('lightbox').getAnimations({ subtree: true })
        .every(a => a.playState !== 'running')""")
    page.wait_for_timeout(50)


def scale_of(state):
    import re
    m = re.search(r"scale\(([\d.]+)\)", state["transform"])
    return float(m.group(1)) if m else 1.0


@test
def desktop_image_opens_enlarged_zooms_and_halo_returns_to_product(page, base):
    fresh(page, base)
    open_product(page, "P001")
    page.click("#modal-thumbs .modal-thumb[data-image='2']")
    page.click("#modal-image")
    page.wait_for_selector("#lightbox[open]")
    settle(page)
    st = lightbox_state(page)
    eq(st["img"], "P001-red-back.svg", "shows the image currently in the product view")
    eq((st["widthPct"], st["heightPct"]), (70, 70), "fills 70% of the screen")
    check("blur" in st["blur"], f"blurred surroundings: {st['blur']}")
    check(st["productOpen"], "product view stays open underneath")

    box = page.locator("#lightbox-frame").bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    st = lightbox_state(page)
    r = st["rect"]
    check(r["width"] <= st["frame"]["width"] + 1 and r["height"] <= st["frame"]["height"] + 1
          and (abs(r["width"] - st["frame"]["width"]) < 2 or abs(r["height"] - st["frame"]["height"]) < 2),
          f"unzoomed picture fits the 70% box: {r} in {st['frame']}")
    page.mouse.click(cx + 20, cy + 20)
    settle(page)
    st = lightbox_state(page)
    eq(scale_of(st), 2.5, "click zooms in")
    check(st["rect"]["height"] > st["frame"]["height"] + 10, f"zoomed picture grows past the 70% box: {st['rect']}")
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx - 80, cy - 40, steps=5)
    page.mouse.up()
    eq(scale_of(lightbox_state(page)), 2.5, "dragging pans without changing the zoom")
    page.mouse.click(cx, cy)
    settle(page)
    eq(lightbox_state(page)["transform"], "translate(0px, 0px) scale(1)", "click again zooms out")
    page.mouse.move(cx, cy)
    page.mouse.wheel(0, -400)
    settle(page)
    check(scale_of(lightbox_state(page)) > 1.5, "mouse wheel zooms in")
    for _ in range(6):
        page.mouse.wheel(0, -600)
    settle(page)
    st = lightbox_state(page)
    r = st["rect"]
    check(r["left"] <= 0 and r["top"] <= 0 and r["right"] >= st["vw"] and r["bottom"] >= st["vh"],
          f"fully zoomed picture fills the screen and is cropped by its edges: {r}")
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx + 3000, cy + 3000, steps=8)   # try to drag it far off
    page.mouse.up()
    settle(page)
    r = lightbox_state(page)["rect"]
    check(abs(r["left"]) < 1 and abs(r["top"]) < 1, f"dragging stops at the picture's edge, no gap: {r}")
    page.mouse.click(cx, cy)   # zoom out
    settle(page)

    page.mouse.click(20, 450)   # the blurred halo
    page.wait_for_selector("#lightbox:not([open])", state="attached")
    st = lightbox_state(page)
    check(st["productOpen"], "back to the product view")
    eq(modal_image(page), "P001-red-back.svg", "same image as before")

    page.click("#modal-image")
    page.wait_for_selector("#lightbox[open]")
    settle(page)
    page.mouse.click(cx, cy)   # zoom in 2.5x; the picture is still narrower than the screen
    settle(page)
    r = lightbox_state(page)["rect"]
    check(r["left"] > 30, f"zoomed but narrower than the screen: stays centred with halo beside it: {r}")
    page.mouse.click(r["left"] - 15, cy)   # halo next to the zoomed picture
    page.wait_for_selector("#lightbox:not([open])", state="attached")

    page.focus("#modal-image")
    page.keyboard.press("Enter")
    page.wait_for_selector("#lightbox[open]")
    settle(page)
    eq(lightbox_state(page)["transform"], "translate(0px, 0px) scale(1)", "opens unzoomed")
    page.keyboard.press("Escape")
    page.wait_for_selector("#lightbox:not([open])", state="attached")
    check(lightbox_state(page)["productOpen"], "Escape closes only the enlarged image")


@test
def phone_tap_opens_enlarged_image_pinch_zooms_and_halo_closes(page, base):
    phone = page.context.browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    try:
        page = phone.new_page()
        fresh(page, base)
        open_product(page, "P001")
        swipe(page, "#modal-image", -150)
        page.wait_for_timeout(100)   # a quick tap right after a swipe must still register
        check(not lightbox_state(page)["open"], "a swipe changes the image, it does not enlarge it")
        page.tap("#modal-image")
        page.wait_for_selector("#lightbox[open]")
        settle(page)
        st = lightbox_state(page)
        eq(st["img"], "P001-red-back.svg", "the swiped-to image")
        eq((st["widthPct"], st["heightPct"]), (70, 70), "fills 70% of the screen")

        box = page.locator("#lightbox-frame").bounding_box()
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        cdp = page.context.new_cdp_session(page)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": cx - 20, "y": cy, "id": 1}, {"x": cx + 20, "y": cy, "id": 2}]})
        for i in range(1, 8):
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": cx - 20 - 12 * i, "y": cy, "id": 1}, {"x": cx + 20 + 12 * i, "y": cy, "id": 2}]})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        settle(page)
        st = lightbox_state(page)
        check(scale_of(st) > 2, f"pinch zooms in: {st['transform']}")
        r = st["rect"]
        check(r["width"] > st["frame"]["width"] + 10, f"zoomed picture grows past the 70% box: {r}")
        check(r["top"] <= 0 and r["bottom"] >= st["vh"], f"and once taller than the screen it is cropped by it: {r}")

        page.tap("#lightbox-close")   # the picture fills the screen; the close button stays on top
        page.wait_for_selector("#lightbox:not([open])", state="attached")
        check(lightbox_state(page)["productOpen"], "back to the product view")
        page.tap("#modal-image")
        page.wait_for_selector("#lightbox[open]")
        settle(page)
        page.touchscreen.tap(195, 30)   # unzoomed: the blurred halo above the picture
        page.wait_for_selector("#lightbox:not([open])", state="attached")
        check(lightbox_state(page)["productOpen"], "halo tap returns to the product view")
    finally:
        phone.close()


def lightbox_image(page):
    return page.get_attribute("#lightbox-image", "src").split("/").pop()


@test
def phone_swipes_in_enlarged_view_wrap_around_and_sync_the_product_view(page, base):
    phone = page.context.browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    try:
        page = phone.new_page()
        fresh(page, base)
        open_product(page, "P001")
        page.tap("#modal-image")
        page.wait_for_selector("#lightbox[open]")
        settle(page)
        eq(lightbox_image(page), "P001-red.svg")
        swipe(page, "#lightbox-frame", -150)
        eq(lightbox_image(page), "P001-red-back.svg", "swipe left → image 2")
        eq(lightbox_state(page)["transform"], "translate(0px, 0px) scale(1)", "a swipe does not zoom")
        swipe(page, "#lightbox-frame", -150)
        eq(lightbox_image(page), "P001-red.svg", "swipe left on the last image wraps to image 1")
        swipe(page, "#lightbox-frame", 150)
        eq(lightbox_image(page), "P001-red-back.svg", "swipe right on image 1 wraps to image 2")
        swipe(page, "#lightbox-frame", -60, 200)
        eq(lightbox_image(page), "P001-red-back.svg", "a mostly vertical drag is not a swipe")

        page.tap("#lightbox-frame")   # zoom in; now a drag pans instead of switching
        settle(page)
        check(scale_of(lightbox_state(page)) > 1, "tap zooms")
        swipe(page, "#lightbox-frame", -150)
        eq(lightbox_image(page), "P001-red-back.svg", "zoomed: dragging pans, it does not switch")
        page.tap("#lightbox-image")   # zoom back out
        settle(page)
        eq(lightbox_state(page)["transform"], "translate(0px, 0px) scale(1)", "tap zooms out")

        page.touchscreen.tap(195, 30)   # the blurred halo
        page.wait_for_selector("#lightbox:not([open])", state="attached")
        eq(modal_image(page), "P001-red-back.svg", "product view shows the image last seen enlarged")
        eq(modal_thumbs(page), [["P001-red.svg", False], ["P001-red-back.svg", True]], "thumbnail highlight synced")

        page.keyboard.press("Escape")
        page.wait_for_selector("#product-modal:not([open])", state="attached")
        open_product(page, "P007")   # one image only
        page.tap("#modal-image")
        page.wait_for_selector("#lightbox[open]")
        settle(page)
        swipe(page, "#lightbox-frame", -150)
        eq(lightbox_image(page), "P007-forest-green.svg", "nothing to switch to with one image")
    finally:
        phone.close()


@test
def desktop_drag_and_arrow_keys_switch_images_in_enlarged_view(page, base):
    fresh(page, base)
    open_product(page, "P002")
    page.click("#modal-image")
    page.wait_for_selector("#lightbox[open]")
    settle(page)
    box = page.locator("#lightbox-frame").bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(cx + 100, cy)
    page.mouse.down()
    page.mouse.move(cx - 100, cy, steps=6)
    page.mouse.up()
    eq(lightbox_image(page), "P002-black-back.svg", "mouse drag left → next image")
    eq(lightbox_state(page)["transform"], "translate(0px, 0px) scale(1)", "a drag-swipe does not zoom")
    page.keyboard.press("ArrowRight")
    eq(lightbox_image(page), "P002-black.svg", "→ on the last image wraps to the first")
    page.keyboard.press("ArrowLeft")
    eq(lightbox_image(page), "P002-black-back.svg", "← on the first image wraps to the last")
    page.keyboard.press("Escape")
    page.wait_for_selector("#lightbox:not([open])", state="attached")
    eq(modal_image(page), "P002-black-back.svg", "product view in sync")


@test
def cart_uses_first_image_even_after_viewing_second(page, base):
    fresh(page, base)
    open_product(page, "P002")
    page.click("#modal-thumbs .modal-thumb[data-image='2']")
    choose_size(page, "S")
    page.click("#modal-add")
    page.click("#cart-button")
    eq(page.get_attribute(".cart-item img", "src").split("/").pop(), "P002-black.svg")


# ---------------------------------------------------------------- runner

# --cloudflare: window.__preview backed by the dev server's /__test/ routes (sync XHR),
# so the tests above run unchanged against the Cloudflare build.
CLOUDFLARE_SHIM = """
(function () {
  function x(method, path, body) {
    var r = new XMLHttpRequest();
    r.open(method, path, false);
    if (body) r.setRequestHeader('Content-Type', 'application/json');
    r.send(body || null);
    return JSON.parse(r.responseText);
  }
  function sheet(name) {
    var q = 'sheet=' + encodeURIComponent(name);
    return {
      get cells() { return x('GET', '/__test/cells?' + q); },
      row: function (n) { return x('GET', '/__test/row?' + q + '&row=' + n); },
      getLastRow: function () { return x('GET', '/__test/lastRow?' + q); },
      getRange: function (r, c) {
        return { setValue: function (v) { x('POST', '/__test/set', JSON.stringify({ sheet: name, row: r, col: c, value: v })); } };
      }
    };
  }
  var delay = 700;
  window.__preview = {
    orders: function () { return sheet('Orders'); },
    products: function () { return sheet('Products'); },
    get delayMs() { return delay; },
    set delayMs(v) { delay = v; x('GET', '/__test/delay?ms=' + v); }
  };
})();
"""


def start_cloudflare_server():
    node = os.environ.get("NODE") or shutil.which("node")
    if not node:
        sys.exit("--cloudflare needs Node.js (set NODE=/path/to/node or put node on PATH)")
    sys.path.insert(0, str(ROOT / "tools"))
    import build_preview  # noqa: E402  (writes preview/img and gives the sample rows)
    rows = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump(build_preview.sample_rows(), rows)
    rows.close()
    subprocess.run([node, str(ROOT / "tools/build_cloudflare.mjs")], check=True, stdout=subprocess.DEVNULL)
    proc = subprocess.Popen([node, str(ROOT / "tests/cloudflare/dev-server.mjs"), rows.name],
                            stdout=subprocess.PIPE, text=True)
    line = proc.stdout.readline()
    if not line.startswith("READY "):
        proc.kill()
        sys.exit("dev server did not start: " + line)
    return proc, line.split()[1], rows.name

def main():
    shots = None
    if "--screenshots" in sys.argv:
        shots = pathlib.Path(sys.argv[sys.argv.index("--screenshots") + 1])
        shots.mkdir(parents=True, exist_ok=True)
    cloudflare = "--cloudflare" in sys.argv
    if cloudflare:
        proc, base, rows_file = start_cloudflare_server()
        print(f"Cloudflare build at {base} (Worker + simulated Google)")
    else:
        subprocess.run([sys.executable, str(ROOT / "tools/build_preview.py")], check=True, stdout=subprocess.DEVNULL)

        class QuietHandler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass

        handler = functools.partial(QuietHandler, directory=str(PREVIEW))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}/"

    passed = failed = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for fn in TESTS:
            context = browser.new_context(viewport={"width": 1366, "height": 900})
            if cloudflare:
                urllib.request.urlopen(base + "__test/reset").read()   # fresh mock sheets per test
                context.add_init_script(CLOUDFLARE_SHIM)
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            # A Content-Security-Policy block is reported on the console, not as a page error.
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Content Security Policy" in m.text else None)
            try:
                fn(page, base)
                check(not errors, f"JavaScript errors: {errors}")
                passed += 1
                print(f"  ✓ {fn.__name__.replace('_', ' ')}")
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print(f"  ✗ {fn.__name__.replace('_', ' ')}\n      {exc}")
                if "-v" in sys.argv:
                    traceback.print_exc()
            if shots:
                page.screenshot(path=str(shots / f"{fn.__name__}.png"))
            context.close()
        browser.close()
    if cloudflare:
        proc.kill()
        os.unlink(rows_file)
    else:
        server.shutdown()
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
