# ADR-0003 · Core stack: PDFium for rasterization and forms, our own Rust text/object layer, one core built natively and as WASM

**Status:** accepted at GATE 0 · **Date:** 2026-09-16 · Evidence: `docs/research/01-arabic-test-results.md`, `docs/research/00-landscape.md`

## Context
The product needs (a) faithful, fast, hostile-input-proof rendering of existing
PDFs on desktop and in the browser, (b) correct Arabic **editing** (shaping,
bidi, reflow, font embedding/subsetting, searchable output) and (c) correct
Arabic **reading** (logical-order extraction, search) from PDFs that are, in the
wild, mostly broken. No open-source component does (b) or (c) today; several do
(a).

## Options considered
1. **PDFium everywhere** (BSD-3) through `pdfium-render`: native dynamic library on
   desktop/mobile, Emscripten build in the browser (2.41 MB gzipped).
2. **Pure Rust everywhere** (`hayro` rasterizer + `lopdf`/`pdf-writer`): one
   toolchain, memory-safe, smallest WASM; young rasterizer, no encryption, no
   forms/annotation appearance generation yet, unproven on hostile input.
3. **PDF.js in the webview** (Apache-2.0) for viewing plus a Rust core for
   editing: two engines that disagree about text and geometry; no native path.
4. **MuPDF** (AGPL): excellent renderer but copyleft, and it crashed
   (SIGSEGV) on one Chrome-generated corpus file during text extraction.

## Choice
* **Rasterization, form-field rendering/filling and annotation appearances:
  PDFium** via `pdfium-render`, on every target (native lib on desktop/iOS;
  `pdfium-binaries` WASM in the extension and web). PDFium rendered all 41 corpus
  files correctly, including legacy encodings and the two scans, in 1–25 ms per
  page natively.
* **Object model, editing and writing: our Rust layer** (`lopdf` for reading and
  modifying existing files including incremental updates, `pdf-writer` for new
  objects, `subsetter` for font subsets, `harfrust`/`unicode-bidi`/`skrifa` for
  text). The prototype `prototypes/proto-text` writes a correct Arabic PDF and
  replaces one word in an existing PDF with a different font, verified by PDF.js
  and PDFium extraction.
* **Text reading: our own reconstruction** (ADR-0005). Content-stream
  interpretation uses `hayro-interpret`'s glyph device today (pure Rust, safe,
  ToUnicode-aware, gives glyph ids and font data); PDFium's own text page is not
  trusted for order.
* `hayro` stays as an **optional pure-Rust rasterizer feature** (sandboxed
  thumbnails, environments where the PDFium WASM cannot load) and as our
  content-stream interpreter; it is not the reference renderer until it supports
  encryption and forms.
* **One core, two builds:** `packages/core` compiles to a native library (Tauri
  desktop, iOS) and to `wasm32-unknown-unknown` (extension, web). The JS shim
  that binds the Rust WASM module to the PDFium Emscripten module is the only
  target-specific glue.

## Consequences
* We ship a C++ component. Mitigations: it is Google-fuzzed and Chrome-shipped;
  in the browser it is sandboxed by WASM; on desktop it runs in a separate
  process (`warraq-renderd`) so a malicious file cannot take the app down.
* Encryption (AES-256 read/write), object streams, linearization and repair are
  implemented in our object layer (QPDF is the reference; `pikepdf` is used in
  tests to cross-check).
* Bundle budget (N8): PDFium 2.41 MB gz + Rust core (target < 2 MB gz) +
  Tesseract.js loaded on demand. Under 8 MB.
* Two parsers exist for a while (`lopdf` for edit, `hayro-syntax` for read).
  Phase 2 keeps the read path behind one trait so it can be replaced.

## License implications
All shipped components are BSD-3 (PDFium and its bundled deps: FreeType,
libjpeg-turbo, OpenJPEG, zlib, libpng, lcms, ICU, abseil), MIT or Apache-2.0
(Rust crates), OFL (fonts). No copyleft in the build.
