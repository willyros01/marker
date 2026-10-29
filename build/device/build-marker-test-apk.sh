#!/usr/bin/env bash
# Builds a TEST copy of The Marker for Android that talks only to the Firebase
# emulators on this machine, in the same test project as The Scorecard's test
# copy (demo-scorecard), so a posted card can be seen arriving. Debug-signed;
# never published.
set -Eeuo pipefail
CAP=8.5.2
rm -rf /tmp/mk && mkdir -p /tmp/mk && git archive HEAD | tar -x -C /tmp/mk && cd /tmp/mk
npm install --no-save --package-lock=false --no-audit --no-fund "@capacitor/cli@$CAP" "@capacitor/core@$CAP" "@capacitor/android@$CAP" "@capacitor/app@8.1.1" > /dev/null 2>&1
mkdir -p www
while IFS= read -r line; do
  line="${line%%#*}"; line="${line//[[:space:]]/}"; [ -n "$line" ] || continue
  mkdir -p "www/$(dirname "$line")"; cp -R "${line%/}" "www/${line%/}"
done < build/www-files.txt
python3 - <<'PY'
from pathlib import Path
st = Path('www/store.js'); t = st.read_text()
old = 'new URLSearchParams(location.search).has("emulators")'
assert t.count(old) == 1, 'emulator switch not found'
t = t.replace(old, 'true /* device test copy: emulators only */', 1)
assert t.count('projectId: "demo-marker"') == 1
t = t.replace('projectId: "demo-marker"', 'projectId: "demo-scorecard"', 1)
st.write_text(t)
import json; c = json.load(open('capacitor.config.json')); c.setdefault('android', {}).update(allowMixedContent=True, webContentsDebuggingEnabled=True)
json.dump(c, open('capacitor.config.json', 'w'), indent=2)
print('Marker test copy: emulators only, test project demo-scorecard')
PY
npx cap add android > /tmp/mcap.log 2>&1 && npx cap sync android >> /tmp/mcap.log 2>&1 || { tail -40 /tmp/mcap.log; exit 1; }
bash build/android-native.sh
python3 - <<'PY'
p='android/app/src/main/AndroidManifest.xml'; s=open(p).read()
s=s.replace('<application','<application android:usesCleartextTraffic="true"',1); open(p,'w').write(s)
PY
(cd android && chmod +x gradlew && ./gradlew --no-daemon -q assembleDebug)
cp android/app/build/outputs/apk/debug/app-debug.apk /tmp/marker-test.apk && ls -la /tmp/marker-test.apk
