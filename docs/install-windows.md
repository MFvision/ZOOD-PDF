# محرر PDF on Windows

Three ways, from easiest to most work.

## 1. The browser version (nothing to build)

The web app is the same interface and the same engine as the desktop app; only
the native window, the system menu bar and printing through macOS differ.

1. Copy the `محرر PDF - browser` folder (or its zip) to the Windows computer.
2. Double-click **`Start on Windows.cmd`**. The browser opens `http://localhost:8080`.
3. Close the command window to stop it.

It needs Node.js or Python on that machine; if neither is there, install Node.js
(LTS) from <https://nodejs.org> and run the file again. In Chrome or Edge, the
address bar then offers **Install**: the app gets a Start-menu icon, opens in its
own window and works offline (the service worker keeps the app's own files —
never a document).

To make that folder yourself:

```bash
pnpm --filter @warraq/web build     # writes apps/web/dist
```

Serve `apps/web/dist` with any static server. No special headers are needed.

## 2. The browser extension

`pnpm --filter @warraq/extension build` writes `apps/extension/dist` and a zip
beside it. In Chrome or Edge: `chrome://extensions` → **Developer mode** →
**Load unpacked** → choose `apps/extension/dist`. A PDF then opens with
**Open with محرر PDF** in the right-click menu.

## 3. The Windows desktop app (built on Windows)

It **cannot be cross-built on a Mac**: `ring`, `tauri-winres` and WebView2 need
the Windows SDK, `llvm-rc` and `link.exe`. Build it on the Windows machine, or
let GitHub build it.

### On the Windows machine

Install first:

* [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/)
  with **Desktop development with C++** (that brings the Windows SDK and `link.exe`),
* [Rust](https://rustup.rs) (stable, `x86_64-pc-windows-msvc`),
* [Node.js 22 LTS](https://nodejs.org) and `corepack enable` for pnpm,
* [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
  (already present on Windows 11 and up-to-date Windows 10).

Then, in the repository:

```powershell
pnpm install --frozen-lockfile
pnpm --dir apps/desktop exec tauri build
```

The installer lands in
`apps/desktop\src-tauri\target\release\bundle\nsis\` as an `.exe`. Windows builds
make the NSIS installer only: WiX (the MSI builder) writes in a code page that
has no Arabic, so it cannot carry the app's name, محرر PDF.

### Or let GitHub build it

`.github/workflows/desktop-windows.yml` builds the installer on a Windows
runner: **Actions → desktop (Windows) → Run workflow**, then download the
`warraq-windows-installer` artifact. It also runs on a `v*` tag. This needs the
repository to be on GitHub, which is still an owner decision (`docs/STATUS.md`).

### What differs from the Mac app

* **Rendering:** the Mac app bundles PDFium; the Windows build does not, so the
  host uses محرر PDF's own Rust renderer (`apps/desktop/README.md`). The document
  view itself is PDFium either way — it runs as WebAssembly inside the webview.
* **Printing:** macOS prints through PDFKit; Windows prints the pages as images
  at 300 dpi through the webview's print dialog. Neither has been run on Windows
  by the people who wrote it (`docs/STATUS.md`).
* **Signing:** the installer is unsigned, so SmartScreen warns on first run
  (More info → Run anyway).
