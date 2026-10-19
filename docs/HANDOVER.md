# Hand-over — where things stand (2026-10-19)

Written at the end of a very long first conversation so the next one can start fresh. Keep
this file current at the end of every job.

## What the owner has in hand

| Platform | Latest build | What is in it |
|---|---|---|
| Windows | Release `windows-20261018-1940` (PR #2, commit `62ef0a6`): https://github.com/MFvision/ZOOD-PDF/releases/download/windows-20261018-1940/ZOOD-PDF-Setup.exe | Everything below plus the Windows pilot (PDF document icon, recent files reopen, one window); the core and desktop tests pass on Windows |
| macOS | Installed in /Applications from `d4b22e1` | Same as Windows |
| iPhone / iPad | TestFlight build `202610052355` | Editor with columns, kept colour and Automatic font (own font, else closest bundled face); not the desktop's AI chat |
| Web | Builds from `main` | Same as desktop, minus installed fonts |

Since `d4b22e1`, `main` only gained documents (this file, `CLAUDE.md`, the backlog, the
PdfCraft study).

**Done and in those builds** (detail in `docs/STATUS.md`): the 20 tools on desktop/web; the
iOS app (viewer, annotate, organize, export, protect with AES-256, PAdES signatures, scanner
with Arabic OCR and the camera/skew fixes, editor, redact, forms, compare, batch, Library,
widgets, on-device AI and read aloud, welcome tour); ZOOD's real logo and the B5 icon; the
Liquid Glass and Zood themes (iOS only so far); editing a column on its own; a replaced
paragraph keeps its colour; Automatic font (A own font → B installed → C open library after a
one-time question → D closest bundled; B and C on desktop/web only); the AI assistant as a
chat with whole-document Analyze (desktop/web).

## Waiting on the owner
1. In App Store Connect → TestFlight, assign build `202610052355` to himself, or create an
   internal group with automatic distribution so later builds arrive on their own.
2. Re-test on the latest Windows build: the AI chat and column editing (`docs/backlog/`
   items 1 and 5), and the fonts (item 6).
3. Before the App Store (not TestFlight): confirm the ITF Huwiya licence covers embedding in
   an app.
4. For Google Drive / OneDrive: his developer client IDs, when he wants that job.

## The Windows pilot (done 2026-10-18, PR #2, draft until the owner approves)
PDFs get a document icon (`ZoodPDF.Document`, set by `src-tauri/windows/hooks.nsh`; shown once
the app is Windows' default for PDFs), recent and starred files reopen by path
(`src-tauri/src/recent.rs`), and a second launch hands its PDF to the open window
(`tauri-plugin-single-instance`). The same PR fixed CI that was red on `app` before it: the
corpus runner's passwords, a clippy 1.99 lint, the RSA-PSS salt's DER encoding (OpenSSL
refused it), the Windows core_bridge test (hayro there by design), the Settings dialog's first
focus and the read-aloud highlight (EmbedPDF 2.x counts pages from zero).
Weekly usage: 23% before; the after figure could not be read from a cloud session (no
`get_usage` there) — read it in the Claude app.

## Added to PR #2 on 2026-10-19 (the owner asked for it all in one PR)
- **Quick tools without opening the app** (idea from Filee, no code taken): right-click files
  in Explorer (`src-tauri/src/shell_menu.rs`, HKCU keys, written at every start in the UI's
  language) or Finder (a Services entry, `Info.plist` + `shell_menu.rs`) → a small window
  (`packages/ui/src/quick/`) that compresses, converts to Word/pictures, OCRs, combines,
  rotates, extracts, protects or makes a PDF from pictures/Office files, saving beside the
  original. **Ctrl/Shift (Option/Command) + drag** files out of Explorer/Finder shows a ring of tools at the
  pointer (`src-tauri/src/ring.rs`, a low-level mouse hook on Windows, drag-pasteboard polling on
  macOS); an optional background mode starts at sign-in and waits in the tray.
- **Document tabs** (`state/tabs.ts`, `shell/TabBar.tsx`): parked tabs keep their file,
  page and unsaved changes; Organize's page drag (now pointer events, since the Windows
  webview keeps HTML drag-and-drop for Explorer files) drops pages onto a tab (copied to its
  end) or onto + (a new document).
- **Welcome tour** (`tour/Tour.tsx`): opens once on the desktop app's first run, again from
  Help → Welcome tour and Settings → Quick tools → Show me how.
- **AI**: the providers are renamed (Built into the app (recommended) / Ollama or LM Studio);
  the owner's Windows error was the Ollama choice with no Ollama installed. The error now says
  so and offers a button to switch to the built-in model.
- **Read aloud** on a page with no text offers OCR, then reads (web/desktop). On iPhone it
  reads the page's picture with Vision without changing the file — **written, not built or
  tested** (no Mac in that session).
- **Bold**: a bold paragraph redrawn in a face with no bold is drawn with an outline in its
  own colour (`ops::replace_paragraph`, `synthetic_bold`; test `warraq-core/tests/edit_bold.rs`).
- **Not tested on real Windows or a Mac**: the right-click menu, the ring, background mode and
  the tray. They compile for both and their logic has unit tests.

## The owner's test of that build (2026-10-19) and what changed
- **The ring did not open** for him (he tried Ctrl, Command and Shift). It now accepts Ctrl
  or Shift on Windows and Option or Command on a Mac, and the window is made a few seconds
  after start so the first drag finds it ready. On a Mac it no longer uses an NSEvent monitor
  (other apps' drags don't reach one); it polls the mouse button, the keys and the system's
  drag pasteboard every 30 ms, and opens for a drag of files from any app. Both platforms
  write `ring.log` (64 KB at most, no file names) in the app's data folder, saying what the
  watcher saw. The Windows workflow tries the ring for real (`scripts/ci/ring-check.ps1`:
  Ctrl+drag a file out of Explorer by synthetic input) and puts its log and a mid-drag
  screenshot on `ci-logs` (`ring-check/`). The Mac side compiles (checked standalone for
  x86_64-apple-darwin) but was **not run on a Mac**.
- **AI suggestion chips could not scroll**: they now wrap onto more lines (`ai/chat/chat.css`).
- **Themes**: Settings → Theme and View → Theme now choose Liquid Glass, Zood or Workbench on
  desktop and web (`styles/looks.css`, `html[data-look]`); the old light/dark choice is now
  labelled Appearance.
- **PDF → Word lost everything but the words**: Word export now keeps each page as it looks
  (`export/docxLayout.ts`): the page's pictures and drawing behind the text, each line as a
  text box in its own font, size, weight and colour, table cells as separate boxes (core op
  `export.lines`). "Text only, flowing" keeps the old export. Checked in LibreOffice, **not in
  Microsoft Word**.

## After that
As he chooses, from the study's top ten (sizes there are PdfCraft's formula and run
high; our desktop jobs took 1–1.5 h of real time each): large-format printing (A0/A1 at true
scale, tiling), autosave and crash recovery, command search (Ctrl/⌘+K), and measuring. (The Workbench theme and the theme choice on
desktop and web are done.)

