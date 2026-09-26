# ADR 0020 — Arabic text that reads back in every reader: glyph encoding + engine-backed viewer text

* Status: accepted
* Date: 2026-09-26
* Reconciles: ADR 0005 §8 (writing with per-word `/ActualText`), ADR 0016 §4 (OCR layer without ActualText)

## Context
SPEC §1 asks that Arabic written into PDFs "reads back correctly (ActualText per word)"; ADR 0005 made every
writer (Edit, Create PDF, the signature appearance, redaction overlays) wrap each word in
`/Span <</ActualText …>> BDC`. The OCR work (ADR 0016) then measured that the viewer's PDFium reverses
Arabic ActualText and wrote its text layer without it. We measured all writers the same way — the exact
`pdfium.wasm` EmbedPDF 2.15.1 ships, driven in Node through `FPDFText_*` (`tests/e2e/pdfium.ts`), on real
outputs (Edit, Create PDF from `report.docx`, a Markdown file, signature appearances):

| Encoding of an RTL word | PDFium text / search | our engine | spec readers (Acrobat) |
| --- | --- | --- | --- |
| logical `/ActualText` (what we wrote) | **reversed** (`ابحرم`), 0 hits | ✔ | ✔ |
| `/ActualText` inside `/ReversedChars` | reversed (PDFium ignores the marker) | ✔ | ✔ |
| visual (reversed) `/ActualText` | ✔ | ✘ reversed | ✘ reversed |
| no ActualText, ToUnicode per glyph in visual order | ✔ except ligatures: `لا`→`ال`, `الله`→`هللا` | ✔ | ✔ |
| … + multi-character glyphs mapped to the **presentation-form ligature** | **✔** | ✔ | ✔ |

Why: PDFium's text page collects a line's characters in content order and reverses every right-to-left run,
*including the characters of `/ActualText`* (there is no escape: a `CharCodeFromUnicode` check that could
skip ActualText never triggers for CID fonts — measured). Presentation forms are decomposed *after* the
reversal (464 of the 465 Arabic ligature forms decompose exactly as NFKC; U+FBDD is the exception), so a
lam-alef glyph mapped to U+FEFB comes out `لا`. The same measurement also showed what no encoding fixes in
PDFium: zero-width tashkeel glyphs are placed geometrically (PDFium inserts spaces and moves marks to other
letters — Chrome's own PDFs included), a percent sign after digits comes out before them (`%35`, no W5 rule),
and Chrome-made PDFs lose lam-alef (`األول`) because Chrome writes ActualText per cluster.

## Decision
1. **One encoder for every writer: `warraq_text::encode`** (`encode_line`, `ToUnicodeMaps`, `tounicode_cmap`,
   `shape::content_stream_encoded`). Per word:
   * right-to-left words are written **without `/ActualText`**; each glyph's ToUnicode entry carries the
     characters it draws so that the visual glyph sequence, read right to left, is the logical word
     (cluster of `k` glyphs and `n` characters: glyph `i` from the left stands for character `n-1-i`; with
     `k < n` the right-most glyph stands for the logical prefix, written as the presentation-form ligature
     whose NFKC is exactly that prefix). This is also the Chrome / classic-writer convention, so pdf.js,
     Acrobat and Poppler read it, and our extractor reads it (visual → logical bidi, NFKC on presentation
     forms only — ADR 0005 §6);
   * **`/ActualText` stays** (ADR 0005 unchanged) for left-to-right words, words with tashkeel (PDFium is
     wrong for marks whatever the encoding; ActualText keeps them exact for our engine and spec readers),
     kashida-stretched words (Create PDF), words drawn with a page's own font (Edit reusing the original
     font: its ToUnicode is not ours), glyphs that already stand for other text in the same font, clusters
     with more glyphs than characters, ligatures without a presentation form, and words mixing directions.
   ToUnicode is per glyph and per font; the encoder claims a glyph's text atomically per word and falls back
   to ActualText on any conflict, so a glyph never says two different things.
   Edit (`warraq-edit`), Create PDF (`warraq-create`), the visible signature (`warraq-sign`) and redaction
   overlays (`warraq-redact`, which now also writes a ToUnicode map) use it; Page marks and Forms must too.
   The OCR layer (ADR 0016) already writes the same convention (visual order, no RTL ActualText).
2. **Extractor**: a line without space glyphs keeps Arabic glyphs drawn by the *same* text-showing operator
   in one word up to a 0.25 em gap (Cairo kerns ~0.12 em after a non-joining `ر`; word-per-operator producers
   such as Word still split at 0.12 em). The acid gate is unchanged.
3. **Viewer: Arabic-aware search and logical-order copy inside the EmbedPDF view** (SPEC §3), for every PDF
   (our own, Chrome's, anyone's): the viewer hooks the PDFium engine instance its plugins use
   (`viewer/arabicText.ts`): `searchAllPages` for the viewer's document is answered by the engine's
   `redact.find` (tashkeel/alef/yaa folding, the same search as Redact), `getTextSlices` (copy of a selection)
   by the engine's words whose glyphs lie inside the selected PDFium characters' boxes, in logical order.
   Match-case / whole-word searches, rotated pages and engine errors fall back to PDFium; other documents of
   the engine (Compare's second file) are untouched.

## Consequences
* Our own Arabic output now searches and copies correctly in Chrome/Edge and any PDFium reader for words
  without tashkeel (measured in `tests/e2e/arabic-text.spec.ts`, `sign.spec.ts`), and in our viewer for
  everything, including third-party PDFs.
* Remaining PDFium gaps outside our viewer: words with tashkeel and kashida-stretched words read reversed
  (they keep ActualText), digits followed by `%` come out as `%35`. Recorded in STATUS.
* SPEC's "ActualText per word" is honoured where it helps (LTR words, tashkeel, fallback) and replaced by the
  glyph encoding for plain right-to-left words, because the most common viewer reverses it — the same
  deviation ADR 0016 made for OCR, now applied uniformly from one helper.
