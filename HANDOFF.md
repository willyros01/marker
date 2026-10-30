# The Marker — handoff (20 Oct 2026, 3:30 am Toronto)

Current version: **0.6.8**. Live on the web (GitHub Pages), Android (signed APK
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

## Delete a posted card's rounds (0.6.7, Willy 20 Oct 2026) — correct.js deleteRounds

- Where: an opened posted card ("🗑 Delete its rounds from The Scorecard"), and the correction
  screen ("🗑 Delete these rounds from The Scorecard"). Asks to confirm.
- Who: same as correcting — the scorer for 24 hours after posting, an owner/admin of every group
  on the card at any time.
- ONE commit (POST /delete-rounds): each of the card's rounds still there is deleted (only if
  unchanged since read); each golfer's 20-round window is rebuilt from their remaining rounds in
  every group they play in (the next older round moves in), with handicapIndex and roundCount;
  their directory entries; the submission records roundsDeleted {by, as, golfers} and
  roundsDeletedAt. It stays "posted", so the card becomes editable and can be re-posted.
- Refused, nothing written: no rights; rounds already deleted; anything changed at the same
  moment.
- "Remove from this phone" (posted cards only): takes the card off the phone; nothing in The
  Scorecard changes. Unposted cards keep "Delete this card".
- Tests: correct.test.mjs D1–D3, card.test.mjs U17.

---------------------------------------------------------------------------------------------------
## RE-POSTING RULES (0.6.1 to 0.6.4, Willy 18 Oct 2026)

A card is **editable** when one or more of its rounds were deleted in The Scorecard. Editing it
means posting it again as a NEW card. Willy: "No records in the db means it is ok to re-post as
new rounds."

1. Which cards: posted cards (markerSubmissions status "posted") with at least one round gone,
   not already re-posted (repostedAs not set). Cards with every round still there are only
   correctable, never editable.
2. Who (Willy, 20 Oct 2026, 0.6.6 — same rights as correcting): the card's scorer for 24 hours
   after the card was first posted; an owner/admin of every group on the card at any time. Other
   members never see it. At posting, the 24 hours are judged at the moment the re-posted card was
   handed in (its createdAt), so a card sent with no signal is not refused for arriving late.
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
7. Hide / Unhide (POST /hide-editable {cardId, hidden}): same rights as re-posting (scorer for
   24 hours, owner/admin any time); Hide asks to confirm; sets `repostHidden: {by}` (Unhide:
   null) and repostHiddenAt on the old submission and nothing else — no Scorecard round, golfer
   or index changes. Hidden cards are listed under "Hidden cards (N)" in Deleted in The
   Scorecard, each with Re-post and Unhide; an opened card also shows Hide or Unhide (0.6.6). A hidden card leaves the orange list and the count, but
   opening it from "On this phone" still offers ✎ Edit and re-post (0.6.3; Willy had hidden all
   three cards and then could not re-post Lakeview).
8. On the phone: a posted card whose rounds were deleted shows "✎ Edit and re-post" instead of
   "✎ Correct this card", and the old Correct path also leads there (0.6.2). Once the re-post is
   posted, the old copy is removed from the phone (store.dropReplaced, run on posting, at start
   and when Your cards opens) — only the corrected card remains (0.6.4). The old copy stays until
   the new card is actually posted.
