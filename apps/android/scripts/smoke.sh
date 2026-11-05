#!/usr/bin/env bash
# Smoke test on an emulator (.github/workflows/android.yml): install, start,
# open a PDF the way another app's "Open with" does, and keep pictures, the
# screen's text and the log. Writes <shots>/ok when the app came up and stayed up.
set -u
out=$1
shots=$2
mkdir -p "$shots"
apk=$(ls "$out"/*.apk | head -1)
pkg=sa.zood.pdf

adb install -r "$apk" || exit 1
adb logcat -c
adb shell am start -W -n "$pkg/.MainActivity"
sleep 30
adb exec-out screencap -p > "$shots/1-home.png"
adb shell uiautomator dump /sdcard/home.xml >/dev/null 2>&1 && adb pull /sdcard/home.xml "$shots/1-home.xml" >/dev/null 2>&1

# A PDF from the repo's own test files, handed over as a content:// file.
pdf=tests/fixtures/edit/tajawal-subset.pdf
if [ -f "$pdf" ]; then
  adb push "$pdf" /sdcard/Download/zood-smoke.pdf >/dev/null
  adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/zood-smoke.pdf >/dev/null
  sleep 4
  id=$(adb shell content query --uri content://media/external/file --projection _id --where "_display_name=\'zood-smoke.pdf\'" | sed -n 's/.*_id=\([0-9]*\).*/\1/p' | head -1)
  echo "media id: $id"
  if [ -n "$id" ]; then
    adb shell am start -W -a android.intent.action.VIEW -t application/pdf --grant-read-uri-permission \
      -d "content://media/external/file/$id" -n "$pkg/.MainActivity"
    sleep 15
    adb exec-out screencap -p > "$shots/2-opened.png"
    adb shell uiautomator dump /sdcard/opened.xml >/dev/null 2>&1 && adb pull /sdcard/opened.xml "$shots/2-opened.xml" >/dev/null 2>&1
  fi
fi

# Back closes, then the app steps aside (still alive).
adb shell input keyevent KEYCODE_BACK
sleep 2
adb exec-out screencap -p > "$shots/3-back.png"

adb logcat -d > "$shots/logcat.txt"
grep -E "chromium|Console|ZOOD|AndroidRuntime" "$shots/logcat.txt" | tail -200 > "$shots/console.txt" || true

if grep -q "FATAL EXCEPTION" "$shots/logcat.txt"; then
  echo "The app crashed:"; grep -A20 "FATAL EXCEPTION" "$shots/logcat.txt" | head -40
  exit 0
fi
if grep -q "falling back to the mock core" "$shots/logcat.txt"; then
  echo "The engine did not load in this WebView:"; grep "mock core" "$shots/logcat.txt" | head -3
  exit 0
fi
if adb shell pidof "$pkg" >/dev/null; then
  touch "$shots/ok"
fi
exit 0
