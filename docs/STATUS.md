# STATUS — Warraq

*Updated 2026-09-16 (end of Phase 0, start of Phase 1).*

## Completed
* Repository skeleton (local git, branch `main`), Apache-2.0 LICENSE, ADRs 0001–0005.
* **Arabic corpus**: 41 PDFs (26 generated with ground truth, 15 real-world with provenance), manifest, generators, README (`tests/corpus/arabic/`).
* **Acid-test harness** (`tests/acid/`): PDFium (Python and Rust), PDF.js, MuPDF (reference), hayro; word-level logical-order scoring; screenshots and contact sheets for every file and engine.
* **Research documents**: `docs/research/00-landscape.md` (92 live-verified records), `01-arabic-test-results.md`, `02-decision.md` (GATE 0).
* **Prototypes** (`prototypes/`): hayro render + glyph extraction, pdfium-render render/extract/edit, and the Rust text stack (harfrust + unicode-bidi + skrifa + subsetter + pdf-writer + lopdf) that writes a correct Arabic PDF and replaces a word in an existing PDF.
* Toolchain on this machine: Rust stable 1.98 + wasm32 target (installed with rustup into `~/.cargo`, PATH not modified), wasm-pack, Python research libs (user site), Node research tools (`tools/node`, outside the repo).

## GATE 0 recommendation (proceeding with it)
PDFium for rasterization/forms/annotations on all targets; our own Rust text and object layer (HarfRust, unicode-bidi, fontations, subsetter, pdf-writer, lopdf); hayro-interpret for content reading and hayro as optional rasterizer; own logical-order text reconstruction. Details: ADR-0003/0004/0005.

## Next
1. Phase 1: `docs/architecture.md`, cargo workspace `packages/core` (`warraq-text`, `warraq-pdf`, `warraq-render`, `warraq-core` with WASM bindings), `packages/ui` (React, RTL-first), hosts (`apps/web` Vite, `apps/extension` MV3, `apps/desktop` Tauri 2), CI building all targets and running the corpus.
2. Phase 2: text engine — extraction reconstruction, shaping/bidi/fallback/subsetting/ToUnicode writer, reflow, Arabic search; golden renders, round-trip tests, fuzzing.

## Blockers / decisions needed from the owner
1. **Product name** — working name *Warraq*; confirm or replace (ADR-0001).
2. **GitHub organization** — no push has been made; run `gh repo create <org>/warraq --private --source . --push` (or give me the org and I will).
3. **License** — Apache-2.0 assumed; confirm before first public release.
4. **Permanent folder** — the repo lives in the app's session scratch workspace; choose a folder and I will move it (`git clone`/`mv`).
5. **C++ in the core** — PDFium (BSD-3) as rasterizer is the recommendation; say so if you want the pure-Rust option instead (slower to reach parity: no encryption/forms in hayro yet).

## Risks
See `docs/research/02-decision.md` §Risks. Highest: PDFium WASM ↔ Rust WASM integration (Phase 1 proves it first), HarfRust conformance, lopdf robustness.

## Brief items that are impossible, contradictory or inadvisable as stated
1. **"rustybuzz"** (brief §5) is archived upstream; HarfRust is the maintained successor and is what we use.
2. **"No feature may exist in only one build"** (§4) versus Office conversions that need LibreOffice (§6, §11): conversions requiring LibreOffice will exist only where a local LibreOffice or the opt-in server is available. The brief already allows this; the feature matrix will mark it.
3. **"Sandboxed parsing even on desktop"** (§4): planned as a separate render process (`warraq-renderd`) rather than WASM-on-desktop, because native PDFium is 4–6× faster than the WASM build on large scans.
4. **"Verify output in Acrobat Reader"** (§5 GATE 2): Acrobat is not installed on this machine; verification uses PDFium (Chrome's engine), PDF.js (Firefox) and MuPDF. Acrobat verification needs a machine with Acrobat Reader.
5. **500 MB scanned file (N8)**: the generator exists (`gen_scans.py --large`) but the stress run has not been done yet.
6. **PDF.js image rendering** could not be verified in the Node harness (blank scans); to be re-checked in a browser — not blocking since PDF.js is not the chosen renderer.

## Collected non-blocking questions
* Should the Rust core's pure-Rust rasterizer (hayro) be the default in the *browser extension* to avoid the 2.4 MB PDFium download, at the cost of encrypted/form fidelity until hayro catches up?
* Are Persian/Urdu (Eastern digits, Nastaliq fonts) first-class targets for v1, or Arabic only?
