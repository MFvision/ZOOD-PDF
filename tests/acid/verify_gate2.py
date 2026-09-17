#!/usr/bin/env python3
"""Verify the GATE 2 outputs in engines that are not ours: PDFium (Chrome's) and,
via a companion Node call, PDF.js (Firefox's). Usage: verify_gate2.py <repo>"""
import json, sys
from pathlib import Path
import pypdfium2 as pdfium, pikepdf
repo = Path(sys.argv[1]).resolve(); d = repo / "docs/gate2"
out = {}
for name, needle in (("word-after.pdf", "وراق"), ("scan-after.pdf", "وراق")):
    f = d / name
    data = f.read_bytes()
    doc = pdfium.PdfDocument(str(f))
    text = doc[0].get_textpage().get_text_bounded()
    pdf = pikepdf.open(str(f))
    out[name] = {
        "bytes": len(data),
        "revisions": data.count(b"%%EOF"),
        "pdfium_pages": len(doc),
        "qpdf_pages": len(pdf.pages),
        "pdfium_finds_new_text": needle in text,
        "pdfium_first_line": text.split("\r\n")[0][:60],
    }
print(json.dumps(out, ensure_ascii=False, indent=1))
