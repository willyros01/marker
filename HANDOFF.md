# The Marker — handoff (20 Oct 2026, 1:10 am Toronto)

Current version: **0.6.5** (main 63c61a6). Live on the web (GitHub Pages), Android (signed APK
published on the Cuberoot website by the build itself) and iPhone (TestFlight).
Tests: 72 unit tests (`npm test`) and 22 emulator tests (`npm run test:rules`, run by CI).

Design document: "The Marker — Design and Build Plan"
https://claude.ai/code/artifact/ba5e28e0-6260-43ba-964b-4bcfda12191a
User guides (written separately, version 0.6.4): www.cuberoot-systems.com/marker/guide/ and
/marker/quick-start/, PDFs in Cuberoot guides/the-marker/.

Standing rules from Willy: get his go-ahead before any change; one commit, all or nothing, for
every database write; never blame the user, the app must cover every case; full names in every
message (a group can have two golfers with the same first name, e.g. Raul Rosales and Raul Reynoso).
The Scorecard itself is frozen since 11 Oct 2026 (documentation only without his permission);
its fixes wait in "The Scorecard — fixes for after the freeze"
(https://claude.ai/code/artifact/86482d42-634d-4f9c-9788-abd7ff4f4a65).

---------------------------------------------------------------------------------------------------
## How it fits together

- The phone (app.js, card.js, store.js, storage.js) keeps every score on the phone the moment it is
  entered. Posting drops the card into `markerSubmissions/{cardId}` (status "sent"); the rules allow
  only that create, by the scorer, never an update or delete.
- The Cloudflare worker "marker" (worker/src) does all writing to The Scorecard with a service
  account, re-checking everything from scratch (course and tee from the library, each golfer's
  index from the golfer record, totals by card.js and The Scorecard's model.js). Each action is
  ONE Firestore commit with preconditions (updateTime / exists), so it is all or nothing.
- The worker wakes on the phone's /wake call, and a cron sweep every 5 minutes posts anything left.
- Deploys: worker by .github/workflows/deploy-worker.yml (after tests, Workload Identity, fresh
  key); web by GitHub Pages; Android by android-apk.yml, which then dispatches Cuberoot's
  publish-marker-apk.yml (token CUBEROOT_DISPATCH_TOKEN); iPhone by ios-testflight.yml whenever
  version.js changes.
- Read-only checks of the live database: edit build/inv.mjs and push; inv.yml runs it and saves
  the log on the ci-logs branch (`git fetch origin ci-logs:refs/remotes/origin/ci-logs`).

## Worker endpoints

GET /health, /search, /course, /withdrawn, /scan-status; POST /scan, /verify, /wake,
/correctable (kept for 0.6.0 phones), /correction-card, /correct, /my-cards, /hide-editable.
A refusal comes back as { error: "REFUSED", reason } with the reason in plain words.

---------------------------------------------------------------------------------------------------
## Start screen and Your cards (0.6.1, Willy 18 Oct: "scoring comes first")

- Start screen: one big green "Start a new round" (or "Continue your round / correction /
  re-post" when one is saved), one smaller "Your cards" button with an orange tag
  "N editable" only when cards with deleted rounds can be re-posted. Signed-in email and
  Sign out at the bottom; Support (The Marker's own guide, 0.6.5) and Privacy (The Scorecard's
  page — The Marker keeps its data there) under it.
- Your cards: "Deleted in The Scorecard" (orange, only when there is one) with Re-post and Hide on
  each card; then "On this phone" (cards kept on the phone, full names); then
  "✎ Correct a posted card".
- The lists from The Scorecard come from POST /my-cards, asked again at most once a minute (at
  once when Your cards opens or a card is posted); the last answer is kept if offline.

## Fix a score before posting (0.5.9)

On the finish screen "✎ Fix a score" opens the card; "✓ Done fixing — back to the totals"
returns. Nothing is posted until Post is tapped.

## Correct a posted card (0.6.0) — worker/src/correct.js

- Who: the scorer for 24 hours after posting; an owner or admin of EVERY group on the card at
  any time (member role admin/owner, or the group's ownerUid).
- What: new hole scores for the golfers already on the card. Never the golfers, course, tee,
  date, game, or the handicap frozen on each round when it was posted (indexAtEntry, and the
  rating/slope/par stored on the round).
- One commit: each changed round (gross, adjusted, differential, holes, plus a corrections[]
  record: at, by, as, the scores before); each changed golfer's 20-round window and index (only
  if that round is in the window); their directory entry in every group that has one; the card
  kept with the submission (corrections count, lastCorrection, correctedAt).
- Refused, nothing written: a round deleted in The Scorecard (then the card is "editable", see
  below); a round changed in The Scorecard since (gross or holes differ from the card); anything
  changed between read and write ("Somebody changed … a moment ago").
- The tee used is the one the card was posted with (postedTee), never the phone's copy.
- The Scorecard side (a lock on Marker scores that never expires, etc.) waits for the freeze;
  it is Fix 1 in the after-the-freeze document.

---------------------------------------------------------------------------------------------------
## RE-POSTING RULES (0.6.1 to 0.6.4, Willy 18 Oct 2026)

A card is **editable** when one or more of its rounds were deleted in The Scorecard. Editing it
means posting it again as a NEW card. Willy: "No records in the db means it is ok to re-post as
new rounds."

1. Which cards: posted cards (markerSubmissions status "posted") with at least one round gone,
   not already re-posted (repostedAs not set). Cards with every round still there are only
   correctable, never editable.
2. Who: the card's scorer, at any time (no 24-hour limit — nothing existing is overwritten), or
   an owner/admin of every group on the card. Other members never see it.
3. Only the golfers whose rounds are gone go on the new card. Golfers whose rounds still exist
   stay out, so nobody is ever counted twice.
4. The new card starts filled in: same course, tee, date, game, holes and the old scores. The
   scorer fixes scores with ✎ Fix a score, then posts. "Cancel the re-post" discards it
   (nothing posted). Only one round can be in progress on a phone at a time.
5. The new card carries `repostOf: <old card id>`. The worker (post.js plan → correct.js
   repostWrite), in the SAME commit as the new rounds, marks the old card `repostedAs: <new id>`
   with an updateTime precondition. It REFUSES the whole card, nothing written, when:
   - the old card is not posted or not found;
   - the old card was already re-posted ("That card has already been re-posted");
   - the poster is neither the old card's scorer nor an owner/admin of its groups;
   - any golfer on the new card still has their round from the old card ("… still in The
     Scorecard, so posting it again would count it twice").
6. The re-posted rounds are new rounds: posted the normal way, with each golfer's index as it is
   today (indexAtEntry is today's, not the old date's). Gross, differential and handicap index are
   unaffected; only the net shown for that old day differs. Willy accepted this (normal use is
   today's round).
7. Hide (POST /hide-editable): only the scorer or an owner/admin; asks to confirm; sets
   `repostHidden: {by}` and repostHiddenAt on the old submission and nothing else — no Scorecard
   round, golfer or index changes. A hidden card leaves the orange list and the count, but
   opening it from "On this phone" still offers ✎ Edit and re-post (0.6.3; Willy had hidden all
   three cards and then could not re-post Lakeview).
8. On the phone: a posted card whose rounds were deleted shows "✎ Edit and re-post" instead of
   "✎ Correct this card", and the old Correct path also leads there (0.6.2). Once the re-post is
   posted, the old copy is removed from the phone (store.dropReplaced, run on posting, at start
   and when Your cards opens) — only the corrected card remains (0.6.4). The old copy stays until
   the new card is actually posted.
9. Messages always give full names.

Tests: test/unit/correct.test.mjs C7–C11 (editable list, re-post in one commit, never twice,
hide, rights), card.test.mjs U16 (old copy replaced only once posted).

---------------------------------------------------------------------------------------------------
## Other changes since 16 Oct

- 0.5.5: delete a course saved on the device; a course picked from search replaces saved copies of
  the same name.
- Royal Ontario saved as the club's printed card (5 tees) in markerCourses.
- 0.5.6: icon — a scorecard with the flag on the green (option B).
- 0.5.7 / 0.5.8: round date uses The Scorecard's own calendar (month/year jumps, typed date,
  Today); never a future date.
- Worker: a course it creates stores its own id inside the document (The Scorecard reads it
  there). The Lakeview course was missing it, which showed "Lakeview" under the rounds of a deleted
  game; data fixed with Willy's go-ahead. Fix 4/5 in the after-the-freeze document.
- Native builds: Android signing key alias marker, SHA-256
  0f0da069f2c8b2842beb4d242415d70069a6bb3137fc90a75e6d1619ad32deff (secrets
  MARKER_ANDROID_KEYSTORE_BASE64 / MARKER_ANDROID_PASSWORD); iPhone app io.github.willyros01.marker,
  TestFlight with an invite group, App Store Connect API key in the repo secrets.
- Cuberoot APK click counter includes marker (rules by mkc.txt, run by Willy).

## Data notes (18 Oct 2026)

All rounds of the three early Marker cards were deleted by Willy in The Scorecard (Royal Ontario
16 and 17 Oct 2026, Lakeview 17 Jul 2025). Lakeview was corrected and re-posted on 18 Oct; the
two Royal Ontario cards are hidden and can still be re-posted from the phone if wanted.

## Open

- Willy's ChatGPT daily APK email should now expect seven rows ("ALL SEVEN").
- Optional cleanup: remote branch marker-counter in Cuberoot.
- After the freeze: The Scorecard fixes in the document above, then build 25 to the App Store.
  Willy decides on Thursday 22 Oct whether to withdraw 2.30.0 (build 24) from review if Apple
  has not approved it.
