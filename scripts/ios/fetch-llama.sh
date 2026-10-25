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
auth=()
[ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
if [ "$tag" = "latest" ]; then release_api="https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=40"
else release_api=https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$tag; fi
# The release's XCFramework asset, by its name (the naming has changed over
# time); for "latest", the newest release that has one.
read -r tag url < <(curl -fsSL ${auth[@]+"${auth[@]}"} "$release_api" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for r in (data if isinstance(data, list) else [data]):
    assets = [a for a in r.get("assets", []) if "xcframework" in a["name"] and a["name"].endswith(".zip")]
    if assets:
        print(r["tag_name"], assets[0]["browser_download_url"]); break
else:
    print("none -")')
[ "$url" != "-" ] || { echo "llama.cpp $tag has no XCFramework asset" >&2; exit 1; }
echo "llama.cpp release $tag: $url"
if [ -d "$vendor/llama.xcframework" ] && [ -f "$vendor/llama.xcframework/.tag" ] && [ "$(cat "$vendor/llama.xcframework/.tag")" = "$tag" ]; then
  echo "llama.xcframework $tag already here"
  exit 0
fi
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
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
