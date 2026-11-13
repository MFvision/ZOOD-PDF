# CI and releases

Checked against `.github/workflows/` on 2026-11-13. Eleven workflows live there. This page says what
starts each one and what it publishes; how the desktop app is released and updated is in
[updates.md](updates.md), and the Microsoft Store package is in [store.md](store.md).

Two things to know first:

- The code lives on the `app` branch. On 2026-11-13 GitHub's default branch was a different one, and
  the **Run workflow** button lists only the default branch's workflows (the comments in
  `desktop-release.yml` and `desktop-windows.yml` say so). That is why several workflows also start
  from a pushed branch or tag.
- There is no `main` branch on GitHub (`CLAUDE.md`: `main` is local). A trigger that names `main`
  does not fire there.

## The workflows

| File | Starts on | What it publishes |
| --- | --- | --- |
| `ci.yml` (CI) | every pull request; a push to `main`; Run workflow; a call from `release.yml` | Nothing. It keeps artifacts: `warraq-extension`, `warraq-web`, `acid-results`, `warraq-desktop-macos-latest`, `warraq-desktop-windows-latest` |
| `release.yml` (Release) | a pushed tag `v*` | Runs `ci.yml`, then a **draft** GitHub release named "Warraq `<tag>`" with the unsigned files CI built |
| `desktop-release.yml` (desktop release, 1. build) | a tag `desktop-v*`; a branch `release/desktop-v*`; Run workflow with a version | A **pre-release** `desktop-v<version>` with the Windows and Mac installers, the signed update files and `latest.json` |
| `desktop-promote.yml` (desktop release, 2. release to users) | a tag `stable-v*`; a branch `release/stable-v*`; Run workflow with a version | Copies that version's `latest.json` to the `updates-stable` release, and marks `desktop-v<version>` as the latest release |
| `desktop-windows.yml` (desktop, Windows) | a push to `windows-build`; a tag `v*`; Run workflow | A pre-release `windows-<date>-<time>` with `ZOOD-PDF-Setup.exe` (a test build), and the run's outcome on the `ci-logs` branch |
| `desktop-store.yml` (desktop, Store package) | a pull request that touches the Store package's files; Run workflow | Nothing. It keeps the artifact `zood-store-package-test` |
| `ios-compile.yml` (iOS compile) | a pull request that touches `apps/ios/**`, `scripts/ios/**` or the core's C header folder; Run workflow | Nothing. It keeps the artifact `ios-build-log` |
| `android.yml` (Android) | a push to `app` or `claude/**` that touches `apps/android/**`, `apps/web/**` or `packages/**`; Run workflow | A pre-release `android-<version>-<run number>` with the `.apk` and `.aab`; to a Google Play track only when run by hand with a track chosen |
| `app-store-screenshots.yml` (App Store screenshots) | a push to `claude/**` that touches `StoreScreenshotTests.swift`; Run workflow | The artifact `store-screenshots`, and a **draft** release `store-shots` with the same pictures |
| `voice-lab.yml` (voice lab) | a push to any branch that touches `scripts/voice-lab/**`; Run workflow | The branches `voice-lab-results` and `voice-lab-models`. Research only; nothing ships in the app |
| `website-hostinger.yml` (Website to Hostinger) | a push to `app` that touches `website/**`; Run workflow | The `hostinger` branch, which holds the files the website serves |

Each workflow also starts when its own YAML file changes, where the table names a path filter.

Branches the workflows write, and nobody else should: `ci-logs`, `hostinger`, `voice-lab-results`,
`voice-lab-models`. All but `hostinger` are replaced whole on every run (a forced push).

## `ci.yml`: the checks

Four jobs. On GitHub they run on pull requests, by hand, and when `release.yml` calls them.

### `rust`: the core, natively and for wasm32

Ubuntu, `dtolnay/rust-toolchain@stable` with the `wasm32-unknown-unknown` target (the same channel
and target as `rust-toolchain.toml`), `Swatinem/rust-cache`. In `packages/core`:

1. `cargo fmt --all --check`
2. `cargo clippy --all-targets -- -D warnings`
3. `cargo test`
4. `cargo check --target wasm32-unknown-unknown -p warraq-core`: the "one core, two builds" gate. A
   feature that compiles only natively fails here (`docs/architecture.md`, Principles).

### `web`: WASM core, interface, web host, extension

Ubuntu, Node 22, pnpm through `pnpm/action-setup` (the version is the `packageManager` field in the
root `package.json`), Rust and `wasm-pack`.

