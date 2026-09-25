# ZOOD PDF · زود PDF

An open, account-free, Arabic-first PDF editor. One Rust engine ("warraq"), one React interface for the web
(installable PWA), desktop (Tauri) and a Chrome extension, and a native SwiftUI app for iPhone and iPad.

* No accounts, no telemetry. Nothing leaves your device unless you press a cloud or AI button.
* Arabic first: right-to-left interface, Arabic text that extracts, searches, copies and writes back correctly.
* Your original bytes stay untouched until you save; saves are incremental.

See [`docs/STATUS.md`](docs/STATUS.md) for what works today and [`docs/feature-matrix.md`](docs/feature-matrix.md)
for tool × platform coverage. Contributors: read [`docs/BRIEF.md`](docs/BRIEF.md).

```bash
# Node 22+, pnpm 10, Rust stable, wasm-pack
pnpm install
bash scripts/build-wasm.sh
pnpm -C apps/web dev
bash scripts/verify.sh   # the full gate: GREEN or RED
```

Licensed under Apache-2.0. Third-party components: [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
