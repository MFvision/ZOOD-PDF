# ADR-0005 · Text reading: reconstruct logical order ourselves; never trust an engine's text order

**Status:** accepted at GATE 0 · **Date:** 2026-09-16

## Context (measured, see 01-arabic-test-results.md)
On the 24 truth-scored corpus files, no engine returned logical-order Arabic
reliably:
* PDFium (Chrome) returns Skia-made Arabic character-reversed, keeps words but
  reverses line order for Quartz-made files, and fragments justified text.
* PDF.js is best on well-formed files (logical on our ideal file and on the
  ReportLab visual-order file) but still fails Chrome-made and tashkeel-heavy text.
* MuPDF swaps adjacent letters inside words when glyph advances are irregular
  and crashed on one file.
* All three return nothing useful when ToUnicode is missing or broken, and none
  fall back to glyph names, font cmaps or OCR.

## Choice
`warraq-text::extract` builds text from **positioned glyphs in content order**
(hayro-interpret device on native and WASM) and reconstructs:
1. **Characters:** ToUnicode → if absent/broken, glyph name (AGL + `uniXXXX`)
   → font `cmap` reverse lookup → presentation-form folding (NFKC) → OCR of the
   rendered line as last resort; each source tagged with a confidence.
2. **Lines:** cluster glyphs by baseline and font size, tolerant of marks.
3. **Runs and order:** within a line, group glyphs into runs by script and
   direction of their *characters* (not their position), detect visual-order
   storage (RTL run stored left-to-right) and reverse it back to logical order;
   numbers and Latin inside Arabic are placed by UAX #9 rules applied to the
   recovered logical string.
4. **Paragraphs:** merge lines by alignment and spacing; detect base direction
   and alignment so editing can reflow.
5. **Normalization for search:** strip tashkeel and tatweel, unify alef forms,
   taa marbuta/haa, yaa/alef maqsura (configurable), fold presentation forms.

## Consequences
* Extraction quality is measured on the corpus with the same scorer as the
  candidates; the target is "logical" on every truth-scored file except the
  no-ToUnicode/legacy files, which must reach "logical" via glyph names and OCR.
* PDFium's text page is still used for non-text-critical features (hit testing
  fallback, comparison) but never as the source of copied or searched text.
