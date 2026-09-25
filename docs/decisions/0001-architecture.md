# ADR 0001 — One Rust engine, one React interface, one native iOS app

* Status: accepted
* Date: 2026-09-25

## Context
ZOOD PDF must run on web (PWA), desktop (macOS/Windows/Linux), a Chrome extension and iPhone/iPad,
Arabic-first, with no accounts and no telemetry.

## Decision
* The engine (`packages/core`, Rust, "warraq") does all document work that PDFium/EmbedPDF does not: object
  layer, encryption, incremental saves, Arabic text extraction/shaping, signing, conversions. It is compiled to
  WebAssembly for web/desktop/extension and to a static library (XCFramework) for iOS.
* The interface (`packages/ui`, React 19) is shared by web, desktop (Tauri 2) and extension (MV3).
* EmbedPDF 2.15.1 (PDFium→WASM) provides the viewer and five tools (Comment, Fill & sign, Form fields, Redact, Protect).
* iOS is native SwiftUI + PDFKit/VisionKit/PencilKit, calling the same engine through a C ABI.
* All UI↔engine traffic is a JSON+blobs RPC (`Document::call`, `call_static`), see `docs/BRIEF.md`.

## Consequences
* One place to fix PDF bugs; one place to fuzz.
* Documents travel between EmbedPDF and the engine as bytes; `doc.rebase` keeps EmbedPDF saves incremental.
