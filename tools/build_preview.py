#!/usr/bin/env python3
"""
Builds preview/index.html: the real storefront plus the real .gs backend running
in the browser against an in-memory mock spreadsheet (tests/gas-mocks.js).
Lets you click through the store locally without a Google account.

    python3 tools/build_preview.py
    python3 -m http.server 8000 --directory preview   # then open http://localhost:8000

Orders placed in the preview are kept in memory only and vanish on reload.
The background GIFs are copied from assets/ and used for any empty CONFIG.BACKGROUND entry.
The UI tests (tests/ui_test.py) run against this page.
"""
import json
import pathlib
import re
import shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
ASSETS = ROOT / "assets"
OUT = ROOT / "preview"

HEADER = ["Product ID", "Name", "Description", "Price", "Category", "Color", "Image Link", "Image Link 2", "S", "M", "L", "XL", "XXL"]
WITH_BACK = {"P001", "P002"}   # sample products that get a second image ("Image Link 2")

# (id, name, description, price, category, shape, [(colour, hex, S, M, L, XL, XXL), ...])
SAMPLE = [
    ("P001", "Classic Hoodie", "Heavyweight cotton hoodie with a soft brushed interior and kangaroo pocket.", 899, "Hoodies", "hoodie",
     [("Red", "#c0392b", 1, 1, 0, 0, 1), ("Blue", "#2f5fa7", 1, 1, 1, 1, 1), ("Green", "#2f7d4f", 0, 0, 1, 1, 0)]),
    ("P002", "Printed T-Shirt", "Premium printed cotton with a relaxed everyday fit.", 449, "Printed", "tee",
     [("Black", "#232323", 1, 1, 1, 0, 0), ("White", "#f4f4f4", 1, 1, 1, 1, 0)]),
    ("P003", "Oxford Shirt", "Button-down Oxford shirt, smart or casual.", 749, "Shirt", "shirt",
     [("Navy", "#2f3e5c", 1, 1, 1, 1, 1), ("Sky Blue", "#9fc3e0", 0, 1, 1, 0, 0), ("Burgundy", "#800020", 0, 0, 0, 0, 0)]),
    ("P004", "Everyday Tee", "Soft classic crew-neck tee.", 349, "Tshirts", "tee",
     [("Heather Grey", "#b8b8bd", 1, 1, 1, 1, 1), ("Olive", "#6b7451", 1, 1, 0, 0, 0), ("Mustard", "#e1ad01", 0, 1, 1, 0, 0)]),
    ("P005", "Linen Shirt", "Lightweight linen blend for warm days.", 599, "Shirt", "shirt",
     [("Sand", "#d8c3a5", 0, 0, 0, 0, 0), ("Khaki", "#c3b091", 0, 0, 0, 0, 0)]),
    ("P006", "Logo Hoodie", "Embroidered logo hoodie.", 999, "Classic", "hoodie",
     [("Cream", "#ece4d4", 1, 1, 1, 1, 0), ("Charcoal", "#36454f", 0, 1, 1, 1, 1)]),
    ("P007", "Classic Pocket Tee", "Classic fit with a chest pocket.", 399, "Classic", "tee",
     [("Forest Green", "#2f5d4a", 1, 1, 1, 0, 0)]),
]
# Preview defaults for empty CONFIG.BACKGROUND entries (files in assets/).
BACKGROUND = {
    "DESKTOP_GIF": "assets/background-desktop.gif",
    "MOBILE_GIF": "assets/background-mobile.gif",
    "DESKTOP_STATIC": "assets/background-desktop-static.jpg",
    "MOBILE_STATIC": "assets/background-mobile-static.jpg",
}
# A colour whose image link is broken on purpose (shows the fallback image).
BROKEN = ["P008", "Mystery Tee", "Image link is broken on purpose (fallback demo).", 299, "Tshirts", "Purple",
          "https://invalid.example/missing.jpg", "", 0, 1, 1, 0, 0]

SHAPES = {
    "tee": "M120 95 L60 130 L80 190 L110 178 L110 330 L250 330 L250 178 L280 190 L300 130 L240 95 C230 118 210 130 180 130 C150 130 130 118 120 95 Z",
    "hoodie": "M125 90 C130 60 230 60 235 90 L300 125 L320 300 L285 305 L270 190 L262 340 L98 340 L90 190 L75 305 L40 300 L60 125 Z M150 92 C160 130 200 130 210 92",
    "shirt": "M135 90 L70 125 L85 210 L112 200 L112 335 L248 335 L248 200 L275 210 L290 125 L225 90 L180 125 Z M180 125 L180 335",
}


