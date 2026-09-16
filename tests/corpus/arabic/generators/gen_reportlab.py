#!/usr/bin/env python3
"""The classic 'reshape + reverse' pattern: presentation-form code points in
visual order, written through ReportLab (Type0 font with a ToUnicode map that
points at U+FBxx/U+FExx). Extraction from this file yields presentation forms
in visual order; a correct engine must normalize both."""
import os, sys
from pathlib import Path
import arabic_reshaper
try:
    from bidi import get_display
except ImportError:
    from bidi.algorithm import get_display
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.pagesizes import A4
sys.path.insert(0, os.path.dirname(__file__))
import corpus_texts as T

REPO = Path(sys.argv[1]).resolve()
OUT = REPO / "tests/corpus/arabic/generated"; TRUTH = REPO / "tests/corpus/arabic/truth"
pdfmetrics.registerFont(TTFont("Amiri", str(REPO / "tests/fonts/Amiri-Regular.ttf")))
LINES = T.INVOICE + T.TASHKEEL
out = OUT / "reportlab-visual-presentation-forms.pdf"
c = canvas.Canvas(str(out), pagesize=A4); c.setTitle("ReportLab visual-order test")
c.setFont("Amiri", 15); y = A4[1] - 60
reshaper = arabic_reshaper.ArabicReshaper({"delete_harakat": False, "support_ligatures": True})
for line in LINES:
    c.drawRightString(A4[0] - 56, y, get_display(reshaper.reshape(line))); y -= 32
c.save()
(TRUTH / "reportlab-visual-presentation-forms.txt").write_text("\n".join(LINES) + "\n", encoding="utf-8")
print("ok ", out.name, out.stat().st_size, "bytes")
