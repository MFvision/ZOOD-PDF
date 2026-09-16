# Acid-test scores

Candidates: hayro, mupdf, pdfium, pdfium-rs, pdfjs. Word-level scoring, see `tests/acid/score.py`.

| File | hayro: verdict (word recall logical / reversed, order fwd/line-rev) · open+render ms | mupdf: verdict (word recall logical / reversed, order fwd/line-rev) · open+render ms | pdfium: verdict (word recall logical / reversed, order fwd/line-rev) · open+render ms | pdfium-rs: verdict (word recall logical / reversed, order fwd/line-rev) · open+render ms | pdfjs: verdict (word recall logical / reversed, order fwd/line-rev) · open+render ms |
|---|---|---|---|---|---|
| `A_arwikibooks_mediawiki_guide_word2007` | no-truth · 3.0+25.8 ms | no-truth · 5.5+36.1 ms | no-truth · 5.3+8.2 ms | no-truth · 18.0+15.6 ms | no-truth · 13.4+1091.4 ms |
| `A_un_rome_statute_A-CONF.183-9-AR_word_pdfmaker6` | no-truth · 1.5+11.4 ms | no-truth · 2.0+17.3 ms | no-truth · 6.3+2.5 ms | no-truth · 8.5+3.3 ms | no-truth · 2.2+175.8 ms |
| `A_worldbank_malpass_g7_briefing_AR_word2016_pdftools` | no-truth · 0.5+16.2 ms | no-truth · 1.1+10.7 ms | no-truth · 4.1+3.4 ms | no-truth · 7.6+6.0 ms | no-truth · 1.6+180.4 ms |
| `B_baytalhekma_covid_workplace_guide_indesign_cc2015` | no-truth · 3.5+601.4 ms | no-truth · 5.1+98.2 ms | no-truth · 3.1+115.2 ms | no-truth · 7.3+236.4 ms | no-truth · 7.7+29528.7 ms |
| `B_wmf_welcome_to_wikipedia_arabic_indesign_cs5_p1-5` | no-truth · 1.5+41.4 ms | no-truth · 1.3+35.2 ms | no-truth · 1.8+9.5 ms | no-truth · 7.7+18.9 ms | no-truth · 4.2+943.4 ms |
| `C_lo_bug119606_seventeen_macos_arabic_fonts_lo7.5dev` | no-truth · 0.6+11.4 ms | no-truth · 1.2+10.4 ms | no-truth · 5.2+4.7 ms | no-truth · 7.5+9.0 ms | no-truth · 1.6+318.1 ms |
| `C_lo_bug171737_noto_sans_arabic_extraction_lo26.2_pdf2.0` | no-truth · 0.5+11.2 ms | no-truth · 10.7+12.2 ms | no-truth · 3.1+3.3 ms | no-truth · 5.5+8.0 ms | no-truth · 1.4+379.4 ms |
| `D_gdocs_digital_safety_guide_ar_skia_m130` | no-truth · 0.8+17.8 ms | no-truth · 7.0+29.1 ms | no-truth · 5.1+12.0 ms | no-truth · 5.9+18.9 ms | no-truth · 2.4+595 ms |
| `D_gdocs_wmf_rapid_funds_guide_ar_skia_m97` | no-truth · 1.7+44.6 ms | no-truth · 10.2+104.4 ms | no-truth · 5.3+15.3 ms | no-truth · 8.2+26.0 ms | no-truth · 2.8+654.8 ms |
| `E_commons_qarar193_toshiba_estudio_mfp_scan` | no-truth · 0.5+16.9 ms | no-truth · 3.7+20.5 ms | no-truth · 0.7+12.2 ms | no-truth · 1.1+17.9 ms | no-truth · 1.3+13.5 ms |
| `E_commons_tafsir_surat_alnur_pd_scan_p1-3` | no-truth · 0.8+76.2 ms | no-truth · 1.0+29.0 ms | no-truth · 0.5+24.6 ms | no-truth · 1.4+62.3 ms | no-truth · 1.2+3.4 ms |
| `E_ia_bv056_arabic_manuscript_1924_ocr_text_layer` | no-truth · 1.0+195.4 ms | no-truth · 1.9+297.8 ms | no-truth · 1.2+104.6 ms | no-truth · 1.5+135.0 ms | no-truth · 38.7+10.4 ms |
| `F_pdfjs15546_rtl_acroform_textfields_arabic_digits_acrobat` | no-truth · 0.6+4.8 ms | no-truth · 7.5+9.7 ms | no-truth · 1.1+1.1 ms | no-truth · 3.8+3.8 ms | no-truth · 2.3+35.4 ms |
| `G_pdfjs_ArabicCIDTrueType_apple_pstopdffilter_no_tounicode` | no-truth · 0.6+3.2 ms | no-truth · 1.1+6.7 ms | no-truth · 1.5+1.3 ms | no-truth · 1.7+1.8 ms | no-truth · 1+31.3 ms |
| `G_wipo_saudi_copyright_law_laserwriter8_distiller5_legacy_encoding` | no-truth · 0.6+4.2 ms | no-truth · 2.5+9.7 ms | no-truth · 4.5+1.9 ms | no-truth · 3.6+3.3 ms | no-truth · 1.1+17.3 ms |
| `acroform-pdflib-arabic-fields` | garbage (0.08 / 0.14, 0.05/0.10); pres.forms · 1.1+37.5 ms | garbage (0.22 / 0.08, 0.15/0.20) · 5.5+18.8 ms | partial-reversed (0.16 / 0.84, 0.13/0.18) · 60.8+110.7 ms | partial-reversed (0.16 / 0.84, 0.13/0.18) · 9.5+5.7 ms | garbage (0.08 / 0.16, 0.05/0.10); pres.forms · 460.8+901.8 ms |
| `chrome-amiri-tashkeel-ligatures` | garbage (0.07 / 0.47, 0.06/0.06) · 0.6+2.9 ms | ❌ open failed: CRASH exit=-11 (signal 11)  | garbage (0.37 / 0.07, 0.12/0.38) · 4.0+3.0 ms | garbage (0.37 / 0.07, 0.12/0.38) · 1.5+2.0 ms | garbage (0.30 / 0.00, 0.28/0.09) · 2.3+292.5 ms |
| `chrome-cairo-mixed-invoice` | garbage (0.44 / 0.43, 0.38/0.29); pres.forms · 0.4+14.4 ms | partial (0.74 / 0.09, 0.57/0.40) · 1.0+17.8 ms | partial (0.52 / 0.41, 0.41/0.35) · 6.4+4.2 ms | partial (0.52 / 0.41, 0.41/0.35) · 7.0+3.3 ms | partial-reversed (0.46 / 0.54, 0.52/0.25); pres.forms · 3.3+538.8 ms |
| `chrome-ibmplex-bidi-stress` | garbage (0.47 / 0.36, 0.36/0.23); pres.forms · 0.7+4.4 ms | partial (0.76 / 0.01, 0.53/0.35) · 0.9+2.3 ms | partial (0.58 / 0.28, 0.40/0.28) · 3.4+2.2 ms | partial (0.58 / 0.28, 0.40/0.28) · 4.1+3.4 ms | garbage (0.46 / 0.38, 0.36/0.22); pres.forms · 6.3+127.9 ms |
| `chrome-notonaskh-justified-3pages` | garbage (0.05 / 0.07, 0.04/0.05); pres.forms · 0.6+58.1 ms | garbage (0.07 / 0.01, 0.06/0.07) · 1.0+30.6 ms | garbage (0.14 / 0.36, 0.08/0.11) · 14.9+6.6 ms | garbage (0.14 / 0.36, 0.08/0.11) · 10.1+10.5 ms | garbage (0.06 / 0.03, 0.04/0.05); pres.forms · 2.2+1023.7 ms |
| `chrome-notosansarabic-form-layout` | garbage (0.08 / 0.14, 0.05/0.10); pres.forms · 0.8+12.8 ms | garbage (0.22 / 0.08, 0.15/0.20) · 1.2+16.2 ms | partial-reversed (0.16 / 0.84, 0.13/0.18) · 11.6+3.8 ms | partial-reversed (0.16 / 0.84, 0.13/0.18) · 6.4+2.8 ms | garbage (0.08 / 0.16, 0.05/0.10); pres.forms · 2+470.4 ms |
| `chrome-tajawal-persian-urdu-digits` | partial-reversed (0.17 / 0.53, 0.15/0.09); pres.forms · 0.8+2.6 ms | words-ok/order-scrambled (0.97 / 0.03, 0.61/0.48) · 1.0+2.4 ms | partial (0.73 / 0.27, 0.27/0.67) · 1.7+2.8 ms | partial (0.73 / 0.27, 0.27/0.67) · 2.3+2.2 ms | garbage (0.27 / 0.30, 0.21/0.18); pres.forms · 2.2+141.7 ms |
| `chrome-windows-arial-tahoma-times` | garbage (0.44 / 0.37, 0.38/0.29); pres.forms · 0.7+5.3 ms | partial (0.87 / 0.09, 0.65/0.41) · 0.9+4.2 ms | partial (0.65 / 0.39, 0.41/0.43) · 4.9+7.3 ms | partial (0.65 / 0.39, 0.41/0.43) · 3.0+3.5 ms | garbage (0.46 / 0.33, 0.52/0.25); pres.forms · 20.8+144.5 ms |
| `coretext-albayan-tashkeel` | partial-reversed (0.13 / 0.67, 0.03/0.12) · 0.5+3.9 ms | partial (0.63 / 0.13, 0.62/0.22) · 0.9+5.7 ms | garbage (0.30 / 0.30, 0.12/0.28) · 11.4+1.9 ms | garbage (0.30 / 0.30, 0.12/0.28) · 3.4+1.9 ms | partial (0.67 / 0.13, 0.25/0.69) · 2.6+80.1 ms |
| `coretext-baghdad-persian-urdu` | partial-reversed (0.10 / 0.83, 0.09/0.06) · 0.6+4.5 ms | logical (0.97 / 0.00, 0.88/0.27) · 0.9+6.7 ms | words-ok/line-order-visual (1.00 / 0.00, 0.27/0.94) · 3.9+11.6 ms | words-ok/line-order-visual (1.00 / 0.00, 0.27/0.94) · 2.0+2.5 ms | partial (0.87 / 0.00, 0.27/0.82) · 3+80.5 ms |
| `coretext-geezapro-paragraphs` | partial-reversed (0.07 / 0.65, 0.04/0.06) · 0.5+12.9 ms | partial (0.72 / 0.01, 0.64/0.16) · 1.0+5.6 ms | partial (0.73 / 0.02, 0.13/0.76) · 9.7+10.8 ms | partial (0.73 / 0.02, 0.13/0.76) · 3.1+5.0 ms | partial (0.79 / 0.01, 0.13/0.82) · 4.4+242.7 ms |
| `coretext-sfarabic-mixed-invoice` | partial-reversed (0.43 / 0.56, 0.46/0.23) · 0.5+3.8 ms | words-ok/order-scrambled (0.91 / 0.11, 0.52/0.60) · 0.8+4.2 ms | words-ok/order-scrambled (0.94 / 0.07, 0.52/0.62) · 3.9+22.2 ms | words-ok/order-scrambled (0.94 / 0.07, 0.52/0.62) · 2.2+2.6 ms | words-ok/order-scrambled (0.94 / 0.07, 0.52/0.63) · 42.1+51.9 ms |
| `perf-text-100-pages` | no-truth · 1.8+79.9 ms | no-truth · 3.8+37.2 ms | no-truth · 16.1+8.4 ms | no-truth · 8.8+11.2 ms | no-truth · 74.6+612.7 ms |
| `perf-text-500-pages` | no-truth · 5.2+69.3 ms | no-truth · 3.1+31.4 ms | no-truth · 15.6+6.8 ms | no-truth · 8.2+10.4 ms | no-truth · 36+590.3 ms |
| `raw-amiri-cid-identity-tounicode` | partial-reversed (0.40 / 0.58, 0.38/0.21) · 1.0+9.2 ms | partial (0.79 / 0.05, 0.58/0.31) · 4.9+12.1 ms | partial (0.85 / 0.06, 0.43/0.57) · 1.9+3.6 ms | partial (0.85 / 0.06, 0.43/0.57) · 1.6+3.7 ms | logical (0.94 / 0.04, 0.90/0.23) · 1.9+92.2 ms |
| `raw-amiri-cid-no-tounicode` | empty (0.00 / 0.00, 0.00/0.00) · 0.5+11.9 ms | garbage (0.01 / 0.01, 0.01/0.01) · 1.1+5.5 ms | garbage (0.01 / 0.01, 0.01/0.01) · 2.7+3.3 ms | garbage (0.01 / 0.01, 0.01/0.01) · 1.6+3.2 ms | garbage (0.01 / 0.01, 0.01/0.01) · 1.7+233.9 ms |
| `raw-cairo-cid-broken-tounicode` | empty (0.00 / 0.00, 0.00/0.00); U+FFFD×851 · 0.3+6.8 ms | garbage (0.00 / 0.00, 0.00/0.00) · 1.2+11.3 ms | empty (0.00 / 0.00, 0.00/0.00); U+FFFD×850 · 6.9+2.2 ms | empty (0.00 / 0.00, 0.00/0.00); U+FFFD×850 · 1.4+3.3 ms | empty (0.00 / 0.00, 0.00/0.00); U+FFFD×851 · 2.3+39.8 ms |
| `raw-legacy-symbolic-truetype` | garbage (0.00 / 0.00, 0.00/0.00) · 0.6+7.7 ms | garbage (0.02 / 0.02, 0.03/0.03) · 1.1+5.1 ms | garbage (0.02 / 0.02, 0.03/0.03) · 1.0+1.8 ms | garbage (0.02 / 0.02, 0.03/0.03) · 0.9+3.1 ms | garbage (0.02 / 0.02, 0.03/0.03) · 2.2+99 ms |
| `reportlab-visual-presentation-forms` | partial-reversed (0.35 / 0.61, 0.35/0.21); pres.forms · 0.4+4.2 ms | logical (0.96 / 0.06, 0.79/0.32); pres.forms · 1.8+6.7 ms | partial (0.82 / 0.10, 0.40/0.62) · 226.5+1.8 ms | partial (0.82 / 0.10, 0.40/0.62) · 331.8+2.9 ms | logical (1.00 / 0.05, 0.92/0.28); pres.forms · 1.7+32.6 ms |
| `scan-arial-200dpi-bilevel` | image-only (OCR needed) · 0.5+120.0 ms | image-only (OCR needed) · 1.1+15.4 ms | image-only (OCR needed) · 3.4+116.0 ms | image-only (OCR needed) · 0.8+14.7 ms | image-only (OCR needed) · 1.6+311.3 ms |
| `scan-notonaskh-300dpi-skewed-jpeg` | image-only (OCR needed) · 1.6+48.1 ms | image-only (OCR needed) · 1.3+30.7 ms | image-only (OCR needed) · 1.3+25.1 ms | image-only (OCR needed) · 2.4+35.4 ms | image-only (OCR needed) · 2.8+18829.6 ms |
| `variant-arabic-metadata-outlines-annots` | garbage (0.05 / 0.07, 0.04/0.05); pres.forms · 0.5+69.5 ms | garbage (0.07 / 0.01, 0.06/0.07) · 10.0+45.6 ms | garbage (0.14 / 0.36, 0.08/0.11) · 5.4+11.1 ms | garbage (0.14 / 0.36, 0.08/0.11) · 9.4+11.6 ms | garbage (0.06 / 0.03, 0.04/0.05); pres.forms · 11.4+1102.5 ms |
| `variant-encrypted-aes256` | ❌ open failed: Decryption(PasswordProtected) | garbage (0.07 / 0.01, 0.06/0.07) · 38.5+39.8 ms | garbage (0.14 / 0.36, 0.08/0.11) · 10.7+6.0 ms | garbage (0.14 / 0.36, 0.08/0.11) · 18.4+10.6 ms | garbage (0.06 / 0.03, 0.04/0.05); pres.forms · 836.9+1371.8 ms |
| `variant-incremental-update` | garbage (0.44 / 0.43, 0.38/0.29); pres.forms · 0.5+19.5 ms | partial (0.74 / 0.09, 0.57/0.40) · 1.9+20.8 ms | partial (0.52 / 0.41, 0.41/0.35) · 5.4+2.0 ms | partial (0.52 / 0.41, 0.41/0.35) · 8.9+3.5 ms | partial-reversed (0.46 / 0.54, 0.52/0.25); pres.forms · 1.6+308 ms |
| `variant-linearized` | garbage (0.05 / 0.07, 0.04/0.05); pres.forms · 1.0+97.7 ms | garbage (0.07 / 0.01, 0.06/0.07) · 1.0+37.4 ms | garbage (0.14 / 0.36, 0.08/0.11) · 4.8+6.0 ms | garbage (0.14 / 0.36, 0.08/0.11) · 8.9+11.4 ms | garbage (0.06 / 0.03, 0.04/0.05); pres.forms · 2+414.7 ms |
| `variant-objectstreams-xrefstream` | garbage (0.05 / 0.07, 0.04/0.05); pres.forms · 0.6+83.4 ms | garbage (0.07 / 0.01, 0.06/0.07) · 1.4+48.2 ms | garbage (0.14 / 0.36, 0.08/0.11) · 4.7+6.0 ms | garbage (0.14 / 0.36, 0.08/0.11) · 10.3+12.0 ms | garbage (0.06 / 0.03, 0.04/0.05); pres.forms · 4.3+394.6 ms |

