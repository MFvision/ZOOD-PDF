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
## Arabic text engine (`warraq-text`) and corpus

### What exists (proven by tests)
* Content-stream interpreter for text: `BT/ET`, `q/Q`, `cm`, `Tf Tc Tw Tz TL Ts Tr`, `Td TD Tm T*`, `Tj TJ ' "`,
  form XObjects (depth ≤ 12, cycle-safe, inherit the graphics/text state), inline images skipped, marked content
  with `/ActualText` (preferred over glyphs), `/Artifact`, `/Lang`, Chrome's `/ReversedChars`. Invisible text
  (`Tr 3/7`) is extracted and flagged `hidden`; bold drawn twice (fill then stroke / offset) is read once.
* Fonts: Type0/CID (Identity-H/V, embedded CMaps with `usecmap`, `Uni*-UCS2`), simple TrueType/Type1/Type3 with
  base encodings + `/Differences` + glyph names (AGL subset, `uniXXXX`, `afii57xxx`, `lam-ar.init`, `lam_alef-ar`),
  ToUnicode (`bfchar`, `bfrange` incl. array form and multi-codepoint), `/W` and `/Widths`, standard-14 metrics,
  embedded-font cmap fallback. Fonts are keyed by object id.
* Layout to blocks → paragraphs → lines → words (with optional glyph boxes) in logical order: XY-cut columns
  (RTL right-to-left), aligned short columns read as tables, bidi with the **W5 fix** (see ADR 0005 and
  `bidi.rs`), the **Nastaliq ordering rule**, presentation forms → base letters (NFKC only for those),
  paragraph breaks from spacing, size, indent, lists and sentence ends.
* `normalize_for_search` with offset map, `search()` with per-line rectangles, `shape()` (harfrust) with per-word
  `/ActualText` spans and a content-stream helper; written Arabic is read back in logical order by the extractor
  (`tests/roundtrip.rs`, font without ToUnicode). `/Direction /R2L` is never written.
* RPC-ready functions `text.extract`, `text.search`, `text.plain` (`warraq_text::call`); `warraq-core` still has to
  register them (lead integration).
* Hostile input: no `unwrap`/`expect`/`panic`/indexing in library code, every loop bounded (`limits.rs`),
  no-panic smoke test (`tests/no_panic.rs`, 8 000 mutated streams/CMaps/strings per run), cargo-fuzz targets
  `packages/core/fuzz/fuzz_targets/{content_text,cmap}.rs` (not run in CI: need nightly).

### Corpus (`tests/corpus`, regenerate with `python3 scripts/corpus/generate.py`)
* Fonts (OFL, with `OFL.txt`): Amiri, Cairo, Noto Naskh Arabic, Noto Nastaliq Urdu, Vazirmatn, Inter.
* **Chrome-made** (headless Chromium `--print-to-pdf`, dates fixed for determinism): news (Amiri; Cairo variable →
  Type3 + presentation-form ToUnicode), mixed Arabic/English/Western and Arabic-Indic digits, deliberately hard
  bidi (e-mail, `+966` phone, URL, Hijri/Gregorian dates with `/`, brackets, multi-word Latin runs, Latin list
  in an RTL page), two columns, table, bold (real and synthetic), full tashkeel (Amiri), Nastaliq Urdu, Persian
  with Persian digits and ZWNJ, lists, English control.
* **Synthetic producer-style** — written by our own Python writer, *not* by the real applications:
  "synthetic Word-style" (Identity-H + ToUnicode, TJ kerning, one run per word, ActualText per word, fake bold drawn
  twice, `Tr 2`, `Tr 3`, `/Artifact` footers, 2 pages), "synthetic LibreOffice-style" (logical glyph order,
  ToUnicode to presentation forms incl. lam-alef ligatures), shaper-order streams for Nastaliq (non-monotonic x,
  cascading y) and Amiri kerning, simple fonts (WinAnsi Helvetica with `TL/T*/'/"/Tw/Tc/Tz`, symbolic TrueType
  Arabic with only `/Differences` names, form XObject). **Genuine Microsoft Word and LibreOffice output is not in
  the corpus**: Word cannot run here and LibreOffice is forbidden (GPL/MPL); the labels say "synthetic".
* **Encrypted** copies (pypdf): RC4-128 and AES-256, one with an Arabic password; passwords in `manifest.json`.
  The acid gate loads every corpus file with `warraq-pdf` (the product loader and decryption) and reads it in place
  through `DocSource::borrowed(pdf.document())`, so they are measured, not pending (`ACID_LOADER=lopdf` gives the
  same numbers with the stand-alone lopdf loader).
