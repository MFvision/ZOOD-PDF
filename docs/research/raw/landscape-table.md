# Phase 0 GitHub landscape audit (Warraq)

Generated 2026-09-16T03:49:44Z from live API/web responses only (see `landscape.json` for full records and per-field source URLs). Stars/forks/issues are GitHub API values at fetch time; `open_issues` includes pull requests (GitHub API semantics). The Arabic/RTL count is `total_count` of `search/issues?q=repo:{owner}/{repo} arabic OR rtl OR bidi` (issues AND pull requests, all states).

## Rendering

| Name | Repo | License | Lang | Stars | Last push | Open issues | Arabic/RTL issues (count) | WASM | Notes |
|---|---|---|---|---|---|---|---|---|---|
| pdf.js | mozilla/pdf.js | Apache-2.0 | JavaScript | 53878 | 2026-09-15 | 421 | 285 | JavaScript library itself (not WASM); official npm pdfjs-dist. README has no WASM mention. |  |
| PDFium (GitHub mirror of pdfium.googlesource.com) | chromium/pdfium | BSD-3-Clause AND Apache-2.0 (both texts in LICENSE) | C++ | 543 | 2025-11-19 | 5 | 0 | Upstream C++ source; official experimental WASM build distributed by bblanchon/pdfium-binaries (pdfium-wasm.t… | ARCHIVED; API spdx=NOASSERTION |
| pdfium-binaries | bblanchon/pdfium-binaries | MIT | Shell | 1473 | 2026-09-14 | 37 | 0 | Official experimental WebAssembly build: README lists 'pdfium-wasm.tgz' and NuGet bblanchon.PDFium.WebAssembl… |  |
| pdfium-render | ajrcarey/pdfium-render | MIT OR Apache-2.0 | Rust | 705 | 2026-08-16 | 11 | 0 | README: 'a Rust application using pdfium-render can be compiled to WASM for running in a browser alongside a … | API spdx=NOASSERTION |
| pypdfium2 | pypdfium2-team/pypdfium2 | Apache-2.0 OR BSD-3-Clause | Python | 821 | 2026-09-09 | 3 | 0 | Python binding; README has no WASM mention (not applicable). |  |
| embed-pdf-viewer | embedpdf/embed-pdf-viewer | Apache-2.0 | TypeScript | 4484 | 2026-09-15 | 224 | 4 | Official npm @embedpdf/pdfium ('PDFium WebAssembly for the web platform') + @embedpdf/engines; engine is Embe… | API spdx=NOASSERTION; commercial/tiered terms - see license_notes |
| @hyzyla/pdfium | hyzyla/pdfium | MIT | TypeScript | 186 | 2026-06-20 | 10 | 0 | README: 'TypeScript/JavaScript wrapper for the WebAssembly build of PDFium library' (built from paulocoutinho… |  |
| MuPDF | ArtifexSoftware/mupdf | AGPL-3.0-or-later | C | 2961 | 2026-09-15 | 14 | 0 | Official WASM via MuPDF.js (npm mupdf): README of mupdf.js: 'wraps the MuPDF C engine in WebAssembly'. | COPYLEFT; GitHub issues disabled (mirror); API spdx=AGPL-3.0; commercial/tiered terms - see license_notes |
| mupdf.js | ArtifexSoftware/mupdf.js | AGPL-3.0-or-later |  | 609 | 2026-07-01 | 11 | 0 | Official WASM build: README 'wraps the MuPDF C engine in WebAssembly, so the same high-fidelity rendering run… | COPYLEFT; API spdx=AGPL-3.0; commercial/tiered terms - see license_notes |
| Poppler | https://gitlab.freedesktop.org/poppler/poppler | GPL-2.0 / GPL-3.0 (COPYING = GPL v2 text; COPYING3 = GPL v3 text) | C++ (not reported by GitLab API in this fetch) | 72 | 2026-09-16 |  | GitLab: arabic=6 rtl=13 bidi=0 | unknown (no official WASM build found in fetched README; not verified) | COPYLEFT; commercial/tiered terms - see license_notes |
| pdf-rs | pdf-rs/pdf | MIT | Rust | 1697 | 2026-07-18 | 51 | 0 | Rust crate; README has no WASM mention (wasm32 support unverified). |  |
| hayro | LaurenzV/hayro | Apache-2.0 OR MIT | Rust | 765 | 2026-09-08 | 50 | 0 | Rust crate; README has no WASM mention (wasm32 support unverified). | API spdx=Apache-2.0 |
| typst | typst/typst | Apache-2.0 | Rust | 56041 | 2026-09-15 | 1295 | 166 | README has no WASM mention; community npm ports exist: @myriaddreamin/typst.ts (npm @myriaddreamin/typst.ts@0… |  |

## PDF read/write/edit

| Name | Repo | License | Lang | Stars | Last push | Open issues | Arabic/RTL issues (count) | WASM | Notes |
|---|---|---|---|---|---|---|---|---|---|
| qpdf | qpdf/qpdf | Apache-2.0 | C++ | 5417 | 2026-09-06 | 171 | 6 | README has no WASM mention; community builds on npm: qpdf-wasm (npm qpdf-wasm@0.1.0 unpackedSize 2,317,089 B,… |  |
| pdfcpu | pdfcpu/pdfcpu | Apache-2.0 | Go | 8838 | 2026-09-14 | 121 | 4 | Go; README has no WASM mention; community npm pdfcpu-wasm ('pdfcpu compiled to WASM', npm pdfcpu-wasm@0.1.0 u… |  |
| PDFBox | apache/pdfbox | Apache-2.0 | Java | 3119 | 2026-09-15 | 41 | 4 | Java; not applicable (no WASM mention in README). | GitHub issues disabled (mirror) |
| lopdf | J-F-Liu/lopdf | MIT | Rust | 2251 | 2026-09-12 | 86 | 3 | Rust crate; README feature table references wasm targets ('bundled into the binary on Windows and on any wasm… |  |
| pdf-writer | typst/pdf-writer | MIT OR Apache-2.0 | Rust | 741 | 2026-08-17 | 11 | 1 | Rust crate; README has no WASM mention (wasm32 support unverified). | API spdx=Apache-2.0 |
| krilla | LaurenzV/krilla | MIT OR Apache-2.0 | Rust | 444 | 2026-09-14 | 22 | 5 | Rust crate; README has no WASM mention (wasm32 support unverified). | API spdx=Apache-2.0 |
| pdf-lib | Hopding/pdf-lib | MIT | TypeScript | 8632 | 2024-07-17 | 317 | 11 | Pure JavaScript/TypeScript (runs in browser natively); not applicable. |  |
| @cantoo/pdf-lib | cantoo-scribe/pdf-lib | MIT | TypeScript | 349 | 2026-09-11 | 13 | 0 | Pure JavaScript/TypeScript fork of pdf-lib; not applicable. |  |
| pypdf | py-pdf/pypdf | BSD-3-Clause | Python | 10204 | 2026-09-15 | 135 | 48 | Python; README has no WASM mention (not applicable/unknown). | API spdx=NOASSERTION |
| pikepdf | pikepdf/pikepdf | MPL-2.0 | Python | 2799 | 2026-09-06 | 18 | 2 | Python + C++ (qpdf); README has no WASM mention (not applicable/unknown). | COPYLEFT |
| PyMuPDF | pymupdf/PyMuPDF | AGPL-3.0 | Python | 10717 | 2026-09-15 | 60 | 33 | Python; README has no WASM mention (use mupdf.js for WASM). | COPYLEFT; commercial/tiered terms - see license_notes |
| pdfkit | foliojs/pdfkit | MIT | JavaScript | 10704 | 2026-09-14 | 327 | 24 | Pure JavaScript; not applicable. |  |
| printpdf | fschutt/printpdf | MIT | Rust | 1113 | 2026-09-05 | 15 | 4 | README: 'See the WASM32 demo live at: https://fschutt.github.io/printpdf'. |  |
| iText 7 (itext-java) | itext/itext-java | AGPL-3.0-or-later | Java | 2256 | 2026-09-14 | 77 | 0 | Java; not applicable. | COPYLEFT; GitHub issues disabled (mirror); API spdx=NOASSERTION; commercial/tiered terms - see license_notes |
| pdfminer.six | pdfminer/pdfminer.six | MIT | Python | 7022 | 2026-03-13 | 234 | 6 | Python; README has no WASM mention (not applicable/unknown). |  |

## Text shaping & bidi & fonts

| Name | Repo | License | Lang | Stars | Last push | Open issues | Arabic/RTL issues (count) | WASM | Notes |
|---|---|---|---|---|---|---|---|---|---|
| HarfBuzz | harfbuzz/harfbuzz | MIT-Modern-Variant | C++ | 6083 | 2026-09-16 | 92 | 255 | Official emscripten build harfbuzzjs (harfbuzz/harfbuzzjs; npm harfbuzzjs npm harfbuzzjs@1.6.1 unpackedSize 1… | API spdx=NOASSERTION |
| rustybuzz | harfbuzz/rustybuzz | MIT | Rust | 667 | 2026-07-26 | 3 | 29 | Rust crate (archived); README has no WASM mention. | ARCHIVED; successor: harfbuzz/harfrust |
| HarfRust (rustybuzz successor) | harfbuzz/harfrust | MIT | Rust | 301 | 2026-09-10 | 27 | 17 | Rust crate; README has no WASM mention (wasm32 support unverified). |  |
| ttf-parser | harfbuzz/ttf-parser | MIT OR Apache-2.0 | Rust | 792 | 2026-08-06 | 5 | 2 | README: 'no_std/WASM compatible'. | API spdx=Apache-2.0 |
| unicode-bidi | servo/unicode-bidi | MIT OR Apache-2.0 | Rust | 87 | 2026-09-15 | 9 | 85 | Rust crate; README has no WASM mention (pure Rust; wasm32 unverified). | API spdx=NOASSERTION |
| fontkit | foliojs/fontkit | MIT | JavaScript | 1670 | 2024-08-14 | 165 | 19 | Pure JavaScript ('font engine for Node and the browser'); not applicable. |  |
| subsetter | typst/subsetter | MIT OR Apache-2.0 | Rust | 56 | 2026-07-23 | 0 | 0 | Rust crate; README has no WASM mention (wasm32 support unverified). | API spdx=Apache-2.0 |
| fontations (skrifa/read-fonts) | googlefonts/fontations | MIT OR Apache-2.0 | Rust | 826 | 2026-09-16 | 240 | 10 | Rust crates; README has no WASM mention (wasm32 support unverified). | API spdx=Apache-2.0 |
| allsorts | yeslogic/allsorts | Apache-2.0 | Rust | 802 | 2026-05-13 | 29 | 8 | README: 'prefer the Rust backend for a pure Rust solution when compiling to WASM'. |  |
| parley | linebender/parley | Apache-2.0 OR MIT | Rust | 735 | 2026-09-16 | 128 | 112 | Rust crate; README has no WASM mention (wasm32 support unverified). | API spdx=Apache-2.0 |
| cosmic-text | pop-os/cosmic-text | MIT OR Apache-2.0 | Rust | 2148 | 2026-08-08 | 135 | 49 | Rust crate; README has no WASM mention (wasm32 support unverified). | API spdx=Apache-2.0 |
| ICU4X | unicode-org/icu4x | Unicode-3.0 | Rust | 1861 | 2026-09-15 | 739 | 135 | Rust crates; README has no WASM mention (wasm32 support unverified). | API spdx=NOASSERTION |
| harfbuzzjs | harfbuzz/harfbuzzjs | MIT | TypeScript | 286 | 2026-09-10 | 1 | 10 | This IS the WASM build of HarfBuzz (README build instructions use emscripten); npm harfbuzzjs npm harfbuzzjs@… |  |

## OCR

| Name | Repo | License | Lang | Stars | Last push | Open issues | Arabic/RTL issues (count) | WASM | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Tesseract | tesseract-ocr/tesseract | Apache-2.0 | C++ | 76505 | 2026-09-11 | 484 | 211 | Community WASM port tesseract.js / tesseract.js-core (npm tesseract.js-core npm tesseract.js-core@6.1.2 unpac… |  |
| tessdata_best | tesseract-ocr/tessdata_best | Apache-2.0 |  | 1586 | 2024-03-09 | 26 | 6 | Data files (traineddata), consumable by tesseract.js; ara.traineddata 12603724 bytes. |  |
| tesseract.js | naptha/tesseract.js | Apache-2.0 | JavaScript | 38707 | 2026-05-17 | 53 | 10 | README: 'works by wrapping a WebAssembly port of Tesseract' (tesseract.js-core); npm tesseract.js npm tessera… |  |
| OCRmyPDF | ocrmypdf/OCRmyPDF | MPL-2.0 | Python | 34771 | 2026-09-16 | 95 | 23 | Python CLI/pipeline; README has no WASM mention (not applicable). | COPYLEFT |
| PaddleOCR | PaddlePaddle/PaddleOCR | Apache-2.0 | Python | 89608 | 2026-07-22 | 245 | 143 | README has no WASM mention; npm @paddle-js-models/ocr exists (npm @paddle-js-models/ocr@4.1.1 unpackedSize 2,… |  |
| docTR | mindee/doctr | Apache-2.0 | Python | 6347 | 2026-09-15 | 22 | 16 | Python; README has no WASM mention (unknown). |  |
| surya | datalab-to/surya | Apache-2.0 | Python | 21392 | 2026-09-11 | 198 | 15 | Python/PyTorch; README has no WASM mention (not applicable). | code Apache-2.0; weights OpenRAIL-M (not copyleft, but use-restricted); redirected from VikParuchuri/surya; commercial/tiered terms - see license_notes |
| EasyOCR | JaidedAI/EasyOCR | Apache-2.0 | Python | 29993 | 2025-12-05 | 530 | 71 | Python/PyTorch; README has no WASM mention (not applicable). |  |
| RapidOCR | RapidAI/RapidOCR | Apache-2.0 | Python | 7841 | 2026-09-16 | 25 | 6 | Python/ONNX; README has no WASM mention (unknown). |  |
| ocrs | robertknight/ocrs | Apache-2.0 | Rust | 1886 | 2026-09-13 | 21 | 1 | README: 'easy to compile and run across a variety of platforms, including WebAssembly'. |  |

## Conversion

| Name | Repo | License | Lang | Stars | Last push | Open issues | Arabic/RTL issues (count) | WASM | Notes |
|---|---|---|---|---|---|---|---|---|---|
| LibreOffice core (mirror) | LibreOffice/core | MPL-2.0 | C++ | 4365 | 2026-09-15 | 0 | 0 | README has no WASM mention; npm 'libreoffice-wasm' does not exist (404). Official WASM build status unverifie… | COPYLEFT; GitHub issues disabled (mirror); API spdx=GPL-3.0 |
| pdf2docx | ArtifexSoftware/pdf2docx | MIT | Python | 3519 | 2026-05-01 | 89 | 7 | Python; not applicable. | relicensed MIT (not copyleft); redirected from dothinking/pdf2docx |
| docx4j | plutext/docx4j | Apache-2.0 | Java | 2382 | 2026-09-16 | 204 | 10 | Java; not applicable. |  |
| pandoc | jgm/pandoc | GPL-2.0-or-later | Haskell | 46296 | 2026-09-16 | 1040 | 152 | README: 'a WebAssembly-based online demo (pandoc.org/app)'; community npm pandoc-wasm (npm pandoc-wasm@1.1.0 … | COPYLEFT; API spdx=GPL-2.0 |
| docx-rs | bokuweb/docx-rs | MIT | Rust | 553 | 2026-09-05 | 70 | 3 | Official WASM bindings: README badge/install 'docx-wasm' (npm docx-wasm npm docx-wasm@0.4.23-rc1 unpackedSize… |  |
| ONLYOFFICE DocumentServer | ONLYOFFICE/DocumentServer | AGPL-3.0 | Shell | 6906 | 2026-07-22 | 1140 | 62 | Server-side document server; not applicable. | COPYLEFT |
| Stirling-PDF | Stirling-Tools/Stirling-PDF | MIT | TypeScript | 92266 | 2026-09-16 | 623 | 44 | Server-side (Java/Spring) web app; not applicable. | MIT open-core with proprietary directories (not copyleft); API spdx=NOASSERTION; commercial/tiered terms - see license_notes |
| marker | datalab-to/marker | Apache-2.0 | Python | 39767 | 2026-09-13 | 471 | 5 | Python/PyTorch; README has no WASM mention (not applicable). | code Apache-2.0; weights OpenRAIL-M (not copyleft, but use-restricted); redirected from VikParuchuri/marker; commercial/tiered terms - see license_notes |

## Complete editors / tool suites

| Name | Repo | License | Lang | Stars | Last push | Open issues | Arabic/RTL issues (count) | WASM | Notes |
|---|---|---|---|---|---|---|---|---|---|
| PDF Arranger | pdfarranger/pdfarranger | GPL-3.0 | Python | 5878 | 2026-09-01 | 86 | 7 | Desktop (Python/GTK); not applicable. | COPYLEFT |
| Xournal++ | xournalpp/xournalpp | GPL-2.0 | C++ | 15376 | 2026-09-13 | 1254 | 14 | Desktop (C++/GTK); README has no WASM mention; not applicable. | COPYLEFT |
| Okular | KDE/okular | GPL-2.0-or-later | C++ | 1510 | 2026-09-16 | 0 | 0 | Desktop (Qt/KDE); not applicable. | COPYLEFT; GitHub issues disabled (mirror) |
| sioyek | ahrm/sioyek | GPL-3.0 | C | 9865 | 2026-08-18 | 328 | 12 | Desktop (C++/Qt); not applicable. | COPYLEFT |
| PDFsam Basic | torakiki/pdfsam | AGPL-3.0 | Java | 4568 | 2026-08-10 | 123 | 5 | Desktop (Java); not applicable. | COPYLEFT |

## Digital signatures

| Name | Repo | License | Lang | Stars | Last push | Open issues | Arabic/RTL issues (count) | WASM | Notes |
|---|---|---|---|---|---|---|---|---|---|
| pyHanko | MatthiasValvekens/pyHanko | MIT | Python | 766 | 2026-09-14 | 5 | 1 | Python; README has no WASM mention (not applicable). |  |
| DSS (eSig) | esig/dss | LGPL-2.1 | Java | 1031 | 2026-08-28 | 3 | 0 | Java; not applicable. | COPYLEFT; GitHub issues disabled (mirror) |
| rustls | rustls/rustls | Apache-2.0 OR ISC OR MIT | Rust | 7621 | 2026-09-16 | 86 | 2 | Rust; README has no WASM mention (wasm32 support unverified). | API spdx=NOASSERTION |
| RustCrypto formats (cms, x509-cert) | RustCrypto/formats | Apache-2.0 OR MIT | Rust | 335 | 2026-09-14 | 65 | 0 | Rust; README has no WASM mention (pure Rust crates; wasm32 unverified). |  |
| pdfsign | digitorus/pdfsign | BSD-2-Clause | Go | 167 | 2026-09-14 | 9 | 1 | Go; README has no WASM mention (unknown). |  |
| OpenSSL | openssl/openssl | Apache-2.0 | C | 30787 | 2026-09-15 | 1550 | 67 | C; README has no WASM mention (community emscripten builds not checked). |  |

## App shells

| Name | Repo | License | Lang | Stars | Last push | Open issues | Arabic/RTL issues (count) | WASM | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Tauri | tauri-apps/tauri | Apache-2.0 | Rust | 111096 | 2026-09-15 | 1464 | 65 | App shell (Rust + webview); README has no WASM mention; not applicable. |  |
| Electron | electron/electron | MIT | C++ | 123087 | 2026-09-16 | 773 | 86 | App shell; not applicable. |  |
| Vite | vitejs/vite | MIT | TypeScript | 82842 | 2026-09-16 | 774 | 19 | Build tool; not applicable. |  |
| Astro | withastro/astro | MIT | TypeScript | 62603 | 2026-09-16 | 86 | 19 | Web framework; not applicable. | API spdx=NOASSERTION |
| Next.js | vercel/next.js | MIT | JavaScript | 142332 | 2026-09-16 | 3356 | 93 | Web framework; not applicable. |  |

## UI assets

| Name | Repo | License | Lang | Stars | Last push | Open issues | Arabic/RTL issues (count) | WASM | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Fluent UI System Icons | microsoft/fluentui-system-icons | MIT | HTML | 10838 | 2026-09-11 | 211 | 71 | Icon assets; not applicable. |  |
| Lucide | lucide-icons/lucide | ISC | TypeScript | 24534 | 2026-09-14 | 466 | 6 | Icon assets; not applicable. | API spdx=NOASSERTION |
| Google Fonts: Cairo | google/fonts (ofl/cairo) | OFL-1.1 | font |  |  |  |  | not applicable (font files) |  |
| Google Fonts: Amiri | google/fonts (ofl/amiri) | OFL-1.1 | font |  |  |  |  | not applicable (font files) |  |
| Google Fonts: Noto Naskh Arabic | google/fonts (ofl/notonaskharabic) | OFL-1.1 | font |  |  |  |  | not applicable (font files) |  |
| Google Fonts: Tajawal | google/fonts (ofl/tajawal) | OFL-1.1 | font |  |  |  |  | not applicable (font files) |  |
| Google Fonts: IBM Plex Sans Arabic | google/fonts (ofl/ibmplexsansarabic) | OFL-1.1 | font |  |  |  |  | not applicable (font files) |  |

## Search: 'pdf editor arabic' (top 5 by stars)

| Name | Repo | License | Lang | Stars | Last push | Open issues | Arabic/RTL issues (count) | WASM | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Hyp4tia/Osh | Hyp4tia/Osh | GPL-3.0 | Swift | 3 | 2026-09-03 | 0 |  | unknown |  |
| ohaigoune-debug/nova-pdf-studio | ohaigoune-debug/nova-pdf-studio | MIT | TypeScript | 1 | 2026-09-06 | 0 |  | unknown |  |
| atom-tech9/scripto | atom-tech9/scripto | MIT | TypeScript | 1 | 2026-09-04 | 0 |  | unknown |  |
| RaqmiShop1/ArabicPdfEditor | RaqmiShop1/ArabicPdfEditor | none detected |  | 0 | 2026-08-25 | 0 |  | unknown |  |
| emrecanuzum/arabic-pdf-editor | emrecanuzum/arabic-pdf-editor | none detected | Python | 0 | 2025-12-07 | 0 |  | unknown |  |

## Search: 'rtl pdf' (top 5 by stars)

| Name | Repo | License | Lang | Stars | Last push | Open issues | Arabic/RTL issues (count) | WASM | Notes |
|---|---|---|---|---|---|---|---|---|---|
| omaralalwi/Gpdf | omaralalwi/Gpdf | MIT | PHP | 157 | 2026-08-27 | 1 |  | unknown |  |
| wmahfoudh/oryx | wmahfoudh/oryx | GPL-3.0 | Rust | 105 | 2026-09-08 | 2 |  | unknown |  |
| iyulab/unpdf | iyulab/unpdf | MIT | Rust | 55 | 2026-09-11 | 0 |  | unknown |  |
| isArman/scientific-fa-translation-skill | isArman/scientific-fa-translation-skill | MIT | Python | 40 | 2026-09-14 | 1 |  | unknown |  |
| Ho3seinTork/Persian-Text-to-PDF-Converter | Ho3seinTork/Persian-Text-to-PDF-Converter | MIT | HTML | 39 | 2025-12-08 | 2 |  | unknown |  |

## npm package sizes (registry.npmjs.org)

| Package | Latest | unpackedSize (bytes) | License | Published |
|---|---|---|---|---|
| pdfjs-dist | 6.3.289 | 34,781,083 | Apache-2.0 | 2026-08-29 |
| @hyzyla/pdfium | 2.1.13 | 11,246,019 | MIT | 2026-05-12 |
| @embedpdf/pdfium | 2.15.0 | 7,541,172 | MIT | 2026-08-04 |
| @embedpdf/engines | 2.15.0 | 4,014,315 | MIT | 2026-08-04 |
| pdf-lib | 1.17.1 | 19,461,112 | MIT | 2021-11-06 |
| @cantoo/pdf-lib | 2.11.1 | 26,301,363 | MIT | 2026-09-15 |
| mupdf | 1.28.1 | 14,324,000 | AGPL-3.0-or-later | 2026-09-06 |
| tesseract.js | 7.0.0 | 1,411,341 | Apache-2.0 | 2025-12-15 |
| tesseract.js-core | 6.1.2 | 30,606,788 | Apache-2.0 | 2025-12-15 |
| @jspawn/qpdf-wasm | 0.0.2 | 1,340,135 | Apache-2.0 | 2022-07-26 |
| qpdf-wasm | 0.1.0 | 2,317,089 | Apache-2.0 | 2025-07-26 |
| pdfium-wasm | 0.0.2 | 5,991,759 | ISC | 2018-06-16 |
| fontkit | 2.0.4 | 5,610,637 | MIT | 2024-08-09 |
| harfbuzzjs | 1.6.1 | 1,238,713 | MIT | 2026-08-31 |
| @pdfme/pdf-lib | 6.1.12 | 2,171,154 | MIT | 2026-07-23 |
| @pdf-lib/fontkit | 1.1.1 | 4,299,890 | MIT | 2020-11-28 |

Additional WASM-port packages checked: docx-wasm=0.4.23-rc1 (9,684,512 B, MIT); @myriaddreamin/typst.ts=0.7.0 (1,414,268 B, Apache-2.0); pandoc-wasm=1.1.0 (58,617,582 B, GPL-2.0-or-later); @paddle-js-models/ocr=4.1.1 (2,914,447 B, ISC); typst-wasm=1.0.0 (24,465,391 B, MIT); libreoffice-wasm=not on npm (404); @ocrs/ocrs=not on npm (404); pdfcpu-wasm=0.1.0 (30,146,996 B, MIT)

## crates.io metadata

| Crate | max_version | License | Downloads (all-time) | Recent (90d) | Repository | Updated |
|---|---|---|---|---|---|---|
| rustybuzz | 0.20.1 | MIT | 30,140,693 | 9,805,463 | https://github.com/harfbuzz/rustybuzz | 2024-11-12 |
| ttf-parser | 0.25.1 | MIT OR Apache-2.0 | 105,929,169 | 27,865,184 | https://github.com/harfbuzz/ttf-parser | 2024-11-29 |
| unicode-bidi | 0.3.18 | MIT OR Apache-2.0 | 502,263,601 | 76,258,834 | https://github.com/servo/unicode-bidi | 2024-12-16 |
| subsetter | 0.2.6 | MIT OR Apache-2.0 | 5,525,428 | 3,023,231 | https://github.com/typst/subsetter | 2026-06-04 |
| krilla | 0.8.2 | MIT OR Apache-2.0 | 2,040,845 | 1,265,085 | https://github.com/LaurenzV/krilla | 2026-06-04 |
| pdf-writer | 0.15.0 | MIT OR Apache-2.0 | 4,057,086 | 2,028,969 | https://github.com/typst/pdf-writer | 2026-05-27 |
| lopdf | 0.45.0 | MIT | 19,460,237 | 9,334,154 | https://github.com/J-F-Liu/lopdf.git | 2026-09-08 |
| hayro | 0.7.1 | Apache-2.0 OR MIT | 2,223,776 | 1,359,500 | https://github.com/LaurenzV/hayro | 2026-06-05 |
| hayro-syntax | 0.7.2 | Apache-2.0 OR MIT | 2,715,573 | 1,813,399 | https://github.com/LaurenzV/hayro | 2026-05-28 |
| pdfium-render | 0.9.4 | MIT OR Apache-2.0 | 2,363,622 | 1,007,900 | https://github.com/ajrcarey/pdfium-render | 2026-09-06 |
| allsorts | 0.17.0 | Apache-2.0 | 938,396 | 383,989 | https://github.com/yeslogic/allsorts | 2026-05-13 |
| skrifa | 0.47.0 | MIT OR Apache-2.0 | 26,250,671 | 13,308,494 | https://github.com/googlefonts/fontations | 2026-09-08 |
| parley | 0.11.1 | Apache-2.0 OR MIT | 3,047,939 | 1,703,565 | https://github.com/linebender/parley | 2026-08-16 |
| cosmic-text | 0.19.0 | MIT OR Apache-2.0 | 8,465,164 | 2,956,962 | https://github.com/pop-os/cosmic-text | 2026-04-22 |
| icu | 2.3.1 | Unicode-3.0 | 2,235,909 | 541,750 | https://github.com/unicode-org/icu4x | 2026-08-20 |
| unicode-normalization | 0.1.25 | MIT OR Apache-2.0 | 570,703,151 | 97,252,837 | https://github.com/unicode-rs/unicode-normalization | 2025-10-30 |
| printpdf | 0.12.8 | MIT | 2,837,797 | 1,290,946 | https://github.com/fschutt/printpdf | 2026-09-05 |
| pdf | 0.10.0 | MIT | 606,241 | 69,636 | https://github.com/pdf-rs/pdf | 2026-03-02 |
| typst-library | 0.15.1 | Apache-2.0 | 2,264,825 | 1,020,947 | https://github.com/typst/typst | 2026-07-17 |
| harfrust | 0.13.3 | MIT | 8,241,114 | 5,002,271 | https://github.com/harfbuzz/harfrust | 2026-08-25 |

## bblanchon/pdfium-binaries latest release

Tag chromium/8057, published 2026-09-14T17:18:55Z. Assets:

| Asset | Size (bytes) |
|---|---|
| pdfium-android-arm.tgz | 2,818,477 |
| pdfium-android-arm64.tgz | 3,382,494 |
| pdfium-android-x64.tgz | 3,525,088 |
| pdfium-android-x86.tgz | 3,303,520 |
| pdfium-attestation.json | 18,223 |
| pdfium-ios-catalyst-arm64.tgz | 3,338,690 |
| pdfium-ios-catalyst-x64.tgz | 3,574,563 |
| pdfium-ios-device-arm64.tgz | 3,304,546 |
| pdfium-ios-simulator-arm64.tgz | 3,394,374 |
| pdfium-ios-simulator-x64.tgz | 3,574,580 |
| pdfium-linux-arm.tgz | 3,374,179 |
| pdfium-linux-arm64.tgz | 3,662,651 |
| pdfium-linux-mips64el.tgz | 3,824,900 |
| pdfium-linux-mipsel.tgz | 3,952,380 |
| pdfium-linux-musl-arm64.tgz | 7,190,672 |
| pdfium-linux-musl-x64.tgz | 7,295,719 |
| pdfium-linux-musl-x86.tgz | 7,244,555 |
| pdfium-linux-ppc64.tgz | 4,220,182 |
| pdfium-linux-x64.tgz | 3,741,565 |
| pdfium-linux-x86.tgz | 3,807,031 |
| pdfium-mac-arm64.tgz | 3,480,513 |
| pdfium-mac-univ.tgz | 7,040,179 |
| pdfium-mac-x64.tgz | 3,675,201 |
| pdfium-v8-android-arm.tgz | 9,543,258 |
| pdfium-v8-android-arm64.tgz | 11,503,272 |
| pdfium-v8-android-x64.tgz | 12,176,580 |
| pdfium-v8-android-x86.tgz | 11,602,717 |
| pdfium-v8-ios-catalyst-arm64.tgz | 12,518,354 |
| pdfium-v8-ios-catalyst-x64.tgz | 14,300,733 |
| pdfium-v8-ios-device-arm64.tgz | 12,393,470 |
| pdfium-v8-ios-simulator-arm64.tgz | 12,855,004 |
| pdfium-v8-ios-simulator-x64.tgz | 14,300,945 |
| pdfium-v8-linux-arm.tgz | 12,376,175 |
| pdfium-v8-linux-arm64.tgz | 13,870,728 |
| pdfium-v8-linux-x64.tgz | 14,051,403 |
| pdfium-v8-linux-x86.tgz | 13,755,544 |
| pdfium-v8-mac-arm64.tgz | 12,922,229 |
| pdfium-v8-mac-univ.tgz | 27,174,888 |
| pdfium-v8-mac-x64.tgz | 14,378,483 |
| pdfium-v8-win-arm64.tgz | 11,848,792 |
| pdfium-v8-win-x64.tgz | 12,723,966 |
| pdfium-v8-win-x86.tgz | 11,550,332 |
| pdfium-wasm.tgz | 2,574,720 |
| pdfium-win-arm64.tgz | 3,593,606 |
| pdfium-win-x64.tgz | 3,821,600 |
| pdfium-win-x86.tgz | 3,686,985 |

## Verification log

- GitHub REST API calls made (excluding the free `/rate_limit` endpoint): 162 total = 78 core (`/repos/...`, `/releases/latest`, `/commits`) + 84 search (`/search/issues`, `/search/repositories`). Non-2xx responses: 1.
- Final rate limit (from `/rate_limit` after the last call): core remaining 33/60 (resets 2026-09-16T04:47:08Z), search remaining 10/10.
- Total HTTP fetches logged (all hosts): 380. Other hosts: registry.npmjs.org (24), crates.io (20), raw.githubusercontent.com (163), gitlab.freedesktop.org (7), spdx.org (1), libreoffice.org (1).
- Method notes: the repo endpoint was used once per repo; the same exact issue-search query was used for every GitHub repo (it matches issues *and* PRs; each sample is tagged `type`). Repos that redirected (renamed/transferred) are recorded under the new name with `repo_redirected_from`. License classification: `license_spdx` = GitHub API `license.spdx_id` unless the API said NOASSERTION/null or a fetched LICENSE/Cargo.toml/package.json/pom.xml/README contradicted or refined it; in those cases `license_notes` cites the file and `license_spdx_github_api` keeps the API value. HarfBuzz's 'Old MIT' text was compared against the SPDX MIT-Modern-Variant canonical JSON.

### Unverified items

- none: every candidate has a fetched repo record, issue-search count and license source.

### Caveats (not unverified, but limitations of the sources)

- Poppler: no GitHub repo; GitLab API used (unauthenticated GitLab omits `open_issues_count`; language not returned). Issue counts come from three separate GitLab term searches.
- GitHub issues are DISABLED on: ArtifexSoftware/mupdf, KDE/okular, LibreOffice/core, apache/pdfbox, esig/dss, itext/itext-java (API has_issues=false: mirrors or projects using external trackers). Their Arabic/RTL counts cover pull requests only and must not be read as no Arabic bugs.
- tesseract-ocr/tessdata_best has no GitHub issue traffic about Arabic by this query; `ara.traineddata` presence was verified by HTTP HEAD on raw.githubusercontent.com.
- `wasm_viability` lines quote README text or npm package descriptions fetched in this run; 'unverified' means the README had no WASM mention and no package was checked - not that a build does not exist.
- Google Fonts license lines come from METADATA.pb (`license: "OFL"`); the SPDX mapping OFL-1.1 follows the Google Fonts `ofl/` directory convention.
