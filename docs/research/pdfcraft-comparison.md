# محرر PDF and PdfCraft: what each does better, and what to bring over (2026-10-14)

This is plan B: محرر PDF (code name Warraq) stays the product, and we take from PdfCraft only the
parts that are genuinely better. It is a study. No product code changes here.

**Sources.** PdfCraft is `github.com/storytold/pdfcraft` at commit `7437bde` (MIT OR Apache-2.0,
Rust and egui, alpha). The repository was read but never built or run. Ours is `main` at `d029e65`.

**Method.** Each area below was judged from the code and its tests: module headers, `#[test]` counts,
fixtures and the gaps the code itself admits. READMEs were not taken on trust. PdfCraft's
self-assessment (`docs/gaps.md`, `docs/target-app-parity.md`, `parity/acrobat-features.toml`) was
read too. It is candid and agrees with what its code shows. Its own figures: 429 of 836 checklist
features shipped and 89 partial, about 49 % "ready for real work" against Acrobat Pro, and 245 open
issues on 2026-10-10.

## Size of the two code bases (Rust; `#[test]` counted)

| | PdfCraft | محرر PDF |
|---|---|---|
| Engine crates | about 150k lines in 31 crates, about 1,765 tests (ui-egui alone: 77k lines, 1,109 tests) | 78k lines in 5 crates (`warraq-pdf` 45.5k/273, `warraq-core` 21.2k/248, `warraq-sign` 5.8k/44, `warraq-text` 4.7k/57, `warraq-render` 1.2k/3), plus about 52 Playwright e2e specs and vitest |
| UI | egui, native, one window. Arabic is **not mirrored**, and there are no Arabic fonts in the default build | React (web, Tauri desktop, extension) and SwiftUI (iOS), mirrored right to left, Arabic first |
| Page drawing | vendored `hayro` 0.7 with about 270 local patches | EmbedPDF (PDFium in WASM) for the view, our own core for editing |
| `unsafe` | forbidden workspace-wide (0 lines) | 76 lines, nearly all at the FFI boundary (`warraq-core/src/ffi.rs`) |

## The 14 areas, compared

Legend: **PC** is PdfCraft, **W** is ours. "Stronger" is a judgement from code and tests.

