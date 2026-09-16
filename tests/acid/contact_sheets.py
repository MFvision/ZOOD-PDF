#!/usr/bin/env python3
"""Per-candidate contact sheets of the page-1 screenshots for visual review."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw
REPO = Path(sys.argv[1]).resolve(); SHOTS = REPO / "docs/research/screenshots"
cands = sys.argv[2:] or [d.name for d in SHOTS.iterdir() if d.is_dir()]
for c in cands:
    files = sorted((SHOTS / c).glob("*.jpg")); tiles = []
    for f in files:
        img = Image.open(f).convert("RGB"); img = img.resize((440, int(img.height * 440 / img.width))); img = img.crop((0, 0, 440, 300))
        ImageDraw.Draw(img).rectangle((0, 0, 440, 14), fill=(255, 255, 255)); ImageDraw.Draw(img).text((3, 2), f.stem[:60], fill=(190, 0, 0)); tiles.append(img)
    cols, per = 3, 12
    for k in range(0, len(tiles), per):
        chunk = tiles[k:k + per]; rows = (len(chunk) + cols - 1) // cols; sheet = Image.new("RGB", (440 * cols, 300 * rows), "white")
        for i, t in enumerate(chunk): sheet.paste(t, ((i % cols) * 440, (i // cols) * 300))
        sheet.save(SHOTS / f"sheet-{c}-{k // per + 1}.jpg", "JPEG", quality=72)
    print(c, len(tiles), "tiles ->", (len(tiles) + per - 1) // per, "sheets")
