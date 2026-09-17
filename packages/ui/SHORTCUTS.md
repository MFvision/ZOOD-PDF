# Keyboard shortcuts (`@warraq/ui`)

Shortcuts are the same in Arabic and English. `Mod` is `Cmd` on macOS and `Ctrl` elsewhere.

| Keys | Action | Notes |
|---|---|---|
| `Mod+O` | Open a file | Shows the native file picker (`<input type="file">`). |
| `Mod+S` | Save | Calls `Document.save()` and downloads `<original-name>.pdf` (a Blob and an object URL, revoked straight after). Always prevents the browser's own save dialog. Under Tauri this still uses the download path; a native save dialog is a TODO. |
| `Mod+F` | Find | Opens the find bar; searching calls `Document.search` in the core worker. `Esc` closes it. |
| `Mod+Z` | Undo the last text edit | Calls `replace_paragraph` with the paragraph's previous text. Disabled when the stack is empty. |
| `Mod+Shift+Z` | Redo the undone edit | Calls `replace_paragraph` with the text that was undone. A new edit after an undo truncates the redo branch. |
| `Mod+=` / `Mod++` | Zoom in | Steps through 25, 33, 50, 67, 75, 100, 125, 150, 200, 300, 400 %. |
| `Mod+-` | Zoom out | Same steps downwards. |
| `Mod+0` | Fit page | Whole page visible; recomputed when the window resizes. |
| `Mod+1` | Actual size | 100 % (1 pt = 96/72 CSS px). |
| `Mod+Shift+N` | Go to page | Opens the "Go to page" dialog. Chrome and Edge reserve this combination for a new private window, so the page indicator in the status bar and the Edit menu offer the same dialog. |
| `F4` | Toggle the navigation (thumbnails) pane | Only while a document is open. |
| `Shift+F4` | Toggle the tools pane | |
| `Esc` | Close the find bar or the open dialog/menu | |
| `Enter` in the page box | Go to the typed page | Ribbon page box. |

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
