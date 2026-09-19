# STATUS — Warraq

*Updated 2026-09-18: the interface is rebuilt on EmbedPDF (ADR-0007); eleven of the thirteen tools work end to end, each proven by a test that clicks through it, saves the file and reopens it.*

## Where the product stands

| Capability | State |
|---|---|
| Open, render, thumbnails, zoom, search | EmbedPDF — PDFium compiled to WebAssembly (MIT) — on web, desktop and extension; Warraq's own engine (native PDFium on desktop, pure Rust in browsers) takes over in Edit text |
| Comment, fill & sign, prepare form, redact, protect | work end to end through EmbedPDF's plugins, in all three hosts; see the count below |
| Find and redact, remove hidden information | Warraq's core finds words (Arabic-aware, as Find) and ready-made patterns — emails, phones, national ID/Iqama, IBANs, card numbers, dates — or a person's own pattern, with the boxes of their glyphs, which become EmbedPDF's redaction marks; and it reports and removes what a file carries besides its pages, writing the file whole |
| Bookmarks, attachments, layers | one navigation pane in both views (View menu): bookmarks go to their page; attachments are listed, saved, added and removed; layers are shown and hidden in the view without touching the file until the visibility is saved with it |
| Organize pages | rotate, reorder (drag or buttons), delete, insert a blank page or another PDF's pages, extract pages to a new file, split into files, crop by margins or trim the white away, undo and redo — Warraq's core, as incremental updates (ADR-0008) |
| Combine files | several PDFs into one new file, in the order listed, form fields and all; protected files with their password — Warraq's core (ADR-0008) |
| Scan & OCR | Tesseract (Apache-2.0) reads scanned pages on the device — Arabic, English, Persian, Urdu (Naskh) — and Warraq's core writes what it read as an invisible, shaped text layer, so the page can be searched, selected and copied while it looks as it did. Measured on the corpus: 130 of 138 Arabic words of a 300 dpi scan (the misses carry diacritics), 20 of 30 of a 200 dpi black-and-white invoice (Tesseract skips its table rows) |
| Compress | a smaller copy, written from scratch: unused objects dropped, duplicate streams shared, everything recompressed, and — only if chosen — images larger than a page needs downsampled to 150 or 96 dpi. Refuses protected and signed files rather than silently stripping their protection or breaking the signature |
| Protected files | open everywhere after a password prompt; one prompt unlocks the file for both engines |
| Arabic text **reading** in logical order | 16 of the truth-scored corpus files, against 2 for PDF.js, 2 for MuPDF, 0 for PDFium |
| Arabic text **editing** with reflow | works end to end: click a paragraph in the app, edit it, undo/redo, save. GATE 2 passed (`docs/gate-2.md`) |
| Encrypted files | read everywhere: R2–R6, RC4 40/128, AES-128, AES-256 |
| Saving | incremental update; the opened bytes stay as the literal prefix — for EmbedPDF's changes too (below), except after a redaction or a change of password, which are written whole |
| Hostile input | mutation harness on every pull request; cargo-fuzz targets ready for nightly |
| Visual regressions | golden renders of all 48 corpus pages gated in CI |
| No-mapping files | characters recovered from glyph shapes, at 100 % precision on held-out fonts |
| Installed on this Mac | `/Applications/ورّاق.app`, built from this tree — `scripts/install-macos.sh`, documented in `docs/install-macos.md`. Opens a PDF, renders every page, both thumbnails and full size |

