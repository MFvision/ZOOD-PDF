#!/usr/bin/env bash
# Builds warraq-core to WebAssembly into packages/ui/src/wasm/pkg.
# Uses a PRIVATE target dir inside this tree: a shared CARGO_TARGET_DIR hands back
# another worktree's WASM (known trap).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CARGO_TARGET_DIR="$ROOT/.target-wasm"
PROFILE="${WASM_PROFILE:---release}"
cd "$ROOT/packages/core/crates/warraq-core"
wasm-pack build $PROFILE --target web --out-dir "$ROOT/packages/ui/src/wasm/pkg" --out-name warraq_core --no-pack -- --features wasm
rm -f "$ROOT/packages/ui/src/wasm/pkg/.gitignore"
echo "[wasm] built $(du -h "$ROOT/packages/ui/src/wasm/pkg/warraq_core_bg.wasm" | cut -f1)"