1. `pnpm install --frozen-lockfile`
2. `pnpm build:core`: wasm-pack builds `warraq-core` into `packages/ui/src/core-wasm/`
3. `pnpm -r lint` and `pnpm -r test`: every workspace package that defines the script
4. `pnpm -r --filter './packages/**' build`: typechecks the shared interface (`tsc --noEmit`), which
   neither vitest nor eslint does
5. `pnpm --filter @warraq/web build` and `pnpm --filter @warraq/extension build`
6. `pnpm --filter @warraq/web e2e`: Playwright in the Google Chrome the runner already has (no
   browser download), against `vite preview` on `127.0.0.1:4391`. The specs in `apps/web/e2e` click
   through the interface as a person does, and `extension.spec.ts` loads the built extension into
   Chrome through DevTools (`Extensions.loadUnpacked`)
7. `pnpm --filter @warraq/extension check`: `scripts/check-manifest.mjs` on the built manifest, then
   `scripts/pack-chrome.mjs`
8. Artifacts: `warraq-extension` (`apps/extension/dist/warraq-extension.zip`) and `warraq-web`
   (`apps/web/dist`)

### `corpus`: the Arabic test files

Ubuntu, Python 3.11 with `.github/scripts/corpus-requirements.txt` (pypdfium2 5.x, pikepdf,
fonttools, Pillow), then Rust stable. The corpus is the PDFs in `tests/corpus/arabic/generated` and
`tests/corpus/arabic/realworld` (35 and 15 files on 2026-11-13).

1. `python3 tests/acid/run_python.py . pdfium`: opens, renders page 1 and extracts the text of every
   corpus file with PDFium
2. `python3 tests/acid/merge.py .`: merges with the committed results of the other engines and
   writes `tests/acid/results.json` and `docs/research/raw/acid-scores.md`
3. `python3 .github/scripts/check_corpus.py .`: **the PDFium gate**. It fails when a corpus file is
   missing from the results, did not open, or did not render its first page. `--generated-only`
   leaves the real-world set out; `--results <file>` reads another results file
4. Golden renders, robustness and hostile files: three `cargo test --release` runs on `warraq-core`
   (`--test golden`, `--test robustness`, `--test hostile`), described below
5. `cargo run --release -p warraq-core --example acid -- .`, then `python3 tests/acid/gate_warraq.py .`:
   **the ratchet** on our own engine, described below
6. Artifact `acid-results` (`results.json`, `results-pdfium.json`, `results-warraq.json`,
   `acid-scores.md`), kept even when the job fails

### `desktop (macos-latest)` and `desktop (windows-latest)`

pnpm, Node 22, Rust stable, `wasm-pack`, `Swatinem/rust-cache` for `packages/core` and
`apps/desktop/src-tauri`, and a cache of the ONNX Runtime files that the `ort` crate downloads while
building.

1. `pnpm install --frozen-lockfile`, `pnpm build:core`
2. `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` on the desktop crate
3. `cargo test` on the desktop crate, in the dev profile. The comment on that step in `ci.yml` says
   this is because "the release profile aborts on panic". That comment is out of date: the release
   profile in `apps/desktop/src-tauri/Cargo.toml` is now `panic = "unwind"`, so that the core and AI
   threads can catch one bad job and answer with an error instead of closing the app
4. `pnpm --filter @warraq/desktop build`, which is `tauri build`, **unsigned**. Tauri's
   `beforeBuildCommand` builds the web host in `tauri` mode first
5. Artifact `warraq-desktop-<os>`: the `.dmg` on macOS and the NSIS `-setup.exe` on Windows. No
   `.msi` is made: `tauri.windows.conf.json` sets the Windows bundle to NSIS only, and the `msi` path
   in the upload step matches nothing

## `release.yml`: a draft release from a `v*` tag

1. `build`: the whole of `ci.yml`.
2. `draft release`: checks that the tag equals the `version` in
   `apps/desktop/src-tauri/tauri.conf.json` and in `apps/extension/manifest.json` (both `0.1.0`
   today), downloads the artifacts and creates a **draft** release with `softprops/action-gh-release`:
   `warraq-extension-<tag>.zip`, `warraq-web-<tag>.zip`, the desktop bundles and
   `acid-results-<tag>.json`. Someone publishes it by hand.