| # | Area | PdfCraft (code, tests, admitted gaps) | محرر PDF (code, tests, admitted gaps) | Stronger |
|---|---|---|---|---|
| 1 | **View** | `render` 12.4k/269 tests, a tile pool, a repair-by-scan parser (`cos` 5k/75), a 500-page scrolling test. Two-up, tabs, full screen. Own gaps: rendering "borrowed and unmeasured" (gap 2), blurry text at 1080p (#730). Bookmarks, layers and attachments are in the right rail | PDFium through EmbedPDF (mature fidelity), Arabic-aware search and logical-order copy (e2e), bookmarks, attachments and layers panes mirrored in RTL | **W** on fidelity and Arabic. **PC** on tiling of huge pages and on the command palette |
| 2 | **Edit** | `edit` 10.4k/132. Latin paragraphs only; "font reused or Helvetica substituted"; `edit.rtl-cjk-editing` *planned*; Arabic editing is open issue #766 | Shaped Arabic and Latin paragraph edit with reflow, font matching (document, installed, library), add text, images, page marks, Bates (Gate 2 passed on real files) | **W**, clearly |
| 3 | **Organize** | `organize` 7k/120: page labels, page boxes (Trim/Bleed/Art), duplicate, replace, transitions, a flat page tree, links/fields/layers/bookmarks carried across | Rotate, reorder, insert, extract, split, crop and combine, keeping fields (e2e). Page labels are only read (`PageLabels` in one file). No box editing, no replace-pages | **PC** on breadth (labels, boxes, replace) |
| 4 | **Comment** | `annot` 5k/41, `xfdf` 2k/30: every markup type, replies, status, filters, dynamic stamps, summary, flatten, **XFDF/FDF/CSV import and export**, **2D measuring** | EmbedPDF's annotation plugin plus our Arabic appearances. No XFDF/FDF, no measurement ("Measurement not yet", feature matrix) | **PC** |
| 5 | **Forms + JS** | `forms` 7.3k/67 and `js` 6.5k/44: AcroForm with Acrobat's AF functions in event order, **boa** JavaScript sandbox (no I/O, 1M-iteration and depth-256 caps, no wall-clock cap), XFA static and dynamic layout with FormCalc (partial) | Fill and author through EmbedPDF plus the core; Arabic appearances; **auto-detect fields** (precision and recall 1.00 on 92 labelled fields); a recognised **subset** of AF scripts in our own interpreter; dynamic XFA not fillable | **PC** on JavaScript and XFA depth. **W** on Arabic forms and field detection |
| 6 | **Protect / redact** | `redact` 3.7k/40: glyphs, image pixels and vectors under the mark, form XObjects rewritten, a verification pass, FOIA codes. **`audit`** (793/13) finds *faux redactions* (black boxes over text still there). `crypt` R2–R6; no certificate security | True removal, Arabic-aware find and redact with Saudi patterns (ID/Iqama, IBAN mod 97, Luhn), hidden-info removal, AES-256 R6 | Even. **PC** has the faux-redaction audit and vector cutting. **W** has Arabic and Saudi patterns |
| 7 | **Signatures** | `sign` 10k/116: PAdES B-B, Windows CNG and macOS Keychain keys, certification. **No PKCS #11, no timestamp servers, no online revocation** (gap 10) | `warraq-sign` 5.8k/44 plus e2e: PAdES B-B, **B-T and B-LTA against real TSAs, B-LT (OCSP/CRL into DSS)**, PKCS #11 built (untested on hardware), DocMDP/FieldMDP judged on verify | **W** (PC has the OS key stores) |
| 8 | **OCR** | `ocr` 400/9: ocrs, "Latin without accents" only; models CC-BY-SA-4.0 | tesseract.js with ara/eng/fas/urd, deskew, cleanup; 94 % of Arabic words on a 300 dpi scan (e2e) | **W**, clearly |
| 9 | **Create / export** | `export` 2k/24, `create` 2k/23: Word "loses layout" (#773), no Excel/PowerPoint, no Office import | Word, Excel (tables, Arabic-Indic numbers), PowerPoint, HTML, Markdown; Create from Word/Excel/PowerPoint/HTML/images with shaped Arabic | **W**, clearly |
| 10 | **Optimize / standards** | `optimize` 2k/13 (bicubic resample, space audit), `preflight` 1.2k/10 (PDF/A-2b/3b verify, partial); no PDF/X/UA | Compress (e2e); PDF/A 1b, 2b, 2u, 3b converted and validated (49-file corpus); PDF/X checks | **W** on standards. **PC** has a "space usage audit" view |
| 11 | **Print** | `print` 731 lines plus 645 lines of tests (25): **18 paper sizes incl. A0/A1/A2, ARCH and ANSI C/D/E; Fit/Actual/Shrink/Custom %; n-up; booklet; poster tiling with overlap and cut marks**, as a *vector* print-ready PDF. The OS spool lives in an external `craft-print` crate (not in the repo) | macOS through PDFKit (vectors). Windows/Linux: each page **rasterised at 300 dpi capped at 36 MP**, so A0 is downsampled; one page per sheet; no n-up, booklet, poster or scale; not yet run on Windows | **PC**, clearly. This matters for the engineering team |
| 12 | **Accessibility** | `a11y` 3.8k/33: **the full 32-rule checker** in seven categories with an HTML report; no tagging tools (gap 11) | Tagging (reading order proposed, edited and written as a structure tree, MCIDs spliced, e2e on 42 files), alt text, `/Lang` per span; **16** PDF/UA and WCAG checks | **W** on tagging. **PC** on checker breadth |
| 13 | **Automation** | `automation` 15k/192: CLI, **MCP over stdio**, 141 tools; opt-in loopback UI control (token, constant-time compare); Action Wizard (partial) | Batch: steps over files and folders, saved actions, a summary (e2e) | **PC** on scripting and agents. **W** on a usable batch UI |
| 14 | **AI** | none (gap 23: local provider "not started"); an "Optional" row in All tools | Chat over the whole document, summary, translation; on iOS, Apple's on-device models; local providers (Ollama, LM Studio) | **W** |

Also outside the 14 areas:

- **Ours is stronger** on the Library (search across documents), cloud (OneDrive, Google Drive),
  read aloud, the iOS app, compare (1,246 core lines and 57 UI tests against their 488/7; it handles
  Arabic and the file's own revisions) and anything Arabic.
- **Theirs is stronger** on the desktop shell: tabs for several documents, autosave and crash
  recovery (`ui-egui/src/recovery.rs`), reopening the last session, the command palette, Windows
  integration (below) and a big-page tile renderer.

### Engineering team needs (owner's note 7)

| Need | PdfCraft | Ours | Gap |
|---|---|---|---|
| A0 or A1 on a plotter, true to scale | Vector imposition, A0/A1/ARCH/ANSI sizes, Actual size (`print/src/lib.rs:240-259`) | Raster at 300 dpi capped at 36 MP: an A0 sheet (9,933×14,043 px at 300 dpi = 139 MP) is downsampled to about 150 dpi | Large |
| Tiling an A0 drawing onto A4/A3 sheets | Poster: tile scale, overlap, cut marks, at most 1,024 sheets (`lib.rs:461-480`, tests at `tests.rs:208,222`) | None | Large |
| Measuring distance, perimeter and area at a drawing's scale | `measure` 552 lines plus `snap.rs` 433 plus 22 tests: two-point calibration, ISO 32000 `/Measure` and `/Viewport`, rotation and UserUnit, Line/PolyLine/PolygonDimension annotations, CSV export, snap to vector ends and intersections, 45° constraint | None | Large |
| Layers (CAD layers as OCGs) | Toggled inside the renderer (hayro patch) | Layers pane toggles by rewriting `/D /ON /OFF` on a rendered copy; visibility can be saved (`warraq-pdf/src/layers.rs`) | Small (ours works) |
| Comparing drawing revisions | Word diff plus pixel diff | Word diff plus pixel diff plus a report, Arabic-aware | None (ours is better); neither has a colour overlay |
| Line weights / hairlines | Only a planned "Fix hairlines" | None | Neither |

### Windows desktop integration (owner's notes 2 and 4)

| Need | PdfCraft | Ours |
|---|---|---|
| `.pdf` file association with a **document icon** | WiX: ProgID `PdfCraft.Document`, `DefaultIcon` `,-2` (a separate document icon embedded in the exe), `OpenWithProgids`, Capabilities, RegisteredApplications. Never takes over the default (`packaging/windows/pdfcraft.wxs:81-100`). Explorer "Create PDF" verbs for images | No `fileAssociations` in `tauri.conf.json`; NSIS only; the app icon shows on PDFs |
| Recent files reopen by path | Last session reopens (`apps/pdfcraft/src/reopen.rs`); files open by path | Recents keep name, thumbnail and time only, so opening one asks for the file again (`home/RecentList.tsx:20-24`) |
| Single instance | `single_instance.rs` (402 lines, 8 tests): a per-sign-in Unix socket in `%LOCALAPPDATA%` hands paths to the running window, falling back to a new window | None: every double-click starts a new process; only the first command-line file is read (`src-tauri/src/lib.rs:219-231`); no `RunEvent::Opened` |
| Jump lists | None | None |
| Drag and drop | Yes | Yes |

## What to bring over, ranked

Each item names the code and why ours is weaker, then how it fits and how big it is. Hours are Opus
5.5 agent-hours and include tests and the e2e.

**Licence handling for every item.** PdfCraft is MIT OR Apache-2.0. Ported code keeps a header naming
"PdfCraft contributors" and the dual licence, and an entry goes into `THIRD-PARTY-NOTICES.md`. Their
crates sit on their own object layer `pdfcraft_cos`, not on lopdf, so a "port" means re-expressing
the algorithms and tests over `warraq-pdf`. Copying a crate as it stands would not work.

1. **Print imposition: poster tiling, true-scale large formats, n-up and booklet.**
   - *What:* `crates/print/src/lib.rs` (731 lines), `range.rs` (112), and its tests (645 lines, 25 tests).
   - *Why ours is weaker:* we rasterise at 300 dpi capped at 36 MP and print one page per sheet, so
     there is no A0 at scale and no tiling.
   - *Fit:* a new `warraq-pdf/src/impose.rs` that writes a vector print-ready PDF (pages as form
     XObjects on sheets), plus a `print.impose` RPC. The UI then prints that PDF: PDFKit on macOS,
     the browser on the web. On Windows we need a vector route, either the WebView2 PDF print or
     `Windows.Data.Pdf` as PdfCraft's external `craft-print` does (its source is not in the repo, so
     we write our own).
   - *Risk:* plotter drivers. Test with a PDF printer and the A0/A1 sizes.
   - *Size:* **medium**, 16–24 h (core 8–10, print dialog UI 6–8, Windows spooling 4–6).
2. **Measurement and scale.**
   - *What:* `crates/measure/src/lib.rs` (552) and `snap.rs` (433), tests 377 lines plus 2 property
     tests, and the UI ideas in `ui-egui/src/measure_ui.rs` (494).
   - *Why ours is weaker:* we have none.
   - *Fit:* the core does `/Measure`, `/Viewport`, calibration, readings, snapping and CSV export, and
     writes the dimension annotations through an incremental update. Our UI adds a Measure tool
     (distance, perimeter, area, set scale) over EmbedPDF's page, with Arabic units (م، سم، مم) and
     Arabic-Indic digits as options.
   - *Risk:* snap cost on dense CAD pages. Theirs is capped at 20k segments and 16 MiB of content;
     keep the caps.
   - *Size:* **large**, 24–36 h.
3. **Windows file association, document icon, single instance and recents by path.**
   - *What:* the design of `packaging/windows/pdfcraft.wxs:81-100` and
     `apps/pdfcraft/src/single_instance.rs`.
   - *Why ours is weaker:* see the table above; these are owner notes 2 and 4.
   - *Fit:* Tauri's own `bundle.fileAssociations` (with a document `.ico` of our own: a page bearing
     our mark), `tauri-plugin-single-instance` (MIT/Apache) to pass paths to the running window, and
     the desktop recents keeping the absolute path (with an fs scope grant) so a double-click reopens
     it. This is configuration and Tauri plugins, not ported code. Like theirs, it must never take
     over the default PDF handler.
   - *Size:* **small to medium**, 8–12 h.
4. **Command palette ("Find tools and commands", ⌘K / Ctrl+K).**
   - *What:* `ui-egui/src/palette.rs` (240 lines) over their command registry (184 commands).
   - *Why ours is weaker:* we have menus and a tool gallery but no single search over every
     command.
   - *Fit:* re-implement in React over `menuModel.ts` and `tools.ts`, with Arabic-normalised
     matching (our `view.search` folding).
   - *Size:* **small**, 4–6 h.
5. **XFDF / FDF / CSV comment and form-data exchange.**
   - *What:* `crates/xfdf/src/lib.rs` (2,056 lines, 30 tests).
   - *Why ours is weaker:* we have none. Review workflows and form data imports need it.
   - *Fit:* port into `warraq-pdf/src/xfdf.rs`; import merges by `/NM`, and form values go through our
     `forms.fill` so the Arabic appearances are drawn.
   - *Size:* **medium**, 12–18 h.
6. **Autosave and crash recovery.**
   - *What:* `ui-egui/src/recovery.rs` (the working file every N seconds to a recovery folder, offered
     at start-up) and `reopen.rs`.
   - *Why ours is weaker:* we have no recovery of unsaved work on the desktop.
   - *Fit:* the desktop host writes the current bytes (the original plus our incremental updates) to
     the app data folder; the home screen offers them at start-up.
   - *Size:* **medium**, 8–12 h.
7. **Faux-redaction audit.**
   - *What:* `crates/audit` (793 lines, 13 tests): opaque rectangles painted after text that can still
     be read (WCAG contrast below 3), and redaction marks never applied.
   - *Why ours is weaker:* we redact correctly but cannot check a file somebody else "redacted".
   - *Fit:* a `redact.audit` RPC over our content-stream interpreter; shown in Redact as "check this
     file for hidden text under boxes".
   - *Size:* **small**, 5–8 h.
8. **Organize breadth: page labels, page boxes, replace and duplicate pages.**
   - *What:* `crates/organize/src/labels.rs` and `boxes.rs`, plus the replace and duplicate operations
     (120 tests in the crate).
   - *Why ours is weaker:* we only read page labels, and we cannot set Trim/Bleed/Art boxes (print
     shops and engineering title blocks use them) or replace pages.
   - *Fit:* port into `warraq-pdf/src/pages.rs`; Hijri and Arabic-Indic label styles are our addition.
   - *Size:* **medium**, 8–12 h.
9. **Accessibility checker breadth.**
   - *What:* the 32 rules in seven categories in `crates/a11y` (3.8k lines, 33 tests) and the HTML
     report.
   - *Why ours is weaker:* we check 16 rules (our tagging is far stronger).
   - *Fit:* add the missing rules to our checker beside the tagging tool; report in Arabic and
     English.
   - *Size:* **medium**, 10–14 h.
10. **Comment review: replies, status, filters, summary.**
    - *What:* `crates/annot` (5k lines, 41 tests) and `ui-egui/src/comments_panel.rs`.
    - *Why ours is weaker:* EmbedPDF's plugin lacks threaded replies (`/IRT`), review status, and
      filters by author, type or status.
    - *Fit:* a Comments panel in our right pane, with replies and status written by the core as
      incremental updates.
    - *Size:* **medium**, 12–16 h.

**Considered and not recommended now:**

- **Full form JavaScript (boa) and XFA.** These are the deepest parts of their forms work (6.5k
  lines in `js`, 9.2k in `xfa`), but the attack surface is large: there is no wall-clock or memory
  cap, and a 1 GiB stack is reserved. Our safe subset covers the forms we see. Size **large**,
  40–60 h. Revisit only if real files need it.
- **MCP and the CLI.** These are useful to agents rather than users. Size **medium**.
- **Their renderer patches.** If `warraq-render/src/hayro_backend.rs` stays in use, their hayro
  hardening patches (allocation caps, nesting budgets, all marked `PdfCraft patch:`) are worth
  reviewing upstream, rather than us forking.
- **Their OCR, export, editing and signatures.** Ours are better.

## Security and licence findings for anything we copy

- **Licences are clean.** `deny.toml` admits only MIT, Apache-2.0, BSD, ISC, Zlib, Unicode, BSL and
  CC0, plus OFL for fonts. A search of the repository found no GPL, AGPL or LGPL code. The GPL tools
  (poppler) run only as external comparison processes in `xtask`.
- **Do not copy:**
  - the **ArtCraft marks** (`docs/brand/*`, "LicenseRef-Storyteller-Trademark"). They also appear in
    `docs/images/pdfcraft-tools.png` and on their Home screen's community card;
  - their **app and document icons** (their branding, though MIT/Apache);
  - the **ocrs OCR models**, which are CC-BY-SA-4.0, share-alike. We do not need them.
- **External code not in the tree:** `storytold/craft-libs` (the `craft-ui` docking and widgets, and
  the `craft-print` OS spooler) is a git dependency. Its licence and code were not verified. Copy
  nothing that depends on it; re-implement instead.
- **Vendored forks** (hayro, lopdf, winit, egui-wgpu) keep upstream licences (Apache-2.0 OR MIT, MIT,
  Apache-2.0). Anything taken from them carries the upstream notice as well as PdfCraft's.
- **Unusual font licences in their tree:** Ubuntu-font-1.0 and Bitstream-Vera (Hack). Do not bring
  these.
- **Their security choices are worth matching:** `unsafe` forbidden everywhere; filter decoders
  bounded by `max_output`; snapping and poster tiling capped. The control port binds 127.0.0.1 on a
  random port, uses a 128-bit token in an owner-only file and a constant-time compare, and is off
  unless `--control` is given. Even so, it lets a client open any path and drive the UI, so **we
  should not bring it**: it adds a local attack surface our users do not need. The single-instance
  socket is per sign-in and lives in the user's own profile, which is the right shape if we ever
  write our own (the Tauri plugin is preferable).
- **No-façade conflict:** their All tools panel lists planned tools with a "Planned · M#" hint
  (`ui-egui/src/panels.rs:100-125`). Our rules forbid that, so nothing planned may be shown in our
  version (see the theme spec).
