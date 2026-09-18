#!/usr/bin/env python3
"""Image-only 'scanned' PDFs derived from the Chrome corpus pages."""
import io, os, sys
from pathlib import Path
import numpy as np, img2pdf, pypdfium2 as pdfium
from PIL import Image, ImageFilter
sys.path.insert(0, os.path.dirname(__file__)); import corpus_texts as T
REPO = Path(sys.argv[1]).resolve(); GEN = REPO / "tests/corpus/arabic/generated"; TRUTH = REPO / "tests/corpus/arabic/truth"

def render(pdf_name, page_index, dpi):
    doc = pdfium.PdfDocument(str(GEN / pdf_name)); page = doc[page_index]
    img = page.render(scale=dpi / 72).to_pil().convert("L"); return img

def degrade(img, angle, noise, blur, jpeg_q):
    img = img.rotate(angle, resample=Image.BICUBIC, expand=False, fillcolor=255)
    if blur: img = img.filter(ImageFilter.GaussianBlur(blur))
    a = np.asarray(img).astype(np.float32)
    a = a * 0.92 + 12 + np.random.default_rng(42).normal(0, noise, a.shape)  # paper tint + sensor noise
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    buf = io.BytesIO(); img.save(buf, "JPEG", quality=jpeg_q, dpi=(300, 300)); return buf.getvalue()

def bilevel(img, threshold=150):
    bw = img.point(lambda p: 255 if p > threshold else 0).convert("1")
    buf = io.BytesIO(); bw.save(buf, "PNG", dpi=(200, 200)); return buf.getvalue()

pages = [degrade(render("chrome-notonaskh-justified-3pages.pdf", i, 300), angle=1.3 if i == 0 else -0.8, noise=9, blur=0.6, jpeg_q=55) for i in (0, 1)]
out = GEN / "scan-notonaskh-300dpi-skewed-jpeg.pdf"; out.write_bytes(img2pdf.convert(pages, title="Scanned Arabic test (300 dpi)"))
print("ok ", out.name, out.stat().st_size, "bytes")
truth = [T.HEADINGS[0]] + T.PARAGRAPHS + [T.HEADINGS[1]] + T.PARAGRAPHS
(TRUTH / "scan-notonaskh-300dpi-skewed-jpeg.txt").write_text("\n".join(truth) + "\n", encoding="utf-8")

# A page scanned 8 degrees crooked: read as it is, Tesseract got 56 % of its
# words; straightened first (packages/ui/src/ocr/deskew.ts), 93 %.
crooked = [degrade(render("chrome-notonaskh-justified-3pages.pdf", 0, 300), angle=8, noise=9, blur=0.6, jpeg_q=55)]
out = GEN / "scan-notonaskh-300dpi-crooked-8deg-jpeg.pdf"; out.write_bytes(img2pdf.convert(crooked, title="Scanned Arabic test, 8 degrees crooked (300 dpi)"))
print("ok ", out.name, out.stat().st_size, "bytes")
(TRUTH / "scan-notonaskh-300dpi-crooked-8deg-jpeg.txt").write_text("\n".join([T.HEADINGS[0]] + T.PARAGRAPHS) + "\n", encoding="utf-8")

bw = bilevel(render("chrome-windows-arial-tahoma-times.pdf", 0, 200).rotate(0.5, resample=Image.BICUBIC, fillcolor=255))
out = GEN / "scan-arial-200dpi-bilevel.pdf"; out.write_bytes(img2pdf.convert([bw], title="Scanned Arabic invoice (200 dpi, 1-bit)"))
print("ok ", out.name, out.stat().st_size, "bytes")
(TRUTH / "scan-arial-200dpi-bilevel.txt").write_text("\n".join(T.INVOICE) + "\n", encoding="utf-8")

if "--large" in sys.argv:  # 500-page, ~500 MB scanned stress file (not committed)
    big = GEN / "generated-large"; big.mkdir(exist_ok=True)
    page = degrade(render("chrome-notonaskh-justified-3pages.pdf", 0, 400), 0.4, 6, 0.3, 90)
    out = big / "perf-scan-500-pages.pdf"; out.write_bytes(img2pdf.convert([page] * 500)); print("ok ", out.name, out.stat().st_size, "bytes")
