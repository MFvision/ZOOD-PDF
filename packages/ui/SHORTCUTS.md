# Keyboard shortcuts (`@warraq/ui`)

Shortcuts are the same in Arabic and English. `Mod` is `Cmd` on macOS and `Ctrl` elsewhere.

| Keys | Action | Notes |
|---|---|---|
| `Mod+O` | Open a file | Shows the native file picker (`<input type="file">`). |
| `Mod+S` | Save | Placeholder: shows "Saving arrives in a later phase" and prevents the browser save dialog. |
| `Mod+F` | Find | Opens the find bar; searching calls `Document.search` in the core worker. `Esc` closes it. |
| `Mod+=` / `Mod++` | Zoom in | Steps through 25, 33, 50, 67, 75, 100, 125, 150, 200, 300, 400 %. |
| `Mod+-` | Zoom out | Same steps downwards. |
| `Mod+0` | Fit page | Whole page visible; recomputed when the window resizes. |
| `Mod+1` | Actual size | 100 % (1 pt = 96/72 CSS px). |
| `Mod+Shift+N` | Go to page | Opens the "Go to page" dialog. Chrome and Edge reserve this combination for a new private window, so the page indicator in the status bar and the Edit menu offer the same dialog. |
| `F4` | Toggle the navigation (thumbnails) pane | Only while a document is open. |
| `Shift+F4` | Toggle the tools pane | |
| `Esc` | Close the find bar or the open dialog/menu | |
| `Enter` in the page box | Go to the typed page | Ribbon page box. |

## Navigation inside the shell

* Menu bar: `←`/`→` move between menus (mirrored in RTL), `↓`/`Enter` opens, `↑`/`↓` move inside, `Esc` closes.
* Toolbars, tab lists and the menu bar follow the reading direction; `Home`/`End` jump to the ends.
* Pane resize handles are focusable separators: `←`/`→` resize by 16 px, `Home`/`End` set the minimum/maximum width.
* Thumbnails are buttons; `Enter`/`Space` scrolls to the page.
* Dialogs are native `<dialog>` elements: focus is trapped and `Esc` closes.
