#!/usr/bin/env bash
# Read aloud, desktop native engines (apps/desktop/speech): fmt + clippy + unit tests on this
# machine, then type-check + clippy of the macOS (AVSpeechSynthesizer) and Windows
# (Windows.Media.SpeechSynthesis) engines for their targets. A check needs no SDK, so Linux can
# verify both; a target whose Rust std is not installed is reported and skipped
# (`rustup target add aarch64-apple-darwin x86_64-pc-windows-msvc`).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/desktop/speech"
# Share the desktop host's target dir (same dependencies, less disk).
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/apps/desktop/src-tauri/target}"
export CARGO_INCREMENTAL=0

cargo fmt -- --check
cargo clippy --all-targets -- -D warnings
cargo test

installed="$(rustup target list --installed 2>/dev/null || true)"
for target in aarch64-apple-darwin x86_64-pc-windows-msvc; do
  if grep -qx "$target" <<<"$installed"; then
    echo "[speech] clippy for $target"
    cargo clippy --all-targets --target "$target" -- -D warnings
  else
    echo "[speech] SKIPPED $target: Rust std for it is not installed"
  fi
done
echo "[speech] ok"
