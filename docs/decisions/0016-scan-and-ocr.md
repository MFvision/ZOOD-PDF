# ADR 0016 — Scan & OCR: local tesseract.js, own preprocessing, engine-written text layer

* Status: accepted
* Date: 2026-09-26

## Context
Scanned PDFs and phone photos carry no text: they cannot be searched, selected or read aloud. The Scan & OCR tool
must make them searchable **on the device** (no account, no network), work for Arabic first (plus Urdu Nastaliq,
Persian and English), run in the web app, the MV3 extension and the desktop host under their CSPs, and write the
result as an incremental update like every other edit.

## Decision
1. **Recogniser: tesseract.js 7 (Apache-2.0), LSTM-only cores**, everything served from the app's own origin under
   `ocr/` (`packages/ui/vite/ocr.ts`): `worker.min.js`, `tesseract-core{,-simd,-relaxedsimd}-lstm.wasm.js` and the
   language models. The worker is started **from its file** (`workerBlobURL: false`), so no `blob:` worker and no
   `unsafe-eval` are needed; the core only needs `'wasm-unsafe-eval'`, which the web, extension and desktop CSPs
   already allow. `cacheMethod: 'none'` (no IndexedDB copies); the service worker caches the `ocr/` files **on first
   use** (not at install: ~40 MB), so OCR also works offline afterwards.
2. **Models: tessdata tag 4.1.0 ("best-int": tessdata_best LSTM models converted to integer), Apache-2.0**, for
   `ara`, `eng`, `fas`, `urd`. They are **not committed** (≈ 28 MB, `eng` alone 23 MB — above the 15 MB budget):
   `scripts/fetch-ocr-models.sh` downloads them into the git-ignored `.cache/ocr-models` and verifies pinned
   SHA-256 checksums; the UI build copies them and **fails** when one is missing (no silent OCR-less build).
   `verify.sh` and the desktop workflows fetch them. The licence and provenance ship next to the models.
3. **Preprocessing in TypeScript, in a dedicated worker** (`preprocess.ts` / `preprocess.worker.ts`), not in the
   Rust engine: the images come from canvas decoding in the browser anyway, the work is simple integer loops, and it
   keeps the engine WASM small. Steps (each optional, all bounded by the pixel count; images above 64 MP or 16 000 px
   a side are refused **from their header**, before decoding):
   perspective correction (4-point homography, bilinear) → grayscale → shadow flattening (background = grayscale closing
   of a block-max reduced copy, blurred, then division) → deskew (projection-profile variance over the dark pixels,
   ±15°, coarse to fine 0.5° → 0.05° → 0.01°, bilinear rotation; the angle is reported) → Sauvola binarisation (integral images, window
   31 px at 300 dpi, k = 0.3) → despeckle (connected components under N px removed).
4. **Text layer written by the engine** (`ocr.addTextLayer`, `ocr.createPdf`, `warraq-core/src/ocr`): invisible
   text (`3 Tr`) in a tiny embedded GlyphLessFont (Identity-H, identity ToUnicode), one run per word scaled with `Tz`
   to the word box. **RTL words** are stored in **visual** order (digit/Latin runs kept left to right) with an
   upright matrix inside `/ReversedChars BMC … EMC` — exactly how Chrome writes Arabic — and **without
   `/ActualText`**; LTR words carry `/ActualText`. This deviates from the brief's "ActualText per word" on purpose,
   after measuring the viewer's PDFium build (`FPDFText` over variants): PDFium runs its line bidi pass over
   `/ActualText` too, so a logical ActualText comes out *reversed* in search/copy, while visual glyphs in
   `/ReversedChars` come out logical. Tesseract's own convention (logical order + mirrored matrix) is also reversed
   in PDFium. warraq-text reads the visual runs back in logical order (tashkeel included), like Chrome's text.
   A real space glyph follows each word in content order (left of an RTL word) so readers see word boundaries
   (warraq-text accepts a space glyph wider than the gap it sits in); `/Direction` is never written. For a crooked
   page the words are mapped back through the detected angle (the page image is untouched), so the layer lies on
   the crooked text. All OCR'd pages go into **one** incremental update.
5. **UI**: one sheet, two tabs — *Make searchable* (pages without text are detected with the engine; per-page
   progress; cancel terminates the workers and leaves the document unchanged) and *Scan pages* (files, or the camera
   through `getUserMedia` where available; corner handles for the crop, keyboard-movable; cleaned preview and the
   detected skew). Languages default to the interface locale.

## Consequences
* Accuracy is measured, not assumed: `pnpm ocr:bench` runs the corpus scans through the real UI in headless
  Chromium and writes `tests/ocr/results.json`; floors live in `tests/ocr/baseline.json` (see STATUS).
* The first OCR downloads the core and the chosen models from the app's origin (a few MB for Arabic, 23 MB for
  English); offline before that first use, OCR is unavailable.
* Tesseract's Arabic models drop most tashkeel and confuse final yaa/alef maqsura; Urdu Nastaliq is weak (the models
  are trained on Naskh-like fonts). These are model limits, recorded in STATUS.