9. Messages always give full names.
10. Delete this card (0.6.8, Willy 20 Oct 2026; POST /discard-editable): on each card under
    Deleted in The Scorecard (and Hidden cards) and on the opened card. Same rights as
    re-posting; only when at least one of its rounds is already gone. Asks to confirm ("cannot be
    undone"). Marks the submission discarded {by} + discardedAt: it leaves everybody's lists for
    good, a re-post of it is refused, and the phone's copy is removed. Nothing in The Scorecard
    changes. Such a card no longer offers "Remove from this phone" (Delete covers it). Test D4.

Tests: test/unit/correct.test.mjs C7–C12 (editable list, re-post in one commit, never twice,
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

## Daily golfer clean-up (Willy, 22 Oct 2026) — worker/src/cleanup.js

- Rule: a golfer with no rounds, on no group's roster and with no linked account is deleted after staying that way for 7 days.
- Runs once a day from Cloudflare's scheduler (wrangler.toml crons "0 7 * * *" = 3 am Toronto in summer, 2 am in winter). GitHub's scheduler is not used.
- Also kept: any golfer named by a round, a member, a game or a Marker card, or whose own record shows rounds.
- First run notes the golfer and the time; deletion only 7 days later. If the golfer is used again, the 7 days start over.
- Deletion: the golfer, its golferNames claim, its directory entries and any userBlocks entry, in one commit per golfer, each guarded by updateTime. Changed in between = nothing deleted, looked at again next day. At most 10 per run.
- Any failed read stops the run before anything is deleted.
- Each run writes maintenance/golferCleanup: lastRun, checked, deleted, keptBecauseChanged, waiting, pending (golfer id -> first seen unused).
- Watchdog: GET /cleanup-status (no sign-in, no names) answers 200 when the last run is under 48 hours old, 503 otherwise; cron-job.org checks it daily and emails Willy on failure.
- After the freeze (optional now that the watchdog exists): the Admin page warns when lastRun is more than 2 days old (needs a rule letting the owner read maintenance/golferCleanup). Tidy in the apps should then stop archiving, since this job deletes.
- 22 Oct 2026: the 11 golfers Tidy had listed were deleted once by hand (build/inv.mjs, one commit, 17 deletes).

## Hole pars on every Marker round (Willy, 25 Oct 2026) — item 22

- Each round the worker posts (and each correction) now also keeps holePar and holeSi: 18 numbers each,
  hole 1 to 18, from the tee frozen when the card was posted (postedTee). holeSi is null for a hole
  without a stroke index. Left out when the tee does not have 18 holes (never a made-up par 4).
- Purpose: The Scorecard can show a Marker round read-only, hole by hole, from History (screen built
  after the freeze), with the pars as played even if the course is corrected later.
- Rounds posted before 25 Oct: filled in once by build/fil.mjs (worker/src/fillholes.js). Only the two
  fields are added, one commit per round, guarded by updateTime; never from today's course list.
- Tests: test/unit/holes.test.mjs (H1-H6).

## App owner override (Willy, 23 and 26 Oct 2026) — item 21, Marker part

- "Like SAP_ALL": an account with appOwners/{uid} = { active: true } may correct, hide, delete and
  re-post ANY Marker card at any time, including cards of groups it did not create and is not in.
- worker/src/correct.js isAppOwner(), used by rights(); a group owner or admin is still recorded as
  "admin"; the override is recorded as as: "appOwner" on every correction / deletion. The phone shows
  "As the app owner" on such cards (app.js).
- The record is written only outside the apps (build/own.mjs, dry first); no Firestore rule allows a
  phone to read or write appOwners (no match = denied).
- The Scorecard's part (rules and screens treating the app owner as owner of every group) waits for
  the freeze.
- Tests: test/unit/owner.test.mjs (O1-O5).

## Caddie scoring (Willy, 29 Oct 2026) — version 0.7.0

- A member taps "Let my caddie score" on Who's playing?: the worker makes markerLive/{liveId} (owner, setup
  with names and course handicaps only, scores, status) and markerCaddieCodes/{CODE} (6 characters, no 0/O/1/I).
  The member's phone shows the code and a QR square (vendor/qrcode, MIT) holding
  https://willyros01.github.io/marker/?caddie=CODE, which opens the Join screen with the code filled in.
- The caddie (no account, anonymous sign-in) taps the small Caddie icon on the first screen (shown only when
  no member is signed in), types the code and scores with the usual screens. The whole card is sent a moment
  after each change (one send at a time); no Post button; "Hand the card back to the golfer" ends it.
- The member's phone asks for the scores every 4 s (waiting) or 8 s (caddie connected) while the caddie screen
  is open; "Take over scoring myself" stops the code at once (needs a signal). Finished cards go to the
  usual Round finished screen, posted by the member; rounds note "by a caddie" (scoredBy on the card).
- Code stops on take-over, finish, or after 12 hours. One caddie per card (the same phone may rejoin). A phone
  gets 20 wrong codes a day. Willy's choices: phone camera or typed code (no scanner in the app), 12 hours.
- 0.7.1: the QR square links to https://www.cuberoot-systems.com/marker/caddie/?caddie=CODE (Willy: "just
  like the invite on The Scorecard"). The Cuberoot site claims it for the apps (.well-known: AASA appID
  VXMLKHF72B.io.github.willyros01.marker, path /marker/caddie/*; assetlinks io.github.willyros01.marker with the
  permanent signing key's SHA-256) and otherwise forwards to the web app. The apps carry the associated domain
  (build/ios/App.entitlements) and an autoVerify App Link (android-native.sh), with @capacitor/app 8.1.1 for
  getLaunchUrl / appUrlOpen. No scanner inside the app (Willy's choice); the Fire HD 8's camera cannot read QR
  squares, so a caddie with a Fire types the code. Caddie scoring needs a signal to join and to hand back.
- Everything goes through the worker (service account); no Firestore rule change.
- Tests: test/unit/caddie.test.mjs (K1-K10); two browsers end to end: test/ui/run-caddie.sh, workflow
  ui-caddie.yml (screenshots in ci-logs logs/ui-caddie/).

## Following a card live (Willy, 29 Oct 2026, option A) — version 0.8.0

- Menu (or the member's caddie screen) > "Let others follow this card": worker follow.js makes a follow code
  (markerFollowCodes/{CODE}) on the card's live copy (markerLive): the caddie's live card if a caddie is
  scoring, otherwise a new one with status "self". QR: https://www.cuberoot-systems.com/marker/follow/?follow=CODE
  (claimed by the apps like the caddie links; otherwise forwards to the web app).
- Followers (any sign-in, no account needed) tap the Follow icon on the first screen (shown to everyone), type
  the code or open the link: read-only card, refreshed every 12 s; "No connection right now. Showing the scores
  from …" without signal; "The round is finished." after posting. The last followed card is offered on the
  first screen ("Follow: <course>") until "Stop following".
- The member's phone sends its own scores (whole card, 1.5 s after a change, one send at a time) except while a
  caddie scores; Post marks the live card finished. Stops after 12 hours.
- Option B (a live leaderboard for a game, for tournaments) is for later, built on this.
- Tests: test/unit/follow.test.mjs (F1-F6); the two-browser test (ui-caddie.yml) also follows a card.

## Follow links open the Follow screen first — version 0.8.1

Willy (29 Oct 2026): scanning a follow QR on the iPad opened The Marker but
stayed on the first screen, while typing the same code worked and caddie scans
worked. A follow link used to fetch the card the instant the app woke up; a
caddie link only opens a screen. Now a follow link (app link or ?follow=) goes
to the Follow screen with the code filled in, like a caddie link, then opens
the card from there, trying once more after 2.5 s if the first try fails for a
network or start-up reason. Any failure is shown on the Follow screen with the
code still filled in. Browser test step 10 covers a link with a wrong code.

0.8.2: 0.8.1 did not help on Willy's iPad (the scan opens the app, the first
screen stays, no Follow screen). Every link that opens the app now goes through
useLink(): a link the app cannot use shows on the first screen, in full, so
the next scan tells us what the iPad hands over (or, if nothing shows, that no
link reaches the app at all).

0.8.3: the real cause. Caddie scans failed on the iPad too. The builds
installed @capacitor/app with --no-save, so it was never in package.json, and
"cap sync" only packs plugins listed there: the app had no App plugin, so
listenForCaddieLinks() returned at once and no link ever reached the app (The
Scorecard lists it in package.json, which is why its invitations work). The
iOS, Android and device-test builds now run npm pkg set
dependencies.@capacitor/app=8.1.1 before cap sync, and stop if the sync output
does not mention @capacitor/app.

## Apple Watch follower (Willy, 30 Oct 2026) — version 0.9.0

Mockup: claude.ai artifact L2bcFtzgvbCQCNb7hgQuKm. Willy has an Apple Watch
Ultra; he chose "Send to my watch" from the iPhone over typing on the watch.

- Watch app: build/ios/watch/MarkerWatch (SwiftUI, watchOS 10+, bundle
  io.github.willyros01.marker.watchkitapp). Screens: no card yet; all golfers
  on the current hole (the furthest hole anyone has a score on); one golfer
  (swipe for the next, crown for holes); Out / In / Total. Reads
  /follow/view itself every 20 s while on screen, with its own anonymous
  Firebase sign-in over REST (key handed over by the phone; Referer
  willyros01.github.io). Scoring as card.js (picked up = hole cap).
- iPhone: WatchLink plugin (build/ios/native, WatchConnectivity application
  context: code, course, workerUrl, apiKey, sentAt) registered by
  MarkerViewController; Main.storyboard pointed at it by build/ios-project.sh.
  "Send to my watch" on the Following screen only when a watch is paired.
- Build: build/ios-project.sh makes the project for both ios-build.sh and
  watch-check.sh; configure.rb adds the MarkerWatch target and embeds it
  (Embed Watch Content). The archive is checked for Watch/MarkerWatch.app.
- watch-check.yml: simulator build + pictures of each screen (-markerDemo,
  -markerShow waiting|group|player|summary) to ci-logs logs/watch/.

0.9.1: Willy, with a caddie scoring his card, could not send his own card to
the watch (the button was only on a follower's screen). "Send to my watch"
(action watch-mine) is now also on the caddie screen and on the Let others
follow screen; it makes the follow code first when the card has none
(ensureFollow), then sends. Shown only when a watch is paired.

0.9.3: on Willy's iPhone (0.9.2) the button never showed: it waited for
WatchLink.status() to say "paired", which may answer late. Now shown on every
iPhone app (native iOS + "iPhone" in the user agent); paired / installed /
plugin missing are reported when tapped (watchWhy).

## Open

- Willy's ChatGPT daily APK email should now expect seven rows ("ALL SEVEN").
- Optional cleanup: remote branch marker-counter in Cuberoot.
- After the freeze: The Scorecard fixes in the document above, then build 25 to the App Store.
  Willy decides on Thursday 22 Oct whether to withdraw 2.30.0 (build 24) from review if Apple
  has not approved it.
