#!/usr/bin/env bash
# iPhone simulator, LIVE (Willy, 13 Nov 2026): The Scorecard from a branch
# (read-only in ./sc), built as golfers get it, talking to the live Firebase
# and the live Cloudflare helper. Only difference: Web Inspector is on, so the
# test can read the screen. usage: bash live-email-ios.sh ADDRESS
set -Euo pipefail
ROOT="$PWD"; OUT="$ROOT/out"; mkdir -p "$OUT"
cd sc
npm ci --no-audit --no-fund > /tmp/npm.log 2>&1 || { tail -40 /tmp/npm.log; exit 1; }
rm -rf www && mkdir -p www
while IFS= read -r line; do
  line="${line%%#*}"; line="${line//[[:space:]]/}"; [[ -n "$line" ]] || continue
  mkdir -p "www/$(dirname "$line")"; cp -R "${line%/}" "www/${line%/}"
done < build/www-files.txt
python3 - <<'PY'
import json
c = json.load(open('capacitor.config.json')); c.setdefault('ios', {})['webContentsDebuggingEnabled'] = True
json.dump(c, open('capacitor.config.json', 'w'), indent=2)
print('iPhone live copy: Web Inspector on; live Firebase and helper')
PY
rm -rf ios; npx cap add ios > /tmp/cap.log 2>&1 && npx cap sync ios >> /tmp/cap.log 2>&1 || { tail -40 /tmp/cap.log; exit 1; }
cp build/ios/PrivacyInfo.xcprivacy ios/App/App/PrivacyInfo.xcprivacy
cp build/ios/App.entitlements ios/App/App/App.entitlements
ruby -e 'require "xcodeproj"' 2>/dev/null || gem install xcodeproj --user-install --no-document > /dev/null
ruby build/ios/configure.rb
UDID="$(xcrun simctl list devices available -j | node -e '
  const d=JSON.parse(require("fs").readFileSync(0)).devices; let best=null;
  for (const [rt,list] of Object.entries(d)) if (/iOS/.test(rt)) for (const x of list) if (/^iPhone \d+$/.test(x.name)) best=x;
  console.log(best.udid);')"
export UDID
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -destination "id=$UDID" -derivedDataPath /tmp/ddf \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=YES CODE_SIGNING_ALLOWED=YES build > /tmp/xcbf.log 2>&1 || { tail -60 /tmp/xcbf.log; exit 1; }
APP="$(find /tmp/ddf/Build/Products -maxdepth 2 -name 'App.app' | head -1)"
xcrun simctl boot "$UDID" || true; xcrun simctl bootstatus "$UDID" -b > /dev/null
SOCK="$(lsof -aUc launchd_sim 2>/dev/null | grep -o '/private/tmp/com.apple.launchd[^ ]*/com.apple.webinspectord_sim.socket' | head -1)"
nohup ios_webkit_debug_proxy -s "unix:$SOCK" -F > /tmp/iwdp.log 2>&1 &
sleep 3
cd "$ROOT"
node build/device/live-email-ios.mjs "$OUT" "$APP" "$1"
