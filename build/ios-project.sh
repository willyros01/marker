#!/usr/bin/env bash
# The Marker — make the Xcode project (iPhone app + Apple Watch app), fresh.
# Used by build/ios-build.sh (TestFlight) and build/watch-check.sh (the watch
# simulator check). Runs on a GitHub Mac from the repository root.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
CAP=8.5.2
TMP="${RUNNER_TEMP:-/tmp}"

echo "--- Capacitor $CAP (installed for this build only)"
npm install --no-save --package-lock=false --no-audit --no-fund "@capacitor/cli@$CAP" "@capacitor/core@$CAP" "@capacitor/ios@$CAP" "@capacitor/app@8.1.1"
# The link piece must be listed in package.json, or "cap sync" leaves it out of
# the app and scanned links never reach it (0.8.3, Willy 29 Oct 2026).
npm pkg set "dependencies.@capacitor/app=8.1.1"

echo "--- The web files (same list as Android)"
rm -rf www && mkdir -p www
while IFS= read -r line; do
  line="${line%%#*}"; line="${line//[[:space:]]/}"
  [ -n "$line" ] || continue
  mkdir -p "www/$(dirname "$line")"; cp -R "${line%/}" "www/${line%/}"
done < build/www-files.txt
test -s www/index.html && test -s www/firebase-config.js

echo "--- The iOS project (fresh every build)"
rm -rf ios
npx cap add ios
npx cap sync ios 2>&1 | tee "$TMP/capsync.log"
grep -q "@capacitor/app" "$TMP/capsync.log" || { echo "RESULT: the link piece (@capacitor/app) is not in the app; links would not open it"; exit 1; }
cp build/ios/PrivacyInfo.xcprivacy ios/App/App/PrivacyInfo.xcprivacy
cp build/ios/App.entitlements ios/App/App/App.entitlements

# The app's own bridge with the WatchLink plugin ("Send to my watch", 0.9.0).
cp build/ios/native/MarkerViewController.swift build/ios/native/WatchLinkPlugin.swift ios/App/App/
SB=ios/App/App/Base.lproj/Main.storyboard
perl -pi -e 's/customClass="CAPBridgeViewController" customModule="Capacitor"/customClass="MarkerViewController" customModule="App" customModuleProvider="target"/' "$SB"
grep -q 'customClass="MarkerViewController"' "$SB" || { echo "RESULT: Main.storyboard was not pointed at MarkerViewController"; grep -n customClass "$SB" || true; exit 1; }

# The Apple Watch app (0.9.0).
rm -rf ios/App/MarkerWatch
cp -R build/ios/watch/MarkerWatch ios/App/MarkerWatch

echo "--- App icons (before the project is finished, so the watch target gets its icon) from icon.svg (square, no transparency, as Apple requires)"
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
WICON=ios/App/MarkerWatch/Assets.xcassets/AppIcon.appiconset
mkdir -p "$WICON"
cp "$TMP/icon.png" "$WICON/AppIcon-1024.png"
cat > ios/App/MarkerWatch/Assets.xcassets/Contents.json <<'JSON'
{ "info": { "author": "xcode", "version": 1 } }
JSON
cat > "$WICON/Contents.json" <<'JSON'
{ "images": [ { "filename": "AppIcon-1024.png", "idiom": "universal", "platform": "watchos", "size": "1024x1024" } ],
  "info": { "author": "xcode", "version": 1 } }
JSON
ruby -e 'require "xcodeproj"' 2>/dev/null || gem install xcodeproj --user-install --no-document
ruby build/ios/configure.rb
PLIST=ios/App/App/Info.plist
plutil -replace CFBundleDisplayName -string "The Marker" "$PLIST"
plutil -replace ITSAppUsesNonExemptEncryption -bool NO "$PLIST"
plutil -replace NSCameraUsageDescription -string "The Marker uses the camera to take a picture of the club's scorecard, so the course details can be read for you." "$PLIST"
plutil -replace NSPhotoLibraryUsageDescription -string "The Marker opens your photos so you can choose a picture of the club's scorecard to read the course details." "$PLIST"

echo "Project ready: iPhone app + Apple Watch app."
