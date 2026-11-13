# ZOOD PDF (محرر زود PDF)

An open, account-free, Arabic-first PDF editor, made by ZOOD (zood.sa). The same Rust
engine and the same interface run on every platform.

**Warraq** (ورّاق) is only the code name. It is still what the packages and paths are called
(`@warraq/ui`, `warraq-core`), so it appears below; the product's name is ZOOD PDF.

## Three promises

- **Arabic first.** Arabic and other joined scripts are drawn, searched and edited correctly, and
  the interface is right-to-left first. CI fails when an Arabic test file stops opening or its text
  comes out worse (`docs/decisions/ADR-0002-arabic-corpus-and-red-test-policy.md`, the `corpus` job
  in `docs/ci.md`).
- **Private and local.** No account and no telemetry. Files are opened and changed on the device.
  Nothing leaves it unless the person chooses an action that needs the network: a cloud drive, an
  AI service, a download. The desktop app also asks GitHub when it opens whether a newer version
  exists; a switch in Settings turns that off (`docs/updates.md`).
- **The original is never lost.** The opened bytes are kept as they are. Edits are written on save,
  as an addition to the original file where the file allows it (`docs/architecture.md`).

## Platforms

| Platform | Code | What it is |
| --- | --- | --- |
| Windows and macOS | `apps/desktop` | A Tauri 2 window around the shared interface, with the engine built natively |
| Web | `apps/web` | The shared interface with the engine as WebAssembly |
| Chrome extension | `apps/extension` | The same, as a Manifest V3 extension |
| iPhone and iPad | `apps/ios` | A SwiftUI app; the engine is linked as an XCFramework |
| Android | `apps/android` | The web build inside a small native app |
| Website | `website/` | The public site, https://pdf.zoodrealty.com: plain HTML, CSS and JavaScript |

The engine is `packages/core` (Rust). The shared interface is `packages/ui` (React).

## Getting the app

- **Windows and Mac**: the installers are on the
  [releases page](https://github.com/MFvision/ZOOD-PDF/releases); the one marked "Latest" is the
  current version. An installed copy updates itself from the stable channel (`docs/updates.md`).
  The Mac build is for Apple silicon only.
- **iPhone, iPad and Android**: through the store links on the website.

## Build and run

You need Node 22 or newer, pnpm (the version is pinned in `package.json`), Rust stable with the
`wasm32-unknown-unknown` target (`rust-toolchain.toml`), and `wasm-pack`.

```sh
pnpm install
pnpm build:core                      # the engine as WebAssembly, into packages/ui/src/core-wasm/
pnpm dev:web                         # the web app, on a local dev server
pnpm --filter @warraq/desktop dev    # the desktop app
```

- On a Mac, `./scripts/install-macos.sh` builds the desktop app and installs it into `/Applications`.
- `./scripts/verify.sh --no-e2e` runs the checks CI runs, except the browser tests. It is a zsh script.
- iPhone and iPad: see `apps/ios/README.md`. Android is built on GitHub only: see
  `apps/android/README.md`.

## Status and documents

- Where things stand now: `docs/HANDOVER.md`. The dated log: `docs/STATUS.md`. Feature by
  feature: `docs/feature-matrix.md`.
- How it is built: `docs/architecture.md`, the decisions in `docs/decisions/`, the engine's API in
  `packages/core/API.md`, the design reference in `docs/design/README.md`.
- CI, releases and updates: `docs/ci.md`, `docs/updates.md`, `docs/store.md`.
- Cloud drives: `docs/cloud.md`. On-device AI: `docs/local-ai.md`.

## Licence

Apache-2.0 (`LICENSE`). Third-party code and fonts are listed in `THIRD-PARTY-NOTICES.md`. ZOOD's
logo, mark and patterns are ZOOD's own and are not under this licence.