## Verdict tally per candidate

- **hayro**: empty: 2, garbage: 12, image-only (OCR needed): 2, no-truth: 17, open-failed: 1, partial-reversed: 7
- **mupdf**: garbage: 10, image-only (OCR needed): 2, logical: 2, no-truth: 17, open-failed: 1, partial: 7, words-ok/order-scrambled: 2
- **pdfium**: empty: 1, garbage: 9, image-only (OCR needed): 2, no-truth: 17, partial: 8, partial-reversed: 2, words-ok/line-order-visual: 1, words-ok/order-scrambled: 1
- **pdfium-rs**: empty: 1, garbage: 9, image-only (OCR needed): 2, no-truth: 17, partial: 8, partial-reversed: 2, words-ok/line-order-visual: 1, words-ok/order-scrambled: 1
- **pdfjs**: empty: 1, garbage: 13, image-only (OCR needed): 2, logical: 2, no-truth: 17, partial: 3, partial-reversed: 2, words-ok/order-scrambled: 1

## Performance (page 1 open + render, and full-document text extraction)

| File | hayro | mupdf | pdfium | pdfium-rs | pdfjs |
|---|---|---|---|---|---|
| `perf-text-100-pages` | open 1.8 ms, render 79.9 ms, text(all) ? ms | open 3.8 ms, render 37.2 ms, text(all) 1350.8 ms | open 16.1 ms, render 8.4 ms, text(all) 253.7 ms | open 8.8 ms, render 11.2 ms, text(all) ? ms | open 74.6 ms, render 612.7 ms, text(all) 6803.2 ms |
| `perf-text-500-pages` | open 5.2 ms, render 69.3 ms, text(all) ? ms | open 3.1 ms, render 31.4 ms, text(all) 9277.6 ms | open 15.6 ms, render 6.8 ms, text(all) 1192.5 ms | open 8.2 ms, render 10.4 ms, text(all) ? ms | open 36 ms, render 590.3 ms, text(all) 35418.6 ms |
