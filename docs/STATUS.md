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

## Interface (`packages/ui`, `apps/web`, `apps/extension`)

`pnpm -C packages/ui test` (vitest) and `pnpm e2e` (Playwright, Chromium, production build of `apps/web` on
port 4311; the extension spec loads `apps/extension/dist` unpacked). Architecture: ADR 0006.

### Proven by tests
| What | Test |
| --- | --- |
| Home renders in English (LTR, sidebar left) and Arabic (RTL, sidebar mirrored right, «ملفات PDF، من جديد», `زود PDF` title); zero requests leave localhost | `home.spec.ts` |
| Only ready tools are shown (sidebar = More sheet = the 5 viewer-backed tools); no "coming soon"; six working home cards | `home.spec.ts`, `registry.test.ts`, `App.test.tsx` |
| Language switch in Settings flips `dir`, persists across reload; Arabic-Indic digits (`صفحة ١ من ٢`) | `home.spec.ts`, `open-save.spec.ts`, `i18n.test.ts` |
| Open via the Open card (file chooser) → viewer with page count; highlight with EmbedPDF; Save through the File System Access picker; saved bytes contain the `/Highlight`; **original bytes are an exact prefix of the saved file** (doc.rebase); reopen the saved file | `open-save.spec.ts` |
| A second save is one more incremental update on top of the first save | `open-save.spec.ts` |
| Save falls back to `<a download>` without the File System Access API | `open-save.spec.ts` |
| Non-PDF files are refused with a HUD toast; a tool picked before any document opens starts after the file is chosen | `open-save.spec.ts` |
| Redaction: mark + apply in EmbedPDF, saved as a whole rewrite (original is NOT a prefix), recents preview and stored bytes dropped | `redact-protect.spec.ts`, `save.test.ts` (`saveStrategy`) |
| Protect sheet (en/ar), Fill & sign and Prepare form tool strips reachable from our tool gallery; EmbedPDF speaks Arabic | `redact-protect.spec.ts`, `vite/embedpdf.test.ts` (every key of its English locale translated) |
| EmbedPDF build-time string patches still match the 2.15.1 dist (build fails otherwise) | `vite/embedpdf.test.ts` |
| Recents: real first-page PNG rendered by PDFium, date, survives reload, one-click reopen from stored bytes; star/tag via ⋯ menu; Starred/Tags sections | `recents-search.spec.ts`, `recents.test.ts` |
| ⌘K search over recents, Arabic-aware (hamza/tashkeel/taa-marbuta/digits), Enter opens | `recents-search.spec.ts`, `recents.test.ts` |
| PWA: manifest (en + ar translations, 192/512/maskable original icons); strict CSP meta without `unsafe-eval` or inline script; shell works offline after first load (including opening a PDF); no document ever cached; "Install app" only after `beforeinstallprompt` | `pwa.spec.ts` |
| Dark mode + reduced motion and Arabic light snapshots; increased contrast makes glass opaque; phone width: drawer (from the right in Arabic), no horizontal overflow, document view fits | `layout.spec.ts` |
| Chrome MV3 extension: `_locales` en/ar names, no permissions, CSP `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`; the extension page opens a PDF with no CSP violations or external requests | `extension.spec.ts` |
| Engine client: request ids, transferred blobs, typed `{code,message}` errors, worker crash and wasm trap (Rust panic) recreate the worker | `engine.test.ts` |
| Reducer: synchronous `switching` + `warraqOwnsDocument` on core byte replacement; stale viewer-ready ignored | `state.test.ts` |
| Every shipped npm package is under an allowed licence, listed in THIRD-PARTY-NOTICES.md, and its licence text is emitted into `licenses/` of every build | `vite/licenses.test.ts` |

### Not done / not proven
* **Password-protected originals**: EmbedPDF asks for the password itself and it never reaches the engine, so
  `doc.rebase` cannot open the original; such saves use PDFium's own output (which keeps the file's
  encryption) instead of an incremental update. Needs a hook into EmbedPDF's password prompt.
* **Fill & sign / Prepare form / Protect**: reachable and working in the viewer, but no spec yet fills a field,
  places a signature or sets a password and then reopens the saved bytes.
* **Snapshots** (`layout.spec.ts-snapshots`) are Linux/Chromium baselines; other OS fonts will differ.
* `prefers-reduced-transparency` is honoured in CSS but Playwright cannot emulate it; only `prefers-contrast`
  is tested.
* EmbedPDF's own page-number overlay shows Latin digits in Arabic, and its canvas stays LTR (its layout uses
  physical coordinates); its tool strips are mirrored.
* The extension runs PDFium on the page thread: MV3 CSP forbids the `blob:` worker EmbedPDF uses.
* `ZOOD_ALLOW_MISSING_ENGINE=1` (dev only) builds without the engine; `verify.sh` never sets it.
* Clouds and the AI card are implemented as seams only (`setCloudOpener`, `setAiHandler`) and stay hidden
  until those tools exist.
