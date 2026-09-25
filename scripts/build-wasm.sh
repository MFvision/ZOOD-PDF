#!/usr/bin/env bash
# Builds warraq-core to WebAssembly into packages/ui/src/wasm/pkg.
# Uses a PRIVATE target dir inside this tree: a shared CARGO_TARGET_DIR hands back
# another worktree's WASM (known trap).
#   WASM_PROFILE=--dev bash scripts/build-wasm.sh   # faster, unoptimised
#   WASM_FEATURES=wasm,render bash scripts/build-wasm.sh   # include hayro page rendering
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CARGO_TARGET_DIR="$ROOT/.target-wasm"
PROFILE="${WASM_PROFILE:---release}"
FEATURES="${WASM_FEATURES:-wasm}"
PATH="$HOME/.cargo/bin:$PATH"
OUT="$ROOT/packages/ui/src/wasm/pkg"
cd "$ROOT/packages/core/crates/warraq-core"
# --no-default-features: the C ABI (feature "ffi") is for iOS only.
wasm-pack build $PROFILE --target web --out-dir "$OUT" --out-name warraq_core --no-pack \
  -- --no-default-features --features "$FEATURES"
rm -f "$OUT/.gitignore"
WASM_OPT_BIN="${WASM_OPT:-$(command -v wasm-opt || true)}"
if [ "$PROFILE" = "--release" ] && [ -n "$WASM_OPT_BIN" ]; then
  "$WASM_OPT_BIN" -Os --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals "$OUT/warraq_core_bg.wasm" -o "$OUT/warraq_core_bg.wasm.opt"
  mv "$OUT/warraq_core_bg.wasm.opt" "$OUT/warraq_core_bg.wasm"
  echo "[wasm] wasm-opt -Os applied ($WASM_OPT_BIN)"
elif [ "$PROFILE" = "--release" ]; then
  echo "[wasm] wasm-opt not found (set WASM_OPT=/path/to/wasm-opt): skipped, output is ~10-20% larger"
fi
echo "[wasm] built $(du -h "$OUT/warraq_core_bg.wasm" | cut -f1) ($(stat -c %s "$OUT/warraq_core_bg.wasm" 2>/dev/null || stat -f %z "$OUT/warraq_core_bg.wasm") bytes)"
