# Status

Honest, current state. Updated by every change. "Proven" means covered by an automated test that runs in `scripts/verify.sh`.

## Summary
Scaffolding in progress.

## Engine foundation (warraq-pdf, warraq-core, warraq-render)

`cd packages/core && cargo test --workspace` (plus `node packages/core/crates/warraq-core/tests/wasm-smoke.mjs`
after `bash scripts/build-wasm.sh`). Page indices in the RPC are 0-based.

### Proven by tests
| What | Test |
| --- | --- |
| Limits: file size, object count, page count, nesting depth, per-stream decode cap + zip-bomb ratio | `warraq-pdf/src/limits.rs` tests, `tests/incremental.rs::limits_are_enforced` |
| Broken xref reconstructed; truncated file (no trailer) and leading junk load; saved update is valid | `tests/incremental.rs::broken_xref_…`, `truncated_file_and_leading_junk_still_load` |
| Freed objects stay freed (lopdf ignores free entries; our xref walk does not) | `tests/incremental.rs::deleted_objects_become_free_entries` |
| Page-tree cycles terminate | `tests/incremental.rs::self_referencing_page_tree_does_not_loop` |
| No panic / bounded time on 2000 mutated + truncated fixtures (open, pages, metadata, save, rewrite, rebase) | `tests/smoke_fuzz.rs` (≈18 s debug; `WARRAQ_SMOKE_CASES` to change) |
| Decryption of qpdf- and pypdf-made R2, R3, R4-RC4, R4-AES (+object streams, +EncryptMetadata false), R6 (+object streams, empty user password with restrictions), user AND owner passwords, wrong/missing password errors | `tests/encryption.rs::third_party_fixtures_…`, `unencrypted_metadata_stays_readable`, `empty_user_password_and_permissions` |
| Our encryptor (R2, R3, R4-RC4, R4-AES, R6; table and xref-stream files) round-trips and pypdf decrypts it with the user password | `tests/encryption.rs::own_encryptor_…`, `pypdf_decrypts_what_we_encrypt` (skips if python/pypdf absent) |
| R5/R6 hash 2.B known answers (from pypdf) | `crypt.rs::r5_r6_hash_known_answers_from_pypdf` |
| Incremental update of encrypted files keeps `/Encrypt` and the same key; appended strings are ciphertext; pypdf reads it | `tests/encryption.rs::incremental_updates_keep_protection_and_key`, `pypdf_reads_our_incremental_update_on_encrypted_file` |
| Permissions enforced for user-password sessions (`permission_denied`) | `tests/encryption.rs::user_password_cannot_modify_…`, `warraq-core/tests/rpc.rs::protect_…` |
| Protect set (AES-256 R6, Arabic passwords) / change / remove / keep = whole rewrites | `tests/encryption.rs::protect_set_change_and_remove_are_whole_rewrites` |
| Incremental writer: original is an exact byte prefix; only changed objects appended; table vs xref stream matches the original; `/Prev`, `/ID[0]` kept; lopdf and pypdf read the result | `tests/incremental.rs` (first three tests) |
| Full rewrite garbage-collects orphans and drops revisions | `tests/incremental.rs::full_rewrite_collects_garbage_and_drops_revisions` |
| Rebase: PDFium-style full rewrite (streams recompressed) → only the changed annotation appended; added/removed annotations; unchanged → original bytes; renumbered → safe fallback; earlier revisions survive; encrypted original + decrypted edit → re-encrypted with original key; protection changed → edited bytes | `tests/rebase.rs` |
| Revisions listed and extracted byte-exactly | `tests/pages_meta.rs::revisions_list_and_extract` |
| Page tree flattening with inherited MediaBox/Resources/Rotate; rotate, reorder, move, delete, insert blank, insert from another PDF (deep copy, annotation `/P` remapped), extract, merge, crop | `tests/pages_meta.rs` |
| Info (Arabic UTF-16) and XMP get/set; pypdf reads the Arabic title | `tests/pages_meta.rs::info_and_xmp_round_trip_with_arabic` |
| Every RPC method (doc.*, pages.*, protect.*, pdf.isEncrypted, pdf.merge, methods.list), JSON error codes | `warraq-core/tests/rpc.rs` |
| C ABI open/call/static/free/close, error replies; header declares every export | `warraq-core/src/ffi.rs` tests |
| wasm build loads in Node (`initSync`), doc.info, incremental rotate, encrypted open with user password, protect.set via crypto.getRandomValues, `{code,message}` errors | `warraq-core/tests/wasm-smoke.mjs` |
| hayro renders a generated page (non-white pixels, PNG); `pages.render` of an encrypted doc (feature `render`) | `warraq-render` tests, `rpc.rs::render_png_of_encrypted_document` (`--features render`) |

### Not done / not proven
* **cargo-fuzz targets** (`packages/core/fuzz`: `load`, `decrypt`, `rebase`): no nightly/cargo-fuzz here, so they
  were built on stable with SanitizerCoverage flags (`-Cpasses=sancov-module …`, no ASan) and each ran 60 s from
  the fixture corpus (load 135k, decrypt 47k, rebase 47k executions, no crash). Not part of `verify.sh`;
  the stable smoke fuzz above is. `content_lexer` target comes with the content lexer.
* **PDFium backend** (`warraq-render`, feature `pdfium`) compiles but is untested: no libpdfium on the build machine.
* **wasm size**: 1,003,533 bytes (435 KB gzip) with `wasm-opt -Os`; wasm-pack cannot download binaryen here, so
  `build-wasm.sh` runs `wasm-opt` itself when `WASM_OPT`/PATH provides it and otherwise skips it (~1.3 MB).
  hayro is not in the default wasm (`WASM_FEATURES=wasm,render` adds it).
* wasm32 panics abort (no unwinding), so the `catch_unwind` belt only protects the C ABI; the web worker must
  recreate the engine after a `RuntimeError`. The code itself has no `unwrap/expect/panic/indexing` (clippy).
* Real PDFium output was not available: rebase is tested against lopdf-simulated full rewrites. The numbering
  assumption is checked at runtime (fallback: append everything) — see ADR 0003.
* R5/R6 passwords are not SASLprep-normalised; R2–R4 non-Latin-1 passwords are not portable (ADR 0004).
* Form fields of pages copied with `pages.insertFrom`/`extract`/`merge` are not added to the target AcroForm;
  outlines/named destinations pointing at deleted pages become dangling (resolve to null).
* `doc.info.hasSignatures` is a heuristic (a `/FT /Sig` field with `/V`, or a `/Sig` dictionary with
  `/ByteRange`); verification belongs to warraq-sign.

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
  interface (built by `apps/desktop/vite.config.ts` from the web entry, no meta CSP) must render, and the WASM engine
  must answer from its module worker under the Tauri CSP (`engine=ok`). Both runs passed here on WebKitGTK 2.52
  under Xvfb (UI run against a local trial merge of the UI and engine branches).
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
