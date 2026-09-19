#!/usr/bin/env python3
"""Image-only 'scanned' PDFs derived from the Chrome corpus pages."""
import io, os, sys
from pathlib import Path
import numpy as np, img2pdf, pypdfium2 as pdfium
from PIL import Image, ImageFilter
sys.path.insert(0, os.path.dirname(__file__)); import corpus_texts as T
REPO = Path(sys.argv[1]).resolve(); GEN = REPO / "tests/corpus/arabic/generated"; TRUTH = REPO / "tests/corpus/arabic/truth"
# `--only=<name>` writes just that file (and its truth): regenerating the
# others would change their bytes (img2pdf dates them) for nothing.
ONLY = [a.split("=", 1)[1] for a in sys.argv if a.startswith("--only=")]
want = lambda name: not ONLY or name in ONLY

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

if want("scan-notonaskh-300dpi-skewed-jpeg"):
    pages = [degrade(render("chrome-notonaskh-justified-3pages.pdf", i, 300), angle=1.3 if i == 0 else -0.8, noise=9, blur=0.6, jpeg_q=55) for i in (0, 1)]
    out = GEN / "scan-notonaskh-300dpi-skewed-jpeg.pdf"; out.write_bytes(img2pdf.convert(pages, title="Scanned Arabic test (300 dpi)"))
    print("ok ", out.name, out.stat().st_size, "bytes")
    truth = [T.HEADINGS[0]] + T.PARAGRAPHS + [T.HEADINGS[1]] + T.PARAGRAPHS
    (TRUTH / "scan-notonaskh-300dpi-skewed-jpeg.txt").write_text("\n".join(truth) + "\n", encoding="utf-8")

# A page scanned 8 degrees crooked: read as it is, Tesseract got 56 % of its
# words; straightened first (packages/ui/src/ocr/deskew.ts), 93 %.
if want("scan-notonaskh-300dpi-crooked-8deg-jpeg"):
    crooked = [degrade(render("chrome-notonaskh-justified-3pages.pdf", 0, 300), angle=8, noise=9, blur=0.6, jpeg_q=55)]
    out = GEN / "scan-notonaskh-300dpi-crooked-8deg-jpeg.pdf"; out.write_bytes(img2pdf.convert(crooked, title="Scanned Arabic test, 8 degrees crooked (300 dpi)"))
    print("ok ", out.name, out.stat().st_size, "bytes")
    (TRUTH / "scan-notonaskh-300dpi-crooked-8deg-jpeg.txt").write_text("\n".join([T.HEADINGS[0]] + T.PARAGRAPHS) + "\n", encoding="utf-8")

if want("scan-arial-200dpi-bilevel"):
    bw = bilevel(render("chrome-windows-arial-tahoma-times.pdf", 0, 200).rotate(0.5, resample=Image.BICUBIC, fillcolor=255))
    out = GEN / "scan-arial-200dpi-bilevel.pdf"; out.write_bytes(img2pdf.convert([bw], title="Scanned Arabic invoice (200 dpi, 1-bit)"))
    print("ok ", out.name, out.stat().st_size, "bytes")
    (TRUTH / "scan-arial-200dpi-bilevel.txt").write_text("\n".join(T.INVOICE) + "\n", encoding="utf-8")

def shadowed(img, fold, shade, stains, seed):
    """A page photographed or scanned badly: the paper darkened by a book
    fold along one edge (`fold`: "left"/"right"), a soft shadow over one
    corner (`shade`: its centre and radius, as shares of the page), and
    tea stains (centre, radius, depth) with the darker ring such a stain
    dries into. Ink stays ink; only the light on the paper changes."""
    a = np.asarray(img).astype(np.float32)
    h, w = a.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    light = np.ones_like(a)
    edge = xx if fold == "left" else (w - 1 - xx)
    light *= 1 - 0.72 * np.exp(-edge / (0.16 * w))
    (sx, sy, sr) = shade
    d = np.hypot(xx - sx * w, yy - sy * h) / (sr * w)
    light *= 1 - 0.55 * np.clip(1.2 - d, 0, 1) ** 1.5
    rng = np.random.default_rng(seed)
    for (cx, cy, r, depth) in stains:
        wobble = 1 + 0.08 * np.sin(np.arctan2(yy - cy * h, xx - cx * w) * rng.integers(3, 7) + rng.uniform(0, 6.3))
        d = np.hypot(xx - cx * w, yy - cy * h) / (r * w * wobble)
        inside = np.clip((1 - d) * 6, 0, 1)
        ring = np.exp(-((d - 0.97) / 0.035) ** 2)
        light *= 1 - depth * inside - 0.8 * depth * ring
    a = a * np.clip(light, 0.05, 1)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

# Shadows and stains: global thresholding (Tesseract's own, Otsu) turns the
# darkened paper black and reads little of it; cleaned up first
# (packages/ui/src/ocr/cleanup.ts) it reads as the clean pages do.
if want("scan-notonaskh-300dpi-shadowed-stained-jpeg"):
    stained = [
        degrade(shadowed(render("chrome-notonaskh-justified-3pages.pdf", 0, 300), "left", (0.15, 0.95, 0.55), [(0.62, 0.30, 0.13, 0.30), (0.30, 0.62, 0.09, 0.38)], 7), angle=0.6, noise=7, blur=0.5, jpeg_q=60),
        degrade(shadowed(render("chrome-notonaskh-justified-3pages.pdf", 1, 300), "right", (0.85, 0.10, 0.5), [(0.45, 0.45, 0.16, 0.28)], 11), angle=-0.5, noise=7, blur=0.5, jpeg_q=60),
    ]
    out = GEN / "scan-notonaskh-300dpi-shadowed-stained-jpeg.pdf"; out.write_bytes(img2pdf.convert(stained, title="Scanned Arabic test, shadowed and stained (300 dpi)"))
    print("ok ", out.name, out.stat().st_size, "bytes")
    truth = [T.HEADINGS[0]] + T.PARAGRAPHS + [T.HEADINGS[1]] + T.PARAGRAPHS
    (TRUTH / "scan-notonaskh-300dpi-shadowed-stained-jpeg.txt").write_text("\n".join(truth) + "\n", encoding="utf-8")

if "--large" in sys.argv:  # 500-page, ~500 MB scanned stress file (not committed)
    big = GEN / "generated-large"; big.mkdir(exist_ok=True)
    page = degrade(render("chrome-notonaskh-justified-3pages.pdf", 0, 400), 0.4, 6, 0.3, 90)
    out = big / "perf-scan-500-pages.pdf"; out.write_bytes(img2pdf.convert([page] * 500)); print("ok ", out.name, out.stat().st_size, "bytes")
