# Phase 0 · Arabic acid test results (updated with the Phase 1 core)

*Run on 2026-09-16 on macOS 27 (Apple Silicon) with PDFium 153/155 (pypdfium2 and pdfium-render 0.9.4 + pdfium-binaries chromium/8057), PDF.js 6.3.289 (Node 22 + @napi-rs/canvas), MuPDF 1.26.10 (PyMuPDF 1.26.5, AGPL reference only), hayro 0.7.1, and the Warraq core (`packages/core`, hayro device + own reconstruction). Harness: `tests/acid/` (`run_python.py`, `run_pdfjs.mjs`, `prototypes/`, `packages/core/warraq-core/examples/acid.rs`, `merge.py`, `score.py`; regenerate this file with `write_results_doc.py`). Screenshots of page 1 for every file and engine: `screenshots/<engine>/`, contact sheets `screenshots/sheet-<engine>-N.jpg`. Raw numbers: `tests/acid/results.json`.*

## 1. Corpus

42 files: 27 generated (with logical-order ground truth) and 15 real-world (Word/PDFMaker, InDesign, LibreOffice, Google Docs/Skia, MFP scans, a 1924 manuscript with an OCR layer, an Acrobat RTL form, and two legacy-encoding files). Corpus v1.1: the Chrome files use static font instances (Skia embeds them as CID fonts, as Google Docs exports do); one file keeps a variable webfont, which Skia embeds as a Type3 font with dots as separate glyphs mapped to U+0000. See `tests/corpus/arabic/README.md` and `manifest.md`. Scoring is word-level after NFKC and mark stripping and separates character order inside words from word order along lines (`tests/acid/score.py`):

* **logical** – words intact, order ≥ 0.75 of the truth sequence
* **words-ok/line-order-visual** – words intact but each line's words come out reversed
* **chars-reversed / partial-reversed** – characters inside words reversed (visual order)
* **partial / garbage / empty** – less than 90 % of words recoverable / < 50 % / nothing

## 2. Opens → renders correctly (visual check of the contact sheets)

| Engine | Opens | Renders correctly | Notes |
|---|---|---|---|
| PDFium | all | all | Encrypted, object streams, incremental update, legacy symbolic fonts, forms and annotations all correct. 1–25 ms per page natively. |
| PDF.js | all | text files correct; the two image-only scans rendered blank **in our Node harness** (JPEG decoding path in Node; to be re-verified in-browser) | Needs `disableFontFace` in Node. |
| MuPDF | all | all | **SIGSEGV during text extraction** of `chrome-amiri-tashkeel-ligatures.pdf` (reproducible: `python3 -c "import fitz; fitz.open(f)[0].get_text()"`). AGPL. |
| hayro / Warraq core | all but the encrypted file | all rendered files correct | Pure Rust, no unsafe; encryption is a Phase 2 item for our object layer. |

## 3. Extracts text in logical order (the P0 requirement)

Verdict (word recall logical / reversed, order LCS):

