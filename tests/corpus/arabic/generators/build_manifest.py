#!/usr/bin/env python3
"""Build tests/corpus/arabic/manifest.json + manifest.md from generated/ and
realworld/ (the latter carries its own provenance manifest written by the
acquisition step). Structural facts come from pikepdf (qpdf); the text sample
from PDFium."""
import hashlib, json, os, re, sys
from pathlib import Path
import pikepdf, pypdfium2 as pdfium
sys.path.insert(0, os.path.dirname(__file__))
ROOT = Path(sys.argv[1]).resolve() / "tests/corpus/arabic"
PASSWORDS = {"variant-encrypted-aes256.pdf": "warraq"}
CATEGORIES = {  # what each generated file is for (the "class" column of the acid test)
    "chrome-cairo-mixed-invoice": "Skia/PDF (Chrome print, Google Docs class), Cairo, mixed Arabic/English invoice, Arabic-Indic digits",
    "chrome-amiri-tashkeel-ligatures": "Skia/PDF, Amiri, full tashkeel, lam-alef and Allah ligatures, kashida",
    "chrome-notonaskh-justified-3pages": "Skia/PDF, Noto Naskh Arabic, justified paragraphs, 3 pages",
    "chrome-tajawal-persian-urdu-digits": "Skia/PDF, Tajawal + Scheherazade fallback, Persian/Urdu letters, Eastern digits",
    "chrome-windows-arial-tahoma-times": "Skia/PDF, Windows system fonts (Arial, Tahoma, Times New Roman)",
    "chrome-ibmplex-bidi-stress": "Skia/PDF, IBM Plex Sans Arabic, bidi stress (numbers, brackets, URLs, LTR paragraph with Arabic)",
    "chrome-notosansarabic-form-layout": "Skia/PDF, Noto Sans Arabic, government-form layout (static)",
    "acroform-pdflib-arabic-fields": "AcroForm fields with Arabic names/value added by pdf-lib (unshaped appearance = known-bad)",
    "coretext-geezapro-paragraphs": "Quartz PDFContext (Pages/Preview class), Geeza Pro, 3 pages",
    "coretext-albayan-tashkeel": "Quartz PDFContext, Al Bayan, tashkeel",
    "coretext-sfarabic-mixed-invoice": "Quartz PDFContext, SF Arabic, mixed invoice",
    "coretext-baghdad-persian-urdu": "Quartz PDFContext, Baghdad with system font fallback for Persian/Urdu",
    "raw-amiri-cid-identity-tounicode": "HarfBuzz-shaped Type0/CIDFontType2 Identity-H with correct ToUnicode (ideal output)",
    "raw-amiri-cid-no-tounicode": "Same glyph runs, NO ToUnicode map",
    "raw-cairo-cid-broken-tounicode": "ToUnicode maps every CID to U+FFFD (broken map)",
    "raw-legacy-symbolic-truetype": "Simple symbolic TrueType, 1-byte codes, presentation-form glyphs in visual order, no ToUnicode (1990s style)",
    "reportlab-visual-presentation-forms": "ReportLab: reshaped presentation forms (U+FBxx/FExx) in visual order with ToUnicode to those forms",
    "scan-notonaskh-300dpi-skewed-jpeg": "Image-only scan, 300 dpi, skewed 1.3/-0.8 deg, noise, JPEG (OCR target)",
    "scan-arial-200dpi-bilevel": "Image-only scan, 200 dpi, 1-bit (OCR target)",
    "variant-encrypted-aes256": "AES-256 (R6) encrypted, user password 'warraq'",
    "variant-objectstreams-xrefstream": "Object streams + cross-reference stream",
    "variant-linearized": "Linearized (fast web view)",
    "variant-arabic-metadata-outlines-annots": "Arabic Info/XMP metadata, outlines, sticky note + highlight annotations, Arabic-named attachment",
    "variant-incremental-update": "Hand-appended incremental update changing the title",
    "perf-text-100-pages": "Performance: 100 text pages (N8 budget: open < 1 s)",
    "perf-text-500-pages": "Performance: 500 text pages (scroll smoothness)",
}
PRES = re.compile("[ﭐ-﷿ﹰ-﻿]")

