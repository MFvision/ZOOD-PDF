#!/bin/zsh
# Writes every icon and every piece of logo artwork the repo ships, from
# ZOOD's own logo (scripts/icon/zood/*.svg, cut from the brand's identity
# package) through the composer (scripts/icon/make_zood_icons.py) and the SVG
# rasterizer (scripts/icon/svg2png.swift):
#
#   apps/ios/…/Assets.xcassets/AppIcon.appiconset/  the iOS icon, default, dark and tinted
#   apps/ios/…/Assets.xcassets/Zood*.imageset/      the mark and the lockups, as vector PDFs
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

png() { xcrun swift "$repo/scripts/icon/svg2png.swift" "$@" > /dev/null; }

python3 "$repo/scripts/icon/make_zood_icons.py" "$work" > /dev/null

# ZOOD's navy (Pantone 282 C), under anything that may not carry alpha.
navy="#041e42"

# ---- iOS ------------------------------------------------------------------
# One 1024 px icon in each appearance. No alpha channel: an iOS app icon that
# carries one is rejected at upload.
assets="$repo/apps/ios/PDFEditor/Resources/Assets.xcassets"
appicon="$assets/AppIcon.appiconset"
png "$work/square.svg"        "$appicon/AppIcon.png"        1024 --opaque "$navy"
png "$work/square-dark.svg"   "$appicon/AppIcon-Dark.png"   1024 --opaque "#010815"
png "$work/square-tinted.svg" "$appicon/AppIcon-Tinted.png" 1024 --opaque "#000000"
# The icons Settings › App icon offers (alternate icons), and the small
# pictures of each the picker shows.
for pair in Paper:paper Sky:sky Black:black Bronze:bronze; do
  key=${pair%%:*}; file=${pair##*:}
  png "$work/alt-$file.svg" "$assets/AppIcon-$key.appiconset/AppIcon-$key.png" 1024 --opaque "$navy"
  png "$work/alt-$file.svg" "$assets/AppIconPreview$key.imageset/AppIconPreview$key.png" 180 --opaque "$navy"
done
png "$work/square.svg" "$assets/AppIconPreviewNavy.imageset/AppIconPreviewNavy.png" 180 --opaque "$navy"
# The artwork the app draws itself, kept as vectors.
for name in ZoodMark ZoodLogoMain ZoodLogoVertical ZoodLogoHorizontal; do
  cp "$work/$name.pdf" "$assets/$name.imageset/$name.pdf"
done
# The brand's graphical elements, vectors cut from its identity package.
for n in 01 02 03; do
  cp "$repo/scripts/icon/zood/zood-pattern-$n.pdf" "$assets/ZoodPattern$n.imageset/ZoodPattern$n.pdf"
done

# ---- desktop, the page, the web -------------------------------------------
cp "$work/tile.svg" "$repo/apps/desktop/icon.svg"
cp "$work/tile.svg" "$repo/packages/ui/public/app-icon.svg"
cp "$work/tile.svg" "$repo/apps/web/public/favicon.svg"
icons="$repo/apps/web/public/icons"
png "$work/tile.svg"   "$icons/icon-192.png"      192
png "$work/tile.svg"   "$icons/icon-512.png"      512
# Maskable: full bleed; the mark already sits inside the middle 80 %, the
# part every home-screen shape keeps.
png "$work/square.svg" "$icons/maskable-192.png"  192 --opaque "$navy"
png "$work/square.svg" "$icons/maskable-512.png"  512 --opaque "$navy"
# Safari fills an apple-touch-icon's transparency with black: it gets the
# full-bleed square, whose corners Safari rounds itself.
png "$work/square.svg" "$icons/apple-touch-icon.png" 180 --opaque "$navy"

# ---- the browser extension -------------------------------------------------
extension="$repo/apps/extension/icons"
for size in 16 32 48 128; do
  png "$work/square.svg" "$extension/icon$size.png" "$size" --opaque "$navy"
done

echo "== wrote the ZOOD icons"
