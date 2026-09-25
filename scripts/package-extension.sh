#!/usr/bin/env bash
# Zips the Chrome MV3 extension build (apps/extension/dist) to out/zood-pdf-extension.zip,
# with manifest.json at the zip root as the Chrome Web Store expects.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/apps/extension/dist"
OUT="$ROOT/out"
ZIP="$OUT/zood-pdf-extension.zip"

if [[ "${1:-}" == "--build" || ! -f "$DIST/manifest.json" ]]; then
  echo "[package-extension] building apps/extension"
  pnpm -C "$ROOT/apps/extension" build
fi
[[ -f "$DIST/manifest.json" ]] || { echo "[package-extension] $DIST/manifest.json missing" >&2; exit 1; }

mkdir -p "$OUT"
rm -f "$ZIP"
(cd "$DIST" && zip -qr -X "$ZIP" . -x '*.map' -x '.DS_Store')
echo "[package-extension] $(du -h "$ZIP" | cut -f1) $ZIP"
