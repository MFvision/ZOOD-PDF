# The owner's notes from testing on Windows (2026-10-14)

To be fixed after the PdfCraft study (plan B). Status as of this date.

1. **AI did not feel like a chat and gave no full summary.** Likely fixed in release
   `windows-20261011-1538` (chat panel, whole-document Analyze); the owner may have tested an
   earlier build. Re-test on that build.
2. **A PDF file shows the app's icon instead of a document icon.** Needs a document icon (a
   page carrying our mark) registered for `.pdf` in the Windows bundle's file association.
3. **Convert did not work.** Not reproduced; ask which file and which target format.
4. **Double-clicking a recent file asks to locate it again** instead of opening it. The
   desktop app must keep the file's path and reopen it directly.
5. **Editing took the whole line across sections.** Fixed in `windows-20261011-1538`
   (columns edit separately). Re-test.
6. **Fonts** (own font, installed fonts, the library download) — not yet tested by the owner.
7. **Printing works**; A0/A1 and what the engineering team needs (measurement, scale,
   tiling) are to be checked.
8. **Google Drive / OneDrive** connect and share — not started; needs the owner's developer
   client IDs (he has the accounts).