| File | PDFium (Chrome) | PDF.js | MuPDF (AGPL ref.) | hayro raw glyphs | **Warraq core** |
|---|---|---|---|---|---|
| `acroform-pdflib-arabic-fields` | partial-reversed (0.16/0.86, 0.13) | garbage (0.08/0.16, 0.05) | garbage (0.22/0.08, 0.18) | garbage (0.08/0.16, 0.05) | garbage(U+FFFD) (0.19/0.08, 0.20) |
| `chrome-amiri-tashkeel-ligatures` | garbage (0.37/0.07, 0.12) | garbage (0.30/0.00, 0.28) | ❌ CRASH exit=-11 (signal 11)  | garbage (0.07/0.47, 0.06) | partial (0.50/0.03, 0.50) |
| `chrome-cairo-mixed-invoice` | partial (0.52/0.41, 0.41) | partial-reversed (0.46/0.54, 0.52) | partial (0.76/0.09, 0.57) | garbage (0.44/0.46, 0.38) | logical (1.00/0.07, 0.96) |
| `chrome-ibmplex-bidi-stress` | partial (0.58/0.28, 0.40) | garbage (0.46/0.38, 0.36) | partial (0.76/0.01, 0.53) | garbage (0.47/0.36, 0.36) | logical (1.00/0.03, 1.00) |
| `chrome-notonaskh-justified-3pages` | garbage (0.14/0.37, 0.07) | garbage (0.06/0.03, 0.04) | garbage (0.12/0.01, 0.12) | garbage (0.05/0.07, 0.04) | garbage(U+FFFD) (0.17/0.01, 0.19) |
| `chrome-notosansarabic-form-layout` | partial-reversed (0.16/0.86, 0.13) | garbage (0.08/0.16, 0.05) | garbage (0.22/0.08, 0.18) | garbage (0.08/0.16, 0.05) | garbage(U+FFFD) (0.19/0.08, 0.20) |
| `chrome-tajawal-persian-urdu-digits` | partial (0.73/0.27, 0.27) | garbage (0.27/0.30, 0.21) | words-ok/order-scrambled (0.97/0.03, 0.61) | partial-reversed (0.17/0.53, 0.15) | logical (1.00/0.00, 1.00) |
| `chrome-variablefont-type3-notonaskh-justified` | garbage (0.14/0.36, 0.08) | garbage (0.06/0.03, 0.04) | garbage (0.07/0.01, 0.06) | garbage (0.05/0.07, 0.04) | garbage(U+FFFD) (0.20/0.01, 0.21) |
| `chrome-windows-arial-tahoma-times` | partial (0.65/0.39, 0.41) | garbage (0.46/0.33, 0.52) | partial (0.87/0.09, 0.65) | garbage (0.44/0.37, 0.38) | logical (1.00/0.07, 0.96) |
| `coretext-albayan-tashkeel` | garbage (0.30/0.30, 0.12) | partial (0.67/0.13, 0.25) | partial (0.63/0.13, 0.62) | partial-reversed (0.13/0.67, 0.03) | logical (1.00/0.00, 1.00) |
| `coretext-baghdad-persian-urdu` | words-ok/line-order-visual (1.00/0.00, 0.27) | partial (0.87/0.00, 0.27) | logical (0.97/0.00, 0.88) | partial-reversed (0.10/0.83, 0.09) | logical (0.97/0.00, 0.97) |
| `coretext-geezapro-paragraphs` | partial (0.73/0.02, 0.13) | partial (0.79/0.01, 0.13) | partial (0.72/0.01, 0.64) | partial-reversed (0.07/0.65, 0.04) | logical (1.00/0.01, 0.99) |
| `coretext-sfarabic-mixed-invoice` | words-ok/order-scrambled (0.94/0.07, 0.52) | words-ok/order-scrambled (0.94/0.07, 0.52) | words-ok/order-scrambled (0.91/0.11, 0.52) | partial-reversed (0.43/0.56, 0.46) | logical (1.00/0.07, 0.96) |
| `raw-amiri-cid-identity-tounicode` | partial (0.85/0.06, 0.43) | logical (0.94/0.04, 0.90) | partial (0.79/0.05, 0.58) | partial-reversed (0.40/0.58, 0.38) | logical (0.96/0.04, 0.93) |
| `raw-amiri-cid-no-tounicode` | garbage (0.01/0.01, 0.01) | garbage (0.01/0.01, 0.01) | garbage (0.01/0.01, 0.01) | empty (0.00/0.00, 0.00) | garbage(U+FFFD) (0.41/0.04, 0.44) |
| `raw-cairo-cid-broken-tounicode` | empty (0.00/0.00, 0.00) | empty (0.00/0.00, 0.00) | garbage (0.00/0.00, 0.00) | empty (0.00/0.00, 0.00) | empty (0.00/0.00, 0.00) |
| `raw-legacy-symbolic-truetype` | garbage (0.02/0.02, 0.03) | garbage (0.02/0.02, 0.03) | garbage (0.02/0.02, 0.03) | garbage (0.00/0.00, 0.00) | garbage (0.01/0.02, 0.01) |
| `reportlab-visual-presentation-forms` | partial (0.82/0.10, 0.40) | logical (1.00/0.05, 0.92) | logical (0.96/0.06, 0.79) | partial-reversed (0.35/0.61, 0.35) | logical (1.00/0.05, 0.97) |
| `scan-arial-200dpi-bilevel` | image-only (OCR needed) | image-only (OCR needed) | image-only (OCR needed) | image-only (OCR needed) | image-only (OCR needed) |
| `scan-notonaskh-300dpi-skewed-jpeg` | image-only (OCR needed) | image-only (OCR needed) | image-only (OCR needed) | image-only (OCR needed) | image-only (OCR needed) |
| `variant-arabic-metadata-outlines-annots` | garbage (0.14/0.37, 0.07) | garbage (0.06/0.03, 0.04) | garbage (0.12/0.01, 0.12) | garbage (0.05/0.07, 0.04) | garbage(U+FFFD) (0.17/0.01, 0.19) |
| `variant-encrypted-aes256` | garbage (0.14/0.37, 0.07) | garbage (0.06/0.03, 0.04) | garbage (0.12/0.01, 0.12) | ❌ Decryption(PasswordProtected) | ❌ E_PASSWORD: the document is encrypte |
| `variant-incremental-update` | partial (0.52/0.41, 0.41) | partial-reversed (0.46/0.54, 0.52) | partial (0.76/0.09, 0.57) | garbage (0.44/0.46, 0.38) | logical (1.00/0.07, 0.96) |
| `variant-linearized` | garbage (0.14/0.37, 0.07) | garbage (0.06/0.03, 0.04) | garbage (0.12/0.01, 0.12) | garbage (0.05/0.07, 0.04) | garbage(U+FFFD) (0.17/0.01, 0.19) |
| `variant-objectstreams-xrefstream` | garbage (0.14/0.37, 0.07) | garbage (0.06/0.03, 0.04) | garbage (0.12/0.01, 0.12) | garbage (0.05/0.07, 0.04) | garbage(U+FFFD) (0.17/0.01, 0.19) |

