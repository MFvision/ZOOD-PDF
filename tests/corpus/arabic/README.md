# Arabic test corpus

44 PDFs (29 generated, 15 real-world) that exercise everything that goes wrong
with Arabic in PDF software. Every generated file has a ground-truth text file in
`truth/` (logical Unicode order, one paragraph or line per line). Real-world files
carry provenance and license in `realworld/manifest.md`. Structural facts for all
files are in `manifest.md` / `manifest.json` (rebuild with
`python3 generators/build_manifest.py <repo>`).

## Generated files (`generated/`)

| Generator | Files | What it represents |
|---|---|---|
| Headless Chrome print-to-PDF (`gen_chrome.py`) | `chrome-*` (8) | Skia/PDF backend, i.e. Google Docs export and Chromium "Save as PDF". Fonts: Cairo, Amiri, Noto Naskh Arabic, Tajawal + Scheherazade fallback, Arial/Tahoma/Times New Roman, IBM Plex Sans Arabic, Noto Sans Arabic. Webfonts are **static instances** (`tests/fonts/static/`, made with fontTools) because Skia embeds variable fonts as Type3; `chrome-variablefont-type3-*` keeps one variable font on purpose. Persian (`chrome-vazirmatn-persian-prose`, ZWNJ words and Persian digits) and Urdu (`chrome-nastaliq-urdu-prose`, Nastaliq shaping) are first-class per ADR-0006. Mixed Arabic/English invoice, full tashkeel with lam-alef/Allah ligatures and kashida, justified 3-page prose, Persian/Urdu and Eastern digits, bidi stress lines, a government-form layout. |
| pdf-lib on the Chrome form (`gen_acroform.mjs`) | `acroform-pdflib-arabic-fields` | AcroForm text fields and checkboxes with Arabic field names and one Arabic value whose appearance stream pdf-lib rendered unshaped (a known-bad appearance our engine must regenerate). |
| Quartz PDFContext + CoreText (`gen_coretext.swift`) | `coretext-*` (4) | What Pages, Preview, TextEdit and Safari export on macOS: Geeza Pro, Al Bayan, SF Arabic, Baghdad with automatic font fallback. |
| HarfBuzz + hand-written PDF objects (`gen_raw.py`) | `raw-*` (4) | Ideal Type0/CIDFontType2 output with correct ToUnicode; the same glyph runs with **no** ToUnicode; a ToUnicode that maps everything to U+FFFD; and a 1990s-style symbolic simple TrueType font with 1-byte codes and presentation-form glyphs in visual order. |
| ReportLab + arabic_reshaper + python-bidi (`gen_reportlab.py`) | `reportlab-visual-presentation-forms` | The most common "Arabic PDF" recipe on the web: presentation-form code points (U+FBxx/FExx) written in visual order. |
| PDFium render → degraded image → img2pdf (`gen_scans.py`) | `scan-*` (4) | Image-only scans: 300 dpi skewed JPEG with noise, the same 8° crooked, the same with a book-fold shadow, a shadowed corner and tea stains (the OCR cleanup target), and 200 dpi 1-bit. `--only=<name>` writes one of them; `--large` also produces a 500-page ≈500 MB scan for the N8 stress test (not committed). |
| pikepdf/qpdf (`gen_variants.py`) | `variant-*` (5), `perf-text-*` (2) | AES-256 (R6) encryption (user password `warraq`), object streams + xref stream, linearization, Arabic Info/XMP metadata + outlines + sticky note/highlight annotations + Arabic-named attachment, a hand-appended incremental update; 100- and 500-page text documents. |

## Real-world files (`realworld/`)

Class A Word/PDFMaker (3), B InDesign (2), C LibreOffice (2), D Google Docs Skia (2),
E scans (3, one with an OCR text layer), F Acrobat RTL AcroForm (1), G legacy encodings
without ToUnicode (2, plus 5 overlapping). See `realworld/manifest.md`.

## Regenerating

```bash
python3 generators/gen_chrome.py <repo> "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
python3 generators/gen_raw.py <repo> && python3 generators/gen_reportlab.py <repo>
swiftc -O generators/gen_coretext.swift -o /tmp/gen_coretext && /tmp/gen_coretext truth/coretext-geezapro-paragraphs.txt generated/coretext-geezapro-paragraphs.pdf GeezaPro 14
python3 generators/gen_scans.py <repo> && python3 generators/gen_variants.py <repo>
python3 generators/find_labels.py <repo> && node tools/gen_acroform.mjs <repo>   # needs pdf-lib + @pdf-lib/fontkit
python3 generators/build_manifest.py <repo>
```

Fonts used by the generators live in `tests/fonts/` (all OFL-1.1). The corpus
texts are in `generators/corpus_texts.py`; change them there and regenerate so
the truth files stay in sync.

## Rules

* Treat every file as hostile input. Open them only with the engines under test.
* A red Arabic test blocks merge (brief §13). New Arabic bugs get a regression
  file here before the fix (brief §0.4).
* Never edit a real-world file in place; derive a new file and record the derivation.
