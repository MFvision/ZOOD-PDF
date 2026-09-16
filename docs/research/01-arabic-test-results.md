# Phase 0 · Arabic acid test results

*Run on 2026-09-16 on macOS 27 (Apple Silicon) with PDFium 153/155 (pypdfium2 and pdfium-render 0.9.4 + pdfium-binaries chromium/8057), PDF.js 6.3.289 (Node 22 + @napi-rs/canvas), MuPDF 1.26.10 (PyMuPDF 1.26.5, AGPL reference only) and hayro 0.7.1. Harness: `tests/acid/` (`run_python.py`, `run_pdfjs.mjs`, `prototypes/`, `merge.py`, `score.py`). Screenshots of page 1 for every file and engine: `screenshots/<engine>/`, contact sheets `screenshots/sheet-<engine>-N.jpg`. Raw numbers: `tests/acid/results.json`.*

## 1. Corpus

41 files: 26 generated (with logical-order ground truth) and 15 real-world (Word/PDFMaker, InDesign, LibreOffice, Google Docs/Skia, MFP scans, a 1924 manuscript with an OCR layer, an Acrobat RTL form, and two legacy-encoding files). See `tests/corpus/arabic/README.md` and `manifest.md`. Scoring is word-level after NFKC and mark stripping and separates character order inside words from word order along lines (`tests/acid/score.py`):

* **logical** – words intact, order ≥ 0.75 of the truth sequence
* **words-ok/line-order-visual** – words intact but each line's words come out reversed (a copy of a sentence is backwards)
* **chars-reversed / partial-reversed** – characters inside words reversed (visual order)
* **partial / garbage / empty** – less than 90 % of words recoverable / < 50 % / nothing

## 2. Opens → renders correctly (visual check of the contact sheets)

| Engine | Opens | Renders correctly | Notes |
|---|---|---|---|
| PDFium | 41/41 | **41/41** | Encrypted, object streams, incremental update, legacy symbolic fonts, forms and annotations all correct. 1–25 ms per page natively. |
| PDF.js | 41/41 | 39/41 text files correct; the two image-only scans rendered blank **in our Node harness** (JPEG decoding path in Node; not a browser result, to be re-verified in-browser) | Needs `disableFontFace` in Node. |
| MuPDF | 41/41 | 41/41 | **SIGSEGV during text extraction** of `chrome-amiri-tashkeel-ligatures.pdf` (reproducible: `python3 -c "import fitz; fitz.open(f)[0].get_text()"`). AGPL. |
| hayro | 40/41 (no password support yet) | 40/41 after the harness set an opaque background | Pure Rust, no unsafe, 45–50 ms per page at 1.5×; encryption listed as unsupported in its README. |

## 3. Extracts text in logical order (the P0 requirement)

Verdict (word recall logical / reversed, order LCS):

