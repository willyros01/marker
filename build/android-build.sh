#!/usr/bin/env bash
# The Marker for Android: the same web files as the website, in a Capacitor
# shell, signed with the permanent key. Runs only in GitHub Actions.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
CAP=8.5.2
npm test
npm install --no-save --package-lock=false --no-audit --no-fund "@capacitor/cli@$CAP" "@capacitor/core@$CAP" "@capacitor/android@$CAP" "@capacitor/app@8.1.1"
# The link piece must be listed in package.json, or "cap sync" leaves it out of
# the app and scanned links never reach it (0.8.3, Willy 29 Oct 2026).
npm pkg set "dependencies.@capacitor/app=8.1.1"
rm -rf www android
mkdir -p www
while IFS= read -r line; do
  line="${line%%#*}"; line="${line//[[:space:]]/}"
  [ -n "$line" ] || continue
  mkdir -p "www/$(dirname "$line")"
  cp -R "${line%/}" "www/${line%/}"
done < build/www-files.txt
test -s www/index.html && test -s www/firebase-config.js && test -s www/vendor/firebase/firebase-10.12.0.js
npx cap add android
npx cap sync android 2>&1 | tee "${RUNNER_TEMP:-/tmp}/capsync.log"
grep -q "@capacitor/app" "${RUNNER_TEMP:-/tmp}/capsync.log" || { echo "RESULT: the link piece (@capacitor/app) is not in the app; links would not open it"; exit 1; }
bash build/android-native.sh
export MARKER_ANDROID_BUILD="${GITHUB_RUN_NUMBER:-1}"
python3 - <<'PY'
import os, pathlib, re
f = pathlib.Path("android/app/build.gradle"); s = f.read_text()
n = int(os.environ["MARKER_ANDROID_BUILD"])
s, k = re.subn(r'(?m)^(\s*versionCode\s+)\d+', lambda m: m.group(1) + str(n), s, count=1); assert k == 1
v = re.search(r'APP_VERSION\s*=\s*"([0-9.]+)"', pathlib.Path("version.js").read_text()).group(1)
s, k = re.subn(r'(?m)^(\s*versionName\s+)"[^"]*"', lambda m: m.group(1) + '"' + v + '"', s, count=1); assert k == 1
f.write_text(s)
print("versionCode", n, "versionName", v)
PY
# A pasted password may carry a line break; the key check already allows for it.
export MARKER_ANDROID_PASSWORD="$(printf '%s' "${MARKER_ANDROID_PASSWORD:-}" | tr -d '\r\n')"
bash build/android-sign.sh
trap 'rm -f android/app/mk-sign.p12 android/app/mk-sign.gradle' EXIT
(cd android && chmod +x gradlew && ./gradlew --no-daemon -q assembleDebug)
APK=android/app/build/outputs/apk/debug/app-debug.apk
test -s "$APK"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
SIGNER="$(find "$SDK/build-tools" -name apksigner -type f | sort -V | tail -1)"
ACTUAL="$("$SIGNER" verify --print-certs "$APK" | sed -n 's/^.*certificate SHA-256 digest: *//p' | head -1 | tr A-F a-f)"
EXPECTED=0f0da069f2c8b2842beb4d242415d70069a6bb3137fc90a75e6d1619ad32deff
[ "$ACTUAL" = "$EXPECTED" ] || { echo "::error title=Wrong signer::APK is signed by $ACTUAL"; exit 1; }
V=$(python3 -c "import re;print(re.search(r'APP_VERSION\s*=\s*\"([0-9.]+)\"',open('version.js').read()).group(1))")
mkdir -p out && cp "$APK" "out/marker.v$V.apk"
( cd out && sha256sum "marker.v$V.apk" > "marker.v$V.apk.sha256" )
echo "Signed with the permanent key ($ACTUAL)."
cat out/*.sha256
