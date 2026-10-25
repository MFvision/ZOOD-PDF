#!/bin/bash
# Puts ZOOD's own on-device model (Qwen2.5 1.5B Instruct, Q4_K_M, Apache-2.0,
# the one the desktop app uses: packages/ui/src/ai/device/models.json) into
# apps/ios/PDFEditor/Resources/Model/ (git-ignored), so the app carries it and
# the AI works the moment it is installed, offline, on any iPhone. Checked
# against the size and sha256 pinned in models.json.
#
#   scripts/ios/fetch-model.sh            # before scripts/ios/testflight.sh
#
# Without it the app still builds: it then offers to fetch the model once from
# Settings › AI (the same file, the same check).
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
dest="$repo/apps/ios/PDFEditor/Resources/Model"
read -r file url sha bytes < <(python3 - "$repo/packages/ui/src/ai/device/models.json" <<'PY'
import json, sys
m = next(m for m in json.load(open(sys.argv[1]))["models"] if m["id"] == "qwen2.5-1.5b")
print(m["file"], m["url"], m["sha256"], m["bytes"])
PY
)
mkdir -p "$dest"
target="$dest/$file"
if [ -f "$target" ] && [ "$(shasum -a 256 "$target" | cut -d' ' -f1)" = "$sha" ]; then
  echo "$file already here and checked"
  exit 0
fi
echo "== fetching $file ($bytes bytes)"
curl -fL --retry 4 -o "$target.part" "$url"
size="$(wc -c < "$target.part" | tr -d ' ')"
got="$(shasum -a 256 "$target.part" | cut -d' ' -f1)"
if [ "$size" != "$bytes" ] || [ "$got" != "$sha" ]; then
  rm -f "$target.part"
  echo "$file is not the pinned file (size $size, sha256 $got): refusing it" >&2
  exit 1
fi
mv "$target.part" "$target"
echo "$file checked and in place"
