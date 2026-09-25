#!/usr/bin/env bash
# Builds the release app on macOS and installs it as "/Applications/ZOOD PDF.app".
#
#   bash scripts/install-macos.sh            # build + install
#   bash scripts/install-macos.sh --no-build # install the last build
#   INSTALL_DIR=~/Applications bash scripts/install-macos.sh
#
# Needs: macOS 11+, Xcode command line tools, Node 22 + pnpm, Rust (rustup) with the
# wasm32-unknown-unknown target, wasm-pack. The app is unsigned (no Apple team): the first
# launch needs right-click → Open, or `xattr -dr com.apple.quarantine` (done below for the
# locally built copy, which is not quarantined anyway).
set -euo pipefail

APP_NAME="ZOOD PDF"
BUNDLE_ID="sa.zood.pdf"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$ROOT/apps/desktop"
INSTALL_DIR="${INSTALL_DIR:-/Applications}"
DEST="$INSTALL_DIR/$APP_NAME.app"
BUILD=1

die() { echo "[install-macos] error: $*" >&2; exit 1; }
log() { echo "[install-macos] $*"; }

for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown argument: $arg" ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || die "this script only runs on macOS"
for tool in pnpm cargo /usr/libexec/PlistBuddy ditto; do
  command -v "$tool" >/dev/null 2>&1 || die "missing $tool"
done

# A private target dir inside this tree (shared cargo target dirs hand back other trees' builds).
export CARGO_TARGET_DIR="$DESKTOP/src-tauri/target"
BUNDLE_DIR="$CARGO_TARGET_DIR/release/bundle/macos"
SRC_APP="$BUNDLE_DIR/$APP_NAME.app"

if [[ "$BUILD" == 1 ]]; then
  command -v wasm-pack >/dev/null 2>&1 || die "missing wasm-pack (cargo install wasm-pack)"
  log "installing dependencies"
  (cd "$ROOT" && pnpm install --frozen-lockfile)
  log "building the engine (WASM)"
  bash "$ROOT/scripts/build-wasm.sh"
  log "building the app bundle (release)"
  (cd "$DESKTOP" && pnpm tauri build --bundles app)
fi

[[ -d "$SRC_APP" ]] || die "no bundle at $SRC_APP (run without --no-build)"

plist_get() { /usr/libexec/PlistBuddy -c "Print :$1" "$2/Contents/Info.plist" 2>/dev/null || true; }

verify_bundle() {
  local app="$1" name display id
  name="$(plist_get CFBundleName "$app")"
  display="$(plist_get CFBundleDisplayName "$app")"
  id="$(plist_get CFBundleIdentifier "$app")"
  [[ "$name" == "$APP_NAME" ]] || die "CFBundleName is '$name', expected '$APP_NAME' ($app)"
  [[ "$display" == "$APP_NAME" ]] || die "CFBundleDisplayName is '$display', expected '$APP_NAME' ($app)"
  [[ "$id" == "$BUNDLE_ID" ]] || die "CFBundleIdentifier is '$id', expected '$BUNDLE_ID' ($app)"
  log "verified $app: CFBundleName='$name' CFBundleDisplayName='$display' CFBundleIdentifier='$id'"
}

verify_bundle "$SRC_APP"

if pgrep -xq "zood-pdf"; then
  log "quitting the running ZOOD PDF"
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  sleep 2
fi

mkdir -p "$INSTALL_DIR"
if [[ -e "$DEST" ]]; then
  log "replacing $DEST"
  rm -rf "$DEST" || die "cannot remove $DEST (try: sudo rm -rf \"$DEST\")"
fi
ditto "$SRC_APP" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
# Let Launch Services / the Dock pick up the new name and icon.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[[ -x "$LSREGISTER" ]] && "$LSREGISTER" -f "$DEST" >/dev/null 2>&1 || true

verify_bundle "$DEST"
log "installed: $DEST"
log "open it with: open \"$DEST\""
