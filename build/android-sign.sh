#!/usr/bin/env bash
# The Marker's permanent Android signing key, from the two GitHub secrets.
# Decoded only on the build machine, deleted after the build. No fallback to a
# throw-away key: without the secrets the build stops.
set -euo pipefail
umask 077
: "${MARKER_ANDROID_KEYSTORE_BASE64:?Missing GitHub secret MARKER_ANDROID_KEYSTORE_BASE64}"
: "${MARKER_ANDROID_PASSWORD:?Missing GitHub secret MARKER_ANDROID_PASSWORD}"
APP="android/app"
test -f "$APP/build.gradle"
STORE="$APP/mk-sign.p12"
# Spaces and line breaks from pasting are removed.
printf '%s' "$MARKER_ANDROID_KEYSTORE_BASE64" | tr -d ' \r\n\t' | base64 --decode > "$STORE"
test -s "$STORE"
if ! keytool -list -keystore "$STORE" -storetype PKCS12 -storepass "$MARKER_ANDROID_PASSWORD" -alias marker >/dev/null 2>&1; then
  echo "::error title=Android signing invalid::The key, its password or its alias (marker) do not match."
  exit 1
fi
cat > "$APP/mk-sign.gradle" <<'GRADLE'
android {
    signingConfigs {
        markerPermanent {
            storeFile file("mk-sign.p12")
            storePassword System.getenv("MARKER_ANDROID_PASSWORD")
            keyAlias "marker"
            keyPassword System.getenv("MARKER_ANDROID_PASSWORD")
            storeType "PKCS12"
        }
    }
    buildTypes {
        debug { signingConfig signingConfigs.markerPermanent }
    }
}
GRADLE
grep -Fq 'apply from: "mk-sign.gradle"' "$APP/build.gradle" || printf '\napply from: "mk-sign.gradle"\n' >> "$APP/build.gradle"
echo "Permanent signing key opened; it stays on this build machine."
