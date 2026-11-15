#!/usr/bin/env python3
"""
Makes the still fallback images for the animated page background from the GIFs:

    assets/background-desktop.gif  ->  assets/background-desktop-static.jpg
    assets/background-mobile.gif   ->  assets/background-mobile-static.jpg

The stills are shown while the GIF downloads, to visitors who ask for reduced
motion, and to visitors with data saver on. Re-run whenever a GIF changes:

    python3 tools/build_backgrounds.py [frame-number]
"""
import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
FRAME = int(sys.argv[1]) if len(sys.argv) > 1 else 0

for name in ("background-desktop", "background-mobile"):
    gif = ASSETS / f"{name}.gif"
    if not gif.exists():
        print(f"Skipped {gif.relative_to(ROOT)} (not found)")
        continue
    img = Image.open(gif)
    img.seek(min(FRAME, getattr(img, "n_frames", 1) - 1))
    out = ASSETS / f"{name}-static.jpg"
    img.convert("RGB").save(out, "JPEG", quality=85, optimize=True)
    print(f"Wrote {out.relative_to(ROOT)} ({img.width}x{img.height}px, "
          f"{out.stat().st_size // 1024} KB; GIF is {gif.stat().st_size // 1024} KB)")
