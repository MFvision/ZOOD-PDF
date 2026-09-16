#!/usr/bin/env python3
"""Regenerate docs/research/01-arabic-test-results.md from tests/acid/results.json."""
import json, sys
from pathlib import Path
repo = Path(sys.argv[1]).resolve(); m = json.load(open(repo / "tests/acid/results.json"))
cands = ["pdfium", "pdfjs", "mupdf", "hayro", "warraq"]
names = {"pdfium": "PDFium (Chrome)", "pdfjs": "PDF.js", "mupdf": "MuPDF (AGPL ref.)", "hayro": "hayro raw glyphs", "warraq": "**Warraq core**"}
def cell(r, c):
    x = r.get(c, {}); sc = x.get("score", {})
    if not x.get("open"): return "❌ " + x.get("error", "")[:36]
    v = sc.get("verdict", "?")
    if "recall_logical" in sc: v += f" ({sc['recall_logical']:.2f}/{sc['recall_reversed']:.2f}, {sc['order_lcs']:.2f})"
    return v
rows = [f"| `{s}` | " + " | ".join(cell(r, c) for c in cands) + " |" for s, r in m.items() if any(r.get(c, {}).get("score", {}).get("verdict") not in ("no-truth", None) for c in cands)]
table = "| File | " + " | ".join(names[c] for c in cands) + " |\n|---|" + "---|" * len(cands) + "\n" + "\n".join(rows)
tally = {c: {} for c in cands}
for s, r in m.items():
    for c in cands:
        x = r.get(c, {}); v = "open-failed" if not x.get("open") else x.get("score", {}).get("verdict", "?")
        if v != "no-truth": tally[c][v] = tally[c].get(v, 0) + 1
tally_md = "\n".join(f"- {names[c]}: " + ", ".join(f"{k} {v}" for k, v in sorted(tally[c].items(), key=lambda kv: -kv[1])) for c in cands)
n_truth = sum(1 for s, r in m.items() if r.get("pdfium", {}).get("score", {}).get("verdict") not in ("no-truth", None))
logical = {c: tally[c].get("logical", 0) for c in cands}
perf_c = ["pdfium", "pdfium-rs", "pdfjs", "mupdf", "hayro", "warraq"]
perf = "| File | " + " | ".join(perf_c) + " |\n|---|" + "---|" * len(perf_c) + "\n" + "\n".join(f"| `{s}` | " + " | ".join(f"{m[s].get(c, {}).get('t_open_ms','?')} / {m[s].get(c, {}).get('t_render_p1_ms','?')} / {m[s].get(c, {}).get('t_text_all_pages_ms','–')}" for c in perf_c) + " |" for s in ("perf-text-100-pages", "perf-text-500-pages") if s in m)
rw = json.load(open(repo / "tests/corpus/arabic/realworld/manifest.json"))
rw_rows = []
for e in rw:
    st = e["filename"].replace(".pdf", ""); r = m.get(st, {})
    hd = lambda c: r.get(c, {}).get("text_head", "")[:60].replace("|", "\\|")
    rw_rows.append(f"| `{st}` | {e.get('producer','')[:28]} | {'yes' if e.get('presentation_forms_detected') else 'no'} | {hd('pdfium')} | {hd('warraq')} |")
