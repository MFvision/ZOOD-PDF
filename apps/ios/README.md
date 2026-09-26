# ZOOD PDF for iPhone and iPad (زود PDF)

Native SwiftUI app, iOS/iPadOS 18+, Swift 6 language mode with complete strict concurrency.
It uses the same Rust engine as the web and desktop apps (`warraq-core`, C ABI in
`packages/core/crates/warraq-core/include/warraq.h`), linked as `Frameworks/WarraqCore.xcframework`.
No third-party Swift packages; system frameworks only (SwiftUI, PDFKit, PencilKit, VisionKit, Vision,
AVFoundation, Core Image, WidgetKit, App Intents, Core Spotlight).

## Build on a Mac

Needs macOS with **Xcode 26+**, Rust (`rustup`), and XcodeGen.

```bash
brew install xcodegen
bash scripts/ios/build.sh          # engine XCFramework → xcodegen → build + test on simulators → screenshots
```

What `build.sh` does:

1. `scripts/ios/build-core.sh` builds `warraq-core --features ffi` as a **static library** for
   `aarch64-apple-ios`, `aarch64-apple-ios-sim` and `x86_64-apple-ios` with the cargo profile `ios`
   (release, **LTO off**: Xcode's linker cannot read Rust thin-LTO bitcode), merges the two simulator
   slices with `lipo`, and writes `apps/ios/Frameworks/WarraqCore.xcframework` with `warraq.h` and a module map.
2. `xcodegen generate` turns `project.yml` into `ZoodPDF.xcodeproj` (not committed).
3. `xcodebuild build-for-testing` + `test-without-building` on **iPhone 17** and **iPad Pro 13-inch (M4)**
   simulators (override with `IPHONE_SIM=… IPAD_SIM=…`). Each test run is time-boxed (`TEST_TIMEOUT`,
   default 1200 s) because `xcodebuild test` can hang after the last bundle; the verdict is read from the
   `.xcresult` bundle with `xcresulttool`, not from xcodebuild's exit status.
4. Screenshots attached by the UI test (`XCUIScreen.main.screenshot()`) are exported from the result
   bundle, plus a final `xcrun simctl io … screenshot`, into `docs/design/ios/<device>/`.

To work in Xcode after step 2: open `apps/ios/ZoodPDF.xcodeproj`, scheme **ZOOD PDF**.

### Running on a device

No Apple team is configured (simulator builds are signed "to run locally"). For a device build the
owner must, in `project.yml` (or Xcode › Signing & Capabilities):

* set `DEVELOPMENT_TEAM` to their team ID and `CODE_SIGN_STYLE: Automatic`;
* register the App Group `group.sa.zood.pdf` (shared by the app and the widgets) for the bundle IDs
  `sa.zood.pdf.ios` and `sa.zood.pdf.ios.widgets`;
* run `scripts/ios/build-core.sh` with the default targets (they include the device slice).

## What can be checked without a Mac

```bash
bash scripts/ios/test-linux.sh        # ZoodKit on Linux, linked to the real engine (swift test)
bash scripts/ios/parse-check.sh       # swiftc -parse of every app/widget/test source
python3 scripts/ios/check-strings.py  # every key in en + ar, Arabic plural forms, no unused keys
```

`test-linux.sh` builds the engine as a static library for the host and runs the `ZoodKit` tests
(swift-testing) against it through the same C ABI the app uses. Install a Swift 6 toolchain from
swift.org first (or set `SWIFT=/path/to/swift`).

## Layout

| Path | What |
| --- | --- |
| `project.yml` | XcodeGen spec: app **ZOOD PDF** (`sa.zood.pdf.ios`), widget extension, unit + UI tests |
| `Packages/ZoodKit` | SwiftPM package, platform-independent, tested on Linux. `ZoodEngine`: actor over the C ABI with typed RPC methods. `ZoodCore`: recents store, Arabic search normalisation (mirror of the web rules), page ranges, Hijri dates, file naming, scan geometry, deep links, AI request/SSE parsing |
| `App/` | SwiftUI app: `Home/` (split view / tabs, Home, Recents, Tags), `Document/` (PDFKit view, Pencil palette, ink conversion, session that saves through `doc.rebase`), `Organize/`, `Tools/` (Protect, Combine, Compress, Convert), `Scan/` (VisionKit + AVFoundation capture, corner editor, OCR, PDF builder), `AI/`, `Services/` |
| `Shared/` | Compiled into the app and the widgets (the Scan intent used by the Control Center control) |
| `Intents/` | App Intents + App Shortcuts (Open recent, Scan, Combine, Compress) |
| `Widgets/` | WidgetKit: Recents, Scan, Lock Screen accessory, Control Center control |
| `*.xcstrings` | String Catalogs, English + Arabic (MSA): app, widgets, App Shortcuts phrases |
| `Tests/ZoodPDFTests` | Simulator tests: PDFKit + engine rebase, OCR text layer, Vision runtime check, compress |
| `Tests/ZoodPDFUITests` | Clicks through Home → document → Pencil → Organize → Scan in Arabic and English, attaching screenshots |

## How documents are handled

* Opening: bytes are read (coordinated, security-scoped for Files documents opened in place), checked
  with `pdf.isEncrypted`, opened by the engine and shown by PDFKit.
* Markup (Pencil pen/marker/highlighter, text highlight, eraser) becomes standard PDF ink and highlight
  annotations. Before any engine step and on Save, PDFKit's whole-file output goes through `doc.rebase`,
  so only the changed objects are appended to the **original bytes** (incremental update; earlier
  signatures stay valid).
* Organize (`pages.rotate/move/delete/insertBlank/insertFrom/extract`) and drop-to-combine run in the
  engine; every step is an incremental update; Undo restores the previous file.
* Protect (`protect.set` AES-256 / `protect.remove`) is a whole rewrite by design; the recents picture and
  the Spotlight entry of a protected file are dropped.
* Compress writes a *new* file (engine full rewrite, or PDFKit JPEG re-encoding when smaller) and never
  replaces the original.
* Spotlight text comes from the engine's `text.plain` (logical order, Arabic-aware), PDFKit otherwise.
