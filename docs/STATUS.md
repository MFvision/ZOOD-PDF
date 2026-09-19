# STATUS — Warraq

*Updated 2026-09-19: the interface is rebuilt on EmbedPDF (ADR-0007); all fifteen tools work end to end, each proven by a test that clicks through it, saves the file and reopens it — Digital signature (PAdES sign, verify, timestamps, validation data) the latest.*

## Where the product stands

| Capability | State |
|---|---|
| Open, render, thumbnails, zoom, search | EmbedPDF — PDFium compiled to WebAssembly (MIT) — on web, desktop and extension; Warraq's own engine (native PDFium on desktop, pure Rust in browsers) takes over in Edit text |
| Comment, fill & sign, prepare form, redact, protect | work end to end through EmbedPDF's plugins, in all three hosts; see the count below |
| Prepare form | Warraq's core finds where a flat form expects writing — underscore and dot runs, empty table cells, drawn boxes, lines to sign on, check boxes — names each field from its Arabic or English label and types it (text, check box, date, Hijri date, signature); the proposals are drawn on the page to adjust, then created as real AcroForm fields. Formats (numbers with SAR and Arabic-Indic digits, percent, dates, Umm al-Qura Hijri dates), ranges and calculations (sum, product, average, min, max, or arithmetic typed over field names) are written as the built-in JavaScript every form reader runs, and run inside Warraq by its own interpreter of exactly that subset — no JavaScript engine, no eval. Measured below |
| Page marks | watermarks (text or a picture), headers and footers with page, date (Gregorian or Hijri) and file tokens, page numbers and Bates numbers, drawn by Warraq's core with Arabic shaped, previewed on the page before they are applied, and listed to change or take off — the page's own content is never touched (form XObjects tagged as artifacts, round the page's streams) |
| Edit PDF: pictures and links | pictures picked, moved, resized, turned, cropped, replaced, deleted or placed from a PNG/JPEG; links drawn, pointed at an address or a page, moved, resized and removed — from the pointer or the keyboard; each change rewrites only the one operation or annotation it touches, as an incremental update, and each can be undone in turn with text edits |
| Find and redact, remove hidden information | Warraq's core finds words (Arabic-aware, as Find) and ready-made patterns — emails, phones, national ID/Iqama, IBANs, card numbers, dates — or a person's own pattern, anywhere on the page — running heads, footers and page marks included — with the boxes of their glyphs, which become EmbedPDF's redaction marks; and it reports and removes what a file carries besides its pages, writing the file whole |
| Bookmarks, attachments, layers | one navigation pane in both views (View menu): bookmarks go to their page; attachments are listed, saved, added and removed; layers are shown and hidden in the view without touching the file until the visibility is saved with it |
| Organize pages | rotate, reorder (drag or buttons), delete, insert a blank page or another PDF's pages, extract pages to a new file, split into files, crop by margins or trim the white away, undo and redo — Warraq's core, as incremental updates (ADR-0008) |
| Digital signatures | PAdES signatures made and checked by Warraq's own core (pure Rust, `warraq-sign`) in every host: sign with a certificate file (.p12/.pfx, modern or legacy) — visibly, where the person drags on the page, Arabic shaped — or on the desktop with a smart card; certify or approve, lock the form; every signature in a file checked when it opens (integrity, signer, chain, trust, time, revocation data, and what changed after it). Trusted timestamps and long-term validation data are fetched by the desktop app only, on a click; the browser cannot read those servers' answers |
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
| Tools in the pane | 15 |
| Tools that work | **15** — Edit, Page marks, Organize pages, Combine, Compress, Scan & OCR, Export, Compare, AI, Digital signature, Comment, Fill & sign, Prepare form, Redact, Protect |
| Tools marked *Later* on their face | 0 |
| Edit (Warraq's engine) | three kinds, switched at the top of the panel. **Text**: replace the text of a paragraph, reflowed and reshaped; add a line of new text where you click; choose the face (Amiri, Cairo, Inter) and size; undo and redo, in order, every change made in Edit — a replacement, an added line, a picture or a link. **Pictures**: every picture on the page as a box to pick — inline ones and ones inside forms too; drag to move, handles to resize (Shift keeps proportions), turn 90°, crop with the handles, replace with another PNG or JPEG (fitted inside what showed), delete, arrow keys to nudge the picked picture; add a picture from a file or a drop by dragging out where it goes. **Links**: drag to draw one, or add one in the middle of the page from the panel; point it at a web or e-mail address or a page of the file; move and resize it by dragging or with the arrow keys (Alt resizes); remove it; follow it from the panel — an address only after the same question as everywhere |
| Page marks (Warraq's engine) | four kinds: watermark (text or picture; size, colour, opacity, rotation, centre, a corner, an edge or tiled; in front of or behind the page), header and footer (three slots — start, centre, end, the start on the right in Arabic, detected from the text or chosen — with page number, page count, date and file name tokens; the date Gregorian or Hijri, in Western or Arabic-Indic digits), page numbers (`1`, `1 / 9`, `Page 1 of 9`, `صفحة 1 من 9`, roman — shown in the digits chosen, Western or Arabic-Indic; start number; no number on the first page) and Bates numbers (prefix, start, padded digits, suffix); any range of pages; the page on screen previewed with the mark as the core will draw it; the marks already in the file listed, each changed in place or taken off, or all at once. A new mark replaces one of the same kind on the same pages |
| Organize pages (Warraq's engine) | a grid of every page: select (click, Shift, Cmd/Ctrl), drag to reorder or move earlier/later, rotate either way, delete (never the last page), insert a blank page, insert every page of another PDF after the selection (its password asked for if it has one), extract the selection as a new file, split into files — every so many pages or at each selected page, saved as one zip; crop by margins in millimetres as the page is shown, or trim the white margins away; undo and redo; keyboard throughout, mirrored in Arabic |
| Compare (Warraq's engine) | what changed in the text between two versions — the file's own earlier revisions, or another PDF — word by word, with Arabic matching that follows the search (letter variants and diacritics optional); go to a change's page; and how each page looks, drawn and compared, with what looks different outlined — a drawing, a stamp or a picture the text cannot show; save the comparison, pictures included, as a report |
| AI (bring your own key, or local) | summarize, ask about, or translate the document with Claude on the person's own Anthropic key, or a model on this computer (Ollama or LM Studio). Nothing is sent before Send, and the screen first shows exactly what will go and where; the answer is shown as it streams in ("thinking" while the model thinks first), Stop keeps what arrived, and answers cite their pages. Refuses while redactions are marked but not applied |
| Combine (Warraq's engine) | add files (the open one comes first), reorder or remove them, unlock protected ones; the result opens in place, to save where you choose. The files chosen are not changed |
| Export (Warraq's engine) | Word (.docx, text only: paragraphs, direction and alignment, not layout), plain text, Markdown, a self-contained web page, and page images (PNG, zipped). Built from Warraq's own reading of the file as it stands now — a redaction applied in the viewer never reaches an export; unapplied marks are warned about |
| Scan & OCR (Tesseract + Warraq's engine) | choose the languages on the page and whether to read only pages without text; progress page by page, and a stop button; the result reports words read and Tesseract's confidence. Nothing is sent anywhere; the models are bundled |
| Compress (Warraq's engine) | three levels — without losing anything, smaller images (150 dpi), smallest (96 dpi) — then save the smaller copy beside the open file or open it in its place; says when a file is already as small as it gets |
| Digital signature (Warraq's engine) | **Sign**: open a certificate file with its password (the signer, issuer, key and expiry are shown first) or, on the desktop, read a smart card through its PKCS#11 module after the PIN; sign visibly — drag where on the page, optionally with a picture of a handwritten signature, the name, date, reason and place drawn in Amiri, Arabic shaped — or invisibly, or into an empty signature field the form already has; approval or certification (no changes / forms and signing / also comments), optionally locking the form's fields; RSA PKCS#1 v1.5 or RSA-PSS, ECDSA P-256 and P-384; on the desktop, a trusted timestamp from DigiCert, Sectigo, GlobalSign, SSL.com, FreeTSA or an address typed in (the panel says the server sees only a digest). The file is signed as it stands, every earlier change kept as an update of its own bytes, and saved through the normal Save. **Check**: a banner the moment a signed file opens (who signed, and valid / signer not trusted / changed after signing / invalid), and a list with each signature's details — the byte range, the digest, the signature, the chain and where trust ends, validity at signing time, the timestamp, revocation data in the file, and each kind of change made after it, permitted or not by its certification. Trust a signer's root with one click, or a certificate from a file; kept on this device only. **Keep**: on the desktop, add validation data (OCSP answers, revocation lists, certificates) to `/DSS`, and a document timestamp. When a tool that would break a signature is chosen, the shell says so before anything is changed |
| Comment (EmbedPDF) | highlight, underline, strike out, sticky note, text box, freehand drawing, rectangle, arrow, link |
| Fill & sign (EmbedPDF) | type into a form's fields, draw or type a signature and place it, place a stamp |
| Prepare form (EmbedPDF + Warraq's engine) | **Detect fields** on this page or all pages: the proposals are drawn over the page — drag to move, drag the corner to resize, arrow keys to nudge, Delete to remove — and listed with their name and type (text, check box, date, Hijri date, signature) to change; **Create fields** makes them real AcroForm fields (Arabic ones right-aligned, the label as the tooltip, dates with their format). **Add a field by hand**: EmbedPDF's text field, check box, radio button, drop-down and list box. **Formats and calculations** for a chosen field: number (decimals, separators, negatives in minus, brackets or red, ر.س after or SAR before, Arabic-Indic digits), percentage, date (four patterns), Hijri date (Umm al-Qura, three patterns); an allowed range; a sum, product, average, smallest or largest of chosen fields, or an arithmetic expression over their names (Arabic names, quotes for names with spaces, Arabic-Indic digits), checked as it is typed and refused if it would go round in a circle. Filling the form — in Fill & sign or anywhere in the view — recalculates it; a value outside its format or range is put back, with a notice. XFA forms and scripts Warraq does not run are said so, in this panel and in Fill & sign |
| Redact (EmbedPDF + Warraq's engine) | mark text or an area, then apply: the text and images underneath are removed from the file, not covered. Find and redact: words found the Arabic-aware way, or emails, phone numbers (Saudi and international, Latin or Arabic-Indic digits), national ID and Iqama numbers, IBANs, card numbers, dates, or a pattern of one's own — each listed with its page and context, the chosen ones marked over their exact glyphs. Remove hidden information: metadata, scripts and actions, attachments, comments, form data, hidden layers, bookmarks, thumbnails, applications' private data, links, hidden text — reported, chosen, and removed by writing the file anew, its earlier revisions and unused objects gone with them |
| Navigation pane (Warraq's engine) | in both views, from the View menu: bookmarks with their levels (a click goes to the page), attachments (saved, never opened; added with a description; removed), layers in their order with locked ones and print/export states shown, switched in the view only until *Save layer visibility with the file*; in Edit text also the page thumbnails |
| Protect (EmbedPDF) | require a password to open, restrict permissions |

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
26. **An adversarial review of Page marks, pictures and links** (three
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

## Known gaps, stated plainly
* **Prepare form — what is and is not proven.** Detection is measured on Chrome-printed forms and the corpus (above); forms made in Word, InDesign or by hand-coded generators have not been labelled, and a scanned form gets no proposals at all — its boxes and lines are pixels, not drawing. On a page that is no form, a table with an empty column gets proposals. The proposals are drawn over EmbedPDF's pages by reading its page layout (2.15.1); if the view is turned with EmbedPDF's own rotate, they are drawn unturned. Signature fields are real, empty signature fields for a digital signature (Digital signature signs into an empty field the form has; that has not yet been tried on one Prepare form made); Fill & sign places a drawn signature anywhere, over them too.
* **Form scripts: only the standard subset runs, and only inside Warraq's own interpreter.** Recognised: `AFNumber_*`, `AFPercent_*`, `AFDate_*` (the numbered and the `Ex` forms), `AFSpecial_*` (the four US masks), `AFRange_Validate`, `AFSimple_Calculate`, `event.value =` arithmetic over `getField(…).value` (simplified field notation), and Warraq's own `Warraq_Digits`, `Warraq_LatinDigits`, `Warraq_HijriFormat` and `Warraq_HijriKeystroke`, whose JavaScript definitions travel in the file for other readers and are recognised by their exact text. Anything else — document scripts, open actions, mouse and focus actions, a calculation with a variable or a loop — is listed in the panel (up to 100) and never run. A `/CO` a file leaves incomplete is completed in the form's order.
* **While a form is filled in Warraq, a formatted field shows the value as typed** (`1500`): PDFium runs no format script. The formatted look (`١٬٥٠٠٫٠٠ ر.س`) is drawn into the file when it is saved, and readers that run form scripts format it themselves. A value is checked when its field loses the focus; a calculated field is not made read-only.
* **Warraq's own functions have not been run in Acrobat**, which is not installed here; they were run as a form reader runs a field's script (an `event` object in a sandbox, `forms/readerScripts.test.ts`) and agree with the Rust that Warraq runs. In Acrobat, Arabic-Indic digits typed into a number field become Western ones through `Warraq_LatinDigits`.
* **Hijri dates** follow the Umm al-Qura table from 1356 to 1500 AH (1937–2077), checked against ICU on every 97th day; outside it they follow the tabular Islamic calendar, which can be a day off. Gregorian date patterns with a time show midnight.
* **XFA**: a static XFA form is filled through its AcroForm fields; readers that prefer the XFA layer may still show its old values until *Remove the XFA layer* is used. A dynamic XFA form is shown only as its file draws it without an XFA engine — usually a "please wait" page — and cannot be filled; the panel says so.
* **Digital signatures — what is and is not proven.** Proven by tests: signing an Arabic corpus file with RSA (PKCS#1 v1.5 and PSS), P-256 and P-384 keys from legacy (3DES/RC2-40) and modern (PBES2/AES-256) .p12 files, and `openssl cms -verify` (LibreSSL 3.3, an independent implementation) accepting every one and refusing each once a signed byte changes; a protected (AES-256) file signed and still protected; a form filled after signing (permitted) and after locking (not); page content drawn after signing, found; certification levels enforced; a revoked certificate caught from its OCSP answer; timestamps from a stand-in authority and — run once on 2026-09-19, over the network, by an ignored test (`cargo test --lib real_timestamp -- --ignored` in `apps/desktop/src-tauri`) — from DigiCert and Sectigo, both verified and trusted through Mozilla's roots, and their responders' OCSP answers written to `/DSS` and checked. Through the interface (`e2e/signatures.spec.ts`): sign with a TEST certificate, PDFium itself lists the signature, save keeps the signed bytes exactly (saving twice gives the same file), a comment afterwards is appended and listed as permitted, reopening checks it, trusting the TEST root makes it valid, and one changed byte makes it invalid.
* **Smart cards are untested with a card.** The PKCS#11 path (`apps/desktop/src-tauri/src/signing.rs`, the `cryptoki` crate) compiles and its encodings are tested, and the same `Signer` trait signed and verified with a software key standing in for the card — but no card, token or SoftHSM was available on this machine, and installing system software was out of bounds. Until someone signs with a real card, treat it as unproven.
* **The browser build cannot timestamp or fetch revocation data.** Checked on 2026-09-18: eleven public timestamp authorities answer a server, and not one sends the CORS headers a page needs to read the answer — no Content-Security-Policy change can fix that — so the web and extension builds say so in the panel and offer neither; the desktop app does both, from Rust. For the same reason the web CSP was not widened: allowing origins whose answers cannot be read would be a control that does nothing. Signing and checking work in every host.
* **Trust is Mozilla's root store plus what the person adds.** Mozilla's list is for web sites: many national and qualified signing authorities (the EU trusted lists, Saudi Arabia's National PKI) are not in it, and their signatures show as "signer not trusted" until their root is trusted from a file. Certificate policies, name constraints and qualified-signature status are not checked. A signature is judged at its timestamp's time, else at the time the signer's computer claimed.
* **Revocation is read, not fetched, when checking.** The check uses what is in the file (`/DSS`, or archived in the signature); it does not go online to ask. "No revocation data in the file" is shown as such, not as a failure.
* **Changes after signing are classified by object**, not by rendering: form values, comments, signatures, validation data and document properties are told apart from page content and document-wide changes; a change is permitted or not by the certification level and the field locks. A viewer that forbids some of what this permits (or the reverse) is possible in unusual files.
* **RSA signing uses the `rsa` 0.9 crate**, which carries the RUSTSEC-2023-0071 (Marvin) timing advisory; Warraq signs with blinding, locally, where no one can time it from outside, and never decrypts with RSA.
* **A signed file over 150 MB is written whole when it is saved from the viewer** (the existing limit on `file.rebase`, which holds both copies in memory), and that breaks its signatures. Below that size the signed bytes are kept exactly.
* **Page marks and pictures: what is not done.** A picture is shown but not offered for editing when the bytes that draw it draw it somewhere else too — a form XObject used twice on the page or drawn by another page, or a content stream two pages share — since changing it would change every place; the pages whose resources could reach such a form are walked to see whether they draw it, and a file too heavy to settle within that walk's budget (256 MB of content, 16 million operations) has the picture treated as shared. A picture inside a form cannot be moved or grown out of the form's box, where it would not show. Deleting or replacing a picture takes it out of the page's (or the form's) resources too; a picture that came with the file stays in the file's earlier revision until a clean copy is written (Remove hidden information, Compress), like every incremental change. A photo with an EXIF orientation is turned upright before it goes in — the one case where a JPEG is not stored byte for byte: it is written again once, at quality 92. Changing a picture watermark needs the picture chosen again (the file keeps the picture, not its source). Text edits made after a mark in Edit text join the page's content streams into one (lopdf's `change_page_content`); the marks still come off, but the page is then no longer byte-identical to the original — the edit changed it anyway. Marks drawn by other programs (Acrobat's own headers, say) are not listed: only Warraq's carry the private data that says what they are.
* **Content streams are read within bounds** (they come from hostile files): 64 MB decoded a stream, two million operations and operands kept from one, and a page's picture walk of 64 MB and four million operations visited, forms drawn again counted each time. A page past them has its pictures refused ("the page draws too much"), and a mark on it refused, rather than a hang. A form drawn inside itself is drawn once, as PDFium does.
* **Undo in Edit keeps a copy of the file for each picture, link or added-text change** (at most the last ten; older history goes with the oldest of them). Undo puts the file back byte for byte, in turn with text edits; switching back to the viewer starts the history again, as before.
* **Only Warraq's own marks leave Warraq's reading of a page.** Edit text, Export, Compare and AI read a page without Warraq's page marks (`/Artifact` carrying `/WarraqMark`) — a diagonal DRAFT would split every line it crosses. Other programs' artifacts — Word's and LibreOffice's running heads, footers and page numbers — are the page's text like the rest. Search and Find and redact read everything, Warraq's marks included, so nothing in a header, footer or watermark escapes a redaction. Where the page's marked content cannot be paired with what the renderer met (optional content, say), a page that carries Warraq's marks has all its artifacts kept out of Edit's reading, and search and redaction still read them. EmbedPDF's own search and selection (PDFium) include everything.
* **In EmbedPDF's view a click on a link selects it**, as its annotation tools are unlocked; its *Go to Link* then follows it — an address only after Warraq's question, a page of the file at once. On desktop the confirmed address goes to the system's opener through a new host command (`open_url`); that is covered by the web e2e with the browser's own `window.open`, not yet clicked in the installed window. An address with controls or invisible format characters (bidi embeddings, overrides and isolates, zero-width characters, the byte-order mark) is neither written nor opened, by the interface or the core alike, and the question shows it escaped; otherwise it shows an address in letters (an Arabic path as typed, not percent-encoded) and the site it really opens, in ASCII. A link written straight into a page's `/Annots` (against the spec) is changed and removed where it is.
* **Remove hidden information does not find everything that could hide text**: it finds text drawn invisibly (as an OCR layer is), in white, or off the page, on the pages themselves; text under an image, text cut away by a clipping path, and hidden text inside reused drawings (form XObjects) are not detected. A protected file is refused rather than written without its password: take the password off first. A signed file can be cleaned, and its signature stops being valid (the report says so).
* **Removing an attachment is an update**, like every change Warraq appends: the file's earlier revision still holds the attachment until the file is written whole — Remove hidden information does that, and the pane says so.
* **Showing or hiding a layer reopens the view** on a copy of the file: EmbedPDF's own undo history starts again (the changes themselves are kept), and it comes back to the page that was on screen. Layers are switched in the reading view only; in Edit text the Layers tab lists them. A layer's print and export states are shown, not edited.
* **EmbedPDF's own sidebar keeps its outline** beside Warraq's navigation pane: two lists of the same bookmarks in the reading view.
* **Deleted pages stay in the file's earlier revision**, like every incremental change, until a clean copy is written; extracting pages writes one. Bookmarks and links that pointed at a deleted page are left pointing nowhere in the open file.
* **A few of EmbedPDF's strings are English in any language**: they are written into its code, not its translations — its loading screens, some text-style tooltips, and default options it writes into new list fields ("Option 1–3").
* **On desktop, EmbedPDF's own Print button is hidden**; File → Print (Cmd+P) prints the file as it stands through PDFKit and the system print sheet on macOS — tested by printing the corpus into a PDF through the same operation, not yet with a person at a printer. Windows and Linux builds do not offer Print yet. EmbedPDF's file buttons (screenshot, insert image, attachment, signature upload) go through the native panels; that is tested against a stand-in for the host, not yet clicked in the installed window.
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