A `v*` tag also starts `desktop-windows.yml`. No `v*` tag existed on GitHub on 2026-11-13, so this
workflow has made no release that is there now. Desktop versions are released by the two workflows
below.

## The desktop release, in two steps

Full detail, the keys and the signing are in [updates.md](updates.md).

### 1. `desktop-release.yml`: build

The version comes from the Run workflow form, or from the name of the tag `desktop-v<version>` or
the branch `release/desktop-v<version>`. It must look like `0.2.0`, and the
`TAURI_SIGNING_PRIVATE_KEY` secret must be set, or the run stops at once.

- **Builds** Windows (x86_64) and Mac (Apple silicon only, because the bundled PDFium is arm64) with
  that version passed to `tauri build`, so `tauri.conf.json` keeps `0.1.0`.
- **Signs when the secrets are there**: the Mac app with the Developer ID, notarized when the Apple
  ID secrets are there too; the Windows app, uninstaller and installer through Certum. Without those
  secrets the build is unsigned and the run still passes. The update files are always signed with
  the updater key.
- **Checks**: the Windows and Mac signatures when signing ran, the notarization, and a launch check
  on both systems: the built app is started and must still be running after 45 seconds.
- **Publishes** a pre-release `desktop-v<version>`, titled "ZOOD PDF `<version>` (testing)", with
  `ZOOD-PDF-Setup-<version>.exe`, `ZOOD-PDF-<version>-mac.dmg`, `ZOOD-PDF-<version>-mac.app.tar.gz`,
  the two `.sig` files and `latest.json`. When the `STORE_PUBLISHER` variable is set it adds
  `ZOOD-PDF-<version>-store.msix`.

Nobody's installed app sees a pre-release.

### 2. `desktop-promote.yml`: release to users

The version comes from the form, the tag `stable-v<version>` or the branch `release/stable-v<version>`.

1. Downloads `latest.json` from `desktop-v<version>` and checks that it names that version and has a
   signed update for Windows and for Mac.
2. Uploads it to the `updates-stable` release, creating that release if it is missing. This is the
   file every installed app reads (`plugins.updater.endpoints` in `tauri.conf.json`).
3. Marks `desktop-v<version>` as a full release and the latest one, and retitles it
   "ZOOD PDF `<version>`".

Runs of this workflow never overlap (one concurrency group).

## `desktop-windows.yml`: the Windows test build

One job on `windows-latest`. Run workflow has a `weight_only` box that keeps only the build, the
measuring of the app's weight and the screenshot check.

1. `tauri build` with the version in `tauri.conf.json`. Artifact `warraq-windows-installer`.
2. Publishes the installer as a pre-release `windows-<UTC date>-<time>` named `ZOOD-PDF-Setup.exe`.
   It is unsigned and is never on the update channel.
3. Tries the app as a person would, each step allowed to fail without failing the run: the ring
   (`scripts/ci/ring-check.ps1`), the right-click tools (`quick-check.ps1`), Ask ZOOD
   (`ask-check.ps1`), the app's CPU and memory (`perf-check.ps1`), and screenshots with ZOOD running
   (`screenshot-check.ps1`).
4. After the installer is out, so a failing test never withholds it: `cargo test --release` on
   `warraq-text`, `warraq-pdf` and `warraq-core`, then the desktop host's library tests.
5. The phone remote's tests, with Chrome at phone size (allowed to fail).
6. Always: writes `status.txt` (the outcome of the job and of each check, the commit, the release
   tag), the last 250 lines of each log and the checks' folders to the `ci-logs` branch.

Read the outcome with `git fetch origin ci-logs && git show FETCH_HEAD:status.txt`.

## `desktop-store.yml`: the Store package, tried

On `windows-latest`: checks and builds the right-click add-on (`apps/desktop/src-tauri/shell-ext`),
builds the app without bundling, makes a **test-signed** package with
`scripts/windows/make-store-package.ps1 -TestSign`, and tries it with
`scripts/windows/check-store-package.ps1`. The package is for checking only. The package that goes
to the Store comes from `desktop-release.yml`.

## `ios-compile.yml`: the iPhone and iPad app compiles

On `macos-latest`, with the newest Xcode on the runner: builds the core for the simulator
(`scripts/ios/build-core.sh`), fetches llama.cpp (`scripts/ios/fetch-llama.sh`), generates the
project with XcodeGen, builds the app and its tests unsigned, and runs a named list of unit suites
on a simulator. Nothing is signed, installed or published. The Keychain suites are not in the list;
the workflow's comment says they need a signed test host and run with `scripts/ios/build.sh` on a
Mac.

