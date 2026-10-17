# The Marker — handoff (16 Oct 2026, 5:00 pm Toronto)

Design document: "The Marker — Design and Build Plan"
https://claude.ai/code/artifact/ba5e28e0-6260-43ba-964b-4bcfda12191a

Built and tested (0.2.0): rules (15 emulator tests), worker (posting, course search, limits,
sign-in checks), app switched to drop-off posting, end-to-end posting on the emulator (4 tests),
31 unit tests. The old handicap job and mk1.txt are gone.

Waiting on Willy, in this order:
1. Cloudflare: create an API token from the template "Edit Cloudflare Workers", plus one more
   permission row: Account / Workers AI / Edit (photo reading); add it to the marker repo as the
   GitHub secret CLOUDFLARE_API_TOKEN.
2. Cloud Shell: run `bash mk2.txt` (pinned to the tested commit). Then `bash mk2.txt verify`.
3. Re-run the "Deploy the worker" workflow (or Claude pushes). It deploys and writes the address.
4. GitHub Pages for the repo: main branch, root.
5. First real round in Philippine Golfers.

0.3.0 (Willy, 16 Oct): withdrawn courses (shared rules in withdrawn.js: withdrawn details never
used; corrected database details and hand entries accepted as new courses; hand entries shared in
the course list as "m-" + Scorecard id) and reading a scorecard photo (worker /scan, Cloudflare
Workers AI, Llama 4 Scout; 10 a day per member, 3 without an account, 40 a day in all).
The Scorecard marks a withdrawn course with withdrawn: true (its next build, after the freeze).

Later, with Willy's OK: copy the rules into the scorecard repo; iPhone/Android builds.

NEXT BUILD in The Marker (Willy, 16 Oct 7:48 pm; build after 8:40 pm, not before):
- Verified scorecard pictures (design doc section "Related Scorecard decision: verified scorecard
  pictures correct course data"): strict criteria; EVERY tee on the card must be complete, not only
  the one played; scorer confirms; only signed-in accounts' verified readings replace the database
  copy (markerCourses) with source "verified picture"; the database never overwrites it again.
- A spinning wheel while the picture is being read.
- (Willy, 7:56 pm) The confirmation screen ("does this match the card?") must look appealing: laid
  out like the club's card (holes across, one coloured row per tee, par and handicap rows, OUT/IN
  totals), a clear tick per tee and per nine when everything adds up, red where it does not, one
  large "This matches the card" button.
- (Willy, 7:56 pm) Once confirmed, the confirmed course REPLACES the database copy in Saved courses:
  one entry per course, no duplicates (today Royal Ontario shows twice: database copy and the hand
  entry). Signed-in: replaces the shared course list too; no account: only on that phone.
- The Scorecard side (recalculation, * on game scores, tee source field) waits for the freeze.

16 Oct 2026, 10:03 pm: Willy's functional test passed. A real card was scored on his phone, posted,
and appeared in The Scorecard straight away (worker live on Cloudflare, rules published by mk2.txt).
Still open: picture reading untested live (Cloudflare's free AI allowance ran out on 16 Oct; Willy's
Lakeview card read by hand verified OK); proposed, awaiting go-ahead: count real AI cost per picture
and show pictures left today. Later with OK: copy rules into the scorecard repo; iPhone/Android builds.

TOMORROW (17 Oct, Willy): 8 am check of Cloudflare's AI allowance (reminder set), then picture
test (Lakeview, typed name "Lakeview Golf Course"). Then native builds of The Marker:
- Android: new permanent signing key (made outside the repo, sent to Willy), he adds secrets
  MARKER_ANDROID_KEYSTORE_BASE64 and MARKER_ANDROID_PASSWORD; build job like Scorecard's
  android-apk.yml; Cuberoot publisher like publish-scorecard-apk.yml.
- iPhone: Willy creates the app in App Store Connect (The Marker, io.github.willyros01.marker)
  and adds ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8, APPLE_TEAM_ID to the marker repo (asked
  whether the .p8 file is still at hand); TestFlight job like Scorecard's ios-testflight.yml.
Done 16 Oct late: 0.5.4 (AI cost counted, pictures left shown); Scorecard firestore.rules on
main/v2/android now match live (Marker additions), Scorecard's own rules tests passed.
