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
* ~~Form fields of pages copied with `pages.insertFrom`/`extract`/`merge` are not added to the target AcroForm~~
  (done: see "Organize, Combine, Compress"); outlines/named destinations pointing at deleted pages still become
  dangling (resolve to null).
* `doc.info.hasSignatures` is a heuristic (a `/FT /Sig` field with `/V`, or a `/Sig` dictionary with
  `/ByteRange`); verification belongs to warraq-sign.

## Create PDF (warraq-create, `create.fromFiles`)

Own layout engine (rustybuzz shaping, UAX #9 bidi, line breaking, kashida justification, tables,
lists, pagination) and a tagged PDF writer with subset TrueType fonts (Amiri, Cairo, Inter bundled).
Readers: DOCX, XLSX, PPTX, HTML (safe subset, `data:` images only), Markdown, TXT (UTF-8/16,
Windows-1256), CSV/TSV, JPEG, PNG, multi-page TIFF (G3/G4 passed through, LZW/Deflate/PackBits).
Fixtures: `python3 scripts/create-fixtures.py` → `tests/fixtures/create/` (each with `.truth.txt`).

### Proven by tests
| What | Test |
| --- | --- |
| Arabic/English text round-trips through warraq-text in logical order (incl. kashida-justified paragraphs, ActualText) | `warraq-create/tests/roundtrip.rs` |
| Every reader on generated fixtures: text back in logical order, table cells intact, headings/lists/tables/figures tagged, `/Alt` on pictures, slide size kept, TIFF polarity/colour checked by rendering with hayro | `warraq-create/tests/readers.rs` |
| Invariants: tagged (`StructTreeRoot`, `MarkInfo`, `Lang`), subset fonts only, never `/Direction`, lopdf reloads | `tests/common/mod.rs::assert_pdf_invariants` |
| No panic / bounded time on mutated whole files and mutated OOXML parts (600 cases default; 5000 checked); billion laughs, zip bomb, huge picture, absurd spans, deep nesting | `warraq-create/tests/no_panic.rs` (`WARRAQ_CREATE_SMOKE_CASES`); cargo-fuzz targets `create_*` |
| RPC `create.fromFiles` / `create.formats`, coded errors; wasm build creates a PDF from the DOCX fixture | `warraq-core/src/methods/create.rs` tests, `wasm-smoke.mjs` |
| UI: pick files, refuse unsupported ones, reorder, page numbers, new PDF opens unsaved and saves through the host (en + ar); a non-PDF dropped on an open document goes to Create, not Combine; Convert card offers Export and Create | `tests/e2e/create.spec.ts`, `tools/create/create.test.ts`, `App.test.tsx` |

### Not supported yet
DOCX headers/footers, footnotes, text boxes, floating positions; XLSX number formats/dates;
PPTX themes, backgrounds, shape fills, charts, SmartArt; EMF/WMF/GIF pictures; legacy .doc/.xls/.ppt.
The bundled fonts (packages/core/assets/fonts, 2.3 MB) are compiled into the wasm (9.7 MB total with all tools, without wasm-opt); warraq-sign uses the same Amiri.

## Interface (`packages/ui`, `apps/web`, `apps/extension`)

`pnpm -C packages/ui test` (vitest) and `pnpm e2e` (Playwright, Chromium, production build of `apps/web` on
port 4311; the extension spec loads `apps/extension/dist` unpacked). Architecture: ADR 0006.

### Proven by tests
| What | Test |
| --- | --- |
| Home renders in English (LTR, sidebar left) and Arabic (RTL, sidebar mirrored right, «ملفات PDF، من جديد», `زود PDF` title); zero requests leave localhost | `home.spec.ts` |
| Only ready tools are shown (sidebar = More sheet = the viewer-backed tools, the core tools and Create PDF); no "coming soon"; six working home cards | `home.spec.ts`, `registry.test.ts`, `App.test.tsx` |
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
| Scans (20 variants) | — | measured by the OCR benchmark (see "Scan & OCR") |

Caveat: the corpus was written together with the engine, and several engine rules came from failures it exposed
(word gaps inside cursive words: first run 99.67 % news/Amiri, 99.06 % Nastaliq, 99.01 % Amiri kerning; the W7 case
of Latin list items in an RTL page: 98.13 %; vertical cuts between blocks that are not side by side). 100 % here
means "no known regression on these producers", not "perfect on every PDF". Two early synthetic files were
unreadable by construction (Noto Naskh draws dots as separate glyphs shared by several letters, so ToUnicode alone
cannot describe them): the generator now wraps such words in `/ActualText` (as real producers must) or uses Amiri.

