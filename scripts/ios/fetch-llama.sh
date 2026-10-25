#!/bin/bash
# Fetches llama.cpp's own XCFramework (MIT, ggml-org/llama.cpp releases) into
# apps/ios/Vendor/llama.xcframework (git-ignored), checked against the pin in
# apps/ios/Vendor/llama.pin: the iPhone's own AI model runs on it
# (PDFEditor/AI/ZoodModelEngine.swift). The same engine the desktop app uses
# through its Rust binding.
#
#   scripts/ios/fetch-llama.sh
#
# With no sha256 in the pin (only when the pin is first chosen), the file is
# fetched over https from GitHub and its checksum printed, to be written into
# the pin.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
vendor="$repo/apps/ios/Vendor"
pin="$vendor/llama.pin"
tag="$(sed -n 's/^tag=//p' "$pin")"
want="$(sed -n 's/^sha256=//p' "$pin")"
if [ "$tag" = "latest" ]; then
  # Only while the pin is first chosen: the newest release's tag.
  auth=()
  [ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  tag="$(curl -fsSL "${auth[@]}" https://api.github.com/repos/ggml-org/llama.cpp/releases/latest | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')"
  echo "newest llama.cpp release: $tag (write tag=$tag into $pin)"
fi
if [ -d "$vendor/llama.xcframework" ] && [ -f "$vendor/llama.xcframework/.tag" ] && [ "$(cat "$vendor/llama.xcframework/.tag")" = "$tag" ]; then
  echo "llama.xcframework $tag already here"
  exit 0
fi
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
url="https://github.com/ggml-org/llama.cpp/releases/download/$tag/llama-$tag-xcframework.zip"
echo "== fetching $url"
curl -fsSL --retry 4 -o "$work/llama.zip" "$url"
got="$(shasum -a 256 "$work/llama.zip" | cut -d' ' -f1)"
if [ -n "$want" ] && [ "$got" != "$want" ]; then
  echo "llama.cpp $tag checksum is $got, the pin says $want: refusing it" >&2
  exit 1
fi
[ -z "$want" ] && echo "llama.cpp $tag sha256=$got (write it into $pin)"
(cd "$work" && unzip -q llama.zip)
found="$(find "$work" -type d -name 'llama.xcframework' -prune | head -1)"
[ -n "$found" ] || { echo "no llama.xcframework inside the release" >&2; exit 1; }
rm -rf "$vendor/llama.xcframework"
mv "$found" "$vendor/llama.xcframework"
echo "$tag" > "$vendor/llama.xcframework/.tag"
ls "$vendor/llama.xcframework"