* **Scans** (git-ignored, `tests/corpus/generated/scans`): 300-dpi page images of the tashkeel, Nastaliq and Persian
  pages, each straight, crooked 5°, crooked 8° and shadowed, as PNG and image-only PDF, same truth text. OCR is done
  later by the UI (tesseract.js); scans are not part of the acid gate.
* Generation is deterministic (two consecutive runs give byte-identical PDFs, PNGs, truth files and manifest).

### Acid gate (`cargo test -p warraq-text --test acid -- --nocapture`)
Normalised character accuracy = 1 − Levenshtein / truth length after NFC, removal of invisible format characters
and whitespace collapsing. Per-file floors in `tests/acid/baseline.json` (measured − 0.2 points); any drop fails.

Measured on 2026-09-25 (21 non-scanned files; all at their floor of 99.80 %):

| Category | Files | Accuracy |
| --- | --- | --- |
| Chrome-made Arabic (Amiri, Cairo Type3, Noto Naskh, two columns, table, bold, lists) | 6 | 100.00 % each |
| Chrome-made mixed Arabic/English/digits incl. the hard-bidi page | 2 | 100.00 % each |
| Chrome-made Amiri full tashkeel | 1 | 100.00 % |
| Chrome-made Nastaliq Urdu | 1 | 100.00 % |
| Chrome-made Persian (Vazirmatn, Persian digits, ZWNJ) | 1 | 100.00 % |
| Chrome-made English control (Inter) | 1 | 100.00 % |
| Synthetic Word-style (2 pages, fake bold, Tr 2/3, artifacts) | 1 | 100.00 % |
| Synthetic LibreOffice-style (presentation forms, logical glyph order) | 1 | 100.00 % |
| Synthetic shaper streams (Nastaliq cascades, Amiri kerning) | 2 | 100.00 % each |
| Synthetic simple fonts (WinAnsi, `/Differences` names, form XObject) | 1 | 100.00 % |
| Encrypted copies (RC4-128, AES-256 ×3 incl. Arabic password) | 4 | 100.00 % each |
| Scans (12 variants) | — | not measured here (OCR is in the UI) |

Caveat: the corpus was written together with the engine, and several engine rules came from failures it exposed
(word gaps inside cursive words: first run 99.67 % news/Amiri, 99.06 % Nastaliq, 99.01 % Amiri kerning; the W7 case
of Latin list items in an RTL page: 98.13 %; vertical cuts between blocks that are not side by side). 100 % here
means "no known regression on these producers", not "perfect on every PDF". Two early synthetic files were
unreadable by construction (Noto Naskh draws dots as separate glyphs shared by several letters, so ToUnicode alone
cannot describe them): the generator now wraps such words in `/ActualText` (as real producers must) or uses Amiri.

### Not done / limits (honest)
* Scanned PDFs are generated but not measured here (OCR belongs to the UI; no OCR accuracy numbers yet).
* No genuine Word/LibreOffice PDFs (see above); real-world producer quirks beyond the synthetic ones are untested.
* Tables are recognised only from aligned text (no ruling-line analysis); 3+ columns of short prose lines could be
  read as a table. Paragraph breaks between equally long lines with uniform spacing are not detected (text is
  still correct, only the paragraph grouping differs).
* Visual order is genuinely ambiguous in a few cases (an LTR paragraph `Price: السعر 50%`; a number between a Latin
  and an Arabic word in an RTL line); we return the standard reading (documented in `bidi.rs` tests).
* Vertical (`-V`) CJK layout is only approximated; Type3 glyph procedures are not interpreted.
* `warraq-core` does not register `text.extract` / `text.search` / `text.plain` yet (lead integration): a
  `methods/text.rs` needs `warraq_text::call(&DocSource::borrowed(doc.pdf().document()), method, params)` and an
  error mapping via `TextError::code()`.


## Digital signatures (`warraq-sign`, `sign.*` RPC)

`cargo test -p warraq-sign -p warraq-core`. Design: ADR 0008. External checkers are optional at
test time and skip when absent: the OpenSSL 3 CLI (test PKI, TSA, OCSP responder, `cms -verify`,
`ts -verify`) and pyHanko (`WARRAQ_PYTHON=/path/to/python` with `pip install pyhanko
pyhanko-certvalidator`). Test PKI: `tests/fixtures/sign/make_pki.sh` (committed output under
`tests/fixtures/sign/pki/`, test-only keys).

