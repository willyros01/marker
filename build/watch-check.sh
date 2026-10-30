#!/usr/bin/env bash
# The Marker — build the iPhone app with its Apple Watch app for the
# simulators (no signing), then open the watch app with made-up scores on an
# Apple Watch Ultra simulator and take a picture of each screen.
# Run by .github/workflows/watch-check.yml. Pictures go to shots/.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
TMP="${RUNNER_TEMP:-/tmp}"
mkdir -p shots

bash build/ios-project.sh

echo "--- Build for the simulators (iPhone app + watch app)"
DD="$TMP/dd"
xcodebuild build -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination "generic/platform=iOS Simulator" -derivedDataPath "$DD" \
  CODE_SIGNING_ALLOWED=NO MARKETING_VERSION=0.0.0 CURRENT_PROJECT_VERSION=1 \
  > "$TMP/sim-build.log" 2>&1 || { grep -E "error:|warning: .*Swift" "$TMP/sim-build.log" | head -40; tail -n 60 "$TMP/sim-build.log"; echo "RESULT: failed to build"; exit 1; }
APP="$(find "$DD/Build/Products" -maxdepth 2 -path "*iphonesimulator/App.app" | head -1)"
WAPP="$(find "$DD/Build/Products" -name "MarkerWatch.app" -path "*watchsimulator*" | head -1)"
echo "iPhone app: $APP"; echo "Watch app: $WAPP"
[ -n "$WAPP" ] || { echo "RESULT: the watch app was not built"; exit 1; }
[ -d "$APP/Watch/MarkerWatch.app" ] && echo "The watch app is embedded in the iPhone app." || { echo "RESULT: the watch app is not embedded in the iPhone app"; ls -la "$APP" | head -40; exit 1; }
plutil -p "$WAPP/Info.plist" | grep -E "WKApplication|WKCompanionAppBundleIdentifier|CFBundleIdentifier|CFBundleIconName"
[ -f "$WAPP/Assets.car" ] && echo "The watch app has its icon." || { echo "RESULT: the watch app has no icon (Assets.car)"; exit 1; }
[ -d "$WAPP/PlugIns/MarkerWidgets.appex" ] && echo "The watch-face widgets are inside the watch app." || { echo "RESULT: the watch-face widgets are not inside the watch app"; ls -la "$WAPP" "$WAPP/PlugIns" 2>/dev/null | head -30; exit 1; }

echo "--- An Apple Watch Ultra simulator"
UDID="$(xcrun simctl list devices available -j | python3 -c '
import json,sys
d=json.load(sys.stdin)["devices"]
best=None
for rt,devs in d.items():
    if "watchOS" not in rt: continue
    for x in devs:
        if "Ultra" in x["name"]: best=(rt,x["udid"],x["name"])
print(best[1] if best else "")')"
if [ -z "$UDID" ]; then
  RT="$(xcrun simctl list runtimes -j | python3 -c '
import json,sys
r=[x for x in json.load(sys.stdin)["runtimes"] if x.get("platform")=="watchOS" and x.get("isAvailable")]
print(r[-1]["identifier"] if r else "")')"
  DT="$(xcrun simctl list devicetypes -j | python3 -c '
import json,sys
t=[x for x in json.load(sys.stdin)["devicetypes"] if "Ultra" in x["name"] and "Watch" in x["name"]]
print(t[-1]["identifier"] if t else "")')"
  [ -n "$RT" ] && [ -n "$DT" ] || { echo "RESULT: no watchOS simulator on this Mac (runtime: ${RT:-none})"; xcrun simctl list runtimes; exit 1; }
  UDID="$(xcrun simctl create "Marker Watch" "$DT" "$RT")"
fi
echo "Simulator: $UDID"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl install "$UDID" "$WAPP"

for screen in waiting group player summary widgets; do
  xcrun simctl launch --terminate-running-process "$UDID" io.github.willyros01.marker.watchkitapp -markerDemo -markerShow "$screen" >/dev/null
  sleep 8
  xcrun simctl io "$UDID" screenshot "shots/watch-$screen.png" >/dev/null
  echo "picture: watch-$screen.png"
done
xcrun simctl spawn "$UDID" launchctl list 2>/dev/null | grep -q watchkitapp && echo "The watch app is still running." || echo "Note: the watch app is not in the running list."
echo "RESULT: success — the watch app builds, is embedded, and opens on the simulator."
