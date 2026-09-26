"""Small committed fixtures for the Scan & OCR end-to-end tests, cut from the generated scans.

    python3 scripts/corpus/generate.py            # makes tests/corpus/generated/scans
    python3 scripts/corpus/ocr_fixtures.py        # writes tests/fixtures/ocr/*

* scan-ar.pdf      image-only PDF (300 dpi): title and first paragraph of the Amiri news page, straight
* crooked8-ar.jpg  the same text rotated 8° counter-clockwise with the corpus scan noise (like "crooked 8°")
* truth-ar.txt     the text on those crops (first two paragraphs of the page's truth)
"""
from __future__ import annotations

import pathlib
import time

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCANS = ROOT / "tests/corpus/generated/scans"
OUT = ROOT / "tests/fixtures/ocr"
FIXED = time.gmtime(1735689600)


def main() -> None:
    import sys
    sys.path.insert(0, str(pathlib.Path(__file__).parent))
    import scans  # noqa: PLC0415 (same noise as the corpus scans)

    OUT.mkdir(parents=True, exist_ok=True)
    band = (0, 180, 2481, 745)  # the title and the first paragraph (rows measured on the page image)
    straight = Image.open(SCANS / "chrome-news-amiri-straight.png").convert("L")
    straight.crop(band).save(OUT / "scan-ar.pdf", "PDF", resolution=300.0, quality=70, title="scan-ar",
                             creationDate=FIXED, modDate=FIXED)
    clean = Image.open(SCANS / "chrome-news-amiri-300dpi.png").convert("L").crop(band)
    padded = Image.new("L", (clean.width, clean.height + 500), 255)
    padded.paste(clean, (0, 250))
    crooked = scans._noise(padded.rotate(8, resample=Image.BICUBIC, expand=False, fillcolor=255), 7)  # noqa: SLF001
    crooked.save(OUT / "crooked8-ar.jpg", "JPEG", quality=70, dpi=(300, 300))
    truth = (ROOT / "tests/corpus/truth/chrome-news-amiri.txt").read_text(encoding="utf-8").splitlines()
    (OUT / "truth-ar.txt").write_text("\n".join(truth[:2]) + "\n", encoding="utf-8")
    for f in sorted(OUT.iterdir()):
        print(f.name, f.stat().st_size)


if __name__ == "__main__":
    main()
