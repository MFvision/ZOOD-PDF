# Phase 0 · Decision (GATE 0)

*Inputs: [00-landscape.md](00-landscape.md) (live-verified licenses and status), [01-arabic-test-results.md](01-arabic-test-results.md) (41-file corpus, four engines, two end-to-end prototypes). Decisions are recorded as ADR-0003/0004/0005 in `docs/decisions/`.*

## The three options

| | 1 · PDFium rasterizer + our Rust text/object layer (**recommended**) | 2 · Pure Rust (hayro rasterizer + our layer) | 3 · PDF.js viewer + Rust editing core |
|---|---|---|---|
| Rendering fidelity on the corpus | 41/41 correct, forms and annotations included | 40/41 (no encryption), fidelity good, forms/annotation appearances not generated | 39/41 in Node (images unverified), no native path |
| Robustness | Google-fuzzed, Chrome-shipped C++; sandbox needed | Memory-safe, `forbid(unsafe)`; young (2025), 1000-file regression suite | Mature JS |
| Arabic reading | none of them: ours (ADR-0005) | ours | ours |
| Arabic writing/editing | ours (prototype verified) | ours | ours, but the viewer and the editor disagree on geometry |
| WASM size | 2.41 MB gz + Rust core | smallest (Rust only) | PDF.js 34.8 MB unpacked (≈ 1.5 MB gz core) |
| Native desktop/iOS | yes (pdfium-binaries for mac/win/linux/ios/android) | yes | no (webview only) |
| License | BSD-3 + MIT/Apache | MIT/Apache | Apache-2.0 |
| Two engines to keep consistent? | no (one rasterizer everywhere) | no | yes |

## Recommendation
**Option 1**, with hayro kept as an optional feature and as our content-stream interpreter (its `Device` API gave us glyphs, positions, ToUnicode strings and font data on 40/41 files), and with a pluggable `Renderer` trait so Option 2 can replace Option 1 per target when hayro gains encryption and form rendering. Text shaping and fonts: HarfRust + fontations + unicode-bidi + subsetter (ADR-0004); rustybuzz is archived. Object layer: lopdf for editing existing files (incremental updates), pdf-writer for new objects, our own encryption/signature code with QPDF and pyHanko as references.

## Fork · wrap · write

| Layer | Decision | Component |
|---|---|---|
| Rasterizer, form-field appearance and fill, annotation appearance streams | **wrap** | PDFium via pdfium-render (native + WASM shim) |
| Content-stream interpretation for text/glyph extraction | **wrap** (fork if the Device API proves insufficient) | hayro-interpret |
| Object model, incremental save | **wrap + contribute** | lopdf |
| New objects, fonts, ToUnicode, PDF/A later | **wrap** | pdf-writer, subsetter (krilla for create/export flows) |
| Shaping, bidi, segmentation, normalization | **wrap** | harfrust, skrifa/read-fonts, unicode-bidi, icu4x |
| Paragraph layout / reflow for the editor | **evaluate in Phase 2** | parley (fits the same font stack) vs. our own |
| Logical-order text reconstruction, Arabic search normalization, font fallback chain, editing operations, redaction, compare, encryption, digital signatures (PAdES), compression/optimization | **write** | `packages/core` (Rust) |
| OCR | **wrap** | tesseract.js (web/extension), Tesseract native (desktop); PaddleOCR/RapidOCR as a desktop option later |
| UI shell, RTL-first | **write** | React + TypeScript, Fluent UI System Icons |
| Hosts | **wrap** | Tauri 2 (desktop, later iOS), MV3 extension, Vite/Astro web |

## Risks and mitigations
1. **C++ in the core (PDFium).** WASM sandbox in browsers; separate render process on desktop; we never pass PDFium's text to the user.
2. **pdfium-render's WASM integration** (Rust WASM ↔ Emscripten PDFium) is the least-travelled path in the plan. Phase 1 proves it first; fallback is hayro rendering in WASM until it works.
3. **HarfRust conformance gaps** (README). Corpus + HarfBuzz C++ cross-check in CI.
4. **lopdf robustness on hostile input.** cargo-fuzz with the corpus as seeds from Phase 2; hayro-syntax is the safe read path.
5. **Tesseract Arabic accuracy** on poor scans; deskew/cleanup pipeline and a PaddleOCR desktop option; benchmark in v1.
6. **License drift**: re-verify `raw/landscape.json` quarterly; Stirling-PDF, EmbedPDF and surya show how quickly terms change.
7. **Session workspace**: the repository currently lives in an ephemeral session folder and must be moved to a permanent path (see STATUS).

## What we will not do
* Ship MuPDF, Poppler, iText, PyMuPDF, pandoc, ONLYOFFICE or surya weights (copyleft or use-restricted).
* Trust any engine's text order for copy, search, or editing.
* Write presentation forms or visual-order strings into a PDF, ever.
