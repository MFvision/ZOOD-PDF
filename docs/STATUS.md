# STATUS — Warraq

*Updated 2026-09-16, end of the first session: Phase 0 complete, Phase 1 complete, Phase 2 well advanced.*

## Where the product stands

| Capability | State |
|---|---|
| Open, render, thumbnails, zoom, search | works on desktop (native PDFium), web and extension (pure Rust) |
| Arabic text **reading** in logical order | 16 of the truth-scored corpus files, against 2 for PDF.js, 2 for MuPDF, 0 for PDFium |
| Arabic text **editing** with reflow | works: detect paragraph → erase → re-shape → redraw, exposed to JS |
| Encrypted files | read everywhere: R2–R6, RC4 40/128, AES-128, AES-256 |
| Saving | incremental update; the opened bytes stay as the literal prefix |
| Hostile input | mutation harness on every pull request; cargo-fuzz targets ready for nightly |

Every one of the 48 corpus files opens. 63 tests green, clippy clean, `wasm32-unknown-unknown` compiles, core WASM 2.50 MB gzipped (budget 8 MB).

## Completed this session
* **Phase 0** — landscape audit (92 live-verified records), Arabic corpus (48 files: 33 generated with ground truth, 15 real-world with provenance), acid harness across five engines plus our own, two prototypes, GATE 0 (`docs/research/02-decision.md`, ADR-0003/4/5).
* **Phase 1** — architecture; Rust core (`warraq-text`, `warraq-pdf`, `warraq-render`, `warraq-core`) native and WASM; RTL-first React shell and web app; MV3 extension; Tauri desktop with native PDFium bundled; CI (rust, wasm gate, web, corpus gate, robustness, desktop matrix, release draft).
* **Phase 2** — bidi with a W5 repair, HarfRust shaping conformant with HarfBuzz, Arabic search normalization, logical-order reconstruction with cmap/GSUB/dot-recomposition fallbacks, paragraph detection and reflow, content-stream text location, erase and replace, subset font embedding with correct ToUnicode, incremental save, the standard security handler, and the robustness harness.
* **ADR-0006** recorded your answers: name, license and native PDFium confirmed; browser builds default to the pure-Rust rasterizer; Persian and Urdu first-class (corpus and fonts added).

## Next (in order)
1. **UI editing surface**: click a paragraph, edit it, undo/redo, and the font-substitution warning. The core API is ready and exposed (`paragraphs`, `replace_paragraph`, `save`).
2. **PDFium WASM shim** so the web build can optionally use PDFium for form and annotation fidelity.
3. **Remaining extraction gaps**: glyph-shape matching against bundled fonts for files with no usable ToUnicode (the Skia/Noto Type3 case and Nastaliq Urdu), then OCR of the rendered line as the last resort.
4. **GATE 2 demo** on a Word-exported and a scanned Arabic file, verified in Acrobat (needs a machine with Acrobat installed).
5. Golden render tests in CI; PDF.js image rendering re-check in a browser; the 500 MB scan stress run.

## Decisions needed from you
1. **GitHub organization** — nothing has been pushed: `gh repo create <org>/warraq --private --source . --push`.
2. **Permanent folder** — the repository still lives in this session's scratch workspace and will be removed with the session. Name a folder and I will move it.
3. **Xcode license** — `/usr/bin/cc` and the system `python3` refuse to run until `sudo xcodebuild -license accept` (needs your password). Builds work because they are pointed at Xcode's clang directly.

## Known gaps, stated plainly
* **Nastaliq Urdu** extraction is still garbage: cascading Nastaliq ligatures do not reverse-map from glyphs the way Naskh does. Needs shape matching or OCR.
* **Ten corpus files** come back with U+FFFD placeholders where a glyph has no usable ToUnicode, cmap or GSUB evidence. Placeholders are deliberate: words are never silently merged.
* **Writing encryption** is not implemented (reading only), so an encrypted file must currently be saved as a plaintext rewrite.
* **SASLprep** is not applied to R5/R6 passwords; ASCII passwords are exact.
* **Line breaking** is greedy at spaces; full UAX #14 (ICU) is a later refinement.
* **Acrobat verification** has not happened — Acrobat is not installed here. Verification used PDFium, PDF.js, MuPDF and qpdf.
* A visual glyph order can have two valid logical readings; the reconstruction picks the right-to-left human reading and content-stream order is the planned tie-breaker.

## Brief items that are impossible or inadvisable as stated
1. `rustybuzz` (§5) is archived upstream; HarfRust is the maintained successor (ADR-0004).
2. Office conversions needing LibreOffice cannot exist in the browser extension; desktop sidecar or opt-in server only.
3. "Sandboxed parsing even on desktop" (§4) is planned as a separate render process, not WASM-on-desktop: native PDFium is 4–6× faster on large scans.
4. Perfect round-trip editing of every PDF is impossible (§15.5) — we substitute a bundled font and report it rather than corrupting the file, and the original bytes always survive in the saved file.
