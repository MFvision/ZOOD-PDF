#!/usr/bin/env bash
# Builds the Rust engine (warraq-core, feature "ffi") as a static library for iOS and packs it
# into apps/ios/Frameworks/WarraqCore.xcframework (device arm64 + simulator arm64/x86_64),
# with warraq.h and a module map.
#
# Uses the `ios` cargo profile: release, LTO OFF. Xcode's linker cannot read Rust (thin-)LTO
# bitcode objects (known trap), so LTO must stay off for anything Xcode links.
#
#   bash scripts/ios/build-core.sh
#   IOS_CORE_TARGETS="aarch64-apple-ios-sim" bash scripts/ios/build-core.sh   # simulator only (faster)
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "[ios-core] ERROR: building the iOS engine needs macOS with Xcode (found $(uname -s))." >&2
  echo "[ios-core] On Linux, test the Swift/engine bridge with: bash scripts/ios/test-linux.sh" >&2
  exit 1
fi
for tool in xcodebuild lipo xcrun; do
  command -v "$tool" >/dev/null || { echo "[ios-core] ERROR: $tool not found — install Xcode 26+ and run xcode-select -s" >&2; exit 1; }
done

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PATH="$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null || { echo "[ios-core] ERROR: cargo not found (https://rustup.rs)" >&2; exit 1; }
# Private target dir: a shared CARGO_TARGET_DIR hands back another tree's build (known trap).
export CARGO_TARGET_DIR="$ROOT/.target-ios"
export IPHONEOS_DEPLOYMENT_TARGET=18.0
TARGETS="${IOS_CORE_TARGETS:-aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios}"
OUT="$ROOT/apps/ios/Frameworks/WarraqCore.xcframework"
STAGE="$CARGO_TARGET_DIR/xcframework-stage"
HEADER="$ROOT/packages/core/crates/warraq-core/include/warraq.h"

if command -v rustup >/dev/null; then
  # shellcheck disable=SC2086
  rustup target add $TARGETS >/dev/null
fi

cd "$ROOT/packages/core"
for t in $TARGETS; do
  echo "[ios-core] building $t (profile ios, LTO off)"
  # `cargo rustc --crate-type staticlib`: only the static library, not the cdylib/rlib.
  cargo rustc -p warraq-core --lib --features ffi --profile ios --target "$t" --crate-type staticlib
  lib="$CARGO_TARGET_DIR/$t/ios/libwarraq_core.a"
  [ -f "$lib" ] || { echo "[ios-core] ERROR: $lib missing" >&2; exit 1; }
  # The C ABI must be exported (and it must be real machine code, not LLVM bitcode).
  nm -g "$lib" 2>/dev/null | grep -q "_warraq_open" || { echo "[ios-core] ERROR: warraq_open not exported by $lib" >&2; exit 1; }
done

rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE/include" "$STAGE/device" "$STAGE/sim"
cp "$HEADER" "$STAGE/include/warraq.h"
cat > "$STAGE/include/module.modulemap" <<'EOF'
module WarraqCore {
    header "warraq.h"
    export *
}
EOF

ARGS=()
if [[ " $TARGETS " == *" aarch64-apple-ios "* ]]; then
  cp "$CARGO_TARGET_DIR/aarch64-apple-ios/ios/libwarraq_core.a" "$STAGE/device/"
  ARGS+=(-library "$STAGE/device/libwarraq_core.a" -headers "$STAGE/include")
fi
SIM_LIBS=()
for t in aarch64-apple-ios-sim x86_64-apple-ios; do
  [[ " $TARGETS " == *" $t "* ]] && SIM_LIBS+=("$CARGO_TARGET_DIR/$t/ios/libwarraq_core.a")
done
if [ "${#SIM_LIBS[@]}" -gt 0 ]; then
  lipo -create "${SIM_LIBS[@]}" -output "$STAGE/sim/libwarraq_core.a"
  lipo -info "$STAGE/sim/libwarraq_core.a"
  ARGS+=(-library "$STAGE/sim/libwarraq_core.a" -headers "$STAGE/include")
fi
[ "${#ARGS[@]}" -gt 0 ] || { echo "[ios-core] ERROR: no iOS targets built" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
xcodebuild -create-xcframework "${ARGS[@]}" -output "$OUT"
echo "[ios-core] wrote $OUT"
