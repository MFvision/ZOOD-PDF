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

## What gets installed

One self-contained `Warraq.app`. The UI is compiled into the executable, so the
bundle does not read anything from the source tree and the repository can be
moved or deleted afterwards.

```
Warraq.app/Contents/
  MacOS/warraq-desktop            the Rust host and the whole core
  Resources/icon.icns
  Resources/resources/pdfium/     libpdfium.dylib + its licences
```

PDFium is the rasterizer on desktop (ADR-0003, narrowed by ADR-0006). If the
library cannot be bound at startup the host falls back to the pure-Rust hayro
backend rather than failing, and reports which engine it got.

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
rm -rf /Applications/Warraq.app
rm -rf ~/Library/WebKit/app.warraq.desktop
rm -rf "$HOME/Library/Application Support/app.warraq.desktop"
```

Warraq keeps no other state: no preferences daemon, no login item, no
background helper, no telemetry.
