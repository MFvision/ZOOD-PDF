#!/usr/bin/env python3
"""Documents as PDFium writes them whole — what EmbedPDF's Save hands
Warraq — for the rebase tests in warraq-pdf (src/rebase.rs). Run from the
repository root: python3 tests/fixtures/rewrites/make.py"""
import io
from pathlib import Path
import pypdfium2 as pdfium
import pypdfium2.raw as c

HERE = Path(__file__).resolve().parent
CORPUS = HERE.parent.parent / "corpus/arabic/generated"


def rewrite(source, out, password=None, square=False, flags=0):
    pdf = pdfium.PdfDocument(str(CORPUS / source), password=password)
    if square:
        page = pdf[0]
        annot = c.FPDFPage_CreateAnnot(page.raw, c.FPDF_ANNOT_SQUARE)
        c.FPDFAnnot_SetRect(annot, c.FS_RECTF(100, 700, 300, 600))
        c.FPDFAnnot_SetColor(annot, c.FPDFANNOT_COLORTYPE_Color, 200, 30, 30, 255)
        c.FPDFPage_CloseAnnot(annot)
        page.close()
    buf = io.BytesIO()
    pdf.save(buf, flags=flags)
    pdf.close()
    (HERE / out).write_bytes(buf.getvalue())
    print(out, len(buf.getvalue()), "bytes")


THREE = "chrome-notonaskh-justified-3pages.pdf"
AES = "variant-encrypted-aes256.pdf"
rewrite(THREE, "three-unchanged.pdf")
rewrite(THREE, "three-square.pdf", square=True)
rewrite(AES, "aes256-square.pdf", password="warraq", square=True)
rewrite(AES, "aes256-unprotected.pdf", password="warraq", flags=c.FPDF_REMOVE_SECURITY)
