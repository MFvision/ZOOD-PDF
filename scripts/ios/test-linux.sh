#!/usr/bin/env bash
# Tests the platform-independent half of the iOS app (apps/ios/Packages/ZoodKit) on Linux or
# macOS with SwiftPM, linked against the real Rust engine built as a static library for the
# host (feature "ffi", the same C ABI the iOS app uses). No Xcode needed.
#
#   bash scripts/ios/test-linux.sh            # build engine + swift test
#   SWIFT=/opt/swift/usr/bin/swift bash scripts/ios/test-linux.sh
#
# Needs: cargo, and a Swift 6 toolchain (https://www.swift.org/install/linux/).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PATH="$HOME/.cargo/bin:$PATH"
SWIFT="${SWIFT:-$(command -v swift || true)}"
if [ -z "$SWIFT" ]; then
  for c in /opt/swift/*/usr/bin/swift; do [ -x "$c" ] && SWIFT="$c"; done
fi
if [ -z "$SWIFT" ] || [ ! -x "$SWIFT" ]; then
  echo "[ios-linux] no Swift toolchain found (set SWIFT=/path/to/swift)" >&2
  exit 2
fi
# Private target dir (shared target dirs hand back another tree's build — known trap).
TARGET="$ROOT/.target-ios-host"
( cd "$ROOT/packages/core" && CARGO_TARGET_DIR="$TARGET" cargo build -p warraq-core --features ffi --profile ios --lib )
LIBDIR="$ROOT/.target-ios-host/lib"
mkdir -p "$LIBDIR"
cp "$TARGET/ios/libwarraq_core.a" "$LIBDIR/"
echo "[ios-linux] engine: $(du -h "$LIBDIR/libwarraq_core.a" | cut -f1) static library"
cd "$ROOT/apps/ios/Packages/ZoodKit"
WARRAQ_LIB_DIR="$LIBDIR" "$SWIFT" test --scratch-path "$ROOT/.target-ios-host/swiftpm" \
  -Xswiftc -strict-concurrency=complete -Xswiftc -warnings-as-errors "$@"
