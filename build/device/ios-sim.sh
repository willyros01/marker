#!/usr/bin/env bash
# Device tests, step 1 (Willy, 23 Oct 2026): build The Scorecard (v2 branch,
# read-only copy in ./sc) for the iPhone SIMULATOR, install it fresh, open each
# kind of link the way a tap does, and take a screenshot of what appears.
# Nothing is signed for Apple, nothing is uploaded, nothing is written to the
# live database (the links use made-up codes, so no account is created).
set -Euo pipefail
OUT="$PWD/out"; mkdir -p "$OUT"
log(){ echo "$*" | tee -a "$OUT/report.txt"; }
cd sc
log "The Scorecard v2 at $(git rev-parse --short HEAD), version $(grep -oE 'APP_VERSION = "[^"]+"' version.js)"

echo "--- web files into www/"
npm ci --no-audit --no-fund > /tmp/npm.log 2>&1 || { tail -40 /tmp/npm.log; exit 1; }
rm -rf www && mkdir -p www
while IFS= read -r line; do
  line="${line%%#*}"; line="${line//[[:space:]]/}"; [[ -n "$line" ]] || continue
  mkdir -p "www/$(dirname "$line")"; cp -R "${line%/}" "www/${line%/}"
done < build/www-files.txt

echo "--- Xcode project"
rm -rf ios; npx cap add ios > /tmp/cap.log 2>&1 && npx cap sync ios >> /tmp/cap.log 2>&1 || { tail -40 /tmp/cap.log; exit 1; }
cp build/ios/PrivacyInfo.xcprivacy ios/App/App/PrivacyInfo.xcprivacy
cp build/ios/App.entitlements ios/App/App/App.entitlements
ruby -e 'require "xcodeproj"' 2>/dev/null || gem install xcodeproj --user-install --no-document > /dev/null
ruby build/ios/configure.rb
plutil -replace CFBundleDisplayName -string "The Scorecard" ios/App/App/Info.plist

echo "--- pick a simulator"
UDID="$(xcrun simctl list devices available -j | node -e '
  const d=JSON.parse(require("fs").readFileSync(0)).devices; let best=null;
  for (const [rt,list] of Object.entries(d)) if (/iOS/.test(rt)) for (const x of list) if (/^iPhone \d+$/.test(x.name)) best={rt,...x};
  if(!best) process.exit(1); console.error(best.rt+" "+best.name); console.log(best.udid);')"
log "Simulator: $(xcrun simctl list devices | grep "$UDID" | sed 's/^ *//')"

echo "--- build for the simulator"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination "id=$UDID" -derivedDataPath /tmp/dd \
  DEVELOPMENT_TEAM=VXMLKHF72B CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- PROVISIONING_PROFILE_SPECIFIER= \
  CODE_SIGNING_REQUIRED=YES CODE_SIGNING_ALLOWED=YES \
  build > /tmp/xcb.log 2>&1 || { tail -60 /tmp/xcb.log; log "RESULT: simulator build failed"; exit 1; }
APP="$(find /tmp/dd/Build/Products -maxdepth 2 -name 'App.app' | head -1)"
log "Built: $APP"
XCENT="$(find /tmp/dd/Build/Intermediates.noindex -name '*.app-Simulated.xcent' | head -1)"
log "Simulator entitlements built in: $( [ -n "$XCENT" ] && plutil -convert json -o - "$XCENT" 2>/dev/null || echo none)"
# The simulator honours app links only if the app carries its entitlements.
# The website's app-link file names the app as VXMLKHF72B.io.github.willyros01.scorecard,
# so the simulator copy carries that identity too (no Apple signing needed).
cat > /tmp/sim.entitlements <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>application-identifier</key><string>VXMLKHF72B.io.github.willyros01.scorecard</string>
  <key>com.apple.developer.team-identifier</key><string>VXMLKHF72B</string>
  <key>com.apple.developer.associated-domains</key><array><string>applinks:www.cuberoot-systems.com</string></array>
</dict></plist>
XML
codesign --force --sign - --entitlements /tmp/sim.entitlements --timestamp=none "$APP"
log "Entitlements in the test app:"; codesign -d --entitlements :- "$APP" 2>/dev/null | tr -d '\n\t' | grep -o 'applinks:[^<]*' | sed 's/^/  /' | tee -a "$OUT/report.txt" || log "  (none found)"

xcrun simctl boot "$UDID" || true
xcrun simctl bootstatus "$UDID" -b
BID=io.github.willyros01.scorecard
APIKEY="$(grep -oE 'apiKey: *"[^"]+"' firebase-config.js | head -1 | sed -E 's/.*"([^"]+)"/\1/')"
JOIN="https://www.cuberoot-systems.com/scorecard/join/"
enc(){ node -e 'console.log(encodeURIComponent(process.argv[1]))' "$1"; }

shot(){ # name
  sleep "${WAIT:-10}"
  xcrun simctl io "$UDID" screenshot "$OUT/$1.png" > /dev/null 2>&1 && log "  screenshot: $1.png"
}
fresh(){ # reinstall the app, nothing running
  xcrun simctl terminate "$UDID" com.apple.mobilesafari > /dev/null 2>&1 || true
  xcrun simctl uninstall "$UDID" "$BID" > /dev/null 2>&1 || true
  xcrun simctl install "$UDID" "$APP"
  sleep 15   # let iOS fetch the website's app-link file for the new install
  ( xcrun simctl spawn "$UDID" swcutil show 2>&1 || xcrun simctl spawn "$UDID" /usr/bin/swcutil show 2>&1 ) | grep -i -B3 -A8 "cuberoot" | head -24 | sed 's/^/    swc: /' >> "$OUT/report.txt" || echo "    swc: (no app-link record found)" >> "$OUT/report.txt"
}

log ""
log "S0 Fresh install, open the app from the home screen"
fresh; xcrun simctl launch "$UDID" "$BID" > /dev/null; shot s0-launch

log "S1 Invitation link (as sent today), app installed"
fresh; xcrun simctl openurl "$UDID" "${JOIN}?join=TESTGROUP.faketoken&v=2"; shot s1-invitation

log "S2 Approval email link (as Firebase sends it today), app installed"
CONT="${JOIN}?apply=1&approved=1&e=$(enc device.test@example.com)"
fresh; xcrun simctl openurl "$UDID" "https://scorecard-f41b8.firebaseapp.com/__/auth/action?mode=signIn&oobCode=FAKECODE&apiKey=${APIKEY}&continueUrl=$(enc "$CONT")&lang=en"; shot s2-approval-email

log "S3 Approval email link pointing straight at the join page (the planned fix), app installed"
fresh; xcrun simctl openurl "$UDID" "${CONT}&mode=signIn&oobCode=FAKECODE&apiKey=${APIKEY}"; shot s3-approval-fixed

log "S4 Invitation link with the app NOT installed"
xcrun simctl terminate "$UDID" com.apple.mobilesafari > /dev/null 2>&1 || true
xcrun simctl uninstall "$UDID" "$BID" > /dev/null 2>&1 || true
xcrun simctl openurl "$UDID" "${JOIN}?join=TESTGROUP.faketoken&v=2"; shot s4-not-installed

log "RESULT: finished"
