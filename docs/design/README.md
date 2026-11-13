# ZOOD PDF design system

This page is the reference for the shared interface in `packages/ui`: the web app, the desktop app, the
extension and, inside its native shell, the Android app. The iPhone and iPad app's themes have a section
at the end. Follow it and a new screen, panel or control will match the rest of the app without extra CSS.

The interface is built from named tokens and shared controls, and it is shown in one of **13 looks**.
Zood, in ZOOD's own colours, is the look a person sees first. A look changes colours, materials and
sometimes layout. It never changes what a control is or how it behaves.

- Tokens: `packages/ui/src/styles/tokens.css`, the one place colours, type, spacing, radii, depth and motion
  are defined.
- Looks: `styles/looks.css` (each look's colours), `styles/looks/` (what a look changes besides colour) and
  `styles/appearance.css` (the person's own choices over the look).
- Motion: `styles/motion.css`.
- Controls: `styles/components.css`, plus `shell/shell.css` (window, toolbar, overlays) and
  `shell/panes.css` (sidebar, inspector, tool panels).
- Screenshots: `docs/design/screenshots/` (how to regenerate them is at the end).

**What was checked, and when.** On 2026-11-13 the Looks, Tokens, Motion and Components sections were
written or corrected from the CSS and TypeScript files they name. In the other sections (the window, the
macOS app, narrow windows, EmbedPDF, the app icon, the iOS themes) every file, class, component and test
name was checked to exist, and what no longer matched was corrected. Their descriptions of behaviour were
not tested again; they stand as written in September and October 2026.

The base of the system follows macOS: system type, colours named for what a surface is, hairline
separators and controls at the system's sizes. Nothing here copies Apple's artwork. There are no SF
Symbols, no bundled Apple fonts and no Apple logos. Icons are Lucide (ISC). The app font is the platform's
own `system-ui`: SF Pro and SF Arabic on Apple devices, Segoe UI on Windows, with Cairo and Inter bundled
for the rest.

## Principles

1. **The document comes first.** The chrome is quiet in every look. Colour is kept for the accent (what is
   selected, what is primary) and, in the looks that have them, for the tools' tiles.
2. **Name what a surface is, not what colour it is.** Use `--window-background` or `--secondary-label`,
   never `#f5f5f7`. The same name then works in every look, in light and dark, and with increased contrast
   or reduced transparency.
3. **One place for each thing.** The document's title, the page and the edited state sit in the toolbar.
   The tools sit in the tool picker and the inspector. Settings sit in Settings. Nothing appears twice, and
   nothing appears that does nothing (see STATUS: no façades).
4. **Respond on press.** Every control changes the moment the pointer goes down (`:active`, no transition
   delay). Nothing waits for release to show feedback.
5. **Motion answers the person.** A press gives at once, a hover wakes what can be clicked, and screens and
   panels come in from where they live. A few things move by themselves: work that is running, and ZOOD's
   mark catching the light. All of it stops under Reduce Motion. The rules are under Motion, below.
6. **Arabic is not an afterthought.** Every layout uses logical properties, which stylelint enforces.
   Arabic text is never letter-spaced, because tracking breaks the joins — including the app's own name
   inside an English sentence, which is written `<bdi dir="rtl" lang="ar">`. Directional icons mirror
   (`<Icon mirror>`). Numbers typed in Arabic-Indic digits work in the page field.
7. **No pure white, no pure black.** No surface is `#fff` or `#000` in any look: the two side by side are
   harsh on the eyes, most of all on OLED screens. The page of a PDF is the one white (`--page-white`), as
   paper is.

## Looks

A look sits over the light or dark appearance. The person chooses both in Settings › Appearance:
**Appearance** (System, Light, Dark) and **Look**. The View menu lists the looks too (`shell/menuModel.ts`).

- The chosen look is kept in the preferences (`state/preferences.ts`) and put on the page as
  `<html data-look="…">` by `state/AppContext.tsx`. Light or dark is `<html data-theme>`, as before.
- Liquid Glass is the absence of `data-look`: it is `tokens.css` as it stands.
- `defaultLook()` returns `zood`. That is the look before the person chooses one, on every system.

There are 13: five looks (`BASE_LOOK_IDS`) and eight premium colour themes (`PREMIUM_LOOK_IDS`).

| `data-look` | Name in the app | Colours | What it changes besides colour |
| ----------- | --------------- | ------- | ------------------------------ |
| `concept` | Concept | A sky-blue and lilac gradient under frosted panels, white cards, a deep-indigo sidebar | `looks/concept.css`: the sidebar is a frosted rail with white text and line icons, cards have 16-px corners, the home headline is centred and large, and the document window is glass over the same gradient |
| (none) | Liquid Glass | `tokens.css` as it is: the macOS greys, translucent materials, and the system's accent where the engine gives it | Nothing |
| `zood` | Zood, **the default** | ZOOD's navy, beige paper and bronze | `looks/zood.css`: headings in ITF Huwiya Arabic where that font is installed on the computer (it is a bought font and never ships with the app), the brand's pattern faint behind the home screen and empty places, bronze icons, and ZOOD's mark in the sidebar |
| `workbench` | Workbench | Flat light grey, 1-px borders, one blue; no blur, smaller radii | `looks/workbench.css` and `shell/workbench.ts`: its own layout. Tabs with Home first at the very top, a mode bar, the tools down the leading side, the panels behind a slim rail on the trailing side, and a quick bar floating over the page |
| `mono` | Monochrome | Greys only; the accent is a grey | `looks/mono.css`: every icon is a plain line with no tile. Settings offers no accent colour and no coloured icons in this look |
| `lantern`, `garden`, `silver`, `amethyst`, `walnut`, `latte`, `terra`, `atlas` | Desert lantern, Night garden, Silver signal, Amethyst night, Walnut grove, Cosmic latte, Stone and clay, Summer trip | Eight palettes, each with a day and a night side that follow Light and Dark | `looks/premium.css`: Liquid Glass's layout in the palette's colours |

### How a look is made

- **A look re-points the same tokens.** `looks.css` sets `--window-background`, `--label`, `--accent` and
  the rest again for each look, once for light and once for dark. No component knows which look is on.
- **What a look changes besides colour lives in its own file** under `styles/looks/`. Apart from Settings
  and the welcome tour, which show the looks to choose from, only the files under `styles/` name a look. A
  panel's own CSS should not.
- **The premium themes are data.** `styles/premiumThemes.ts` holds each palette; `looks/premium.css` carries
  the same colours as tokens. `premiumThemes.test.ts` fails when the two differ, and when a text colour
  reads at less than 4.5:1 on its ground. Each palette follows 60-30-10: the first colour fills the window,
  the second tints the sidebar, text and borders, the third is kept for the main button, links and
  highlights.
- **The order of the stylesheets matters** (`App.tsx`): `tokens.css`, `looks.css`, the files in `looks/`,
  `appearance.css`, then the fonts, the base and the components, and last `motion.css` and
  `liquidGlass.css`.
- **The small windows take a look's colours only.** The ring, the Ask ZOOD island, the Sort window and the
  quick-tools window import `tokens.css`, `looks.css`, `looks/premium.css` and `appearance.css`, and set
  `data-look` themselves. They do not import the files that change a look's shape (`looks/zood.css` and
  the others).
- **The picture on each look's card** in Settings is drawn by `settings/LookPreview.tsx`.

### The person's choices over the look

Settings › Appearance also has these. `settings/SettingsEffects.tsx` puts each on `<html>` as a data
attribute and `styles/appearance.css` reads it. Nothing is set while a choice is the look's own.

| Setting | Attribute | What it does |
| ------- | --------- | ------------ |
| Accent colour | `data-accent` | The look's own, or blue, purple, pink, red, orange, green or graphite. It wins over the look's accent, except in Monochrome |
| Coloured icons | `data-icons="plain"` | Off: each tool's glyph in the text colour on a quiet tile |
| Icon size | `data-icon-size` | Small or large; medium sets nothing |
| Reduce transparency | `data-reduce-transparency="on"` | Every material becomes its solid colour and the blurs go, as the system's own setting does |
| Reduce motion | `data-reduce-motion="on"` | Stops animation and transitions, as the system's own setting does (see Motion) |

### Liquid glass's light

`styles/liquidGlass.css` gives each floating piece the light real glass catches: a bright rim and a crescent
in the corners nearest the light, which comes from above the reading start (the top right in Arabic).
Where the engine can bend what is behind a piece (Chromium, so the Windows app), `styles/liquidGlass.ts`
bends the backdrop near the piece's edge. Both are off in the flat looks, Workbench and Monochrome, and
with reduced transparency.

## Tokens

### Colour

The values below are `tokens.css` itself, which is the Liquid Glass look. Every other look gives the same
names its own values in `looks.css`.

| Token                                        | Light                         | Dark                            | Use                                                                   |
| -------------------------------------------- | ----------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| `--window-background`                        | `#f5f5f7`                     | `#242426`                       | The window, the inspector, the home screen                            |
| `--toolbar-background`                       | `#f6f6f8` at 82 %             | `#28282a` at 82 %               | Toolbar, menu bar, find bar, banners (with `--blur-regular`)          |
| `--sidebar-background`                       | `#ececf0` at 78 %             | `#222224` at 76 %               | The sidebar's source-list material (with `--blur-thick`)              |
| `--content-background`                       | `#fcfcfd`                     | `#1c1c1e`                       | Text fields, the page-number field                                    |
| `--under-page-background`                    | `#e6e6ea`                     | `#161618`                       | Behind the pages (both engines)                                       |
| `--grouped-background`                       | `#fcfcfd`                     | `#2c2c2e`                       | Grouped inset sections, cards, action lists                           |
| `--elevated-background`                      | `#fcfcfd` at 86 %             | `#2c2c2e` at 86 %               | Sheets, popovers, menus, the HUD (with `--blur-thick`)                |
| `--control-background`                       | `#fdfdfe`                     | white at 12 %                   | Push buttons, pop-up buttons, the selected segment                    |
| `--control-border`                           | black at 12 %                 | white at 10 %                   | The edge of a control                                                 |
| `--glass` / `--glass-edge`                   | white at 70 / 80 %            | `#3a3a3c` at 62 %, white at 12 % | A floating piece of glass and its edge                               |
| `--label` / `--secondary-label` / `--tertiary-label` / `--quaternary-label` | black at 85 / 50 / 26 / 10 % | white at 88 %, grey at 58 / 28 / 14 % | Text by importance; tertiary is also disabled text                    |
| `--separator` / `--opaque-separator`         | black at 10 %, `#d9d9dd`      | white at 10 %, `#38383a`        | Hairlines (always `0.5px`), and a line that must not show through     |
| `--fill` … `--quaternary-fill`               | black at 10 / 7 / 5 / 3 %     | white at 16 / 11 / 8 / 5 %      | Pressed, selected, hover and resting plates                           |
| `--accent` / `--accent-contrast`             | `#007aff`, white              | `#0a84ff`, white                | What is selected and what is primary, and the text on it. In this look it becomes CSS `AccentColor` where the engine has it (Safari, and so the macOS app). Each other look sets its own, and the person's accent colour wins over both |
| `--red` `--orange` `--yellow` `--green`      | system colours                | system colours                  | `--destructive` is red                                                |
| `--focus`                                    | accent at 85 %                | accent at 85 %                  | The focus ring                                                        |
| `--selection`                                | accent at 28 %                | accent at 28 %                  | Selected text                                                         |
| `--scrim`                                    | black at 22 %                 | black at 45 %                   | Behind a sheet                                                        |
| `--page-white`                               | `#fff`                        | `#fff`                          | The page of a PDF: the one white                                      |
| `--home-gradient`                            | sky, haze, green on `#f5f6fa` | navy on `#1c1d22`               | The home screen's ground: an original CSS gradient, no picture        |
| `--glass-panel` / `--glass-card` / `--glass-border` / `--glass-hover` | white at 52 / 66 / 60 / 80 % | dark grey at 52 / 58 %, white at 12 %, grey at 70 % | The home's frosted panels, cards, their 1-px edge, and a hover. Solid under increased contrast and reduced transparency |

The older names (`--bg-app`, `--bg-panel`, `--fg-muted`, `--border`, `--accent-soft`, `--radius-m`…) are kept
as aliases under "Compatibility" in `tokens.css`. Panels written against them still follow the look. New
code should use the semantic names.

**Accessibility variants** are at the end of `tokens.css`:

- `prefers-contrast: more` makes materials solid, separators and control borders stronger, secondary
  labels darker, and the focus ring the full accent.
- `prefers-reduced-transparency: reduce` turns every material into its solid colour and removes the blurs.
- `prefers-reduced-motion: reduce` turns the spring into a plain step and shortens the long durations to
  160 ms. Components replace any travel with a cross-fade.

### Type

The body text is **13 px**, as on macOS. Tracking changes with size and is **always 0 in Arabic**
(`:root:lang(ar)` sets every tracking token to 0).

| Style       | Token                 | Size |
| ----------- | --------------------- | ---- |
| Large title | `--text-large-title`  | 26   |
| Title 1     | `--text-title1`       | 22   |
| Title 2     | `--text-title2`       | 17   |
| Title 3     | `--text-title3`       | 15   |
| Headline    | `--text-headline`     | 13   |
| Body        | `--text-body`         | 13   |
| Callout     | `--text-callout`      | 12   |
| Subheadline | `--text-subheadline`  | 11   |
| Footnote    | `--text-footnote`     | 10   |

Tracking, for Latin text: `--track-large-title` −0.022em, `--track-title1` −0.018em, `--track-title2`
−0.012em, `--track-title3` −0.008em, `--track-body` −0.006em and `--track-small` +0.004em.

Weight is not a token: each component sets its own. Line height is `--leading-tight` (1.15) or
`--leading-body` (1.38). `--font-ui` is the interface face and `--font-mono` the fixed-width one.

Use `font-variant-numeric: tabular-nums` wherever numbers change in place, such as the page, zoom and sizes.

### Space, radii, sizes

- Space follows a 4-pt grid: `--space-1` = 2 px through `--space-10` = 48 px.
- Radii: `--radius-6` for small controls and fields, `--radius-8` for the default button and the segmented
  control, `--radius-10` for grouped sections, `--radius-12` for popovers, `--radius-16` for sheets, and
  `--radius-capsule` for the switch, the HUD and badges. A look may change them: Workbench makes the larger
  ones smaller.
- Controls are `--control-h` (28 px) high, or `--control-h-small` (22 px) for pop-ups, segments and the page
  field. The toolbar is `--toolbar-h` (52 px, 48 on a phone). The browser's menu bar is `--menubar-h` (26 px).
  On a touch screen all four grow to take a finger (Narrow windows, below).
- Icons are Lucide with a stroke of `--icon-stroke` (1.6). `Icon` draws them at 18 px unless told otherwise.
  Settings › Appearance › Icon size scales the tools' tiles and the toolbar's and home sidebar's icons.

### Depth and materials

- `--shadow-control` is the bezel of a button or field.
- `--shadow-small` is a card resting on the window.
- `--shadow-popover` is for menus and popovers.
- `--shadow-sheet` is for sheets and drop targets.
- `--shadow-page` is paper on the grey.
- Materials are `--blur-thin`, `--blur-regular` and `--blur-thick`. Larger surfaces use thicker materials.
  Never put a translucent surface on top of another translucent one.

### Motion tokens

- `--spring` is a `linear()` sample of a critically damped spring (damping 1, response about 0.35 s). It
  has no overshoot and is used for everything that travels.
- `--ease-out` is used for fades and colour changes. `--ease-in` is used only for things leaving.
- Durations are `--duration-press` (90 ms), `--duration-quick` (160 ms), `--duration-regular` (260 ms) and
  `--duration-sheet` (340 ms).

## Motion

`styles/motion.css` holds the app's motion in one place, so that it reads as one system. It is short,
springy and never in the way. Use the tokens above; do not write a duration or a curve by hand.

### What moves

| When | What happens | Where |
| ---- | ------------ | ----- |
| **Press** | The control gives under the pointer at once: an icon button shrinks to 92 %, a push button to 97 %, a card, tab or chip to 96–98 %. No delay on `:active` | `.icon-btn`, `.push-btn`, `.icon-btn-primary`, `.segmented-item`, `.tool-card`, `.home-card`, `.recent-item` |
| **Hover** | What can be clicked wakes: an icon rises a pixel and grows a little, a tool's tile tilts, a card lifts 2 px, a recent file's page tilts under a deeper shadow | `.icon-btn .lucide`, `.tool-card .tool-icon`, `.home-card`, `.recent-item` |
| **A screen arrives** | It fades in from 99 % size. The home's parts and cards rise 8 px one after another, 40 to 50 ms apart | `.shell-main > .home` and the document views, `.home-content`, `.home-cards` |
| **A panel arrives** | The inspector slides in from its own edge: the trailing edge, the leading one in Workbench, mirrored in Arabic. A tool's options rise after it | `.inspector`, `.pane-body` |
| **A tab opens** | It grows into the bar | `.tab` |
| **Something is confirmed** | The HUD's icon pops as it lands; a banner drops 6 px into place | `.toast > .lucide`, `.banner` |
| **Sheets and popovers** | A sheet drops from under the toolbar and leaves the same way. A popover grows out of its trigger and shrinks back into it | `components.css`, `Dialog`, `Popover.tsx` |
| **The phone's inspector sheet** | It rises from the bottom edge and follows a drag on its grabber; released, it springs to where the drag was sending it | `shell/sheetDrag.ts` |

### What moves by itself

Only these loop, and each says something:

- **Work is running.** A button with `aria-busy="true"` carries a sheen that crosses it every 1.3 s, an
  icon with `.spin` turns, and an indeterminate `<progress>` moves.
- **ZOOD's mark catches the light.** A strip of light crosses the mark in the home sidebar every 7 s
  (`.home-brand-icon`). In the Zood look the light falls on the mark's strokes only.
- **An empty place breathes.** The mark where the recent files would be floats 4 px up and down
  (`.recent-empty-mark`).

`components/ZoodMark.tsx` is the brand mark with a loop of its own (`components/zoodMark.css`): asked to
loop, its strokes rise in one after another and a sheen crosses them, again every 6 s. The ZOOD bubble and
the Sort windows use it. Reduce Motion leaves it still.

### Reduce Motion

- Everything in `motion.css` is inside `@media (prefers-reduced-motion: no-preference)`, so the system's
  Reduce Motion takes all of it away.
- Settings › Appearance › Reduce motion does the same from inside the app: `appearance.css` cuts every
  animation and transition to nothing, and `motion.css` names the loops so that they stop still, not on
  a faded frame.
- A scene that moves on a timer must stop the timer too, not only its CSS. `useReducedMotion()` and
  `prefersReducedMotion()` in `components/useReducedMotion.ts` answer for both the system's setting and
  the app's.

### Rules

- Feedback happens on press, with no transition delay on `:active`.
- A thing comes in from where it lives and leaves the way it came.
- Nothing travels that the person did not ask to move. A loop is allowed only for the three reasons above.
- Every new animation goes inside the `no-preference` media query, and every new loop is added to the
  list at the end of `motion.css` that Reduce motion stops.
- A directional move is mirrored in Arabic (see `.tool-card-chevron` and `.inspector`).

## The window

The drawing and the list below describe the layout of every look except Workbench, which has its own
(Looks, above). Since they were written the window has also gained **document tabs** (`shell/TabBar.tsx`):
Settings › Viewing › Tabs puts them above the toolbar, under it, down the side, or on Auto, which moves
them to the side from seven tabs on when the window is at least 1000 px wide (`shell/tabPlace.ts`). The
tabs are not in the drawing.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ZOOD PDF  File  Edit  View  Tools  Help                  (browser only)       │  menu bar
├──────────────────────────────────────────────────────────────────────────────┤
│ (●●●) [▯] Title.pdf          [‹ 3 of 9 ›] [− 91% +]   [✎ ✐][Tool ▾][⌕ ⤓][▯] │  unified toolbar
│           Page 3 of 9 — Edited                                               │
├──────────┬─────────────────────────────────────────────────┬─────────────────┤
│ sidebar  │                 pages on --under-page-background │  inspector      │
│ (source  │                                                  │  header + tool  │
│  list)   │                                                  │  panel          │
└──────────┴─────────────────────────────────────────────────┴─────────────────┘
```

- **Toolbar** (`shell/Toolbar.tsx`, `role="toolbar"`): it replaced the ribbon and the status bar.
  - Leading: the sidebar toggle and the **title block**. The title block holds the file name and a subtitle
    `role="status"` named "Document status", which reads "Page n of m — Edited".
  - Middle: pages and zoom. Zoom reads and sets EmbedPDF's zoom, or Warraq's own in Edit text.
  - Trailing: the markup toolbar, Edit text, the **tool picker** (a popover gallery of all twenty tools;
    the arrow keys move between its tiles, Home and End to the ends), find, save and the inspector.
  - The toggles — the sidebar, find, the markup bar — are pressed exactly while what they show is open,
    in both views: EmbedPDF's own state is followed (`watchToggles`), not read once while drawing.
  - Controls are grouped on glass capsules (`.toolbar-group`).
- **Sidebar** (`LeftPane`): translucent source-list material.
- **Inspector** (`RightPane`, `.inspector`): the tools as a list, or the chosen tool's panel under a header
  with its coloured tile and name. A tool panel's own `<h3>` is hidden there, because the header already
  names it.
- **Home** (`home/`): glass panels over a soft gradient (the owner's design target of 2026-09-25).
  - **The material.** `--home-gradient` is an original CSS gradient (sky, haze, a little green; a deep
    navy in dark) drawn by `.home`; `.glass` panels sit on it with `--glass-panel` at about 52 % and a 1-px
    `--glass-border` (white at 60 % in light, 12 % in dark); cards use `--glass-card`. Increased contrast and
    reduced transparency make every one of them solid. Nothing here is a photograph or anyone else's artwork.
  - **Sidebar** (`HomeSidebar`, `nav` "Home sections"): the app mark, name and tagline; Home, Recents,
    Starred, Tags, and Clouds only in a build that carries a cloud client ID; a Tools heading and all twenty
    tools with their tiles; at the bottom the size of the Library's index on this device — the only storage
    the app has — or a line saying there is none. The place on screen takes the accent.
  - **Top bar**: the search field (`HomeSearch`, a `searchbox` named "Search", ⌘K) and the primary **+**,
    whose menu is Open PDF…, Create PDF…, Scan from file…. The search field really searches: recent files by
    name, and the text of every Library document through the core's own `library.search` when this device
    holds an index (`useLibraryIndex`, read-only). A hit opens its file at the page of the match
    (`pendingPage.ts`, mounted in the shell so the request outlives the home screen). No bell, no avatar:
    there are no accounts.
  - **Hero**: the headline in the interface language («ملفات PDF، من جديد.» / "PDFs, done right.") and six
    action cards (`HeroCards`): Open PDF, Create PDF, Edit PDF, Convert, AI Assistant, More. The first two
    carry the commands' names ("Open…", "Create PDF…"); Edit and Convert choose their tool and ask for the
    file; AI Assistant puts the caret in the assistant's question; More goes to the gallery.
  - **Recents** (`RecentList`): a row of paper cards with the first page's picture, the name, when it was
    opened ("Today, 9:41 AM", "Yesterday, …", a date — `dates.ts`), a ⋯ menu (Open, Star, Remove from
    recents) and ‹ › paging; "See all" is the Recents place, a grid with the drop tile first. Only the name,
    the small picture and the time are kept, on this device, never for a password-protected file.
  - **Starred** (`state/starred.ts`, `StarredView`): a per-device flag. A recent file is starred from its ⋯
    menu; a Library document from the star on a hit or on a chosen document. The view opens each: a Library
    document from where the Library found it, a recent file by asking for it again.
  - **Tags** (`TagsView`): the Library's tags with their counts; one opens the Library tool held to it.
  - **AI Assistant** (`AiCard`, `complementary` "AI Assistant"): docked at the trailing edge, with the chips
    Summarize this document · Explain it simply · Translate · Find the key points · Make a quiz · Draft an
    email from it, and a question. Each chip is one of the AI tool's actions or a question worded for it
    (`ai/request.ts`); a chip opens the tool with the request chosen and asks for the PDF. The card names the
    provider that would receive it, and nothing is sent before the tool's own Send button.
  - The tools as a gallery, and the cloud drives where a build has them.
- **Overlays**:
  - Sheets (`components/Dialog.tsx`).
  - Popovers (`components/Popover.tsx`).
  - The HUD (`.toast`).
  - The drop overlay: a thick material with one card, or two targets when a document is open ("Combine
    with…" / "Open instead"). The target under the pointer lifts and takes the accent.
  - The find bar (Safari's: a capsule search field under the toolbar).

### The macOS app

- **Title bar merged with the toolbar.** `tauri.conf.json` sets `titleBarStyle: "Overlay"`,
  `hiddenTitle: true` and `trafficLightPosition {x: 20, y: 19}`, which centres the traffic lights in the
  52-pt toolbar. The toolbar leaves `--traffic-lights` (84 px) free for them on the left in either reading
  direction.
- **Dragging.** The toolbar is `data-tauri-drag-region="deep"`: it drags the window from anywhere except a
  control, and a double click zooms the window. This needs `core:window:allow-start-dragging`.
- **Menu bar.** The system's own, built in Rust (`apps/desktop/src-tauri/src/menu.rs`) from the page's menu
  model (`shell/menuModel.ts`):
  - It is labelled in the interface language, with the app menu (About, Settings…, Services, Hide, Hide
    Others, Show All, Quit), the system's Cut/Copy/Paste/Select All, Enter Full Screen and the Window menu.
  - Items enable, disable and check as the page's menu does. The model is re-sent on every change. The
    menu is rebuilt only when labels change; otherwise it is updated in place.
  - Undo and Redo are the model's own items, so they reach the document's history. While a text field has
    the focus — EmbedPDF's own fields too, inside its shadow root — they are that field's, enabled by what
    its typing can undo (`shell/typing.ts`); ⌘Z is handled by the page either way.
  - **About** is the page's own sheet, which names the core's version and the engine drawing the pages; the
    system's About panel knew neither and never reached the page.
  - The model is sent again after every item chosen there: the system flips a check item's own mark when it
    is clicked, and the model is the truth.
  - The page's own menu bar is not drawn. Language and appearance are in **Settings… (⌘,)**.
- **Each shortcut runs once.** WebKit gives the page the first look at a key equivalent, and the page calls
  `preventDefault()` on every key it handles, so the menu does not also see it. `shell/shortcutEcho.ts`
  also drops any menu event that echoes a key handled in the last 500 ms.

### Narrow windows

- At 900 px and below, the tool picker shows its icon only and zoom leaves the toolbar. Zoom stays in the
  View menu and on keys.
- At 700 px and below, the inspector becomes a **sheet** from the bottom edge, and the sidebar floats over
  the document. The sheet's **grabber** drags: it follows the finger from where it was taken, resists being
  pulled past its top, and on release goes where the finger was sending it — the momentum projected as a
  scroll's is, then a spring from where it is at the speed it had, which can be taken hold of again
  mid-flight (`shell/sheetDrag.ts`). Its close button does the same for the keyboard. With no tool chosen
  there is no sheet, so View › Tools pane and the inspector button are not offered.
- At 640 px and below (a phone):
  - The toolbar keeps the sidebar, the title, the tool picker and save. Find, Edit text and the markup
    toolbar are in the menus (Edit › Find, Edit › Edit text, View › Markup toolbar).
  - EmbedPDF's floating page field returns, as the way to move between pages.
  - The home's sidebar becomes a strip of place chips at the top (the tools are in the gallery), the action
    cards go two to a row, the recents row becomes a grid of three, and the AI card sits under the content.
  - Nothing ever scrolls sideways.
- On a touch screen (`@media (pointer: coarse)`: a phone, a tablet), whatever the width, every target takes a
  finger: `--control-h` becomes 44 px and `--control-h-small` 36 px, the toolbar is 60 px with 44-px buttons,
  the menu bar's items and menu rows are 44 px, and so are the inspector's action rows and back button. The
  look does not change, only the room around it. `e2e/pwa.spec.ts` fails on any smaller target in the shell.
- Installed from the browser, the app is the web manifest's (`apps/web/public/manifest.webmanifest`): its
  icons are the app icon at 192 and 512 px and a **maskable** version for phones, where the tile fills the
  square and the mark sits in the middle 80 % (`scripts/icon/make_zood_icons.py`).

## Components

| Class / component                               | What it is                                    | Notes                                                                 |
| ----------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| `IconButton` → `.icon-btn`                      | Borderless button, with a plate on hover and press | Toolbar, headers, close boxes. Uses `aria-pressed` for toggles     |
| `IconButton showLabel` → `.icon-btn-labeled`    | Push button (bezelled)                        | Anywhere except a toolbar or menu bar. Disabled keeps the bezel       |
| `.push-btn`                                     | The same bezelled push button, as a class     | Styled in `components.css` and `motion.css`. No component uses the class by name today |
| `variant="primary"` → `.icon-btn-primary`       | The default button, filled with the accent    | One per panel or sheet. Its text is `--accent-contrast`               |
| `.icon-btn-destructive`                         | A button whose label and icon are `--destructive` | A class added to an `IconButton`                                  |
| `.link-btn`                                     | A text button                                 | For example "Clear list" next to a heading                            |
| `.select` (and any `select` in a `.tool-panel`) | Pop-up button, with the double chevron        | `.select-compact` is the small one                                    |
| `.text-input`                                   | Text field, with the accent halo on focus     |                                                                       |
| `input[type=checkbox]`, `input[type=radio]`     | macOS checkbox and radio                      | Drawn with `appearance: none`, so they look the same in every host    |
| `input[type=checkbox].switch`                   | Switch                                        | For on/off settings                                                   |
| `.segmented` > `.segmented-item`                | Segmented control                             | `role="radiogroup"` / `role="radio"` with `aria-checked` (see `settings/controls.tsx`). One Tab stop: the arrow keys move and choose, following the reading direction (`useRadioGroupKeyboard`) |
| `.stepper`                                      | Number field with arrows                      |                                                                       |
| `.tool-panel`                                   | An inspector panel                            | A column with 12-px gaps                                              |
| `fieldset` + `legend` inside `.tool-panel`      | **Grouped inset section**, heading above      | The legend is drawn above the rounded group                           |
| `.tool-actions`                                 | **Action list**                               | Consecutive buttons form one rounded group, divided by hairlines. A primary button stands apart. In `shell/panes.css` |
| `.tool-panel-note`                              | Secondary explanatory text                    | 12 px. In `shell/panes.css`                                           |
| `.field`, `.field-row`                          | Label above a control / a label and a control on one row |                                                            |
| `.field-error`, `.banner`, `.badge`             | Inline error, a notice under the toolbar, a small tag | `.banner-error` and `.badge-warning` are their stronger forms |
| `.spin`                                         | Turns an icon while work runs                 | The hover motion leaves a spinning icon alone                         |
| `.toast`                                        | The HUD: a short confirmation                 | A capsule; its icon pops as it lands                                  |
| `.coming-later`                                 | The notice `tools/ComingLater.tsx` draws      | For a tool not built yet. Every tool in `tools/tools.ts` is built today |
| `Dialog`                                        | Sheet                                         | Focuses the first field, or itself                                    |
| `Popover`                                       | Anchored popover                              | Scales from its trigger, closes on Escape or an outside press, and returns focus |
| `ContextMenu`                                   | The system's context menu at a point          | `role="menu"`, kept inside the window; arrow keys move, Escape or an outside press closes it, focus returns. Organize's pages (Add Page, Delete Page, Extract Pages, Rotate Left, Rotate Right, Replace Page, Crop, Split PDF, Insert from File) and the recents' ⋯ and the home's + use it |
| `ToolIcon`                                      | A tool's glyph on its coloured tile           | Colours are in `tools/ToolIcon.tsx`. A new tool without one gets the accent |

### Adding a tool panel

1. Wrap it in `<div className="tool-panel">` and start with `<h3>` (the inspector hides it).
2. Put a short `.tool-panel-note` first if the tool needs an introduction.
3. Group choices in `<fieldset><legend>…</legend>…</fieldset>`. Put radios and checkboxes as
   `<label><input …/><span>…</span></label>`.
4. Put commands in `<div className="tool-actions">` as `IconButton showLabel`. Make the main action
   `variant="primary"`.
5. Use tokens only, no hard-coded colours, and logical properties only.
6. Look at it in light and dark, in Arabic and English, and at 375 px wide. Look at it in more than one
   look too: Zood, because it is the default, and Workbench, because its layout is its own.

## EmbedPDF

The document view (EmbedPDF 2.15.1) is themed through its own API in `embed/embedTheme.ts`.

- **Colours by reference.** Every theme colour is one of our tokens written as `var(--…)`. Custom
  properties inherit into its shadow root, so the view follows light, dark, contrast and the system accent
  exactly as the window does.
- **A stylesheet in its shadow root** sets the system font, a shadow on each page, radii, and the mode tabs
  drawn as a segmented control.
- **Duplicates removed through its schema.** The sidebar button, zoom and search are taken off its main bar
  (`removeDuplicatedChrome`), because the toolbar has them. Its floating page field is hidden except on a
  phone.
- **The rest of its bar is the markup toolbar.** That is the modes (annotate, shapes, insert, form, redact),
  page settings, pan and the comments panel. It is shown from the toolbar's markup button or **View › Markup
  toolbar** (the only way at phone width, where that button has no room) and hidden by default, as Preview's
  markup toolbar is. Its mode toolbars still appear whenever a tool puts it in a mode.

## The app icon

The app's icon is **ZOOD's own mark** — the owner's brand — exactly as the brand's identity package has
it: the arcs and the swash that make its Z, cut from the Main Logo's Illustrator file (ZOOD New CI, "01.
Logo Design", saved PDF-compatible) into `scripts/icon/zood/zood-mark.svg` with every path as the file
holds it. Nothing is redrawn or traced. (Wave 1's slab Z, an invented letter, and its generator are gone.)

**Copper on navy**, the way the brand carries its mark when it is precious: foil-stamped in copper on the
navy folder (guide p. 28). It is the brand's own pairing rather than a new one — the guide's 40 % navy as
the ground and its 20 % bronze (Pantone 2318 C) as the mark, run from a lit edge to a shaded one as foil
catches the light — and on a Home Screen of white and bright tiles a deep navy square with a warm metal
mark reads at once and reads as ZOOD. Navy on beige (the guide's other pairing) was the alternative; it
was set aside because a pale tile loses the mark's fine arcs at 60 px and looks like every light icon.

- Colours: ground `#0A2A55` → `#041E42` (Pantone 282 C) → `#031631`; copper `#C9A27C` → `#977756`
  (2318 C) → `#7A5C3F`. `MARK_WIDTH` is 60 % of the icon's side; the icon draws the mark at 84 % of that
  (`MARK_SHRINK`), to leave room for the label.
- **The label along the foot.** `make_zood_icons.py` also draws a band of the brand's copper across the
  foot of the icon, 23 % of its height (`BAND`), carrying a pencil and "PDF" in navy: what the app is,
  readable at the size of a home screen. The mark above it is raised to sit in the middle of the space
  left. "PDF" is ZOOD's headline face drawn once into outlines, so the icon needs no
  font.
- **Dark** (`AppIcon-Dark.png`): the same copper, a step brighter, on a deeper navy. **Tinted**
  (`AppIcon-Tinted.png`): one grey ramp on black, which the system colours itself. All three 1024 px, no
  alpha channel.
- The same composition is drawn in the app by `ZoodMark` (`apps/ios/PDFEditor/Design/ZoodMark.swift`) from
  the vector `ZoodMark` in the asset catalogue; `ZoodIcon` there and `MARK_WIDTH` in the generator are the
  same numbers. `ThemeTests.testTheAppIconIsTheMarkOverItsCopperLabel` reads the 120-px icon Xcode puts in
  the app and checks the copper mark on navy over the copper band.
- `scripts/icon/make_zood_icons.py` composes the icons (SVG) and writes the vector PDFs for the asset
  catalogue; `scripts/icon/svg2png.swift` rasterizes (AppKit reads SVG on macOS);
  `scripts/icon/crop_pdf.swift` cut the brand's patterns out of its `.ai` files;
  `scripts/icon/make_zood_icons.sh` writes every derivative at once:

```
./scripts/icon/make_zood_icons.sh
pnpm --filter @warraq/desktop icons        # the Tauri bundle's .icns/.ico, which the script does not write
```

What it writes:

| Where | What |
| ----- | ---- |
| `apps/ios/…/AppIcon.appiconset/AppIcon.png`, `-Dark.png`, `-Tinted.png` | the iOS icon in its three appearances; full-bleed squares with no alpha channel |
| `apps/ios/…/Assets.xcassets/ZoodMark`, `ZoodLogoMain`, `ZoodLogoVertical`, `ZoodLogoHorizontal` | the mark and the three logos, vector PDFs (Preserve Vector Data, template) |
| `apps/ios/…/Assets.xcassets/ZoodPattern01`, `02`, `03` | the brand's three graphical elements, vectors from its package |
| `apps/desktop/icon.svg`, `packages/ui/public/app-icon.svg`, `apps/web/public/favicon.svg` | the continuous-corner tile |
| `apps/web/public/icons/*.png` | 192 and 512, the maskable pair, and the 180-px apple-touch icon |
| `apps/extension/icons/icon{16,32,48,128}.png` | the browser extension |

The web app's `theme-color` and the manifest's `theme_color` are ZOOD's navy (`#041e42`).

The logo, mark and patterns are ZOOD's trademarks and artwork, in the repository at the owner's request and
not under its licence (THIRD-PARTY-NOTICES.md).

## The iOS themes

`apps/ios/PDFEditor/Design/Themes.swift` (the themes) and `Design/Brand.swift` (ZOOD's palette, type, logo
and pattern) add a **theme** beside the language and appearance settings. It is a layer over the tokens in
`Theme.swift`: every screen still asks for `Surface.label`, `Space` and `Radius`. Every theme follows the
system's Light and Dark (or the appearance chosen in Settings). **Zood is the theme a person sees first**
(`AppTheme.standard` in `Themes.swift`). These are three themes of the iPhone and iPad app; the 13 looks
above belong to the shared interface and are not in it.

| Theme | What it is | Where it stops |
| ----- | ---------- | -------------- |
| **System** | what the app looked like before: the system's materials and the person's own accent | — |
| **Liquid Glass** | the system's own glass (`.glassEffect(.regular, in:)`) on the **navigation and control layer only** — the markup and edit bars, the floating pen palette; the navigation, tool and tab bars are the system's own, which iOS 26 already makes glass. The content — pages, the home's cards, lists, sheets' rows — is solid on the system's own grouped ground, in the system's accent: legibility first, no tint of its own | `.glassEffect` is iOS 26; below it the bars are the system's `.bar` material, and Settings says so |
| **Zood** | ZOOD's identity, below | opaque by design |

**What the glass theme dropped from wave 1**: the sky-to-violet gradient ground (it fought the documents
for attention, and Apple's glass does not need a coloured ground — content scrolls under it), the glass on
the home's cards and on every sheet's rows (content is never glass), the white highlight and the white
hairlines (the system's glass draws its own edge).

**Zood**, from the guide and the identity package:

- **Palette, in its proportions** (guide p. 9): navy Pantone 282 C `#041E42` dominant — the type on paper,
  the ground in dark, the plates of the tool tiles, the logo; beige 482 C at 60 % `#D6C6B8` as the paper,
  with its 60 % tint `#E6DDD4` as the light ground and `#F5F1ED` (the beige at a quarter, the envelope's
  stock, p. 30) for cards; bronze 2318 C `#977756` as the accent — the copper glyphs, the hairline edges,
  the tint; light blue 291 C `#A7C6ED` sparingly — only as the frosted pattern on the navy. The tints are
  the guide's 95/85/60 % toward white. Two steps are the app's own, because the guide's bronze does not reach
  4.5:1 as text on either ground: `#73563A` (a darker bronze) on the paper and `#AE8B66` (a lighter one) on
  the navy. **Light** = beige paper, navy type, copper accents; **dark** = navy ground, beige type, copper
  accents.
- **Contrast**: every text colour on every surface it is drawn on is at least 4.5:1, and white on the
  deep bronze and navy on the light one (a filled button) too — `ThemeTests.testEveryTextOnZoodsGroundsPassesAA`.
- **The colours reach every screen through the theme.** `Surface.label`, `secondaryLabel`, `grouped` …
  are dynamic colours that read the theme from a UIKit trait bridged to `\.appTheme`
  (`AppThemeKey: UITraitBridgedEnvironmentKey`), so a screen that asks for `Surface.label` gets navy on the
  paper without knowing about themes (`testTheSurfaceTokensTakeZoodsColoursThroughTheTraits`).
- **Type.** Headlines in **ITF Huwiya Arabic** — the face ZOOD bought (Light at display sizes, Regular
  below), which has its own Latin. Body copy in **Vazirmatn** (OFL), Arabic and Latin, as the guide sets it.
  `BrandType` in `Brand.swift` is the one place either is named; `.themeFont(_:)` (a `TypeRole`) gives a
  text the theme's face, and `ThemeTypeface` makes Vazirmatn the default for text that names none.
  Dynamic Type applies (`Font.custom(_:size:relativeTo:)`).
- **Huwiya is never in the repository.** It is a commercial font: put its `.ttf` files in
  `apps/ios/PDFEditor/Resources/LicensedFonts/` (ignored by version control) and the next build bundles
  and registers them. Without them — a clean checkout, CI — the headlines are Vazirmatn Light, and the build
  is otherwise identical (`testZoodsFacesAreInTheAppAndTheHeadlineFallsBackHonestly`). Both faces shape
  Arabic with no fallback and no missing glyph (`testBothFacesShapeArabicAndCarryLatin`).
- **The logo** (`ZoodLogo`): the Vertical logo on the welcome tour's first screen, the Main logo in
  Settings › About, both themes and the system theme alike — the app is ZOOD's. Never stretched (the
  artwork's own proportions); the guide gives no clear space, so the app keeps a quarter of the mark's
  height clear all round. Elsewhere the mark alone, as the icon (`ZoodMark`).
- **The graphical element** (`ZoodPattern`): the brand's own vectors. The woven Pattern 02 is a frosted
  texture — navy at 7 % on the paper, light blue at 13 % on the navy — in the home screen's hero, in the
  part the words do not use (a band along the top on a phone, the trailing third on an iPad); Pattern 01
  (three lines, two bending) over the logo on the welcome tour. Never behind text, and gone under Increase
  Contrast.
- **Iconography**: the brand's own icons are wayfinding pictograms (washrooms, lifts, prayer rooms) with
  nothing to say in a PDF editor, so they are not used; the app keeps SF Symbols, set at a light weight on
  this theme to sit with the guide's thin single-weight line (p. 16).
- **Bars**: the navigation and bottom bars take the theme's ground; the markup and edit bars its navy.

**Accessibility, every theme.** **Reduce Transparency** makes every surface solid. **Increase Contrast**
makes the glass theme's bars solid, firms every edge, and removes ZOOD's texture. **Reduce Motion** loses
nothing: no theme moves anything, and a theme change cross-fades (`Motion.quick`).

- **Where it is applied:** the home screen (hero, cards, rows), the Library's sidebar and grids, every
  sheet's body (`AppSheet`), the navigation and bottom bars, the markup and edit bars and the pen palette,
  the welcome tour, Settings. The entry points are `themedGround()`, `themedCard()`, `themedBar()`,
  `themedSurface(_:in:)`, `themedScrollBackground()`, `themedToolbar()`, `themeFont(_:)` and
  `.buttonStyle(.themedProminent)`.
- **Not themed in type**: a sheet or tool that sets `TextStyle.*` itself keeps the system face on the Zood
  theme (its colours still follow); only text that names no font, and the screens above, take Vazirmatn.
- **Chosen and kept** in Settings › Interface, applied at once and kept in `UserDefaults` under `theme`.
  A UI test passes `-theme glass`.
- **RTL**: the logo is not mirrored (a logo is never flipped); the pattern and every layout follow the
  reading direction.

## Screenshots

`docs/design/screenshots/` holds the shots below. **They are old**: the files were last changed between
2026-09-18 and 2026-09-25, before the looks, the motion and the tabs, so they show the interface as it was
then, in what is now the Liquid Glass look. They are taken from the production build by an opt-in
Playwright spec, and running it again would replace them:

```
pnpm --filter @warraq/web build
WARRAQ_SCREENSHOTS=1 pnpm --filter @warraq/web exec playwright test e2e/design-screenshots.spec.ts
```

- `home-en-light`, `home-ar-dark`: the home screen; `home-search-en-light`: the search field with results;
  `home-starred-ar-dark`: the Starred place; `home-tools-ar-light`: the tools gallery.
- `organize-menu-en-light`: a page's context menu in Organize.
- `document-en-light`, `document-ar-light`, `document-ar-dark`: a document open.
- `gallery-en-light`, `gallery-ar-dark`: the tool picker's gallery, as it was (there are twenty tools now).
- `inspector-organize-en-light`, `inspector-compress-en-dark`: the inspector.
- `sheet-goto-en-light`, `about-en-dark`, `settings-ar-light`: sheets.
- `drop-overlay-ar-light`: the split drop overlay.
- `phone-home-ar-light`, `phone-document-en-light`, `phone-sheet-ar-light`,
  `tablet-document-ar-dark`: narrow widths.
- `cloud-home-en-light`, `cloud-home-ar-dark`, `cloud-signin-en-light`, `cloud-browse-en-light`,
  `cloud-browse-ar-dark`, `cloud-conflict-en-light`, `cloud-phone-home-en-light`: the cloud drives.
  They come from a build that carries a client ID (the default build has none), so the cloud spec
  takes them: `WARRAQ_SCREENSHOTS=1 pnpm --filter @warraq/web exec playwright test e2e/cloud.spec.ts`.

The macOS app itself (traffic lights, the system menu bar) cannot be screenshotted headlessly. Its
configuration is pinned by `apps/desktop/src-tauri/tests/desktop_contract.rs` and `src/menu.rs`'s tests.
