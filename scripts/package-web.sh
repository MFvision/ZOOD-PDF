#!/usr/bin/env bash
# Packages the web build as out/zood-pdf-web.zip:
#   zood-pdf-web/app/…               apps/web/dist
#   zood-pdf-web/serve.mjs           dependency-free static server (node:http, 127.0.0.1 only)
#   zood-pdf-web/Start on Windows.cmd
#   zood-pdf-web/start.sh
#   zood-pdf-web/README.txt, LICENSE, THIRD-PARTY-NOTICES.md
# Builds apps/web first when dist is missing (or when --build is given).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/apps/web/dist"
SRC="$ROOT/scripts/package-web"
OUT="$ROOT/out"
NAME="zood-pdf-web"
STAGE="$OUT/$NAME"
ZIP="$OUT/$NAME.zip"

if [[ "${1:-}" == "--build" || ! -f "$DIST/index.html" ]]; then
  echo "[package-web] building apps/web"
  pnpm -C "$ROOT/apps/web" build
fi
[[ -f "$DIST/index.html" ]] || { echo "[package-web] $DIST/index.html missing" >&2; exit 1; }

rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE/app"
cp -R "$DIST/." "$STAGE/app/"
cp "$SRC/serve.mjs" "$SRC/README.txt" "$ROOT/LICENSE" "$ROOT/THIRD-PARTY-NOTICES.md" "$STAGE/"
cp "$SRC/start.sh" "$STAGE/start.sh"
chmod 755 "$STAGE/start.sh"
# .cmd files must use CRLF line endings for cmd.exe.
sed 's/\r$//; s/$/\r/' "$SRC/start-windows.cmd" > "$STAGE/Start on Windows.cmd"

# Sanity: the served app must contain the engine/PDFium wasm.
if ! find "$STAGE/app" -name '*.wasm' | grep -q .; then
  echo "[package-web] warning: no .wasm found in apps/web/dist" >&2
fi

(cd "$OUT" && zip -qr -X "$NAME.zip" "$NAME")
rm -rf "$STAGE"
echo "[package-web] $(du -h "$ZIP" | cut -f1) $ZIP"
