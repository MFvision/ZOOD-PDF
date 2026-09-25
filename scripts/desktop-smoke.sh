#!/usr/bin/env bash
# Headless smoke test of the desktop app on Linux (WebKitGTK under Xvfb). Two runs of the
# debug binary, both with the custom-protocol feature (bundled assets, not devUrl):
#
#  1. ACL probe — the binary is built with frontendDist = apps/desktop/smoke/acl-probe, a
#     fixture page that tries forbidden IPC calls (fs outside the dialog scope, shell,
#     window close), eval/new Function/remote fetch (CSP) and the app's own commands, and
#     reports PROBE_OK only if every call behaves as the capabilities + CSP require.
#  2. UI — the real shared interface (apps/desktop/dist) must start and call app_ready.
#
# With ZOOD_SMOKE_EXIT_ON_READY=1 the Rust side prints the report and ZOOD_READY, then exits 0.
#
#   bash scripts/desktop-smoke.sh              # probe + UI
#   bash scripts/desktop-smoke.sh --probe-only # when the UI cannot be built
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$ROOT/apps/desktop"
TAURI="$DESKTOP/src-tauri"
TIMEOUT="${SMOKE_TIMEOUT:-90}"
BIN="$TAURI/target/debug/zood-pdf"
LOG_DIR="$ROOT/test-results/desktop-smoke"
PROBE_ONLY=0
[[ "${1:-}" == "--probe-only" ]] && PROBE_ONLY=1
mkdir -p "$LOG_DIR"

[[ "$(uname -s)" == "Linux" ]] || { echo "[smoke] Linux only (WebKitGTK under Xvfb)" >&2; exit 2; }
command -v xvfb-run >/dev/null 2>&1 || { echo "[smoke] xvfb-run missing" >&2; exit 2; }

# WebKitGTK in containers: no GPU, no user namespaces for its bubblewrap sandbox.
# These relaxations apply to this test process only, never to shipped builds.
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export LIBGL_ALWAYS_SOFTWARE=1
export NO_AT_BRIDGE=1
if [[ "$(id -u)" == 0 || -f /.dockerenv || -n "${CI:-}" ]]; then
  export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
fi

build_binary() { # $1 = frontendDist override (relative to src-tauri) or empty
  if [[ -n "$1" ]]; then
    (cd "$TAURI" && TAURI_CONFIG="{\"build\":{\"frontendDist\":\"$1\"}}" cargo build)
  else
    (cd "$TAURI" && cargo build)
  fi
  [[ -x "$BIN" ]] || { echo "[smoke] missing $BIN" >&2; exit 1; }
}

run_app() { # $1 = name; prints the report line; returns 0 when ZOOD_READY was printed
  local name="$1" code
  echo "[smoke] $name: launching under Xvfb (timeout ${TIMEOUT}s)"
  set +e
  ZOOD_SMOKE_EXIT_ON_READY=1 timeout --kill-after=10 "$TIMEOUT" \
    xvfb-run -a -s "-screen 0 1280x800x24" "$BIN" >"$LOG_DIR/$name.out.log" 2>"$LOG_DIR/$name.err.log"
  code=$?
  set -e
  if [[ $code -ne 0 ]] || ! grep -q '^ZOOD_READY$' "$LOG_DIR/$name.out.log"; then
    echo "[smoke] $name: FAILED (exit $code)" >&2
    tail -n 40 "$LOG_DIR/$name.out.log" "$LOG_DIR/$name.err.log" >&2
    return 1
  fi
}

echo "[smoke] 1/2 ACL + CSP probe"
build_binary "../smoke/acl-probe"
run_app probe
if ! grep -q '^ZOOD_REPORT PROBE_OK$' "$LOG_DIR/probe.out.log"; then
  echo "[smoke] probe: $(grep '^ZOOD_REPORT' "$LOG_DIR/probe.out.log" || echo 'no report')" >&2
  exit 1
fi
echo "[smoke] probe: OK (capabilities and CSP enforced in the real webview)"

if [[ "$PROBE_ONLY" == 1 ]]; then
  build_binary "" >/dev/null 2>&1 || true # leave the normal binary behind
  exit 0
fi

echo "[smoke] 2/2 real UI"
pnpm -C "$DESKTOP" build
if grep -q "UI not built" "$DESKTOP/dist/index.html" 2>/dev/null; then
  echo "[smoke] apps/desktop/dist is the placeholder page" >&2
  exit 1
fi
build_binary ""
run_app ui
if ! grep -q "^ZOOD_REPORT engine=ok$" "$LOG_DIR/ui.out.log"; then
  echo "[smoke] ui: engine self-check failed: $(grep "^ZOOD_REPORT" "$LOG_DIR/ui.out.log" || echo "no report")" >&2
  exit 1
fi
echo "[smoke] ui: OK (the interface rendered and the WASM engine answered in its worker)"
