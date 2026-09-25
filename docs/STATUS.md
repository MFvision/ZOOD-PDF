# Status

Honest, current state. Updated by every change. "Proven" means covered by an automated test that runs in `scripts/verify.sh`.

## Summary
Scaffolding in progress.

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
  They open today through lopdf's decryption inside `LopdfSource` (so they are measured, not pending); the lead
  swaps in `warraq-pdf`'s handler at integration.
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
* `warraq-core` RPC registration and the switch from lopdf to `warraq-pdf` (decryption, object layer) are left to
  the lead.
