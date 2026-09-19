# Installing Warraq on macOS

Warraq has no installer to download, because there is nothing to download it
from: the project is not notarised, not on the App Store, and has no release
server. On macOS you build it on the machine that will run it. The whole
process is local — no account, no sign-in, nothing leaves the Mac.

```sh
./scripts/install-macos.sh            # builds, then installs into /Applications
./scripts/install-macos.sh ~/Applications
```

`WARRAQ_SKIP_BUILD=1` installs a bundle that is already built.

## Requirements

| | |
| --- | --- |
| macOS | 11 or newer (`bundle.macOS.minimumSystemVersion`) |
| Architecture | Apple Silicon or Intel — the build targets the host, not both |
| Xcode command line tools | for the linker and the macOS SDK |
| Rust | the toolchain pinned in `rust-toolchain.toml` |
| Node | 22 or newer, with pnpm |

WebKit comes from the system, so unlike the Windows host there is no runtime to
install alongside the app.

## Building it yourself, without the script

Use `tauri build`, not `cargo build`. A bare `cargo build --release` leaves the
`custom-protocol` feature off, and `tauri` then compiles in dev mode: the app it
produces navigates to the dev server named in `build.devUrl` instead of the
interface compiled into it, so it opens an empty window on any machine where
that server is not running. `cargo build --release --features custom-protocol`
is the equivalent if you need cargo directly.

## What gets installed

One self-contained `محرر PDF.app`. The UI is compiled into the executable, so the
bundle does not read anything from the source tree and the repository can be
moved or deleted afterwards.

```
محرر PDF.app/Contents/
  MacOS/warraq-desktop            the Rust host and the whole core
  Resources/icon.icns
  Resources/resources/pdfium/     libpdfium.dylib + its licences
```

PDFium is the rasterizer on desktop (ADR-0003, narrowed by ADR-0006). If the
library cannot be bound at startup the host falls back to the pure-Rust hayro
backend rather than failing, and reports which engine it got.

## Opening a PDF

Three ways, all local:

* **File → Open**, the toolbar button, or ⌘O — the native open panel.
* **Drag a PDF onto the window.**
* **`/Applications/محرر PDF.app/Contents/MacOS/warraq-desktop report.pdf`** from a
  terminal. Double-clicking a PDF in Finder does *not* open Warraq yet: the
  bundle claims no document types, which is a deliberate omission — an editor
  should not take over the system PDF handler without being asked.

Only files you choose this way are readable. The open panel, the save panel and
a drop each add that one path to the host's file scope; nothing else on the
disk is reachable from the interface.

`WARRAQ_DEBUG=1` makes the host print what the interface asked the core to do
(`opened #1, 116722 bytes, 3 page(s)`), which is how the desktop build is
smoke-tested without a person at the screen.

## Signing

The build is signed ad hoc — that is what the linker does on Apple Silicon, and
it is enough for the app to launch on the machine that built it. It is *not* a
Developer ID signature, so the bundle is not notarised and will not pass
Gatekeeper if you copy it to another Mac; that one would refuse to open it
until the user cleared the quarantine flag by hand. Signing and notarising for
distribution needs a paid Apple Developer account and is a release decision,
not an installation step.

## Uninstalling

```sh
rm -rf /Applications/محرر PDF.app
rm -rf ~/Library/WebKit/app.warraq.desktop
rm -rf "$HOME/Library/Application Support/app.warraq.desktop"
```

Warraq keeps no other state: no preferences daemon, no login item, no
background helper, no telemetry.
