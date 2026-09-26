# ADR 0010 — Native iOS/iPadOS app

Status: accepted · Date: 2026-09-25

## Context

The owner's specification asks for a separate native SwiftUI app for iPhone and iPad (not the React
interface in a web view): XcodeGen project, the Rust engine as an XCFramework, PDFKit, VisionKit, Vision
OCR, PencilKit, WidgetKit, App Intents, Core Spotlight, iOS 18+, Swift 6 strict concurrency,
simulator-tested; a device build needs the owner's Apple team. The development machines for this
project are Linux: no Xcode, no iOS SDK, no simulator.

## Decision

1. **Two layers.** `apps/ios/Packages/ZoodKit` is a SwiftPM package with no Apple-only imports:
   `ZoodEngine` (a Sendable **actor** per open document over the C ABI `warraq.h`, typed Codable wrappers
   of the RPC methods) and `ZoodCore` (recents store, Arabic search normalisation mirroring the web
   rules, page ranges, Hijri dates, file naming, scan geometry, deep links; since ADR 0015 also the local-first AI, autofill and read-aloud logic).
   Everything that needs UIKit/SwiftUI/PDFKit/VisionKit/PencilKit lives in the app and widget targets.
   ZoodKit is built and tested on Linux against the real engine static library
   (`scripts/ios/test-linux.sh`), which proves the FFI bridge (ownership, blobs, errors, concurrency)
   without a Mac.
2. **PDFKit displays; the engine owns bytes.** Same contract as the web app with EmbedPDF: PDFKit writes
   whole files, so its output always goes through `doc.rebase`, which appends only changed objects to
   the original bytes. Page organisation, protection and combining run in the engine; PDFKit reloads.
3. **Pencil → PDF ink.** PencilKit is used for input only. Each finished stroke is converted to a PDF
   `/Ink` annotation on the page under it (canvas → PDFView → page coordinates), so saved files are
   standard PDF readable anywhere and go through the same rebase path. Text highlight uses `/Highlight`
   with QuadPoints.
4. **Scanning.** Document mode uses VisionKit's `VNDocumentCameraViewController`. Whiteboard, ID Card and
   Book use an own AVFoundation capture with live `VNDetectRectanglesRequest` outlines, draggable
   corners, Core Image perspective correction, and per-mode processing (contrast boost; two sides on one
   A4 page at ID-1 real size; spread split with right-page-first order for right-to-left books).
   OCR uses `VNRecognizeTextRequest` (revision 3); Arabic is used only when
   `supportedRecognitionLanguages()` reports it **at runtime**, otherwise the user is told. The text layer
   is written as invisible text (`CGContext` text drawing mode `.invisible`) by Core Text while the PDF
   is generated with `UIGraphicsPDFRenderer` — the engine has no OCR-layer method yet.
5. **Engine packaging.** `scripts/ios/build-core.sh` builds `staticlib` for `aarch64-apple-ios`,
   `aarch64-apple-ios-sim`, `x86_64-apple-ios` with the `ios` cargo profile (**LTO off**; Xcode's linker
   cannot read Rust LTO bitcode), `lipo`s the simulator slices and creates `WarraqCore.xcframework`.
   ZoodKit keeps its own copy of `warraq.h` (module `CWarraq`); a test fails if it drifts from the
   engine's header.
6. **Shared state across processes.** Recents (`recents.json` + thumbnails) live in the App Group
   `group.sa.zood.pdf` so widgets, the Control Center control and App Intents read them; every read goes
   to disk (tiny file) instead of caching, because several processes write.
7. **Windows and navigation.** `WindowGroup(for: URL.self)` for documents; Files-app documents are passed
   between windows as `zoodpdf://open?id=…` links and re-resolved from their bookmark so the security
   scope survives. Navigation state is per window; the library is shared.
8. **Localisation.** String Catalogs with semantic keys (as in the web `en.json`/`ar.json`), English +
   Arabic MSA, Arabic plural forms, numerals from the locale; a Python checker enforces completeness.
9. **No third-party Swift packages.** Amended by ADR 0015: llama.cpp (MIT) is linked as its pinned
   upstream release XCFramework for device builds (on-device model fallback); still no SwiftPM
   dependencies. The bring-your-own-key AI assistant this ADR originally shipped was removed
   (SPEC §8: no cloud AI, no API keys).

## Consequences

* The iOS app has **not been compiled for iOS** in this repository's automation; only ZoodKit is
  compiled and tested (on Linux), and the app sources are syntax-checked (`swiftc -parse`). The owner
  must run `scripts/ios/build.sh` on a Mac; compile errors in the SwiftUI layer are possible and are
  expected to be small.
* Office export/import, redaction, digital signatures, forms, page marks, standards and accessibility are
  not on iOS yet (web/desktop only); the iOS feature-matrix column says so.
* Saving markup on a password-protected file cannot be incremental (PDFKit changes the encryption);
  the user chooses between keeping the password (AES-256 rewrite with the password they typed) and
  saving without it.
