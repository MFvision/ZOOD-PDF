# ADR 0005 — Arabic text extraction, search and shaping (`warraq-text`)

* Status: accepted
* Date: 2026-09-25

## Context
PDFs store glyphs, not text, and for Arabic they store them in *visual* order, often as contextual glyphs, split
into skeletons and dots (Noto), stacked in kerned ligatures (Amiri lam-alef, kaf-taa) or cascading diagonally
(Nastaliq). Producers disagree: Chrome/Skia draws runs visually left-to-right inside `/ReversedChars` with
`/ActualText` for clusters; Word-style writers draw one TJ run per word with `/ActualText`; older writers map glyphs
to presentation forms (U+FB50–FEFF) and draw them in logical order. Bold text is sometimes drawn twice (fill then
stroke), OCR layers are invisible (`Tr 3`), headers are `/Artifact`. The engine must return **logical-order** text
that matches what a reader sees, search it Arabic-aware, and write Arabic that reads back correctly.

## Decision
1. **Own content interpreter** (`interp.rs`) on a small, bounded lexer; the object layer is reached only through the
   `ContentSource` trait (page count, content bytes, resources, object lookup) so `warraq-pdf`'s decrypted document
   can back it. Until integration, `LopdfSource` implements it on `lopdf` 0.45 (default features off).
2. **Fonts** keyed by object id (`FontKey`), never by pointer. Text comes from, in order: `/ActualText` (always
   preferred), ToUnicode (bfchar/bfrange incl. array form and multi-codepoint), simple-font encodings +
   `/Differences` glyph names (AGL subset incl. `uniXXXX`, `afii57xxx`, `lam-ar.init`, `lam_alef-ar`), `Uni*-UCS2`
   CMaps, and finally the embedded font's own cmap (Identity CID fonts without ToUnicode).
3. **Units, not characters**: every glyph (or ActualText span) is a unit carrying its own logical text; marks are
   attached to the base they sit on. Fill+stroke duplicates (same text, same place ±0.15 em) are dropped.
4. **Layout**: recursive XY-cut (vertical gutters must span the region and the two sides must sit side by side;
   RTL regions read right-to-left; 3+ aligned short columns are read as a table row by row), lines from
   content-order chains merged by baseline/box overlap, words from content-order chains of touching units.
   **Nastaliq rule**: inside a word the glyph-stream order is kept even when x is non-monotonic (stacked, kerned or
   cascading glyphs); only words are ordered by x. When a line has space glyphs, only spaces (or gaps > 0.8 em)
   separate words, because cursive attachment leaves gaps inside words.
5. **Bidi**: visual → logical by running `unicode-bidi` on one proxy character per unit and applying L2 (the
   classic involution) with the **W5 fix**: European digit runs whose logical predecessor (the strong character on
   their *right* in a right-to-left context) is an Arabic letter are treated as AN, so W5 cannot glue `%`, `$`, `+`,
   `٪` to them and W4 cannot join `-`/`/` separators; digit runs whose logical predecessor is R or the paragraph
   start stay one number block with their terminators, protected from W2/W7 by the letter that is only *visually*
   before them. Without it `…بنسبة 50%` at a line end comes back as `%50`, `2024-06-01` as `01-06-2024`, and a
   Latin list item `1. Install` in an RTL page as `Install .1`. A digit run between Latin (left) and Arabic
   (right) is genuinely ambiguous (`نسخة Windows 10` vs `حوالي 10 USD`) and keeps the standard reading. Paragraph direction per line: majority of strong
   characters (first strong on ties), the block's direction when mixed (35–65 %); a minority-script line flush
   with the page's start edge and ragged at the end takes the page direction (Latin list items in RTL pages).
6. **Presentation forms** are mapped back with NFKC *only for those characters* (lam-alef ligatures expand to
   ل + ا in logical order); nothing else is NFKC-normalised during extraction.
7. **Search normalisation** drops tashkeel/tatweel/invisible format characters, unifies alef forms, ة→ه, ى→ي,
   ی→ي, ک→ك, Arabic-Indic/Persian digits → ASCII, lower-cases, applies NFKC only when it changes a character, and
   keeps an offset map so hits map back to glyph rectangles.
8. **Writing**: `shape()` uses `harfrust` (MIT) per bidi run and returns glyphs in visual order with clusters;
   `actual_text_spans()` groups them per logical word for `/Span <</ActualText …>> BDC … EMC`. We never write
   `/Direction /R2L` (PDFium would read lines backwards).
9. **Acid gate**: `tests/acid` compares every non-scanned corpus PDF with its truth (normalised character accuracy)
   against per-file baselines; any drop fails `verify.sh`.

## Consequences
* Extraction quality is measured, not assumed (see `docs/STATUS.md`); regressions fail CI.
* Visual order is sometimes genuinely ambiguous (e.g. an LTR paragraph `Price: السعر 50%` and `Price: 50 السعر%`
  render identically); we pick the reading documented in `bidi.rs` tests.
* Tables are only recognised from aligned text (no ruling-line analysis yet); prose with 3+ columns of short lines
  could be mistaken for a table.
* The crate does not decrypt by itself: encrypted files open through lopdf's handler in `LopdfSource` today and
  through `warraq-pdf` after integration.
