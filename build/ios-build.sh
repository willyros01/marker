#!/usr/bin/env bash
# The Marker — build the iPhone app and upload it to TestFlight.
# Run by .github/workflows/ios-testflight.yml on a GitHub Mac. Modelled on The
# Scorecard's build. Needs the secrets ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8,
# APPLE_TEAM_ID, and RUN_NUMBER (the build number, rising every run).
set -Eeuo pipefail
cd "$(dirname "$0")/.."
for v in ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8 APPLE_TEAM_ID; do
  [ -n "${!v:-}" ] || { echo "RESULT: not started — the Apple secret $v is not set."; exit 1; }
done
TMP="${RUNNER_TEMP:-/tmp}"
VERSION="$(grep -oE 'APP_VERSION = "[0-9]+\.[0-9]+\.[0-9]+"' version.js | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
[ -n "$VERSION" ] || { echo "RESULT: version.js has no X.Y.Z version"; exit 1; }
BUILD="${RUN_NUMBER:-1}"
echo "Building The Marker $VERSION, build $BUILD"

echo "--- 1. Tests"
npm test
echo "--- 2. The Xcode project: iPhone app + Apple Watch app"
bash build/ios-project.sh

echo "--- 6. App Store Connect key (this build machine only)"
mkdir -p "$TMP/keys"
KEY="$TMP/keys/AuthKey_${ASC_KEY_ID}.p8"
printf '%s\n' "$ASC_KEY_P8" > "$KEY"
trap 'rm -rf "$TMP/keys"; cp "$TMP/xcodebuild.log" xcodebuild.log 2>/dev/null || true' EXIT
AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$KEY" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")

echo "--- 7. Archive"
xcodebuild archive -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination "generic/platform=iOS" -archivePath "$TMP/App.xcarchive" "${AUTH[@]}" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY="-" AD_HOC_CODE_SIGNING_ALLOWED=YES \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" \
  > "$TMP/xcodebuild.log" 2>&1 || { tail -n 80 "$TMP/xcodebuild.log"; echo "RESULT: failed at archive"; exit 1; }
tail -n 3 "$TMP/xcodebuild.log"
test -d "$TMP/App.xcarchive/Products/Applications/App.app/Watch/MarkerWatch.app" \
  || { echo "RESULT: the Apple Watch app is not inside the archive"; exit 1; }
echo "The Apple Watch app is inside the archive."
test -f "$TMP/App.xcarchive/Products/Applications/App.app/Watch/MarkerWatch.app/Assets.car" \
  || { echo "RESULT: the Apple Watch app has no icon"; exit 1; }

cat > "$TMP/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>${APPLE_TEAM_ID}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST
echo "--- 8. Sign for the App Store and upload to TestFlight"
xcodebuild -exportArchive -archivePath "$TMP/App.xcarchive" -exportOptionsPlist "$TMP/ExportOptions.plist" \
  -exportPath "$TMP/upload" "${AUTH[@]}" >> "$TMP/xcodebuild.log" 2>&1 \
  || { tail -n 60 "$TMP/xcodebuild.log"; echo "RESULT: failed at upload"; exit 1; }
echo "RESULT: success — The Marker $VERSION build $BUILD uploaded to TestFlight."