Every one of the 48 corpus files opens. 63 tests green, clippy clean, `wasm32-unknown-unknown` compiles, core WASM 2.50 MB gzipped (budget 8 MB).

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
| Tools in the pane | 13 |
| Tools that work | **13** — Edit, Organize pages, Combine, Compress, Scan & OCR, Export, Compare, AI, Comment, Fill & sign, Prepare form, Redact, Protect |
| Tools marked *Later* on their face | 0 |
| Edit (Warraq's engine) | replace the text of a paragraph, reflowed and reshaped; add a line of new text where you click; choose the face (Amiri, Cairo, Inter) and size; undo and redo a replacement |
| Organize pages (Warraq's engine) | a grid of every page: select (click, Shift, Cmd/Ctrl), drag to reorder or move earlier/later, rotate either way, delete (never the last page), insert a blank page, insert every page of another PDF after the selection (its password asked for if it has one), extract the selection as a new file, split into files — every so many pages or at each selected page, saved as one zip; crop by margins in millimetres as the page is shown, or trim the white margins away; undo and redo; keyboard throughout, mirrored in Arabic |
| Compare (Warraq's engine) | what changed in the text between two versions — the file's own earlier revisions, or another PDF — word by word, with Arabic matching that follows the search (letter variants and diacritics optional); go to a change's page; and how each page looks, drawn and compared, with what looks different outlined — a drawing, a stamp or a picture the text cannot show; save the comparison, pictures included, as a report |
| AI (bring your own key, or local) | summarize, ask about, or translate the document with Claude on the person's own Anthropic key, or a model on this computer (Ollama or LM Studio). Nothing is sent before Send, and the screen first shows exactly what will go and where; the answer is shown as it streams in ("thinking" while the model thinks first), Stop keeps what arrived, and answers cite their pages. Refuses while redactions are marked but not applied |
| Combine (Warraq's engine) | add files (the open one comes first), reorder or remove them, unlock protected ones; the result opens in place, to save where you choose. The files chosen are not changed |
| Export (Warraq's engine) | Word (.docx, text only: paragraphs, direction and alignment, not layout), plain text, Markdown, a self-contained web page, and page images (PNG, zipped). Built from Warraq's own reading of the file as it stands now — a redaction applied in the viewer never reaches an export; unapplied marks are warned about |
| Scan & OCR (Tesseract + Warraq's engine) | choose the languages on the page and whether to read only pages without text; progress page by page, and a stop button; the result reports words read and Tesseract's confidence. Nothing is sent anywhere; the models are bundled |
| Compress (Warraq's engine) | three levels — without losing anything, smaller images (150 dpi), smallest (96 dpi) — then save the smaller copy beside the open file or open it in its place; says when a file is already as small as it gets |
| Comment (EmbedPDF) | highlight, underline, strike out, sticky note, text box, freehand drawing, rectangle, arrow, link |
| Fill & sign (EmbedPDF) | type into a form's fields, draw or type a signature and place it, place a stamp |
| Prepare form (EmbedPDF) | add text fields, checkboxes, radio buttons, drop-downs and list boxes as real AcroForm fields |
| Redact (EmbedPDF + Warraq's engine) | mark text or an area, then apply: the text and images underneath are removed from the file, not covered. Find and redact: words found the Arabic-aware way, or emails, phone numbers (Saudi and international, Latin or Arabic-Indic digits), national ID and Iqama numbers, IBANs, card numbers, dates, or a pattern of one's own — each listed with its page and context, the chosen ones marked over their exact glyphs. Remove hidden information: metadata, scripts and actions, attachments, comments, form data, hidden layers, bookmarks, thumbnails, applications' private data, links, hidden text — reported, chosen, and removed by writing the file anew, its earlier revisions and unused objects gone with them |
| Navigation pane (Warraq's engine) | in both views, from the View menu: bookmarks with their levels (a click goes to the page), attachments (saved, never opened; added with a description; removed), layers in their order with locked ones and print/export states shown, switched in the view only until *Save layer visibility with the file*; in Edit text also the page thumbnails |
| Protect (EmbedPDF) | require a password to open, restrict permissions |

Each working tool has a test in `apps/web/e2e` that uses it the way a person
does — clicks the card, the control, the page — then saves the file, reopens
it and checks the change is in the file, not just on the screen. A test
keeps the count of *Later* cards at zero; a tool not built would have to say
so on its face.

## How it looks (design refresh, 2026-09-18)

The shell now follows the system's document apps (Preview, Pages) instead of an office suite. The design
system is written down in `docs/design/README.md`, with screenshots in `docs/design/screenshots/`. It has one
set of design tokens modelled on macOS's semantic colours, used in light and dark, with increased contrast,
reduced transparency and reduced motion honoured.

| | |
| --- | --- |
| Toolbar | One unified toolbar in place of the ribbon and the status bar. It carries the document's title, with "Page n of m — Edited" under it; pages; zoom (which now drives EmbedPDF's zoom too); the markup toolbar; Edit text; a tool picker that opens a gallery of the 13 tools; find; save; and the inspector |
| Inspector | The tools pane, restyled: grouped inset sections, action lists, and macOS checkboxes, radios, pop-up buttons, segmented controls, steppers and switches. Every panel, including ones added later, gets the look from shared classes |
| Home | A document chooser. Recent files are shown as pages with a small picture of each first page, stored on the device and never for a password-protected file. The inert "Open from OneDrive / Google Drive" buttons are gone: they did nothing, and the connectors are not built (feature matrix: Cloud ⬜) |
| Dialogs and overlays | Dialogs are sheets. Popovers come out of their trigger. Toasts are a HUD. The find bar sits under the toolbar. The drop overlay is a material with one or two targets. Settings (⌘,) holds language and appearance |
| EmbedPDF | Themed with Warraq's tokens by reference. Its duplicated sidebar, zoom and search buttons and its floating page field (except on a phone) are gone. The rest of its bar is the markup toolbar, shown from Warraq's toolbar |
| macOS app | The title bar is merged into the toolbar, with the traffic lights in it. The toolbar drags the window and a double click zooms it. The system menu bar is built from the page's own menu model, in the interface language, and enables and checks items as the page does. A shortcut the page handles never runs its menu item too |
| Narrow windows | On a tablet the toolbar condenses. On a phone the inspector is a sheet, the sidebar floats over the page, and nothing scrolls sideways |
| App icon | New original artwork (`scripts/icon/make_icon.py`): a calligraphic و on a sheet of paper. Desktop and extension icons are regenerated from it |

## Next (in order)
1. **Print on Windows and Linux** desktop builds (macOS prints through PDFKit).
2. Nastaliq Urdu extraction; Acrobat verification on a machine that has it.

## Decisions needed from you
1. **GitHub organization** — nothing has been pushed: `gh repo create <org>/warraq --private --source . --push`.
2. **Xcode license** — `/usr/bin/cc` and the system `python3` refuse to run until `sudo xcodebuild -license accept` (needs your password). Builds work because they are pointed at Xcode's clang directly.

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
   at a time); files over 150 MB are saved whole, since the core would hold
   both copies at once.

## Known gaps, stated plainly
* **Remove hidden information does not find everything that could hide text**: it finds text drawn invisibly (as an OCR layer is), in white, or off the page, on the pages themselves; text under an image, text cut away by a clipping path, and hidden text inside reused drawings (form XObjects) are not detected. A protected file is refused rather than written without its password: take the password off first. A signed file can be cleaned, and its signature stops being valid (the report says so).
* **Removing an attachment is an update**, like every change Warraq appends: the file's earlier revision still holds the attachment until the file is written whole — Remove hidden information does that, and the pane says so.
* **Showing or hiding a layer reopens the view** on a copy of the file: EmbedPDF's own undo history starts again (the changes themselves are kept), and it comes back to the page that was on screen. Layers are switched in the reading view only; in Edit text the Layers tab lists them. A layer's print and export states are shown, not edited.
* **EmbedPDF's own sidebar keeps its outline** beside Warraq's navigation pane: two lists of the same bookmarks in the reading view.
* **Deleted pages stay in the file's earlier revision**, like every incremental change, until a clean copy is written; extracting pages writes one. Bookmarks and links that pointed at a deleted page are left pointing nowhere in the open file.
* **A few of EmbedPDF's strings are English in any language**: they are written into its code, not its translations — its loading screens, some text-style tooltips, and default options it writes into new list fields ("Option 1–3").
* **On desktop, EmbedPDF's own Print button is hidden**; File → Print (Cmd+P) prints the file as it stands through PDFKit and the system print sheet on macOS — tested by printing the corpus into a PDF through the same operation, not yet with a person at a printer. Windows and Linux builds do not offer Print yet. EmbedPDF's file buttons (screenshot, insert image, attachment, signature upload) go through the native panels; that is tested against a stand-in for the host, not yet clicked in the installed window.
* **Another app that redraws a field can undo the Arabic.** Warraq writes each Arabic field and text box's appearance itself; a program that regenerates appearances when you edit the field there (Chrome's viewer, some others) may draw it again with a font that has no Arabic.
* **Dragging a file over the desktop window gives no highlight.** The host catches the OS drag before the webview sees it, and only the drop is forwarded, not the hover. The drop itself works; the invitation to drop does not appear.
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
* **OCR reads diacritics poorly and skips some table rows**; crooked scans are straightened first, but there is no cleanup of stains or shadows; Nastaliq Urdu cannot be recognised usefully on the device at all. Recognition in the desktop app has not been watched yet (it runs in the same webview that draws the pages).
* **Nastaliq Urdu** extraction is still garbage: cascading Nastaliq ligatures do not reverse-map from glyphs the way Naskh does. Needs shape matching or OCR.
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
