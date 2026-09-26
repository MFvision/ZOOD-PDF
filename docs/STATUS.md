# STATUS — Warraq

*Updated 2026-09-20: an adversarial review of the Apple-style redesign found ten distinct problems —
the home screen keeping a picture of a page as it was before a redaction, the macOS menu bar's Undo and
About, stale checks and pressed states, the keyboard in the tool picker and in Settings, the markup
toolbar and the sheet's grabber on a phone, and text pointing at chrome that no longer exists — and every
one is fixed with a test ("Fixed after the redesign review", below).
Before that, on 2026-09-19: the interface is rebuilt on EmbedPDF (ADR-0007); all nineteen tools work end to end, each proven by a test that clicks through it, saves the file and reopens it — Create PDF (Word, Excel, PowerPoint, web pages, Markdown, text and pictures to PDF) and Export to Excel and PowerPoint the latest. Digital signature: signing and checking proven through the interface; its timestamps and validation data work on the desktop only, proven by Rust tests and run once against DigiCert and Sectigo, not through the interface; its verifier was hardened against the published PDF-signature attacks after an adversarial review (below). Also since then: search and copy in the page view answer with Warraq's reader, the web app installs and works offline, Windows and Linux print by pages, EmbedPDF's interface is Arabic throughout, and Nastaliq Urdu reads exactly; then Batch (a sequence of the tools' steps over many files), OCR cleanup and the AI's data actions, and Standards (PDF/A, PDF/X-4, preflight) with Accessibility (checker, reading order, tags, picture text).*

## Where the product stands

| Capability | State |
|---|---|
| Open, render, thumbnails, zoom | EmbedPDF — PDFium compiled to WebAssembly (MIT) — on web, desktop and extension; Warraq's own engine (native PDFium on desktop, pure Rust in browsers) takes over in Edit text |
| Search and copy in the page view | EmbedPDF's search panel (Cmd+F), its highlights, next and previous, and its Copy, answered by Warraq's reader: Arabic found with or without diacritics, alef, taa marbuta, yaa and digit forms unified, case and whole words on request; what is selected copies in logical order. PDFium, on the corpus's three-page Naskh file, found none of the seven "وراق" this finds, and copied a Chrome-made form backwards |
| The Library: search across a folder | **Its core, its readers and its desktop host are built; the panel is not.** `packages/core/warraq-core/src/tools/library` holds an inverted index over every document's words — normalized the way the find bar normalizes, so a word typed الفاتوره finds الفَاتُورَةُ, and 2026 finds ٢٠٢٦ — whole word against whole word, the last word of a query also as a beginning — with each word's line and place, ranked by BM25 with a phrase bonus (the rule is written down in `packages/core/API.md`), filtered by folder, kind, tag, date range or "scanned only", and each hit marked inside the line the person reads. The date shown is the document's own, read from its text in Arabic or Latin digits, Gregorian or Hijri (Umm al-Qura) — never the file's date. Tags by hand and by the person's own rules. The index is a cache, never the documents: no file is touched, nothing leaves the device, and a damaged or foreign index is refused rather than half-loaded. The reading of each kind of file into text and the desktop host that walks a folder and keeps the index are in too (their own sections below); the panel is the one part still in flight, so until it lands there is nothing to click |
| Comment, fill & sign, prepare form, redact, protect | work end to end through EmbedPDF's plugins, in all three hosts; see the count below |
| Prepare form | Warraq's core finds where a flat form expects writing — underscore and dot runs, empty table cells, drawn boxes, lines to sign on, check boxes — names each field from its Arabic or English label and types it (text, check box, date, Hijri date, signature); the proposals are drawn on the page to adjust, then created as real AcroForm fields. Formats (numbers with SAR and Arabic-Indic digits, percent, dates, Umm al-Qura Hijri dates), ranges and calculations (sum, product, average, min, max, or arithmetic typed over field names) are written as the built-in JavaScript every form reader runs, and run inside Warraq by its own interpreter of exactly that subset — no JavaScript engine, no eval. Measured below |
| Page marks | watermarks (text or a picture), headers and footers with page, date (Gregorian or Hijri) and file tokens, page numbers and Bates numbers, drawn by Warraq's core with Arabic shaped, previewed on the page before they are applied, and listed to change or take off — the page's own content is never touched (form XObjects tagged as artifacts, round the page's streams) |
| Edit PDF: pictures and links | pictures picked, moved, resized, turned, cropped, replaced, deleted or placed from a PNG/JPEG; links drawn, pointed at an address or a page, moved, resized and removed — from the pointer or the keyboard; each change rewrites only the one operation or annotation it touches, as an incremental update, and each can be undone in turn with text edits |
| Find and redact, remove hidden information | Warraq's core finds words (Arabic-aware, as Find) and ready-made patterns — emails, phones, national ID/Iqama, IBANs, card numbers, dates — or a person's own pattern, anywhere on the page — running heads, footers and page marks included — with the boxes of their glyphs, on turned pages and slanting lines too, which become EmbedPDF's redaction marks; and it reports and removes what a file carries besides its pages, writing the file whole |
| Bookmarks, attachments, layers | one navigation pane in both views (View menu): bookmarks go to their page; attachments are listed, saved, added and removed; layers are shown and hidden in the view without touching the file until the visibility is saved with it |
| Organize pages | rotate, reorder (drag or buttons), delete, insert a blank page or another PDF's pages, extract pages to a new file, split into files, crop by margins or trim the white away, undo and redo — Warraq's core, as incremental updates (ADR-0008) |
| Digital signatures | PAdES signatures made and checked by Warraq's own core (pure Rust, `warraq-sign`) in every host: sign with a certificate file (.p12/.pfx, modern or legacy) — visibly, where the person drags on the page, Arabic shaped — or on the desktop with a smart card; certify or approve, lock the form; every signature in a file checked when it opens (integrity, signer, chain, trust, time, revocation data, and what changed after it). A signer is shown as valid only when a certificate the person trusts vouches for them: Mozilla's roots are trusted by browsers for web sites and do not make a document signer valid (see "Trust" below). Trusted timestamps and long-term validation data are fetched by the desktop app only, on a click; the browser cannot read those servers' answers |
| Combine files | several PDFs into one new file, in the order listed, form fields and all; protected files with their password — Warraq's core (ADR-0008) |
| Create PDF | Word, Excel, PowerPoint, web pages, Markdown, text, CSV and pictures (PNG, JPEG, GIF, BMP, WebP, every page of a TIFF; HEIC or AVIF where the browser draws them) made into a new PDF on the device — no LibreOffice, no server. The files are read in the interface and laid out by Warraq's own engine in the core (`warraq-pdf/src/create.rs`): shaped Arabic in embedded subsets that read back as typed, right to left where the text is, pages of the source's size. From the home screen, the Create PDF tool, or by dropping such files on the window; several become one PDF in the order listed; pictures optionally read with Scan & OCR afterwards |
| Scan & OCR | Tesseract (Apache-2.0) reads scanned pages on the device — Arabic, English, Persian, Urdu (Naskh) — and Warraq's core writes what it read as an invisible, shaped text layer, so the page can be searched, selected and copied while it looks as it did. Measured on the corpus: 130 of 138 Arabic words of a 300 dpi scan (the misses carry diacritics), 20 of 30 of a 200 dpi black-and-white invoice (Tesseract skips its table rows). A scan can be cleaned up first — shadows and stains evened out, contrast, black and white by Sauvola's local threshold, specks, dark borders — and the cleaned picture put in place of the scan: a shadowed and stained page went from 59 % of its words to 94 % (measured below). Runs in the desktop webview too (checked from the host's log) |
| Batch | a sequence of the tools' own steps — OCR (with cleanup), compress, rotate, delete or keep pages, page marks, remove hidden information, flatten, protect, export — over many files, from the file picker, a folder (subfolders too) or a drop, one at a time; progress per file, Stop, a summary; a file that fails says why and the rest go on. Results never replace their originals: beside them with a suffix or into a chosen folder on the desktop (never over a file that is there), one zip in a browser. Sequences saved as named actions on this device, never with their passwords |
| Library | one search across every document added, not only the one on screen. Files, a drop or a whole folder — the system panel on the desktop, the browser’s directory picker where there is one — are read into an index kept on this device: the app’s own data directory on the desktop, IndexedDB in a browser. PDFs are read by محرر PDF’s own reader, a page with no text of its own and a picture by Scan & OCR, and Word, Excel, PowerPoint, web pages, Markdown and text by the readers Create PDF already has. Progress says which file and whether it is being read or recognized; Stop leaves what was read in place and *Carry on* takes what the run never reached; an unchanged file is never read twice; everything left unread is listed with its reason. One search, Arabic-aware as the find bar is (tashkeel, alef, taa marbuta, yaa and the digit forms), ranked, filtered by kind, folder, tag, the date the document itself carries and "scans and pictures only"; each hit shows its file, its page and the matched line with the words marked, and opens the document there. Tags by hand and tag rules kept in the index. "Forget this folder" and "Delete the index", which deletes the file or the database itself. On the desktop the folders can be watched — a re-check every few seconds, which the panel says in those words. Nothing leaves the device |
| Compress | a smaller copy, written from scratch: unused objects dropped, duplicate streams shared, everything recompressed, and — only if chosen — images larger than a page needs downsampled to 150 or 96 dpi. Refuses protected and signed files rather than silently stripping their protection or breaking the signature |
| Cloud drives | OneDrive (desktop and web) and Google Drive (desktop) opened from and saved to, with no ورّاق server and no client secret: the person signs in on the provider's own page, Save writes a new revision checked against the version the file was opened at, and a file someone else saved meanwhile is never overwritten silently. Nothing of it appears unless the build carries a client ID (docs/cloud.md); with none, no control, no address in the security policy, no request |
| Protected files | open everywhere after a password prompt; one prompt unlocks the file for both engines |
| Arabic text **reading** in logical order | 26 of the 32 truth-scored corpus files (2026-09-19, the Nastaliq page and the Amiri tashkeel page among them), against 2 for PDF.js, 2 for MuPDF, 0 for PDFium, scored the same way (`tests/acid/score.py`) |
| Arabic text **editing** with reflow | works end to end: click a paragraph in the app, edit it, undo/redo, save. GATE 2 passed (`docs/gate-2.md`) |
| Encrypted files | read everywhere: R2–R6, RC4 40/128, AES-128, AES-256 |
| Saving | incremental update; the opened bytes stay as the literal prefix — for EmbedPDF's changes too (below), except after a redaction or a change of password, which are written whole |
| Hostile input | mutation harness on every pull request; cargo-fuzz targets ready for nightly |
| Visual regressions | golden renders of all 48 corpus pages gated in CI |
| No-mapping files | characters recovered from glyph shapes, at 100 % precision on held-out fonts |
| Installed on this Mac | `/Applications/محرر PDF.app`, built from this tree — `scripts/install-macos.sh`, documented in `docs/install-macos.md`. Opens a PDF, renders every page, both thumbnails and full size |
| Print | macOS: PDFKit prints the file itself, vectors and all. Windows and Linux: each page drawn by Warraq's core at 300 dpi and printed through the webview's own dialog — proven in Chrome, not yet run on either system (below). Browsers: the file through the browser's PDF viewer, which the page's security policy had been blocking without a word |
| iPhone and iPad app | **The foundation is built, simulator only** (2026-09-21, below): a native SwiftUI app in `apps/ios` with the Rust core linked in as an XCFramework behind a C ABI. It opens a PDF from Files or its own Library, draws it with PDFKit in right-to-left page order for Arabic documents, reads its text in logical order through the core (VoiceOver gets it as the page's value), edits through the core as incremental updates with nothing written until Save, and has Settings for language and appearance that apply at once. Everything else — annotate, sign, organize, export, scan, OCR, the Library's search, the widgets, Shortcuts — is being built on it. Proven on the iPhone 17 and iPad Pro 13-inch (M5) simulators; no device, no signing identity here |
| Install and offline (phones too) | the web app installs from the browser under its Arabic name, and after one visit opens and works with no network: a service worker keeps the app's own files — never a document. On phones and tablets every control is a 44-point target. Native iOS and Android apps are not built: the tools they need are not on this Mac (Decisions, below) |

Every one of the 48 corpus files opens. 63 tests green, clippy clean, `wasm32-unknown-unknown` compiles, core WASM 2.50 MB gzipped (budget 8 MB).

## The iPhone and iPad app: the foundation (2026-09-21)

The owner asked for the phone app to be rebuilt as a true Apple-native app. `apps/ios` is that app's
foundation — SwiftUI from the first screen, Swift 6 with strict concurrency, iOS 18, universal — with the
shared Rust core inside it. Four parts are being built in parallel; this is part A, what the other three
build on (`apps/ios/README.md` says how).

* **The core on a phone.** `packages/core/warraq-core/src/ffi.rs` (feature `ffi`, crate type `staticlib`)
  is a C ABI mirroring `wasm.rs`: `warraq_open`, `warraq_call`, `warraq_call_static`, `warraq_save`,
  `warraq_free` and the readers; JSON in and out, bytes as (pointer, length) pairs, errors as codes carrying
  the core's `E_…` names, and a panic on hostile input caught at the boundary and answered as
  `WARRAQ_E_PANIC` rather than ending the app (the `ios` profile unwinds for that). `scripts/ios/build-core.sh`
  builds it for the device and the simulator into `apps/ios/Vendor/WarraqCore.xcframework`. Nine Rust tests
  round-trip a corpus Arabic PDF through the C surface (`ffi::tests`), and a test keeps the header
  (`include/warraq_core.h`) and the exports in step. Cross-crate LTO is off for this build: Xcode 27's
  linker cannot read the bitcode rustc's newer LLVM writes.
* **The Swift wrapper.** `actor Core` (`apps/ios/WarraqCore`): `open`, `call`, `callStatic`, `save`, `close`
  and typed readers, errors as `CoreError` cases, every call off the main thread.
* **The app.** A Library shell — `NavigationSplitView` on iPad (sections, documents as a grid of real first
  pages, the document), a stack on iPhone — with Recents, the app's own Documents folder (the Files app shows
  it), Open… through the system's file picker, search by name, and the scene restored to the document it had
  open. A document model whose edits go through the core and come back as incremental updates: the file on
  disk is untouched until Save, undo and redo included. PDFs handed over by Files, Mail, Safari and "Open in"
  open in a `DocumentGroup` scene; "Open in New Window" on iPad opens a window of its own. PDFKit draws the
  pages, continuous, pinch and scroll its own, pages ordered right-to-left when the first page reads
  right-to-left; the page view's accessibility value is the page's text in logical order from the core, so
  VoiceOver reads Arabic as it is read. Info shows what the core read; Share hands the bytes as they stand to
  the share sheet; a protected file asks for its password. Settings: language (system, Arabic, English —
  applied at once to every screen and, through `AppleLanguages`, to the system's own pieces from the next
  launch, with a link to the Settings app) and appearance. The String Catalog carries every string in Arabic
  and English, the app's name isolated inside English text. Design tokens and a small component set follow
  `docs/design/README.md`: system colours by role, the system text styles (Dynamic Type), a 4-point grid,
  press feedback on touch-down, critically damped motion, cross-fades under Reduce Motion. The icon is the
  maskable variant of `scripts/icon/make_icon.py`.
* **Widgets and the share sheet, as far as the foundation goes.** A Recent documents widget (small, medium,
  large, Lock Screen rectangle) reads the recents list and thumbnails the app keeps in the App Group
  container and opens a document through `pdfeditor://open/<id>`; "Save to محرر PDF" in the share sheet
  copies PDFs into the container's Inbox, which the app takes into its Documents folder when it is next in
  front. Part D builds the rest of the widgets, the intents and Spotlight on these.
* **Proof, on the simulator only** (no device and no signing identity on this Mac; a device or TestFlight
  needs the owner's Apple Developer team): `scripts/ios/build.sh` generates the project with XcodeGen,
  builds for the iPhone 17 and the iPad Pro 13-inch (M5), runs 12 unit tests (the wrapper on corpus files:
  Arabic in logical order, Arabic-aware search, an incremental save, combine, every error code; the
  document model: untouched file until Save, password, undo and redo; the recents store) and 3 UI tests
  (launch, open a corpus Arabic PDF, see its Arabic text on screen; the English interface; the screenshots)
  on each, and writes the screenshots — the document, its Info sheet, the Library and Settings, in Arabic and
  English, light and dark, on both — to `docs/design/ios/`, each looked at.
* **What the simulator cannot do,** so it has not been done: the real camera (VisionKit's document camera
  does not exist there), Face ID, the share sheet from another app, a Home Screen with the widget on it.
  What is not built yet is not shown: the sidebar lists Recents and My documents, nothing more, until the
  parts behind the other sections land.

## The iOS app — part D: Library, widgets, App Intents, Spotlight, share extension, Settings (2026-09-21)

**Simulator only** (iPhone 17 and iPad Pro 13-inch (M5), iOS 27.0 runtime, Xcode 27): there
is no signing identity on this Mac, so nothing here has run on a device, and nothing has been
submitted anywhere. Built on the foundation in `apps/ios/` (SwiftUI, Swift 6, the core as an
XCFramework); the view/annotate/organize and scan/OCR parts are other agents' and are not
described here.

**What works, as a person would see it**

* **Home** (to the owner's design target of 2026-09-25, in SwiftUI materials over a soft
  gradient — no photograph): a greeting by the time of day, the headline «ملفات PDF، من جديد.» /
  "PDFs, done right." (the same as the desktop's), six large action cards — Open, Scan, Create (pictures
  into a PDF), Combine (files into one PDF), Search, Settings — each doing what it says today, then
  rows of real first pages with the file's name and date ("Today, 9:41 AM"): Recents, Starred,
  My documents, the chosen folder; a ⋯ menu on every card (Star, Open in New Window, Remove from
  Recents), "See all" into the section, paging arrows on iPad. The sidebar: Home, Recents, Starred,
  My documents, the folder once chosen, Tags; "Tools": Scan, Create a PDF, Combine files, Search.
  **Starred** is a real per-device flag (`StarredStore`, a set of file paths in the shared
  container). Not shown, because they do not exist on this device: Convert and AI cards, Shared,
  Clouds. Proven by XCUITest `testHomeCardsAndStarring` (the six cards, a star from the ⋯ menu
  putting the document in the Starred row and section, the Search card opening the field).
* **The Library.** Above the documents, one search field: "ابحث داخل كل مستند". Typing a word
  finds every line holding it in every document the index holds — in Arabic without its tashkeel
  and with alef, taa marbuta and yaa forms unified (the core's `library.search`) — grouped by
  document with the page number and the matched words marked; a tap opens the document at that
  page. Filters (kind, tag, place, scans only, the document's own date, Gregorian or Hijri). The
  index is built from My documents and, once chosen in Settings, one folder in Files or iCloud
  Drive (a security-scoped bookmark; the files stay where they are). A status line says how many
  documents are indexed, shows progress while a run reads, and has Stop (between files) and
  Index now; pull to refresh runs it too. A PDF's text comes from the core page by page; a page
  with no text of its own, and a picture, go through the OCR seam; a thumbnail is drawn with the
  core; a file whose size and date have not changed is not read again; a file taken away leaves
  the index on the next run. Tags (from a document's menu, or in the Tags section) and rules
  ("فاتورة" tags the invoices; apply now) are the core's, kept in the index. Core Spotlight holds
  each document's name, kind and the start of its text, so the iOS search finds documents and opens
  them in the app.
* **Widgets** (`group.app.warraq`): Recent documents (small: the last one with its first page;
  medium: three; large: six; each opens the document), Scan (one tap into the scanner), Library
  search (the last searches, each a tap back into that search); Lock Screen: the last document
  (rectangle, inline) and Scan (circle, inline); an iOS 18 Control Center control for Scan.
  Refreshed through `WidgetCenter` whenever a document is opened, indexed or forgotten and
  whenever a search is run. Each opens the app at one of its routes (`pdfeditor://scan`,
  `pdfeditor://open/<id>`, `pdfeditor://search?q=…`, `pdfeditor://last`).
* **App Intents, Shortcuts, Siri**: "Scan a document", "Open <document>" (an entity query over
  the recents and the index, matched by name, tashkeel and case aside), "Search my documents for
  <text>" (answers matches with document, page and line; a spoken summary), "Make a PDF from these
  files" (PDFs and pictures into one PDF in My documents, handed back as a file), "Open the last
  document"; Siri phrases in Arabic and English (`AppShortcuts.xcstrings`). Home Screen quick
  actions: Scan, and the last document by name.
* **Share extension** "Save to محرر PDF": PDFs shared from any app land in the Inbox; pictures
  become one PDF (the core's `create.images`); the app moves the Inbox into My documents and
  indexes it the next time it is in front.
* **Settings**: language (system/Arabic/English), appearance, the default scan mode (colour, grey,
  black and white), OCR languages (the list is what Vision offers on this device), the
  Files/iCloud folder (choose, change, stop reading), Face ID/Touch ID lock (off by default; asks
  whenever the app comes to the front; refuses to turn on where the device has neither biometrics
  nor a passcode), and "Delete everything", which deletes the documents in My documents, the
  index, Spotlight's items, the recents, the thumbnails, the last searches, the Inbox, the folder
  bookmark and the settings.
* **Scan entry**: every "Scan" (widget, control, Shortcut, quick action, the toolbar) lands on
  VisionKit's document camera where the device has one, and on a pictures-to-PDF sheet where it
  does not (the simulator); either way the pages become a PDF through the core in the default scan
  mode, saved among My documents, indexed and opened. The scan feature's own pipeline takes this
  entry over.

**The OCR seam.** `TextRecognizer.shared` in `apps/ios/Shared/TextRecognizer.swift`:
`recognize(image, languages) -> [RecognizedWord]` (text, box, line). Vision's
`VNRecognizeTextRequest` stands behind it by default; the scan agent's pipeline was not on main
when this was built, so the unit tests drive the seam with a fake recognizer (`FakeRecognizer` in
`LibraryTests`) and the UI test uses Vision as it is. **Vision's languages on this simulator:**
`en-US, fr-FR, it-IT, de-DE, es-ES, pt-BR, zh-Hans, zh-Hant, yue-Hans, yue-Hant, ko-KR, ja-JP, ru-RU, uk-UA, th-TH, vi-VT, ar-SA, ars-SA, tr-TR, id-ID, cs-CZ, da-DK, nl-NL, no-NO, nn-NO, nb-NO, ms-MY, pl-PL, ro-RO, sv-SE, fi-FI, hi-IN, mr-IN` (`testVisionLanguagesOnThisSimulator`, iPhone 17, iOS 27.0) — **Arabic (`ar-SA`, and Najdi `ars-SA`) is there**, so the index reads Arabic scans with Vision on this simulator; the default OCR languages are Arabic and English.

**Proven by** (all on the simulator, both devices unless said):

* XCTest `LibraryTests` (6 tests): corpus files indexed, "فاتوره" (no tashkeel,
  haa for taa marbuta) found in the invoice at page 1 with its span marked, a tashkeel-laden word of
  `coretext-albayan-tashkeel` found from its bare form, filters by kind and tag, rules applied,
  save/close/reopen, forget; a damaged index file set aside; the indexer reading a corpus folder
  with a scan through the fake seam (2 read, 1 skipped, 1 page recognized), unchanged on the second
  run, forgotten when the file is removed; Stop between files; the seam's line assembly.
* XCTest `WidgetsAndRoutesTests`: the Recent documents and Library search timelines from a seeded
  App Group container (newest first, only files still there, small = one), routes round-tripping
  through their URLs, a posted route taken once, the quick actions' items and routes.
* XCTest `IntentsTests`: documents resolved by name from the recents and the index file, the
  search intent answering from the index file (and no index = no matches), "Make a PDF" joining
  a PDF and two pictures into three pages with the Arabic intact, the opening intents leaving
  their routes, five Shortcuts.
* XCUITest `LibraryUITests`: the corpus imported and indexed (5 documents, the scan through
  Vision), "فاتوره" searched, a hit tapped and the document open at that page (the toolbar's page
  number), the search written for the widget; Scans only filtering to the scan (skipped with a
  message if Vision read nothing off the bilevel scan); a rule written through the interface and
  the tag appearing.
* XCUITest `SettingsUITests`: the scan mode and an OCR language kept across a relaunch; Delete
  everything emptying the Library (0 indexed, no documents, no recents); the app starting locked
  with `-appLock 1` and unlocking on the simulator's Face ID match (`scripts/ios/build.sh` enrols a
  face and posts matches through `simctl spawn … notifyutil`); the lock switch.
* Screenshots in `docs/design/ios/` (iPhone 17; each looked at): `home-ar-light-iPhone-17.jpg`
  and `home-en-dark-iPhone-17.jpg` (the home: greeting, headline, the six cards, the index status
  line — "5 documents indexed · 5 read · 1 pages recognized" in the dark English one, the scan
  read by Vision), `library-search-*`, `library-filters-*` (the filters sheet), `library-tags-*`
  (the Tags screen), `widgets-gallery-1..4-iPhone-17.jpg` (SpringBoard's widget gallery opened
  on the app's entry: "Recent documents", then the next families), `settings-full-en-light-*`.
  The iPad set is taken by the same tests on the iPad Pro 13-inch (M5) when
  `scripts/ios/build.sh` reaches it (see "Not done", below).

**Not done, limited, or not provable here — stated plainly**

* Only PDFs, scans and pictures are read into the index on iOS: the Word/Excel/PowerPoint/HTML
  readers of the web and desktop hosts are not in the app, and the kinds are not shown as filters.
* A protected PDF is skipped by the index (its password is not asked for during a run).
* The Files/iCloud folder is read to a depth of 8 and at most 4 000 files per run; iCloud files
  not yet on the device are asked for and read on the run after they arrive. No watching: the
  index is brought up to date when the app comes to the front, on pull to refresh, and on Index
  now.
* Vision's word boxes for the index are the line's box shared out by word length; the scan
  feature's own measured boxes are what a text layer should use.
* Widgets, the Control Center control, Siri, Shortcuts and the share sheet are proven as code
  (timelines, entity queries, routes, the extension's saving) and through the app's handling of
  each route; the widget gallery itself is photographed by `WidgetGalleryUITests` only where
  SpringBoard's controls could be found — on the iPhone 17 simulator they were: the gallery
  opened on the app's entry and four pages were photographed (`widgets-gallery-1..4`); the Lock
  Screen and Control Center galleries are not driven.
* **Shared simulators.** Several agents test on the same two booted simulators outside the
  queue; two XCUITest runners on one device kill each other ("Early unexpected exit … server
  died") and the machine's load (50–90) exhausts process slots. `scripts/ios/build.sh` now takes
  `WARRAQ_IPHONE` / `WARRAQ_IPAD` for simulators of one's own (part D ran on "iPhone 17 D" and
  "iPad Pro 13-inch (M5) D", reported under the shared names); its Face ID matcher loop dies with
  the script. The last complete iPhone UI run before that change (`build13`): LaunchTests 2/3
  (the third: the app could not be launched under load), LibraryUITests 3/5, SettingsUITests 1/4,
  WidgetGalleryUITests 1/1 — the failures were the index status line not yet idle within the
  wait, rows below the fold, the lock's switch tapped beside its control, and launch timeouts;
  each is fixed in the tests (longer waits through the running state, scrolling, the row's own
  switch) and re-run on the private simulators. The iPad stage had not been reached by any run
  with the final code when this was written; the log of the last run is the verdict
  (`apps/ios/.build/logs/test-iPad-Pro-13-inch-M5.log`).
* The chosen-folder flow through the system's folder picker is not driven by a UI test (the
  picker is another process); the bookmark, the listing and the keys are unit-tested through the
  Documents folder, which uses the same code.
* Nothing has run on a device; Face ID is the simulator's simulated sensor.

## Completed this session
* **Phase 0** — landscape audit (92 live-verified records), Arabic corpus (48 files: 33 generated with ground truth, 15 real-world with provenance), acid harness across five engines plus our own, two prototypes, GATE 0 (`docs/research/02-decision.md`, ADR-0003/4/5).
* **Phase 1** — architecture; Rust core (`warraq-text`, `warraq-pdf`, `warraq-render`, `warraq-core`) native and WASM; RTL-first React shell and web app; MV3 extension; Tauri desktop with native PDFium bundled; CI (rust, wasm gate, web, corpus gate, robustness, desktop matrix, release draft).
* **Phase 2** — bidi with a W5 repair, HarfRust shaping conformant with HarfBuzz, Arabic search normalization, logical-order reconstruction with cmap/GSUB/dot-recomposition fallbacks, paragraph detection and reflow, content-stream text location, erase and replace, subset font embedding with correct ToUnicode, incremental save, the standard security handler, and the robustness harness.
* **ADR-0006** recorded your answers: name, license and native PDFium confirmed; browser builds default to the pure-Rust rasterizer; Persian and Urdu first-class (corpus and fonts added).

## What the interface actually offers, counted

Stated because it was not, and a person met thirteen tool cards that looked
alike when only one of them did anything.

| | |
| --- | --- |
| Tools in the pane | 20 |
| Tools that work | **20** — Edit, Page marks, Organize pages, Combine, Create PDF, Compress, Scan & OCR, Export, Compare, AI, Digital signature, Batch, Standards, Accessibility, Library, Comment, Fill & sign, Prepare form, Redact, Protect |
| Tools marked *Later* on their face | 0 |

| Edit (Warraq's engine) | three kinds, switched at the top of the panel. **Text**: replace the text of a paragraph, reflowed and reshaped; add a line of new text where you click; choose the face (Amiri, Cairo, Inter) and size; undo and redo, in order, every change made in Edit — a replacement, an added line, a picture or a link. **Pictures**: every picture on the page as a box to pick — inline ones and ones inside forms too; drag to move, handles to resize (Shift keeps proportions), turn 90°, crop with the handles, replace with another PNG or JPEG (fitted inside what showed), delete, arrow keys to nudge the picked picture; add a picture from a file or a drop by dragging out where it goes. **Links**: drag to draw one, or add one in the middle of the page from the panel; point it at a web or e-mail address or a page of the file; move and resize it by dragging or with the arrow keys (Alt resizes); remove it; follow it from the panel — an address only after the same question as everywhere |
| Page marks (Warraq's engine) | four kinds: watermark (text or picture; size, colour, opacity, rotation, centre, a corner, an edge or tiled; in front of or behind the page), header and footer (three slots — start, centre, end, the start on the right in Arabic, detected from the text or chosen — with page number, page count, date and file name tokens; the date Gregorian or Hijri, in Western or Arabic-Indic digits), page numbers (`1`, `1 / 9`, `Page 1 of 9`, `صفحة 1 من 9`, roman — shown in the digits chosen, Western or Arabic-Indic; start number; no number on the first page) and Bates numbers (prefix, start, padded digits, suffix); any range of pages; the page on screen previewed with the mark as the core will draw it; the marks already in the file listed, each changed in place or taken off, or all at once. A new mark replaces one of the same kind on the same pages |
| Organize pages (Warraq's engine) | a grid of every page: select (click, Shift, Cmd/Ctrl), drag to reorder or move earlier/later, rotate either way, delete (never the last page), insert a blank page, insert every page of another PDF after the selection (its password asked for if it has one), extract the selection as a new file, split into files — every so many pages or at each selected page, saved as one zip; crop by margins in millimetres as the page is shown, or trim the white margins away; undo and redo; keyboard throughout, mirrored in Arabic |
| Compare (Warraq's engine) | what changed in the text between two versions — the file's own earlier revisions, or another PDF — word by word, with Arabic matching that follows the search (letter variants and diacritics optional); go to a change's page; and how each page looks, drawn and compared, with what looks different outlined — a drawing, a stamp or a picture the text cannot show; save the comparison, pictures included, as a report |
| AI (bring your own key, or local) | summarize, ask about, or translate the document with Claude on the person's own Anthropic key, or a model on this computer (Ollama or LM Studio). Nothing is sent before Send, and the screen first shows exactly what will go and where; the answer is shown as it streams in ("thinking" while the model thinks first), Stop keeps what arrived, and answers cite their pages. Refuses while redactions are marked but not applied. Four actions answer with data, shown for review before anything changes (the answer's shape asked of each provider: Claude's structured outputs, Ollama's `format`, an OpenAI-compatible `response_format`): **Correct the OCR text** — the words Scan & OCR kept with each page are sent; each changed word is listed ("محزر ← محرّر"), and the ticked ones are written into the text layer over the boxes they were read from. **Fill in the form from my details** — only the form's text fields (name, the words printed beside each, what it holds) and the pasted details go; the proposed values are listed to edit or leave out, then typed into the fields; the details stay in memory unless "Remember on this device" is ticked. **Find personal information** — the model's findings (names, addresses, numbers) and, with nothing sent, Warraq's own patterns (e-mails, phones, ID and Iqama numbers, IBANs, cards, dates) are looked up on their pages; the ticked ones become the Redact tool's marks, applied only there. **Extract the tables** — found on this device by the Excel export's own detection (ruling lines or columns, nothing sent), or read by the model for tables without either; shown as tables, then saved as CSV (UTF-8 with a BOM) or an Excel workbook written by the Excel export (a sheet each, right to left when Arabic, numbers as numbers written the way they were, the core's merged cells kept) |
| Combine (Warraq's engine) | add files (the open one comes first), reorder or remove them, unlock protected ones; the result opens in place, to save where you choose. The files chosen are not changed |
| Export (Warraq's engine) | Word (.docx, text only: paragraphs, direction and alignment, not layout), **Excel** (.xlsx: the tables the core finds on each page — drawn with rules, whose missing borders are merged cells, or lined up in columns without them — cell for cell, numbers as numbers in the format they were written in, Arabic-Indic digits and `٫` `٬` included, percentages and losses in parentheses too; the rest of the page's text in rows; a sheet for each page or for each table; a right-to-left page is a right-to-left sheet with its first column as A), **PowerPoint** (.pptx: a slide for each page at its size, the page drawn *without its text* behind the text as editable text boxes where it was, in its lines, size and colour, right to left where it is Arabic; or the text alone; a scan keeps its picture and its recognised text stays invisible), plain text, Markdown, a self-contained web page, and page images (PNG, zipped). Built from Warraq's own reading of the file as it stands now — a redaction applied in the viewer never reaches an export; unapplied marks are warned about |
| Create PDF (Warraq's engine) | choose files (or drop them on the window, or use Create PDF… on the home screen, which makes the PDF at once): list, reorder, remove; page size as each file says, A4 or Letter; portrait, landscape or as each page suits; a margin around pictures; *then read the text in the pictures* runs Scan & OCR on the new file before it opens. The panel names files it could not read, and says how many letters had no glyph and how many pictures were left out. **Word**: paragraphs with direction, alignment, spacing, indent and shading; bold, italic, underline, strike-through, colour and links inside them; headings; numbered and bulleted lists counted as Word counts; tables with widths, merged and shaded cells and repeated header rows; pictures at their size; sections of another page size; the header and footer with page numbers. **Excel**: every visible sheet as a paginated table (landscape when wide) showing what the cells show — number formats, dates, percentages, the value saved with a formula — merged cells across a row, right to left as the sheet is. **PowerPoint**: each slide a page of the slide's size and background, its text boxes where they are (placeholders placed by their layout, text sized by the master), bullets and numbering, theme colours, filled and outlined boxes, pictures, tables. **Web page**: a safe subset — headings, paragraphs, lists, tables with spans, quotations, preformatted text, pictures carried in the page; nothing runs and nothing is fetched. **Markdown** (CommonMark with GitHub tables), **text** (UTF-8, UTF-16 or Windows-1256), **CSV** |
| Scan & OCR (Tesseract + Warraq's engine) | choose the languages on the page and whether to read only pages without text; clean the scan up first — remove shadows and stains, strengthen the contrast, black and white, remove specks, remove dark borders — previewed on the page on screen, and optionally put the cleaned, straightened picture in place of the scan (one bit a pixel when black and white); progress page by page, and a stop button; the result reports words read, Tesseract's confidence and the pictures replaced. Nothing is sent anywhere; the models are bundled |
| Batch (Warraq's engine + PDFium) | files: add files or a folder (with its subfolders or not), or drop PDFs on the window; a password tried on protected ones. Steps, each with the options of its tool, in any order (Export last): Scan & OCR (languages, pages, cleanup, replace the picture), Compress (three levels), Rotate pages (all, odd, even or a list; either way or half), Delete pages, Keep only some pages, Page marks (text watermark, header, footer, page numbers, Bates), Remove hidden information (the kinds to remove), Flatten forms and comments, Protect (open password, permissions password, what is allowed), Export (Word, text, Markdown, web page, page images). Run: each file's state as it goes (which step, OCR's page), Stop after the step under way, a summary; a failure says why (not a PDF, needs a password, a step refuses it) and the rest go on. Results: desktop — beside each original with a suffix, or into a chosen folder, never over a file ("name (2).pdf"); browser — one zip, a folder's subfolders kept. Saved actions: named, kept on this device, used again or deleted; passwords never saved |
| Compress (Warraq's engine) | three levels — without losing anything, smaller images (150 dpi), smallest (96 dpi) — then save the smaller copy beside the open file or open it in its place; says when a file is already as small as it gets |
| Digital signature (Warraq's engine) | **Sign**: open a certificate file with its password (the signer, issuer, key and expiry are shown first) or, on the desktop, read a smart card through its PKCS#11 module after the PIN; sign visibly — drag where on the page, optionally with a picture of a handwritten signature, the name, date, reason and place drawn in Amiri, Arabic shaped — or invisibly, or into an empty signature field the form already has; approval or certification (no changes / forms and signing / also comments), optionally locking the form's fields; RSA PKCS#1 v1.5 or RSA-PSS, ECDSA P-256 and P-384; on the desktop, a trusted timestamp from DigiCert, Sectigo, GlobalSign, SSL.com, FreeTSA or an address typed in (the panel says the server sees only a digest). The file is signed as it stands, every earlier change kept as an update of its own bytes — with the file's own layer visibility, not the view's — and saved through the normal Save. **Check**: a banner the moment a signed file opens (who signed — the certificate's name, never the file's own claim — and valid / intact but the signer's identity not verified / changed after signing / invalid / not checked), and a list with each signature's details: why it is not simply valid, in one sentence under its status (for example "The signer's identity is not verified by a document-signing authority you trust: the certificate chains to ISRG Root X1, which browsers trust for web sites, not for signers"); the name the signature gives itself, marked as its own unverified claim when it differs; the byte range, the digest, the signature, the chain and where trust ends, validity, the timestamp (and whether its authority is trusted), revocation data in the file, and each kind of change made after it, permitted or not by its certification — each check worded as passed or failed, not only marked. Names are isolated for their direction in both languages. Trust a signer's root (or, for a certificate issued for another purpose, that certificate itself) with one click, or a certificate from a file; kept on this device only. **Keep**: on the desktop, add validation data (OCSP answers, revocation lists, certificates) to `/DSS`, and a document timestamp; a failure is said in words, the error codes behind "Technical details". When a tool that would break a signature is chosen — Edit, Organize pages, Scan & OCR, Page marks, Comment, Fill & sign (a picture or stamp on a forms-only certification), Prepare form, Redact, Protect — the banner says so before anything is changed; the attachments and layers panes say it beside their controls |
| Comment (EmbedPDF) | highlight, underline, strike out, sticky note, text box, freehand drawing, rectangle, arrow, link |
| Fill & sign (EmbedPDF) | type into a form's fields, draw or type a signature and place it, place a stamp |
| Prepare form (EmbedPDF + Warraq's engine) | **Detect fields** on this page or all pages: the proposals are drawn over the page — drag to move, drag the corner to resize, arrow keys to nudge, Delete to remove — and listed with their name and type (text, check box, date, Hijri date, signature) to change; **Create fields** makes them real AcroForm fields (Arabic ones right-aligned, the label as the tooltip, dates with their format). **Add a field by hand**: EmbedPDF's text field, check box, radio button, drop-down and list box. **Formats and calculations** for a chosen field: number (decimals, separators, negatives in minus, brackets or red, ر.س after or SAR before, Arabic-Indic digits), percentage, date (four patterns), Hijri date (Umm al-Qura, three patterns); an allowed range; a sum, product, average, smallest or largest of chosen fields, or an arithmetic expression over their names (Arabic names, quotes for names with spaces, Arabic-Indic digits), checked as it is typed and refused if it would go round in a circle. Filling the form — in Fill & sign or anywhere in the view — recalculates it; a value outside its format or range is put back, with a notice. XFA forms and scripts Warraq does not run are said so, in this panel and in Fill & sign |
| Redact (EmbedPDF + Warraq's engine) | mark text or an area, then apply: the text and images underneath are removed from the file, not covered. Find and redact: words found the Arabic-aware way, or emails, phone numbers (Saudi and international, Latin or Arabic-Indic digits), national ID and Iqama numbers, IBANs, card numbers, dates, or a pattern of one's own — each listed with its page and context — running heads and footers included, and page marks محرر PDF drew said to be one — the chosen ones marked over their glyphs — on pages turned by /Rotate, and on slanting or upright lines, each char where the reader placed it; a match it could not place is listed to be marked by hand, never guessed. A file whose permissions forbid changing its content takes no marks, and the panel says so; results belong to the file they were found in. Remove hidden information: metadata, scripts and actions (chained ones too), attachments, comments, form data, hidden layers, bookmarks, thumbnails, applications' private data, links, hidden text — reported in the interface's language, chosen, and removed by writing the file anew, its earlier revisions, unused objects and whatever still pointed at the removed ones (a tagged file's structure tree) gone with them |
| Navigation pane (Warraq's engine) | in both views, from the View menu: bookmarks with their levels (a click or Enter goes to the page; a heading with no page is shown as a heading, an entry that leaves the file says so; the tree and the pane tabs work with the arrow keys, mirrored in Arabic), attachments (saved, never opened; added with a description; removed), layers in their order with locked ones and print/export states shown, switched in the view only until *Save layer visibility with the file*; in Edit text also the page thumbnails |
| Protect (EmbedPDF) | require a password to open, restrict permissions |
| Cloud drives (OneDrive, Google Drive) | **shown only in a build that carries a client ID; this repository ships none, so by default there is no cloud control at all.** With one: Open… and Sign out for each drive on the home screen, the drive files opened lately as pages, and in the File menu *Open from…*, *Save to…* and *Save a Copy on This Device*. OneDrive is browsed by folder and searched; with Google Drive the person picks the file in Google's own picker, shown in its consent screen. Save writes a new revision checked against the version the file was opened at; a file changed in the drive since is offered as a copy, or replaced on purpose, never overwritten silently |

Each working tool has a test in `apps/web/e2e` that uses it the way a person
does — clicks the card, the control, the page — then saves the file, reopens
it and checks the change is in the file, not just on the screen. A test
keeps the count of *Later* cards at zero; a tool not built would have to say
so on its face.

## Prepare form, measured (2026-09-19)

Detection was measured on a labelled set: flat forms printed by Chrome
(Skia/PDF, as Google Docs and "Save as PDF" make them) with where a person
would put each field marked in their source and measured from the page
(`tests/fixtures/forms/make.mjs`, `truth.json`), plus the corpus's own flat
form. `cargo run -p warraq-core --example detect_fields -- --eval .` prints
the table; `tests/tool_forms.rs` holds a floor under it.

| Set | Forms | Fields | Found | Precision | Recall | Right type | Right name |
| --- | --- | --- | --- | --- | --- | --- | --- |
| First (detection built on it) | 6 (5 Arabic, 1 English) | 64 | 64 | 1.00 | 1.00 | 1.00 | 1.00 |
| Held-out, as first measured | 4 (3 Arabic, 1 English) | 28 | 27 | 1.00 | 0.96 | 0.74 | 0.78 |
| Held-out, after four fixes | 4 | 28 | 28 | 1.00 | 1.00 | 1.00 | 1.00 |

The held-out forms — other faces (Amiri, Cairo), colon-less labels, a shaded
box, a dotted line, check boxes inside a table, blanks in running text — were
written after detection was built and measured before anything was changed
for them. The four fixes were general, not per form: a box drawn inside a
table cell is the field, not the cell (and is named `row/column`); a dotted
line (a row of tiny squares) is a line; a label a line above a box or a line
is read; and in running text only the words beside a blank decide its type
("جرى التوقيع في مدينة ____" is a city, not a signature). So the held-out
numbers after the fixes are no longer held out; the first measurement is the
honest estimate for forms like these.

On documents that are not forms: of the 41 other corpus files (Word,
InDesign, LibreOffice, Google Docs, Acrobat exports, scans), 36 get no
proposal at all; the other five get 56, 38 of them in one MediaWiki guide
whose tables have an empty column. A frame at the page edge, a rule under a
heading, a page number's line, an empty cell beside a dash and a box around a
picture are not proposed.

Found along the way, and fixed with a test each:

1. **Fields made with a font size of 0 ("fit") took nothing typed in
   EmbedPDF**: its field editor draws the size literally, and at 0 the value
   typed was lost. Fields Warraq makes get a size their box holds.
2. **Warraq's reader cut Arabic-Indic numbers at the Arabic decimal
   separator**: `٧٥٫٠٠` read as `٠٠٫٧٥`, in Edit text, Export, Compare and
   search, and `٪` was joined to them as if they were European digits. The
   separators `٫` `٬` are now part of the number (UAX #9 class AN) and a
   terminator joins only European digits (class ET, rule W5).

## Scan & OCR cleanup, measured (2026-09-19)

A new corpus scan, `scan-notonaskh-300dpi-shadowed-stained-jpeg` (two pages
of the justified Naskh text, 300 dpi JPEG, with a book-fold shadow along one
edge, a shadowed corner and tea stains with the darker ring such a stain dries
into; `gen_scans.py --only=…`, truth beside it), was read with and without
each cleanup step. Two measurements, the same metric as `e2e/ocr.spec.ts`
(the share of the truth's Arabic words of three letters or more that were
read), each page scored on its own:

**In the browser, through the interface** (`e2e/ocr.spec.ts`, page 1, the
text layer read back in Edit text): **59 %** read as it is, **94 %** with every
cleanup step and the cleaned picture put in place of the scan.

**Every scan, every setting** (`src/ocr/measure.test.ts`, opt-in:
`WARRAQ_OCR_MEASURE=1`; Tesseract in Node on the pages the WASM core draws,
cleaned and straightened as the app does it; both pages of each scan):

| Scan | As it is | Shadows and stains | + contrast | Black and white only | Every step |
| --- | --- | --- | --- | --- | --- |
| Shadowed and stained (new) | 173/276 (63 %) | 255/276 (92 %) | 260/276 (94 %) | 253/276 (92 %) | 259/276 (94 %) |
| 300 dpi, skewed 1.3° (clean) | 260/276 (94 %) | 259/276 (94 %) | 258/276 (93 %) | 254/276 (92 %) | 256/276 (93 %) |
| 300 dpi, 8° crooked (clean) | 129/137 (94 %) | 128/137 (93 %) | — | — | 129/137 (94 %) |
| 200 dpi black and white | 21/30 (70 %) | 21/30 | 21/30 | 21/30 | 21/30 |

So cleanup lifts a damaged scan to what a clean one reads, and on a clean
scan it changes nothing beyond Tesseract's own noise (a word or two either
way) — which is why it is a choice in the panel, off until chosen. What is
left on the damaged page is where a stain's ring crosses a word: the ring is
as dark and as thin as a stroke, and no threshold tells them apart. The
first version of the stained scan drew its rings as dark as ink (0.28 of the
paper's light); at that, every step still read only 86–88 %.

**In the desktop app** (2026-09-19, macOS, a debug build of this tree, the
host's own log — `WARRAQ_DEBUG=1 WARRAQ_SELFCHECK=ocr|ocr-clean warraq-desktop
scan.pdf` runs the recognition by itself once the file is open): Tesseract's
SIMD core started in the webview in 266 ms under the host's security policy,
read the 8° crooked scan (181 words, confidence 88 %), and with every cleanup
step read the shadowed scan (363 words on 2 pages, both pictures replaced);
Warraq's reader then read the layer back as Arabic. Nothing needed changing
for the worker, its WebAssembly or its models. What this does not prove is
how the panel looks there: no screen could be seen (below).

## The Library: reading the files, measured (2026-09-20)

The Library indexes a whole folder and answers one search across it. Turning
each file into the text the index holds is `packages/ui/src/library/`, beside
the index itself (the core), the panel and the desktop host: all four are in
and the tool works end to end.

**What it reads, and how.** A PDF is read page by page by Warraq's own
reader. A page that carries no text of its own is a scan, and goes through
**Scan & OCR** — the same `ocr/run.ts` and `ocr/cleanup.ts` the tool uses,
reached through a new `readPagesWith`, never a copy of them; a PDF no page of
which carries text is indexed as a `scan`, so the filter for "has no text
layer" finds it even when nothing was recognized. A **picture** (PNG, JPEG,
GIF, BMP, WebP, every page of a TIFF; HEIC and AVIF where the browser draws
them) is made a page by **Create PDF**'s own `create.images` and then read
exactly as a scan is. **Word, Excel, PowerPoint, web pages, Markdown, text
and CSV** go through the readers in `create/` that Create PDF already uses;
a page break, and a page of its own size — which is what a slide and a
turned section are — start a new page, so a hit points at the slide it is
really on.

**Nothing heavy on the interface's thread.** The core has its worker,
Tesseract has its own, and everything else — unzipping, parsing XML, cleaning
a scan up, measuring how crooked it is, drawing thumbnails — is in the
Library's own worker (`library/ingest.worker.ts`); a file's content hash is
the platform's own digest, native and off that thread already. A job that
does not answer within 90 seconds has that worker dropped, a new one started
for the next file, and this file skipped: one hostile file cannot end a run
of a thousand.

**On the desktop it reads what the host walks.** The walk answers each file
as `new`, `changed` or `same` — by its size and date against what the index
holds, without reading a byte — and hands over its full path, which is its
key. A file the walk calls `same` and the ledger remembers at that same size
and date is not read at all; anything else is read through
`readLibraryFile(path)` when its turn comes, one file at a time, and hashed
here. A browser has no walk, so every file is read and hashed.

**Cleanup is on by default here**, unlike in Scan & OCR. Measured on a new
fixture, `tests/fixtures/create/photo-arabic.jpg` — the corpus's Noto Naskh
page taken smaller as a camera would, under light falling off across the
paper:

| The photograph read | Of the page's 138 Arabic words | Time |
| --- | --- | --- |
| as it is | 13 % (and 4 528 characters of nonsense) | 77 s |
| shadows evened out + contrast (what the Library does) | **93 %** | 13 s |
| every cleanup step | 94 % | 8 s |

Every step reads one word more and costs a folder twice the time — five times
on a 1924 manuscript — so the Library stops at the two. Scan & OCR leaves the
choice to the person, who can see the page; the Library never can.

**Fifty files, in Chrome, on this Mac** (`node scripts/measure-library.mjs`:
the real ingest, the real WebAssembly core, the real Tesseract and the real
worker, over the 48 corpus PDFs and the two picture fixtures, 18.5 MB):

| | |
| --- | --- |
| The whole run | **201 s** — 4.0 s a file |
| Reading the files' own text (42 PDFs, no recognition) | 12.5 s |
| Recognizing (37 pages of 6 scans and 2 pictures) | 188 s |
| Handing the text to the index | 71 ms |
| Indexed / skipped | 46 / 4 — the four are the corpus's encrypted variants, skipped as `needsPassword` because no password was given |
| Thumbnails | 46, 167 kB in all (192 px on the longer side, JPEG) |
| Slowest one file | 104 s — a 1924 manuscript scan |
| The scanned Arabic page | 97 % of the truth's words; searching «المستندات» finds it |
| The photograph | 93 %; «المستندات» finds it too |

So a folder of ordinary documents is read at about a quarter of a second a
file, and everything after that is Tesseract: a folder with scans in it costs
what Scan & OCR costs, once, and never again — a file whose size, date and
content hash are unchanged is not read a second time, which is also how a run
resumes after Stop, since only a file that finished is written down.

**How this part is proven.**

* `src/library/ingest.test.ts` and `reader.test.ts` (33 tests): every kind
  read into pages of text with the real fixtures and the real readers —
  Word, Excel, PowerPoint, web page, Markdown, text, CSV, a PDF page by
  page, a PDF with no text called a `scan` and still indexed, a picture made
  a PDF through `create.images`, a multi-page TIFF; unchanged files not read
  again; Stop and resume; a thumbnail of the first page and never one for a
  file that needed a password; and, hostile: a file that cannot be opened, a
  password not given, a file past the size bound, a reader that will not
  finish, page and character bounds, and the core refusing the file — each
  skipped with its reason while the run carries on.
* `e2e/library-ingest.spec.ts` in a real browser against the production
  build: a scanned Arabic page and a photograph of one, both read to text
  through the very paths the Library uses for them, and the words a search
  needs found in both.

**What is not proven here.** Holding that text and answering a search over it
are the core's (`library.*`) and the panel's, and are being written beside
this; the e2e that indexes a folder and searches across it comes with them.
The fifty-file measurement stubs `library.add` for the same reason, so its
numbers are the cost of reading, not of indexing. Office files, web pages,
Markdown and text get no thumbnail — nothing draws them without typesetting
them into a PDF first, which would cost more than the picture is worth; they
are shown by their kind. The ledger of what has been read keeps its last
10 000 files on this device (about 600 kB); past that the oldest are dropped
and those files are read again.

## Batch and the AI's data actions: how they are proven (2026-09-19)

* **Batch, in the browser** (`e2e/batch.spec.ts`): four files, one protected
  and one not a PDF, through rotate (odd pages), page numbers (Arabic-Indic)
  and compress — two done, the protected one refused by Compress with its
  reason, the other named as not a PDF, and the rest went on; the zip holds
  the two results, reopened by the core: page 1 turned, page 2 not, every word
  still there, the numbers Warraq's marks. A saved action (flatten, protect)
  comes back without its password and cannot run until one is given; the
  form it ran on opens only with that password and has no form left. A folder
  of scans, read with OCR and exported as text, keeps its subfolder in the zip.
* **Batch, on the desktop** (the host's log, `WARRAQ_SELFCHECK=batch:<folder>`):
  a folder of three "PDFs" listed, read and written through the host's
  commands — one not a PDF, named so; the two others rotated and numbered as
  incremental updates (the originals' bytes first), written beside them, and
  one written as `speech-selfcheck (2).pdf` because `speech-selfcheck.pdf` was
  already there. The writing rules themselves are Rust tests (`batch.rs`).
* **AI** (`e2e/ai-extras.spec.ts`, both providers faked): an OCR correction
  written into the layer and read back from the saved file; form values
  reviewed, one edited, typed into the fields and saved, and the request
  holding the fields and the details but not the page's other text; a name
  found by the model and ID numbers by the patterns marked for redaction,
  and nothing more sent while those marks wait; a table saved as a workbook
  (right to left, `1,200.00` as the number 1200) and as CSV, from a local
  model asked for the shape through Ollama's `format`.

## The Library's core, measured (2026-09-20)

The Library — one search across a whole folder of documents — is being built by
four agents at once. **This entry is part A alone: the core.** The panel is
another agent's work and is not described here; the reading of each kind of
file into text and the desktop host have their own entries. **Until
the panel lands there is no Library tool in the interface**, and nothing claims
one.

`packages/core/warraq-core/tests/tool_library.rs::the_whole_arabic_corpus_goes_into_one_index_and_is_searched_across`
offers the whole Arabic corpus to `library.add` one file at a time, searches
across the lot, saves the index and opens it again. On this Mac (Apple silicon,
release build, with several other agents working on it at the same time — so
these are what a busy machine gives, not its best):

| | |
|---|---|
| Files offered | 48 PDFs (`tests/corpus/arabic/{generated,realworld}`, the many-page performance fixtures left out) |
| Indexed | 44 — the four password-protected files are refused with `skipped: "password"` until one is given, and the run carries on |
| Read and indexed in | **3.7 s** — 83 ms a file: each PDF read page by page with Warraq's own reader, and what it says indexed. The two were not timed apart |
| The same folder offered again | **14 ms** — nothing has been written to, so `library.add` answers `unchanged` without opening a single file. The test fails if a second pass ever costs more than a fifth of the first |
| Words indexed | 65 028 |
| The index | **1 159 KB** written by `library.save`; `library.stats` estimates 1 125 KB, 3 % under (the test keeps the two within a quarter of each other) |
| One search across all 44 | **0.9 ms** (`العربية`, written without tashkeel; the test requires it in at least five different files, each hit marked inside the line the person would read) |
| Scans seen for what they are | the corpus's scanned pages go in as `scan` with no text of their own, for the interface to read with OCR and hand back; the test requires at least three |

An index of that shape costs about 18 bytes a word. These 44 documents run to
1 478 words each, so the cap of 48 000 000 characters — call it eight million
words of Arabic — works out at roughly 150 MB held and something over five
thousand documents of this size (`Known gaps`, below).

**Proved besides the numbers** (ten tests through `call_static`, the way every
host reaches the ops, and 56 more inside the module): a protected file skipped
until its password is given, and **the password nowhere in the bytes the index
writes**; a scan filled in by OCR text under the same key and then found; one
copy of a file changing while its twin keeps the old text; forgetting a file
taking it out of every answer; **400 damaged indexes** — truncated, flipped,
counts blown up to gigabytes, stretches cut out — every one refused with
`E_INDEX` and not one of them a panic; and the ranking's four claims (a phrase
beats scattered words, more beats fewer, short beats long, the whole query
beats half) each with a test of its own.

## The Library's desktop host (2026-09-20)

The Library — one search across a whole folder of documents — is being built by
four agents at once. **This entry is part D alone: the desktop host.** The
core's index and search, the panel, and the reading of each kind into text are
other agents' work and are not described here. **Until those land there is no
Library tool in the interface**, and nothing claims one: what follows is a set
of commands, documented in `apps/desktop/README.md`, with nothing in front of
them yet.

**What the host does** (`apps/desktop/src-tauri/src/library.rs`, reached through
`packages/ui/src/core/host-tauri.ts`):

* The native folder picker, several folders at once; `recursive` is what puts
  everything under each in the file scope, and nothing outside it is reachable.
* A walk of each folder and its subfolders on a thread of its own. It answers
  at once with the number naming the walk, then hands over batches of 256 files
  as it goes, with the folder being read now, and stops between entries when
  asked. No file's bytes are read to list it — one `stat` each — so memory does
  not follow the folder's size.
* Files read one at a time, when their turn comes, and only from inside the
  chosen folders.
* The index written into the app's own data directory
  (`<app_data_dir>/library/<name>.wlx`), whole or not at all — a temporary file
  renamed over the old one, so a crash halfway leaves the old index intact —
  and deleted for real when asked, half-written leftovers included. Never a
  temporary folder: it holds text out of the person's own documents.
* Files that changed while the app was closed, from the same walk: hand it what
  the index holds and each file comes back `new`, `changed` or `same` (size
  **and** date), with everything the index holds that no folder held any more
  reported as missing. A walk that was stopped reports none, because it met
  only part of the folder.

**Measured on this Mac**: a folder of 10 000 files across 20 subfolders is
walked in **40 ms** (`a_folder_of_ten_thousand_files_is_walked_without_reading_one`,
run it with `--nocapture` to see the number). How long indexing 50 corpus files
takes, how big the index is and how long a search takes are the core's and the
panel's numbers, and belong with their parts.

**Hostile folders.** A folder can hold anything, so nothing here is fatal: a
subfolder that refuses to be read, a file whose metadata is refused, a link
that points nowhere — each is reported as a skip with its reason
(`unreadable`, `link`, `too-deep`, `too-big`, `too-many`) and the walk carries
on. Depth (24), files (100 000), folders entered (100 000), entries looked at
(1 000 000) and a single file's size (512 MB) are all bounded per scan — and so
is what the walk holds while it runs: findings are handed over 256 at a time,
skips included, and each folder is remembered by its true path only up to that
same bound. A list cut short says it is short rather than look complete.

**Links.** A link that leaves the chosen folder is refused although the file
scope's own glob would allow it — the person chose a folder, not wherever its
links point — and a link inside one whose target is outside is refused at the
read as well, since the panel can ask for any path. That check compares the
target with the chosen folder as the file system truly names it: on macOS
`/tmp` is `/private/tmp`, and comparing a resolved target with an unresolved
scope would have refused honest files. Every folder is entered once, by its
true path, which is what keeps `deeper -> ..` from walking for ever.

**Watching a folder while the app runs is a re-check, and says so.** Every five
seconds the host walks the watched folders again — `stat` only — and reports
what was added, changed or taken away. It is *not* the operating system's own
notifications: FSEvents, inotify and ReadDirectoryChangesW each behave
differently, each fails silently in its own way (a network volume, a full watch
table), and none could be exercised on more than this one Mac. A re-check
behaves the same on all three systems and is tested. The cost is stated rather
than hidden: the answer carries how often it looks, so the panel can say it,
and it refuses folders holding more than 20 000 files — `watching: false`,
`reason: "too-many"` — instead of appearing to watch and watching nothing.
Whoever builds the panel must show that refusal; a "watching" light over a
host that answered `false` would be a façade.

**Proven by**: 15 Rust tests in `library.rs`, each making its own temporary
folder — the kinds listed and hidden files left out, a subfolder unticked, a
folder that refuses to be read, links out and links that loop, Stop,
the bounds, the ten-thousand-file walk, change detection, the watcher's
differences, the index written/read/deleted, index names that are never paths,
and the scope (`only_a_folder_the_person_picked_is_walked`,
`a_file_is_read_only_from_inside_the_chosen_folder`); 13 vitest in
`packages/ui/src/core/host-tauri.test.ts` for the bridge; and three contract
tests in `tests/desktop_contract.rs` pinning that every command the panel
invokes is registered, that both sides name the same events, and that the index
goes to the app's data directory and never to a temporary folder.

**Not done, and why**:

* **Not run on Windows or Linux.** The commands are written portably — `/`-separated
  relative paths on every platform, `canonicalize` on both sides of every link
  check (which carries Windows' `\\?\` prefix and with it paths longer than 260
  characters), a rename that replaces on all three, and the app's own data
  directory wherever the system puts it — but neither system is on this Mac, so
  none of it was exercised there.
* **Not exercised through the running window.** The commands are registered and
  pinned by the contract test, but no panel calls them yet, so the IPC itself —
  the raw bodies, the headers, the events — has been proven only by the vitest
  against a fake host. It should be exercised once the Library panel lands.
* **The watcher is a re-check, not live notifications** (above), and it does not
  watch folders past 20 000 files.
* **No thumbnails and no text**: turning a file into text is part C's, and the
  host hands over bytes only.

## How it looks (design refresh, 2026-09-18)

The shell now follows the system's document apps (Preview, Pages) instead of an office suite. The design
system is written down in `docs/design/README.md`, with screenshots in `docs/design/screenshots/`. It has one
set of design tokens modelled on macOS's semantic colours, used in light and dark, with increased contrast,
reduced transparency and reduced motion honoured.

| | |
| --- | --- |
| Toolbar | One unified toolbar in place of the ribbon and the status bar. It carries the document's title, with "Page n of m — Edited" under it; pages; zoom (which now drives EmbedPDF's zoom too); the markup toolbar; Edit text; a tool picker that opens a gallery of all nineteen tools; find; save; and the inspector. Its toggles follow what is really open in the view |
| Inspector | The tools pane, restyled: grouped inset sections, action lists, and macOS checkboxes, radios, pop-up buttons, segmented controls, steppers and switches. Every panel, including ones added later, gets the look from shared classes |
| Home | Rebuilt on 2026-09-25 to the owner's design target (see the section below). Recent files are shown as pages with a small picture of each first page, kept in this browser's storage and nowhere else: never for a file that needed a password, dropped the moment anything is marked for redaction, and dropped when the file is saved, since the saved file may no longer look like it (a new one is taken the next time it opens). The **Cloud drives** section is there only in a build that carries a client ID: each drive with its account, Open… and Sign out, and the drive files opened lately as pages that reopen from the drive (docs/cloud.md) |
| Dialogs and overlays | Dialogs are sheets. Popovers come out of their trigger. Toasts are a HUD. The find bar sits under the toolbar. The drop overlay is a material with one or two targets. Settings (⌘,) holds language and appearance |
| EmbedPDF | Themed with Warraq's tokens by reference. Its duplicated sidebar, zoom and search buttons and its floating page field (except on a phone) are gone. The rest of its bar is the markup toolbar, shown from Warraq's toolbar |
| macOS app | The title bar is merged into the toolbar, with the traffic lights in it. The toolbar drags the window and a double click zooms it. The system menu bar is built from the page's own menu model, in the interface language; its checks follow EmbedPDF's own state, it is sent again after every item chosen there, its Undo and Redo reach the typing in whatever field has the focus, and About opens the page's own sheet. A shortcut the page handles never runs its menu item too |
| Narrow windows | On a tablet the toolbar condenses. On a phone the inspector is a sheet, the sidebar floats over the page, and nothing scrolls sideways. On a touch screen (`pointer: coarse`) the controls, rows, toolbar and menu bar grow to 44-point targets; the look is the same |
| App icon | New original artwork (`scripts/icon/make_icon.py`): a calligraphic و on a sheet of paper. Desktop and extension icons are regenerated from it |

## The home screen and the shell's chrome (2026-09-25)

The owner sent a competitor's marketing picture and said "this design is the target". The desktop and
web home screen now has that structure — its layout, spacing and mood — on top of the existing tokens,
with nothing of theirs: no name, no artwork, no photograph, no copy. `docs/design/README.md` describes
the pieces; `docs/design/screenshots/home-*`, `organize-menu-en-light` show them. Proven through the
interface by `apps/web/e2e/home.spec.ts` (six tests) with the older specs kept green.

| | |
| --- | --- |
| The material | Frosted-glass panels over an original CSS gradient (sky, haze, green; navy in dark). Light and dark, RTL mirrored, solid under increased contrast and reduced transparency |
| Sidebar | Home · Recents · Starred · Tags (· Clouds only when a build carries a cloud client ID), then all twenty tools. The bottom line says how big the Library's index is on this device, or that there is none — the app has no quota to show and shows none |
| Search (⌘K) | Searches what this device really has: recent files by name, and the text of every Library document through the core's `library.search` when there is an index. A hit opens its file at the page of the match. A document that was added to the Library one file at a time cannot be read back by a browser: the hit says so, asks for the file, and opens it at the page once chosen |
| + | Open PDF…, Create PDF…, Scan from file… (the file opens with Scan & OCR chosen) |
| The hero | «ملفات PDF، من جديد.» / "PDFs, done right." and six action cards: Open PDF, Create PDF, Edit PDF, Convert, AI Assistant, More. Every one does something now |
| Recents | A row of pages with the time each was opened, a ⋯ menu (Open, Star, Remove from recents) and ‹ › paging; "See all" is the Recents place |
| Starred | A real per-device flag (`localStorage`, `warraq.starred`): on a recent file from its ⋯ menu, on a Library document from the star on a hit or a chosen document. The Starred place lists both and opens each — a Library document from where the Library found it; a recent file by asking for it, since only its name is kept |
| Tags | The Library's tags with counts; one opens the Library tool held to that tag |
| AI Assistant | Docked at the side with Summarize this document · Explain it simply · Translate · Find the key points · Make a quiz · Draft an email from it, and a question. Each chip is the AI tool's own action (Summarize, Translate) or a question worded for it; a chip opens the tool with the request chosen and asks for the PDF. The card names the provider (Anthropic with your key, or the local model's host); nothing leaves before the tool's Send button, which the test proves by watching both hosts |
| No bell, no avatar | There are no accounts and no notifications, so none are drawn |
| Organize | Every page has a context menu: Add Page, Delete Page, Extract Pages, Rotate Left, Rotate Right, Replace Page, Crop, Split PDF, Insert from File. Each is the panel's own operation on that page (with the rest of the selection when it is part of one); Replace Page is one step of the history, so Undo puts the page back; a protected file asks for its password in a sheet |
| Phone | The sidebar becomes a strip of place chips, the cards go two to a row, the recents a grid of three, the AI card sits below; nothing scrolls sideways; every target takes a finger |

Not done, and why: "Shared" (files that arrived by share or drop) is not a place — the app keeps no
record of how a file arrived, and listing recents again under another name would be a façade. A
greeting by the device's user name is not shown: a browser cannot know it. The Library's own picture of
a starred document is shown where the Library made one; a document without one shows the Library's glyph.

## The app's name

Since 2026-09-19 the app is called **محرر PDF** in every language and on every
host (the owner's choice): the Mac bundle `/Applications/محرر PDF.app`, the
window, the Dock and menu bar, the browser tab, the extension, and both
interface languages. Inside English sentences it is written between
right-to-left isolates, so it reads as it does in Arabic. *Warraq* (ورّاق) is
only the code name, left in the repository, crate and package names, and the
Mac bundle identifier `app.warraq.desktop` (kept so macOS keeps trusting
installs). The app icon still shows a calligraphic waw, the first letter of
the earlier name.

## Next (in order)
1. **Run the Windows and Linux builds on those systems**: print by pages, the drop targets and the NSIS installer have been built for them in code only — nothing of them has run here.
2. **Phone apps**: iPhone and iPad are the native SwiftUI app in `apps/ios` (its foundation above; the other parts in progress). Android is not started: it would need the Android SDK, NDK and JDK installed here (Decisions, below). The installable web app covers phones meanwhile.
3. Nastaliq Urdu in files without a ToUnicode map; Acrobat verification on a machine that has it.

## Decisions needed from you
1. **Register the cloud apps** (and one thing to check). The drives are built
   and proven, but no build offers them until you register an app with each
   provider and build with its client ID; `docs/cloud.md` is the step-by-step,
   with the redirect URIs, the scopes and the consent screens. Two parts are
   yours to decide:
   * **OneDrive** — one Microsoft app registration serves the web build (a
     single-page-app redirect URI) and the desktop app (a loopback one). No
     secret, and none may be added. Nothing else is needed.
   * **Google Drive** — a "Desktop app" client, scope `drive.file` only (a
     non-sensitive scope: basic verification, no security assessment). Its
     documentation calls the client secret optional for installed apps
     redeeming a code with PKCE, which is what the app does — but developers
     have reported through August 2026 that Google answers "client_secret is
     missing." all the same. **Sign in once in the built app after
     registering.** If Google refuses, either leave the Google client ID unset
     (no Google control appears) or decide to ship the value Google calls a
     secret and itself says "is not treated as a secret" for installed apps —
     which would change the rule *no client secrets in binaries*, so it is
     yours, not the app's. Google Drive is not offered in a browser at all:
     Google redeems no web client's code without a secret, and its
     browser-only alternative (the implicit grant, with Google's scripts in
     the page) is neither what was asked for nor what the security policy
     allows.
2. **GitHub organization** — nothing has been pushed: `gh repo create <org>/warraq --private --source . --push`.
3. **Xcode license** — `/usr/bin/cc` and the system `python3` refuse to run until `sudo xcodebuild -license accept` (needs your password). Builds work because they are pointed at Xcode's clang directly.
4. **Phone apps (Tauri 2 mobile)** — tried on 2026-09-19 and stopped, as it should, at tools this Mac does not have. Since 2026-09-21 iOS is no longer this route: the owner asked for a native SwiftUI app, which is `apps/ios` (above), simulator only until an **Apple Developer team** is set in `apps/ios/project.yml` for a device or TestFlight. The notes below stand for Android. What they need, all installs outside this project:
   * **iOS**: `tauri ios init` added the iOS Rust targets (`aarch64-apple-ios`, `aarch64-apple-ios-sim`, `x86_64-apple-ios`, user-level, through rustup) and then tried to install **xcodegen** with Homebrew, which is not installed. Steps: accept the Xcode licence (item 2); install Homebrew, then `brew install xcodegen cocoapods`; an Apple development team for signing (`APPLE_DEVELOPMENT_TEAM`, or `bundle > iOS > developmentTeam` in `tauri.conf.json`; a free Apple ID works for a simulator and your own phone); then `pnpm --filter @warraq/desktop tauri ios init`.
   * **Android**: `tauri android init` found no Android SDK. Steps: Android Studio (or the command-line tools) with the SDK, the NDK and a JDK 17; set `ANDROID_HOME`, `NDK_HOME` and `JAVA_HOME`; `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`; then `pnpm --filter @warraq/desktop tauri android init`.
   * Prepared here: `run()` is the mobile entry point (`#[cfg_attr(mobile, tauri::mobile_entry_point)]`) and the bundle names iOS 15 and Android API 26 as the lowest. Still to do in the host for a phone: the menu bar, `print_webview`, the drop events and the external opener are desktop APIs and need `#[cfg(desktop)]`; PDFium is bundled as a macOS dylib, and a phone needs its own PDFium build or the pure-Rust hayro renderer the browsers use; PKCS#11 smart cards do not apply.

## Fixed after the first install, 2026-09-17

The desktop app shipped unable to do anything at all, and the four causes are
worth keeping written down because each one failed **silently**.

1. **The crate never declared Tauri's `custom-protocol` feature**, so every
   build — including the bundled one — was a development build. It pointed the
   window at `build.devUrl`, a dev server that does not run on a user's
   machine, and the window came up empty. Pinned by
   `tests/desktop_contract.rs`.
2. **The open command clicked a hidden `<input type="file">`**, which WKWebView
   ignores unless the host implements the panel. It now calls the native one.
3. **Drag-and-drop listened for the DOM `drop` event.** Tauri catches the OS
   drop before the webview sees it and re-emits it; the host had always done
   so and nothing was listening.
4. **Save clicked a download link**, which a webview also ignores — it reported
   a save that never wrote a file. It now opens the native save panel.

A fifth would have surfaced next: the document carried its own
Content-Security-Policy, which a browser enforces *alongside* the one Tauri
serves, and the intersection would have cut the interface off from its own
host. The desktop bundle now leaves that policy to `tauri.conf.json`
(`apps/web/src/csp.test.ts`).

## Fixed on 2026-09-18, with the move to EmbedPDF

Each of these was found by clicking through the interface, and each now has a
test that fails without its fix.

1. **EmbedPDF's Arabic fallback font and its stamps were never shipped.** They
   were fetched from paths no host served, came back 404, and nothing said so.
   Both are bundled assets now, and every test fails on a 4xx/5xx response.
2. **The menus, shortcuts and status bar drove the hidden viewer.** Zoom, Find,
   Go to page, Undo and the page count all acted on Warraq's own view while
   EmbedPDF was the one on screen. They now act on whichever view is showing.
3. **EmbedPDF's own Open, Close and Download went around Warraq.** A file opened
   with its Cmd+O was one Warraq did not know it had. Those three are switched
   off; Warraq's File menu does them.
4. **In Edit text, Cmd+Z undid a hidden drawing** instead of the edit on
   screen: EmbedPDF stays mounted under the editor and its shortcuts still
   listened. They are switched off while the editor is up.
5. **A protected file could not be opened at all**, and after the Protect tool
   saved one, Warraq could not reopen its own output. There is a password
   prompt now, and Edit text reopens such a file with its password instead of
   failing behind the scenes.
6. **Closing Edit text never reopened the file in EmbedPDF.** Closing the old
   document fired EmbedPDF's "active document changed"; Warraq's listener then
   asked it what could be undone with no document active, that threw inside
   EmbedPDF's close, and the close never finished, so the edited file never
   opened and the old one stayed on screen. The listener no longer throws, the
   new file opens before the old one closes, and the tests check that EmbedPDF
   shows a new document with the new page count.
7. **Mid-switch, the editor showed the previous copy and took edits on it.**
   Handing the file between engines takes a moment; an edit made in it was
   silently lost. The screen now says the file is on its way, and nothing can
   be edited until it has arrived.
8. **A protected file lost its password when saved after a text edit or a
   page change.** Warraq's core decrypts a file to edit it and wrote it back as
   plaintext. It now keeps the file's key and seals everything it appends with
   it, naming the same `/Encrypt`: the update opens with the same passwords
   and keeps the same permissions. Checked on every cipher in the corpus (RC4
   40 and 128, AES-128, AES-256) by Warraq and, independently, by PDFium.
9. **Arabic typed into a form field or a text box was not drawn in the saved
   file.** PDFium stores the value but writes its appearance with Helvetica,
   which has no Arabic, so most readers showed the field empty. Warraq now
   redraws those appearances as the file leaves EmbedPDF — shaped, in an
   embedded subset of Amiri, with a ToUnicode — keeping the border and
   background PDFium drew, and grows a text box that is too small for its
   text, as Acrobat does. Checked in PDFium's own renderer.
10. **EmbedPDF's toolbar was English in an Arabic app.** It ships ten
   languages and no Arabic; Warraq adds a complete Arabic translation and
   switches it with the Language selector, and keeps its pages centred and
   its controls mirrored right to left.
11. **The e2e suite could test someone else's app.** It reused any server on
   the usual preview port, and another project on this Mac had one running.
   It now starts its own on a port of its own and refuses to share.
12. **EmbedPDF's screenshot, insert image, attachment and signature upload
   were hidden on desktop**, because they choose or save a file through a file
   input or a download link, which the macOS webview ignores. On desktop both
   now go through the native open and save panels (`core/desktopFiles.ts`),
   the way Warraq's own Open and Save do; a download is read from the blob the
   page made rather than fetched, so the security policy is unchanged. Tested
   in Chrome against a stand-in for the host, in the ways EmbedPDF does it
   (`e2e/desktop-files.spec.ts`).
13. **Search crashed on ﴾ ﴿ and U+FEFF.** Folding the Arabic presentation
   forms recursed on characters that have no other form, and overflowed the
   stack. Every character of those blocks is now searched for in a test.
14. **Text written in Amiri did not read back as typed** (found by Compare):
   Amiri draws kha, and lam before kaf, with two glyphs, and only the first
   carried text, so edits read back as ال�خير and للكن — in Warraq's reader,
   in EmbedPDF's search and in copy. A word whose glyphs do not spell it now
   carries its text as `/ActualText` (PDF 2.0 §14.9.4), in edits, added
   text, form appearances and the OCR layer; PDFium finds every such word,
   checked against it directly. Warraq's own reader honours `/ActualText`
   too, which also fixed Chrome-made Arabic PDFs: ten corpus files went from
   garbled or partial to exact (`tests/acid`, baseline raised).
15. **Shrink-to-fit never shrank the text.** An edit too long for its box
   reported a smaller size but was drawn at the old one with tighter lines,
   and ran out of the box; it is drawn at the size it fitted at.
16. **The desktop app could not print.** The macOS webview has no print for
   a page's content, and a webview's print would print the app around the
   document. File → Print now hands the file as it stands to PDFKit, which
   prints it in the system print sheet on Warraq's window: vector pages,
   scaled to the paper, a protected file with its password, and a file that
   forbids printing refused, as Acrobat does.
17. **Files dropped while Combine was open replaced the document** instead
   of joining the list: every drop opened its first file. A panel can now
   claim the window's drops — Combine does, and the drop overlay says what
   will happen — on the web and on desktop alike.
18. **Edit text's navigation pane still promised a later phase**: four of its
   five tabs — bookmarks, attachments, layers, comments — only said so.
   They are gone; the pane is the page thumbnails (EmbedPDF's own sidebar
   has the outline and the comments). The tool list no longer says "0 tools
   are not built yet", and a test fails if anything on screen promises a
   later phase.
19. **EmbedPDF's view kept the theme it started with**: choosing Dark or
   Light in the View menu changed Warraq's chrome but not the page view
   until a reload. The view now follows it live (e2e).
20. **An AI answer arrived in one piece after a silent wait** — minutes, with
   a model that thinks first. Answers now stream from Anthropic, Ollama and
   OpenAI-compatible servers as they are written; the panel says when the
   model is still thinking, and Stop keeps what had arrived, marked as cut
   off.
21. **Compare saw only the words.** A drawing, a stamp, a picture or a moved
   block did not show at all. Every page both versions have is now also
   drawn and compared, cell by cell past anti-aliasing, and the pages that
   look different are shown with what changed outlined — in the panel and
   in the saved report. When the words are the same and a page is not, the
   summary says so (e2e: a freehand drawing found this way).
22. **A crooked scan was read badly**: Tesseract read 56 % of the words of a
   page scanned 8° off true (80 % at 5°). Each page's slant is now measured
   from its lines of ink and the page straightened before it is read — 93 %
   at 8°, 92 % at 5° — and the invisible text is written turned back with
   the page, so it lies over the words. Warraq's reader follows a run's own
   slant within a few degrees of level, so those lines read in order.
23. **Paragraphs set with no space between them were one paragraph**: the
   World Bank speech's body came to Edit text, Export and the AI tool as a
   single 26-line block. A column's lines now part after a short line that
   finishes a sentence, and before a line indented from a full one — eight
   paragraphs of two to seven lines there, the rest of the corpus as it was.
24. **Save through EmbedPDF rewrote the whole file**, even with nothing
   changed: PDFium writes a document whole, so the file's own bytes — and
   any signature over them — were gone after a comment, a filled field, or
   nothing at all. PDFium keeps every object's number, so the objects it
   wrote differently are the changes: they are now appended to the file's
   own bytes as an update (`file.rebase`), on Save and on the way into Edit
   text, and a file nothing was done to saves byte for byte as it was. After
   a redaction the file is still written whole — an update would leave the
   redacted text in the revision before it — and so is a password added,
   changed or taken off. Stress run, 2026-09-18, Chrome: a 409 MB scan of
   100 pages opens and draws its first page in 3.2 s, reaches page 100 in
   0.15 s and saves in 8.6 s (most of it EmbedPDF copying the bytes out one
   at a time); unsigned files over 150 MB are saved whole, since the core
   would hold both copies at once (a signed one is not: see "Known gaps").
25. **A PDF dropped on an open document replaced it**, with no sign of what
   a drop would do on desktop (the webview sees no drag events). The host now
   forwards the drag, and with a document open the overlay offers two
   targets: Combine with it (the default) or Open instead. On desktop the
   target is the one last hovered, since the host reports the drop after the
   overlay has gone; positions are in the page's units on macOS and Linux and
   scaled only on Windows, where wry reports physical pixels; drags that carry
   no files get no overlay. Several files dropped with nothing open go to
   Combine together; Combine checks each file's first bytes, so a PDF without
   `.pdf` in its name joins as well. Windows builds make only the NSIS
   installer, which can write the Arabic name ورّاق (WiX's code page cannot);
   not yet built on Windows.
26. **Print in a browser did nothing.** EmbedPDF prints by putting the file,
   as a blob, in a hidden frame for the browser's PDF viewer, and the page's
   policy (`default-src 'self'`) refused the frame: the print dialog never
   came and nothing said so. `frame-src blob:` lets exactly that through
   (e2e: the frame opens in Chrome's PDF viewer, no policy error).
27. **Search and copy in the page view were PDFium's**, which reads most
   Arabic files out of order: the search found nothing a person could see,
   and Copy pasted words backwards or as presentation forms. They now answer
   with Warraq's reader (`embed/embedText.ts`, the core's `view.search` and
   `view.text`); e2e: seven hits where PDFium finds none, with and without
   the shadda, next and previous across pages; a copied page equals the
   corpus's truth file.
28. **EmbedPDF showed English under the Arabic interface** where its code
   writes the words instead of asking its translations: the loading screens,
   the text-style tooltips, a comment's missing date and its American date
   format, the stroke unit, the swatch for no colour, a signature's colours, a
   new list field's options, and search's next and previous, which had no name
   at all. Each is now looked up in Warraq's table as the bundle is built
   (`packages/ui/vite/embedPatches.ts`); a build fails if one no longer
   matches. New comments no longer record EmbedPDF's "Guest" as their author.
   e2e: every state of EmbedPDF — loading, each mode, menus, comments, text
   style, stamps, signature, a new drop-down, redaction, print, security,
   screenshot, search, sidebar — has no Latin word but the document's own and
   font names. In English the Form toolbar's fill button was named with its
   key, "form.toggleFillMode" (EmbedPDF's English has no string for it); the
   English it lacks is added to its own locale, and the same walk in English
   fails on any key shown as it is.
29. **The tool gallery ran off a phone's screen.** A popover was placed by its
   box as measured while it was still scaled down for its opening animation,
   so it landed too far along; it is placed by its layout size now (e2e at
   390 points wide).
30. **كتاب read as "كاتب" in Amiri** (found by the page view's search, which
   could not find it): Amiri kerns the alef of its kaf–taa–alef ligature
   under the taa, so the alef's origin sits right of the taa although it is
   drawn to its left. Within a run of touching glyphs drawn in one
   direction, a glyph that steps back by less than half the narrower advance
   now keeps its drawn order; the corpus's Amiri tashkeel page went from
   0.90 to 1.0, and a LibreOffice page's Aref Ruqaa lam–alef was fixed by the
   same rule.
31. **A refused form value went back to empty, not to the value before it,**
   when the two were typed in quick succession: the second commit replaced
   the first before the engine had reported it, so the first was never
   checked or kept (the prepare-form e2e failed whenever it ran alone, on
   main too). A field's commit now carries the text it held when it lost the
   focus, a second commit runs the first at once, and nothing being typed is
   overwritten by the check of what was typed before.
32. **An adversarial review of Page marks, pictures and links** (three
   reviewers a feature, each finding confirmed) found these, now fixed, each
   with a test that failed before: a hostile content stream crashed the core
   (`BI (\`: the lexer stepped past the end), an inline image's length
   wrapped on 32-bit WebAssembly and looped the lexer forever, a form that
   drew itself was walked 50⁸ times, and lexing kept every operation with no
   bound — the lexer and the picture walker are now bounded and fuzzed
   (`fuzz/lex_content`, and a stable harness in CI). Find and redact missed
   Word's headers and footers, because the reader dropped every artifact:
   only Warraq's own marks are kept out of the page's text now, and search
   and redaction read everything. A picture in a form or a content stream
   another page draws was edited on every page; a deleted or replaced
   picture stayed in the page's resources; replacing one in a form without
   resources broke the rest of the form; a phone photo went in sideways; a
   small tiled watermark stopped short of the top of the page. A link's
   question could be disguised with bidi controls. In the interface, the
   Page marks preview re-drew itself forever, its number fields could not
   be typed (12 became 52), the panel stayed disabled if chosen before a
   file was open, labels promised digits the mark does not draw; picture
   and link changes could not be undone and Cmd+Z undid an older text edit
   instead; the arrows nudged a picture once; the picture and link panels
   stayed on screen after Edit mode was turned off.

## Fixed on 2026-09-19, with Batch and OCR cleanup

1. **Scan & OCR wrote its layer onto PDFium's copy of the file.** The layer
   is an incremental update, but it was appended to the file as EmbedPDF
   rewrote it whole, so the file's own bytes — and a signature over them —
   were gone after OCR. It is now appended to the file's own bytes, as Page
   marks' changes are (`e2e/ocr.spec.ts` checks the prefix).

## Fixed after the redesign review, 2026-09-20

Three reviewers went over the Apple-style redesign and a fourth confirmed each
finding. Eighteen were raised, ten of them distinct; every one is fixed, each
with a test that fails without its fix.

1. **The home screen kept a picture of page 1 as it was before a redaction.**
   The recent grid's picture was taken when a file opened and never replaced,
   so after marking and applying a redaction, deleting a page or setting a
   password and saving over the file, the home screen still showed the page as
   it was. It is now forgotten the moment anything is marked for redaction (and
   none is taken while that file stays open), whenever the file is saved, and
   when a file that needs a password opens under a name that had one
   (`e2e/recent.spec.ts`).
2. **Opening any file drew its first page with no limit on its size.** The
   picture was drawn on every open, at a scale set by the page, and nothing
   bounded it: a page of 170 000 points was drawn at 72 million pixels (that
   much was run), and the million-point page the review describes would ask
   for gigabytes — on wasm32 an allocation that aborts the core, which was not
   run here. The picture is now sized to fit both ways and skipped past that,
   and no render anywhere may pass 64 million pixels: the core refuses before
   allocating, for both sizes (`robustness.rs`). Warraq's own view draws a
   large page at a high zoom a little softer instead of hitting that limit.
3. **In the macOS menu bar, Undo could not reach the typing in a text field.**
   The page's own Undo item replaced the system's role but was enabled only by
   the document's history, so typing in a field (the first paragraph edit, the
   page field, the password sheet) could not be undone from the menu; and it
   aimed by `document.activeElement`, which inside EmbedPDF's shadow root is
   its host, so in EmbedPDF's search field the menu took back the last drawing
   instead. Both now follow the focused field and what its typing can undo. The
   paragraph editor undoes its own typing on ⌘Z, and shortcuts match the key's
   place when the layout is not Latin (an Arabic keyboard types ئ on Z).
4. **About could not be opened on the Mac.** The app menu's About was the
   system's panel, which never reaches the page: the core's version, the engine
   drawing the pages and the privacy note were nowhere. It is the page's own
   sheet now, and a desktop core that could not load PDFium says so in a badge
   beside the document's title.
5. **Checks and pressed states that come from EmbedPDF went stale.** The
   sidebar and Find buttons and the View menu's Fit width, Fit page and
   navigation-pane checks were read while drawing, and nothing drew again when
   EmbedPDF changed. They follow its command state now; the macOS menu is sent
   again after every item chosen there, because the system flips a check item's
   own mark; and in Edit text the sidebar button no longer shows the state
   before the click. Find there can be pressed off again.
6. **The arrow keys in the tool picker moved the focus out of it.** Left,
   Right, Home and End went through the popover's portal to the toolbar behind
   it, and opening the picker from the keyboard left the focus on its trigger
   (the popover took focus while still hidden). Fixed both ways; Home and End
   go to the first and last tile.
7. **Settings' segmented controls announced a radio group they did not have.**
   Every option was a Tab stop and the arrows did nothing. They are one Tab
   stop now, and the arrows move and choose, following the reading direction —
   the same for Edit's kinds and Prepare form's scope.
8. **A phone could not show the markup toolbar at all**, and View › Tools pane
   flipped a check and showed nothing while no tool was chosen. The View menu
   has a Markup toolbar item (the macOS menu bar gets it too), and Tools pane,
   the toolbar's inspector button and Shift+F4 are offered only when a sheet
   can rise.
9. **The phone's sheet drew a grabber that could not be dragged.** It drags
   now, with the system's sheet physics, and closes when the drag — carried on
   by its speed — passes half the sheet.
10. **The Shortcuts sheet sent people to the status bar**, which the redesign
    removed, in both languages. It names the toolbar's page field and Edit ›
    Go to page now, and is shown only in a browser, since only a browser keeps
    that key for itself. A test fails on any string that mentions the status
    bar or the ribbon again, and their leftover strings, rules and tokens are
    gone.

Also found while looking: the app's Arabic name was letter-spaced inside the
English interface, which breaks the joins (it is marked as Arabic now); the
tool picker had no height limit, so a short window would have cut it off; a
first keystroke was swallowed by the new focus tracking until it was moved
off the input event's own dispatch; and Edit PDF's picture and link layers
ignored a press until the page's pictures or links had been listed without
saying so anywhere — they carry `aria-busy` while they wait now, which is
also what the end-to-end tests that draw by dragging wait for (they had been
pressing into a layer that was not ready, and failed whenever the machine
was loaded).

## Fixed after a review of Redact and the navigation pane, 2026-09-20

Three reviewers read Find and redact, Remove hidden information and the
navigation pane, and a fourth tried to refute each finding. Each one below
was reproduced first by a test that failed, and each test passes now.

1. **A redaction came back in the saved file** when layers were shown by
   choice and the file then went through Edit text or Organize pages: the
   save was kept as an update of the file's bytes from before the redaction.
   Those bytes now remember the redaction, and nothing is kept as an update
   of them (e2e: the redacted words are nowhere in the saved bytes).
2. **Remove hidden information left removed comments, fields and attached
   files in tagged files**: the structure tree points at each annotation
   (`/OBJR`), which kept it — with its text, its field's name and value, its
   embedded file — in the file written whole. What pointed at them is taken
   out now (Rust and e2e: every marker gone from the bytes and every
   inflated stream, the structure tree still there).
3. **Scripts chained after another action (`/Next`), and actions held as
   objects without `/Type`, were neither reported nor removed.** They are
   both now, wherever they sit.
4. **Find and redact never read headers, footers and watermarks** (text
   marked as an artifact, as Word and Page marks write them): it reads every
   glyph of the page now — other programs' artifacts as the page's text, the
   page marks محرر PDF drew apart, each once — and says a match is in one of
   those marks.
5. **Marks were misplaced on turned pages and slanting lines**: on a page
   turned by /Rotate or a crooked scan's text layer the mark was an even
   share of the line's box — the wrong word, or a whole line, or a strip.
   Each char is now boxed where it was drawn, in its run's own frame (Rust:
   /Rotate 0, 90, 180, 270, an 8° page, an upright margin line, against the
   glyphs; e2e: only the word gone, its neighbours all there).
6. **Removing hidden layers could show what they hid**: membership
   dictionaries' policies and expressions, and a layer's own view state,
   were ignored, and a hidden layer was taken out of the file even where
   content that depends on it stayed. Hidden is now decided as PDFium
   decides it, appearance streams are cleaned too, and a layer that is
   still needed stays, switched off.
7. **"N marked for redaction" was said when none were**: a file whose
   permissions forbid changing its content takes no marks. The panel counts
   what the view took, and says why when it took none (e2e: such a file).
8. **Card and IBAN numbers after another group of digits were missed** (a
   row number, an expiry date), and **a match partly overlapping another
   was dropped with its tail**. Both are found whole now.
9. **The Redact panel kept the previous file's results** after another file
   was opened, and would mark or remove with them. It starts afresh.
10. **White text on a coloured band counted as hidden text**, and removing
   hidden text deleted it; outlined text in the default black counted too.
   Only white on white counts now.
11. **A second form flattening overwrote the first one's drawings.**
12. **The report was half English in Arabic** — annotation kinds, property
   names, PDF dates. The core now says what it found in structured words
   that the interface translates.
13. **Smaller ones**: a failed check said a removal had failed; a bookmark
   that only heads others looked like a disabled external link; the pane
   tabs and the bookmarks tree had no arrow keys, and layers claimed to be
   a tree that could be collapsed; attaching a file in Edit text threw away
   its undo history; attachment rows sat lopsided in Arabic; and several
   Arabic strings read word for word from the English.

## Known gaps, stated plainly
* **The Library has a core and no face yet.** `library.open/add/forget/search/document/tag/rules/stats/save/close` all work and are tested, the readers turn every kind of file into text, and the desktop host can walk a folder and keep an index — but nothing in the interface calls any of it: the panel is the one part still in flight. Until it lands, the Library cannot be used by a person.
* **The Library's index is capped, and says so.** 200 000 documents; 2 000 000 characters and 400 000 words of any one document; 48 000 000 characters in the whole index — about 150 MB held, and something over five thousand documents the size of the Arabic corpus's (measured above). Past a cap a file is skipped with `indexFull`, or its text is cut with `truncated`; nothing fails silently, and nothing grows without end. A person with a bigger library than that needs a second index or a cap raised in one constant.
* **The Library ranks with one rule, and it is a judgement.** BM25 with a phrase bonus (`packages/core/API.md`): a phrase beats scattered words, more matches beat fewer, a short document beats a long one on the same count, and a document holding the whole query beats one holding half of it. It was tested against those four statements, not against people searching their own files — nobody has used it yet.
* **The document's date is a guess, and a scored one.** It is read from the first three pages, and where a document carries several dates the one beside a label, near the top of the first page, with its month written out, wins. A document that carries a deadline more prominently than its own date will show the deadline. A date is read as Hijri when its month is a Hijri month, when هـ or AH follows it, or when its year is between 1300 and 1500 — a Gregorian year in that band, in a historical document, would be converted wrongly.
* **The Library's core reads PDFs and nothing else.** Word, Excel, PowerPoint, HTML, Markdown, text and pictures reach the index only as text the interface read and handed back, which is what `packages/ui/src/library/` now does; the core never opens them itself. A PDF whose pages carry no text is reported as a scan and stays unsearchable until the interface reads it with OCR and hands the words back under the same key.
* **PDF/A and PDF/X are checked by Warraq's own validators only.** veraPDF, the reference PDF/A validator, is GPL/MPL and Java: it is not bundled, and it was not run on this machine. Each copy passes Warraq's validator, which checks exactly these rules (clauses of ISO 19005-2, the same numbers in -3; the -1 clauses in `warraq-pdf/src/standards/pdfa.rs`): file header, file identifier and nothing after `%%EOF` (6.1.2–6.1.3); no encryption (6.1.3); cross-reference tables for PDF/A-1 (-1 6.1.4); no streams in outside files (6.1.7.1); no LZW, Crypt, or JPEG 2000 in PDF/A-1 (6.1.7.2); implementation limits (6.1.13); one output intent profile, monitor or printer class, N matching (6.2.3); device colour only as the output intent allows, else a default colour space (6.2.4.3); embedded ICC profiles readable, N matching, version ≤ 2 for -1 (6.2.4.2); overprint mode 1 with ICC-based CMYK (6.2.4.2); transparency (none in -1) and only standard blend modes (6.2.10); transfer functions, halftones other than types 1 and 5, unknown rendering intents (6.2.5); alternate images, OPI, interpolation, bit depths (6.2.8); reference XObjects and PostScript (6.2.9); operators ISO 32000-1 does not define, and content that cannot be read (6.2.2); fonts embedded, their programs holding every glyph shown, widths matching (within 1/1000 em), TrueType encodings and cmaps, CIDToGIDMap, CIDSet (6.2.11); every character with Unicode for -2u (6.2.11.7.2); annotation types, print flags, appearances (6.3); forbidden and named actions, automatic actions, JavaScript (6.5); NeedAppearances and XFA (6.4); XMP present, unfiltered, with the PDF/A identification, and in step with the document information (6.6); embedded files per level, associated-file relationship, MIME type and names for -3 (6.8); layers named, ordered, without `AS` (6.9); alternate presentations and presentation steps (6.10); permissions (6.1.12). Not checked: the rest of ISO 19005 — among them the ICC profiles' own contents, every font format's internals (Type 1 and CFF programs are not parsed), Type 3 glyph procedures, image data, and the structure of every dictionary. PDF/X-4: one GTS_PDFX output intent with a printer profile, device colour, fonts embedded, a trim or art box (not both) inside the bleed and media boxes, nothing printing inside the page's boxes, no JavaScript or automatic actions, no transfer functions or PostScript, XMP with PDF/X-4, identifiers and dates, `Trapped` true or false, and a title.
* **PDF/A-2u passes on 24 of the 49 corpus files** (`the_whole_corpus_converts_at_every_level`, release, ignored). Warraq completes a font's own ToUnicode where the reader's rungs (cmap, GSUB, glyph shape) name a glyph, and leaves alone a font with no map at all — a partial map would send the rest to the font's encoding and read Arabic as Latin letters. What remains are subsets with neither cmap nor GSUB (Chrome, CoreText), dots drawn as separate glyphs, and Type 3 marks: the copy is still written, and says it is not 2u. Every copy reads in Warraq as its file did, or nearer the truth (84 copies: 83 word for word, 1 nearer the truth where a broken map had lost letters — `every_corpus_copy_reads_as_well_as_the_file`).
* **A substituted font moves letters.** A font a file names but does not carry is replaced by bundled Inter, Cairo or Amiri — the closest in style that has the characters — keeping the file's own codes; the new face's widths are its own, so lines can run a little longer or shorter than before. The report names each one. A font named through a CMap other than Identity (a Chinese GB1 font in one corpus file) cannot be replaced: its codes cannot be turned into characters, and the copy says it is not PDF/A.
* **PDF/X: no press profile ships, and colour is not converted.** FOGRA, GRACoL and Japan Color profiles may not be redistributed; the person brings their printer's. RGB is made device-independent with sRGB, and PDF/X-4 leaves the conversion to the press. The profile in `tests/fixtures/icc/` is generated for tests and describes no press.
* **PDF/A-1b is refused, with the reason, for a file with transparency, layers, JPEG 2000 or 16-bit pictures** — flattening them would change how the page looks; choose PDF/A-2b.
* **The accessibility checker is not a PDF/UA validator.** It reads sixteen things a file can say (listed in the panel with their PDF/UA-1 clauses) and marks contrast, whether the reading order makes sense and whether alternative text says what a picture shows as for a person to judge. It does not claim PDF/UA: no `pdfuaid` is written.
* **What the tagger does not do yet.** Vector drawings (charts drawn with paths) are artifacts, not figures, unless a figure box is drawn round them in the reading order; tables are found only where lines share columns of wide gaps (not by ruling lines), with the first row as the header; list items get a body, not a separate label; headings are found by size alone, so a bold title in the body size stays a paragraph until relabelled; artifacts in form XObjects are left as the file had them. Tagging writes a touched annotation's `/Rect` through lopdf, which keeps reals as f32: on one corpus file, one pixel at an annotation's edge flips its antialiasing in Warraq's renderer (PDFium, which reads reals as f32, is unchanged).
* **No AI suggestion for picture text.** The AI tool sends text only; describing a picture needs the picture sent and shown first, which is not built. The panel offers no such button.

* **The Library: what it is not.** Its four parts are joined and the tool works end to end, but three things came out of joining them and are worth saying. The core counts a matched word in **UTF-8 bytes** and answers a hit’s **page from one**; the contract in the brief pins down neither, and the second had the core counting from zero while the readers counted from one — pages are one-based at the operation’s edge now (`library/mod.rs`), and the panel turns byte places into places in the line before it marks anything. The brief’s table has no operation for the tag rules and the core added one (`library.rules`), which is where the rules live and where they are run. **What the panel does not do**: the index is written whole after every run and every change of tags, so a very large one is rewritten each time; a run that ends in something systemic — the engine gone, a worker lost, which no test has produced — shows its error and lists what went unread, but its summary line says “Added: 0”, because that run never reached the point where the index is written to this device (the files it had read are in the open index and findable until the tab closes); in a browser without the directory picker (Safari, Firefox) a folder comes in through `webkitdirectory`, and those files are in hand only while the tab lives — after a reload a hit in one of them is reported as moved or gone rather than opened from somewhere it never was (Chrome’s folder handle is kept, and the browser asks once before it is read again); and the desktop watcher, the folder walk and the index in the app’s data directory are driven by the panel but were exercised by the host’s own Rust tests on macOS, not by a test that clicks them — everything a browser can do is clicked (five e2e).
* **The Library, measured** (this Mac; the WASM core in Node, driven straight at `library.*`, so no Scan & OCR is in these numbers): the first 50 corpus PDFs — 18.8 MB — were read in **21.1 s**, 46 of them indexed and 4 refused because they are password-protected. The index came to **2.74 MiB** (2 870 345 bytes) for 46 documents, 946 pages and 172 428 words, about a seventh of the PDFs’ own bytes, and reading it back takes **80 ms**. A search answers in **0.3–1.9 ms** in the median over those 50 files, the worst of a hundred runs 18 ms — which is why the results follow the typing rather than waiting to be asked. The core's own measurement agrees: 48 corpus PDFs indexed in 3.7 s, an index of about 1.1 MB, a second pass over an unchanged folder 14 ms, one search 0.9 ms. Through the interface, where the readers and Scan & OCR do the work, the same 50 files take **201 s** (part C measured it): almost all of that is recognising scans, about four seconds a file, which is why the panel says so beside the switch that turns it on and keeps Stop within reach the whole time.
* **Batch: what it is not.** PDF/A is not one of its steps: there is no PDF/A conversion on main yet (a step plugs into `batch/steps.ts` when there is). In a browser the results are held in memory until the zip is made, so a batch of very many large files needs the memory for all of its results; on the desktop each is written as soon as it is done. Files dropped on the desktop window have no folder to go back to, so their results need a chosen folder. Protect and Flatten go through PDFium and write the file whole (as EmbedPDF's own Protect does); Flatten refuses a protected file rather than write it without its protection, Compress and Remove hidden information refuse one as their tools do. A saved action's page marks are text only (a picture watermark would have to be kept with the action). The batch was run in the desktop app through its self-check, not clicked there by a person: the native panels for files and folders are the ones Combine and Open already use.
* **The AI's data actions: what they are not.** OCR correction needs the words Scan & OCR now keeps with each page: a layer written before 2026-09-19 has none and is not offered (take it off with Remove hidden information → hidden text, and recognise again). The words are the page's private application data (`/PieceInfo`): Remove hidden information lists them as such, and removing them ends later correction while the layer itself stays. A corrected word that the correction split or joined lies over the boxes of the words it replaced; a word the model adds joins the word before it. Smart fill fills text fields only — check boxes, radio buttons and lists are left for the person. Personal information is found as the model and the patterns find it; each finding is then looked up on its page with the Arabic-aware search, and one the page does not have is shown but cannot be marked. Tables read by the model come from the page's text in logical order and are checked against the page by the person; tables found on the device are the Excel export's detection, with its limits (below).
* **The cloud drives are proven against stand-ins for the drives, not against the drives themselves.** No app is registered with Microsoft or Google here, so nothing has ever signed in to a real account. What the tests do check is the protocol: the stand-ins are written from the providers' documentation and refuse what the real ones refuse — PKCE against the challenge, the redirect URI and the origin a code is redeemed from, a secret from a public client, bearer tokens, `If-Match` (412), `conflictBehavior` (409), upload ranges in multiples of 320 KiB, no Authorization on an upload address, and drive.file's rule that a file the person did not pick is "not found". Two things can only be found against the real services, and `docs/cloud.md` says so: whether Google's token endpoint asks a Desktop app client for its "secret" despite its documentation, and whether a particular OneDrive account's download and upload addresses fall under the hosts the policy names (`*.1drv.com`, `*.sharepoint.com`, `*.microsoftpersonalcontent.com`).
* **Google Drive is desktop-only, and its conflict check has a window.** A browser build ships none: Google redeems no web client's code without a client secret. On the desktop, Drive v3 has no conditional write, so a save reads the file's head revision and refuses if it changed — someone saving in the moment between that read and the write would still be overwritten. OneDrive's `If-Match` has no such window.
* **A browser sign-in to OneDrive lasts 24 hours at most** (Microsoft's lifetime for a browser app's refresh token), and only if the person ticks *Stay signed in on this browser*; otherwise it ends with the tab. On the desktop the refresh token is kept in the system keychain and never reaches the window — on macOS, a rebuilt app is a different signer, so the keychain asks the person once whether the new build may read what the old one kept.
* **Microsoft lets a public client revoke nothing.** Signing out forgets the sign-in on this device; withdrawing the app's access is done in the person's Microsoft account, and the app says where. Google's token is revoked on sign-out.
* **The cloud drives are not in the extension**, and not offered there: it has no page a provider can send a sign-in back to.
* **Only the person's own OneDrive is browsed** (`/me/drive`, with shortcuts to other drives followed): SharePoint sites and shared libraries are not listed, and national clouds (US Government, China) are not supported.
* **Create PDF lays content out itself, and plainly.** It is not Word's, Excel's or PowerPoint's layout engine: one face (Amiri, with Inter for what Amiri lacks) and one size per paragraph, greedy line breaks at spaces (no hyphenation, no kashida), tables whose cells can span columns but not rows (a cell merged down is left empty below it). Not read: Word's text boxes, shapes, footnotes, comments, columns and a first page's own header; Excel's charts, pictures and cell colours, and anything past 2,000 rows or 60 columns of a sheet (the panel says so); PowerPoint's charts, SmartArt, gradients, shapes other than boxes (drawn as their box), rotation, animations and notes; a web page's style sheets (only a `style` attribute's colour, alignment and direction) and any picture it does not carry itself. HEIC and AVIF pictures are made into PNGs by the browser, so they work where the browser can draw them (Safari and the macOS app for HEIC). The Office files Create reads and the exports it writes are checked against ECMA-376's content models by the tests (`packages/ui/src/export/ooxml.testing.ts`) and by the browser's XML parser; the official XSDs are not in the repository, and the exports have not been opened in Office itself on this Mac (no Office is installed).
* **Excel export finds tables, it does not read their meaning.** A table drawn with rules becomes a grid, a missing border a merged cell; a table without rules is found where lines cut at wide gaps stand in the same columns one under another — a two-column page layout can be taken for one. Numbers are only what is plainly a number (a leading zero, a date, a phone number and anything with letters stay text).
* **Prepare form — what is and is not proven.** Detection is measured on Chrome-printed forms and the corpus (above); forms made in Word, InDesign or by hand-coded generators have not been labelled, and a scanned form gets no proposals at all — its boxes and lines are pixels, not drawing. On a page that is no form, a table with an empty column gets proposals. The proposals are drawn over EmbedPDF's pages by reading its page layout (2.15.1); if the view is turned with EmbedPDF's own rotate, they are drawn unturned. Signature fields are real, empty signature fields for a digital signature: Digital signature offers them and signs into one visibly, in its own box (proven on a field Prepare form made: `tool_signatures.rs` and `e2e/signatures.spec.ts`); Fill & sign places a drawn signature anywhere, over them too.
* **Form scripts: only the standard subset runs, and only inside Warraq's own interpreter.** Recognised: `AFNumber_*`, `AFPercent_*`, `AFDate_*` (the numbered and the `Ex` forms), `AFSpecial_*` (the four US masks), `AFRange_Validate`, `AFSimple_Calculate`, `event.value =` arithmetic over `getField(…).value` (simplified field notation), and Warraq's own `Warraq_Digits`, `Warraq_LatinDigits`, `Warraq_HijriFormat` and `Warraq_HijriKeystroke`, whose JavaScript definitions travel in the file for other readers and are recognised by their exact text. Anything else — document scripts, open actions, mouse and focus actions, a calculation with a variable or a loop — is listed in the panel (up to 100) and never run. A `/CO` a file leaves incomplete is completed in the form's order.
* **While a form is filled in Warraq, a formatted field shows the value as typed** (`1500`): PDFium runs no format script. The formatted look (`١٬٥٠٠٫٠٠ ر.س`) is drawn into the file when it is saved, and readers that run form scripts format it themselves. A value is checked when its field loses the focus; a calculated field is not made read-only.
* **Warraq's own functions have not been run in Acrobat**, which is not installed here; they were run as a form reader runs a field's script (an `event` object in a sandbox, `forms/readerScripts.test.ts`) and agree with the Rust that Warraq runs. In Acrobat, Arabic-Indic digits typed into a number field become Western ones through `Warraq_LatinDigits`.
* **Hijri dates** follow the Umm al-Qura table from 1356 to 1500 AH (1937–2077), checked against ICU on every 97th day; outside it they follow the tabular Islamic calendar, which can be a day off. Gregorian date patterns with a time show midnight.
* **XFA**: a static XFA form is filled through its AcroForm fields; readers that prefer the XFA layer may still show its old values until *Remove the XFA layer* is used. A dynamic XFA form is shown only as its file draws it without an XFA engine — usually a "please wait" page — and cannot be filled; the panel says so.
* **Digital signatures — what is and is not proven.** Proven by tests: signing an Arabic corpus file with RSA (PKCS#1 v1.5 and PSS), P-256 and P-384 keys from legacy (3DES/RC2-40) and modern (PBES2/AES-256) .p12 files, and `openssl cms -verify` (LibreSSL 3.3, an independent implementation) accepting every one and refusing each once a signed byte changes; a protected (AES-256) file signed and still protected; a form filled after signing (permitted) and after locking (not); page content drawn after signing, found; certification levels enforced; a revoked certificate caught from its OCSP answer; timestamps from a stand-in authority and — run once on 2026-09-19, over the network, by an ignored test (`cargo test --lib real_timestamp -- --ignored` in `apps/desktop/src-tauri`) — from DigiCert and Sectigo, both verified and trusted through Mozilla's roots (as timestamp authorities; see "Trust"), and their responders' OCSP answers written to `/DSS` and checked. Through the interface (`e2e/signatures.spec.ts`): sign with a TEST certificate, PDFium itself lists the signature, save keeps the signed bytes exactly (saving twice gives the same file), a comment afterwards is appended and listed as permitted, reopening checks it, trusting the TEST root makes it valid, and one changed byte makes it invalid — and the card then says the signed content has changed, in words, not only with a mark; the signature lands in the file within five points of where it was drawn on the preview; an unsigned form's empty signature field is offered and signed into visibly; the banner offers the list again once the inspector is closed; Page marks is warned of before it changes a signed file.
* **Hostile files and certificates the verifier rejects** (`warraq-sign/src/attacks.rs`, after an adversarial review and the published attacks — Mladenov et al., "1 Trillion Dollar Refund", CCS 2019; Mainka et al., "Shadow Attacks", NDSS 2021, and "Breaking the Specification: PDF Certification", S&P 2021): a web-server (serverAuth) certificate is not a trusted document signer, under a web-site root or a root the person trusts; a certificate "issued" by a certificate that is no CA, a CA beyond its issuer's path length, and a key that may only encrypt make a signature invalid; a signer under a web-site root shows as "identity not verified", and as valid once the person trusts that root; the signer shown is the certificate's name, `/Name` only as its own claim; a signature dictionary added later that borrows a genuine one's byte range — in a field of its own or with the genuine field pointed at it — is invalid; a catalog hidden in the file before signing and swapped in by the trailer after, an annotation hidden before and linked in after, a signature field drawn over a "no changes" certification, a text field added over a "forms only" one, and a signature's own appearance redrawn are all changes that are not permitted, while a document timestamp after a "no changes" certification and filling in an existing field under "forms only" still are; a timestamp from an authority nobody trusts is not relied on; an expired certificate without a trusted time is "not proven", and valid with a trusted timestamp from when it was valid; SHA-1 is not trusted; field locks keep their Include/Exclude action and match fully qualified names; a timestamp token altered on the way is refused when signing (`tsp.rs`). `warraq-pdf`: validation data that inflates without end is skipped, a file that refers to one large object 200 000 times is walked once, and saving a signed Arabic form leaves the appearances another program drew as they were (`tool_signatures.rs`).
* **Smart cards are untested with a card.** The PKCS#11 path (`apps/desktop/src-tauri/src/signing.rs`, the `cryptoki` crate) compiles and its encodings are tested, and the same `Signer` trait signed and verified with a software key standing in for the card — but no card, token or SoftHSM was available on this machine, and installing system software was out of bounds. The panel says so beside the card option. Certificates are listed without the PIN (it is tried only when a single token shows none without it), so a card with a PIN per slot is not locked by the listing; a key that asks for its PIN again for every signature (`CKA_ALWAYS_AUTHENTICATE`: a PIV card's signing key, many national eID qualified keys) is refused with a message saying exactly that — the PKCS#11 binding does not expose the context-specific login a one-part signature would need. Until someone signs with a real card, treat it as unproven.
* **The browser build cannot timestamp or fetch revocation data.** Checked on 2026-09-18: eleven public timestamp authorities answer a server, and not one sends the CORS headers a page needs to read the answer — no Content-Security-Policy change can fix that — so the web and extension builds say so in the panel and offer neither; the desktop app does both, from Rust. For the same reason the web CSP was not widened: allowing origins whose answers cannot be read would be a control that does nothing. Signing and checking work in every host.
* **Trust: a signer is valid only when a certificate the person trusts vouches for them.** Mozilla's root store (`webpki-roots`) is the list browsers trust *for web sites*: its authorities check that someone controls a domain, and anyone can get a certificate under them for free — so it is not a list of document-signing authorities, and a signer whose certificate chains there shows as "intact — the signer's identity is not verified", naming the root and offering to trust the issuing certificate for documents. The anchors of document trust are the certificates the person trusts on this device (their organisation's or country's authority, or a signer's own certificate). The signer's certificate must also be for signing documents: key usage digitalSignature or nonRepudiation, and — when it has an extended key usage — anyExtendedKeyUsage, emailProtection, id-kp-documentSigning (RFC 9336), Adobe's Authentic Documents or Microsoft's Document Signing, and so must every CA above it that restricts its purposes (a web-server certificate is "not for signing documents" even under a trusted root); only a certificate the person trusted itself is exempt from that purpose check. Each issuer must be a CA within its path length, or the path is broken and the signature invalid. **A timestamp authority** may be trusted through Mozilla's roots, when its certificate and every CA above it that restricts purposes are for timestamping: it vouches for a time, not for a person. There is no Adobe AATL (Adobe's to distribute) and no EU trusted list reader, so most commercial and qualified signers show as "identity not verified" until their authority is trusted; certificate policies, name constraints and qualified-signature status are not checked.
* **Time: a certificate is judged at a trusted time, else now.** A timestamp's time is relied on only when an authority trusted for timestamping signed it (any key can make a token, and a token sits outside what the signer signed); otherwise the card says whose it is and that its time is not relied on. Without a trusted time the certificates are judged as of now (ETSI EN 319 102-1): one that has expired since shows "not proven", not valid — the time the signer's computer claimed proves nothing. A later document timestamp is not yet used as proof of time for the signatures before it. SHA-1 (as the signature's digest, `adbe.pkcs7.sha1`, or a certificate's) is untrusted unless a trusted timestamp puts the signature before 2017.
* **Revocation is read, not fetched, when checking.** The check uses what is in the file (`/DSS`, or archived in the signature); it does not go online to ask. "No revocation data in the file" is shown as such, not as a failure. The first OCSP answer or revocation list that checks out is used; how fresh it is against the signing time is not judged.
* **Changes after signing are classified by object**, not by rendering. The trailer is compared (another catalog is a document change); an object that nothing in the signed revision reached counts as new when something reaches it now, whatever its bytes (the "shadow" attacks); a widget or field added, removed, moved, shown, retyped or given actions is "form fields added or changed", which no certification level permits, while a new value or appearance for an existing field is filling it in; an existing signature's field, dictionary or appearance changed is "an existing signature was altered"; a new signature counts as signing only with a new signature dictionary of its own, and under "no changes" only an invisible document timestamp (and validation data) is permitted. Each signature dictionary must be the one its signed revision holds, unchanged, with its own `/Contents` where its byte range leaves the hole. Comments added — including one over the page — are permitted after an approval signature and at level 3, as ISO 32000 says; approval signatures also permit fields added (listed). Numbers are compared to a hundredth of a point, so a rewritten widget does not look moved. A viewer that forbids some of what this permits (or the reverse) is possible in unusual files. Verifying bounds its work: validation data is read to 16 MB an item and 64 MB in all, stream comparisons to 256 MB per signature, and at most 30 signatures are checked (the rest show as "not checked").
* **Saving a signed file keeps what others drew.** Warraq redraws Arabic form values and text-box comments PDFium cannot draw; in a signed file it redraws only what changed since the file was opened, so a third party's Arabic appearances stay as the signer saw them (`tool_signatures.rs`). A file opened unsigned has every Arabic appearance drawn, as before.
* **RSA signing uses the `rsa` 0.9 crate**, which carries the RUSTSEC-2023-0071 (Marvin) timing advisory; Warraq signs with blinding, locally, where no one can time it from outside, and never decrypts with RSA.
* **A signed file over 150 MB is still saved as an update**, past the limit `file.rebase` keeps for other files (it holds both copies in memory); if even that fails, the save is refused with a message saying why, rather than written whole over its signatures. Not measured on a file that large: whether the update fits in memory depends on the file. Below 150 MB the signed bytes are kept exactly (e2e).
* **Page marks and pictures: what is not done.** A picture is shown but not offered for editing when the bytes that draw it draw it somewhere else too — a form XObject used twice on the page or drawn by another page, or a content stream two pages share — since changing it would change every place; the pages whose resources could reach such a form are walked to see whether they draw it, and a file too heavy to settle within that walk's budget (256 MB of content, 16 million operations) has the picture treated as shared. A picture inside a form cannot be moved or grown out of the form's box, where it would not show. Deleting or replacing a picture takes it out of the page's (or the form's) resources too; a picture that came with the file stays in the file's earlier revision until a clean copy is written (Remove hidden information, Compress), like every incremental change. A photo with an EXIF orientation (a phone's portrait, say) is placed and replaced upright, and drawn upright as a picture watermark, as Create PDF places it: the JPEG is stored byte for byte and the turn is written into where it is drawn, since no PDF viewer reads the tag. A PNG's own orientation tag is not read. Changing a picture watermark needs the picture chosen again (the file keeps the picture, not its source). Text edits made after a mark in Edit text join the page's content streams into one (lopdf's `change_page_content`); the marks still come off, but the page is then no longer byte-identical to the original — the edit changed it anyway. Marks drawn by other programs (Acrobat's own headers, say) are not listed: only Warraq's carry the private data that says what they are.
* **Content streams are read within bounds** (they come from hostile files): 64 MB decoded a stream, two million operations and operands kept from one, and a page's picture walk of 64 MB and four million operations visited, forms drawn again counted each time. A page past them has its pictures refused ("the page draws too much"), and a mark on it refused, rather than a hang. A form drawn inside itself is drawn once, as PDFium does.
* **Undo in Edit keeps a copy of the file for each picture, link or added-text change** (at most the last ten; older history goes with the oldest of them). Undo puts the file back byte for byte, in turn with text edits; switching back to the viewer starts the history again, as before.
* **Only Warraq's own marks leave Warraq's reading of a page.** Edit text, Export, Compare and AI read a page without Warraq's page marks (`/Artifact` carrying `/WarraqMark`) — a diagonal DRAFT would split every line it crosses. Other programs' artifacts — Word's and LibreOffice's running heads, footers and page numbers — are the page's text like the rest. Search and Find and redact read everything, Warraq's marks included, so nothing in a header, footer or watermark escapes a redaction. Where the page's marked content cannot be paired with what the renderer met (optional content, say), a page that carries Warraq's marks has all its artifacts kept out of Edit's reading, and search and redaction still read them. EmbedPDF's own search and selection (PDFium) include everything.
* **Search and copy in the page view — what is still PDFium's.** The selection itself is: what a drag highlights follows PDFium's order of characters, which on some Chrome-made Arabic files jumps about the line, and Copy then gives Warraq's reading of exactly the highlighted glyphs — in logical order, but only those. A selection with no Arabic script copies PDFium's text, which reads Latin well. The search reads the file as Warraq opened it; after a redaction is applied in the view it reads the view's copy instead, so removed text is not found. A word Warraq's reader gets wrong is not found either (it was the Amiri kaf–taa–alef ligature, now fixed; ten corpus files still have unreadable glyphs, below).
* **In EmbedPDF's view a click on a link selects it**, as its annotation tools are unlocked; its *Go to Link* then follows it — an address only after Warraq's question, a page of the file at once. On desktop the confirmed address goes to the system's opener through a new host command (`open_url`); that is covered by the web e2e with the browser's own `window.open`, not yet clicked in the installed window. An address with controls or invisible format characters (bidi embeddings, overrides and isolates, zero-width characters, the byte-order mark) is neither written nor opened, by the interface or the core alike, and the question shows it escaped; otherwise it shows an address in letters (an Arabic path as typed, not percent-encoded) and the site it really opens, in ASCII. A link written straight into a page's `/Annots` (against the spec) is changed and removed where it is.
* **Remove hidden information does not find everything that could hide text**: it finds text drawn invisibly (as an OCR layer is), white on white, or off the page, on the pages themselves; text under an image, text cut away by a clipping path, and hidden text inside reused drawings (form XObjects) are not detected. White text counts as hidden only where nothing but white was painted under it, judged by boxes: white text beside a dark shape but inside its box is taken as seen and left in place. Hidden layers are decided as PDFium decides them (a layer's own view state, then the configuration; membership dictionaries by their policy or expression); a hidden layer that shown content depends on, or whose content cannot be read, stays in the file, switched off, rather than be removed and let what it hid show. A protected file is refused rather than written without its password: take the password off first. A signed file can be cleaned, and its signature stops being valid (the report says so).
* **Removing an attachment is an update**, like every change Warraq appends: the file's earlier revision still holds the attachment until the file is written whole — Remove hidden information does that, and the pane says so.
* **Showing or hiding a layer reopens the view** on a copy of the file: EmbedPDF's own undo history starts again (the changes themselves are kept), and it comes back to the page that was on screen. Layers are switched in the reading view only; in Edit text the Layers tab lists them. A layer's print and export states are shown, not edited.
* **EmbedPDF's own sidebar keeps its outline** beside Warraq's navigation pane: two lists of the same bookmarks in the reading view.
* **Deleted pages stay in the file's earlier revision**, like every incremental change, until a clean copy is written; extracting pages writes one. Bookmarks and links that pointed at a deleted page are left pointing nowhere in the open file.
* **What stays in Latin script inside EmbedPDF in Arabic**: the names of the standard fonts in its font picker (Helvetica, Courier, Times — names, not words), the names it gives new form fields (`Combobox_fcacab1a`: the file's own data, which the person can rename), and a colour swatch's code (`#FF8D00`). Its strings written in code are patched at build time (`vite/embedPatches.ts`, not `pnpm patch`: the bundle is three minified lines, and a patch of it would be two copies of a 1.1 MB line); a new EmbedPDF version fails the build until every patch matches again. The e2e walks the states listed in fix 28; a state it does not open could still hold an English string.
* **Print — what was and was not run.** On desktop, EmbedPDF's own Print button is hidden; File → Print (Cmd+P) prints the file as it stands. macOS prints through PDFKit and the system print sheet — tested by printing the corpus into a PDF through the same operation, not yet with a person at a printer. **Windows and Linux print by pages** (`print/printPages.ts`, the host's `print_webview`): the pages are pictures at 300 dpi, not vectors — sharp on paper, but a long file is a large print job and is drawn first (a banner counts the pages, with a stop button). That path was run in Chrome, printed to a PDF by the e2e (three pages, each the page's own size, one 300 dpi picture, nothing else of the app), and on macOS its host command compiles and its mode is unit-tested (`WARRAQ_PRINT=pages` takes it there). It has **not** been run on Windows or Linux: neither system is here, and the desktop crate cannot be compiled for them on this Mac — `ring` needs the Windows SDK's C headers and `tauri-winres` an `llvm-rc`, and Linux needs GTK and WebKitGTK's development files. What did check for Windows (`cargo check --keep-going --target x86_64-pc-windows-msvc`): Tauri, wry, its WebView2 bindings and Warraq's core. Printing a PDF with its vectors on Windows through WebView2's own PDF viewer (as a browser does) may well work, but it could not be tried, so it is not what ships. A file that forbids printing is refused on every path, as Acrobat refuses it. EmbedPDF's file buttons (screenshot, insert image, attachment, signature upload) go through the native panels; that is tested against a stand-in for the host, not yet clicked in the installed window.
* **The installable web app — what is limited.** Tesseract and its language models (about 20 MB) are kept the first time Scan & OCR fetches them, not at install: OCR works offline only after it has been used once online. A new version installs beside the old one and takes over once no window still runs the old one. The OS does not yet offer محرر PDF to open a PDF from outside the app (no file handler is declared: it would be a promise the app has not been tested to keep). The installed app is tested in desktop Chrome at phone size with touch emulated, not on a phone; Safari on iOS, which installs web apps its own way and may clear their storage, has not been tried.
* **Another app that redraws a field can undo the Arabic.** Warraq writes each Arabic field and text box's appearance itself; a program that regenerates appearances when you edit the field there (Chrome's viewer, some others) may draw it again with a font that has no Arabic.
* **Finder does not offer Warraq for a PDF.** The bundle claims no document types on purpose — an editor should not take over the system PDF handler unasked. Open from inside the app, or pass the path on the command line.
* **The macOS build is ad hoc signed, not notarised.** It runs on the machine that built it. Copied to any other Mac it will be refused until that user clears the quarantine flag by hand, because notarising needs a paid Apple Developer account. Nothing in the build is broken by this; it is a distribution decision, not a defect.
* **Nobody has looked at the installed window.** The Claude desktop app has no Screen Recording permission on this Mac, so no screenshot is possible. What is verified, from the host's own log (`WARRAQ_DEBUG=1 warraq-desktop file.pdf`), is the whole chain behind the glass: the interface boots, claims the file named on the command line, reads it through the file scope and opens it in the core, and EmbedPDF — which reports back through the `ui_log` command — starts, opens the file and draws its pages inside the macOS webview (the Arabic Word export: 4 tiles in 502 ms on 2026-09-18). What that does not prove is what the pixels look like, or that the open and save panels behave once a person clicks them.
* **The macOS title bar and menu bar have not been seen either.** For the same reason, no one has looked at
  whether the traffic lights sit centred in the toolbar at `trafficLightPosition {20, 19}` (worked out from
  how tao places them, and pinned by `desktop_contract.rs`), how the system menu bar looks in Arabic, or
  whether a double click on the toolbar zooms the window. The configuration and the menu wiring are tested;
  the pixels are not. The browser and extension look is verified by screenshots
  (`docs/design/screenshots/`).
* **Undo in the macOS menu bar is the app's own item, not the system's role.** A system Undo reaches only the
  webview's text fields, never the document's history. The app's item undoes the document, or the typing
  when a text field has the focus. Cut, Copy, Paste and Select All are the system's.
* **OCR reads diacritics poorly and skips some table rows**; crooked scans are straightened and damaged ones can be cleaned up first, but a stain's ring as dark and thin as a stroke still costs the words it crosses; Nastaliq Urdu cannot be recognised usefully on the device at all. Recognition in the desktop app was checked from the host's log (above), not watched on screen.

  when a text field has the focus — enabled by what the browser says that field's history can undo
  (`queryCommandEnabled`), and carried out with `execCommand`. Cut, Copy, Paste and Select All are the
  system's. **What is proven and what is not**: the whole menu path is exercised in Chrome against a
  stand-in for the host that receives the very menu the page sends and delivers items chosen in it
  (`e2e/native-menu.spec.ts`); the system's own menu bar in the installed app has still not been clicked by
  anyone (no screen access here), and WebKit's editing history is assumed to answer as Chrome's does.
* **The recent grid's picture is dropped when a file is saved, not retaken.** The saved file may no longer
  look like it — a page deleted, a password set, a redaction applied — and which file a name means after a
  save (the panel can write anywhere) is not knowable from the name alone, so the tile shows a plain page
  until that file is opened again. Nothing about a redacted or protected page is kept.
* **No page is drawn with more than 64 million pixels.** Past that the core refuses the render rather than
  allocating gigabytes for a page size read from the file. An A4 page at the largest scale the core draws
  at (8×) is half of it, and print, export and OCR ask for less; a very large page at a very high zoom is
  drawn a little softer instead.
* **The phone's sheet drag has been tested in a browser, not on a phone.** The gesture is driven by pointer
  events at 390 points wide with touch emulated (`e2e/phone.spec.ts`), and its physics — momentum
  projection, rubber-banding, the spring — are unit-tested; no one has yet dragged it with a finger.
* **OCR reads diacritics poorly and skips some table rows**; crooked scans are straightened first, but there is no cleanup of stains or shadows; Nastaliq Urdu cannot be recognised usefully on the device at all. Recognition in the desktop app has not been watched yet (it runs in the same webview that draws the pages).
* **Nastaliq Urdu** now reads exactly where the file maps its glyphs: the corpus's Chrome-made Nastaliq page went from recall 0.61 / order 0.56 to 1.0 / 1.0 (`tests/acid`, baseline raised), with no other truth-scored file changing a byte. Nastaliq lifts each word's letters up to an em above the line, which split every line into fragments; a joining letter touching its neighbour is now read on that letter's baseline. Not done: a Nastaliq file with no ToUnicode map — Noto Nastaliq draws ب ت ث ن ی پ ٹ from one skeleton plus separate dots, which the glyph-to-letter fallback cannot express (65 of 170 glyphs right), and producers that subset the font drop the table it reads. Two leftovers in real-world files: a false space in "مع ظم" (Wikibooks) and diacritics out of order in "وَأَناَ اشْترََيْتهُاَ" (a LibreOffice page).
* **Ten corpus files** come back with U+FFFD placeholders where a glyph has no usable ToUnicode, cmap or GSUB evidence. Placeholders are deliberate: words are never silently merged.
* **SASLprep** is not applied to R5/R6 passwords; ASCII passwords are exact.
* **Line breaking** is greedy at spaces; full UAX #14 (ICU) is a later refinement.
* **Acrobat verification** has not happened — Acrobat is not installed here. Verification used PDFium, PDF.js, MuPDF and qpdf.
* A visual glyph order can have two valid logical readings; the reconstruction picks the right-to-left human reading and content-stream order is the planned tie-breaker.

## Brief items that are impossible or inadvisable as stated
1. `rustybuzz` (§5) is archived upstream; HarfRust is the maintained successor (ADR-0004).
2. Office conversions needing LibreOffice cannot exist in the browser extension; desktop sidecar or opt-in server only.
3. "Sandboxed parsing even on desktop" (§4) is planned as a separate render process, not WASM-on-desktop: native PDFium is 4–6× faster on large scans.
4. Perfect round-trip editing of every PDF is impossible (§15.5) — we substitute a bundled font and report it rather than corrupting the file, and the original bytes always survive in the saved file.
