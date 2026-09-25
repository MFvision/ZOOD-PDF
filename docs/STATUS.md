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

## Organize, Combine, Compress

Engine: `warraq-pdf` (`outline.rs`, `import.rs`, compact writer in `writer.rs`) and `warraq-core`
(`methods/organize.rs`, `ops/{image,geometry,compress}.rs`). UI: `packages/ui/src/{organize,combine,compress}`,
`services/{coreOps,history,ranges,zip,toolBus}.ts`. Undo model and Compress-as-new-file: ADR 0007.

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
* wasm grows from ~1.3 MB to ~1.9 MB (unoptimised; warraq-text interpreter + JPEG/PNG codecs).

