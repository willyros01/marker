#!/usr/bin/env bash
# The Marker — build the iPhone app and upload it to TestFlight.
# Run by .github/workflows/ios-testflight.yml on a GitHub Mac. Modelled on The
# Scorecard's build. Needs the secrets ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8,
# APPLE_TEAM_ID, and RUN_NUMBER (the build number, rising every run).
set -Eeuo pipefail
cd "$(dirname "$0")/.."
CAP=8.5.2
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
echo "--- 2. Capacitor $CAP (installed for this build only)"
npm install --no-save --package-lock=false --no-audit --no-fund "@capacitor/cli@$CAP" "@capacitor/core@$CAP" "@capacitor/ios@$CAP"

echo "--- 3. The web files (same list as Android)"
rm -rf www && mkdir -p www
while IFS= read -r line; do
  line="${line%%#*}"; line="${line//[[:space:]]/}"
  [ -n "$line" ] || continue
  mkdir -p "www/$(dirname "$line")"; cp -R "${line%/}" "www/${line%/}"
done < build/www-files.txt
test -s www/index.html && test -s www/firebase-config.js

echo "--- 4. The iOS project (fresh every build)"
rm -rf ios
npx cap add ios
npx cap sync ios
cp build/ios/PrivacyInfo.xcprivacy ios/App/App/PrivacyInfo.xcprivacy
ruby -e 'require "xcodeproj"' 2>/dev/null || gem install xcodeproj --user-install --no-document
ruby build/ios/configure.rb
PLIST=ios/App/App/Info.plist
plutil -replace CFBundleDisplayName -string "The Marker" "$PLIST"
plutil -replace ITSAppUsesNonExemptEncryption -bool NO "$PLIST"
plutil -replace NSCameraUsageDescription -string "The Marker uses the camera to take a picture of the club's scorecard, so the course details can be read for you." "$PLIST"
plutil -replace NSPhotoLibraryUsageDescription -string "The Marker opens your photos so you can choose a picture of the club's scorecard to read the course details." "$PLIST"

echo "--- 5. App icon from icon.svg (square, no transparency, as Apple requires)"
command -v rsvg-convert >/dev/null || HOMEBREW_NO_AUTO_UPDATE=1 brew install librsvg >/dev/null
rsvg-convert -w 1024 -h 1024 -b "#2E5541" icon.svg -o "$TMP/icon-a.png"
sips -s format jpeg -s formatOptions 100 "$TMP/icon-a.png" --out "$TMP/icon.jpg" >/dev/null
sips -s format png "$TMP/icon.jpg" --out "$TMP/icon.png" >/dev/null
sips -g hasAlpha "$TMP/icon.png" | grep -q "hasAlpha: no" || { echo "RESULT: the icon still has transparency"; exit 1; }
ICONSET=ios/App/App/Assets.xcassets/AppIcon.appiconset
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
cp "$TMP/icon.png" "$ICONSET/AppIcon-1024.png"
cat > "$ICONSET/Contents.json" <<'JSON'
{ "images": [ { "filename": "AppIcon-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024" } ],
  "info": { "author": "xcode", "version": 1 } }
JSON

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
  PRODUCT_BUNDLE_IDENTIFIER=io.github.willyros01.marker \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" \
  > "$TMP/xcodebuild.log" 2>&1 || { tail -n 80 "$TMP/xcodebuild.log"; echo "RESULT: failed at archive"; exit 1; }
tail -n 3 "$TMP/xcodebuild.log"

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
