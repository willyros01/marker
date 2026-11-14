#!/usr/bin/env bash
# Builds a copy of The Scorecard's Android app from a branch (read-only checkout
# in ./sca) exactly as golfers get it, talking to the LIVE Firebase and the live
# Cloudflare helper. Only difference: web debugging is on, so the test can read
# the screen. Debug-signed; never published; the branch is not changed.
set -Eeuo pipefail
cd sca
npm ci --no-audit --no-fund > /tmp/npm.log 2>&1 || { tail -40 /tmp/npm.log; exit 1; }
npm install --no-save --package-lock=false --no-audit --no-fund @capacitor/android@8.5.2 > /dev/null 2>&1
rm -rf www && mkdir -p www
while IFS= read -r line; do
  line="${line%%#*}"; line="${line//[[:space:]]/}"; [ -n "$line" ] || continue
  mkdir -p "www/$(dirname "$line")"; cp -R "${line%/}" "www/${line%/}"
done < build/www-files.txt
python3 - <<'PY'
from pathlib import Path
p = Path('www/index.html'); s = p.read_text()
needle = '<script type="module" src="./app.js"></script>'
s = s.replace(needle, '<script>window.__SCORECARD_NATIVE_ANDROID__=true;</script>\n  ' + needle, 1)
s = s.replace('var inApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());',
              'var inApp = window.__SCORECARD_NATIVE_ANDROID__ === true || !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());', 1)
p.write_text(s)
import json; c=json.load(open('capacitor.config.json')); c.setdefault('android',{})['webContentsDebuggingEnabled']=True
json.dump(c,open('capacitor.config.json','w'),indent=2); print('live copy: web debugging on (to read the screen); live Firebase and helper')
PY
npx cap add android > /tmp/cap.log 2>&1 && npx cap sync android >> /tmp/cap.log 2>&1 || { tail -40 /tmp/cap.log; exit 1; }
bash build/android-native.sh
java build/AndroidIcons.java android/app/src/main/res > /dev/null
cd android && chmod +x gradlew && ./gradlew --no-daemon -q assembleDebug
ls -la app/build/outputs/apk/debug/app-debug.apk
