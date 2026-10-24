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

## One tap to talk, with the screen glowing (2026-10-21, stacked on PR #18)
The owner: voice took too many steps (permissions, a download, holding three keys). Like
Claude's Mac app (Caps Lock once to start, again to stop), **one tap of the Ask key** (right
Ctrl / right ⌘) now listens until the next tap, or until the person goes quiet
(`ask/listen.ts`: 1.6 s quiet after speaking, 8 s if nothing is said; host stops at 60 s).
While it listens a click-through window over the screen glows round its edges in ZOOD bronze
and gold, swelling with the voice (`ask/Glow.tsx`, `glow.css`, host `show_glow`, label
`ask-glow`), and the island draws the voice as a moving line with **Done** and **Type instead**.
Settings › AI › Ask ZOOD › Tap once: Talk / Type a request / Nothing (talk falls back to typing
until the hearing model is in); a Glow switch. Holding Ctrl/⌘+Shift+Space still works. Double
tap is unchanged. **One-button setup** (`ask/AskSetup.tsx`, in Settings and the tour chapter):
downloads the hearing and deciding models together, then asks each missing permission in turn
(Mac: microphone via a short open of it, Input Monitoring via `IOHIDRequestAccess`,
Accessibility, Screen Recording; Windows: the microphone privacy switches, read from the
registry) and tells the host to listen. Input Monitoring matters on a Mac: without it ⌘C made
with the right ⌘ reads as a tap. Tour version 4 re-shows the Ask chapter, whose first tab is
now "Tap once: talk" with a pretend glowing screen. **Not tried on real Windows or a Mac.**

## Ask ZOOD talks back, shows, explains and does (2026-10-21)
The owner's go on the notch/Sentient OS doc (all four now). **Talk back**: answers are said in
the Read aloud engines (`speech/engines.ts`: Mac AVSpeech through the host incl. Premium
voices, Windows' own natural voices e.g. Kareem, Web Speech elsewhere), the voice and speed
chosen in Read aloud (`ask/voice.ts`). Settings › Ask ZOOD › Talk back: When I speak (default)
/ Always / Never; a tap of the key stops it. **Show me / Explain this / Do it for me**
(`ask/guide.ts`, island phase `guide`, host `ask/guide.rs`): new decision acts `show`,
`explain`, `do` (only with a model that sees). ZOOD's pointer (Point.tsx `GuidePointer`,
class `ask-pointer`) flies out of the island to each step and stays; Show me waits for the
person's click near the step (`ask_watch_clicks`, mouse button polled, 5 min max) or "I clicked
it", then `ask_look_again` retakes the picture and the model gives the next step (max 8).
Explain this asks for up to 6 parts in one look and walks them while speaking. Do it for me
clicks (`ask_click`, enigo) **only when ZOOD PDF was in front** (`focus::is_ours`); elsewhere it
points. It asks before a step or goal that sends/deletes/pays/signs (`risky`, EN+AR), and
stops with `E_MOVED` when the person moved the mouse (Go on resumes). The island moves to the
bottom (`ask_island_aside`) when a step is under it. Settings switch "Let Ask ZOOD click
inside ZOOD PDF". Tour v5: Ask chapter tab "Show me and do it" plays all three on a pretend
window; Help › "Ask ZOOD: Show Me, Explain and Do It" opens it. The quick-actions thread adds
an `organize` act and a quick decider at the top of `respond` (separate files). **Not tried on
real Windows or a Mac; coordinates depend on the vision model's accuracy.**

