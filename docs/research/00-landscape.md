# Phase 0 · Landscape: open-source components for an Arabic-first PDF editor

*Verified live on 2026-09-16 against the GitHub REST API, GitLab, crates.io, npm and the projects' own LICENSE files. Raw records with per-field source URLs: [`raw/landscape.json`](raw/landscape.json); full tables: [`raw/landscape-table.md`](raw/landscape-table.md). Nothing in this document comes from memory; where a fact could not be fetched it is marked "unverified".*

## 1. How to read this

* **License** is the SPDX id from the API, cross-checked against the LICENSE file when the API said `NOASSERTION`. **Copyleft** (GPL/AGPL/LGPL/MPL) is flagged; those components are usable only if we accept the license terms for the artifact that links them (AGPL contaminates the whole app; MPL is file-level and fine as a separate process/tool).
* **Arabic/RTL issues** = number of issues *and* PRs matching `arabic OR rtl OR bidi` in the tracker. A high count means either many bugs or a large user base; a zero on a mirror with issues disabled (MuPDF, Okular, LibreOffice, PDFBox, DSS, iText) means nothing.
* **WASM** states only what a fetched README or npm package says.
* Sizes are measured, not estimated (see §9).

## 2. Rendering

| Candidate | License | Lang | Stars | Last push | Arabic/RTL issues | WASM | Assessment |
|---|---|---|---|---|---|---|---|
| **PDFium** (pdfium.googlesource.com; GitHub mirror `chromium/pdfium` is archived) | BSD-3-Clause (+ Apache-2.0 texts) | C++ | 543 (mirror) | upstream active | n/a | **Yes, official experimental build** via `bblanchon/pdfium-binaries` (`pdfium-wasm.tgz` 2.57 MB; `.wasm` 5.3 MB raw / **2.41 MB gzipped**) | Chrome's engine. Renders all 41 corpus files correctly, including the two legacy-encoding files. No shaping on write. Text extraction of Arabic is in visual order for Skia-made PDFs (see 01). |
| **pdfium-render** (Rust binding) | MIT OR Apache-2.0 | Rust | 705 | 2026-08-16 | 0 | Yes (WASM via JS shim, per README) | Wraps the full PDFium API incl. page objects, forms, annotations, save. Used by our native prototype. |
| **PDF.js** | Apache-2.0 | JS | 53,878 | 2026-09-15 | 285 | n/a (JS) | Firefox's viewer/editor. Best Arabic text extraction of the three viewers on our corpus (logical order on well-formed files). No write API beyond annotations. |
| **hayro** (LaurenzV, Typst ecosystem) | Apache-2.0 OR MIT | Rust | 765 | 2026-09-08 | 0 | pure Rust, wasm32 unverified in README (our prototype compiles it) | Young pure-Rust rasterizer, >1000-file regression suite from pdf.js/PDFBox. No encryption support yet, no text extraction API (a `Device` trait gives glyph callbacks with ToUnicode strings, which we use). |
| MuPDF / mupdf.js | **AGPL-3.0-or-later** (commercial license available) | C | 2,961 | 2026-09-15 | issues disabled | official WASM (`mupdf` npm, 14.3 MB unpacked) | Reference-quality renderer; **segfaults** on one Chrome-generated corpus file during text extraction (PyMuPDF 1.26.5 / MuPDF 1.26.10). Copyleft: reference only. |
| Poppler | **GPL-2.0 / GPL-3.0** | C++ | GitLab | 2026-09-16 | arabic 6 / rtl 13 | none known | Copyleft; README says callers must be GPL. Not usable. |
| pdf-rs | MIT | Rust | 1,697 | 2026-07-18 | 0 | unverified | Parser/object model, no rasterizer. |
| typst | Apache-2.0 | Rust | 56,041 | 2026-09-15 | 166 | community ports | Not a PDF renderer, but its text stack (harfrust → rustybuzz, unicode-bidi, subsetter, pdf-writer/krilla) produces correct Arabic PDFs and is what we adopt for writing. |

## 3. PDF read / write / edit