## Known open problems
- **iPhone UI tests**: 6 of 55 failing at the last full run, each a test reaching for a
  control below the fold or a duplicate identifier (theme picker ×2, Protect's Remove, form
  fields bar, AI autofill's Fill, batch save) — recordings showed the app working for three
  of them; the theme and batch ones were not confirmed.
- **iPad**: unit 205/208 (three tests assume English on an Arabic simulator); the UI suite
  was not completed — Redact's Find, drawn form-field placement and the lock tests still
  fail, cause not established.
- **Browser e2e on this Mac is flaky** ("Target page … has been closed", a different 1–2 tests
  per run, each passes alone).
- **On-device AI quality**: the 0.5B model (the only one in a browser) cannot summarize long
  documents; the 1.5B gets the gist but degrades on long Arabic summaries and rarely cites.
  Options offered to the owner: a larger on-device model, or his own Claude key.
- Convert failed for the owner once on Windows — not reproduced (ask which file and format).

## Housekeeping
- The GitHub repository is **public** since 2026-10-11 (the owner's choice).
- Xcode's Apple account signs out from time to time; the owner signs back in.
- Old agent worktrees under `.claude/worktrees/` can be removed once merged; two named
  ones (`frosty-bartik-…`, `wonderful-thompson-…`) belong to the owner's other sessions.
