#!/bin/sh
# ZOOD PDF (زود PDF) — start the offline web app on this computer (macOS / Linux).
# Needs Node.js 22 or newer (https://nodejs.org). Serves on 127.0.0.1 only.
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "ZOOD PDF needs Node.js 22+: https://nodejs.org" >&2
  echo "يحتاج زود PDF إلى Node.js ‏22 أو أحدث: https://nodejs.org" >&2
  exit 1
fi
exec node "$HERE/serve.mjs" --open "$@"