| Candidate | License | Lang | Stars | Last push | Arabic/RTL issues | WASM | Assessment |
|---|---|---|---|---|---|---|---|
| **QPDF** | Apache-2.0 | C++ | 5,417 | 2026-09-06 | 6 | community `qpdf-wasm` 2.3 MB | Gold standard for object-level surgery, encryption (AES-256 read/write), object streams, linearization, repair. We use it in Phase 0 through `pikepdf` (MPL-2.0, tool-only). Candidate for repair/linearize/encrypt if we do not write these ourselves. |
| **lopdf** | MIT | Rust | 2,251 | 2026-09-12 | 3 | wasm targets mentioned in README | Object model with load/modify/save and incremental-update structures. Used by our edit prototype (works). Parser robustness on hostile input needs fuzzing. |
| **pdf-writer** | MIT OR Apache-2.0 | Rust | 741 | 2026-08-17 | 1 | pure Rust | Low-level writer (Typst). Used by our write prototype. |
| **krilla** | MIT OR Apache-2.0 | Rust | 444 | 2026-09-14 | 5 | pure Rust | High-level document creation on pdf-writer: fonts, subsetting, ToUnicode, PDF/A, PDF/UA tagging, embedded files. `draw_glyphs` takes pre-shaped glyphs; its own `draw_text` uses a *naive* shaper (not for Arabic). Candidate for the "create/export" flows and PDF/A. |
| **subsetter** | MIT OR Apache-2.0 | Rust | 56 | 2026-07-23 | 0 | pure Rust | TrueType/CFF subsetting with glyph remapping (Typst). Used by both prototypes. |
| pdfcpu | Apache-2.0 | Go | 8,838 | 2026-09-14 | 4 | community `pdfcpu-wasm` 30 MB | Excellent feature list (forms, signing validation, booklets) but Go: not our core language and its WASM is huge. Reference for features. |
| PDFBox | Apache-2.0 | Java | 3,119 | 2026-09-15 | issues disabled | no | Reference for algorithms (text stripping, font handling, signatures); Java rules it out as a component. |
| pdf-lib / @cantoo/pdf-lib | MIT | TS | 8,632 / 349 | 2024-07 / 2026-09 | 11 | JS | **No shaping, no bidi**: our sample shows Arabic drawn as disconnected LTR letters. Upstream unmaintained since 2021; the cantoo fork is active. Not a candidate for the core. |
| pypdf, pdfminer.six, pikepdf, PyMuPDF | BSD-3 / MIT / **MPL-2.0** / **AGPL-3.0** | Python | – | – | 48 / 6 / 2 / 33 | no | Research tooling only. PyMuPDF is AGPL: never ship. |
| printpdf | MIT | Rust | 1,113 | 2026-09-05 | 4 | WASM demo | Generation-only; no shaping engine of its own. |
| iText 7 | **AGPL-3.0-or-later** | Java | 2,256 | 2026-09-14 | issues disabled | no | Copyleft + Java. Reference only (its `pdfCalligraph` Arabic add-on is closed source). |

## 4. Text shaping, bidi, fonts