Tally over the 25 truth-scored files:

- PDFium (Chrome): garbage 10, partial 8, partial-reversed 2, image-only (OCR needed) 2, words-ok/line-order-visual 1, words-ok/order-scrambled 1, empty 1
- PDF.js: garbage 14, partial 3, partial-reversed 2, logical 2, image-only (OCR needed) 2, words-ok/order-scrambled 1, empty 1
- MuPDF (AGPL ref.): garbage 11, partial 7, words-ok/order-scrambled 2, logical 2, image-only (OCR needed) 2, open-failed 1
- hayro raw glyphs: garbage 13, partial-reversed 7, empty 2, image-only (OCR needed) 2, open-failed 1
- **Warraq core**: logical 11, garbage(U+FFFD) 8, image-only (OCR needed) 2, partial 1, empty 1, garbage 1, open-failed 1

**Logical-order files: PDFium 0, PDF.js 2, MuPDF 2, Warraq core 11.** No shipping engine returns logical-order Arabic reliably: PDFium reverses characters of Skia/Chrome output and reverses word order of Quartz output; MuPDF swaps adjacent letters inside words when glyph advances are irregular (`رضيبية` for `ضريبية`) and crashed once; PDF.js is the best of the three on well-formed files but still fails Chrome-made and tashkeel-heavy text. The hayro column is the raw glyph stream (visual order, ToUnicode as written by the producer) that the Warraq reconstruction (ADR-0005) starts from. The Warraq core's remaining failures are the files without a usable ToUnicode map (`raw-amiri-cid-no-tounicode`, `raw-cairo-cid-broken-tounicode`, `raw-legacy-symbolic-truetype`), the variable-font Type3 file, and glyphs that Skia maps to U+0000 (contextual forms without cmap entries); glyph-name, outline-matching and OCR fallbacks are Phase 2 work.

Real-world files (no ground truth; first characters of page 1 as returned):

