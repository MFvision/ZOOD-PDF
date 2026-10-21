# Hand-over — where things stand (2026-10-19)

Written at the end of a very long first conversation so the next one can start fresh. Keep
this file current at the end of every job.

## What the owner has in hand

| Platform | Latest build | What is in it |
|---|---|---|
| Windows | Release `windows-20261019-1013` (PR #2, commit `58acfff`): https://github.com/MFvision/ZOOD-PDF/releases/download/windows-20261019-1013/ZOOD-PDF-Setup.exe | Everything below plus the Windows pilot, quick tools, tabs, tour, themes and the layout-keeping Word export; the core and desktop tests pass on Windows |
| macOS | Installed in /Applications from PR #2 (2026-10-19) | Same as Windows; the ring with Option/Command not yet tried by hand on the Mac |
| iPhone / iPad | TestFlight build `202610191832` | Editor with columns, kept colour and Automatic font; Word export keeps the layout (`DocxLayout.swift`, as `docxLayout.ts`), with "Word, text only" beside it; not the desktop's AI chat. Built before `pages.resize` reached the core (no iOS screen uses it) |
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
- **Mac signing (agreed for 2026-10-21)**: the desktop-v0.2.0 dmg is ad-hoc signed and its
  signature is incomplete ("code has no resources"), so other Macs will call it damaged. He
  creates a *Developer ID Application* certificate in Xcode (Settings → Apple Accounts → team
  AWV883QWPU → Manage Certificates); this Mac has only Apple Development and Apple
  Distribution. Then: sign with hardened runtime, notarize (`notarytool`), staple, rebuild the
  dmg, replace the release asset. On 2026-10-20 his Mac had the iPad TestFlight app ("محرر PDF
  2", app.warraq.ios) beside the desktop app — he mistook it for the Mac app; 0.2.0 is now
  installed as /Applications/ZOOD PDF.app.
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
  screenshot on `ci-logs` (`ring-check/`); on `58acfff` the log said "ring shown" and the
  screenshot shows the ring over Explorer (the step itself still reported failure after
  that, cause not found; trust the log and screenshot). The Mac side compiles (checked standalone for
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

## Quick tools, second round (2026-10-19 evening, the owner's rules)
The owner's rules (team memory `quick-tools-ux`): **no confirm pop-ups**. A tool that needs
nothing more runs the moment it is picked, and a window opens only for a password, pages, a paper
size or a mark's text, **with a live preview of the pages**.
- `quick/plan.ts`: each tool has `mode` (instant / ask / editor) and `ring`.
  - New tools: excel, powerpoint, text, split, resize, numbers, watermark, sign (opens the editor
    at Fill & sign: `open_in_editor_at`, `startup_tool`), unlock.
  - New batch steps `resize` (core `pages.resize`) and `unlock` (`protect.remove`).
- `quick/runQuick.ts` is the shared runner for both the quick window and the ring.
- `quick/QuickPreview.tsx` draws thumbnails with the core's `render_page`. They show kept or
  cut pages, split's files, each page on the new paper, and the watermark text.
- **The ring runs instant tools itself**, with a progress circle, then a tick or cross
  (`ring_take`, `ring_done`).
  - Protected files go to their tool's window, which asks for the password (`ring_pick` with
    `only`).
- **Ctrl+Alt+Z (Command+Option+Z)** opens the ring at the pointer on the selection
  (`tauri-plugin-global-shortcut`):
  - Windows: Explorer's selection through Shell.Application (PowerShell);
  - Mac: Finder's selection through osascript, which macOS asks about once
    (NSAppleEventsUsageDescription).
- The Windows ring check now expects result files beside the sample, tries the shortcut, and
  does a plain drag onto the main window as a control (to tell a CI-only drag failure from a
  ring failure).
- Queued next, in order: iPhone/iPad home-screen widget (the ring's shortcut). Android: the
  owner chose "website for now". The website videos and the explainer video belong to the
  website thread.

## iPhone Duo (folding iPhone), 2026-10-21
Apple's folding iPhone (announced 2026-09-09, in shops 2026-10-23): a 5.4" outer screen that
behaves like any iPhone (compact) and a 7.6" inner screen (about 626 x 890 points) that reports a
regular size class both ways. The app adapts by size and width, not by device:
- `Document/DocumentScreen.swift`: everything the document screen has open (the tool, the sheet,
  read aloud, the AI conversation) lives outside the view, so a fold or unfold, which swaps the
  Library's phone stack for its split view, keeps it. The view holds it; the model points weakly.
- `LibraryShell`: below 900 points wide (Duo unfolded, iPad portrait) the split view is a book,
  the section on one half and the document on the other, split at the fold; an opened document
  takes the whole screen and the split button brings the Library back.
- `DocumentView`: a pane under 520 points gets the phone's bars instead of the inspectors. New
  layout **Two pages** (PDFKit two-up as a book, RTL-aware), offered only where it is wide enough.
- `.github/workflows/ios-compile.yml` compiles the app and its tests for the simulator on a
  GitHub Mac on each PR touching `apps/ios` (nothing signed or published).
- Not used yet: the iOS 27.1 SDK's own fold APIs (`reservedRegions`, `onHingeChange`,
  `ArrangementView`); they need Xcode 27.1, and the layouts above work without them.
- Not tried on a real Duo or its simulator.

## Welcome tour and app motion (2026-10-21)
The owner found the old tour boring and two-coloured and wanted it to train people. Desktop
and web: `tour/` is now a large sheet with chapters down the side (`chapters.ts`; scenes in
`scenes.tsx`): language, look and light/dark chosen in it, the website's film
(`public/film/`, WebM then MP4; the web's service worker never keeps the MP4s), an animated
"open and edit" window, a right-click demo and a ring **practice area** (Ctrl/Shift or
Option/Command + drag a sample file, same geometry as the real ring), the real phone-remote
QR (`RemotePanel`), the AI and read aloud, and a finish list. Desktop shows it once more to
people who saw the old one (`warraq.tour` version 2). `styles/motion.css` adds press, hover,
screen/panel/tab entrances, busy sheen and the sidebar mark's sheen; `components/ZoodMark.tsx`
is the brand mark with a loop. Everything stops under Reduce Motion (system or Settings).
iOS: six tour screens (a Make it yours screen and a phone-remote screen) with motion,
**written without an iOS compiler** — run `scripts/ios/build.sh` before TestFlight.

## After that
As he chooses, from the study's top ten (sizes there are PdfCraft's formula and run
high; our desktop jobs took 1–1.5 h of real time each): large-format printing (A0/A1 at true
scale, tiling), autosave and crash recovery, command search (Ctrl/⌘+K), and measuring. (The Workbench theme and the theme choice on
desktop and web are done.)

## Ask ZOOD taps (2026-10-21, stacked on PR #8; idea from Sentient OS, AGPL, no code taken)
- **Double tap** the tap key (right Ctrl; right Command on a Mac; Settings can pick right Alt/Option
  or right Shift) in any app: `src/ask/tap.rs` reads key states every 12 ms (a modifier alone can't
  be a global shortcut; a key held with anything else is never a tap). The focused window is
  captured (`eye::capture_front`), the island reads its words with the app's Tesseract when the
  model is text-only (`packages/ui/src/ask/read.ts`), drafts with `draft.ts` (writing style from
  Settings › AI › Ask ZOOD, Library lines from `memory.ts`), and pastes via clipboard + Ctrl/Cmd+V
  with the clipboard put back (`src/ask/hands.rs`). Never sent. Away from a conversation it shows
  up to three ideas. Write it again = app's Undo, then a new draft.
- **One tap** opens the island with the keyboard for a typed request; new action `write` puts text
  at the cursor (also for spoken requests).
- **Home › Coming up** (`ask/today.ts`, `TodayCard.tsx`): deadline lines in the Library with a date
  from 7 days back to 30 ahead (day-first, Arabic/English months, Hijri Umm al-Qura).
- Tests: `apps/web/e2e/ask-tap.mjs` (real OCR in Chromium). **Not tried on real Windows or a Mac**:
  the key watcher, window capture, paste and focus hand-back compile for both (checked standalone).

## Teaching the Ask ZOOD keys (2026-10-21)
The owner: the keys are important and no one knows them. Desktop on Windows/Mac only (where
Ask ZOOD is): a tour chapter **Ask ZOOD** (`tour/askScene.tsx`) shows the keyboard's bottom row
with the person's key lit, then three practice tabs that react to the real keys: double tap
fills a pretend reply box with a draft, one tap opens a typing box, hold shows the island
listening (nothing recorded). The page reads its own key events with the host's tap logic
ported line for line (`ask/keys.ts`, same tests as `tap.rs`); while the chapter is open the host
is paused (`ask_pause`: shortcut unregistered so the page gets it, taps ignored). Tour version 3:
people who saw version 2 get it once more, opened at this chapter. Help › Ask ZOOD keys and the
Keyboard shortcuts sheet point to it; Settings › AI › Ask ZOOD has plainer wording and a
practice button; `ask/ReadyHint.tsx` shows a one-time card the first time Ask ZOOD can answer.
iOS: nothing (Ask ZOOD is not on iPhone/iPad). **Not tried on real Windows or a Mac** (the pause
and the page's view of right Ctrl/Command).

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
