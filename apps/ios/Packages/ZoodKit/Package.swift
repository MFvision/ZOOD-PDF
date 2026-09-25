// swift-tools-version: 6.0
//
// ZoodKit: the platform-independent half of the ZOOD PDF iOS app.
//
//   ZoodCore   pure Swift (models, recents store, Arabic search normalisation, page ranges,
//              Hijri dates, file naming, scan geometry). Used by the app and the widgets.
//   ZoodEngine Swift wrapper (actor) around the Rust engine's C ABI (warraq.h).
//
// Everything here builds and is tested on Linux (scripts/ios/test-linux.sh) as well as on iOS.
// On Linux the engine static library is found through WARRAQ_LIB_DIR; on iOS the app target
// links Frameworks/WarraqCore.xcframework instead, so no linker flags are added here.

import Foundation
import PackageDescription

let warraqLibDir = Context.environment["WARRAQ_LIB_DIR"]
let engineLinker: [LinkerSetting] = warraqLibDir.map {
    [.unsafeFlags(["-L", $0]), .linkedLibrary("warraq_core")]
} ?? []

let strict: [SwiftSetting] = [
    .swiftLanguageMode(.v6),
    .enableUpcomingFeature("ExistentialAny"),
]

let package = Package(
    name: "ZoodKit",
    defaultLocalization: "en",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "ZoodCore", targets: ["ZoodCore"]),
        .library(name: "ZoodEngine", targets: ["ZoodEngine"]),
    ],
    targets: [
        .target(name: "CWarraq", path: "Sources/CWarraq", linkerSettings: engineLinker),
        .target(name: "ZoodCore", swiftSettings: strict),
        .target(name: "ZoodEngine", dependencies: ["CWarraq", "ZoodCore"], swiftSettings: strict),
        .testTarget(name: "ZoodCoreTests", dependencies: ["ZoodCore"], swiftSettings: strict),
        .testTarget(name: "ZoodEngineTests", dependencies: ["ZoodEngine"], swiftSettings: strict),
    ]
)
