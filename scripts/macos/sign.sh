#!/usr/bin/env bash
# Signs a released Mac dmg with the Developer ID on this Mac, sends it to
# Apple for notarization, and leaves the signed dmg on the Desktop.
#
#   scripts/macos/sign.sh 0.4.3            # download desktop-v0.4.3's dmg
#   scripts/macos/sign.sh path/to/app.dmg  # or sign a dmg already here
#
# The app is signed with the hardened runtime AND the repo's entitlements
# (apps/desktop/src-tauri/Entitlements.plist): without them the microphone
# and Apple events are silently refused. Notarization uses the keychain
# profile "ZOOD" (xcrun notarytool store-credentials, typed by the owner).
# Stapling waits for Apple: run `xcrun stapler staple <dmg>` once approved.
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
entitlements="$here/apps/desktop/src-tauri/Entitlements.plist"
identity="${WARRAQ_SIGN_IDENTITY:-Developer ID Application}"
work="$(mktemp -d)"
trap 'hdiutil detach -quiet "$work/mnt" 2>/dev/null || true; rm -rf "$work"' EXIT

if [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  version="$1"
  curl -fsSL -o "$work/in.dmg" \
    "https://github.com/MFvision/ZOOD-PDF/releases/download/desktop-v$version/ZOOD-PDF-$version-mac.dmg"
else
  version="$(basename "$1" .dmg)"
  cp "$1" "$work/in.dmg"
fi

mkdir "$work/mnt" "$work/root"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$work/mnt" "$work/in.dmg"
app="$(find "$work/mnt" -maxdepth 1 -name '*.app' | head -1)"
ditto "$app" "$work/root/$(basename "$app")"
hdiutil detach -quiet "$work/mnt"
app="$work/root/$(basename "$app")"
xattr -cr "$app"

# Inside out: the bundled libraries first, then the app with its entitlements.
find "$app/Contents" -type f \( -name '*.dylib' -o -name '*.so' \) -print0 |
  xargs -0 -I{} codesign --force --timestamp --options runtime --sign "$identity" {}
codesign --force --timestamp --options runtime --entitlements "$entitlements" --sign "$identity" "$app"
codesign --verify --deep --strict "$app"
codesign -d --entitlements - "$app" 2>/dev/null | grep -q audio-input

ln -s /Applications "$work/root/Applications"
out="$HOME/Desktop/ZOOD-PDF-$version-mac.dmg"
rm -f "$out"
hdiutil create -quiet -volname "ZOOD PDF" -srcfolder "$work/root" -format UDZO "$out"
codesign --force --timestamp --sign "$identity" "$out"
xcrun notarytool submit "$out" --keychain-profile ZOOD --no-wait
echo "signed: $out (sent to Apple; staple once approved)"