def svg(shape, color, back=False):
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 450">'
        f'<rect width="360" height="450" fill="{"#e4e9f0" if back else "#f3f1f4"}"/>'
        '<ellipse cx="180" cy="390" rx="120" ry="14" fill="#00000010"/>'
        f'<path d="{SHAPES[shape]}" transform="translate(0 20)" fill="{color}" stroke="#00000022" stroke-width="3" stroke-linejoin="round"/>'
        + ('<text x="180" y="425" font-family="sans-serif" font-size="22" font-weight="700" text-anchor="middle" fill="#00000066">BACK</text>' if back else "")
        + "</svg>"
    )


def main():
    shutil.rmtree(OUT / "img", ignore_errors=True)   # generated files only
    (OUT / "img").mkdir(parents=True, exist_ok=True)
    rows = [HEADER]
    for pid, name, desc, price, cat, shape, colours in SAMPLE:
        for colour, hex_, *stock in colours:
            file = f"img/{pid}-{colour.lower().replace(' ', '-')}.svg"
            (OUT / file).write_text(svg(shape, hex_), encoding="utf-8")
            second = ""
            if pid in WITH_BACK:
                second = file.replace(".svg", "-back.svg")
                (OUT / second).write_text(svg(shape, hex_, back=True), encoding="utf-8")
                second = "{{BASE}}" + second
            rows.append([pid, name, desc, price, cat, colour, "{{BASE}}" + file, second] + stock)
    rows.append(BROKEN)

    shutil.rmtree(OUT / "assets", ignore_errors=True)   # copied files only
    background = {}
    for key, rel in BACKGROUND.items():
        if (ROOT / rel).exists():
            (OUT / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / rel, OUT / rel)
            background[key] = rel

    backend = "\n".join(
        [(ROOT / "tests/gas-mocks.js").read_text()]
        + [(SRC / f).read_text() for f in ("Config.gs", "Products.gs", "Orders.gs", "Email.gs", "Code.gs")]
    )
    fake_run = """
(function () {
  var base = location.origin + location.pathname.replace(/[^/]*$/, '');
  var rows = JSON.parse(%s.replace(/\\{\\{BASE\\}\\}/g, base));
  resetMocks({ sheets: { Products: rows, Orders: [CONFIG.ORDER_HEADERS] } });
  var bg = %s;
  Object.keys(bg).forEach(function (k) { if (!CONFIG.BACKGROUND[k]) CONFIG.BACKGROUND[k] = bg[k]; });
})();
window.__preview = {
  orders: function () { return __mock.spreadsheet.getSheetByName('Orders'); },
  products: function () { return __mock.spreadsheet.getSheetByName('Products'); },
  delayMs: 700
};
window.google = { script: { get run() {
  var ok = function () {}, fail = function () {};
  var r = { withSuccessHandler: function (f) { ok = f; return r; }, withFailureHandler: function (f) { fail = f; return r; } };
  ['getProducts', 'submitOrder'].forEach(function (n) {
    r[n] = function (arg) {
      var go = function () {
        try { ok(JSON.parse(JSON.stringify(window[n](JSON.parse(JSON.stringify(arg === undefined ? null : arg)))))); }
        catch (e) { fail(e); }
      };
      setTimeout(go, n === 'submitOrder' ? window.__preview.delayMs : 0);
    };
  });
  return r;
} } };
""" % (json.dumps(json.dumps(rows)), json.dumps(background))

    page = (SRC / "Index.html").read_text(encoding="utf-8")
    page = page.replace(
        "<script>window.STORE_CONFIG = <?!= configJson ?>;</script>",
        "<script>\n" + backend + fake_run + "\nwindow.STORE_CONFIG = getPublicConfig_();\n</script>",
    )
    page = re.sub(r"<\?!= include\('(\w+)'\); \?>", lambda m: (SRC / (m.group(1) + ".html")).read_text(encoding="utf-8"), page)
    page = page.replace("<?= storeName ?>", "Store")
    (OUT / "index.html").write_text(page, encoding="utf-8")
    print(f"Wrote {OUT / 'index.html'}")


if __name__ == "__main__":
    main()
