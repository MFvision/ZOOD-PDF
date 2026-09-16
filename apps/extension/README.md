# `@warraq/extension` — Manifest V3 extension

One build for Chrome, Edge and Brave. The extension mounts the shared `@warraq/ui` `<App/>` in
`viewer.html`; the UI's Web Worker and the WASM core are bundled as extension files, so nothing is loaded from
the network and the extension CSP stays at `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.

```
apps/extension/
├── manifest.json            # MV3; permissions: contextMenus, storage, offscreen; no host permissions
├── background.js            # service worker: context menu "Open with Warraq" + toolbar button → viewer.html
├── viewer.html              # Vite entry; mounts <App/> from src/viewer.tsx
├── src/viewer.tsx
├── _locales/{ar,en}/messages.json   # default_locale "ar"
├── icons/                   # PNGs derived from ../desktop/icon.svg
├── scripts/postbuild.mjs    # copies the static files into dist/ and writes dist/warraq-extension.zip
├── scripts/check-manifest.mjs       # required keys, minimal permissions, CSP, locales, no inline scripts
├── scripts/pack-chrome.mjs  # Chrome headless --pack-extension on a copy of dist/ (Chrome's own validation)
└── vite.config.ts
```

## Build, validate, load

```bash
pnpm install
pnpm build:core                              # optional: without it the UI falls back to its mock core
pnpm --filter @warraq/extension build        # → dist/ and dist/warraq-extension.zip
pnpm --filter @warraq/extension check        # check-manifest on dist/manifest.json + Chrome --pack-extension
pnpm --filter @warraq/extension lint         # tsc --noEmit + check-manifest on the source manifest
```

Load it unpacked: `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`) → _Developer
mode_ → _Load unpacked_ → `apps/extension/dist`. Then right-click any page or link → **Open with Warraq**, or
click the toolbar button. `dist/warraq-extension.zip` is the file to upload to the Chrome Web Store and Edge
Add-ons; Brave installs from the Chrome Web Store.

`pack-chrome.mjs` finds Chrome on its own (macOS app path, `google-chrome`, `chromium`, …) or uses `$CHROME_BIN`.
Chrome prints `ERROR … Could not load …` and writes no `.crx` when the manifest is invalid, which is what the
script checks (Chrome itself exits 0 either way).

## What Phase 1 does and does not do — read this before filing bugs

- **No PDF interception.** Navigating to a PDF still opens the browser's built-in viewer. Intercepting PDF
  navigations and `file://` access (which needs the `file://` host permission and the user's "Allow access to
  file URLs" toggle) are **Phase 7**. Today the context-menu item only opens the viewer; the page or link URL is
  passed as `?src=` for that phase, but it is _not_ fetched — there are no host permissions, and the viewer
  offers the UI's own file picker instead.
- `offscreen` is declared because the architecture runs the core in an offscreen document from Phase 7 on
  (`docs/architecture.md`, "One UI"); in Phase 1 the core runs in the viewer page's own Web Worker. `storage` is
  for the UI's settings.
- **Chrome and Edge on iOS have no extensions** (Apple's WebKit-only rule): iPhone/iPad users get the web host
  (`apps/web`) and later the native iOS shell, not this package.
- **Safari needs separate packaging**: a Safari Web Extension is an Xcode project built with
  `xcrun safari-web-extension-converter apps/extension/dist`, signed and distributed through the App Store.
  This package produces nothing for Safari today.
- Firefox is not targeted in Phase 1 (`background.service_worker` and `offscreen` are Chromium-only).

## Manifest rules enforced by `check-manifest.mjs`

`manifest_version: 3`, `name: "Warraq"`, a dotted-integer `version`, `default_locale: "ar"` with every
`__MSG_…__` present in `_locales/ar/messages.json`, exactly the permissions `contextMenus`, `storage`,
`offscreen`, no `host_permissions` / `content_scripts` / `web_accessible_resources`, the CSP above verbatim, all
icons and the service worker present, and `viewer.html` without inline scripts or handlers (the CSP would block
them). Bump `version` in `manifest.json` for every store upload; `release.yml` checks it against the tag.
