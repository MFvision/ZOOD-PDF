# Feature matrix (Acrobat Pro parity map)

Status legend: ✅ done · 🟡 partial · ⬜ planned · ❌ out of scope. Targets: D = desktop, X = extension, W = web, M = mobile (Phase 9).

| Area | Feature | Tier | D | X | W | Status / notes |
|---|---|---|---|---|---|---|
| View | Open, zoom, fit modes, continuous scroll, thumbnails | MVP | ✅ | ✅ | ✅ | EmbedPDF (PDFium in WebAssembly) in all three hosts (ADR-0007); Warraq's own engine in Edit text. Menus, shortcuts, Go to page and the status bar act on the view on screen. On desktop the file comes in through the native open panel, an OS drop or a path on the command line, and goes out through the native save panel — a webview ignores the browser equivalents. The extension is proven by a test that loads it into Chrome |
| View | Bookmarks, attachments, layers panes | MVP | ⬜ | ⬜ | ⬜ | pane tabs exist, data binding next |
| View | Text selection and copy in logical order | MVP | 🟡 | 🟡 | 🟡 | reconstruction engine done; selection overlay in UI |
| View | Arabic-aware search | MVP | 🟡 | 🟡 | 🟡 | Warraq's engine (tashkeel-insensitive, alef/taa/yaa/digits unified) drives the find bar in Edit text; EmbedPDF's search panel, in the main view, is PDFium's plain search |
| Comment | Highlight, underline, strikeout, sticky notes, drawing, shapes, stamps, text boxes, callouts, measurement | MVP | ✅ | ✅ | ✅ | EmbedPDF's annotation plugin, saved as standard PDF annotations (e2e: a drawing survives save and reopen). Measurement not yet. Arabic typed into a text box is drawn into the saved file by Warraq's shaping, the box grown to fit (e2e; checked in PDFium) |
| Organize | Insert, delete, rotate, reorder, extract, split, merge, crop | MVP | 🟡 | 🟡 | 🟡 | Warraq's core (ADR-0008): rotate, reorder (drag or buttons), delete, insert a blank page and extract as a new file work, with undo, as incremental updates (e2e: moved, turned, deleted pages keep their text through save and reopen). Combine files merges several (e2e: order kept, page by page by their text; a protected input opened with its password), keeping every form field; split, crop and insert from another file not yet |
| Compress | Image downsampling, object streams, font subsetting, presets | MVP | ✅ | ✅ | ✅ | Warraq's core, pure Rust in every host: unused objects dropped, duplicate streams shared, best Flate, object and xref streams; optional downsampling of oversized 8-bit grey/RGB images to 150 or 96 dpi JPEG (e2e: a 300 dpi scan more than halved; every page's text kept, checked on a 95-page Word export). Refuses protected and signed files. Font re-subsetting not yet |
| Fill & Sign | AcroForm fill, draw/type/image signature, initials, dates | MVP | 🟡 | ✅ | ✅ | EmbedPDF's form and signature plugins (e2e: a typed value survives save and reopen). Arabic values are drawn into the saved file by Warraq's shaping, where PDFium wrote an empty appearance (e2e; checked in PDFium). Image signatures need the desktop file panel |
| Protect | Open password, AES-256 | MVP | 🟡 | 🟡 | 🟡 | EmbedPDF sets an open password and permissions (e2e: the saved file is encrypted and reopens only with its password, through Warraq's prompt, in both engines). Warraq's core reads R2–R6 (RC4 40/128, AES-128, AES-256) and keeps the protection on what it appends — a text edit or a page change saves encrypted with the file's own key (checked by PDFium; e2e: edit, save, the password is still asked for) |
| Edit PDF | Add a line of text where you click | MVP | ✅ | ✅ | ✅ | shaped, subset and embedded like any replacement, in a chosen face (Amiri, Cairo, Inter) and size; RTL grows leftwards from the point. Not on the undo stack yet |
| Edit PDF | Text edit with reflow (Arabic-correct) | MVP | ✅ | ✅ | ✅ | click a paragraph, edit in place, undo/redo, save. GATE 2 passed on a real Word export and a scan (`docs/gate-2.md`); Acrobat verification still outstanding |
| Edit PDF | Images replace/resize/crop, links, headers/footers, watermarks, Bates, page numbers | MVP/v1 | ⬜ | ⬜ | ⬜ | |
| Scan & OCR | Arabic + English OCR, deskew, cleanup, searchable image PDF | v1 | ⬜ | ⬜ | ⬜ | tesseract.js (X, W), Tesseract native (D) |
| Export / Create | PDF → Word/Excel/PowerPoint/images/HTML/text; Office/images/HTML → PDF; combine | v1 | ⬜ | ⬜ | ⬜ | images/HTML/text client-side; Office via optional local LibreOffice (D) or opt-in server (W) — **not available in X** |
| Prepare Form | Create fields, auto-detect, calculations, safe JS subset | v1 | 🟡 | 🟡 | 🟡 | EmbedPDF creates text fields, checkboxes, radio buttons, drop-downs and list boxes as real AcroForm fields (e2e). Auto-detect and calculations not yet; XFA read-only/limited |
| Redact | Text, area, search-and-redact, metadata scrub, true removal | v1 | 🟡 | 🟡 | 🟡 | EmbedPDF marks text or an area and applies it as true removal (e2e: the text is gone from the saved file, the rest is intact). Search-and-redact and metadata scrub not yet |
| Compare | Text + visual diff | v1 | ⬜ | ⬜ | ⬜ | |
| Signatures | PAdES sign (PKCS#12, smart card), verify chain, timestamps, LTV | v1 | ⬜ | ❌ smart card | ⬜ | RustCrypto; smart cards desktop-only |
| Accessibility | Tags, reading order, alt text, checker | v2 | ⬜ | ⬜ | ⬜ | |
| Action Wizard | Batch processing | v2 | ⬜ | ⬜ | ⬜ | |
| Print production | PDF/A & PDF/X conversion + validation, preflight light | v2 | ⬜ | ⬜ | ⬜ | krilla for PDF/A output |
| AI | Summarize, chat, translate, OCR post-correction, smart fill, PII suggestions, table extraction | v1 | ⬜ | ⬜ | ⬜ | BYO key / local; off by default |
| Cloud | OneDrive and Google Drive connectors (independent) | v1 | ⬜ | ⬜ | ⬜ | Phase 5 |