| File | PDFium (Chrome) | PDF.js | MuPDF (AGPL ref.) | hayro raw glyph stream |
|---|---|---|---|---|
| `acroform-pdflib-arabic-fields` | partial-reversed (0.16/0.84, 0.13) | garbage (0.08/0.16, 0.05); pres.forms | garbage (0.22/0.08, 0.15) | garbage (0.08/0.14, 0.05); pres.forms |
| `chrome-amiri-tashkeel-ligatures` | garbage (0.37/0.07, 0.12) | garbage (0.30/0.00, 0.28) | ❌ CRASH exit=-11 (signal 11)  | garbage (0.07/0.47, 0.06) |
| `chrome-cairo-mixed-invoice` | partial (0.52/0.41, 0.41) | partial-reversed (0.46/0.54, 0.52); pres.forms | partial (0.74/0.09, 0.57) | garbage (0.44/0.43, 0.38); pres.forms |
| `chrome-ibmplex-bidi-stress` | partial (0.58/0.28, 0.40) | garbage (0.46/0.38, 0.36); pres.forms | partial (0.76/0.01, 0.53) | garbage (0.47/0.36, 0.36); pres.forms |
| `chrome-notonaskh-justified-3pages` | garbage (0.14/0.36, 0.08) | garbage (0.06/0.03, 0.04); pres.forms | garbage (0.07/0.01, 0.06) | garbage (0.05/0.07, 0.04); pres.forms |
| `chrome-notosansarabic-form-layout` | partial-reversed (0.16/0.84, 0.13) | garbage (0.08/0.16, 0.05); pres.forms | garbage (0.22/0.08, 0.15) | garbage (0.08/0.14, 0.05); pres.forms |
| `chrome-tajawal-persian-urdu-digits` | partial (0.73/0.27, 0.27) | garbage (0.27/0.30, 0.21); pres.forms | words-ok/order-scrambled (0.97/0.03, 0.61) | partial-reversed (0.17/0.53, 0.15); pres.forms |
| `chrome-windows-arial-tahoma-times` | partial (0.65/0.39, 0.41) | garbage (0.46/0.33, 0.52); pres.forms | partial (0.87/0.09, 0.65) | garbage (0.44/0.37, 0.38); pres.forms |
| `coretext-albayan-tashkeel` | garbage (0.30/0.30, 0.12) | partial (0.67/0.13, 0.25) | partial (0.63/0.13, 0.62) | partial-reversed (0.13/0.67, 0.03) |
| `coretext-baghdad-persian-urdu` | words-ok/line-order-visual (1.00/0.00, 0.27) | partial (0.87/0.00, 0.27) | logical (0.97/0.00, 0.88) | partial-reversed (0.10/0.83, 0.09) |
| `coretext-geezapro-paragraphs` | partial (0.73/0.02, 0.13) | partial (0.79/0.01, 0.13) | partial (0.72/0.01, 0.64) | partial-reversed (0.07/0.65, 0.04) |
| `coretext-sfarabic-mixed-invoice` | words-ok/order-scrambled (0.94/0.07, 0.52) | words-ok/order-scrambled (0.94/0.07, 0.52) | words-ok/order-scrambled (0.91/0.11, 0.52) | partial-reversed (0.43/0.56, 0.46) |
| `raw-amiri-cid-identity-tounicode` | partial (0.85/0.06, 0.43) | logical (0.94/0.04, 0.90) | partial (0.79/0.05, 0.58) | partial-reversed (0.40/0.58, 0.38) |
| `raw-amiri-cid-no-tounicode` | garbage (0.01/0.01, 0.01) | garbage (0.01/0.01, 0.01) | garbage (0.01/0.01, 0.01) | empty (0.00/0.00, 0.00) |
| `raw-cairo-cid-broken-tounicode` | empty (0.00/0.00, 0.00) | empty (0.00/0.00, 0.00) | garbage (0.00/0.00, 0.00) | empty (0.00/0.00, 0.00) |
| `raw-legacy-symbolic-truetype` | garbage (0.02/0.02, 0.03) | garbage (0.02/0.02, 0.03) | garbage (0.02/0.02, 0.03) | garbage (0.00/0.00, 0.00) |
| `reportlab-visual-presentation-forms` | partial (0.82/0.10, 0.40) | logical (1.00/0.05, 0.92); pres.forms | logical (0.96/0.06, 0.79); pres.forms | partial-reversed (0.35/0.61, 0.35); pres.forms |
| `scan-arial-200dpi-bilevel` | image-only (OCR needed) | image-only (OCR needed) | image-only (OCR needed) | image-only (OCR needed) |
| `scan-notonaskh-300dpi-skewed-jpeg` | image-only (OCR needed) | image-only (OCR needed) | image-only (OCR needed) | image-only (OCR needed) |
| `variant-arabic-metadata-outlines-annots` | garbage (0.14/0.36, 0.08) | garbage (0.06/0.03, 0.04); pres.forms | garbage (0.07/0.01, 0.06) | garbage (0.05/0.07, 0.04); pres.forms |
| `variant-encrypted-aes256` | garbage (0.14/0.36, 0.08) | garbage (0.06/0.03, 0.04); pres.forms | garbage (0.07/0.01, 0.06) | ❌ Decryption(PasswordProtected) |
| `variant-incremental-update` | partial (0.52/0.41, 0.41) | partial-reversed (0.46/0.54, 0.52); pres.forms | partial (0.74/0.09, 0.57) | garbage (0.44/0.43, 0.38); pres.forms |
| `variant-linearized` | garbage (0.14/0.36, 0.08) | garbage (0.06/0.03, 0.04); pres.forms | garbage (0.07/0.01, 0.06) | garbage (0.05/0.07, 0.04); pres.forms |
| `variant-objectstreams-xrefstream` | garbage (0.14/0.36, 0.08) | garbage (0.06/0.03, 0.04); pres.forms | garbage (0.07/0.01, 0.06) | garbage (0.05/0.07, 0.04); pres.forms |

