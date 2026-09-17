# Feature matrix (Acrobat Pro parity map)

Status legend: ✅ done · 🟡 partial · ⬜ planned · ❌ out of scope. Targets: D = desktop, X = extension, W = web, M = mobile (Phase 9).

| Area | Feature | Tier | D | X | W | Status / notes |
|---|---|---|---|---|---|---|
| View | Open, zoom, fit modes, continuous scroll, thumbnails | MVP | ✅ | 🟡 | 🟡 | desktop renders with native PDFium; browser builds use the pure-Rust rasterizer by default (ADR-0006) |
| View | Bookmarks, attachments, layers panes | MVP | ⬜ | ⬜ | ⬜ | pane tabs exist, data binding next |
| View | Text selection and copy in logical order | MVP | 🟡 | 🟡 | 🟡 | reconstruction engine done; selection overlay in UI |
| View | Arabic-aware search | MVP | 🟡 | 🟡 | 🟡 | engine done (tashkeel-insensitive, alef/taa/yaa/digits unified); UI find bar |
| Comment | Highlight, underline, strikeout, sticky notes, drawing, shapes, stamps, text boxes, callouts, measurement | MVP | ⬜ | ⬜ | ⬜ | standard PDF annotations |
| Organize | Insert, delete, rotate, reorder, extract, split, merge, crop | MVP | ⬜ | ⬜ | ⬜ | lopdf page-tree ops |
| Compress | Image downsampling, object streams, font subsetting, presets | MVP | ⬜ | ⬜ | ⬜ | |
| Fill & Sign | AcroForm fill, draw/type/image signature, initials, dates | MVP | ⬜ | ⬜ | ⬜ | PDFium form rendering; our appearance streams for Arabic |
| Protect | Open password, AES-256 | MVP | 🟡 | 🟡 | 🟡 | **reading** encrypted files works everywhere: own standard security handler (R2–R6, RC4 40/128, AES-128, AES-256), verified against qpdf and RFC/NIST vectors. Writing encryption and permission flags still to do |
| Edit PDF | Text edit with reflow (Arabic-correct) | MVP | ✅ | ✅ | ✅ | click a paragraph, edit in place, undo/redo, save. GATE 2 passed on a real Word export and a scan (`docs/gate-2.md`); Acrobat verification still outstanding |
| Edit PDF | Images replace/resize/crop, links, headers/footers, watermarks, Bates, page numbers | MVP/v1 | ⬜ | ⬜ | ⬜ | |
| Scan & OCR | Arabic + English OCR, deskew, cleanup, searchable image PDF | v1 | ⬜ | ⬜ | ⬜ | tesseract.js (X, W), Tesseract native (D) |
| Export / Create | PDF → Word/Excel/PowerPoint/images/HTML/text; Office/images/HTML → PDF; combine | v1 | ⬜ | ⬜ | ⬜ | images/HTML/text client-side; Office via optional local LibreOffice (D) or opt-in server (W) — **not available in X** |
| Prepare Form | Create fields, auto-detect, calculations, safe JS subset | v1 | ⬜ | ⬜ | ⬜ | XFA read-only/limited |
| Redact | Text, area, search-and-redact, metadata scrub, true removal | v1 | ⬜ | ⬜ | ⬜ | |
| Compare | Text + visual diff | v1 | ⬜ | ⬜ | ⬜ | |
| Signatures | PAdES sign (PKCS#12, smart card), verify chain, timestamps, LTV | v1 | ⬜ | ❌ smart card | ⬜ | RustCrypto; smart cards desktop-only |
| Accessibility | Tags, reading order, alt text, checker | v2 | ⬜ | ⬜ | ⬜ | |
| Action Wizard | Batch processing | v2 | ⬜ | ⬜ | ⬜ | |
| Print production | PDF/A & PDF/X conversion + validation, preflight light | v2 | ⬜ | ⬜ | ⬜ | krilla for PDF/A output |
| AI | Summarize, chat, translate, OCR post-correction, smart fill, PII suggestions, table extraction | v1 | ⬜ | ⬜ | ⬜ | BYO key / local; off by default |
| Cloud | OneDrive and Google Drive connectors (independent) | v1 | ⬜ | ⬜ | ⬜ | Phase 5 |