## `android.yml`: the Android app

Two jobs on Ubuntu.

- **`android`**: builds the WASM core without `wasm-opt` (the comment in the file says why), runs
  the shared interface's tests, builds the web app and copies it into the Android app, then runs
  `gradle lintRelease bundleRelease assembleRelease` with Java 17. The version name is the form's,
  or `0.1.0`; the version code is 1000 plus the run number. With the `ANDROID_UPLOAD_KEYSTORE`
  secrets the files are signed with the upload key; without them, with a debug key that Google Play
  refuses. It keeps the artifact `zood-pdf-android` for 30 days and publishes the pre-release. The
  release's note says which key signed it.
- **`smoke (emulator)`**: starts the built app on an Android emulator (API 34) with
  `apps/android/scripts/smoke.sh`, adds its pictures and log to the pre-release, and fails when the
  app did not start.

A push never sends anything to Google Play. Only a run by hand with a track chosen does, and it
needs the `PLAY_SERVICE_ACCOUNT_JSON` secret; the `production` track is sent as a draft.

## `app-store-screenshots.yml`: the App Store pictures

On `macos-latest`: builds the app and its UI tests, then runs `StoreScreenshotTests` on the largest
iPhone and iPad simulators the runner has, from a list of names in the file. The raw pictures come
back as the artifact `store-screenshots` and as a draft release `store-shots`, which is deleted and
made again on each run. They are framed afterwards with `scripts/ios/store-frames/`. Nothing is
signed or sent to Apple.

## `voice-lab.yml`: read-aloud voices, tried

Research only. The `engine` job runs Piper on Windows and Kokoro on Ubuntu over the sentences in
`scripts/voice-lab/texts.py`; `models` pins the candidate voices (`scripts/voice-lab/models.py`);
`results` scores how well each sample is understood with Whisper (`scripts/voice-lab/understand.py`).
Samples and timings go to the `voice-lab-results` branch, the pinned voices to `voice-lab-models`.

## `website-hostinger.yml`: the website

Copies the files under `website/` that the site serves (everything tracked there except `tools`,
`README.md`, `Dockerfile`, `Caddyfile`, `package.json` and the ignore files) to the `hostinger`
branch, as a commit "Website from `<commit>`". The file's comment says Hostinger deploys that branch
to pdf.zoodrealty.com on every push; that half is set up at Hostinger and cannot be checked from
this repository.

## Secrets and variables

The workflows read these. Which of them are set on GitHub cannot be read from the repository's
files; a release's own note or files show what a run had (an Android release says which key signed
it, and a desktop release has `.sig` files only when the updater key was there).

| Name | Kind | Read by | Used for |
| --- | --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secret | `desktop-release.yml` | Signing the update files. Required |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | secret | `desktop-release.yml` | Signing the Mac app with the Developer ID |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` | secret | `desktop-release.yml` | Notarizing the Mac app |
| `APPLE_TEAM_ID` | variable | `desktop-release.yml` | The team for notarization; has a default in the file |
| `CERTUM_EMAIL`, `CERTUM_OTP` | secret | `desktop-release.yml` | Signing the Windows files |
| `WARRAQ_GOOGLE_CLIENT_SECRET` | secret | `desktop-release.yml`, `desktop-windows.yml` | Google Drive in the desktop app; without it Google Drive is left out |
| `WARRAQ_GOOGLE_CLIENT_ID`, `WARRAQ_ONEDRIVE_CLIENT_ID`, `WARRAQ_ONEDRIVE_TENANT` | variable | the same two | The cloud drives' public app IDs (`docs/cloud.md`); the IDs have defaults in the files |
| `STORE_NAME`, `STORE_PUBLISHER`, `STORE_PUBLISHER_DISPLAY_NAME` | variable | `desktop-release.yml` | The Microsoft Store package's identity; unset, no package is made |
| `ANDROID_UPLOAD_KEYSTORE`, `ANDROID_UPLOAD_KEYSTORE_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS` | secret | `android.yml` | Signing the Android files with the upload key |
| `PLAY_SERVICE_ACCOUNT_JSON` | secret | `android.yml` | Sending the bundle to Google Play |

`ci.yml`, `release.yml`, `desktop-store.yml`, `ios-compile.yml`, `app-store-screenshots.yml`,
`voice-lab.yml` and `website-hostinger.yml` use only GitHub's automatic token.

## Caches

- `Swatinem/rust-cache@v2`: the cargo registry and the `target/` directories of the workspaces each
  job names.
- `actions/setup-node` with `cache: pnpm`: the pnpm store, keyed on `pnpm-lock.yaml`.
- `actions/setup-python` with `cache: pip` in the `corpus` job, keyed on
  `.github/scripts/corpus-requirements.txt`.
- `actions/cache` for the ONNX Runtime files `ort` downloads, in the three desktop workflows that
  build the app with it (`ci.yml`, `desktop-release.yml`, `desktop-windows.yml`).

## Making the checks block merges

CI only reports; a branch protection rule is what blocks. Whether one is set on `app` cannot be read
from the repository's files: look in _Settings → Branches_ on GitHub. To set one:

1. Add a rule for `app`.
2. Tick **Require a pull request before merging**.
3. Tick **Require status checks to pass before merging**, then add the job names above: `rust`,
   `web`, `corpus`, `desktop (macos-latest)`, `desktop (windows-latest)`. They appear in the picker
   after the first CI run on a pull request.
4. Tick **Do not allow bypassing the above settings**, so that nobody can merge over a red corpus.

With this in place a pull request that makes an Arabic corpus file fail shows a red `corpus` check
and cannot be merged; the `acid-results` artifact on the failed run has the reason for each file.

## Running the same checks locally

`./scripts/verify.sh` runs what CI runs, with one line of verdict per step; `--no-e2e` leaves the
browser tests out. Or step by step:

```bash
(cd packages/core && cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test \
  && cargo check --target wasm32-unknown-unknown -p warraq-core)
