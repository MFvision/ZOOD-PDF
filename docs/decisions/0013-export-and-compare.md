# ADR 0013 — Export and Compare: own writers in `warraq-office`, rasters from PDFium

* Status: accepted
* Date: 2026-09-25

## Context
Export must produce Word, Excel, PowerPoint, HTML, Markdown, text and pictures from a PDF, Arabic first, with
tables. Compare must show text and visual differences and save a report. GPL/LGPL/MPL office suites
(LibreOffice) are forbidden, nothing may leave the device, and hostile PDFs must not crash or hang the engine.
The default wasm has no raster backend: hayro (`warraq-render`, feature `render`) adds several MB.

## Decision
* **New crate `warraq-office`** (workspace member, linked by `warraq-core`):
  * An **export model** built from warraq-text's logical-order extraction (so every format carries the same text
    the Arabic acid gate measures): paragraphs with direction, guessed language (`ar`/`fa`/`ur`/`he`/`en` from
    script), heading level (font size vs. the character-weighted body size), bold/italic runs (warraq-text now
    reports italic from font names, `/Flags` bit 7 and `/ItalicAngle`), and tables.
  * **Tables**: (1) *ruled* — a small path interpreter over the warraq-text content lexer (`q/Q/cm`, `m/l/re/h`,
    curves, all paint operators, form XObjects, bounded) collects axis-aligned stroked segments and thin filled
    rectangles (how Chrome draws borders); touching segments form components; a component with ≥ 2 x-lines and
    ≥ 2 y-lines is a grid; a missing rule between two cells merges them (row/column spans). (2) *aligned* — ≥ 3
    consecutive visual rows splitting into the same number of chunks whose gaps line up, with ≤ 4 words per chunk
    so prose columns are not tables. Words are assigned by centre; cell text keeps the extractor's logical order;
    right-to-left tables number their columns from the right (DOCX `w:bidiVisual`, XLSX `rightToLeft`, HTML
    `dir=rtl`).
  * **Writers are our own**: minimal valid OOXML (content types, relationships, core/app properties; DOCX with
    `w:bidi` paragraphs and `w:rtl` + `w:lang w:bidi` runs split at direction changes, Heading1–3 styles, tables
    with `gridSpan`/`vMerge`, page breaks; XLSX with shared strings, numbers in any digit system as numbers,
    merged cells, localised sheet names; PPTX with one slide per page, text boxes at the source positions,
    optional PNG background), HTML (`lang`/`dir`, semantic headings, `colspan`/`rowspan`, no scripts), GitHub
    Markdown, and plain text identical to `text.plain`. The ZIP container is ~150 lines over `miniz_oxide` +
    `crc32fast` (both already linked through flate2).
  * **Compare**: word-level diff of the two extractions with Arabic-aware keys (tashkeel/tatweel dropped by default;
    optional search normalisation of letter forms and digits). Patience anchors (words unique on both sides,
    longest increasing subsequence) split the problem; gaps use Myers O(ND) bounded to D ≤ 1000 and anchor
    recursion depth ≤ 48; beyond the bound a gap is reported as one replacement. Output: inserted/deleted/changed
    with rectangles on both documents. Visual diff takes two RGBA rasters, compares per channel with a threshold,
    groups changed 8×8 cells into regions and returns an overlay PNG. The HTML report is self-contained (inline
    CSS, overlays as `data:` URIs, no scripts), localised by labels the UI passes from `en.json`/`ar.json`.
* **Rasters come from PDFium in the UI** (the viewer's engine renders pages; a second PDF is opened in the same
  PDFium engine via `ViewerApi.openOther`), not from hayro in the wasm. PNG export renders at 144 dpi and zips
  several pages with the engine's `export.zip`. `export.png` exists in the engine only with the `render` feature
  (native/iOS builds).
* **UI**: Export is a sheet (format gallery, page range accepting Arabic-Indic/Persian digits and Arabic
  separators); Compare is a side panel (choose the revised file, changes list with click-to-jump and side-by-side
  highlighted previews, visual pass over the first 30 pages, save report). Both save through the host bridge.
  Core tools open their panel through `tools/panels.ts` (`openToolPanel(tool, docId)`), keeping the static
  registry free of React state.

## Consequences
* wasm grows by ~319 KB before `wasm-opt` (1,674,278 → 1,993,484 bytes) instead of several MB for hayro.
* Exports never modify the document; they run on a private engine copy of the current bytes (PDFium's copy when
  the viewer has unsaved edits).
* Layout fidelity is "structured document", not "pixel copy": fonts, colours, images, lists and columns are not
  reproduced (see `docs/STATUS.md`).
