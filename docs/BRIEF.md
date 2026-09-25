# ZOOD PDF — shared brief for every contributor and agent

Read this whole file before touching code. The owner's original specification is
reproduced in [`docs/SPEC.md`](SPEC.md) and wins over anything here if they ever disagree.

## Repository map

| Path | What |
| --- | --- |
| `packages/core` | Rust workspace (the engine, "warraq"). Crates: `warraq-pdf`, `warraq-text`, `warraq-render`, `warraq-sign`, `warraq-core`. |
| `packages/core/fuzz` | cargo-fuzz targets for every parser (lexer, xref, encryption, fonts, images). |
| `packages/ui` | `@zood/ui`: React 19 + Vite 8 + vitest. The whole interface, shared by web, desktop and extension. |
| `packages/ui/src/wasm/pkg` | wasm-pack output of `warraq-core` (generated, git-ignored). Built by `scripts/build-wasm.sh`. |
| `apps/web` | PWA host (manifest + service worker that caches the shell only). |
| `apps/desktop` | Tauri 2 host (`src-tauri`). |
| `apps/extension` | Chrome MV3 extension host. |
| `apps/ios` | Native SwiftUI app (XcodeGen). Needs macOS + Xcode; cannot be built on Linux CI. |
| `tests/corpus` | Generated Arabic corpus + truth text (`scripts/corpus/`). |
| `tests/acid` | The Arabic acid gate: extraction must match truth; any regression fails `verify.sh`. |
| `tests/e2e` | Playwright specs (Chrome, production build). |
| `docs/STATUS.md` | Honest status. `docs/feature-matrix.md`: tool × platform. `docs/decisions/`: ADRs. |

## Engine RPC contract (do not break)

All UI ↔ engine traffic is JSON + binary blobs:

```rust
// warraq-core
pub struct Document { … }
impl Document {
    pub fn open(bytes: Vec<u8>, password: Option<&str>) -> Result<Document, CoreError>;
    pub fn call(&mut self, method: &str, params: &serde_json::Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError>;
}
pub fn call_static(method: &str, params: &serde_json::Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError>;
pub struct Reply { pub json: serde_json::Value, pub blobs: Vec<Vec<u8>> }
```

* Method names are `namespace.verb` (`doc.info`, `doc.save`, `text.extract`, `pages.rotate`, `redact.apply`, …).
* Errors are `{ "code": "…", "message": "…" }`; never panic, never `unwrap` on input-derived data.
* `wasm.rs` exposes `WarraqDocument` with the same shape (`call(method, paramsJson, blobs: Uint8Array[]) → { json, blobs }`)
  and `callStatic`. `ffi.rs` exposes the same through a C ABI for iOS.
* The UI never calls wasm directly: it goes through `packages/ui/src/services/engine.ts`, which runs the engine in a Worker.

## Document ownership in the UI

`AppContext` holds the open documents as bytes. EmbedPDF (PDFium) displays and edits with its 5 tools; the core owns
everything else. When a core tool changes a document, the UI sets `warraqOwnsDocument`, the reducer flips `switching`
synchronously, and the viewer reloads from the new bytes. When EmbedPDF saves, the bytes go through
`doc.rebase` so only objects PDFium changed are appended as an incremental update (original bytes and signatures kept).

## Rules that apply to every change

1. **TDD.** Failing test first (Rust unit test, vitest, or Playwright). Every user-visible feature has a Playwright test that
   clicks through the real interface, saves, reopens and inspects the bytes.
2. **Hostile input.** No `eval`/`new Function`; bounded loops and allocations (`warraq_pdf::limits`); no panics (clippy denies
   `unwrap`/`expect`/`panic`); fuzz target for every new parser.
3. **No network** unless the user clicks a cloud/AI action. No telemetry.
4. **Original bytes untouched until save**; saves are incremental updates. Only redaction, password changes and files > 150 MB
   do a whole rewrite.
5. **Licences**: MIT/Apache-2.0/BSD/ISC/OFL/CC0/Zlib/Unicode only. Add every new dependency to `THIRD-PARTY-NOTICES.md`.
6. **Arabic first**: every string goes in `packages/ui/src/i18n/en.json` *and* `ar.json` (natural MSA). Layout uses logical CSS
   properties only (stylelint enforces). Numerals follow the locale.
7. **No façades.** If a control is visible it works end to end. If something is impossible, write why in `docs/STATUS.md`.
8. **Name**: "ZOOD PDF" / "زود PDF" everywhere. Never Adobe/Apple names, icons or artwork.

## Working in parallel (agents)

* Work in your own git worktree/branch. Before your final verify: `git merge main` (or the lead branch) and re-run.
* Your Playwright port is given in your task (`E2E_PORT`). Never use another agent's port. Never `pkill` by pattern;
  kill only PIDs you started.
* Heavy runs (full `verify.sh`, release builds, e2e) go through the machine-wide queue: `scripts/queue.sh <command…>`.
* Build the WASM in a private target dir (`scripts/build-wasm.sh` uses `.target-wasm/` inside your tree). Always rebuild the
  WASM before e2e.
* Chrome keeps writing its profile after kill: wait for the process to exit before removing the profile dir.

## Commands

```bash
pnpm install
bash scripts/build-wasm.sh          # engine → packages/ui/src/wasm/pkg
pnpm -C packages/ui test            # vitest
(cd packages/core && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings)
bash scripts/verify.sh              # everything, prints GREEN or RED
```