pnpm install && pnpm build:core && pnpm -r lint && pnpm -r test
pnpm --filter @warraq/web build && pnpm --filter @warraq/extension build && pnpm --filter @warraq/extension check
python3 -m pip install -r .github/scripts/corpus-requirements.txt
python3 tests/acid/run_python.py . pdfium && python3 tests/acid/merge.py . && python3 .github/scripts/check_corpus.py .
pnpm --filter @warraq/desktop build
```

## The Arabic extraction ratchet

The `corpus` job runs our own engine over the corpus (`cargo run -p warraq-core --example acid`) and
then `tests/acid/gate_warraq.py`, which compares every file against
`tests/acid/baseline-warraq.json` and fails the build when a file stops opening, loses more than
0.05 of word recall or line order, or drops out of the `logical` verdict. Improvements are reported
but never fail. After an intended improvement, refresh the ratchet with:

```bash
cargo run --release --manifest-path packages/core/Cargo.toml -p warraq-core --example acid -- .
python3 tests/acid/gate_warraq.py . --update
```

and commit the new baseline together with the change that caused it.

## Hostile files and fuzzing

Every PDF is hostile input. The `corpus` job runs two harnesses on stable Rust:

- `packages/core/warraq-core/tests/robustness.rs` mutates every corpus file (truncation, bit flips,
  corrupted digits, damaged `xref`/`trailer`/`stream` keywords, deleted spans). Opening, rendering,
  extracting and searching must either succeed or return an error: never panic, never run past the
  time budget. A failure prints the file and seed that reproduce it.
- `packages/core/warraq-core/tests/hostile.rs` has hand-made bad files (loops, deep nesting,
  impossible lengths, decompression bombs, broken fonts) and a seeded mutation fuzzer over them and
  the corpus. Each case runs on a thread with a 1 MiB stack, as the WebAssembly build has.
  `WARRAQ_FUZZ_ITERS=<n>` makes it run longer.

Coverage-guided fuzzing is in `packages/core/fuzz/`, with five targets (`open_document`,
`extract_text`, `lex_content`, `form_script`, `library_index`). It needs a nightly toolchain, so no
workflow runs it; see `packages/core/fuzz/README.md`.

## Golden renders

`packages/core/warraq-core/tests/golden.rs` renders page 1 of every corpus file and compares it with
a reference in `tests/golden/`. References are 160 px wide, 8-bit grey, so the whole corpus stays
under 2 MB while still catching a moved line, a missing glyph or a blank page. Comparison is by mean
absolute difference, with a tolerance of 2 grey levels out of 255.

After an intended rendering change, refresh the references and commit them with the change:

```bash
UPDATE_GOLDEN=1 cargo test --manifest-path packages/core/Cargo.toml -p warraq-core --test golden
```
