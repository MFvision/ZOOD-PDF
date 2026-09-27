#!/bin/zsh
# Archives محرر PDF for iOS and uploads it to TestFlight.
#
# Needs, once, on this Mac: Xcode signed in to the Apple Developer account of
# team AWV883QWPU (Xcode → Settings → Accounts), and an app record in App
# Store Connect with bundle id app.warraq.ios. Signing is automatic: Xcode
# makes the distribution certificate and profiles itself (-allowProvisioningUpdates).
#
#   scripts/ios/testflight.sh            # build number = the current UTC minute
#   BUILD_NUMBER=42 scripts/ios/testflight.sh
set -euo pipefail
repo=${0:A:h:h:h}
cd "$repo/apps/ios"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
build=${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}
out="$repo/apps/ios/.build/testflight"
mkdir -p "$out"

"$repo/.tools/xcodegen/xcodegen/bin/xcodegen" generate --quiet

cat > "$out/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>AWV883QWPU</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
EOF

echo "== archiving build $build"
xcodebuild -project PDFEditor.xcodeproj -scheme PDFEditor -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$out/PDFEditor.xcarchive" \
  -allowProvisioningUpdates CURRENT_PROJECT_VERSION="$build" archive | tail -20

echo "== uploading to TestFlight"
xcodebuild -exportArchive -archivePath "$out/PDFEditor.xcarchive" \
  -exportOptionsPlist "$out/ExportOptions.plist" -exportPath "$out/export" \
  -allowProvisioningUpdates | tail -20
echo "uploaded build $build — it appears in App Store Connect → TestFlight after processing (10–30 min)"
