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