| Candidate | License | Lang | Stars | Last push | Arabic/RTL issues | WASM | Assessment |
|---|---|---|---|---|---|---|---|
| **HarfRust** (`harfbuzz/harfrust`) | MIT | Rust | 301 | 2026-09-10 | 17 | pure Rust | The HarfBuzz org's Rust port on `read-fonts`; tracks HarfBuzz 14.3.1; no unsafe. **rustybuzz is archived and points to HarfRust.** Adopted. |
| rustybuzz | MIT | Rust | 667 | 2026-07-26 | 29 | pure Rust | **Archived.** Do not start new work on it. |
| HarfBuzz (C++) / harfbuzzjs | MIT-Modern-Variant | C++ | 6,083 | 2026-09-16 | 255 | official emscripten build 1.2 MB | The reference. Used in Phase 0 through `uharfbuzz` to generate the corpus. Not needed at runtime if HarfRust holds. |
| **fontations** (`read-fonts`, `skrifa`) | MIT OR Apache-2.0 | Rust | 826 | 2026-09-16 | 10 | pure Rust | Google's font parsing (Chrome/Skia are migrating to it). Basis of HarfRust; gives metrics, outlines, cmap, variations. Adopted. |
| ttf-parser | MIT OR Apache-2.0 | Rust | 792 | 2026-08-06 | 2 | no_std/WASM | Mature; only needed if we kept rustybuzz. |
| **unicode-bidi** (servo) | MIT OR Apache-2.0 | Rust | 87 | 2026-09-15 | 85 | pure Rust | UAX #9 reference implementation used by Servo/Typst. Adopted. |
| ICU4X | Unicode-3.0 | Rust | 1,861 | 2026-09-15 | 135 | pure Rust | Segmentation (line/word/grapheme), normalization, properties, collation. Adopt `icu_segmenter` + `icu_normalizer` for search and line breaking. |
| **parley** (linebender) | Apache-2.0 OR MIT | Rust | 735 | 2026-09-16 | 112 | pure Rust | Paragraph layout (bidi, HarfRust shaping, font fallback via fontique, line breaking, alignment). Candidate for the paragraph editor; krilla ships a parley→PDF example with Arabic. |
| cosmic-text | MIT OR Apache-2.0 | Rust | 2,148 | 2026-08-08 | 49 | pure Rust | Alternative layout engine (rustybuzz-based). Parley preferred for the HarfRust/fontations alignment. |
| allsorts | Apache-2.0 | Rust | 802 | 2026-05-13 | 8 | yes | Strong Arabic/Indic shaper (Prince XML). Alternative shaper if HarfRust regresses. |
| fontkit | MIT | JS | 1,670 | 2024-08-14 | 19 | JS | pdf-lib's font engine. Not needed. |
| Fonts: Cairo, Amiri, Noto Naskh Arabic, Noto Sans Arabic, Tajawal, IBM Plex Sans Arabic, Scheherazade New | OFL-1.1 (METADATA.pb verified) | – | – | – | – | – | Fallback chain and UI fonts; redistributable with the OFL text. |

## 5. OCR

| Candidate | License | Arabic | Stars | Last push | WASM / size | Assessment |
|---|---|---|---|---|---|---|
| **Tesseract** + tessdata_best | Apache-2.0 | `ara.traineddata` 12.6 MB (verified) | 76,505 | 2026-09-11 | **tesseract.js** 7.0 (Apache-2.0), core 30.6 MB unpacked (≈ 4–5 MB wasm) | The only permissive engine with a browser build and Arabic. v1 default for web/extension; native Tesseract on desktop. Accuracy on Arabic is mediocre on low-quality scans (benchmark in v1). |
| PaddleOCR | Apache-2.0 | yes (arabic rec model) | 89,608 | 2026-07-22 | `@paddle-js-models/ocr` (ch/en only) | Best accuracy/speed for server-side; needs Paddle/ONNX runtime; Arabic model must be converted for ONNX. Desktop option later. |
| EasyOCR | Apache-2.0 | yes | 29,993 | 2025-12-05 | no (PyTorch) | Python/PyTorch; desktop-only via sidecar. Slower maintenance. |
| docTR | Apache-2.0 | limited | 6,347 | 2026-09-15 | no | Latin-centric. |
| surya / marker | Apache-2.0 **code**, weights OpenRAIL-M (free only under $5M funding/revenue) | yes | 21,392 | 2026-09-11 | no | Strong Arabic layout+OCR but weight license is use-restricted: flag for legal before any bundling. |
| RapidOCR | Apache-2.0 | via Paddle models | 7,841 | 2026-09-16 | no | ONNX runtime packaging of PaddleOCR; desktop candidate. |
| ocrs | Apache-2.0 | Latin only | 1,886 | 2026-09-13 | yes | Pure Rust, WASM; no Arabic model yet. Watch. |
| OCRmyPDF | **MPL-2.0** | via Tesseract | 34,771 | 2026-09-16 | no | Pipeline reference (deskew, cleanup, sandwich PDF). MPL is fine as an external tool; we re-implement the pipeline in Rust. |

## 6. Conversion