### Not done / limits (honest)
* Scanned PDFs are measured by the OCR benchmark (section "Scan & OCR"), not by this gate.
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
  timestamp and revocation tests use a local OpenSSL TSA and responder. The desktop host's HTTP
  commands (below) are tested against a local mock TSA only; no request to a public TSA was made
  here. Real TSAs whose tokens exceed the 12 KiB reserve would need a bigger `placeholderSize`.
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

### Interface (Digital signature tool, Signatures panel) and desktop network
Tool `digital-signature` is `ready` on web, desktop and extension (`tools/registry.ts`). Signing
panel `packages/ui/src/app/SignPanel.tsx`, verification `SignaturesPanel.tsx` (banner + panel),
engine orchestration `services/signing.ts`, formatting `services/signatures.ts`, trust list
`services/trust.ts`. New engine methods: `sign.inspect` (static: PKCS#12 + password → certificate
summary, EKU verdict, validity; no key material returned) and `sign.certInfo` (static: PEM/DER →
summaries + DER per certificate); `sign.prepare` takes an optional RGBA signature picture
(`appearance.image` + `blobs[1]`, image XObject with `/SMask`, left 40 % of the box).

| What | Test |
| --- | --- |
| **UI, en + ar**: import `signer-*.p12` through the file chooser, wrong password → "Wrong certificate password" / «كلمة سر الشهادة غير صحيحة», unlock, certificate summary (Arabic CN «أحمد بن سعيد», issuer), draw the box on the page preview, reason/location, hand-drawn picture, Sign → saved through the host bridge → the viewer reloads, banner "valid, identity unknown"; the saved file starts with the original bytes, has `/ETSI.CAdES.detached`, `/Subtype /Image`, `/ActualText`; **`sign.verify` run on the saved bytes in Node (wasm)** → `valid_identity_unknown`, `valid` with the test root; reopen → panel shows the signer, no changes after signing, Hijri time (`١٤٤٨`, Arabic digits); adding `root.pem` to the trust list turns it "valid"; no external request | `tests/e2e/sign.spec.ts` |
| **UI, en + ar**: approval signature → a highlight added with Comment and saved (incremental on top) → Node `sign.verify`: still `valid_identity_unknown`, not covering the whole file; reopened: `annotation_added` listed as allowed and an **overlay** warning; "View signed version" opens the covered revision, which verifies with no changes | `sign.spec.ts` |
| **UI, en + ar**: certification "form filling and signing" (DocMDP P=2) → page 1 rotated with **Organize** and saved → Node `sign.verify` says `modified`; reopened: banner "changed after signing", the page change listed as not allowed | `sign.spec.ts` |
| **UI, en + ar**: the `shadow-replace.pdf` attack fixture → banner invalid/modified, panel lists the shadow attack | `sign.spec.ts` |
| Web/extension: B-T/B-LT/B-LTA are not offered (hidden without a host network); the desktop host shows them | `sign.spec.ts`, `SignPanel` (`app.host.signing?.network`) |
| Signing flow with a fake engine + network: B-B uses no network; B-T = prepare → TSA → finish; B-LTA = TSA, OCSP with CRL fallback, DSS (`kinds`), document timestamp; only the chosen TSA and the certificate's own URLs are contacted | `packages/ui/src/services/signing.test.ts` |
| Certificate summary formatting: DN parsing with Arabic values, Gregorian and Hijri (Umm al-Qura) times with Arabic-Indic digits, appearance lines without bidi control characters, rectangle → PDF user space for /Rotate 0/90/180/270, overall status | `services/signatures.test.ts` |
| Trust list: empty by default, IndexedDB persistence, idempotent import, removal by fingerprint, unreadable entries skipped | `services/trust.test.ts` |
| `sign.inspect` (Arabic CN, serverAuth-only flagged, expired flagged, Arabic password, wrong password), `sign.certInfo` (PEM chain, DER), signature picture + wrong picture size | `warraq-core/tests/sign_rpc.rs` |
| Arabic-Indic digits are in the signature font (localised dates in the appearance) | `warraq-sign/tests/sign.rs::font_has_arabic_indic_digits_for_localised_dates` |
| **Desktop** `sign_timestamp` / `sign_ocsp` / `sign_fetch_crl` (ureq 3 + rustls/ring, OS trust store via rustls-platform-verifier, no webpki-roots): a **local mock TSA answering with `openssl ts -reply`** returns a token that `openssl ts -verify` accepts; http/https only, no user-info, no redirects (302 refused), non-200 and HTML answers refused, reply size cap (declared and streamed), timeout; CRL GET | `apps/desktop/src-tauri/src/net.rs` tests |
| **Desktop** trust list in `<app data>/trusted-certificates/<SHA-256>.der`: add/list/remove, names and bytes validated | `apps/desktop/src-tauri/src/trust.rs` tests, `host-tauri.test.ts` |

