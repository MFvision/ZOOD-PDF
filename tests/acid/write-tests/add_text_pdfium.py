#!/usr/bin/env python3
"""Can PDFium add an Arabic paragraph? (FPDFText_LoadFont + FPDFText_SetText)"""
import ctypes, sys
from pathlib import Path
import pypdfium2 as pdfium, pypdfium2.raw as C
REPO = Path(sys.argv[1]).resolve(); out = Path(__file__).parent / "out-pdfium-add-text.pdf"
doc = pdfium.PdfDocument.new(); page = doc.new_page(595, 842)
data = (REPO / "tests/fonts/Amiri-Regular.ttf").read_bytes(); buf = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
font = C.FPDFText_LoadFont(doc, buf, len(data), C.FPDF_FONT_TRUETYPE, 1)
for i, s in enumerate(["مرحباً بكم في محرّر وراق", "الْعِلْمُ نُورٌ — Warraq 2026"]):
    obj = C.FPDFPageObj_CreateTextObj(doc, font, 20)
    u = (s + "\0").encode("utf-16-le"); arr = (ctypes.c_ushort * (len(u) // 2)).from_buffer_copy(u)
    C.FPDFText_SetText(obj, arr); C.FPDFPageObj_Transform(obj, 1, 0, 0, 1, 80, 760 - 40 * i); C.FPDFPage_InsertObject(page, obj)
C.FPDFPage_GenerateContent(page); doc.save(out)
doc2 = pdfium.PdfDocument(str(out)); txt = doc2[0].get_textpage().get_text_bounded()
doc2[0].render(scale=1.5).to_pil().crop((0, 0, 893, 180)).save(Path(__file__).parent / "out-pdfium-add-text.png")
print("PDFium add-text extraction:", repr(txt))