def analyze(path: Path):
    rec = {"file": str(path.relative_to(ROOT)), "size_bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()[:16]}
    pw = PASSWORDS.get(path.name)
    try:
        with pikepdf.open(path, password=pw or "") as pdf:
            rec.update(pages=len(pdf.pages), pdf_version=pdf.pdf_version, encrypted=pdf.is_encrypted, linearized=pdf.is_linearized,
                       has_acroform="/AcroForm" in pdf.Root, producer=str(pdf.docinfo.get("/Producer", "")), creator=str(pdf.docinfo.get("/Creator", "")))
            fonts = {}
            for page in list(pdf.pages)[:3]:
                res = page.get("/Resources", {}); fd = res.get("/Font", {}) if res else {}
                for key, f in (fd.items() if fd else []):
                    try:
                        st = str(f.get("/Subtype", "")); base = str(f.get("/BaseFont", "?"))
                        desc = f.get("/FontDescriptor") if st != "/Type0" else (f.get("/DescendantFonts")[0].get("/FontDescriptor") if f.get("/DescendantFonts") else None)
                        embedded = bool(desc and any(k in desc for k in ("/FontFile", "/FontFile2", "/FontFile3")))
                        fonts[base] = {"subtype": st, "embedded": embedded, "tounicode": "/ToUnicode" in f}
                    except Exception as e:  # noqa
                        fonts[str(key)] = {"error": str(e)[:60]}
            rec["fonts"] = fonts
    except Exception as e:
        rec["error_pikepdf"] = str(e)[:120]
    try:
        doc = pdfium.PdfDocument(str(path), password=pw); txt = doc[0].get_textpage().get_text_bounded()
        rec["text_sample_pdfium"] = txt[:120].replace("\r\n", " / "); rec["image_only"] = len(txt.strip()) < 20
        rec["presentation_forms_in_pdfium_text"] = bool(PRES.search(txt))
    except Exception as e:
        rec["error_pdfium"] = str(e)[:120]
    return rec

records = []
for p in sorted((ROOT / "generated").glob("*.pdf")):
    r = analyze(p); r["category"] = CATEGORIES.get(p.stem, "?"); r["truth"] = f"truth/{p.stem}.txt" if (ROOT / "truth" / f"{p.stem}.txt").exists() else None; r["source"] = "generated"; records.append(r)
rw = ROOT / "realworld/manifest.json"
if rw.exists():
    for e in json.load(open(rw)):
        p = ROOT / "realworld" / e["filename"]
        if p.exists():
            r = analyze(p); r.update(category="real-world: " + e.get("notes", "")[:140], source=e.get("source_url"), license=e.get("license_or_status"), truth=None); records.append(r)
json.dump(records, open(ROOT / "manifest.json", "w"), ensure_ascii=False, indent=1)
with open(ROOT / "manifest.md", "w") as f:
    f.write("# Arabic corpus manifest\n\nGenerated by `generators/build_manifest.py`. Structural facts via qpdf (pikepdf), text sample via PDFium.\n\n")
    f.write("| File | Pages | Size | Fonts (embedded / ToUnicode) | Encrypted | AcroForm | Image-only | Pres. forms in PDFium text | Category |\n|---|---|---|---|---|---|---|---|---|\n")
    for r in records:
        fonts = "; ".join(f"{k.split('+')[-1][:22]} ({'emb' if v.get('embedded') else 'NOT emb'}/{'TU' if v.get('tounicode') else 'no TU'})" for k, v in list(r.get("fonts", {}).items())[:4]) or "-"
        f.write(f"| `{r['file']}` | {r.get('pages','?')} | {r['size_bytes']//1024} KB | {fonts} | {r.get('encrypted','?')} | {r.get('has_acroform','?')} | {r.get('image_only','?')} | {r.get('presentation_forms_in_pdfium_text','?')} | {r.get('category','')} |\n")
print(f"{len(records)} records -> manifest.json / manifest.md")
