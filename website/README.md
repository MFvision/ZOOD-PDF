# ZOOD PDF website

The public landing site for ZOOD PDF (زود PDF): one long page that tells the
story as you scroll, plus Privacy, Terms and Support pages, in Arabic (default)
and English. Plain HTML, CSS and JavaScript modules: no framework, no build
step, no cookies, no analytics, no third-party requests.

```
index.html, en/index.html            the story (Arabic at /, English at /en/)
privacy/, terms/, support/ (+ en/)   the legal pages
css/site.css                         all styles: colours, layout, motion rules
js/story.js                          EVERY word of the story, both languages, each
                                     chapter's stage numbers, devices and screens
js/legal.js                          every word of the legal pages
js/main.js                           renders the page and runs the scroll loop
js/desk.js                           the desk scene (pages, actions, device frames)
js/desk-arabic.js                    generated: the Arabic sample lines as outlines
assets/<lang>/<device>/NN-name-<theme>.webp   app screens
assets/fonts/                        Vazirmatn and Inter (SIL OFL 1.1)
assets/fonts/licensed/               ITF Huwiya Arabic (NOT in git, see Fonts)
assets/brand/                        ZOOD logo (logo-ar/en.svg), mark, pattern, app icons
assets/og/                           social preview pictures
Caddyfile, Dockerfile                hosting
tools/                               scripts that regenerate assets and run QA
```

## Edit the words

Open `js/story.js`. Every piece of text is an object with `ar` and `en`:

```js
title: { ar: 'ملفات PDF، [[من جديد]].', en: 'PDFs, [[done right]].' },
```

The phrase in `[[ ]]` gets the bronze band. A chapter has at most three
`points`. Keep both languages saying the same thing. The legal pages are in
`js/legal.js`; `{{entity}}`, `{{email}}` and `{{phone}}` come from `CONTACT` at
the top, the same details the app shows in Settings › About. Anything else in
`{{double braces}}` shows highlighted as a placeholder.

Only claim what `docs/feature-matrix.md` marks ✅. Partial (🟡) and planned (⬜)
work stays off the site until it works: the owner wants nothing shown as
"coming soon". The page titles and
descriptions that search engines read live in the small HTML files; after
changing the hero title or lead, or a legal page's title, run
`node website/tools/make-shells.mjs` from the repository root.

## Add a chapter

1. Add one entry to `CHAPTERS` in `js/story.js`, where it should appear:

   ```js
   {
     id: 'compare',                                  // the #anchor
     stage: { pages: 2, fan: 0.3, recede: 0.5 },     // pose of the desk
     act: { turn: [0.1, 0.6] },                      // optional actions, [start, end] of the chapter
     devices: [{ frame: 'desktop', screen: 'compare' }],
     eyebrow: { ar: 'المقارنة', en: 'Compare' },
     title: { ar: '…[[…]]…', en: '…[[…]]…' },
     points: [{ ar: '…', en: '…' }],
   },
   ```

2. Add the screen: a file name in `SCREENS.files` and a description in
   `SCREENS.alt` (what a screen reader hears), then put the pictures at
   `assets/ar/desktop/12-compare-light.webp`, `…-dark.webp`, and the same
   under `assets/en/`.

Stage numbers: `pages` 1 to 5, `fan` 0 (stacked) to 1 (arc), `recede` 0 to 1
(pages step back so the devices lead), `dusk` 0 to 1 (the desk turns navy),
`pattern` and `frame` 0 or 1. Actions (each 0 to 1 across its range): `turn`,
`flow`, `find`, `reflow`, `mark`, `order`, `merge`, `thin`, `sign`, `redact`,
`scan`. End an action by 0.78 of its chapter: the last fifth is the hand-over
to the next chapter. Frames: `phone`, `tablet`, `desktop`, `browser`.

## Downloads

`DOWNLOADS` in `js/story.js`: a button with `href: null` reads "Coming soon".
Put the link in to make it live. `PLATFORMS` holds each platform's status line.

## Screens

The screens are taken from the real web app in its Zood look (Settings, Theme,
Zood). That look is on the `windows-build` branch (the Windows pilot), so build
the web app from a checkout of that branch. From the repository root:

```sh
git worktree add ../zood-wb origin/windows-build
(cd ../zood-wb && pnpm install && pnpm build:core && pnpm --filter @warraq/web build)
(cd ../zood-wb/apps/web && npx vite preview --host 127.0.0.1 --port 4391) &
python3 -m pip install pillow
node website/tools/make-samples.mjs                 # invented sample PDFs
node website/tools/capture-screens.mjs              # or: … redact, phone, phone:sign
```

Each screen shows a tool's finished work on an invented sample. Phone screens
hide the desktop-style menu row and get a plain status bar, and the home
screen hides its own tool count. The AI screen runs the app's panel on the
stand-in engine its browser tests use (`apps/web/e2e/deviceStub.ts`); only the
model's words are written by the script.