Not proven / limits:
* B-T/B-LT/B-LTA through the desktop **UI** are not exercised end to end (no desktop Playwright;
  the WebKitGTK smoke test only boots the app). The flow is unit-tested with fakes and the Rust
  HTTP commands against a local mock; no public TSA/OCSP responder was contacted.
* The page preview used to draw the box ignores a MediaBox/CropBox whose origin is not (0, 0).
* FieldMDP from the UI offers "lock all form fields" only (Include/Exclude lists are engine-only).
* Tampering is covered through Organize (rotate) and Comment (highlight); a text change made with
  the Edit tool (which landed after this work) is not yet exercised against a signature in a spec. Comment-after-certification (disallowed annotation) is proven
  in the engine (`warraq-sign/tests/verify.rs`), not through the UI.
* The password lives in a React state string until signing finishes or the panel closes; JS strings
  cannot be wiped.

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

## Export and Compare (`warraq-office`, Export sheet, Compare panel)

Architecture: ADR 0013. Engine methods: `export.docx|xlsx|pptx|html|markdown|text` (document), `export.zip`
(static), `export.png` (feature `render` only), `compare.text` (document + other PDF as blob),
`compare.visual` / `compare.report` (static).

### Proven by tests
| What | Test |
| --- | --- |
| Text export of 13 Arabic/Urdu/Persian corpus files (Chrome-made + synthetic Word/LibreOffice-style) equals the logical truth at ≥ 99.8 % (the acid floor) | `warraq-office/tests/export.rs::text_export_of_the_arabic_corpus_equals_the_logical_truth` |
| DOCX: required parts present and well-formed (quick-xml); every Arabic paragraph has `<w:bidi/>`, every run holding Arabic letters has `<w:rtl/>`; document.xml text ≥ 99 % of the truth; `w:lang w:bidi="ar-SA"`; title in core properties | `export.rs::docx_has_bidi_arabic_paragraphs_in_logical_order` (news/Amiri, mixed, synthetic Word, tashkeel) |
| XLSX of a generated ruled Arabic table: sheet `جدول 1`, RTL view, A1 = rightmost header, Western/Arabic-Indic numbers as numbers (`٣٥٠` → 350, `٧` → 7) | `export.rs::xlsx_of_a_generated_arabic_table_has_the_right_cells` |
| XLSX of the Chrome-made corpus table (borders drawn as 1-unit filled rectangles): 5 rows, `المنتج` in A1, D2 = 13500 | `export.rs::chrome_table_corpus_file_becomes_a_spreadsheet` |
| Row/column spans from missing rules → XLSX `mergeCell`, DOCX `gridSpan` | `export.rs::merged_cells_become_spans`, `table.rs` unit tests |
| DOCX/HTML/Markdown keep the table between the paragraphs before/after it; HTML `lang`/`dir`, `<th>` row, headings, no scripts | `export.rs::docx_and_html_keep_the_table_structure` |
| Prose (two columns, news, lists, English) is never taken for a table | `export.rs::two_column_prose_is_not_a_table` |
| PPTX: one slide per page, all parts well-formed, RTL paragraphs | `export.rs::pptx_has_one_slide_per_page_with_positioned_text` |
| Independent readers open our files: python-docx (paragraphs, table cell), openpyxl (RTL view, values), python-pptx (2 slides) | `export.rs::python_office_readers_open_our_files` (skips when not installed; ran here) |
| Page ranges and typed errors (`page_out_of_range`, `invalid_params`) | `export.rs::page_ranges_and_bad_params`, `warraq-core/tests/export_compare_methods.rs` |
| Compare: identical → no changes; one changed word (ثلاثين → عشرين) found with one rectangle on each document at the right place; insertions/deletions across pages; tashkeel ignored by default and detected on request | `warraq-office/tests/compare.rs` |
| Diff correctness (ops rebuild the target), Myers minimality, 50 000-word unrelated inputs stay bounded | `compare.rs` unit tests |
| Visual diff: changed region box, overlay PNG, size mismatch/garbage rejected | `compare.rs::visual_diff_finds_the_changed_region`, `tests/no_panic.rs` |
| HTML report: `lang`/`dir` from locale, `<del>`/`<ins>` with `dir`, Arabic-Indic counts, data-URI images, no scripts, no URLs | `compare.rs::html_report_contains_the_change_and_no_scripts`, `export_compare_methods.rs` |
| No panic on 600 mutated content streams through rules → tables → every writer; 3000 mutated ZIPs; random rasters | `warraq-office/tests/no_panic.rs` (`WARRAQ_SMOKE_CASES`) |
| RPC: all methods registered; exports leave the document unchanged; `export.zip` rejects paths/duplicates | `warraq-core/tests/export_compare_methods.rs` |
| **UI, en + ar**: Export sheet → Word of `sample-ar.pdf` → saved via the save picker → unzipped in the test: paragraphs in logical order (`هذا ملف اختبار صغير لتطبيق زود PDF، مكتوب باللغة العربية.`), all `w:bidi`, Heading1, page 2 after page 1; no network | `tests/e2e/export-compare.spec.ts` |
| **UI, en + ar**: Excel of the Arabic table fixture → cells A1 `المنتج`, A2 `حاسوب محمول`, D2 13500, localised sheet name | `export-compare.spec.ts` |
| **UI, en + ar**: Pictures with a page range typed in Arabic-Indic digits (`١-٢`); an out-of-range page disables Export; ZIP of two 144-dpi PNGs | `export-compare.spec.ts` |
| **UI, en + ar**: Compare `compare-v1.pdf` with `compare-v2.pdf` chosen through the file chooser → exactly one change `ثلاثين → عشرين`; clicking it shows both pages with one highlight each; the visual pass lists page 1 only; the saved HTML report contains the change, the overlay image and no script | `export-compare.spec.ts` |
| **UI**: Convert card → file chooser → Export sheet → text export | `export-compare.spec.ts`, `App.test.tsx` |
| Page-range parser (Arabic-Indic/Persian digits, `،`, en dash), file names, engine call shapes, panel store | `exporter.test.ts`, `comparer.test.ts`, `panels.test.ts` |

