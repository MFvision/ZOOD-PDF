#!/usr/bin/env python3
"""Download the OFL fonts used by the Arabic corpus into tests/corpus/fonts/.

The fonts are committed, so this only needs to run when upgrading them. Every font comes
from the google/fonts repository (OFL-1.1) together with its OFL.txt.
"""
from __future__ import annotations

import hashlib
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEST = ROOT / "tests" / "corpus" / "fonts"
BASE = "https://raw.githubusercontent.com/google/fonts/main/ofl/"

FONTS = {
    "amiri": ["Amiri-Regular.ttf", "Amiri-Bold.ttf"],
    "cairo": ["Cairo[slnt,wght].ttf"],
    "notonaskharabic": ["NotoNaskhArabic[wght].ttf"],
    "notonastaliqurdu": ["NotoNastaliqUrdu[wght].ttf"],
    "vazirmatn": ["Vazirmatn[wght].ttf"],
    "inter": ["Inter[opsz,wght].ttf"],
}


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as r:  # noqa: S310 (fixed https URL)
        return r.read()


def main() -> int:
    for family, files in FONTS.items():
        d = DEST / family
        d.mkdir(parents=True, exist_ok=True)
        for name in files + ["OFL.txt"]:
            quoted = name.replace("[", "%5B").replace("]", "%5D")
            data = fetch(BASE + family + "/" + quoted)
            (d / name).write_bytes(data)
            print(f"{family}/{name} {len(data)} sha256={hashlib.sha256(data).hexdigest()[:16]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