### Proven by tests
| What | Test |
| --- | --- |
| PKCS#12: modern PBES2/AES-256 + SHA-256 MAC; legacy `-legacy` (RC2-40 certs + 3DES key, SHA-1 MAC), 3DES-only, RC2-40-only; RSA-2048, P-256, P-384; Arabic password; wrong password → `wrong_certificate_password`; 300 mutated/truncated files never panic | `warraq-sign/tests/pkcs12.rs` |
| PAdES B-B as an incremental update (original bytes are a prefix), `/ByteRange` covers the whole file except `/Contents`, `ETSI.CAdES.detached`, second signature appends another revision; **`openssl cms -verify` accepts every produced CMS** (RSA, P-256, P-384, xref-stream file, AES-256 encrypted file, existing empty field) | `tests/sign.rs` |
| Encrypted documents: `/Reason` is ciphertext on disk, `/Contents` is the raw CMS, reopening decrypts the reason | `tests/sign.rs::encrypted_document_…` |
| Visible Arabic appearance: shaped by warraq-text/HarfRust (contextual forms differ from nominal glyphs; lam-alef), subsetted Type0 Identity-H Amiri with ToUnicode, per-word `/ActualText`; **warraq-text's extractor reads "أحمد بن سعيد" and "الرياض" back in logical order** | `tests/sign.rs::arabic_is_shaped_not_nominal`, `appearance_text_reads_back_in_logical_order` |
| Certification DocMDP P=1/2/3 (+ `/Perms`), FieldMDP All/Include/Exclude, field `/Lock` → FieldMDP; second certification and signing after P=1 refused; serverAuth-only and expired certificates cannot sign | `tests/sign.rs`, `tests/verify.rs` |
| B-T: TSA request → `openssl ts -reply` → `finish` embeds the token in place (file length unchanged); responses for other data and garbage are rejected | `tests/ltv.rs` |
| B-LT: OCSP request built by us answered by `openssl ocsp` (delegated responder), DSS with Certs/OCSPs/CRLs/VRI; verification reports `good (OCSP)`, level B-LT | `tests/ltv.rs` |
| B-LTA: `/DocTimeStamp` (`ETSI.RFC3161`) prepared + finished; verified by us and by **`openssl ts -verify`** | `tests/ltv.rs` |
| **pyHanko validates our signatures as intact/valid/trusted**: RSA, P-256 visible Arabic, P-384 certified P=2, two signatures (coverage, DocMDP ok), AES-256 encrypted, B-LTA (signature timestamp recognised) — and flags our three attack fixtures | `tests/pyhanko.rs` (ran here with pyHanko installed in a venv) |
| Verification: untrusted by default (`valid_identity_unknown`), `valid` with the test root, chain of 3, JSON shape; tampered byte → `digest_mismatch`; EKU policy (serverAuth-only → invalid, Adobe authentic documents + emailProtection accepted); expired signer → invalid | `tests/verify.rs` |
| Modification listing: annotations allowed for approval/P=3 (overlay reported), refused for P=1/2; form fill allowed for P=2, refused when the field is FieldMDP-locked; later signatures/DSS/doc timestamps allowed | `tests/verify.rs`, `tests/ltv.rs` |
| Attacks (each fixture passes a naive digest check): shadow **replace** (content stream redefined), shadow **hide via xref** (later xref re-points the page content at hidden signed bytes), **hide-and-replace** (page switched to hidden content), **borrowed signature** (other document embeds the signed file; byte range points into it), **signature wrapping** (SWA: second part moved, new xref/sig dict inside the gap) — all rejected with the right reason; committed fixtures in `tests/fixtures/sign/attacks/` | `tests/attacks.rs`, `tests/verify.rs` |
| RPC: `sign.list`, `sign.prepare` (B-B … B-LTA, certification, field lock, Arabic appearance), `sign.finish`, `sign.revocationRequests`, `sign.addDss`, `sign.verify` (trusted roots as blobs); error codes; full B-LTA flow through the RPC | `warraq-core/tests/sign_rpc.rs` |
| No panic / bounded time: 4 000+ mutated signed PDFs (ByteRange/Contents/startxref hot spots, attack fixtures as seeds) and 7 000 mutated CMS/CRL/cert/PKCS#12 blobs (run here with `WARRAQ_SMOKE_CASES=700`; default 150 in `verify.sh`) | `tests/smoke_fuzz.rs` |
| wasm32 build of warraq-core with `sign.*` compiles (`cargo check --target wasm32-unknown-unknown --features wasm`; no getrandom 0.2) | manual check |

### Not done / not proven (honest)
* **PKCS#11 untested**: only the `Signer` trait exists (digest-level signing maps to `CKM_RSA_PKCS`
  / `CKM_ECDSA`); no token implementation and no smart-card hardware here.