### Not done / limits (honest)
* **Fidelity**: exports are structured documents, not layout copies. Fonts, colours, images (DOCX "images
  optional": not done), lists, columns, footnotes and links are not reproduced; PPTX places one text box per
  paragraph/cell at its PDF position with a substitute font (slack added), so text may reflow. Headings come from
  font size only; italic from font names/descriptors only (synthetic slant is not detected).
* **Tables**: ruled grids need both horizontal and vertical rules (booktabs-style tables with only horizontal rules
  fall back to alignment detection); alignment tables need ≥ 3 rows with the same column count, so tables with
  empty cells in the text-only style may be missed; tables spanning pages are two tables; nested tables are
  flattened; rotated pages (`/Rotate`) are not handled for rules.
* **Compare**: word-level only (no character-level highlight inside a word, no moved-block detection); a change
  adjacent to a deletion on another page is reported as one change spanning both pages; the visual pass covers the
  first 30 pages at 480 px width and compares pages by index (an inserted page makes later pages differ); both
  files must open without a password (a protected revised file fails with an error toast).
* **PNG export** uses PDFium in the viewer; the engine's `export.png` (hayro) is only compiled with the `render`
  feature and has no test of its own here (the existing `pages.render` test covers the renderer).
* The fuzz targets `ruling_tables` and `zip_read` (`packages/core/fuzz`) compile; they were not run under
  cargo-fuzz here (no nightly). The stable smoke test above runs in `verify.sh`.
* python-docx/openpyxl/python-pptx are not part of CI images; the reader test skips without them.
* Desktop and extension hosts use the same UI and engine code but have no Export/Compare spec of their own.

## Scan & OCR (`packages/ui/src/ocr`, `warraq-core/src/ocr`, ADR 0016)

tesseract.js 7 (LSTM-only cores) with tessdata 4.1.0 "best-int" models for `ara`, `eng`, `fas`, `urd`, all served
from the app's origin (`ocr/`); models fetched by `scripts/fetch-ocr-models.sh` (pinned SHA-256, git-ignored cache,
not committed: 28 MB). Own preprocessing in a worker; the engine writes the invisible text layer.

