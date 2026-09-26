#!/usr/bin/env bash
# Builds and tests the native iOS app on simulators and captures screenshots.
#
#   1. scripts/ios/build-core.sh          → apps/ios/Frameworks/WarraqCore.xcframework
#      scripts/ios/fetch-llama.sh         → apps/ios/Frameworks/llama.xcframework (pinned, device only)
#   2. xcodegen generate                   → apps/ios/ZoodPDF.xcodeproj
#   3. xcodebuild build-for-testing + test-without-building on an iPhone 17 and an
#      iPad Pro 13-inch (M4) simulator, each time-boxed (known trap: `xcodebuild test` can
#      hang after the last test bundle finishes, so we kill it and read the result bundle).
#   4. screenshots from the UI test (XCUIScreen attachments) + `simctl io screenshot`
#      → docs/design/ios/
#
# Env: IPHONE_SIM, IPAD_SIM (simulator names), TEST_TIMEOUT (seconds, default 1200),
#      SKIP_CORE=1 (reuse an existing XCFramework).
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "[ios] ERROR: the iOS app builds only on macOS with Xcode 26+ (found $(uname -s))." >&2
  echo "[ios] On Linux you can still run: bash scripts/ios/test-linux.sh" >&2
  exit 1
fi
command -v xcodebuild >/dev/null || { echo "[ios] ERROR: xcodebuild not found — install Xcode 26+" >&2; exit 1; }
command -v xcodegen >/dev/null || { echo "[ios] ERROR: xcodegen not found — brew install xcodegen" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IOS="$ROOT/apps/ios"
BUILD="$IOS/build"
SHOTS="$ROOT/docs/design/ios"
IPHONE_SIM="${IPHONE_SIM:-iPhone 17}"
IPAD_SIM="${IPAD_SIM:-iPad Pro 13-inch (M4)}"
TEST_TIMEOUT="${TEST_TIMEOUT:-1200}"
SCHEME="ZOOD PDF"
mkdir -p "$BUILD" "$SHOTS"

if [ "${SKIP_CORE:-0}" != "1" ] || [ ! -d "$IOS/Frameworks/WarraqCore.xcframework" ]; then
  bash "$ROOT/scripts/ios/build-core.sh"
fi
bash "$ROOT/scripts/ios/fetch-llama.sh"

echo "[ios] xcodegen generate"
( cd "$IOS" && xcodegen generate --spec project.yml )

sim_udid() {
  # First available simulator with exactly this name: "    iPhone 17 (UDID) (Shutdown)".
  xcrun simctl list devices available | grep -F "    $1 (" | head -n 1 |
    grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' | head -n 1 || true
}

# Run a command with a time box (macOS has no coreutils `timeout`). Returns 124 on timeout.
run_boxed() {
  local secs="$1"; shift
  "$@" &
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$secs" ]; then
      echo "[ios] time box of ${secs}s reached — stopping xcodebuild (PID $pid) and reading the result bundle" >&2
      kill "$pid" 2>/dev/null || true
      sleep 5
      kill -9 "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 5
    waited=$((waited + 5))
  done
  wait "$pid"
}

summary_of() {
  # Xcode 16+: `xcresulttool get test-results summary` prints JSON with result + counts.
  xcrun xcresulttool get test-results summary --path "$1" 2>/dev/null
}

OVERALL=0
for SIM in "$IPHONE_SIM" "$IPAD_SIM"; do
  UDID="$(sim_udid "$SIM")"
  if [ -z "$UDID" ]; then
    echo "[ios] ERROR: no available simulator named \"$SIM\". Create it in Xcode › Window › Devices and Simulators, or set IPHONE_SIM/IPAD_SIM. Available:" >&2
    xcrun simctl list devices available | grep -E "iPhone|iPad" >&2 || true
    exit 1
  fi
  SLUG="$(echo "$SIM" | tr ' ()' '-__' | tr -s '-_' | tr '[:upper:]' '[:lower:]')"
  DEST="platform=iOS Simulator,id=$UDID"
  RESULT="$BUILD/Results-$SLUG.xcresult"
  rm -rf "$RESULT"
  echo "[ios] === $SIM ($UDID) ==="
  xcrun simctl boot "$UDID" 2>/dev/null || true
  xcrun simctl bootstatus "$UDID" -b >/dev/null

  xcodebuild build-for-testing -project "$IOS/ZoodPDF.xcodeproj" -scheme "$SCHEME" \
    -destination "$DEST" -derivedDataPath "$BUILD/DerivedData" | tail -n 30

  set +e
  run_boxed "$TEST_TIMEOUT" xcodebuild test-without-building -project "$IOS/ZoodPDF.xcodeproj" \
    -scheme "$SCHEME" -destination "$DEST" -derivedDataPath "$BUILD/DerivedData" \
    -resultBundlePath "$RESULT" -test-timeouts-enabled YES -default-test-execution-time-allowance 300
  CODE=$?
  set -e

  SUMMARY="$BUILD/summary-$SLUG.json"
  if [ -d "$RESULT" ] && summary_of "$RESULT" > "$SUMMARY"; then
    RES="$(/usr/bin/plutil -extract result raw -o - "$SUMMARY" 2>/dev/null || echo unknown)"
    PASSED="$(/usr/bin/plutil -extract passedTests raw -o - "$SUMMARY" 2>/dev/null || echo "?")"
    FAILED="$(/usr/bin/plutil -extract failedTests raw -o - "$SUMMARY" 2>/dev/null || echo "?")"
    echo "[ios] $SIM: result=$RES passed=$PASSED failed=$FAILED (xcodebuild exit $CODE)"
    [ "$RES" = "Passed" ] || OVERALL=1
    # Screenshots attached by ZoodPDFUITests (XCUIScreen.main.screenshot()).
    ATT="$BUILD/attachments-$SLUG"
    rm -rf "$ATT"
    if xcrun xcresulttool export attachments --path "$RESULT" --output-path "$ATT" >/dev/null 2>&1; then
      mkdir -p "$SHOTS/$SLUG"
      if command -v python3 >/dev/null; then
        python3 - "$ATT" "$SHOTS/$SLUG" <<'PY'
import json, os, shutil, sys
src, dst = sys.argv[1], sys.argv[2]
manifest = json.load(open(os.path.join(src, "manifest.json")))
for test in manifest:
    for a in test.get("attachments", []):
        name = a.get("suggestedHumanReadableName") or a["exportedFileName"]
        shutil.copy(os.path.join(src, a["exportedFileName"]), os.path.join(dst, name))
PY
      else
        cp "$ATT"/*.png "$SHOTS/$SLUG/" 2>/dev/null || true
      fi
    fi
  else
    echo "[ios] $SIM: no readable result bundle (xcodebuild exit $CODE)" >&2
    OVERALL=1
  fi
  xcrun simctl io "$UDID" screenshot "$SHOTS/$SLUG-last-screen.png" >/dev/null 2>&1 || true
  xcrun simctl shutdown "$UDID" 2>/dev/null || true
done

if [ "$OVERALL" = "0" ]; then
  echo "[ios] GREEN — screenshots in docs/design/ios/"
else
  echo "[ios] RED — see $BUILD/Results-*.xcresult" >&2
fi
exit "$OVERALL"