rw_md = "| File | Producer | Pres. forms in ToUnicode | PDFium text head | Warraq text head |\n|---|---|---|---|---|\n" + "\n".join(rw_rows)
doc = f"""# Phase 0 · Arabic acid test results (updated with the Phase 1 core)

*Run on 2026-09-16 on macOS 27 (Apple Silicon) with PDFium 153/155 (pypdfium2 and pdfium-render 0.9.4 + pdfium-binaries chromium/8057), PDF.js 6.3.289 (Node 22 + @napi-rs/canvas), MuPDF 1.26.10 (PyMuPDF 1.26.5, AGPL reference only), hayro 0.7.1, and the Warraq core (`packages/core`, hayro device + own reconstruction). Harness: `tests/acid/` (`run_python.py`, `run_pdfjs.mjs`, `prototypes/`, `packages/core/warraq-core/examples/acid.rs`, `merge.py`, `score.py`; regenerate this file with `write_results_doc.py`). Screenshots of page 1 for every file and engine: `screenshots/<engine>/`, contact sheets `screenshots/sheet-<engine>-N.jpg`. Raw numbers: `tests/acid/results.json`.*

## 1. Corpus

{len(m)} files: 27 generated (with logical-order ground truth) and 15 real-world (Word/PDFMaker, InDesign, LibreOffice, Google Docs/Skia, MFP scans, a 1924 manuscript with an OCR layer, an Acrobat RTL form, and two legacy-encoding files). Corpus v1.1: the Chrome files use static font instances (Skia embeds them as CID fonts, as Google Docs exports do); one file keeps a variable webfont, which Skia embeds as a Type3 font with dots as separate glyphs mapped to U+0000. See `tests/corpus/arabic/README.md` and `manifest.md`. Scoring is word-level after NFKC and mark stripping and separates character order inside words from word order along lines (`tests/acid/score.py`):

* **logical** – words intact, order ≥ 0.75 of the truth sequence
* **words-ok/line-order-visual** – words intact but each line's words come out reversed
* **chars-reversed / partial-reversed** – characters inside words reversed (visual order)
* **partial / garbage / empty** – less than 90 % of words recoverable / < 50 % / nothing

## 2. Opens → renders correctly (visual check of the contact sheets)

| Engine | Opens | Renders correctly | Notes |
|---|---|---|---|
| PDFium | all | all | Encrypted, object streams, incremental update, legacy symbolic fonts, forms and annotations all correct. 1–25 ms per page natively. |
| PDF.js | all | text files correct; the two image-only scans rendered blank **in our Node harness** (JPEG decoding path in Node; to be re-verified in-browser) | Needs `disableFontFace` in Node. |
| MuPDF | all | all | **SIGSEGV during text extraction** of `chrome-amiri-tashkeel-ligatures.pdf` (reproducible: `python3 -c "import fitz; fitz.open(f)[0].get_text()"`). AGPL. |
| hayro / Warraq core | all but the encrypted file | all rendered files correct | Pure Rust, no unsafe; encryption is a Phase 2 item for our object layer. |

## 3. Extracts text in logical order (the P0 requirement)

Verdict (word recall logical / reversed, order LCS):

{table}

Tally over the {n_truth} truth-scored files:

{tally_md}

**Logical-order files: PDFium {logical['pdfium']}, PDF.js {logical['pdfjs']}, MuPDF {logical['mupdf']}, Warraq core {logical['warraq']}.** No shipping engine returns logical-order Arabic reliably: PDFium reverses characters of Skia/Chrome output and reverses word order of Quartz output; MuPDF swaps adjacent letters inside words when glyph advances are irregular (`رضيبية` for `ضريبية`) and crashed once; PDF.js is the best of the three on well-formed files but still fails Chrome-made and tashkeel-heavy text. The hayro column is the raw glyph stream (visual order, ToUnicode as written by the producer) that the Warraq reconstruction (ADR-0005) starts from. The Warraq core's remaining failures are the files without a usable ToUnicode map (`raw-amiri-cid-no-tounicode`, `raw-cairo-cid-broken-tounicode`, `raw-legacy-symbolic-truetype`), the variable-font Type3 file, and glyphs that Skia maps to U+0000 (contextual forms without cmap entries); glyph-name, outline-matching and OCR fallbacks are Phase 2 work.

Real-world files (no ground truth; first characters of page 1 as returned):

{rw_md}

Notable: PDFium silently folds presentation forms to base letters (its output never contains U+FBxx/FExx although 6 of the 15 real-world files map to them), so PDFium's text hides that the ToUnicode maps are wrong for search and copy in other viewers.

## 4. Selects text
All engines expose per-glyph positions; selection *geometry* is available everywhere, but selection *order* follows the extraction order above. The Warraq core returns lines with logical text and bounding boxes (`text_lines`), which the UI uses for its selectable text layer.

## 5. Edits one word and saves without breaking shaping; adds a new Arabic paragraph with a custom font

| Path | Add paragraph | Edit one word | Evidence |
|---|---|---|---|
| PDFium `FPDFText_SetText` / `FPDFText_LoadFont` (pypdfium2 and pdfium-render `set_text`) | ✗ unshaped, characters placed left-to-right | ✗ same | `tests/acid/write-tests/out-pdfium-add-text.png`, `edit-compare.png` row 3 |
| MuPDF `insert_text` | ✗ isolated presentation forms, reversed | n/a | `out-mupdf-add-text.png` |
| MuPDF `insert_htmlbox` (Story engine, HarfBuzz) | render ✓, extraction garbage (broken ToUnicode) | n/a | same; AGPL |
| pdf-lib `drawText` / form field appearance | ✗ almost nothing drawn / unshaped | n/a | `out-pdflib-add-text.png`, corpus `acroform-pdflib-arabic-fields` |
| Python HarfBuzz + own PDF writer (`gen_raw.py`) | ✓ render; PDF.js logical 0.935 | – | corpus `raw-amiri-cid-identity-tounicode` |
| Rust `harfrust` + `unicode-bidi` + `skrifa` + `subsetter` + `pdf-writer` (`prototypes/proto-text write`) | ✓ render; PDF.js logical 0.951, order 0.893 | – | `out-rust-write.pdf` |
| Rust `lopdf` + the same text stack (`prototypes/proto-text edit`, now `warraq-pdf::replace_word`) | – | ✓ `للتقنية` → `للبرمجة`: located through ToUnicode across several TJ operators, replaced by a shaped run in a new subset font; MuPDF reads `العميل: شركة زود للبرمجة` | `out-rust-edit.pdf`, `edit-compare.png` row 2 |

## 6. Performance (page 1 open / render at 1.5× / text of all pages, ms)

{perf}

PDFium natively is well inside N8. The Warraq core column is the pure-Rust path (hayro) that also runs in WASM. The 500 MB scanned stress file (`gen_scans.py --large`) has not been run yet.

## 7. Bundle sizes (N8: < 8 MB gzipped)
`pdfium.wasm` 5.32 MB raw / **2.41 MB gzipped**; Warraq core WASM (pure Rust, hayro rasterizer included) 4.78 MB raw / **1.95 MB gzipped**. Tesseract.js core and `ara.traineddata` (12.6 MB) load on demand only.

## 8. What surprised us
1. Chrome's own engine cannot copy Arabic from Chrome's own PDFs in order (Skia writes glyphs in visual order with presentation-form ToUnicode, and U+0000 for contextual forms that have no cmap entry; PDFium's bidi pass does not undo it).
2. Skia embeds **variable** webfonts as Type3 fonts with dotted letters split into skeleton and dot glyphs; only static fonts become CID fonts.
3. CoreText applies the bracket-pair rule (UAX #9 N0), so `(Premium Support) | 12 | 150.00` lands the numbers left of the bracket group, while producers without N0 put them right of it; the same visual glyph order can have two logical readings, which the reconstruction resolves toward a right-to-left human reading.
4. `rustybuzz` is archived; `harfrust` matched HarfBuzz 12.1 glyph for glyph on Amiri.
5. `unicode-bidi` 0.3.18 resolves a European terminator after a number (`15%`) to the paragraph level (rule W5); `warraq-text::bidi` repairs it.
6. MuPDF crashes on a modern Chrome-generated file; `lopdf` 0.45 drops the objects of an AES-256 file.
"""
(repo / "docs/research/01-arabic-test-results.md").write_text(doc, encoding="utf-8"); print("01 regenerated", len(doc.split()), "words; logical:", logical)
