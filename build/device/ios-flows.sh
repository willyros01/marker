#!/usr/bin/env bash
# iPhone simulator flows (Willy, 23 Oct 2026): a TEST copy of The Scorecard
# (v2, read-only in ./sc) that talks only to the Firebase emulators on this
# machine, driven through Safari's Web Inspector. Nothing live is touched.
set -Euo pipefail
ROOT="$PWD"; OUT="$ROOT/out-ios"; mkdir -p "$OUT"
cd sc
npm ci --no-audit --no-fund > /tmp/npm.log 2>&1 || { tail -40 /tmp/npm.log; exit 1; }
rm -rf www && mkdir -p www
while IFS= read -r line; do
  line="${line%%#*}"; line="${line//[[:space:]]/}"; [[ -n "$line" ]] || continue
  mkdir -p "www/$(dirname "$line")"; cp -R "${line%/}" "www/${line%/}"
done < build/www-files.txt
python3 - <<'PY'
from pathlib import Path
import json
st = Path('www/store.js'); t = st.read_text()
old = 'new URLSearchParams(location.search).has("emulators")'
assert t.count(old) == 1; st.write_text(t.replace(old, 'true /* device test copy: emulators only */', 1))
pl = Path('www/platform.js'); u = pl.read_text()
old = 'export function onLink(handler) {'
assert u.count(old) == 1
# Test copy only: the test hands a link to the app the same way iOS does (appUrlOpen).
u = u.replace(old, old + '\n  globalThis.__testOpenLink = (url) => { if (takeLink(url)) handler(); return true; };', 1)
pl.write_text(u)
c = json.load(open('capacitor.config.json')); c.setdefault('ios', {})['webContentsDebuggingEnabled'] = True
json.dump(c, open('capacitor.config.json', 'w'), indent=2)
print('iPhone test copy: emulators only, Web Inspector on')
PY
rm -rf ios; npx cap add ios > /tmp/cap.log 2>&1 && npx cap sync ios >> /tmp/cap.log 2>&1 || { tail -40 /tmp/cap.log; exit 1; }
cp build/ios/PrivacyInfo.xcprivacy ios/App/App/PrivacyInfo.xcprivacy
cp build/ios/App.entitlements ios/App/App/App.entitlements
ruby -e 'require "xcodeproj"' 2>/dev/null || gem install xcodeproj --user-install --no-document > /dev/null
ruby build/ios/configure.rb
PL=ios/App/App/Info.plist
plutil -replace NSAppTransportSecurity -json '{"NSAllowsLocalNetworking":true}' "$PL"
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
echo "Web Inspector socket: ${SOCK:-not found}"
nohup ios_webkit_debug_proxy -s "unix:$SOCK" -F > /tmp/iwdp.log 2>&1 &
sleep 3
cd "$ROOT"
node build/device/flows-ios.mjs "$OUT" "$APP"