| File | Producer | Pres. forms in ToUnicode | PDFium text head | Warraq text head |
|---|---|---|---|---|
| `A_un_rome_statute_A-CONF.183-9-AR_word_pdfmaker6` | Acrobat Distiller 6.0 (Windo | yes | A المتحـدة الأمــم /CONF.183/9 ⏎ المعني للمفوضين الدبلوماسي | الأمـمـ المتحدـة  A/CONF.183/9 ⏎ مؤتمر الأمم المتحدة الدبلوم |
| `A_worldbank_malpass_g7_briefing_AR_word2016_pdftools` | Microsoft® Word 2016 / PDF P | no |  إعالمية إحاطة جلسة في مالباس ديفيد الدولي البنك مجموعة رئيس | d ⏎ ez ⏎ ir ⏎ o ⏎ كلمة رئيس مجموعة البنك الدولي ديفيد مالباس |
| `A_arwikibooks_mediawiki_guide_word2007` | Microsoft® Office Word 2007 | no |  ًكٌاوٌدٌم استخدام لٌدل ⏎ 1 ⏎ ٙكٚٔاٚذٛي اعرخذاو مٛدن ⏎ ـح | دلٌل استخدام مدٌاٌوكٌ ً ⏎ دنٛم اعرخذاو يذٛأٚكٙٚ ⏎ يشاـسغٚ ذط |
| `B_baytalhekma_covid_workplace_guide_indesign_cc2015` | Adobe PDF Library 15.0 | yes | دليلالوقايةمنفيروس ⏎ إعداد مركز مكافحة الفيروسات والأوبئة ب |  ⏎ الطبعة الأولى: 1441ه ـ- 2020م ⏎ الناشر: بيت الحكمة للاستث |
| `B_wmf_welcome_to_wikipedia_arabic_indesign_cs5_p1-5` | Adobe PDF Library 9.9 | no | ًا يمكن  ⏎ تخيل عالم ⏎ فيه لكل فرد  ⏎ مطالعة مجموع  ⏎ مع | تخيل عالمًا يمكن ⏎ فيه لكل فرد ⏎ مطالعة مجموع ⏎ معارف البشري |
| `C_lo_bug171737_noto_sans_arabic_extraction_lo26.2_pdf2.0` | LibreOffice 26.2.1.2 (X86_64 | yes | amiri ⏎ الآخر وم	والي ل	والرس والكتب وصفاته بالله الجازم ال | am iri ⏎ والإيمان هو التصديق الجازم بالله وصفاته وال�كتب وال |
| `C_lo_bug119606_seventeen_macos_arabic_fonts_lo7.5dev` | LibreOfficeDev 7.5 | no | هُ ْمن ا ِ هَ تُيْ ⏎ َتَرشا ا ْ َن ⏎ أَو كتاب آالف خمسة با | اشتَرى بلال خمسة آلاف كتاب وأََنَاَ اشْتَرََيتْهُاَ منِهُْ ⏎ |
| `D_gdocs_digital_safety_guide_ar_skia_m130` | Skia/PDF m130 Google Docs Re | yes | `` ⏎ الدليل؟ لماذا ⏎ ةفرعم إن .هثدحي أن يمكن الذي الضرر حج | `` ⏎ لماذا الدليل؟ ⏎ كلما زاد قدر المعلومات التي یمتلكھا شخص |
| `D_gdocs_wmf_rapid_funds_guide_ar_skia_m97` | Skia/PDF m97 Google Docs Ren | yes | ،ان ⏎ ت ⏎ سلوم يبوب وباركاو البوعمراوي ا ⏎ ن ⏎ يمساج ⏎  | الصور م﮴�دمة مں ﮳حاسم﮵��ا ال﮳�وعمراوي و�را﮳�و ﮳�و﮳�﮵ى مولس�ا |
| `E_commons_tafsir_surat_alnur_pd_scan_p1-3` | itext-paulo-155 (itextpdf.sf | no |  ⏎  ⏎  |  ⏎  ⏎  |
| `E_commons_qarar193_toshiba_estudio_mfp_scan` | SECnvtToPDF V1.0 | no |  ⏎  ⏎  |  ⏎  ⏎  |
| `E_ia_bv056_arabic_manuscript_1924_ocr_text_layer` | Internet Archive PDF 1.2.0;  | no |  ⏎  ⏎  |  ⏎  ⏎  |
| `F_pdfjs15546_rtl_acroform_textfields_arabic_digits_acrobat` | Adobe Acrobat Pro DC (64-bit | no | RTL Field with arabic numbers ⏎ RTL Field with usual number | RTL Field with arabic numbers ⏎ RTL Field with usual numbers |
| `G_pdfjs_ArabicCIDTrueType_apple_pstopdffilter_no_tounicode` | Apple pstopdffilter | yes | العربية الخطوط انواع ⏎ العربية الخطوط انواع ⏎ العربية الخط | انواع الخطوط العربية ⏎ انواع الخطوط العربية ⏎ انواع الخطوط ا |
| `G_wipo_saudi_copyright_law_laserwriter8_distiller5_legacy_encoding` | Acrobat Distiller 5.0.5 (Win | no | n=R*« ‚uIŠ W¹ULŠ ÂUE½ ⏎ a¹—UðË © ¥±Ø Â ® r?— wJK*« Âu???Ý | n=�R*« ‚uIŠ W¹ULŠ ÂUE½ ⏎ a¹—UðË © ¥±Ø Â ® r?�— wJK*« Âu???Ýd |

Notable: PDFium silently folds presentation forms to base letters (its output never contains U+FBxx/FExx although 6 of the 15 real-world files map to them), so PDFium's text hides that the ToUnicode maps are wrong for search and copy in other viewers.

## 4. Selects text
All engines expose per-glyph positions; selection *geometry* is available everywhere, but selection *order* follows the extraction order above. The Warraq core returns lines with logical text and bounding boxes (`text_lines`), which the UI uses for its selectable text layer.

## 5. Edits one word and saves without breaking shaping; adds a new Arabic paragraph with a custom font

| Path | Add paragraph | Edit one word | Evidence |
|---|---|---|---|
| PDFium `FPDFText_SetText` / `FPDFText_LoadFont` (pypdfium2 and pdfium-render `set_text`) | ✗ unshaped, characters placed left-to-right | ✗ same | `tests/acid/write-tests/out-pdfium-add-text.png`, `edit-compare.png` row 3 |
| MuPDF `insert_text` | ✗ isolated presentation forms, reversed | n/a | `out-mupdf-add-text.png` |
| MuPDF `insert_htmlbox` (Story engine, HarfBuzz) | render ✓, extraction garbage (broken ToUnicode) | n/a | same; AGPL |
| pdf-lib `drawText` / form field appearance | ✗ almost nothing drawn / unshaped | n/a | `out-pdflib-add-text.png`, corpus `acroform-pdflib-arabic-fields` |
| Python HarfBuzz + own PDF writer (`gen_raw.py`) | ✓ render; PDF.js logical 0.935 | – | corpus `raw-amiri-cid-identity-tounicode` |
| Rust `harfrust` + `unicode-bidi` + `skrifa` + `subsetter` + `pdf-writer` (`prototypes/proto-text write`) | ✓ render; PDF.js logical 0.951, order 0.893 | – | `out-rust-write.pdf` |
| Rust `lopdf` + the same text stack (`prototypes/proto-text edit`, now `warraq-pdf::replace_word`) | – | ✓ `للتقنية` → `للبرمجة`: located through ToUnicode across several TJ operators, replaced by a shaped run in a new subset font; MuPDF reads `العميل: شركة زود للبرمجة` | `out-rust-edit.pdf`, `edit-compare.png` row 2 |

## 6. Performance (page 1 open / render at 1.5× / text of all pages, ms)

| File | pdfium | pdfium-rs | pdfjs | mupdf | hayro | warraq |
|---|---|---|---|---|---|---|
| `perf-text-100-pages` | 3.5 / 19.5 / 216.4 | 12.9 / 29.6 / – | 135.2 / 1628.6 / 10446.5 | 1.1 / 11.4 / 333.6 | 2.2 / 13.1 / – | 1.2 / 4.4 / 218.4 |
| `perf-text-500-pages` | 3.7 / 26.5 / 1102.1 | 7.9 / 8.5 / – | 65.4 / 352.9 / 36692.8 | 2.5 / 10.9 / 1495.5 | 5.8 / 13.8 / – | 4.3 / 4.3 / 1113.1 |

PDFium natively is well inside N8. The Warraq core column is the pure-Rust path (hayro) that also runs in WASM. The 500 MB scanned stress file (`gen_scans.py --large`) has not been run yet.

## 7. Bundle sizes (N8: < 8 MB gzipped)
`pdfium.wasm` 5.32 MB raw / **2.41 MB gzipped**; Warraq core WASM (pure Rust, hayro rasterizer included) 4.78 MB raw / **1.95 MB gzipped**. Tesseract.js core and `ara.traineddata` (12.6 MB) load on demand only.

## 8. What surprised us
1. Chrome's own engine cannot copy Arabic from Chrome's own PDFs in order (Skia writes glyphs in visual order with presentation-form ToUnicode, and U+0000 for contextual forms that have no cmap entry; PDFium's bidi pass does not undo it).
2. Skia embeds **variable** webfonts as Type3 fonts with dotted letters split into skeleton and dot glyphs; only static fonts become CID fonts.
3. CoreText applies the bracket-pair rule (UAX #9 N0), so `(Premium Support) | 12 | 150.00` lands the numbers left of the bracket group, while producers without N0 put them right of it; the same visual glyph order can have two logical readings, which the reconstruction resolves toward a right-to-left human reading.
4. `rustybuzz` is archived; `harfrust` matched HarfBuzz 12.1 glyph for glyph on Amiri.
5. `unicode-bidi` 0.3.18 resolves a European terminator after a number (`15%`) to the paragraph level (rule W5); `warraq-text::bidi` repairs it.
6. MuPDF crashes on a modern Chrome-generated file; `lopdf` 0.45 drops the objects of an AES-256 file.
