#!/usr/bin/env python3
"""Locate form labels in the Chrome form-layout PDF (PDFium text search) and
emit field rectangles for gen_acroform.mjs."""
import json, os, sys
from pathlib import Path
import pypdfium2 as pdfium
sys.path.insert(0, os.path.dirname(__file__)); import corpus_texts as T
REPO = Path(sys.argv[1]).resolve()
doc = pdfium.PdfDocument(str(REPO / "tests/corpus/arabic/generated/chrome-notosansarabic-form-layout.pdf"))
page = doc[0]; tp = page.get_textpage(); W = page.get_width()
MARGIN = 15 / 25.4 * 72; table_w = W - 2 * MARGIN; label_w = table_w * 0.30
fields = []
for label in T.FORM[1:7]:
    q = label.rstrip(":"); hit = tp.search(q).get_next()
    if not hit: hit = tp.search(q[::-1]).get_next()  # PDFium stores Skia/PDF Arabic in visual order
    if not hit: print("label not found:", label); continue
    idx, cnt = hit; n = tp.count_rects(idx, cnt); l, b, r, t = tp.get_rect(0)
    cy = (b + t) / 2
    fields.append({"name": label.rstrip(":"), "type": "text", "x": MARGIN + 2, "y": cy - 14, "w": table_w - label_w - 4, "h": 28})
hit = tp.search("الجنس").get_next() or tp.search("سنجلا").get_next()
if hit:
    idx, cnt = hit; tp.count_rects(idx, cnt); l, b, r, t = tp.get_rect(0); cy = (b + t) / 2
    for i, name in enumerate(("ذكر", "أنثى")):
        fields.append({"name": "الجنس/" + name, "type": "checkbox", "x": l - 30 - i * 70, "y": cy - 7, "w": 14, "h": 14})
fields[0]["value"] = "محمد عبد الله"; fields[1]["value"] = "1098765432"
json.dump({"page_height": page.get_height(), "fields": fields}, open(REPO / "tests/corpus/arabic/generators/form_fields.json", "w"), ensure_ascii=False, indent=1)
print(f"{len(fields)} fields located")
