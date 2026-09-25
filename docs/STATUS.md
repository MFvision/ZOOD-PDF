# Status

Honest, current state. Updated by every change. "Proven" means covered by an automated test that runs in `scripts/verify.sh`.

## Summary
Scaffolding in progress.

## Desktop host (Tauri 2), CI and packaging

**Built and tested on Linux (this machine):**
* `apps/desktop/src-tauri` compiles; `cargo test` (run by `verify.sh` "desktop tests"): unit tests for drop-position
  scaling (÷ scale factor on Windows only), menu-model parsing/validation with bounds, file-name sanitisation
  (path stripping, bidi-override removal, Windows reserved names, byte bound), locale → window title, host flags;
  config guards (`custom-protocol` declared + default and compiled in, productName/identifier/title, exact CSP,
  NSIS-only with Arabic, minimal capabilities, Info.plist names); licence gate over every crate linked into the
  binary. `cargo clippy -D warnings` is clean for Linux, **and type-checks for `aarch64-apple-darwin` (PDFKit
  print, native menu) and `x86_64-pc-windows-msvc`** — compile-checked only, not run.
* `scripts/desktop-smoke.sh` (CI step; not in `verify.sh`): builds the debug binary and runs it under Xvfb/WebKitGTK.
  Probe run: a fixture page inside the real window proves the ACL and CSP — `fs` outside the dialog/drop scope,
  `read_dir`, `remove`, shell, window close, `eval`, `new Function` and remote `fetch` are denied; the app's own
  commands work. (Negative control: with the CSP removed the probe reports `PROBE_FAIL`.) UI run: the real shared
  interface must start and call `app_ready`.
* `packages/ui/src/services/host-tauri.ts` + tests (vitest, jsdom): dialogs, read/write via plugin-fs, save
  fallback, drop re-emission, macOS PDFKit vs image printing, chrome CSS vars, menu routing.
* `apps/desktop/vite-plugin-desktop.ts`: strips the `<meta>` CSP and fails the build if one survives (vitest).
* `scripts/package-web.sh` → `out/zood-pdf-web.zip` (app + `serve.mjs` + `Start on Windows.cmd` + `start.sh`);
  `serve.mjs` has `node --test` coverage (127.0.0.1 only, `application/wasm`, CSP, traversal/NUL/symlink refusal,
  SPA fallback, GET/HEAD only). `scripts/package-extension.sh` → `out/zood-pdf-extension.zip`.
* Workflows pass `actionlint` + `shellcheck`; all scripts pass `shellcheck`.

**Needs macOS / Windows hardware or CI (not run here):**
* `scripts/install-macos.sh` (builds `--bundles app`, installs `/Applications/ZOOD PDF.app`, verifies
  `CFBundleName`/`CFBundleDisplayName`/identifier) — cannot run on Linux. `.github/workflows/macos.yml` builds and
  verifies the unsigned `.app` (workflow_dispatch).
* PDFKit printing, the native macOS menu bar, the overlay title bar with traffic lights, WKWebView behaviour of
  dialogs/writes — need a person at a Mac.
* Windows NSIS installer with the Arabic language page: `.github/workflows/windows-installer.yml`
  (workflow_dispatch / `v*` tags). Drop-position scaling on a HiDPI Windows display is unit-tested only.
* Windows/Linux printing uses page images from the UI's renderer (`setPageRasterizer`); the print dialog itself is
  a native dialog and is not automated.

**Known limits:**
* No AppImage: it would bundle LGPL WebKitGTK/GTK (ADR 0002). Linux ships a `.deb` depending on system packages.
* The app is unsigned (no Apple team / Windows certificate): Gatekeeper and SmartScreen warn on first launch.
* Files opened in an earlier session leave the fs scope; saving them asks for a location again.
* The macOS Dock name is "ZOOD PDF" (no `ar.lproj` localisation of the bundle name yet); the window title switches
  to "زود PDF" with the UI locale.
