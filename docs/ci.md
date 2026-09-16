# CI and releases

Two GitHub Actions workflows live in `.github/workflows/`:

| Workflow      | Trigger                                                                                                               | What it does                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ci.yml`      | every push to `main`, every pull request, manual (`workflow_dispatch`), and `workflow_call` from the release workflow | four jobs: `rust`, `web`, `corpus`, `desktop (macos-latest)` / `desktop (windows-latest)`               |
| `release.yml` | a pushed tag `v*` (for example `v0.1.0`)                                                                              | runs `ci.yml` unchanged, then creates a **draft** GitHub release with the artifacts attached (unsigned) |

## Jobs

### `rust` — the core, natively and for wasm32

Ubuntu, `dtolnay/rust-toolchain@stable` with the `wasm32-unknown-unknown` target (the same
channel and target pinned in `rust-toolchain.toml`), `Swatinem/rust-cache`. In `packages/core`:

1. `cargo fmt --all --check`
2. `cargo clippy --all-targets -- -D warnings`
3. `cargo test`
4. `cargo check --target wasm32-unknown-unknown -p warraq-core` — the **"one core, two builds"** gate: a
   feature that compiles only natively fails here (`docs/architecture.md`, Principles).

### `web` — WASM core, UI, web host, extension

Ubuntu, Node 22 through `actions/setup-node`, pnpm through `pnpm/action-setup` (the version comes from the
`packageManager` field in the root `package.json`), pnpm store cache, Rust + `wasm-pack`
(`taiki-e/install-action`).

1. `pnpm install --frozen-lockfile`
2. `pnpm build:core` — wasm-pack builds `warraq-core` into `packages/ui/src/core-wasm/`
3. `pnpm -r lint` and `pnpm -r test` — every workspace package that defines the script
   (`@warraq/ui`, `@warraq/web`, `@warraq/extension`)
4. `pnpm --filter @warraq/web build` and `pnpm --filter @warraq/extension build`
5. `pnpm --filter @warraq/extension check` — `scripts/check-manifest.mjs` (required keys, minimal permissions,
   CSP, locales, no inline scripts) and `scripts/pack-chrome.mjs` (Chrome headless `--pack-extension` on a copy of
   `dist/`; Chrome prints the manifest error and produces no `.crx` when the manifest is invalid)
6. Artifacts: `warraq-extension` (`apps/extension/dist/warraq-extension.zip`) and `warraq-web` (`apps/web/dist`)

### `corpus` — the Arabic acid test on PDFium

Ubuntu, Python 3.11, `pip install -r .github/scripts/corpus-requirements.txt` (pypdfium2 5.x, pikepdf,
fonttools, Pillow).

1. `python3 tests/acid/run_python.py . pdfium` — opens, renders page 1 and extracts text of all 41 corpus files
   with PDFium (each file in its own process, so a crash is recorded, not fatal)
2. `python3 tests/acid/merge.py .` — merges with the committed results of the other engines, scores the text
   against the ground truth and writes `tests/acid/results.json` and `docs/research/raw/acid-scores.md`
3. `python3 .github/scripts/check_corpus.py .` — **the gate**: fails when any file in
   `tests/corpus/arabic/generated` or `tests/corpus/arabic/realworld` is missing from the results, did not open,
   or did not render its first page. `--generated-only` restricts it to the generated set;
   `--results tests/acid/results-pdfium.json` reads the raw runner output instead of the merge.
4. Artifact `acid-results` (`results.json`, `results-pdfium.json`, `acid-scores.md`), uploaded even on failure.

Per ADR-0002 a red Arabic test blocks merge. Today the gate is "opens and renders in PDFium"; when
`warraq-core` runs the corpus itself (Phase 2), add its runner next to `run_python.py` and extend
`check_corpus.py` with the text-score thresholds from `tests/acid/score.py`.

### `desktop (macos-latest)` and `desktop (windows-latest)`

pnpm + Node 22, Rust stable, `wasm-pack`, `Swatinem/rust-cache` for both `packages/core` and
`apps/desktop/src-tauri`. macOS runners already have Xcode/CLT and Windows runners MSVC + WebView2; the Linux
apt step is guarded by `runner.os == 'Linux'` and only matters when ubuntu joins the matrix.

1. `pnpm install --frozen-lockfile`, `pnpm build:core`, `pnpm --filter @warraq/web build`
2. `cargo fmt --check` on the desktop crate
3. `pnpm --filter @warraq/desktop build` → `tauri build`, **unsigned** (no signing identity, no notarization;
   the `beforeBuildCommand` rebuilds the web host so `apps/web/dist` is always current)
4. Artifact `warraq-desktop-<os>`: `.dmg` on macOS, `.msi` + NSIS `-setup.exe` on Windows, from
   `apps/desktop/src-tauri/target/release/bundle/`

## Making the corpus (and everything else) block merges

CI only reports; branch protection is what blocks. Once the repository is on GitHub:

1. _Settings → Branches → Add branch protection rule_, pattern `main`.
2. Tick **Require a pull request before merging**.
3. Tick **Require status checks to pass before merging** and **Require branches to be up to date before merging**,
   then add these checks (the job names above): `rust`, `web`, `corpus`, `desktop (macos-latest)`,
   `desktop (windows-latest)`. The checks appear in the picker after the first CI run on a PR.
4. Tick **Do not allow bypassing the above settings** so administrators cannot merge over a red corpus.

Equivalent `gh` call (repeat `-f` for each context):

```bash
gh api -X PUT repos/<org>/warraq/branches/main/protection \
  -F required_status_checks[strict]=true \
  -f 'required_status_checks[contexts][]=rust' -f 'required_status_checks[contexts][]=web' \
  -f 'required_status_checks[contexts][]=corpus' \
  -f 'required_status_checks[contexts][]=desktop (macos-latest)' -f 'required_status_checks[contexts][]=desktop (windows-latest)' \
  -F enforce_admins=true -F required_pull_request_reviews[required_approving_review_count]=1 -F restrictions=null
