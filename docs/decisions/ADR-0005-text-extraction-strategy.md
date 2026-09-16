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

## Addendum (end of Phase 1, 2026-09-16): what the first implementation taught us
* **Skia writes U+0000** in ToUnicode for contextual-form glyphs that have no cmap entry, and embeds **variable** webfonts as **Type3** fonts whose dotted letters are split into skeleton + dot glyphs (the dots map to U+0000). Static fonts become CID fonts. The corpus now carries both cases (`chrome-*` static, `chrome-variablefont-type3-*`).
* **Implemented fallbacks:** U+0000/empty → unknown; unknown glyphs are looked up in the embedded font's cmap (reverse map, preferring letters over presentation forms and private-use codes); still-unknown glyphs become U+FFFD placeholders so words are never silently merged. Presentation forms are folded (NFKC); Persian yeh/kaf written by Skia/Word for Arabic glyphs are restored to Arabic code points when a line has no Persian-specific letters.
* **CoreText applies bracket pairs (N0)**, so the same logical line can have two different visual glyph orders depending on the producer. The inverse mapping is therefore ambiguous by construction; the reconstruction resolves toward the right-to-left human reading: true bracket pairs split runs, numbers attach to Latin on either side of them within a chain, neutrals between two numbers stay RTL (N1). Content-stream order is the planned tie-breaker.
* **Marks** attach to the base whose advance box contains them (else the nearest base) and are reordered together with their base as one unit.
* **Not yet done:** glyph-name fallback (Amiri and Noto have no `post` names), outline matching against bundled fonts, OCR of the rendered line, Type3 dot recomposition, paragraph/alignment detection, and the content-order tie-breaker.
