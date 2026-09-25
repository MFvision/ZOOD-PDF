#!/usr/bin/env bash
# Syntax check (swiftc -parse, no type checking) of the iOS app sources that need the iOS SDK
# and therefore cannot be compiled on Linux: App/, Shared/, Intents/, Widgets/, Tests/.
# Catches syntax errors early on any machine with a Swift toolchain; the real build is
# scripts/ios/build.sh on a Mac.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SWIFTC="${SWIFTC:-$(command -v swiftc || true)}"
if [ -z "$SWIFTC" ]; then
  for c in /opt/swift/*/usr/bin/swiftc; do [ -x "$c" ] && SWIFTC="$c"; done
fi
[ -n "$SWIFTC" ] || { echo "[ios-parse] no swiftc found (set SWIFTC=…)" >&2; exit 2; }
cd "$ROOT/apps/ios"
mapfile -t FILES < <(find App Shared Intents Widgets Tests -name '*.swift' | sort)
"$SWIFTC" -parse -swift-version 6 "${FILES[@]}"
echo "[ios-parse] ${#FILES[@]} files parse cleanly"