```

With this in place a PR that makes any Arabic corpus file fail to open in PDFium shows a red `corpus` check and
the merge button is disabled; the `acid-results` artifact on the failed run has the per-file reason.

## Releases

`git tag v0.1.0 && git push origin v0.1.0` runs `release.yml`:

1. `build` — the whole `ci.yml` (all gates must pass; the same artifacts are reused).
2. `draft release` — checks that the tag equals the `version` in `apps/desktop/src-tauri/tauri.conf.json` and
   `apps/extension/manifest.json`, downloads the artifacts and creates a **draft** release
   (`softprops/action-gh-release`) with `warraq-extension-<tag>.zip`, `warraq-web-<tag>.zip`, the `.dmg`, `.msi`
   and `-setup.exe`, and `acid-results-<tag>.json`. A maintainer reviews and publishes it by hand.

The release needs only the automatic `GITHUB_TOKEN` (`permissions: contents: write`).

## Secrets

Nothing today: every job runs unsigned and unauthenticated. When signing is enabled (`apps/desktop/README.md`,
"Signing and notarization"), the desktop job and the release will read these repository secrets:

| Secret                         | Used for                                      |
| ------------------------------ | --------------------------------------------- |
| `APPLE_CERTIFICATE`            | base64 of the Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD`   | password of that `.p12`                       |
| `APPLE_ID`                     | Apple ID used for notarization                |
| `APPLE_PASSWORD`               | app-specific password of that Apple ID        |
| `APPLE_TEAM_ID`                | team identifier for notarization              |
| `WINDOWS_CERTIFICATE`          | base64 of the code-signing `.pfx`             |
| `WINDOWS_CERTIFICATE_PASSWORD` | password of that `.pfx`                       |

Do not add them before the signing steps exist; unused secrets are only a liability.

## Caches

- `Swatinem/rust-cache@v2` — `~/.cargo` registry/git and the `target/` directories of `packages/core` and
  `apps/desktop/src-tauri`, keyed on the lockfiles and the toolchain.
- `actions/setup-node` with `cache: pnpm` — the pnpm store, keyed on `pnpm-lock.yaml`.
- `actions/setup-python` with `cache: pip` — keyed on `.github/scripts/corpus-requirements.txt`.

## Running the same checks locally

```bash
export PATH="$HOME/.cargo/bin:$PATH"
(cd packages/core && cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test \
  && cargo check --target wasm32-unknown-unknown -p warraq-core)
pnpm install && pnpm build:core && pnpm -r lint && pnpm -r test
pnpm --filter @warraq/web build && pnpm --filter @warraq/extension build && pnpm --filter @warraq/extension check
python3 -m pip install -r .github/scripts/corpus-requirements.txt
python3 tests/acid/run_python.py . pdfium && python3 tests/acid/merge.py . && python3 .github/scripts/check_corpus.py .
pnpm --filter @warraq/desktop build
```

The workflow files are plain YAML; `node` with the `yaml` package (or `actionlint`, if installed) parses them.
