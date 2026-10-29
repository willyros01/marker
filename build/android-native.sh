#!/usr/bin/env bash
# Android-only adjustments to the generated project (never touches the web app).
set -euo pipefail
python3 - <<'PY'
import pathlib, re
m = pathlib.Path("android/app/src/main/AndroidManifest.xml")
s = m.read_text()
# The scorecard picture button opens the camera.
perms = ['<uses-permission android:name="android.permission.CAMERA" />',
         '<uses-feature android:name="android.hardware.camera" android:required="false" />']
for p in perms:
    if p not in s:
        s = s.replace("</manifest>", "    " + p + "\n</manifest>", 1)
# Caddie links on the Cuberoot site open the app (Willy, 29 Oct 2026); verified by
# www.cuberoot-systems.com/.well-known/assetlinks.json.
link = """<intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="https" android:host="www.cuberoot-systems.com" android:pathPrefix="/marker/caddie/" />
            </intent-filter>
        """
if "/marker/caddie/" not in s:
    i = s.index("</activity>")
    s = s[:i] + link + s[i:]
m.write_text(s)
print("Manifest: camera permission added (camera optional, so tablets without one can install); caddie links open the app.")
PY
# Launcher icons from the app's own icon.svg (the plain icons; Android's
# adaptive icon set from the template is removed so the real icon shows).
RES=android/app/src/main/res
rm -rf "$RES"/mipmap-anydpi-v26
for d in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  n=${d%%:*}; px=${d##*:}
  mkdir -p "$RES/mipmap-$n"
  rm -f "$RES/mipmap-$n"/ic_launcher*.png
  rsvg-convert -w "$px" -h "$px" icon.svg -o "$RES/mipmap-$n/ic_launcher.png"
  cp "$RES/mipmap-$n/ic_launcher.png" "$RES/mipmap-$n/ic_launcher_round.png"
  rsvg-convert -w $((px*9/4)) -h $((px*9/4)) icon.svg -o "$RES/mipmap-$n/ic_launcher_foreground.png"
done
echo "Launcher icons made from icon.svg."