Tally over the 24 truth-scored files:

- **pdfium**: garbage 9, partial 8, partial-reversed 2, image-only (OCR needed) 2, words-ok/line-order-visual 1, words-ok/order-scrambled 1, empty 1
- **pdfjs**: garbage 13, partial 3, partial-reversed 2, logical 2, image-only (OCR needed) 2, words-ok/order-scrambled 1, empty 1
- **mupdf**: garbage 10, partial 7, words-ok/order-scrambled 2, logical 2, image-only (OCR needed) 2, open-failed 1
- **hayro**: garbage 12, partial-reversed 7, empty 2, image-only (OCR needed) 2, open-failed 1

**Reading:** no shipping engine returns logical-order Arabic reliably. PDFium reverses characters of Skia/Chrome output and reverses word order of Quartz output; MuPDF swaps adjacent letters inside words when glyph advances are irregular (`رضيبية` for `ضريبية`) and crashed once; PDF.js is the best of the three on well-formed files (logical on our ideal file and on the ReportLab visual-order file, which it normalizes) but still fails Chrome-made and tashkeel-heavy text. Justified Skia text (`chrome-notonaskh-justified-3pages`) is garbage in every engine. Files without a usable ToUnicode map (`raw-amiri-cid-no-tounicode`, `raw-cairo-cid-broken-tounicode`, `raw-legacy-symbolic-truetype`, the two class-G real-world files) yield nothing or code garbage in every engine: none falls back to glyph names, font cmaps or OCR. The hayro column is not a competitor: it is the raw glyph stream (visual order, ToUnicode as written by the producer, e.g. Skia's presentation forms) that our own reconstruction layer (ADR-0005) starts from.

Real-world files (no ground truth; first characters of page 1 as returned):

| File | Producer | Pres. forms in ToUnicode | PDFium text head | PDF.js text head |
|---|---|---|---|---|
| `A_un_rome_statute_A-CONF.183-9-AR_word_pdfmaker6` | Acrobat Distiller 6.0 (Windo | yes | A المتحـدة الأمــم /CONF.183/9 ⏎ المعني للمفوضين الدبلوماسي | ﺍملﺘﺤـﺪﺓ ﺍﻷﻣــﻢ A/CONF.183/9 ⏎ ﺍملﻌين ﻟﻠﻤﻔﻮﺿني ﺍﻟﺪﺑﻠﻮﻣﺎﺳﻲ ﺍم |
| `A_worldbank_malpass_g7_briefing_AR_word2016_pdftools` | Microsoft® Word 2016 / PDF P | no |  إعالمية إحاطة جلسة في مالباس ديفيد الدولي البنك مجموعة رئيس | كلمة رئيس مجموعة البنك الدولي ديفيد مالباس في جلسة إحاطة إعا |
| `A_arwikibooks_mediawiki_guide_word2007` | Microsoft® Office Word 2007 | no |  ًكٌاوٌدٌم استخدام لٌدل ⏎ 1 ⏎ ٙكٚٔاٚذٛي اعرخذاو مٛدن ⏎ ـح | دلٌلاستخدام ًمٌدٌاوٌك ⏎ 1 ⏎ ٙ ⏎ دنٛم اعرخذاو يٛذٚأٚك ⏎ يشـا |
| `B_baytalhekma_covid_workplace_guide_indesign_cc2015` | Adobe PDF Library 15.0 | yes | دليلالوقايةمنفيروس ⏎ إعداد مركز مكافحة الفيروسات والأوبئة ب | ﻓﻴﺮوس ﻣﻦ اﻟﻮﻗﺎﻳﺔ دﻟﻴﻞ ⏎ إﻋﺪاد ﻣﺮﻛﺰ ﻣﻜﺎﻓﺤﺔ اﻟﻔﻴﺮوﺳﺎت واﻷوﺑﺌﺔ  |
| `B_wmf_welcome_to_wikipedia_arabic_indesign_cs5_p1-5` | Adobe PDF Library 9.9 | no |  يمكن اً ⏎ عالم تخيل ⏎  فرد لكل فيه ⏎  مجموع مطالعة ⏎  ا | تخيل عالمًا يمكن ⏎ فيه لكل فرد ⏎ مطالعة مجموع ⏎ معارف البشري |
| `C_lo_bug171737_noto_sans_arabic_extraction_lo26.2_pdf2.0` | LibreOffice 26.2.1.2 (X86_64 | yes | amiri ⏎ الآخر وم	والي ل	والرس والكتب وصفاته بالله الجازم ال | amiri ⏎ كتب والرس ل والي وم الآخرلوالإيمان هو التصديق الجاز |
| `C_lo_bug119606_seventeen_macos_arabic_fonts_lo7.5dev` | LibreOfficeDev 7.5 | no | هُ ْمن ا ِ هَ تُيْ ⏎ َتَرشا ا ْ َن ⏎ أَو كتاب آالف خمسة با | َيْتُهَا مِنْهُرَتَ ْ نَا اشَأََ ى بالل خمسة آالف كتاب ورَت  |
| `D_gdocs_digital_safety_guide_ar_skia_m130` | Skia/PDF m130 Google Docs Re | yes | `` ⏎ الدليل؟ لماذا ⏎ ةفرعم إن .هثدحي أن يمكن الذي الضرر حج | `` ⏎ ذاﺎﻣﻟ ل؟ﯾﻟدﻟا ⏎ ﺎﻣﻠﻛ زاد درﻗ تﺎﻣوﻠﻌﻣﻟا ﻲﺗﻟا ﺎﮭﻛﻠﺗﻣﯾ صﺧﺷ |
| `D_gdocs_wmf_rapid_funds_guide_ar_skia_m97` | Skia/PDF m97 Google Docs Ren | yes | ،ان ⏎ ت ⏎ سلوم يبوب وباركاو البوعمراوي ا ⏎ ن ⏎ يمساج ⏎  | ن،ﺎ﮴ ﺴﻟﻮﻣ ﮵ ﻰ﮳ ﻮ﮳  ﻮ﮳ را اوي وﺮﻤﻋﻮ﮳ ﻟا ﺎ﮲ ﮵ ﻤﺳﺎ ﮳ﺣ  ⏎ ﮲ ⏎  ں |
| `E_commons_tafsir_surat_alnur_pd_scan_p1-3` | itext-paulo-155 (itextpdf.sf | no |  ⏎  ⏎  |  ⏎  ⏎  |
| `E_commons_qarar193_toshiba_estudio_mfp_scan` | SECnvtToPDF V1.0 | no |  ⏎  ⏎  |  ⏎  ⏎  |
| `E_ia_bv056_arabic_manuscript_1924_ocr_text_layer` | Internet Archive PDF 1.2.0;  | no |  ⏎  ⏎  |  ⏎  ⏎  |
| `F_pdfjs15546_rtl_acroform_textfields_arabic_digits_acrobat` | Adobe Acrobat Pro DC (64-bit | no | RTL Field with arabic numbers ⏎ RTL Field with usual number | RTL Field with arabic numbers ⏎  ⏎ RTL Field with usual numb |
| `G_pdfjs_ArabicCIDTrueType_apple_pstopdffilter_no_tounicode` | Apple pstopdffilter | yes | العربية الخطوط انواع ⏎ العربية الخطوط انواع ⏎ العربية الخط | اﻟﻌﺮﺑﻴﺔ اخلﻄﻮط اﻧﻮاع ⏎ اﻟﻌﺮﺑﻴﺔ اخلﻄﻮط اﻧﻮاع ⏎ اﻟﻌﺮﺑﻴﺔ اخلﻄﻮط |
| `G_wipo_saudi_copyright_law_laserwriter8_distiller5_legacy_encoding` | Acrobat Distiller 5.0.5 (Win | no | n=R*« ‚uIŠ W¹ULŠ ÂUE½ ⏎ a¹—UðË © ¥±Ø Â ® r?— wJK*« Âu???Ý | n=R*« ‚uIŠ W¹ULŠ ÂUE½ ⏎ a¹—UðË © ¥±Ø Â ® r?— wJK*« Âu???Ýd |

Notable: PDFium silently folds presentation forms to base letters (its output never contains U+FBxx/FExx although 6 of the 15 real-world files map to them), so PDFium's text hides that the ToUnicode maps are wrong for search and copy in other viewers.

## 4. Selects text
All four engines expose per-glyph positions (PDFium char boxes, PDF.js text items with transforms, MuPDF words, hayro glyph callbacks); selection *geometry* is available everywhere, but selection *order* (what a drag selects, what Shift+arrow extends) follows the extraction order above and is therefore wrong in every engine for most Arabic files.

## 5. Edits one word and saves without breaking shaping; adds a new Arabic paragraph with a custom font

| Path | Add paragraph | Edit one word | Evidence |
|---|---|---|---|
| PDFium `FPDFText_SetText` / `FPDFText_LoadFont` (pypdfium2 and pdfium-render `set_text`) | ✗ unshaped, characters placed left-to-right | ✗ same | `tests/acid/write-tests/out-pdfium-add-text.png`, `edit-compare.png` row 3 |
| MuPDF `insert_text` | ✗ isolated presentation forms, reversed | n/a | `out-mupdf-add-text.png` |
| MuPDF `insert_htmlbox` (Story engine, HarfBuzz) | render ✓, extraction garbage (broken ToUnicode) | n/a | same; AGPL |
| pdf-lib `drawText` / form field appearance | ✗ almost nothing drawn / unshaped | n/a | `out-pdflib-add-text.png`, corpus `acroform-pdflib-arabic-fields` |
| Python HarfBuzz + own PDF writer (`gen_raw.py`) | ✓ render; PDF.js logical 0.935 | – | corpus `raw-amiri-cid-identity-tounicode` |
| **Rust `harfrust` + `unicode-bidi` + `skrifa` + `subsetter` + `pdf-writer`** (`prototypes/proto-text write`) | ✓ render; **PDF.js logical 0.951, order 0.893**; 209-glyph subset, correct multi-char ToUnicode | – | `out-rust-write.pdf` |
| **Rust `lopdf` + the same text stack** (`prototypes/proto-text edit`) | – | ✓ `للتقنية` → `للبرمجة`: word located through the existing ToUnicode across several TJ operators, replaced by a shaped glyph run in a newly embedded subset font; MuPDF reads the edited line as `العميل: شركة زود للبرمجة` | `out-rust-edit.pdf`, `edit-compare.png` row 2 |

Both prototype combinations were built end-to-end in Rust on the corpus: **(A)** PDFium (pdfium-render) for rendering/objects + our text stack for writing, and **(B)** pure Rust (hayro for reading, lopdf/pdf-writer for writing). Rendering fidelity and robustness decide in favor of PDFium as rasterizer; the write/edit path is ours in both cases.

## 6. Performance (page 1 open / render at 1.5× / text of all pages, ms)

| File | PDFium (Python) | PDFium (Rust) | PDF.js (Node) | MuPDF | hayro |
|---|---|---|---|---|---|
| `perf-text-100-pages` | 16.1 / 8.4 / 253.7 | 8.8 / 11.2 / – | 74.6 / 612.7 / 6803.2 | 3.8 / 37.2 / 1350.8 | 1.8 / 79.9 / – |
| `perf-text-500-pages` | 15.6 / 6.8 / 1192.5 | 8.2 / 10.4 / – | 36 / 590.3 / 35418.6 | 3.1 / 31.4 / 9277.6 | 5.2 / 69.3 / – |

PDFium natively is well inside N8 (100 pages open + first render < 30 ms). PDF.js numbers are Node-side and include JIT warm-up. The 500 MB scanned stress file (`gen_scans.py --large`) is generated on demand and was not run in this session.

## 7. Bundle sizes (N8: < 8 MB gzipped)
`pdfium.wasm` 5.32 MB raw / **2.41 MB gzipped** (+ 30 KB JS glue), from `bblanchon/pdfium-binaries` chromium/8057, no V8/XFA. Our Rust core target: < 2 MB gzipped. Tesseract.js core and `ara.traineddata` (12.6 MB) load on demand only.

## 8. What surprised us
1. Chrome's own engine cannot copy Arabic from Chrome's own PDFs in order (Skia writes glyphs in visual order with presentation-form ToUnicode; PDFium's bidi pass does not undo it).
2. `rustybuzz` is archived; the HarfBuzz organisation's successor is `harfrust` on Google's fontations, which we used successfully.
3. MuPDF crashes on a modern Chrome-generated file — a reminder that the parser must be sandboxed whatever engine we use.
4. The two ways Google Docs and Word write Arabic (visual-order simple fonts without ToUnicode; presentation-form ToUnicode) are both common in real documents (7 of 15 real-world files).
