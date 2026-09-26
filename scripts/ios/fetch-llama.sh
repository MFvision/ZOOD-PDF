#!/usr/bin/env bash
# Fetches llama.cpp (MIT) as a prebuilt XCFramework for the iOS app's portable on-device model
# (Qwen3 GGUF; see docs/decisions/0015-local-first-ai-ios.md) into
# apps/ios/Frameworks/llama.xcframework. The release and the archive's SHA-256 are pinned; the
# script refuses anything else. Runs on macOS or Linux (curl + unzip + sha256sum/shasum).
#
#   bash scripts/ios/fetch-llama.sh
#
# The b11200 archive has slices for iOS devices (arm64) and macOS only — no simulator — so
# project.yml links it for iphoneos builds only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TAG="b11200"
SHA256="c62cae37316b12938cde3224493e008d121635bf759ddd08fbcdd587b3b8808c"
URL="https://github.com/ggml-org/llama.cpp/releases/download/${TAG}/llama-${TAG}-xcframework.zip"
DEST="$ROOT/apps/ios/Frameworks"
STAMP="$DEST/llama.xcframework/.zood-${TAG}"

if [ -f "$STAMP" ]; then
  echo "[llama] llama.xcframework ${TAG} already present"
  exit 0
fi
mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "[llama] downloading llama.cpp ${TAG} XCFramework"
curl -fL --retry 3 -o "$TMP/llama.zip" "$URL"
if command -v sha256sum >/dev/null; then
  GOT="$(sha256sum "$TMP/llama.zip" | cut -d' ' -f1)"
else
  GOT="$(shasum -a 256 "$TMP/llama.zip" | cut -d' ' -f1)"
fi
if [ "$GOT" != "$SHA256" ]; then
  echo "[llama] ERROR: SHA-256 mismatch (expected $SHA256, got $GOT)" >&2
  exit 1
fi
unzip -q "$TMP/llama.zip" -d "$TMP/x"
rm -rf "$DEST/llama.xcframework"
mv "$TMP/x/build-apple/llama.xcframework" "$DEST/llama.xcframework"
touch "$STAMP"
echo "[llama] installed $DEST/llama.xcframework (${TAG}, sha256 verified)"
