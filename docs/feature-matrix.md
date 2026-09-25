# Feature matrix

Legend: ✅ proven by an automated test in `verify.sh` · 🟡 implemented, not proven on this platform · ⛔ not available (reason in STATUS) · — not applicable.
M = iOS native app.

| Tool | Web | Desktop | Extension | iOS (M) |
| --- | --- | --- | --- | --- |
| (filled in as tools land) | | | | |
| Comment (EmbedPDF) | ✅ `open-save.spec.ts` | | 🟡 extension page opens PDFs (`extension.spec.ts`); tool not exercised there | 🟡 Pencil ink + text highlight saved through `doc.rebase` (`ZoodPDFTests`, not yet run) |
| Fill & sign (EmbedPDF) | 🟡 tool strip reachable (`redact-protect.spec.ts`); signing not yet saved+reopened in a spec | | 🟡 | ⛔ not on iOS yet (STATUS) |
| Prepare form (EmbedPDF form fields) | 🟡 tool strip reachable (`redact-protect.spec.ts`) | | 🟡 | ⛔ not on iOS yet (STATUS) |
| Redact (EmbedPDF marks + apply) | ✅ mark, apply, save as whole rewrite, recents preview dropped (`redact-protect.spec.ts`) | | 🟡 | ⛔ not on iOS yet (STATUS) |
| Protect (EmbedPDF sheet) | 🟡 sheet reachable in en/ar (`redact-protect.spec.ts`); password save not yet reopened in a spec | | 🟡 | 🟡 engine `protect.set`/`remove` (engine call proven on Linux: ZoodKit tests; UI not run) |
| Export (Word, Excel, PowerPoint, HTML, Markdown, text, pictures; warraq-office) | ✅ DOCX/XLSX/PNG-ZIP/text saved and inspected in en + ar (`export-compare.spec.ts`); HTML/Markdown/PPTX engine-proven (`warraq-office/tests/export.rs`) | 🟡 same UI + engine, no desktop spec | 🟡 same UI + engine, no extension spec | ⛔ Office export not on iOS yet |
| Compare (text + visual diff, HTML report; warraq-office) | ✅ changed word listed, highlighted, report saved and inspected in en + ar (`export-compare.spec.ts`) | 🟡 | 🟡 | ⛔ not on iOS yet |

## iOS app (M) in detail

Nothing in the iOS column is ✅ except the string check: the app has not been compiled or run on iOS in
this repository's automation (Linux only, no Xcode). "Proven on Linux" means the Swift wrapper and the
real engine are exercised by `bash scripts/ios/test-linux.sh` (ZoodKit, swift-testing); the SwiftUI layer
stays 🟡 until `scripts/ios/build.sh` runs on a Mac.

| Feature | iOS (M) |
| --- | --- |
| Home (hero, six action cards, Recents with thumbnails, search), iPad split view, iPhone tabs | 🟡 UI test `ScreenshotTests` written, not run |
| Recents / Starred / Tags, Arabic-aware search | 🟡 store + search proven on Linux (`RecentsStoreTests`, `SearchNormalizerTests`) |
| Document view (PDFKit, toolbar "Page x of y · Edited", thumbnails rail on iPad) | 🟡 |
| Markup: Pencil pen/marker/highlighter/eraser → PDF ink, text highlight, save via `doc.rebase` | 🟡 rebase proven on Linux (`rebaseKeepsTheOriginalBytes`); PDFKit path in `ZoodPDFTests` (not run) |
| Organize: rotate, reorder (drag), delete, insert blank/file, extract; page ranges with Arabic digits | 🟡 engine calls + page ranges proven on Linux |
| Combine (new file) and drop-to-combine (incremental append) | 🟡 `pdf.merge` / `pages.insertFrom` proven on Linux |
| Compress (engine rewrite or PDFKit JPEG; always a new file) | 🟡 |
| Protect (AES-256, permissions) / remove | 🟡 engine proven on Linux |
| Convert: pages → PNG/JPEG, text → .txt (engine `text.plain`) | 🟡 `text.plain` through the wrapper proven on Linux |
| Scan to PDF: VisionKit document camera; own capture with corner handles for Whiteboard / ID Card / Book | 🟡 geometry (corner ordering, ID-1 real size, right-to-left book order) proven on Linux |
| OCR text layer (Vision; Arabic only if the OS supports it, checked at runtime) | 🟡 `ZoodPDFTests` (not run) |
| AI assistant (bring your own Anthropic key, exact text shown before Send, streaming) | 🟡 request body + SSE parsing proven on Linux |
| Widgets: Recents, Scan, Lock Screen accessory; Control Center control (iOS 18) | 🟡 |
| Siri / Shortcuts: Open recent, Scan, Combine, Compress (phrases en + ar) | 🟡 |
| Core Spotlight indexing of recents | 🟡 |
| Multiple windows, drag & drop PDFs between windows, Files app (open in place), Share sheet | 🟡 |
| String Catalogs en + ar complete (plural forms, no unused keys) | ✅ `python3 scripts/ios/check-strings.py` (not yet wired into `verify.sh`) |
| Fill & sign, forms, redaction, digital signatures, page marks, Office export/import, compare, standards, accessibility tools, batch, library | ⛔ web/desktop only for now (STATUS) |
