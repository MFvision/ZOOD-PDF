# The owner's notes from testing on Windows (2026-10-14)

To be fixed after the PdfCraft study (plan B). Status as of this date.

1. **AI did not feel like a chat and gave no full summary.** Likely fixed in release
   `windows-20261011-1538` (chat panel, whole-document Analyze); the owner may have tested an
   earlier build. Re-test on that build.
2. **A PDF file shows the app's icon instead of a document icon.** Done in the Windows pilot
   (2026-10-18): the installer registers `.pdf` with a document icon (a page carrying ZOOD's
   mark, `apps/desktop/pdf-document.svg`). Windows shows it once محرر PDF is the default app
   for PDFs, which only the owner can choose (Windows asks, or Settings → Default apps).
3. **Convert did not work.** Not reproduced; ask which file and which target format.
4. **Double-clicking a recent file asks to locate it again** instead of opening it. Done in
   the Windows pilot (2026-10-18): the desktop app keeps each recent file's path
   (`src-tauri/src/recent.rs`) and opens it directly; a file that has moved is asked for.
   Also: a second double-clicked PDF now opens in the window already open.
5. **Editing took the whole line across sections.** Fixed in `windows-20261011-1538`
   (columns edit separately). Re-test.
6. **Fonts** (own font, installed fonts, the library download) — not yet tested by the owner.
7. **Printing works**; A0/A1 and what the engineering team needs (measurement, scale,
   tiling) are to be checked.
8. **Google Drive / OneDrive** connect and share — not started; needs the owner's developer
   client IDs (he has the accounts).
