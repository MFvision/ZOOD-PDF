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
