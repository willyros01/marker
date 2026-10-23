#!/usr/bin/env bash
# Device tests, Android (Willy, 23 Oct 2026): installs the PUBLISHED Scorecard
# APK (the one golfers download from the Cuberoot site) on an Android emulator,
# opens each kind of link the way a tap does, records which app came to the
# front, and takes a screenshot. Nothing is written to the live database.
set -Euo pipefail
OUT="$PWD/out"; mkdir -p "$OUT"
log(){ echo "$*" | tee -a "$OUT/report.txt"; }
PKG=io.github.willyros01.scorecard
JOIN="https://www.cuberoot-systems.com/scorecard/join/"
curl -fsSL -o /tmp/scorecard.apk "https://www.cuberoot-systems.com/downloads/scorecard.apk"
log "APK: $(sha256sum /tmp/scorecard.apk | cut -c1-16)…, $(stat -c %s /tmp/scorecard.apk) bytes"
log "Android: $(adb shell getprop ro.build.version.release | tr -d '\r'), WebView: $(adb shell dumpsys package com.google.android.webview | grep -m1 versionName | tr -d '\r ' )"
APIKEY="AIzaSy-unknown"
enc(){ node -e 'console.log(encodeURIComponent(process.argv[1]))' "$1"; }
front(){ adb shell dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity' | sed -E 's/.*\{[^ ]+ [^ ]+ ([^ }]+).*/\1/' | tr -d '\r'; }
shot(){ sleep "${WAIT:-12}"; adb exec-out screencap -p > "$OUT/$1.png"; log "  in front: $(front)   screenshot: $1.png"; }
fresh(){
  adb shell am force-stop com.android.chrome > /dev/null 2>&1 || true
  adb uninstall "$PKG" > /dev/null 2>&1 || true
  adb install -r /tmp/scorecard.apk > /dev/null
  adb shell pm verify-app-links --re-verify "$PKG" > /dev/null 2>&1 || true
  sleep 15
  adb shell pm get-app-links "$PKG" | tr -d '\r' | grep -E 'www.cuberoot|Domain verification' | sed 's/^ */  app-link check: /' | tee -a "$OUT/report.txt"
}
view(){ adb shell am start -W -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d "'$1'" > /dev/null 2>&1; }

log ""
log "A0 Fresh install, open the app from the home screen"
fresh; adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1; shot a0-launch
log "A1 Invitation link (as sent today), app installed"
fresh; view "${JOIN}?join=TESTGROUP.faketoken&v=2"; shot a1-invitation
CONT="${JOIN}?apply=1&approved=1&e=$(enc device.test@example.com)"
log "A2 Approval email link (as Firebase sends it today), app installed"
fresh; view "https://scorecard-f41b8.firebaseapp.com/__/auth/action?mode=signIn&oobCode=FAKECODE&continueUrl=$(enc "$CONT")&lang=en"; shot a2-approval-email
log "A3 Approval link pointing straight at the join page (the planned fix), app installed"
fresh; view "${CONT}&mode=signIn&oobCode=FAKECODE"; shot a3-approval-fixed
log "A4 Invitation link with the app NOT installed"
adb shell am force-stop com.android.chrome > /dev/null 2>&1 || true
adb uninstall "$PKG" > /dev/null 2>&1 || true
view "${JOIN}?join=TESTGROUP.faketoken&v=2"; shot a4-not-installed
log "RESULT: finished"
