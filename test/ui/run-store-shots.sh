#!/usr/bin/env bash
# App Store pictures: emulators + worker stand-in + the web app (store-shots.mjs).
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
SHOTS="${SHOTS:-/tmp/store-shots}"; mkdir -p "$SHOTS"; export SHOTS
W=/tmp/caddie-www; rm -rf "$W"; mkdir -p "$W"
while IFS= read -r line; do
  line="${line%%#*}"; line="${line//[[:space:]]/}"; [ -n "$line" ] || continue
  mkdir -p "$W/$(dirname "$line")"; cp -R "${line%/}" "$W/${line%/}"
done < build/www-files.txt
# test copy only: the stand-in worker is on plain http
python3 - "$W/store.js" <<'PY'
import sys; p=sys.argv[1]; t=open(p).read()
assert t.count('/^https:\\/\\//.test(url)') == 1
t=t.replace('/^https:\\/\\//.test(url)','/^https?:\\/\\//.test(url)'); open(p,'w').write(t)
PY
(cd "$W" && python3 -m http.server 8099 --bind 127.0.0.1 >/tmp/www.log 2>&1) & WWW=$!
node test/ui/caddie-server.mjs >/tmp/caddie-server.log 2>&1 & SRV=$!
trap 'kill $WWW $SRV 2>/dev/null || true' EXIT
firebase emulators:exec --only firestore,auth --project demo-marker "node test/ui/store-shots.mjs"
