# STATUS — Warraq

*Updated 2026-09-17: Phase 0 and Phase 1 complete, Phase 2 complete through GATE 2.*

## Where the product stands

| Capability | State |
|---|---|
| Open, render, thumbnails, zoom, search | works on desktop (native PDFium), web and extension (pure Rust) |
| Arabic text **reading** in logical order | 16 of the truth-scored corpus files, against 2 for PDF.js, 2 for MuPDF, 0 for PDFium |
| Arabic text **editing** with reflow | works end to end: click a paragraph in the app, edit it, undo/redo, save. GATE 2 passed (`docs/gate-2.md`) |
| Encrypted files | read everywhere: R2–R6, RC4 40/128, AES-128, AES-256 |
| Saving | incremental update; the opened bytes stay as the literal prefix |
| Hostile input | mutation harness on every pull request; cargo-fuzz targets ready for nightly |
| Visual regressions | golden renders of all 48 corpus pages gated in CI |
| No-mapping files | characters recovered from glyph shapes, at 100 % precision on held-out fonts |
| Installed on this Mac | `/Applications/Warraq.app`, built from this tree — `scripts/install-macos.sh`, documented in `docs/install-macos.md`. Opens a PDF, renders every page, both thumbnails and full size |

Every one of the 48 corpus files opens. 63 tests green, clippy clean, `wasm32-unknown-unknown` compiles, core WASM 2.50 MB gzipped (budget 8 MB).

## Completed this session
* **Phase 0** — landscape audit (92 live-verified records), Arabic corpus (48 files: 33 generated with ground truth, 15 real-world with provenance), acid harness across five engines plus our own, two prototypes, GATE 0 (`docs/research/02-decision.md`, ADR-0003/4/5).
* **Phase 1** — architecture; Rust core (`warraq-text`, `warraq-pdf`, `warraq-render`, `warraq-core`) native and WASM; RTL-first React shell and web app; MV3 extension; Tauri desktop with native PDFium bundled; CI (rust, wasm gate, web, corpus gate, robustness, desktop matrix, release draft).
* **Phase 2** — bidi with a W5 repair, HarfRust shaping conformant with HarfBuzz, Arabic search normalization, logical-order reconstruction with cmap/GSUB/dot-recomposition fallbacks, paragraph detection and reflow, content-stream text location, erase and replace, subset font embedding with correct ToUnicode, incremental save, the standard security handler, and the robustness harness.
* **ADR-0006** recorded your answers: name, license and native PDFium confirmed; browser builds default to the pure-Rust rasterizer; Persian and Urdu first-class (corpus and fonts added).

## What the interface actually offers, counted

Stated because it was not, and a person met thirteen tool cards that looked
alike when only one of them did anything.

| | |
| --- | --- |
| Tools in the pane | 13 |
| Tools that do something | **1** — Edit. Every other card now says *Later* on its face, and opens a panel that says which phase it belongs to |
| What Edit does | replace the text of a paragraph, reflowed and reshaped; add a line of new text where you click; choose the face (Amiri, Cairo, Inter) and the size an edit is drawn with; undo and redo a replacement |
| What Edit does not do | add an image, restyle text already on the page without retyping it, move or delete anything, and it cannot undo an *added* line |

The engine underneath is not a mock-up — the Arabic reading, reflow, font
subsetting, incremental save and encryption are real and measured — but the
shell around it advertised far more than it delivered, and that is a product
defect regardless of what the engine can do.

## Next (in order)
1. **Paragraph breaks**: consecutive body paragraphs with uniform spacing still merge into one. Needs indentation and spacing analysis, not just line proximity.
2. **OCR** for scanned pages (Tesseract: `tesseract.js` in the browser, native on desktop), which also gives the last extraction fallback and makes the two scanned corpus files searchable.
3. **PDFium WASM shim** so the web build can optionally use PDFium for form and annotation fidelity.
4. **Nastaliq Urdu**, which does not decompose into per-letter shapes. (Rotated runs — sidebars that read backwards — were fixed on 2026-09-18.)
5. Thumbnails do not re-render after an edit (the page canvas does); writing encryption; the 500 MB scan stress run; Acrobat verification on a machine that has it.

## Decisions needed from you
1. **GitHub organization** — nothing has been pushed: `gh repo create <org>/warraq --private --source . --push`.
2. **Permanent folder** — the repository still lives in this session's scratch workspace and will be removed with the session. Name a folder and I will move it.
3. **Xcode license** — `/usr/bin/cc` and the system `python3` refuse to run until `sudo xcodebuild -license accept` (needs your password). Builds work because they are pointed at Xcode's clang directly.

## Fixed after the first install, 2026-09-17

The desktop app shipped unable to do anything at all, and the four causes are
worth keeping written down because each one failed **silently**.

1. **The crate never declared Tauri's `custom-protocol` feature**, so every
   build — including the bundled one — was a development build. It pointed the
   window at `build.devUrl`, a dev server that does not run on a user's
   machine, and the window came up empty. Pinned by
   `tests/desktop_contract.rs`.
2. **The open command clicked a hidden `<input type="file">`**, which WKWebView
   ignores unless the host implements the panel. It now calls the native one.
3. **Drag-and-drop listened for the DOM `drop` event.** Tauri catches the OS
   drop before the webview sees it and re-emits it; the host had always done
   so and nothing was listening.
4. **Save clicked a download link**, which a webview also ignores — it reported
   a save that never wrote a file. It now opens the native save panel.

A fifth would have surfaced next: the document carried its own
Content-Security-Policy, which a browser enforces *alongside* the one Tauri
serves, and the intersection would have cut the interface off from its own
host. The desktop bundle now leaves that policy to `tauri.conf.json`
(`apps/web/src/csp.test.ts`).

## Known gaps, stated plainly
* **Dragging a file over the desktop window gives no highlight.** The host catches the OS drag before the webview sees it, and only the drop is forwarded, not the hover. The drop itself works; the invitation to drop does not appear.
* **Finder does not offer Warraq for a PDF.** The bundle claims no document types on purpose — an editor should not take over the system PDF handler unasked. Open from inside the app, or pass the path on the command line.
* **The macOS build is ad hoc signed, not notarised.** It runs on the machine that built it. Copied to any other Mac it will be refused until that user clears the quarantine flag by hand, because notarising needs a paid Apple Developer account. Nothing in the build is broken by this; it is a distribution decision, not a defect.
* **Nobody has looked at the installed window.** The Claude desktop app has no Screen Recording permission on this Mac, so no screenshot is possible. What is verified, from the host's own log, is the whole chain behind the glass: the interface boots, asks the host which engine it got, claims the file named on the command line, reads it through the file scope, opens it in the core and renders every page at both thumbnail and full scale. What that does not prove is what the pixels look like, or that the open and save panels behave once a person clicks them.
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
