# Third-party notices

Components shipped in Warraq builds (kept current as components are integrated;
research-only tools such as PyMuPDF, pikepdf and uharfbuzz are not shipped).

Every web, extension and desktop build carries the licence texts under
`licenses/`: `THIRD-PARTY-LICENSES.md` for the bundled JavaScript packages
(written by Vite), and beside it the fonts', stamps', PDFium's, Tesseract's
and its models' (`packages/ui/vite/notices.ts`), with this file. The desktop
build adds `RUST-CRATES.md`: every Rust crate linked into the app, with its
licence text (`scripts/rust-licenses.mjs`).

| Component | License | Use |
|---|---|---|
| PDFium (pdfium.googlesource.com) and its bundled dependencies (FreeType, libjpeg-turbo, OpenJPEG, libpng, zlib, lcms2, ICU, abseil, agg23, fast_float, simdutf) | BSD-3-Clause and the licenses in `licenses/` of pdfium-binaries | rasterization, forms, annotations |
| pdfium-render | MIT OR Apache-2.0 | Rust binding to PDFium |
| harfrust, read-fonts, skrifa, fontations | MIT OR Apache-2.0 | shaping and font parsing |
| unicode-bidi, unicode-normalization, icu4x crates | MIT OR Apache-2.0 / Unicode-3.0 | bidi, normalization, segmentation |
| subsetter, pdf-writer, krilla | MIT OR Apache-2.0 | font subsetting and PDF writing |
| lopdf | MIT | PDF object model |
| hayro, hayro-syntax, hayro-interpret, vello_cpu | Apache-2.0 OR MIT | content interpretation, optional pure-Rust rasterizer |
| EmbedPDF (`@embedpdf/react-pdf-viewer`, `snippet`, `engines`, `models` and its plugins), © 2025 CloudPDF | MIT | the document view, and the Comment, Fill & sign, Prepare form, Redact and Protect tools |
| `@embedpdf/pdfium` (PDFium compiled to WebAssembly), © 2024 CloudPDF, Ji Chang; PDFium itself | MIT; BSD-3-Clause (`LICENSE.pdfium` in the package) | rendering inside the interface, in every host |
| EmbedPDF's standard stamps (`packages/ui/public/stamps/en/`, licence beside them) | MIT | the Fill & sign stamps |
| Preact, tailwind-merge (bundled inside EmbedPDF's viewer) | MIT | EmbedPDF's own interface |
| tesseract.js 7, tesseract.js-core 6 (the Tesseract OCR engine compiled to WebAssembly) | Apache-2.0 | Scan & OCR |
| Tesseract's trained models for Arabic, English, Persian and Urdu (`4.0.0_best_int`, from tessdata_best, packaged as `@tesseract.js-data/*`) | Apache-2.0 (the packaging: MIT) | Scan & OCR |
| RustCrypto `aes`, `cbc`, `md-5`, `sha2`; `getrandom`; `flate2`; `image` (JPEG only) | MIT OR Apache-2.0 | encryption kept on save, Compress |
| Amiri, Cairo, Inter, Noto Naskh Arabic | SIL OFL-1.1 | bundled edit, UI and fallback fonts (the corpus in `tests/` uses more, which are not shipped) |
| Lucide (`lucide-react`) | ISC | icons |
| fflate | MIT | zip and deflate for Export (the Word file, page images, PNG compression) |
| React, Vite, Tauri | MIT / MIT / Apache-2.0 OR MIT | UI and app shells |
| muda (Tauri's menu library, already inside Tauri) | Apache-2.0 OR MIT | named directly only in the desktop tests, to parse the macOS menu bar's shortcuts as Tauri does |
| `objc2`, `objc2-foundation`, `objc2-app-kit`, `objc2-pdf-kit` (macOS desktop) | MIT; Zlib OR Apache-2.0 OR MIT | Print, through PDFKit and the system print sheet |
| `cssparser`, `cssparser-macros`, `selectors`, `dtoa-short`, `option-ext` (pulled in by Tauri, desktop only, unmodified; source on crates.io) | MPL-2.0 | Tauri's HTML handling and settings paths |

No GPL, AGPL or LGPL component is shipped (`r-efi`, offered under MIT OR
Apache-2.0 OR LGPL-2.1, is taken under MIT, and is not built for any target
Warraq ships). Checked on 2026-09-18 with `pnpm licenses list --prod` and
`cargo metadata` for the core and the macOS desktop app.

EmbedPDF, Tesseract, Ollama and LM Studio are named here, and in the
interface where a person chooses them, only to say what Warraq uses or
connects to; Warraq is not affiliated with their owners. Claude and Anthropic
are named the same way in the AI tool, where a person brings their own key.
