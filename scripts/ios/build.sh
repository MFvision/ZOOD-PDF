#!/bin/zsh
# Generates the Xcode project from apps/ios/project.yml, builds the app for
# the iPhone 17 and iPad Pro 13-inch (M5) simulators, runs the unit and UI
# tests on both, and writes the UI tests' screenshots to docs/design/ios/.
#
#   scripts/ios/build.sh                 # everything
#   scripts/ios/build.sh --no-test       # generate and build only
#   scripts/ios/build.sh --unit          # unit tests only (no screenshots)
#   scripts/ios/build.sh --iphone|--ipad # one simulator
#
# Needs apps/ios/Vendor/WarraqCore.xcframework (scripts/ios/build-core.sh).
# Run through the machine-wide queue (~/Developer/warraq/.tools/one-at-a-time.sh)
# with an 8 GB Mac shared by several agents. DerivedData stays inside the
# checkout (apps/ios/.build/DerivedData, git-ignored): delete it when done.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
ios="$repo/apps/ios"
derived="$ios/.build/DerivedData"
shots="$repo/docs/design/ios"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
xcodegen_bin="${XCODEGEN:-$HOME/Developer/warraq/.tools/xcodegen/xcodegen/bin/xcodegen}"

run_tests=1
unit_only=0
devices=("iPhone 17" "iPad Pro 13-inch (M5)")
for arg in "$@"; do
  case "$arg" in
    --no-test) run_tests=0 ;;
    --unit) unit_only=1 ;;
    --iphone) devices=("iPhone 17") ;;
    --ipad) devices=("iPad Pro 13-inch (M5)") ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done

if [ ! -d "$ios/Vendor/WarraqCore.xcframework" ]; then
  echo "apps/ios/Vendor/WarraqCore.xcframework is missing: run scripts/ios/build-core.sh first" >&2
  exit 1
fi

echo "== xcodegen"
(cd "$ios" && "$xcodegen_bin" generate --quiet)

# xcodebuild's own log is long; keep it, print only what matters.
logs="${WARRAQ_LOGS:-$ios/.build/logs}"
mkdir -p "$logs" "$shots"

xcb() {
  /usr/bin/xcodebuild -project "$ios/PDFEditor.xcodeproj" -scheme PDFEditor \
    -derivedDataPath "$derived" -skipPackagePluginValidation \
    -parallelizeTargets "$@"
}

summarize() {
  # The lines that say whether it built and what the tests did.
  grep -E "^(\*\* .* (SUCCEEDED|FAILED) \*\*|Test Suite .* (passed|failed)|Executed [0-9]+ tests?|error:|.*Test Case .*(passed|failed) \([0-9.]+ seconds\))" "$1" | sed 's/^[[:space:]]*//' | sort -u | head -80 || true
}

for device in "${devices[@]}"; do
  dest="platform=iOS Simulator,name=$device"
  slug="$(echo "$device" | tr -c 'A-Za-z0-9\n' '-' | tr -s '-' | sed 's/-$//')"
  echo "== build for $device"
  log="$logs/build-$slug.log"
  xcb build-for-testing -destination "$dest" > "$log" 2>&1 || { summarize "$log"; echo "build failed; log: $log" >&2; exit 1; }
  summarize "$log"

  if [ "$run_tests" = "1" ]; then
    echo "== test on $device"
    log="$logs/test-$slug.log"
    only=()
    if [ "$unit_only" = "1" ]; then
      only=(-only-testing:PDFEditorTests)
    fi
    # The app-lock UI test needs a face: the simulator enrols one, and a
    # helper answers every Face ID prompt with a match while the tests run
    # (the simulator has no sensor; this is what its Features menu does).
    udid="$(/usr/bin/xcrun simctl list devices available -j | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next((x["udid"] for v in d["devices"].values() for x in v if x["name"]==sys.argv[1]), ""))' "$device")"
    matcher=""
    if [ -n "$udid" ] && [ "$unit_only" = "0" ]; then
      /usr/bin/xcrun simctl spawn "$udid" notifyutil -s com.apple.BiometricKit.enrollmentChanged 1 -p com.apple.BiometricKit.enrollmentChanged >/dev/null 2>&1 || true
      ( while true; do /usr/bin/xcrun simctl spawn "$udid" notifyutil -p com.apple.BiometricKit_Sim.pearl.match >/dev/null 2>&1; sleep 1; done ) &
      matcher=$!
    fi
    # TEST_RUNNER_ variables in xcodebuild's environment reach the test
    # process's environment, without the prefix.
    TEST_RUNNER_WARRAQ_SCREENSHOT_DIR="$shots" TEST_RUNNER_WARRAQ_DEVICE_SLUG="$slug" TEST_RUNNER_WARRAQ_FACEID_DRIVER="${matcher:+1}" \
      xcb test-without-building -destination "$dest" "${only[@]}" > "$log" 2>&1 || { [ -n "$matcher" ] && kill "$matcher" 2>/dev/null; summarize "$log"; echo "tests failed; log: $log" >&2; exit 1; }
    [ -n "$matcher" ] && kill "$matcher" 2>/dev/null
    summarize "$log"
  fi
done

echo "== done"
if [ "$run_tests" = "1" ] && [ "$unit_only" = "0" ]; then
  ls -1 "$shots" | sed 's/^/   /'
fi
