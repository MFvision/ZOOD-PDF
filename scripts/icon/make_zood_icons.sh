#!/bin/zsh
# Writes every ZOOD app icon the repo ships, from the one generator
# (scripts/icon/make_zood_icon.py) through the SVG rasterizer
# (scripts/icon/svg2png.swift):
#
#   apps/ios/…/Assets.xcassets/AppIcon.appiconset/  the iOS icon, light, dark and tinted
#   apps/desktop/icon.svg                            the desktop tile (continuous corners)
#   packages/ui/public/app-icon.svg                  the in-page mark
#   apps/web/public/favicon.svg + icons/*.png        the web app and its home-screen icons
#   apps/extension/icons/icon{16,32,48,128}.png      the browser extension
#
# The Tauri bundle's .icns/.ico are NOT written here; after running this:
#   pnpm --filter @warraq/desktop icons
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

gen() { python3 "$repo/scripts/icon/make_zood_icon.py" "$@" > /dev/null; }
png() { xcrun swift "$repo/scripts/icon/svg2png.swift" "$@" > /dev/null; }

gen "$work/tile.svg"                      # the continuous-corner tile
gen "$work/square.svg" --square           # full bleed, for a system that cuts its own shape
gen "$work/square-dark.svg" --square --dark
gen "$work/square-tinted.svg" --square --tinted
gen "$work/maskable.svg" --maskable
gen "$work/mark.svg" --mark-only

# ---- iOS ------------------------------------------------------------------
# One 1024 px icon in each appearance. No alpha channel: an iOS app icon that
# carries one is rejected at upload.
appicon="$repo/apps/ios/PDFEditor/Resources/Assets.xcassets/AppIcon.appiconset"
png "$work/square.svg"        "$appicon/AppIcon.png"        1024 --opaque "#080b1a"
png "$work/square-dark.svg"   "$appicon/AppIcon-Dark.png"   1024 --opaque "#04060f"
png "$work/square-tinted.svg" "$appicon/AppIcon-Tinted.png" 1024 --opaque "#000000"

# ---- desktop, the page, the web -------------------------------------------
cp "$work/tile.svg" "$repo/apps/desktop/icon.svg"
cp "$work/tile.svg" "$repo/packages/ui/public/app-icon.svg"
cp "$work/tile.svg" "$repo/apps/web/public/favicon.svg"
icons="$repo/apps/web/public/icons"
png "$work/tile.svg"     "$icons/icon-192.png"      192
png "$work/tile.svg"     "$icons/icon-512.png"      512
png "$work/maskable.svg" "$icons/maskable-192.png"  192
png "$work/maskable.svg" "$icons/maskable-512.png"  512
# Safari fills an apple-touch-icon's transparency with black: it gets the
# full-bleed square, whose corners Safari rounds itself.
png "$work/square.svg"   "$icons/apple-touch-icon.png" 180 --opaque "#080b1a"

# ---- the browser extension -------------------------------------------------
extension="$repo/apps/extension/icons"
for size in 16 32 48 128; do
  png "$work/square.svg" "$extension/icon$size.png" "$size" --opaque "#080b1a"
done

echo "== wrote the ZOOD icons"
