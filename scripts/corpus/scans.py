"""Scan variants from a 300-dpi page image: straight, crooked 5° and 8°, shadowed (vignette).

Each variant is written as a PNG and as an image-only PDF (no text layer; OCR happens in the UI).
"""
from __future__ import annotations

import pathlib
import random
import time

from PIL import Image, ImageChops, ImageFilter

FIXED_DATE = time.gmtime(1735689600)  # 2025-01-01T00:00:00Z

VARIANTS = ("straight", "crooked5", "crooked8", "shadow")


def _noise(img: Image.Image, seed: int) -> Image.Image:
    rnd = random.Random(seed)
    w, h = img.size
    small = Image.new("L", (w // 8, h // 8))
    small.putdata([rnd.randint(236, 255) for _ in range((w // 8) * (h // 8))])
    grain = small.resize((w, h), Image.BILINEAR)
    return ImageChops.multiply(img, grain)


def _vignette(size: tuple[int, int]) -> Image.Image:
    """Dark gradient from the top-left corner (a hand's shadow) plus edge vignette."""
    w, h = size
    sw, sh = 256, 256
    g = Image.new("L", (sw, sh))
    px = []
    for y in range(sh):
        for x in range(sw):
            d = ((x / sw) ** 2 + (y / sh) ** 2) ** 0.5 / 1.4142
            edge = min(x, y, sw - 1 - x, sh - 1 - y) / (sw / 2)
            v = 120 + 135 * min(1.0, d * 1.3)
            v *= 0.82 + 0.18 * min(1.0, edge * 3)
            px.append(int(max(0, min(255, v))))
    g.putdata(px)
    return g.resize((w, h), Image.BICUBIC).filter(ImageFilter.GaussianBlur(8))


def make_variants(src_png: pathlib.Path, out_dir: pathlib.Path, stem: str, seed: int = 7) -> dict[str, pathlib.Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    base = Image.open(src_png).convert("L")
    results = {}
    for v in VARIANTS:
        if v == "straight":
            img = base
        elif v.startswith("crooked"):
            angle = 5 if v == "crooked5" else 8
            img = base.rotate(angle, resample=Image.BICUBIC, expand=False, fillcolor=255)
        else:
            img = ImageChops.multiply(base, _vignette(base.size))
        img = _noise(img, seed)
        png = out_dir / f"{stem}-{v}.png"
        img.save(png, optimize=True, dpi=(300, 300))
        pdf = out_dir / f"{stem}-{v}.pdf"
        img.convert("RGB").save(pdf, "PDF", resolution=300.0, quality=80,
                                title=f"{stem} {v}", creationDate=FIXED_DATE, modDate=FIXED_DATE)
        results[v] = pdf
    return results