### Proven by tests
| What | Test |
| --- | --- |
| Preprocessing on synthetic images: known rotations recovered within 0.3° (±15°), shadow gradient flattened, Sauvola, despeckle bounds, homography/warp, header-only size checks (64 MP / 16 000 px) | `ocr/preprocess.test.ts` |
| Language codes, tesseract word tree → words with lines | `ocr/recognizer.test.ts` |
| `ocr.addTextLayer`: invisible `3 Tr` text, `Tz` to the word box, words read back in logical order (Arabic, tashkeel, digits in RTL words), existing text kept, one incremental update (original bytes a prefix), several pages in one commit, low-confidence words skipped, `/Direction` never written, rotated matrix on a crooked page, `/Rotate` pages, hostile params rejected | `warraq-core/tests/ocr.rs` |
| RTL words: visual order in `/ReversedChars`, no ActualText (PDFium-searchable); a space glyph after each word keeps tightly set Arabic words apart | `ocr.rs::rtl_words_…`, `tightly_set_words_stay_separate` |
| `ocr.createPdf`: pages from JPEG (DCT passthrough) and 1-bit/gray images with a text layer; hostile/truncated images rejected | `ocr.rs` |
| **Make searchable (e2e, ar)**: scanned Arabic PDF → Scan & OCR (Arabic by default, Arabic-Indic numerals, «صفحة واحدة بلا نص») → progress → **viewer Ctrl+F finds «الحكومية»** → Save: original bytes a prefix, 2 revisions, no `/Direction`; engine `text.plain` of the saved bytes contains the words; reopened, viewer search finds «التحول»; zero non-localhost requests, zero CSP errors | `ocr.spec.ts` |
| **Scan pages (e2e)**: crooked 8° photo → skew **detected 8.x°** (within 0.5°) → cleaned preview → Create PDF opens in the viewer → Save: 1 page, image + `/Lang (ar)`, Arabic text read back | `ocr.spec.ts` |
| Cancel stops recognition, document unchanged; a 30 000 × 30 000 PNG header is refused before decoding | `ocr.spec.ts` |
| **MV3 extension**: the same scan works under the extension CSP (worker from its file, no `blob:` worker, no `unsafe-eval`) | `ocr.spec.ts` |

### Measured accuracy (2026-09-26, headless Chromium, the real UI path)
Character accuracy = 1 − Levenshtein / truth length, after NFC, bidi controls and tatweel removed and whitespace
collapsed; first number with tashkeel removed from both sides, in brackets with tashkeel kept. `pnpm ocr:bench`
("Make searchable" + Save + engine `text.plain`), floors in `tests/ocr/baseline.json` (tolerance 2 points),
raw results in `tests/ocr/results.json`. E2E pages: `scan-ar` (straight, title + first paragraph) **97.3 %**,
`crooked8-ar` (Scan pages from a crooked JPEG) **71.3 %**.

| Page (300 dpi, image-only PDF) | Languages | Straight | Crooked 5° | Crooked 8° | Shadowed |
| --- | --- | --- | --- | --- | --- |
| Arabic news (Amiri) | ar | 89.0 % (88.5 %) | 75.2 % (75.0 %) | 87.3 % (86.8 %) | 96.1 % (95.6 %) |
| Arabic, full tashkeel (Amiri) | ar | 50.2 % (35.2 %) | 41.5 % (29.8 %) | 53.1 % (39.1 %) | 38.2 % (23.3 %) |
| Urdu Nastaliq | ur | 83.0 % (83.0 %) | 83.0 % (83.0 %) | 80.5 % (80.5 %) | 83.0 % (83.0 %) |
| Persian (Vazirmatn) | fa | 96.1 % (96.1 %) | 96.1 % (96.1 %) | 96.1 % (96.1 %) | 96.5 % (96.5 %) |
| Mixed Arabic/English (Naskh) | ar+en | 89.0 % (88.7 %) | 90.9 % (90.6 %) | 91.3 % (91.0 %) | 88.8 % (88.5 %) |

About 4–8 s per page on this 4-core container.

### Not done / limits (honest)
* **Tashkeel**: the Arabic model drops most diacritics (35 % with tashkeel kept on the fully vocalised page, ~50 %
  without); Quranic/vocalised text is not usable as OCR output.
* **Accuracy is uneven across variants** of the same page (Arabic news: 75 % crooked 5° vs 96 % shadowed): errors
  are mostly line merges and alef-maqsura/yaa confusions from the model, not investigated further; the Scan tab's
  binarisation costs accuracy on clean photos (crooked8-ar 71 %).
* Urdu Nastaliq tops out around 83 % (tessdata `urd` is trained on Naskh-like fonts).
* **Desktop**: the web UI runs in Tauri (same CSP allowances) but no desktop spec runs OCR; the camera uses
  `getUserMedia` (web) — no native camera bridge, the file picker is the desktop path.
* The first OCR needs the core and the chosen model from the app's origin (Arabic ~2.5 MB, English 23 MB); the
  service worker caches them on first use, not at install.
