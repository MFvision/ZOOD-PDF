# STATUS — Warraq

*Updated 2026-09-16, end of the first session: Phase 0 complete, Phase 1 skeleton complete, Phase 2 text engine first slice.*

## Completed this session
* **Phase 0** — landscape audit (92 live-verified records, `docs/research/00-landscape.md`), Arabic corpus (42 files: 27 generated with ground truth, 15 real-world with provenance), acid-test harness for PDFium, PDF.js, MuPDF (reference), hayro and our own core, two end-to-end Rust prototypes, GATE 0 decision (`02-decision.md`, ADR-0003/4/5).
* **Phase 1** — `docs/architecture.md`; Rust core workspace `packages/core` (`warraq-text`, `warraq-pdf`, `warraq-render`, `warraq-core` with wasm-bindgen exports, WASM 1.96 MB gzipped incl. the pure-Rust rasterizer); RTL-first React shell `packages/ui` (130 keys ar/en, Cairo/Inter, Lucide icons, logical CSS enforced by stylelint, strict CSP, worker-hosted core) and `apps/web`; MV3 extension (`apps/extension`, zip 2.9 MB, Chrome `--pack-extension` check passes); Tauri 2 desktop (`apps/desktop`, `Warraq.app` + DMG built and launched on this Mac, unsigned); CI workflows (rust, wasm gate, web, corpus gate, desktop matrix, release draft) and `docs/ci.md`.
* **Phase 2 first slice** (`docs/testing/phase-2-text-engine.tdd.md`): bidi with a W5 repair over `unicode-bidi`, HarfRust shaping conformant with HarfBuzz on Amiri, Arabic search normalization with byte-accurate highlights, logical-order reconstruction from positioned glyphs (marks, ligature clusters, bracket pairs, W4/W5/W7/N1 heuristics), ToUnicode-less fallbacks (font cmap reverse lookup, dot recomposition for skeleton+dot fonts such as Noto Naskh Arabic, U+FFFD placeholders), subset-font embedding with multi-character ToUnicode, replace-word and append-line operations. 25 unit tests green, clippy clean.

## Verified end to end
* Web app in the built-in browser: Arabic RTL by default, dark theme, dropping `coretext-sfarabic-mixed-invoice.pdf` renders it through the WASM core with a logical-order selectable text layer, thumbnails, zoom and search.
* Corpus extraction (`tests/acid/results.json`, `docs/research/01-arabic-test-results.md`): on the 25 truth-scored files the Warraq core reads **11 in logical order** (PDF.js 2, MuPDF 2, PDFium 0), 1 partial, 1 empty, 9 with placeholders (files without usable ToUnicode and the Skia/Noto Type3 files, see below).

## Next (in order)
1. **PDFium WASM shim** (pdfium-render ↔ Emscripten module) so the browser rasterizes with PDFium like the desktop; keep hayro as fallback. Then native PDFium render commands in Tauri (`warraq-render` feature `pdfium`, already tested natively).
2. **Phase 2 continuation:** glyph-shape matching against bundled fonts and OCR-of-line fallback for glyphs without ToUnicode (Skia writes U+0000 for contextual forms; Type3 Noto skeleton forms), paragraph/alignment detection and reflow, edit operation log with incremental save, standard security handler (AES-256; `lopdf` 0.45 cannot open R6 files), fuzzing with the corpus as seeds, golden renders in CI, GATE 2 demo.
3. Corpus gate in CI on our own engine (thresholds per file class), PDF.js image rendering re-check in a browser.

## Decisions needed from the owner
*Owner replied "yes" on 2026-09-16 (ADR-0006): name Warraq, Apache-2.0 and native PDFium confirmed; browser builds default to pure Rust; Persian/Urdu first-class.*
1. **GitHub organization** — nothing pushed; `gh repo create <org>/warraq --private --source . --push`.
2. **Permanent folder** — the repo is in the app's session scratch workspace; pick a folder and I will move it.
6. **Xcode license** — during this session `/usr/bin/cc` and `/usr/bin/python3` started refusing to run until `sudo xcodebuild -license accept` is executed (needs your password). The build now links through Xcode's clang directly (`packages/core/.cargo/config.toml`, `tools/env.sh`), but Tauri/pdfium-render builds and Python tooling will need the license accepted.

## Brief items that are impossible, contradictory or inadvisable as stated
1. `rustybuzz` (brief §5) is archived upstream; HarfRust is the maintained successor and is what we use (ADR-0004).
2. Office conversions that need LibreOffice (§6, §11) cannot exist in the browser extension; they will be desktop-sidecar or opt-in server only, marked in `docs/feature-matrix.md`.
3. "Sandboxed parsing even on desktop" (§4) is planned as a separate render process, not WASM-on-desktop, because native PDFium is 4–6× faster on large scans.
4. Acrobat Reader is not installed here; verification used PDFium (Chrome), PDF.js (Firefox) and MuPDF. GATE 2 needs a machine with Acrobat.
5. The 500 MB scan stress test (N8) is generated on demand (`gen_scans.py --large`) and has not been run.
6. A visual glyph order can have two logical readings (`items 3` / `3 items`; CoreText's bracket-pair rule vs producers without it); the reconstruction picks the right-to-left human reading and Phase 2 adds content-stream order as a tie-breaker (ADR-0005 addendum).

## Risks
PDFium WASM integration (unproven here), HarfRust conformance gaps, lopdf robustness and encryption, Skia/Noto Type3 output (the Google Docs default Arabic font) needing shape recognition, license drift (re-verify quarterly).

## Collected non-blocking questions
* Should the extension default to the pure-Rust rasterizer to avoid the 2.4 MB PDFium download, accepting lower fidelity on forms until hayro catches up?
* Are Persian/Urdu first-class targets for v1 (affects the yeh/kaf normalization default)?
