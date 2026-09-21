#!/bin/zsh
# Builds the Rust core for iOS and packs it as apps/ios/Vendor/WarraqCore.xcframework
# (git-ignored): libwarraq_core.a for a device (arm64) and for the simulator
# (arm64, plus x86_64 when WARRAQ_IOS_X86=1), with the C header and module map
# from packages/core/warraq-core/include/.
#
#   scripts/ios/build-core.sh              # release ("ios" profile: unwinding, thin LTO)
#   WARRAQ_IOS_DEBUG=1 scripts/ios/build-core.sh   # a debug build, quicker
#
# Run it through the machine-wide queue (~/Developer/warraq/.tools/one-at-a-time.sh)
# and with a CARGO_TARGET_DIR of your own: the shared one can hand back another
# checkout's build of the same crates.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
core="$repo/packages/core"
out="$repo/apps/ios/Vendor"
include="$core/warraq-core/include"
target_dir="${CARGO_TARGET_DIR:-$repo/apps/ios/.build/cargo}"
export CARGO_TARGET_DIR="$target_dir"

# The macOS SDK path that .tools/env.sh exports would be handed to any C
# compiled for iOS; cargo and cc pick the iOS SDKs by target on their own.
unset SDKROOT
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export PATH="$DEVELOPER_DIR/usr/bin:$HOME/.cargo/bin:$PATH"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-3}"
# iOS 18 is the app's deployment target; the core's objects say the same.
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-18.0}"

if [ "${WARRAQ_IOS_DEBUG:-0}" = "1" ]; then
  profile_args=()
  profile_dir="debug"
else
  profile_args=(--profile ios)
  profile_dir="ios"
fi

targets=(aarch64-apple-ios aarch64-apple-ios-sim)
if [ "${WARRAQ_IOS_X86:-0}" = "1" ]; then
  targets+=(x86_64-apple-ios)
fi

for target in "${targets[@]}"; do
  echo "== cargo build -p warraq-core --features ffi --target $target ${profile_args[*]:-}"
  cargo build --manifest-path "$core/Cargo.toml" -p warraq-core --lib \
    --features ffi --target "$target" "${profile_args[@]}"
done

stage="$target_dir/xcframework-stage"
rm -rf "$stage"
mkdir -p "$stage/device" "$stage/simulator" "$stage/include"
cp "$include/warraq_core.h" "$include/module.modulemap" "$stage/include/"

cp "$target_dir/aarch64-apple-ios/$profile_dir/libwarraq_core.a" "$stage/device/libwarraq_core.a"
if [ "${WARRAQ_IOS_X86:-0}" = "1" ]; then
  # One simulator slice holding both architectures.
  lipo -create \
    "$target_dir/aarch64-apple-ios-sim/$profile_dir/libwarraq_core.a" \
    "$target_dir/x86_64-apple-ios/$profile_dir/libwarraq_core.a" \
    -output "$stage/simulator/libwarraq_core.a"
else
  cp "$target_dir/aarch64-apple-ios-sim/$profile_dir/libwarraq_core.a" "$stage/simulator/libwarraq_core.a"
fi

mkdir -p "$out"
rm -rf "$out/WarraqCore.xcframework"
xcodebuild -create-xcframework \
  -library "$stage/device/libwarraq_core.a" -headers "$stage/include" \
  -library "$stage/simulator/libwarraq_core.a" -headers "$stage/include" \
  -output "$out/WarraqCore.xcframework"

rm -rf "$stage"
echo "== $out/WarraqCore.xcframework"
ls "$out/WarraqCore.xcframework"
du -sh "$out/WarraqCore.xcframework"
