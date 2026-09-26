#!/usr/bin/env bash
# Downloads the OCR language models used by the Scan & OCR tool into a git-ignored cache
# (.cache/ocr-models) and verifies pinned SHA-256 checksums. The UI build copies them from there
# (packages/ui/vite/ocr.ts); the app itself never fetches anything from the network.
#
# Models: tesseract-ocr/tessdata tag 4.1.0 — the "best-int" models (LSTM models of tessdata_best
# converted to integer, plus the legacy engine data). Licence: Apache-2.0.
#
#   bash scripts/fetch-ocr-models.sh            # download missing files, verify all
#   OCR_MODELS_DIR=/path bash scripts/fetch-ocr-models.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${OCR_MODELS_DIR:-$ROOT/.cache/ocr-models}"
TAG="4.1.0"
BASE="https://raw.githubusercontent.com/tesseract-ocr/tessdata/$TAG"
mkdir -p "$DIR"

# name  sha256
MODELS="
ara 2005976778bbc14fc56a4ea8d43c6080847aeee72fcc2201488f240daca15c5b
eng daa0c97d651c19fba3b25e81317cd697e9908c8208090c94c3905381c23fc047
fas 0b3b15e9ccbe435825187fa7a2bb227f555dd37cf85126c6cf459ca4a69b929f
urd 80bc282fbbae99abd6b407084c401a930ddc49343719109e650d779531fc7a97
"

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

fail=0
while read -r lang sum; do
  [ -z "$lang" ] && continue
  f="$DIR/$lang.traineddata"
  if [ ! -s "$f" ] || [ "$(sha "$f")" != "$sum" ]; then
    echo "[ocr-models] fetching $lang.traineddata ($TAG)"
    curl -fsSL --retry 3 -o "$f.part" "$BASE/$lang.traineddata"
    mv "$f.part" "$f"
  fi
  got="$(sha "$f")"
  if [ "$got" != "$sum" ]; then
    echo "[ocr-models] CHECKSUM MISMATCH for $lang: expected $sum, got $got" >&2
    fail=1
  else
    echo "[ocr-models] ok $lang $(stat -c %s "$f" 2>/dev/null || stat -f %z "$f") bytes"
  fi
done <<< "$MODELS"
exit $fail