* **Real TSA / OCSP / CRL over the network untested**: the engine never does network I/O; all
  timestamp and revocation tests use a local OpenSSL TSA and responder. The desktop host still has
  to POST `application/timestamp-query` / `application/ocsp-request` and fetch CRLs; no UI is wired
  (`packages/ui`, `apps/desktop` are other agents' work). Real TSAs whose tokens exceed the 12 KiB
  reserve would need a bigger `placeholderSize`.
* **Adobe Acrobat is not available** to cross-check; independent checks are OpenSSL and pyHanko only.
* cargo-fuzz targets `cms` and `sig_dict` (`packages/core/fuzz`) compile (`cargo check`); they were
  **not run under libFuzzer** here (no nightly/cargo-fuzz; the stable SanitizerCoverage release build
  was abandoned to stay within the shared machine's disk budget). The stable smoke fuzz above runs
  instead, in every `cargo test`.
* Verification: RSA keys > 4096 bits, curves other than P-256/P-384, Ed25519 and `adbe.x509.rsa_sha1`
  are reported `unsupported`; signed attributes and TBS certificates are verified over their
  received bytes, but OCSP responses are verified over a DER re-encoding (fine for DER responders).
  Chain building does not process name constraints, policies or path-length limits; revocation of
  intermediates is reported only through warnings; no AIA fetching.
* Modification classification is object-level: a later update that re-writes an object with
  semantically equal content is invisible (correct), and "unused object" additions are reported as
  allowed. Changes to `/Outlines`, `/PageLabels` and similar catalog entries count as allowed for
  approval-only documents and disallowed under certification.
* Page rotation of visible signatures is compensated with the form `/Matrix` (tested for 90°).
* `rsa 0.9` has RUSTSEC-2023-0071 (Marvin); signing uses blinding, nothing is decrypted.
* The JSON password parameter is wiped only in our copy (the JS/serde strings are outside Rust's
  control); the key and decrypted PKCS#12 buffers are zeroized.

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
* Windows/Linux printing renders 300-dpi PNGs with warraq-render (unit-tested: US Letter → 2550×3300 px) and prints
  them from an image-only document (bridge unit-tested with jsdom); the print dialog itself is
  a native dialog and is not automated.

**Known limits:**
* No AppImage: it would bundle LGPL WebKitGTK/GTK (ADR 0002). Linux ships a `.deb` depending on system packages.
* The app is unsigned (no Apple team / Windows certificate): Gatekeeper and SmartScreen warn on first launch.
* Files opened in an earlier session leave the fs scope; saving them asks for a location again.
* The macOS Dock name is "ZOOD PDF" (no `ar.lproj` localisation of the bundle name yet); the window title switches
  to "زود PDF" with the UI locale.

## iOS / iPadOS app (`apps/ios`, native SwiftUI)

**Not compiled for iOS here.** This machine is Linux: no Xcode, no iOS SDK, no simulator. The app and
widget sources have never been built with the iOS SDK, so small compile errors in the SwiftUI layer are
possible; nothing about the UI is proven yet. What *was* compiled and tested here:

| Checked on Linux | How | Result |
| --- | --- | --- |
| `ZoodKit` package (engine wrapper + pure logic) compiled with Swift 6.3, Swift 6 language mode, `-strict-concurrency=complete -warnings-as-errors` | `bash scripts/ios/test-linux.sh` | builds clean |
| FFI bridge to the real engine (`libwarraq_core.a`, feature `ffi`, cargo profile `ios`) through `warraq.h`: open/info, garbage → `parse_error`, rotate as incremental update (original bytes kept), delete/insert/move/extract, bad params / unknown method errors, `doc.rebase` (unchanged + incremental), AES-256 protect → `password_required` → reopen with user/owner password → remove, `pdf.merge`, `methods.list`, metadata, `text.plain`, 16 documents in parallel; `warraq.h` copy equals the engine header | swift-testing, `ZoodEngineTests` | 13 tests pass |
| Arabic search normalisation (mirror of the web rules), page ranges with Arabic-Indic/Persian digits and «،», Umm al-Qura Hijri + Gregorian dates with locale numerals, safe file names (bidi-spoof removal), recents store (dedupe, cap, stars, tags, thumbnails, forget-thumbnail, path-escape), scan geometry (corner ordering, ID-1 real size, right-to-left book order), deep links, AI prompt/request body/SSE parsing | swift-testing, `ZoodCoreTests` | 30 tests pass |
| Every app/widget/test source parses (`swiftc -parse`, Swift 6) | `bash scripts/ios/parse-check.sh` | 29 files parse |
| String Catalogs: every key used in Swift exists in English and Arabic, Arabic plural forms (zero…other), no unused keys, App Shortcuts phrases in both languages | `python3 scripts/ios/check-strings.py` | 256 app keys, 13 widget keys, 7 phrases |
| `build.sh` / `build-core.sh` fail clearly on non-macOS; all iOS scripts pass `shellcheck` | run on Linux | as designed |

Total on Linux: **43 swift-testing tests** in 10 suites.

**Written, needs a Mac to run (owner action):** `scripts/ios/build-core.sh` (XCFramework, LTO off),
`xcodegen generate`, simulator build and tests (`Tests/ZoodPDFTests`: PDFKit ink → `doc.rebase`
incremental save, highlight annotations, invisible OCR text layer readable by PDFKit, ID-card A4 page,
Vision runtime language check, compress never grows a file, unique file names; `Tests/ZoodPDFUITests`:
Arabic and English tours Home → document → Pencil stroke → Save → Organize → Scan with screenshots into
`docs/design/ios/`). `docs/design/ios/` is empty until then.

**Implemented (🟡 until run on a simulator):** iPad `NavigationSplitView` (Home, Recents, Starred, Tags,
tools) and iPhone tabs; Home hero «ملفات PDF، من جديد», six action cards, Recents grid with PDFKit
thumbnails, Gregorian · Hijri dates, ⋯ menus, search; glass materials with Reduce Motion / Reduce
Transparency / Increase Contrast handled; document view (PDFKit, toolbar with "Page x of y · Edited",
thumbnails rail, prev/next, share, save, unsaved-changes prompt); floating Pencil palette (pen, marker,
highlighter, eraser, text highlight, 6 colours, width, undo) turning PencilKit strokes into PDF ink
annotations; Organize (rotate/reorder by drag/delete/insert blank or file/extract, page-range field);
Protect/remove (engine); Combine (new file) and drop-a-PDF → "Combine with this document / Open in New
Window"; Compress (new file); Convert (PNG/JPEG pages, text); AI assistant (bring-your-own Anthropic key in
the Keychain, exact text shown before Send, streaming, `claude-opus-5` default, model editable); Scan to
PDF (dark camera screen, mode strip Document · Whiteboard · ID Card · Book; VisionKit for Document; own
AVFoundation capture with live rectangle detection and draggable corners for the others; photo import);
widgets (Recents small/medium/large, Scan, Lock Screen circular/rectangular/inline, Control Center
"Scan to PDF"); App Intents + App Shortcuts (Open recent, Scan, Combine, Compress; phrases en + ar);
Core Spotlight indexing of recents with engine `text.plain`; multiple windows (`WindowGroup(for: URL.self)`),
drag & drop of PDFs between windows; Files app (open in place, app Documents folder visible).

**Limits / honest notes:**
* The OCR text layer is written by Core Text (invisible text mode) while the scan PDF is generated with
  `UIGraphicsPDFRenderer`; the engine has no OCR-layer method yet, so the per-word ActualText rule of the
  web OCR does not apply to iOS scans. Arabic OCR is used only if `supportedRecognitionLanguages()`
  reports Arabic at runtime; otherwise the scanner says so and recognises English only.
* Markup on a **password-protected** file cannot be saved incrementally (PDFKit re-writes the encryption):
  the user chooses "Keep Password" (AES-256 whole rewrite with the password they typed, original
  permissions) or "Save Without Password".
* Undo covers markup strokes and engine steps (whole-file snapshots, capped at 300 MB); no redo.
* Not on iOS yet (web/desktop only): Fill & sign, form preparation, redaction, digital signatures, page
  marks, Office export/import (iOS Convert makes pictures and text), compare, standards, accessibility
  tools, batch, library indexing, cloud drives. Local AI servers (Ollama/LM Studio on localhost) are not
  offered on iOS.
* Page labels inside PDFKit's own thumbnail rail use PDFKit's digits.
* No Apple team: simulator only. A device build needs `DEVELOPMENT_TEAM`, automatic signing and the App
  Group `group.sa.zood.pdf` registered for `sa.zood.pdf.ios` and `sa.zood.pdf.ios.widgets`.

**Owner actions:** install Xcode 26+ and Rust; `brew install xcodegen`; run `bash scripts/ios/build.sh`
(iPhone 17 + iPad Pro 13-inch (M4) simulators, time-boxed tests, screenshots into `docs/design/ios/`);
fix any SwiftUI compile errors it reports; for a device, set the Apple team as above.