| Candidate | License | Assessment |
|---|---|---|
| LibreOffice (core mirror) | MPL-2.0 (API reports GPL-3.0 from root COPYING; libreoffice.org states MPL-2.0) | Office ⇄ PDF with real Arabic support; headless sidecar (optional local install) or opt-in server. No usable WASM (npm `libreoffice-wasm` does not exist). |
| pdf2docx (now `ArtifexSoftware/pdf2docx`) | relicensed **MIT**, declared unmaintained | Depends on PyMuPDF (AGPL). Reference only. |
| docx4j | Apache-2.0 (Java) | Reference. |
| docx-rs (`bokuweb/docx-rs`) | MIT (Rust, official `docx-wasm`) | Candidate for PDF→Word *writing* side in Rust/WASM. |
| pandoc | **GPL-2.0-or-later** | Copyleft; optional local tool only. |
| Chromium print-to-PDF | (browser) | HTML→PDF in the extension/web (Skia/PDF backend; note its Arabic text extraction problems, §01). |
| ONLYOFFICE | **AGPL-3.0** | Server-side, copyleft. Reference. |

## 7. Complete editors (UX and feature reference)

| Project | License | Stars | Arabic/RTL issues | What to learn |
|---|---|---|---|---|
| Stirling-PDF | MIT **open-core** (proprietary `app/proprietary`, `engine/`, SaaS/portal/desktop dirs since 2025-11-27) | 92,266 | 44 | Tool catalogue and naming; server-side Java. Arabic: relies on LibreOffice/PDFBox, no editing of Arabic text. |
| EmbedPDF | Apache-2.0 except `cloudpdf/server` (FCL-1.0-ALv2) | 4,484 | 4 | PDFium-in-WASM viewer SDK with plugins; closest architectural cousin on the web side. |
| PDF.js (Firefox editor) | Apache-2.0 | 53,878 | 285 | Annotation editing UX, text layer, RTL text layer handling. |
| PDF Arranger, PDFsam | GPL-3.0 / AGPL-3.0 | 5,878 / 4,568 | 7 / 5 | Page-organization UX. |
| Xournal++, Okular, sioyek | GPL-2.0 / GPL-2.0+ / GPL-3.0 | 15,376 / 1,510 / 9,865 | 14 / 0 / 12 | Annotation and reading UX; Okular's Arabic is via Poppler. |
| GitHub search "pdf editor arabic" / "rtl pdf" | – | ≤ 157 stars | – | Nothing substantial exists: the top results are tiny scripts. The niche is open. |

## 8. Digital signatures and app shells

| Candidate | License | Assessment |
|---|---|---|
| pyHanko | MIT (Python) | The best open PAdES/LTV reference implementation; port its logic. |
| DSS (EU) | LGPL-2.1 (Java) | Validation policy reference. |
| RustCrypto `cms`, `x509-cert`, `rustls`/`rustls-webpki` | Apache-2.0 OR MIT | Building blocks for CMS/PAdES in Rust (no OpenSSL). |
| pdfsign (Go) | BSD-2-Clause | Small readable reference for ByteRange placement. |
| Tauri 2 | Apache-2.0 OR MIT | Desktop + mobile shell over the system webview; Rust core links natively. Adopted. |
| Electron | MIT | Larger binaries, bundles Chromium; not needed since our renderer is our own. |
| Vite / Astro / Next.js | MIT | Vite for the app bundle, Astro for the static tool site. |
| Fluent UI System Icons / Lucide | MIT / ISC | Icon sets (no Adobe assets). |

## 9. Measured sizes (for N8: WASM < 8 MB gzipped)

| Artifact | Raw | Gzipped |
|---|---|---|
| `pdfium.wasm` (bblanchon chromium/8057, no V8/XFA) | 5,317,566 B | **2,414,178 B** |
| `pdfium.js` glue | 164,733 B | 30,186 B |
| tesseract.js-core wasm (unpacked package 30.6 MB incl. variants) | ≈ 4–5 MB per variant | not measured |
| `ara.traineddata` (tessdata_best) | 12,603,724 B | not measured (loaded on demand, not in the bundle) |

## 10. Copyleft register (from N6)

AGPL: MuPDF, mupdf.js, PyMuPDF, iText 7, ONLYOFFICE, PDFsam. GPL: Poppler, pandoc, Okular, Xournal++, PDF Arranger, sioyek. LGPL: DSS. MPL-2.0: OCRmyPDF, pikepdf, LibreOffice. Use-restricted weights: surya, marker. Open-core carve-outs: Stirling-PDF, EmbedPDF (server only). **None of these ships in the product.** Phase 0 tooling uses pikepdf (MPL) and PyMuPDF (AGPL) as reference measurement tools only; they are not part of the build.
