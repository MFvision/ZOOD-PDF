# TDD evidence · Phase 2 text engine (first slice, 2026-09-16)

Source plan: brief §5 (global text engine) and ADR-0004/0005. Runner: `cargo test` in `packages/core`.

## User journeys
* As an Arabic reader, when I copy or search text in any PDF, I get logical-order Unicode regardless of how the producer stored glyphs.
* As an editor, when I add or replace Arabic text, the saved PDF renders shaped text and other viewers extract it correctly.

## Task reports (RED → GREEN)

| # | Behavior | Test | RED evidence (first run) | GREEN evidence |
|---|---|---|---|---|
| 1 | Bidi runs keep Latin+number runs together (W7) | `bidi::numbers_after_latin_belong_to_the_latin_run_w7` | passed on first run (library behaviour) | ok |
| 2 | `%` after a number stays with the number (W5) | `bidi::percent_after_a_number_stays_with_the_number_w5` | `left: "(%15) ةبيرض" right: "(15%) ةبيرض"` — unicode-bidi 0.3.18 resolves a trailing ET to the paragraph level | ok after `char_levels` W5 repair + own reordering |
| 3 | Base direction per UAX #9 P3 | `bidi::base_direction_detects_ltr_paragraph_with_arabic_words` | `left: Ltr right: Rtl` (test expected RTL for digits-only; spec says LTR) | ok after correcting the expectation |
| 4 | Presentation forms fold to letters, marks strip | `normalize::presentation_forms_fold_to_logical_letters`, `strip_marks_…` | passed first run | ok |
| 5 | Search normalization + byte map | `normalize::search_normalization_unifies_alef_taa_yaa_and_digits` | `left: [0,4,8,10] right: [0,4,8,12]` (wrong expected offsets) | ok |
| 6 | Search ignores tashkeel, unifies alef/taa marbuta, highlights whole word incl. trailing marks | `search::*` (2 tests) | `left: end 16 right: 18`; `left: "مرحبا" right: "مرحباً"` | ok after extending the range over trailing marks |
| 7 | HarfRust shaping equals HarfBuzz on Amiri (lam-alef, الله, بلا) | `shape::arabic_letters_get_contextual_forms_and_ligatures` | `left: 2 right: 1` (test assumed a single ligature glyph; HarfBuzz 12.1 via uharfbuzz also returns two glyphs: ids 2518, 2513) | ok with HarfBuzz reference glyph ids |
| 8 | Visual→logical round trip for 13 corpus sentences | `extract::visual_to_logical_round_trips_every_corpus_line` | four successive failures: `"1,200.00 | 1,200.00 | 1 | Pro Warraq"` (spaces broke Latin runs), `"(450.00 :(%15"` (W5), `"00.450"` (W4 separator), `"Thank you … شكرا"` (base direction) | ok after membership rules W4/W5/W7/N1 and rightmost-strong base rule |
| 9 | Marks stay on their base through reordering; ligature clusters not split | `extract::marks_are_attached_to_their_base_and_presentation_forms_folded` | `left: "\u{64e}كتب"`, then `left: "ال" right: "لا"` | ok after unit- and cluster-level reordering |
| 10 | Lines ordered top→bottom, content order irrelevant; gaps become spaces | `extract::reconstruct_lines_…`, `gaps_between_clusters_become_spaces` | passed first run | ok |
| 11 | PDF open/page size/metadata/500-page open < 1 s | `document::*` (3 tests) | passed first run | ok |
| 12 | AES-256 (R6) open with password | `document::encrypted_file_needs_the_password` | `left: 0 right: 3` — lopdf 0.45 loads 1 object and drops the rest | **ignored** with reason; Phase 2 implements the standard security handler |
| 13 | Replace a word with a new subset font + ToUnicode; error when absent | `ops::replace_word_embeds_a_new_subset_font_with_tounicode_and_reopens` | passed first run (ported from the Phase 0 prototype) | ok |
| 14 | Append a shaped Arabic line to a Chrome page | `ops::append_line_adds_shaped_text_to_a_chrome_page` | passed first run | ok |
| 15 | hayro backend renders and yields glyphs with advances and font size | `hayro_backend::renders_and_extracts_glyphs_with_advances` | compile errors (kurbo type paths, `BfString`, glyph API) then ok | ok |
| 16 | Core extracts logical text from the ideal file and searches with normalization | `core::extracts_logical_order_text_from_the_ideal_corpus_file` | passed first run | ok |
| 18 | Skeleton letters + recovered dot marks recompose (ٮ+dot below=ب, ٯ+two dots=ق, ه+two dots=ة) | `extract::skeleton_letters_with_combining_dots_recompose` | written after measuring Noto Naskh Arabic Type3 output; passed first run | ok |
| 17 | Core reads a Chrome/Skia file (presentation-form ToUnicode, visual glyph order) logically | `core::chrome_skia_file_with_presentation_form_tounicode_reads_logically` | `فاتورة ضريبية مب س طة` (advance mismatch with a variable font instance) | ok after the space-glyph-aware gap rule |

Final run: `warraq-text` 17 passed; `warraq-pdf` 5 passed, 1 ignored; `warraq-render` 1 passed; `warraq-core` 2 passed. `cargo clippy --all-targets -- -D warnings` clean.

## Coverage and gaps
* Not yet covered: no-ToUnicode fallbacks (glyph names, cmap, OCR), Type3 fonts, vertical text, paragraph/reflow, incremental save, encryption, the ambiguity "items 3" vs "3 items" (needs content-order tie-break).
* The corpus-wide extraction gate (all 24 truth files scored in CI) is the next test to add.
