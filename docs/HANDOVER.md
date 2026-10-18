# Hand-over — where things stand (2026-10-18)

Written at the end of a very long first conversation so the next one can start fresh. Keep
this file current at the end of every job.

## What the owner has in hand

| Platform | Latest build | What is in it |
|---|---|---|
| Windows | Release `windows-20261011-1538` (commit `d4b22e1`): https://github.com/MFvision/ZOOD-PDF/releases/download/windows-20261011-1538/ZOOD-PDF-Setup.exe | Everything below; the core and desktop tests pass on Windows |
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

## The next job (agreed, not started)
**A priced pilot**: item 3 of `docs/research/pdfcraft-comparison.md` — Windows basics:
a document icon for `.pdf` files (a page carrying our mark, registered in the Tauri bundle's
file association), recent files reopening directly by path instead of asking to locate them,
and a second double-click going to the window already open. These are the owner's own
backlog items 2 and 4. One agent, desktop only, no simulators. **Note the weekly usage %
before and after** (`get_usage`; it was 23% of the week on 2026-10-18) so the rest of the
list can be priced from a real number.

Then, as he chooses, from the study's top ten (sizes there are PdfCraft's formula and run
high; our desktop jobs took 1–1.5 h of real time each): large-format printing (A0/A1 at true
scale, tiling), autosave and crash recovery, command search (Ctrl/⌘+K), measuring, and the
Workbench theme (`docs/research/pdfcraft-theme.md`, which also brings the theme choice to
desktop and web).

## Known open problems
- **iPhone UI tests**: 6 of 55 failing at the last full run, each a test reaching for a
  control below the fold or a duplicate identifier (theme picker ×2, Protect's Remove, form
  fields bar, AI autofill's Fill, batch save) — recordings showed the app working for three
  of them; the theme and batch ones were not confirmed.
- **iPad**: unit 205/208 (three tests assume English on an Arabic simulator); the UI suite
  was not completed — Redact's Find, drawn form-field placement and the lock tests still
  fail, cause not established.
- **Browser e2e on this Mac is flaky** ("Target page … has been closed", a different 1–2 tests
  per run, each passes alone); `read-aloud.spec.ts` test 1 also fails on older code.
- **On-device AI quality**: the 0.5B model (the only one in a browser) cannot summarize long
  documents; the 1.5B gets the gist but degrades on long Arabic summaries and rarely cites.
  Options offered to the owner: a larger on-device model, or his own Claude key.
- Bold paragraphs that fall back to a bundled face come back regular (no bold bundled).
- Convert failed for the owner once on Windows — not reproduced (ask which file and format).

## Housekeeping
- The GitHub repository is **public** since 2026-10-11 (the owner's choice).
- Xcode's Apple account signs out from time to time; the owner signs back in.
- Old agent worktrees under `.claude/worktrees/` can be removed once merged; two named
  ones (`frosty-bartik-…`, `wonderful-thompson-…`) belong to the owner's other sessions.
