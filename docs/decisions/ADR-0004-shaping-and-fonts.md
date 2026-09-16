# ADR-0004 · Shaping and fonts: HarfRust on fontations, unicode-bidi, subsetter, bundled OFL fallback chain

**Status:** accepted at GATE 0 · **Date:** 2026-09-16

## Context
The brief names "HarfBuzz/rustybuzz, ttf-parser, unicode-bidi, fontkit,
subsetter, Typst's text stack". On 2026-09-16 the live audit found
`harfbuzz/rustybuzz` **archived** with its README pointing to
`harfbuzz/harfrust` (MIT), a port on Google's `read-fonts`/`skrifa`
(fontations), tracking HarfBuzz 14.3.1, `#![forbid(unsafe_code)]`.

## Options
1. rustybuzz + ttf-parser (archived; no future HarfBuzz fixes).
2. **HarfRust + fontations** (maintained by the HarfBuzz and Google Fonts teams).
3. HarfBuzz C++ via FFI/WASM (`harfbuzzjs` 1.2 MB): the reference, but a second
   C++ dependency and awkward in the WASM build.
4. allsorts (Apache-2.0): good Arabic shaper, smaller community.

## Choice
Option 2. `harfrust` for OpenType shaping (Arabic joining forms, ligatures,
`mark`/`mkmk`, kashida via `tatweel` characters and later justification),
`unicode-bidi` (UAX #9) for paragraph levels and visual runs, `skrifa` for
metrics and outlines, `subsetter` (Typst) for TrueType/CFF subsetting with
glyph remapping, `icu_segmenter` for line/word/grapheme breaks. `parley` is the
candidate paragraph layout engine for the editor (evaluated in Phase 2; it uses
the same HarfRust/fontations stack).

Fallback chain, bundled (OFL-1.1): Noto Naskh Arabic, Noto Sans Arabic, Amiri,
Cairo, IBM Plex Sans Arabic, Tajawal, plus Noto Sans and Inter for Latin. The
embedded font of the document is reused when it has the needed glyphs; otherwise
the chain is consulted, the user is warned, and the substitute is embedded and
subset on save.

Output rule: text is always written as logical Unicode via a correct ToUnicode
map (multi-character mappings for ligatures), Identity-H CID fonts with
`CIDToGIDMap /Identity`; never presentation forms, never visual-order strings.

## Consequences
* HarfRust conformance gaps (per its README: some HarfBuzz tests, malformed
  fonts error instead of fallback) are covered by our corpus and by a
  `harfbuzz` C++ cross-check in CI (dev-time only, via `uharfbuzz`).
* Variable fonts are instantiated to a static instance before embedding (PDF has
  no variable-font support).
