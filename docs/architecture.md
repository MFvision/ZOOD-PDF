# Architecture

```mermaid
flowchart LR
  subgraph hosts[Hosts: thin shells]
    D[apps/desktop · Tauri 2<br/>Windows / macOS / later iOS]
    X[apps/extension · MV3<br/>Chrome / Edge / Brave]
    W[apps/web · Vite static<br/>tool pages, PWA]
  end
  subgraph ui[packages/ui · one React app, RTL-first]
    Shell[Acrobat-familiar shell:<br/>menu · ribbon · panes · canvas · status]
    Worker[core worker adapter]
  end
  subgraph core[packages/core · one Rust workspace]
    Core[warraq-core · façade + wasm-bindgen]
    Text[warraq-text<br/>bidi · shaping · fallback · normalization · extraction]
    Pdf[warraq-pdf<br/>object model · fonts · ToUnicode · edit ops · save]
    Render[warraq-render<br/>Renderer trait: PDFium backend · hayro backend]
  end
  D --> Shell; X --> Shell; W --> Shell
  Shell --> Worker --> Core
  Core --> Text; Core --> Pdf; Core --> Render
  Render -. native dylib / WASM module .-> PDFium[(PDFium)]
  Pdf --> lopdf & pdf-writer & subsetter
  Text --> harfrust & unicode-bidi & skrifa
```

## Principles (from the brief, made concrete)
* **One core, two builds.** `packages/core` compiles to a native library (linked into Tauri; later iOS via FFI) and to `wasm32-unknown-unknown` (extension, web). CI builds both on every commit; a feature that compiles for only one target fails the build (`cargo check --target wasm32-unknown-unknown` is a required job).
* **One UI.** `packages/ui` is the whole product surface. A host provides only: file open/save, window/OS integration, storage for settings and cloud tokens, and the way the core module is loaded (worker in the browser, offscreen document in the extension, worker in Tauri's webview plus native commands for heavy jobs).
* **RTL-first CSS.** Logical properties only (`margin-inline-start`, `inset-inline-end`, `text-align: start`); `dir` on `<html>` follows the UI language; icons that imply direction (back, next, indent) are mirrored with `[dir=rtl]` rules; stylelint rule `csstools/use-logical` enforces it.
* **Hostile input.** Parsing and rendering run outside the UI thread and, on desktop, in a separate process (`warraq-renderd`, Phase 2). The WASM build is sandboxed by the browser. No `eval`, strict CSP (`script-src 'self' 'wasm-unsafe-eval'`), no network calls without a user action (verified by an egress test in CI).
* **Original never lost.** The opened bytes are kept immutable; edits are an operation log applied on save (incremental update when possible, full rewrite when the file is broken or encrypted with a changed key).

## Crates
| Crate | Responsibility | Key dependencies |
|---|---|---|
| `warraq-text` | Unicode bidi (UAX #9), OpenType shaping, script/direction itemization, font fallback chain (bundled OFL fonts + user fonts), Arabic-aware normalization and search, logical-order reconstruction from positioned glyphs | harfrust, skrifa, unicode-bidi, unicode-normalization, unicode-script |
| `warraq-pdf` | Document model over `lopdf` (read/modify/incremental save), font embedding and subsetting with ToUnicode, text object writing/editing, page operations, encryption (later), signatures (later) | lopdf, pdf-writer, subsetter |
| `warraq-render` | `Renderer` trait with `Pdfium` (native + WASM shim) and `Hayro` (pure Rust) backends; page bitmaps; glyph device for extraction | pdfium-render (feature), hayro, hayro-interpret |
| `warraq-core` | Façade used by hosts; `wasm-bindgen` exports mirroring `API.md`; error codes | all of the above |

## Rendering backends per target (Phase 1 state)
| Target | Rasterizer | Status |
|---|---|---|
| Desktop (Tauri, native core) | PDFium via pdfium-render (dynamic library from pdfium-binaries) | built in Phase 0 prototype; wired in Phase 1 |
| Web / extension (WASM core) | hayro (pure Rust) in the skeleton; PDFium WASM shim is the next task | hayro compiles to wasm32 today; PDFium WASM integration is risk #2 in `02-decision.md` |

The `Renderer` trait keeps both backends behind one API so the swap is a build flag, not a code change in the UI.

## Data flow: open → render → edit → save
1. Host reads bytes → `Document::open(bytes)` in the worker.
2. UI asks `render_page(i, scale)` per visible page (tiles later) and draws RGBA into a canvas; thumbnails at scale 0.2.
3. `text_lines(i)` gives the selection overlay in logical order with per-line geometry.
4. An edit (Phase 2) creates an operation (`ReplaceText{page, run, old, new}`) → `warraq-pdf` re-shapes the affected paragraph with `warraq-text`, rewrites the content stream and font subsets → the page is re-rendered.
5. Save = incremental update appended to the original bytes (or full rewrite), then re-opened through the reader to verify round trip.

## Repository layout
See the README; `prototypes/` (Phase 0) is a separate cargo workspace and is not part of the product build.