The chapters' devices also play a short looping video of the tool at work
(WebM, or MP4 where WebM does not play, beside each picture), shown over the picture once
it plays; with Reduce Motion or Save Data the picture stays. Record them with
`node website/tools/capture-screens.mjs --clips` (needs ffmpeg). A drawn
pointer shows where the mouse or finger is.

Replace any picture with a marketing screenshot by saving it under the same
name and size (phone 640 × 1386, tablet 1600 × 1200, desktop and browser
1600 × 1000, WebP quality about 80).

## Fonts

Body text is Vazirmatn (Arabic) and Inter (English), self-hosted. Arabic
headlines use **ITF Huwiya Arabic**, ZOOD's licensed font. The repository is
public, so its files are git-ignored: before deploying, put
`huwiya-medium.woff2` in `assets/fonts/licensed/` (make it from the .ttf with
`pyftsubset ItfHuwiyaArabic-Medium.ttf --unicodes="U+0020-0040,U+005B-0060,U+007B-007E,U+00A0,U+00AB,U+00BB,U+0600-06FF,U+200C-200F,U+FB50-FDFF,U+FE70-FEFF" --layout-features='*' --flavor=woff2 --output-file=huwiya-medium.woff2`).
Without it, set `licensedHeadlineFont: false` in `js/story.js` and the
headlines use Vazirmatn.

## Run it locally

```sh
node website/tools/serve.mjs 8080      # http://127.0.0.1:8080, same headers as production
```

## Host it

Any static host with HTTPS works; serve the folder at the domain's root.

**Hostinger** (or any Apache or LiteSpeed host): run `sh website/tools/pack.sh`
on the Mac that has the licensed font in `assets/fonts/licensed/`. It makes
`website/zood-pdf-site.zip` with only what the site serves, `.htaccess`
included (HTTPS redirect, the same security headers and caching as the
Caddyfile). In hPanel, point `pdf.zood.sa` at a folder, turn on its free SSL,
open File Manager there, upload the zip and extract it so `index.html` sits at
the top. The zip carries the licensed font: keep it private.

**Caddy in Docker** (certificates are automatic):

```sh
docker build -t zood-pdf-site website/
docker run -d -p 80:80 -p 443:443 -v caddy_data:/data zood-pdf-site
```

The `Caddyfile` sets the domain (`pdf.zood.sa`, override with
`SITE_ADDRESS`), compression, a week's caching for pictures and fonts,
revalidation of HTML, JS and CSS on every visit, and the security headers
(nosniff, no referrer to other sites, no framing, HSTS, a content security policy that allows
nothing outside the site). For auto-deploy on push, have the server pull the
`app` branch and rebuild the image, or push the image from a GitHub Actions
workflow to the server; the licensed font has to be added on the server side.

## The opening, the pattern and the ring

- `js/gather.js`: at load, at the top of the page, loose papers settle onto the
  desk's stack, which then wears the ZOOD PDF mark (it fades once you scroll).
  With Reduce Motion the page opens on the finished stack.
- `js/drip.js`: the ZOOD pattern runs down the page like paint, each narrow
  column at its own speed, while a chapter plays; it slides off as the next
  chapter begins. With Reduce Motion it simply stands.
- `js/ring.js`: the tool ring chapter (`kind: 'ring'` in `js/story.js`), drawn
  after the app's own ring (`packages/ui/src/quick/Ring.tsx`, `ringGeometry.ts`,
  `plan.ts`) and played by the scroll: files dragged out of a folder with Ctrl,
  the ring opening, Compress picked, the progress, the results beside the
  originals. The ring's tools follow `plan.ts`; programs' names are shown as the
  files they make (docx, xlsx, pptx). The icons in `js/ring-icons.js` are
  Lucide's, generated from the app's `lucide-react`. Claim only what the
  Windows build does: keep the note's "Windows" until the Mac ring is tested.
