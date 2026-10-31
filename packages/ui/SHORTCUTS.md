# Keyboard shortcuts (`@warraq/ui`)

Shortcuts are the same in Arabic and English. `Mod` is `Cmd` on macOS and `Ctrl` elsewhere.

They act on the view on screen: EmbedPDF (ADR-0007) while you read, comment,
fill, redact or protect, and Warraq's own view while **Edit text** is on
(`viewCommand` in `state/AppContext.tsx`). EmbedPDF listens for most of these
keys itself while it is showing and takes them first, so each runs once; while
Warraq's editor is up, every EmbedPDF shortcut is switched off, because
EmbedPDF stays mounted underneath and would otherwise answer keys meant for
the editor (`setKeyboard` in `embed/embedControl.ts`).

| Keys | Action | Notes |
|---|---|---|
| `Mod+O` | Open a file | Warraq's picker (the native panel on desktop). EmbedPDF's own Open is switched off: a file opened there was one Warraq did not know it had. A protected file asks for its password. |
| `Mod+S` | Save | Whichever view is showing holds the latest file: EmbedPDF's copy carries comments, fields, redactions and protection; Warraq's its text edits. Native save panel on desktop, a download in a browser. Always prevents the browser's own save dialog. |
| `Mod+P` | Print | The file itself: EmbedPDF's print dialog in a browser and the extension; on macOS the system print sheet through PDFKit, and on Windows and Linux the pages drawn at 300 dpi for the webview's dialog. A file that forbids printing is refused. |
| `Mod+F` | Find | EmbedPDF's search panel, with the cursor in its field and the last words selected to type over (pressed again it stays open); Warraq's find bar in Edit text. `Esc` closes it. |
| `Mod+Z` | Undo the last change | EmbedPDF's history (comments, fields, redaction marks); Warraq's edit stack in Edit text. |
| `Mod+Shift+Z` | Redo | Also `Ctrl+Y` on Windows and Linux while EmbedPDF is showing. |
| `Mod+=` / `Mod++` | Zoom in | |
| `Mod+-` | Zoom out | |
| `Mod+0` | Fit page | |
| `Mod+1` | Fit width | EmbedPDF's meaning for the key, now Warraq's too, so it does the same in both views. Actual size is in the View menu. |
| `Mod+Shift+N` | Go to page | Opens the "Go to page" dialog, which scrolls the view on screen. Chrome and Edge reserve this combination for a new private window, so the toolbar's page field takes a page number typed into it, and Edit › Go to page opens the same dialog. |
| `Ctrl+G` | Go to page | Windows and Linux, as in Word. On a Mac `⌘G` is Find's next match instead. |
| `F3` / `Shift+F3` | Next / previous match | Windows and Linux; `⌘G` / `⇧⌘G` on a Mac. `Enter` again in the search field, once it has searched, also goes to the next match. A first `F3` with no search yet opens Find. |
| `Mod+W` / `Ctrl+F4` | Close the document | Windows and Linux (`⌘W` stays the Mac menu bar's Close Window). A document with unsaved changes asks first: Save, Close without saving, or Cancel. A browser keeps `Ctrl+W` for its own tab. |
| `F10` | Go to the menu bar | Windows and Linux: the keyboard goes to the first menu; the arrows move from there. |
| `F4` | Toggle the page thumbnails | EmbedPDF's sidebar, or Warraq's navigation pane in Edit text. Only while a document is open. |
| `Shift+F4` | Toggle the tools pane | |
| `Esc` | Close the find bar or the open dialog/menu | |

Taken before EmbedPDF sees them (`useKeyboardShortcuts`, capture phase): `Mod+F`,
`F3`, `Enter` in the search field, `Ctrl+G`, `Mod+W`/`Ctrl+F4` and `F10`. A
keyboard-only reader found each of these dead (First Five, 2026-10-31). After a
file opens, the keyboard is on its pages when nothing else has it, so `Page Down`
and `End` read on at once.

While EmbedPDF is showing it also has keys of its own: `←`/`→` and `Mod+[`/`Mod+]`
turn the page, `H` and `P` switch between the hand and the pointer, `Mod+C` copies
the selected text, and `F11` goes full screen.

## Edit mode

Reachable from the **Edit** tool card, the **Tools → Edit** menu, the **Edit → Edit
text** menu item, and the pencil button in the toolbar. While it is on, hovering a
paragraph outlines it and the cursor becomes a text cursor.

| Keys | Action | Notes |
|---|---|---|
| `Tab` / `Shift+Tab` | Move between paragraphs | Every paragraph box is a button, so the whole mode works without a pointer. |
| `Enter` / `Space` | Open the paragraph under focus | The in-place editor opens over the paragraph box, pre-filled with its text. |
| `Mod+Enter` | Apply the change | Also available as the **Apply** button next to the editor. |
| `Esc` | Discard the change | The paragraph is left exactly as it was. |
| click outside | Apply the change | Anywhere outside the editor: the canvas, a pane or the toolbar. |

The editor takes its `dir`, `text-align` and font size from the paragraph itself,
so editing looks like the page. Replacement text is shaped with the bundled Amiri
Naskh face (`public/fonts/Amiri-Regular.ttf`, SIL OFL 1.1); when the core reports
`font_substituted`, a dismissible notice says so rather than changing the page
silently.

## Navigation inside the shell

* Menu bar: `←`/`→` move between menus (mirrored in RTL), `↓`/`Enter` opens, `↑`/`↓` move inside, `Esc` closes.
* Tool picker: `Enter` opens the gallery, the arrow keys move between its tiles in the reading direction (`Home`/`End` to the ends), `Enter` chooses, `Esc` closes and gives the focus back to the button.
* Segmented controls (Settings' language and appearance, Edit's kinds, Prepare form's scope) are one `Tab` stop: the arrow keys move and choose within them.
* Toolbars, tab lists and the menu bar follow the reading direction; `Home`/`End` jump to the ends.
* Pane resize handles are focusable separators: `←`/`→` resize by 16 px, `Home`/`End` set the minimum/maximum width.
* Thumbnails are buttons; `Enter`/`Space` scrolls to the page.
* Dialogs are native `<dialog>` elements: focus is trapped and `Esc` closes.
