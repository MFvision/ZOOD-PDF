#!/usr/bin/env bash
# One command: builds the WASM first, then lint / unit / typecheck / web+extension builds /
# core tests / Arabic acid gate / desktop tests / e2e. Prints GREEN or RED.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG_DIR="$ROOT/test-results/verify"
mkdir -p "$LOG_DIR"
FAILED=()
PASSED=()

step() {
  local name="$1"; shift
  local log="$LOG_DIR/${name// /_}.log"
  local t0=$SECONDS
  printf '%-28s' "$name"
  if "$@" >"$log" 2>&1; then
    printf 'ok   (%ss)\n' "$((SECONDS - t0))"
    PASSED+=("$name")
  else
    printf 'FAIL (%ss) — see %s\n' "$((SECONDS - t0))" "${log#"$ROOT"/}"
    tail -n 30 "$log" | sed 's/^/    │ /'
    FAILED+=("$name")
  fi
}

core() { (cd packages/core && "$@"); }

step "wasm build"          bash scripts/build-wasm.sh
step "ocr models"          bash scripts/fetch-ocr-models.sh
step "install"             pnpm install --frozen-lockfile
step "lint"                pnpm lint
step "typecheck"           pnpm typecheck
step "unit (vitest)"       pnpm -C packages/ui test
step "core fmt"            core cargo fmt --all -- --check
step "core clippy"         core cargo clippy --workspace --all-targets -- -D warnings
step "core tests"          core cargo test --workspace
step "arabic acid gate"    core cargo test -p warraq-text --test acid -- --nocapture
step "web build"           pnpm -C apps/web build
step "extension build"     pnpm -C apps/extension build
step "desktop tests"       bash -c 'cd apps/desktop/src-tauri && cargo test'
step "offline server tests" node --test scripts/package-web/serve.test.mjs
step "desktop smoke"       bash scripts/desktop-smoke.sh
step "ios strings"         python3 scripts/ios/check-strings.py
step "ios swift parse"     bash scripts/ios/parse-check.sh
step "ios engine (linux)"  bash scripts/ios/test-linux.sh
step "e2e (playwright)"    pnpm e2e

echo
echo "passed: ${#PASSED[@]}  failed: ${#FAILED[@]}"
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "GREEN"
  exit 0
else
  echo "RED: ${FAILED[*]}"
  exit 1
fi
