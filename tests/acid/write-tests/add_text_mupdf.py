#!/usr/bin/env python3
"""Can MuPDF (AGPL reference) add an Arabic paragraph? insert_text vs insert_htmlbox (Story/HarfBuzz)."""
import sys
from pathlib import Path
import fitz
REPO = Path(sys.argv[1]).resolve(); here = Path(__file__).parent
doc = fitz.open(); page = doc.new_page(width=595, height=842)
page.insert_font(fontname="amiri", fontfile=str(REPO / "tests/fonts/Amiri-Regular.ttf"))
page.insert_text((80, 80), "insert_text: مرحباً بكم في محرّر وراق", fontname="amiri", fontsize=20)
css = "@font-face { font-family: Amiri; src: url(Amiri-Regular.ttf); } p { font-family: Amiri; font-size: 20px; }"
arch = fitz.Archive(str(REPO / "tests/fonts")); rect = fitz.Rect(60, 120, 540, 300)
page.insert_htmlbox(rect, "<p dir='rtl'>insert_htmlbox: مرحباً بكم في محرّر وراق — الْعِلْمُ نُورٌ Warraq 2026</p>", css=css, archive=arch)
out = here / "out-mupdf-add-text.pdf"; doc.save(out)
d2 = fitz.open(out); print("MuPDF add-text extraction:", repr(d2[0].get_text("text")))
pix = d2[0].get_pixmap(matrix=fitz.Matrix(1.5, 1.5), clip=fitz.Rect(0, 0, 595, 200)); pix.save(here / "out-mupdf-add-text.png")
