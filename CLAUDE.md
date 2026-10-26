# ZOOD PDF (محرر زود PDF) — project instructions

An open, account-free, Arabic-first PDF editor (code name **Warraq**) for the owner's company
**ZOOD** (zood.sa). The App Store name is «محرر زود PDF»; the app's own name is ZOOD PDF in English and
«محرر زود PDF» in Arabic on every platform, and the Zood look is the default from the first
launch (owner, 2026-10-20).
Platforms: Windows and macOS (Tauri), web, Chrome extension, iPhone and iPad (SwiftUI).

**Read `docs/HANDOVER.md` first** — where things stand now and what is next. The full,
truthful status is `docs/STATUS.md` and `docs/feature-matrix.md`; open items from the owner's
own testing are in `docs/backlog/`; the PdfCraft study (what to bring over, the Workbench
theme spec) is in `docs/research/`.

## The owner
Not an engineer. Speaks by voice, so messages arrive loosely worded: read for intent. Wants
plain-language answers, honest status (what is done, what is NOT, what was not tested), and a
download link or a build he can try at the end of each job. Arabic first in everything.

## Cost rules (the owner is on a Max plan; extra usage is off)
- **One agent at a time.** Never fan out several agents or workflows in parallel: five at
  once exhausted the weekly allowance and cost him extra money (2026-10-01).
- A **fresh conversation per job**; keep this file and `docs/HANDOVER.md` current instead of
  relying on a long conversation.
- Proportionate verification: the tests for what changed, not every suite. **No iOS
  simulators unless the job is iOS** (they are slow and heavy on this 8 GB Mac).
- Before a job, note the weekly usage %; after, report the change, so jobs can be priced.

## Non-negotiables
- Treat every PDF as hostile input: no `eval`/`new Function`, strict CSP, bounded loops and
  allocations, no panics on bad input.
- No telemetry. Nothing leaves the device unless the person clicks a cloud or AI action (the
  on-device AI and the font library's one-time question are the only automatic network use).
- No façade: every control shown must work; unfinished work is absent from the UI.
- Licences: MIT / Apache-2.0 / BSD / ISC / OFL preferred; never add GPL/AGPL/LGPL code; record
  every dependency in `THIRD-PARTY-NOTICES.md`. Never use Adobe's, Apple's or ArtCraft's marks.
- No client secrets in binaries — one exception the owner allowed (2026-10-24): Google's
  installed-app "secret" for Google Drive, which Google says is not secret for desktop apps;
  it comes from the `WARRAQ_GOOGLE_CLIENT_SECRET` Actions secret, is compiled into the Rust
  host only (and, owner 2026-10-26, the iPhone app's Info.plist at build time), and is never committed. The original bytes stay untouched until the person saves
  (incremental updates).
- **ZOOD's licensed font (ITF Huwiya Arabic) is never committed**: it lives in the git-ignored
  `apps/ios/PDFEditor/Resources/LicensedFonts/`; builds fall back to an OFL face without it.

## Layout
`packages/core` (Rust: warraq-pdf, warraq-text, warraq-render, warraq-sign, warraq-core — the
engine every platform uses; WASM for web, native for desktop, an XCFramework for iOS),
`packages/ui` (React UI for web, desktop and extension), `apps/web`, `apps/desktop` (Tauri 2),
`apps/extension`, `apps/ios` (SwiftUI, XcodeGen). Architecture: `docs/architecture.md`;
core API: `packages/core/API.md`; design system: `docs/design/README.md`.

## Building, testing, shipping
- Toolchain: `source .tools/env.sh` (git-ignored, local). Heavy builds go through
  `.tools/one-at-a-time.sh <command>` (a machine-wide lock). Never pattern-kill processes.
- Checks: `./scripts/verify.sh --no-e2e` (lint, unit, typecheck, builds, core fmt/clippy/tests,
  desktop tests). Web e2e: rebuild the web app and the WASM (`pnpm build:core`) first — a
  stale `dist` or WASM gives false results.
- **Mac**: `cd apps/desktop && CI=true node_modules/.bin/tauri build --bundles app,dmg`, then
  `WARRAQ_SKIP_BUILD=1 ./scripts/install-macos.sh` (installs into /Applications).
- **Windows**: built on GitHub, not here. Push to the `windows-build` branch of
  `git@github.com:MFvision/ZOOD-PDF.git` (public). The workflow builds, publishes the
  installer as a release (`ZOOD-PDF-Setup.exe`, page
  https://github.com/MFvision/ZOOD-PDF/releases), then runs the core and desktop tests on
  Windows and writes its status and log tails to the `ci-logs` branch
  (`git fetch origin ci-logs && git show FETCH_HEAD:status.txt`). Status is also readable at
  `https://api.github.com/repos/MFvision/ZOOD-PDF/actions/runs?branch=windows-build`.
  The project's code lives on the `app` branch of that remote; other branches there belong
  to the owner's other projects — never touch them.
- **iPhone/iPad**: `scripts/ios/build-core.sh` after core changes, `scripts/ios/build.sh` for
  tests, `scripts/ios/testflight.sh` to upload (team AWV883QWPU, bundle `app.warraq.ios`).
  If the upload says "Failed to Use Accounts", Xcode's Apple account has signed out: the
  owner must sign in again (Xcode → Settings → Apple Accounts) — never type his password.
  A new build arrives on his phone only once it is assigned to a tester in App Store Connect
  → TestFlight (unless an internal group with automatic distribution exists).
- Commits end with the attribution line the session gives. Branch `main` is local; push
  `HEAD:refs/heads/app` to publish code, and `HEAD:refs/heads/windows-build` to build Windows.