- The glass rooms, each a chapter `kind` in `js/story.js` and a module with a
  `scene` (markup) and a `frame(el, p, reduced)` the scroll calls, `p` 0-1
  across the room (`ROOMS` in `js/main.js`; shared helpers in `js/motion.js`):
  `js/ai-room.js` (a question typed into a glass card, the answer fanning out
  with its pages, then the app's own AI recording), `js/library.js` (a shelf of
  files, a word typed, the matches lit, one turning to show its page and tag;
  drawn, not recorded), `js/phone-room.js` (the phone turning to face you while
  glass cards for scanning, the widget and a shortcut slide out and are
  pressed, each bringing up the app's own screen) and `js/family.js` (every
  version together, after the concept the app was designed from: the pen
  writing on the iPad, the phone scanning, the assistant's suggestions) and
  `js/remote.js` (the desktop app's phone remote beside a computer: one quick
  beat each for the laser, highlighting, pages, the mouse, the keyboard, any
  slideshow and the volume, files both ways and a signature; labels jump to
  each beat, and the drawn phone answers the visitor's pointer and presses;
  drawn, not recorded).
  Their look is the app's liquid glass (`packages/ui/src/styles/looks.css`).
- `js/film.js`: the 30-second film after the opening. It plays without sound
  while on screen and pauses when it leaves; a button turns the sound on. With
  Reduce Motion or Save Data it waits on its poster. Screens up to 760px wide
  get the 720p copy (`film-<lang>-720.*`).
- `js/fabric.js`: the download button, a velvet cushion drawn in SVG and lit
  by an SVG filter. It swells toward the pointer and squeezes when pressed;
  blue in the dark theme, navy in the light one. Still with Reduce Motion.
- `js/foldable.js`, `js/foldable-copy.js`, `css/foldable.css`: the iPhone Duo
  page (`/iphone-duo/`), an Apple-style white gallery. The device is drawn in
  CSS 3D (`js/fold-device.js`): it turns and unfolds as the hero scrolls; the
  highlights carousel shows it folded (iPhone screens) or open (iPad screens).
  `js/fold-room.js` is its small section on the home page. Check it with
  `node website/tools/qa-foldable.mjs`.
- `js/page-morph.js`: moving between pages, the pages cross-fade and the top
  bar stays put (`@view-transition` in `css/site.css`); between the home page
  and the iPhone Duo page the phone carries across. The shells load
  `js/main.js` with `blocking="render"` so the new page is built before the
  transition, and set the referrer policy to same-origin, which the browser
  needs to tell the script which page it came from. Off with Reduce Motion.
- Privacy, platforms and downloads: the privacy frame closes in around the
  page and its lock shuts; the platform and download rows follow their card
  in, one after another.
- `js/ask-room.js`: Ask ZOOD in three acts. One tap: the screen's edges glow
  with the voice, the island grows out of the notch, listens, and makes a file
  smaller with a one-line answer. Two taps in an email: it reads the window
  and writes the reply word by word ("Nothing was sent"). Then "Coming up"
  slides in. Drawn, with the app's own words (`packages/ui/src/ask`).
- `js/helper-room.js`: the AI panel's Chat tab with no file open. "Organize
  my Downloads" shows the plan, the loose files fly into their folders, with
  Undo; "How do I save this as docx?" offers Show me, and ZOOD's glowing
  pointer flies to Export and opens it.
- `js/tour-room.js`: the welcome tour, drawn: its eight chapters tick off one
  by one as you scroll (`packages/ui/src/tour`).
- The phone room also shows the iPhone's tabs, "Open with" and the five app
  icons (`assets/brand/icons/`, from the iOS app's icon previews); the remote
  room has a Flick beat: a file goes up off the phone in a glow and a wave of
  light and lands on the computer's desktop, then one comes back.
- `js/interact.js`: a ring of light from where a button or switch is pressed;
  the press and spring are in `css/site.css`. Off with Reduce Motion.

## Motion, for whoever changes it

One `requestAnimationFrame` loop (in `js/main.js`), started by scroll and
resize events, reads the scroll position and writes CSS custom properties on
the stage; `css/site.css` turns them into `transform` and `opacity`. Do not
replace this with CSS scroll-driven animations (`animation-timeline`,
`view-timeline`): on the reference site they froze in Safari 26 and in Chrome
on Windows. The dock and the stage are `position: fixed` with `svh`/`lvh`
sizes, so the devices do not move when a phone's address bar collapses.
With Reduce Motion on (Windows "Animation effects" off sets it in Chrome),
nothing glides: the stage and screens swap at the same scroll points.

## QA

`node website/tools/qa.mjs <out-dir> [--video]` runs every size (375, 390,
430, 820, 1280, 1440, 1920) × Arabic and English × light and dark × Reduce
Motion on and off in Chromium. It checks sideways overflow, console errors,
that the device dock never moves, that each chapter's stage and actions are
reached, that the wall's phone shows every screen exactly aligned, and that
the language switch keeps your place; it writes a contact sheet per run and,
with `--video`, scroll recordings. Real devices still need a person: iPhone
Safari, Mac Safari, Windows Chrome and Edge (Animation effects on and off),
Android Chrome and desktop Firefox.

## Regenerating other assets

- `tools/arabic-outlines.py`: the desk's Arabic lines (needs `fonttools uharfbuzz`).
- `tools/make-og.mjs`: the social preview pictures.
- `tools/make-shells.mjs`: the HTML files.
- `tools/promo/make.mjs`: the film, `assets/film/film-<lang>.mp4`, `.webm` and
  the `.webp` poster (needs ffmpeg; `CHROMIUM=<path>` picks the browser). The
  scenes are `tools/promo/promo.js`, drawn around the app's own recordings;
  the music is made from plain waves by `tools/promo/music.mjs`, so it is ours.
  `--at=4,12.5` writes stills of those seconds to check a scene.
- Fonts: `pyftsubset` from `tests/fonts/Vazirmatn-Variable.ttf` and
  `packages/ui/public/fonts/Inter-Variable.ttf`.
