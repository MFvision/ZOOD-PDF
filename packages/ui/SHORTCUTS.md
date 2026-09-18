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
| `Mod+P` | Print | EmbedPDF's print, in a browser and the extension. Not offered on desktop yet: the app has no route to the system print dialog. |
| `Mod+F` | Find | EmbedPDF's search panel; Warraq's find bar in Edit text. `Esc` closes it. |
| `Mod+Z` | Undo the last change | EmbedPDF's history (comments, fields, redaction marks); Warraq's edit stack in Edit text. |
| `Mod+Shift+Z` | Redo | Also `Ctrl+Y` on Windows and Linux while EmbedPDF is showing. |
| `Mod+=` / `Mod++` | Zoom in | |
| `Mod+-` | Zoom out | |
| `Mod+0` | Fit page | |
| `Mod+1` | Fit width | EmbedPDF's meaning for the key, now Warraq's too, so it does the same in both views. Actual size is in the View menu. |
| `Mod+Shift+N` | Go to page | Opens the "Go to page" dialog, which scrolls the view on screen. Chrome and Edge reserve this combination for a new private window, so the page indicator in the status bar and the Edit menu offer the same dialog. |
| `F4` | Toggle the page thumbnails | EmbedPDF's sidebar, or Warraq's navigation pane in Edit text. Only while a document is open. |
| `Shift+F4` | Toggle the tools pane | |
| `Esc` | Close the find bar or the open dialog/menu | |

While EmbedPDF is showing it also has keys of its own: `←`/`→` and `Mod+[`/`Mod+]`
turn the page, `H` and `P` switch between the hand and the pointer, `Mod+C` copies
the selected text, and `F11` goes full screen.

## Edit mode

Reachable from the **Edit** tool card, the **Tools → Edit** menu, the **Edit → Edit
text** menu item, and the pencil button in the ribbon. While it is on, hovering a
paragraph outlines it and the cursor becomes a text cursor.

| Keys | Action | Notes |
|---|---|---|
| `Tab` / `Shift+Tab` | Move between paragraphs | Every paragraph box is a button, so the whole mode works without a pointer. |
| `Enter` / `Space` | Open the paragraph under focus | The in-place editor opens over the paragraph box, pre-filled with its text. |
| `Mod+Enter` | Apply the change | Also available as the **Apply** button next to the editor. |
| `Esc` | Discard the change | The paragraph is left exactly as it was. |
| click outside | Apply the change | Anywhere outside the editor: the canvas, a pane or the ribbon. |

The editor takes its `dir`, `text-align` and font size from the paragraph itself,
so editing looks like the page. Replacement text is shaped with the bundled Amiri
Naskh face (`public/fonts/Amiri-Regular.ttf`, SIL OFL 1.1); when the core reports
`font_substituted`, a dismissible notice says so rather than changing the page
silently.

## Navigation inside the shell

* Menu bar: `←`/`→` move between menus (mirrored in RTL), `↓`/`Enter` opens, `↑`/`↓` move inside, `Esc` closes.
* Toolbars, tab lists and the menu bar follow the reading direction; `Home`/`End` jump to the ends.
* Pane resize handles are focusable separators: `←`/`→` resize by 16 px, `Home`/`End` set the minimum/maximum width.
* Thumbnails are buttons; `Enter`/`Space` scrolls to the page.
* Dialogs are native `<dialog>` elements: focus is trapped and `Esc` closes.