* PDFium in the viewer reads the RTL words through `/ReversedChars`; readers that ignore that marker see visual
  order (same as Chrome's own Arabic PDFs).

## Organize, Combine, Compress

Engine: `warraq-pdf` (`outline.rs`, `import.rs`, compact writer in `writer.rs`) and `warraq-core`
(`methods/organize.rs`, `ops/{image,geometry,compress}.rs`). UI: `packages/ui/src/{organize,combine,compress}`,
`services/{coreOps,history,ranges,zip}.ts`, panels via `tools/panels.ts`. Undo model and Compress-as-new-file: ADR 0007.

### Proven by tests
| What | Test |
| --- | --- |
| Outline read with every destination form (explicit, `/Dests` name, name tree, `GoTo` action, `/D` dict); cycles/depth bounded; pypdf reads the outlines we write (Arabic titles) | `warraq-pdf/tests/import.rs` |
| Merge: one top-level bookmark per file with the file's own bookmarks nested and remapped; form fields merged, clashing names renamed (`name` → `name_2`, pypdf agrees); page labels kept per file (pypdf: `i ii iii i ii 1`) | `import.rs::merge_nests_each_files_outline_renames_fields_and_keeps_labels` |
| Extract keeps only the bookmarks of extracted pages; incremental insert appends a bookmark entry + fields, original bytes a prefix | `import.rs` |
| Compact rewrite: object streams + xref stream (PDF 1.5), smaller than the table form, readable by us and pypdf, incremental update on top works; AES-256 protection kept (pypdf decrypts) | `warraq-pdf/tests/compact.rs` |
| `pages.insertImage`: JPEG embedded byte-for-byte (DCTDecode passthrough), PNG → Flate + `/SMask` from alpha, page size of the neighbour, picture centred and fitted; hostile/truncated pictures are errors (no panic); 100 MP / 64 k side bounds | `warraq-core/tests/organize.rs`, `ops/image.rs` tests |
| `pages.trimMargins`: CropBox = text (font metrics) ∪ paths (white fills ignored) ∪ images, + margin; `dryRun`; blank page → `nothing_to_trim` | `organize.rs::trim_margins_…`, `ops/geometry.rs` tests |
| `pages.replace` (one update), `pages.combine` (files at a position, one bookmark each), `pages.split` (every N, ranges, top-level bookmarks incl. leading pages; each part keeps its bookmark), `pages.boxes`, `doc.outline`, `pdf.merge` titles | `warraq-core/tests/organize.rs` |
| `doc.compress`: placement-based downsampling (CTM at `Do`; 480 dpi → 150 dpi), JPEG re-encode (jpeg-encoder) / Flate for lossless in "high", masks/`/Decode`/special colour spaces/corrupt pictures skipped and reported, uncompressed streams Flate-compressed, duplicate streams/fonts stored once, thumbnails + PieceInfo dropped in "smallest"; presets ordered (smallest < balanced < high < original); **hayro raster of the output vs the original: mean pixel difference < 1.5/255 (balanced), < 3/255 (smallest)**; open document unchanged; protection kept | `organize.rs::compress_*` |
| No panic / bounded time: 600 mutated documents (bookmarks, pictures) through boxes, trim, split, combine, replace, merge, compress | `warraq-core/tests/organize_smoke.rs` |
| Page ranges incl. Arabic-Indic/Persian digits and «،» (`١-٣، ٥`), open ranges, errors with reasons, bounds | `ranges.test.ts` |
| Store-only ZIP writer: CRC-32, UTF-8 names (bit 11), DOS date/time, unique/safe names, ZIP64 refused | `zip.test.ts` |
| Undo/redo history of byte versions: order, redo cleared by new edits, out-of-sync refusal, count/byte bounds | `history.test.ts` |
| Selection (click/shift/meta), RTL-mirrored keyboard focus, drop slot → `pages.move` target, crop margins ↔ CropBox for /Rotate 0/90/180/270, drawn rectangle → margins, drop-overlay halves mirrored in RTL | `organize/logic.test.ts` |
| Organize/Combine/Compress are ready core tools (sidebar, More sheet, tool gallery, ⌘K) and open through the tool bus | `registry.test.ts`, `App.test.tsx`, `home.spec.ts` |
| **Organize (e2e, en)**: rotate from the organize menu, drag page 6 before page 1, delete from the right-click menu, Add Page (neighbour size), Alt+→ moves the selection, undo + redo; saved via the save picker: original bytes are a prefix, 6 revisions, page order by page sizes, `/Rotate 90` on the right page; reopened | `organize.spec.ts` |
| **Organize (e2e, ar)**: RTL grid (page 1 on the right), Arabic labels and plurals; insert a PDF from the ⋯ menu, insert JPEG + PNG pictures, replace page 1, crop by margins (CropBox `[40 0 420 550]`), trim margins; saved bytes: prefix, 10 pages in the expected order, JPEG bytes present verbatim | `organize.spec.ts` |
| **Extract / Split (e2e)**: shift-click multi-select → Extract saves `organize-6 (pages 2-3).pdf` (document untouched); split by «١-٢، ٥» (reversed range rejected with a message) and by bookmarks → ZIP with named parts, each part's pages and bookmark checked | `organize.spec.ts` |
| **Crop by drawing** a rectangle on the page preview → CropBox within 6 pt of the drawn area | `organize.spec.ts` |
| **Phone width (390 px)**: organize grid fits (no horizontal overflow, ≥ 2 pages per row), ⋯ menu stays on screen, rotate from it | `organize.spec.ts` |
| **Combine (e2e)**: from Home pick two files, reorder with the button alternative, combine → new unsaved “Combined.pdf” (8 pages); saved: page order and outline (one entry per file, the file's chapters nested with page indices) | `combine.spec.ts` |
| **Drop on an open document (e2e, ar)**: split overlay; dropping on «دمج مع organize-6.pdf» (start half, right in RTL) appends as an incremental update (prefix, 8 pages, `sample-ar.pdf` bookmark at page 7); the other half («Open instead») opens the file as its own document | `combine.spec.ts` |
| **Combine at a position (e2e)**: from the document tool picker, insert after page 2 | `combine.spec.ts` |
| **Compress (e2e, en/ar)**: before/after sizes (`452.9 KB`, `٤٥٢٫٩ ك.ب`), “% smaller”, pictures recompressed; Save Compressed Copy → `photo-heavy (compressed).pdf` < ¼ of the original, 1 page, object streams; the open document is not edited; Open Compressed Copy opens an unsaved new document | `compress.spec.ts` |

### Not done / not proven
* **Desktop / extension**: the same UI runs there, but no spec exercises these tools in Tauri or in the MV3 page;
  the desktop drop path (`onHostDrop` with a point but no HTML5 drag preview) shows the two halves as a choice
  sheet — covered by code, not by a desktop test.
* **Long-press** on touch screens opens the page menu (pointer timer) — not exercised by Playwright (no touch
  emulation in the spec); right-click, ⋯ and Shift+F10 are.
* **Trim margins** ignores clipping paths and shadings, and form XObject `/BBox` clipping; text boxes use font
  ascent/descent (may leave a few points of space).
* **Compress** does not re-encode CMYK/Indexed/Separation/Lab pictures, images with masks or `/Decode`, JPX,
  JBIG2 or CCITT (reported as "left as they are"); fonts are not subset (only exact duplicates are shared).
  Placement is measured on page content only (pictures used only in annotation appearances keep their resolution).
* **Page labels** are merged only when pages are appended at the end (Combine from Home, append on drop); inserting
  in the middle leaves the target's labels unchanged.
* **Encrypted sources** for Insert from file / Combine need their password: the UI does not ask yet
  (`password_required` is shown as an error).
* Thumbnails in the grid are rendered by PDFium through the viewer; very large documents render them lazily.
* Organize/Compress add ~0.6 MB to the wasm (warraq-text interpreter + JPEG/PNG codecs); the merged engine with
  signing and Office export is ~5.1 MB unoptimised.

## Edit tool (`warraq-edit`, `edit.*` RPC, Edit surface)

Architecture: ADR 0014. Engine methods: `edit.textBlocks|replaceText|addText`, `edit.images|imageTransform|
imageCrop|imageReplace|imageDelete|imageAdd`, `edit.links|linkAdd|linkUpdate|linkDelete` (document) and
`edit.checkUrl` (static). Mutating calls commit one incremental update; a failed call leaves the document as it was.

### Proven by tests
| What | Test |
| --- | --- |
| Byte-faithful lexer: operations + gaps partition every page of every corpus/fixture PDF and re-emit it byte for byte; splices change only the edited operators; hostile nesting/unterminated/inline-image input bounded | `warraq-edit/tests/edit.rs::lexer_round_trips_every_corpus_page_byte_for_byte`, `content.rs` unit tests, `tests/no_panic.rs` |
| Edit an Arabic paragraph of a Chrome-made Amiri page: new text (with shadda/tashkeel, Arabic-Indic digits, ٪) read back by `text.plain` in logical order, old text gone, neighbouring paragraph intact, every untouched operator byte-identical and in order, Amiri subset embedded (`+Amiri-…`, FontFile2), ActualText present, no `/Direction`, no fill+stroke double draw, original bytes an exact prefix | `edit.rs::edit_arabic_paragraph_reflows_reads_back_and_keeps_other_bytes` |
| Full-tashkeel paragraph replaced and read back with its marks; the page's own font is reused (no new font program) when it covers the new text (Chrome's Inter subset) | `edit.rs::tashkeel_…`, `original_embedded_font_is_reused_when_it_covers_the_new_text` |
| `/Artifact` text (synthetic Word footers) is extracted but never offered as an editable block | `edit.rs::artifacts_are_not_editable_blocks` |
| Add text boxes (Arabic in Cairo, Latin in Inter, colour), which are editable blocks afterwards | `edit.rs::add_text_box_arabic_and_english` |
| Pictures: list (XObject + inline), move (the `cm` before the `Do` rewritten in place, everything else identical), resize into a box, rotate 90° and free, crop (clip in unit space, kept by later moves), replace with PNG (alpha → SMask), delete inline image, add picture; reopened | `edit.rs::pictures_list_move_resize_rotate_crop_replace_delete_add` |
| Links: add/list/update (to a page)/delete; RLO, `javascript:` refused; Punycode mixed-script host refused unless the decoded host is typed; saved and reopened | `edit.rs::links_add_list_update_delete_and_spoof_refusal`, `url.rs` unit tests (bidi controls raw and percent-encoded, IDN decoding incl. Arabic IDN, whole-script Cyrillic look-alike, `user@host`) |
| RPC: all methods registered; stale block → `stale`; refused URL → `url_refused` and the document unchanged (`unsavedChanges: false`); edits on an AES-256 file with an Arabic password stay encrypted and read back | `warraq-core/tests/edit_methods.rs`, `edit.rs::rpc_surface_and_errors` |
| No panic on 400 mutated pages through blocks/replace/pictures/links/commit, 3000 random URLs, JPEG/PNG garbage | `warraq-edit/tests/no_panic.rs` (`WARRAQ_SMOKE_CASES`) |
| Page ↔ view coordinates at 0/90/180/270°, scheme allow-list, Arabic/Persian digits in page numbers | `packages/ui/src/services/editor.test.ts` |
| **UI, en + ar**: Home "Edit" card → file chooser → Edit surface; edit the Arabic sentence of a Chrome-made page in a `dir=auto` text area (new text with tashkeel), add a text box, nudge (arrow keys) and drag a picture then delete it, add a link (RLO address refused, Punycode look-alike host shown decoded and refused until typed), open it only through the confirm sheet (host + full address), undo/redo by toolbar and ⌘/Ctrl+Z / ⇧⌘/Ctrl+Shift+Z, click the link in the viewer → confirm sheet (no popup), save: original bytes are an exact prefix, the engine (wasm in Node) reads the new sentence, the added text, no picture, one link, no `/Direction`; the saved file reopens with the new sentence as an editable block; no network | `tests/e2e/edit.spec.ts` |

### Not done / limits (honest)
* **Reusing the original font** works only when the page's embedded font program already has every glyph (and,
  for Arabic, its GSUB table): Chrome's Latin subsets often qualify, Chrome/Word Arabic subsets never do, so
  edited Arabic is set in a bundled Amiri/Cairo subset (visually close for Amiri/Cairo/Naskh-like pages, different
  for other typefaces). Adding glyphs to an existing subset is not attempted. Type3 and simple (non-Type0) fonts
  are never reused.
