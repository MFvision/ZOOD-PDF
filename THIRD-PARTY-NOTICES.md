# Third-party notices

Components shipped in Warraq builds (kept current as components are integrated;
research-only tools such as PyMuPDF, pikepdf and uharfbuzz are not shipped).

| Component | License | Use |
|---|---|---|
| PDFium (pdfium.googlesource.com) and its bundled dependencies (FreeType, libjpeg-turbo, OpenJPEG, libpng, zlib, lcms2, ICU, abseil, agg23, fast_float, simdutf) | BSD-3-Clause and the licenses in `licenses/` of pdfium-binaries | rasterization, forms, annotations |
| pdfium-render | MIT OR Apache-2.0 | Rust binding to PDFium |
| harfrust, read-fonts, skrifa, fontations | MIT OR Apache-2.0 | shaping and font parsing |
| unicode-bidi, unicode-normalization, icu4x crates | MIT OR Apache-2.0 / Unicode-3.0 | bidi, normalization, segmentation |
| subsetter, pdf-writer, krilla | MIT OR Apache-2.0 | font subsetting and PDF writing |
| lopdf | MIT | PDF object model |
| hayro, hayro-syntax, hayro-interpret, vello_cpu | Apache-2.0 OR MIT | content interpretation, optional pure-Rust rasterizer |
| tesseract.js / Tesseract, tessdata_best | Apache-2.0 | OCR |
| Amiri, Cairo, Noto Naskh Arabic, Noto Sans Arabic, IBM Plex Sans Arabic, Tajawal, Scheherazade New, Inter, Noto Sans | SIL OFL-1.1 | bundled fallback and UI fonts |
| Fluent UI System Icons or Lucide | MIT / ISC | icons |
| React, Vite, Tauri | MIT / MIT / Apache-2.0 OR MIT | UI and app shells |
