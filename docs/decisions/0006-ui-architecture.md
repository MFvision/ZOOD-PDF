# ADR 0006 — Interface architecture (`@zood/ui`)

* Status: accepted
* Date: 2026-09-25

## Context
One React interface serves the PWA, the Tauri desktop app and the Chrome extension. It must be Arabic-first,
account-free, make no network requests of its own, keep the original bytes untouched until the user saves,
and hand documents between EmbedPDF (PDFium) and the Rust engine without either one saving stale state.

## Decision

**Layers.** `src/app` (views: home, document, sheets), `src/services` (state and side effects), `src/viewer`
(EmbedPDF integration), `src/i18n`, `src/tools/registry.ts`. Views never touch IndexedDB, the file system, the
engine or wasm directly; they call `useApp()`.

**State.** A single reducer (`services/state.ts`) holds open documents as `Uint8Array` bytes plus their
`originalBytes`, the route, recents and HUD toasts. When a core tool replaces a document's bytes
(`CORE_REPLACED_BYTES`) the reducer sets `warraqOwnsDocument`, bumps `revision` and flips `switching` in the same
dispatch; the viewer is keyed by revision so it always remounts on the new bytes. A late "ready" from an old
viewer cannot clear the switch (revision check). Open documents stay mounted (hidden) while the user is on Home,
so PDFium keeps unsaved edits.

**Engine.** `services/engine.ts` is a typed RPC client (`open`, `call(docId, method, params, blobs)`,
`callStatic`, `close`) for `warraq-core` running in a module Worker (`engine.worker.ts`). Blobs are transferred,
requests carry ids, errors are `EngineError { code, message }`, a crashed worker fails all pending calls and
restarts lazily. The worker imports `virtual:warraq-core`, which the `zoodEngine` Vite plugin resolves to
`src/wasm/pkg/warraq_core.js`; **a missing package fails the build**. `ZOOD_ALLOW_MISSING_ENGINE=1` exists only
for UI development before the engine lands and produces an engine whose calls reject with `engine_missing`.

**Saving.** `services/save.ts#rebaseOnOriginal` is the single call site of `doc.rebase`: open the original bytes
in the engine, pass PDFium's `saveAsCopy` output as a blob, write the engine's reply. The result is the original
file plus an incremental update. Only `engine_missing` (dev builds) falls back to PDFium's whole rewrite.

**Hosts.** `services/host.ts` defines `HostBridge` (`openFiles`, `saveFile`, `onHostDrop`); `files.ts` is the web
implementation (`<input type=file>`, File System Access save picker, `<a download>` fallback with a delayed
revoke, drop capture that snapshots the `FileList` synchronously). A native host installs its own bridge as
`window.__ZOOD_HOST__` before boot; `getHost()` picks it at runtime.

**EmbedPDF.** Exactly 2.15.1 (`@embedpdf/react-pdf-viewer`, `@embedpdf/snippet`). Documents load from bytes
(a private copy of the buffer, which EmbedPDF may transfer). `pdfium.wasm`, Noto Naskh Arabic (fallback font)
and the stamp library are bundled as local assets through `@zood-assets/*` aliases; the UI webfont and the
signature webfonts are switched off. Theme colours are passed as `var(--token)` references, which inherit
through EmbedPDF's shadow root, so light/dark follow our tokens. Its main toolbar is closed and its
Open/Close/Export/Fullscreen/Capture categories disabled: our toolbar owns navigation, zoom and files, and our
tool picker executes its mode commands (`mode:annotate`, `mode:insert`, `mode:form`, `mode:redact`,
`document:protect`). Its page canvas stays LTR inside the RTL interface (it lays pages out with physical
coordinates) while its tool strips are mirrored with a style injected into its shadow root. An `ar` locale
covering every key of its English locale is registered at runtime; literals it does not route through i18n are
rewritten at build time by `zoodEmbedPdfPatches` from `src/viewer/embedpdf-patches.json` into
`window.__zoodEP(...)` lookups. Tests fail when a patch target or locale key disappears in an upgrade. MV3
extension pages cannot start `blob:` workers, so the extension runs PDFium on the page thread.

**Tools.** `tools/registry.ts` lists the 20 tools with `status: 'ready' | 'hidden'`. Only ready tools appear
(sidebar, More sheet, tool gallery, ⌘K, action cards); the six home cards fill free slots with ready tools
instead of showing unimplemented ones. The AI card appears only when the AI tool is ready and a handler is
registered (`setAiHandler`).

**Design.** CSS custom properties for macOS-style semantic colours with light/dark sets, glass panels with
`backdrop-filter` over a CSS-only gradient, radii 6–24 px, one blue accent, springs only on press feedback,
`prefers-reduced-motion`, `prefers-contrast` and `prefers-reduced-transparency` honoured, logical properties only
(stylelint), sidebar → drawer below 760 px.

## Consequences
* Upgrading EmbedPDF is a deliberate act: the patch and locale tests point at every string to revisit.
* The desktop agent implements `HostBridge` once; nothing else in the UI changes for Tauri.
* Engine methods are strings; the engine agent owns their names and the UI adapts in `save.ts`/`engine.worker.ts`.