## Help & Support (2026-10-21)
The owner wants support with no staff, no accounts and no paid servers. F1, Help › Help &
Support, Settings › Support and a tour chapter (tour version 7) open `support/SupportCenter.tsx`.
**Ask** searches 24 bilingual guides (`support/articles.ts`) and FAQ. **Show me** and **Do it
for me** (`support/guide.ts`) find the real controls by their words and point at them or press
them. Each guide is also a PDF (`scripts/support/make-guides.mjs`, in the app and on the
website's help pages). **Report a problem** and **Ideas** go through the PHP + MySQL relay
`website/api/support/`, which runs on his Hostinger plan and files issues in a private
`MFvision/zood-support` repository. Until it is uploaded, reports go by e-mail. The weekly review
routine is in `docs/support/weekly-review.md`. **Waiting on him**: upload the relay, create the
private repository and its token (steps in `website/api/support/README.md`). After that, the
weekly routine can be switched on. Not tried on real Windows or Mac.
**Step pictures (2026-10-22)**: the owner found text-only guides unhelpful, so every guide step
that names a control now shows a picture of the real app with that control lit up, in Arabic and
English (63 pictures each), and three steps move (editing a paragraph, organizing pages, the
ring). They are taken by `scripts/support/make-shots.mjs`; how to retake them is in
`docs/support/README.md`. Retake the affected pictures whenever a screen in a guide changes.

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

## Quick asks and tidying (2026-10-21; idea from the Pragmatic Coder video on Jev, no code taken)
The owner: a quick action ("make these smaller", "organize my Downloads") should not need a 3 GB
model thinking. Ask ZOOD now has a **quick lane**: a small decision model, Jev-Style 0.8B
Decision v3 (Apache-2.0, a Qwen3.5-0.8B fine-tune, 529 MB Q4_K_M, pinned in `models.json` with
`"decides": true`), ranks 27 options with a probability each without writing a word
(`src-tauri/src/decide.rs`: the model's own prompt layout and " yes"/" no" readout, ported from
its Apache-2.0 Python runtime; its own thread beside the main engine, sharing one llama backend,
`ai::backend()`). `packages/ui/src/ask/quick.ts` reads the ranking: a tool, *find* or *organize*
at 0.8 or above is done at once with a one-line reply in the person's language; 0.6–0.8 shows
the usual confirm card; under 0.6 the island offers the two best guesses as buttons. Writing,
filling, summarizing, translating, showing and answering go to the larger model as before.
**Tidying** (`src-tauri/src/ask/tidy.rs`): Downloads, Desktop, Documents or the selected folder
or files, by kind, by month, renamed by date, or invoices gathered (by name, or a PDF's first
page). The host makes the plan and keeps it (the page can't name files), the island shows the
moves, **Tidy now** applies them; only top-level files move, one level down, never through a
link, nothing deleted or overwritten (" (2)" instead), each move journalled to
`tidy-undo.json` so **Undo** (button, or "undo") puts every file back and removes the folders it
made. Folders must be inside the home folder and not the home folder itself. The decider is in
Ask ZOOD's one-button setup and in Settings › AI › Ask ZOOD › Quick decider; without it asks go
to the larger model as before. Tour version 6: a **Quick asks** chapter (`tour/quickAskScene.tsx`)
and Help › Quick asks and tidying. Tests: `quick.test.ts`, `decide.rs` and `tidy.rs` unit tests
(apply and undo on a real folder), and an ignored real-model test (`real_model_picks_the_quick_actions`,
see `docs/local-ai.md`). **Not tried on real Windows or a Mac** (the cloud CPU only).

## Sort with ZOOD: files thrown on ZOOD (2026-10-24; the owner's idea)
The owner wanted a reason for ZOOD to keep running in the background: gather messy files and
let ZOOD organise them. While the app runs, a drag of files **with no key held** (from File
Explorer or the desktop on Windows, any file drag on a Mac) brings **ZOOD's drop zone** down from
the top middle of the screen, where Ask ZOOD's island lives: a black pill at first, opening into
"Drop here to sort" when the pointer comes near (`src-tauri/src/sort.rs`, watched by the ring's
own pollers in `ring.rs`, `Gesture::Dragging`). Files let go there, on the **ZOOD bubble**
(`presence.rs`), or on the ring's new **Sort** place (two files or more) open a **Sort window**
(`packages/ui/src/sort/`). The host reads each PDF's first 40 pages of words (`sort_look`); the
rules (`sort/plan.ts`) suggest **merging** a numbered series (PDFs combined, scans/pictures made
one PDF; camera photos never), **splitting** a PDF where a new invoice number or "page 1 of"
starts, **renaming** names that say nothing (IMG_…, scan0001, Document (3)) from the topic, a
short line of the first page and the date, and **folders** by topic (invoices, bank statements,
contracts, IDs, travel, medical, CVs, certificates) or else by kind. With the quick decider
downloaded, it names the topic of documents the rules could not (`sort/ai.ts`, on the device).
Each suggestion has Do it / Skip; Do all runs them merge → split → rename → folders. **Speak**
starts Ask ZOOD's one tap; the island hands the words to the Sort window (`sort_voice`), which
reads them with fixed words in Saudi Arabic and English (`sort/voice.ts`: "merge them but don't
rename", "كلها", "تراجع") and answers aloud. Safety as tidying: the window names files only by
their place in the session, moves stay inside the session's folder (one level down) and the home
folder, nothing is overwritten; merged/split originals go to an **Originals** folder; every move
and every made file is journalled (`sort-undo-<window>.json`), and **Undo** moves everything back
and removes only the files the sort made. Settings › Quick tools › "Drop files on ZOOD to sort
them" (`dropZone` in `quick-tools.json`, on by default, in the settings book). Tour version 13:
a **Sort with ZOOD** chapter with a drag-and-drop practice (`tour/sortScene.tsx`); Help › Throw
files on ZOOD to sort them (pictures `sort-*`). Tests: `sort.rs` (zone placement, apply and undo
on disk, names can't climb), `sort/plan.test.ts`, `sort/voice.test.ts`. **Not tried on real
Windows or a Mac**: on Windows the zone also comes down for a rubber-band selection dragged to the
top from Explorer (the watcher cannot tell it from a file drag); it goes away when the button is
let go.