* **Blocks** are warraq-text paragraphs: a paragraph that shares a text-showing operator with another one
  (e.g. one `TJ` drawing two columns) is listed as not editable (`shared_operators`); invisible OCR text is not
  editable (`hidden`); text inside form XObjects (stamps, page marks, some producers' whole pages) is not
  listed. Justified text comes back start-aligned; the new text keeps size, colour and weight but not italics,
  letter spacing or underline; overflow grows the box downwards. Tagged PDFs keep their structure tree, but the
  new text is untagged content (the Accessibility tool re-tags).
* **Pictures** inside form XObjects are not listed; free rotation + non-uniform resize of a rotated picture
  scales its bounding box (can shear); replace keeps the visible box but drops rotation and crop; only JPEG and
  PNG (no CMYK PNG, no 16-bit alpha precision) are accepted.
* **Links**: only URI and GoTo actions are listed/edited (Launch, JavaScript, GoToR links are left alone and not
  listed); link borders/highlight modes are not edited; the confirm sheet opens http/https/mailto only.
  EmbedPDF's bookmark panel still opens bookmark URIs directly (it bypasses the annotation navigate event).
* **Undo/redo** is the shared core-edit history (also used by Organize): 40 steps / 400 MB per open document,
  session only, cleared on save; EmbedPDF's own history starts empty after each engine edit (the viewer reloads).
* The font programs are shared with Create PDF (`warraq_create::fonts`), so Edit adds only its code to the wasm.
* cargo-fuzz targets `content_rewrite`, `url_check`, `picture_decode` compile on stable; not run under cargo-fuzz
  here (no nightly). The stable smoke fuzz (`warraq-edit/tests/no_panic.rs`) runs in `verify.sh`.
* Desktop and extension use the same UI and engine but have no Edit spec of their own; iOS has no Edit tool.
