# The Marker — Illustrated Application & Code Guide

**Documentation snapshot:** 7 November 2026  
**Repository:** willyros01/marker · **Source version:** 1.1.0 (version.js)  
**Scope:** web, iOS, Android and Apple Watch architecture. Documentation only; no app code, worker deployment or Firebase rules are changed by this guide.

## 1. What The Marker does

The Marker is a hole-by-hole golf scoring companion to The Scorecard.

A scorer creates a card, chooses a course/tee and golfers, then records scores hole by hole. A signed-in Scorecard member can select golfers from their Scorecard groups and submit a finished eligible card. A guest can also use The Marker without a Scorecard account and keep/share a card locally.

The key ownership boundary is important: **the phone does not write Scorecard round records directly.** It submits a Marker card; the trusted Cloudflare Worker independently checks it and performs the Scorecard write.

## 2. Application architecture

~~~mermaid
flowchart TD
  G[Golfer / Scorer] --> UI[app.js — screens and actions]
  UI --> C[card.js — golf scoring rules]
  UI --> ST[storage.js — local card persistence]
  UI --> DB[store.js — Marker Firebase session/data]
  UI --> CR[courses.js — course search interface]
  CR --> W[Cloudflare Worker]
  DB --> SUB[(markerSubmissions)]
  SUB --> W
  W --> V[Verify and validate card]
  V -->|Accepted| SC[(The Scorecard Firestore)]
  V -->|Rejected| REF[Refusal reason]
  W --> LIVE[(markerLive / follow codes)]
  LIVE --> F[Followers and caddie phones]
  LIVE --> WATCH[Apple Watch app and widgets]
~~~

### Main code modules

| File / folder | Responsibility |
|---|---|
| app.js | Screen state, navigation, card setup, score entry, sharing, caddie/follower/watch actions |
| card.js | Pure scoring rules: hole order, strokes received, hole caps, totals and completion |
| model.js | The Scorecard handicap model copied into Marker so both apps calculate course handicaps consistently |
| cardcheck.js | Pure validation and merging of course-card readings |
| courses.js | Course-search client and course/tee selection |
| storage.js | Local persistence of cards and supporting state |
| store.js | Marker Firebase app, authentication, group/golfer lookup and worker communication |
| withdrawn.js | Withdrawn-course handling |
| worker/src/index.js | Worker request routing and API endpoints |
| worker/src/post.js | Revalidates a completed card and posts Scorecard rounds atomically |
| worker/src/caddie.js | Caddie join codes, live card ownership and caddie score updates |
| worker/src/follow.js | Read-only follower codes and live-card access |
| worker/src/search.js | Course search and course-card reading normalization |
| worker/src/firestore.js | Worker-side Firestore REST helpers and conditional writes |
| build/ios/watch/ | Native SwiftUI watch app, shared watch models and WidgetKit extensions |
| build/ios/native/WatchLinkPlugin.swift | Capacitor / WatchConnectivity bridge for sending the followed card to the watch |

## 3. A normal card: from setup to Scorecard

~~~mermaid
sequenceDiagram
  participant P as Scorer's phone
  participant C as card.js
  participant L as Local storage
  participant F as Firebase
  participant W as Cloudflare Worker
  participant S as The Scorecard
  P->>P: Choose date, course, tee and golfers
  P->>C: Create card and enter hole scores
  C-->>P: Totals, caps and completion state
  P->>L: Save each score locally
  P->>F: Submit completed Marker card
  F->>W: Worker receives submission
  W->>W: Recalculate and validate from trusted records
  alt Valid
    W->>S: One conditional commit for all golfer rounds
    W-->>F: Mark submission posted
  else Invalid / not allowed
    W-->>F: Mark submission refused with plain reason
  end
~~~

The app saves a score locally as soon as it is entered and reads it back before moving on. This protects the in-progress card from a screen change or temporary loss of signal.

## 4. Scoring engine: card.js

The scoring engine is intentionally independent of Firebase and the UI. It can be unit tested without a browser or network.

Its main responsibilities include:

- Selecting 18 holes, the front nine or the back nine.
- Starting on a selected hole and continuing in playing order.
- Calculating a golfer's course handicap from the shared Scorecard model.
- Allocating handicap strokes by stroke index.
- Calculating the maximum hole score for handicap purposes (net double bogey; par plus five when no handicap is available).
- Treating a picked-up hole as its handicap cap.
- Calculating gross, adjusted, to-par and net totals.
- Recognizing a golfer who joins after play has started and handling holes not played according to the implemented late-join rule.

~~~mermaid
flowchart TD
  SETUP[Course, tee, holes, players] --> ORDER[card.holeOrder]
  ORDER --> CH[card.courseHandicapFor]
  CH --> ALLOC[card.strokesOn]
  ALLOC --> CAP[card.holeCap]
  CAP --> SCORE[card.grossOn / totals]
  SCORE --> COMPLETE[cardComplete]
  COMPLETE --> SUBMIT[Eligible completed card]
~~~

The shared model.js copy is a critical consistency point: The Marker must calculate the same course handicap as The Scorecard. If the handicap model changes in the future, the copies and their tests must be reconciled deliberately.

## 5. Trusted posting: why the worker matters

The worker does not trust totals or handicap values supplied by the phone.

When a card is submitted, worker/src/post.js:

1. Reads the submitted card and checks its structure/date/tee.
2. Gets golfer records and current handicap data from The Scorecard.
3. Recalculates the scoring values using card.js and the shared handicap model.
4. Checks course/tee data against the trusted course library where applicable.
5. Builds one conditional Firestore commit for the golfer rounds, golfer windows/indexes, directory updates, any permitted course additions and the submission status.
6. Marks the submission posted with the resulting round IDs, or refused with a human-readable reason.

A temporary infrastructure failure leaves the submission available for retry. A permanent validation/permission refusal is not silently treated as a successful post.

**Security boundary:** the worker's service identity performs the Scorecard write. The phone is not granted a shortcut around Scorecard rules.

## 6. Caddie: another person enters the scores

The member starts a card and chooses **Let my caddie score**. The worker creates a live card and a six-character caddie code. The member shares the QR/link or code with the caddie.

~~~mermaid
sequenceDiagram
  participant M as Member's phone
  participant W as Worker
  participant C as Caddie's phone
  M->>W: Start caddie session
  W-->>M: Live card + six-character code
  M-->>C: Share QR/link or code
  C->>W: Join code (anonymous sign-in)
  W-->>C: Minimum scoring data
  C->>W: Send updated scores
  W-->>M: Updated live card
  M->>W: Take over or finish
  W->>W: Stop caddie code
  M->>W: Submit the finished card
~~~

Caddie safeguards in the current worker implementation:

- The caddie does not need a Scorecard account.
- The caddie can see only the course/tee, holes, player names and course handicaps needed to score.
- The caddie cannot post the card to The Scorecard; the member remains responsible for checking and posting.
- One caddie is active per card.
- The code ends when the member takes over, the card is finished or the 12-hour limit is reached.
- Wrong-code attempts are limited.
- Worker writes use conditional commits so concurrent updates do not silently overwrite newer state.

The Fire HD 8 camera may not read the QR square; typing the displayed code is the supported alternative on that device.

## 7. Follower: read-only live scoring

The member chooses **Let others follow this card** and shares a follow code or QR link. A follower opens the Follow screen and enters the code or uses the link.

~~~mermaid
flowchart LR
  SC[Member scores card] --> LC[(markerLive)]
  CAD[Caddie scores card] --> LC
  LC --> API[Worker /follow/view]
  API --> F1[Phone follower — read only]
  API --> F2[Apple Watch — read only]
  F1 --> END[Finished state after posting]
  F2 --> END
~~~

- Followers may use a Scorecard account or follow without one.
- Followers see scores as the card progresses but cannot edit or post.
- The phone follower view refreshes periodically while connected.
- Without signal, it shows the last available scores and when they were updated.
- The last followed card can be offered again on the first screen until the user stops following.
- The follow code is time-limited; a finished card remains viewable during its allowed lifetime.
- A card being scored by a caddie uses the same live card, so followers see the caddie's updates too.

The worker's follow endpoint is the authority for whether a code is valid and what read-only card data is returned.

## 8. Apple Watch: live card, golfer view and widgets

The iPhone has a **Send to my watch** action on the relevant following/caddie screens. It passes the follow code, course name, worker address and public Firebase web key to the paired watch using WatchConnectivity application context. This handoff can arrive even when the Watch app is not open.

~~~mermaid
sequenceDiagram
  participant I as iPhone Marker
  participant WC as WatchConnectivity
  participant A as MarkerWatch (SwiftUI)
  participant W as Worker /follow/view
  participant X as WidgetKit
  I->>WC: Send follow code + connection details
  WC-->>A: Deliver application context
  A->>W: Watch signs in anonymously and requests live card
  W-->>A: Read-only card snapshot
  A->>A: Refresh while app is active
  A->>X: Reload widget timelines
  X-->>I: Watch face / Smart Stack views
~~~

### Watch application screens

- **No card yet:** prompts the user to send a card from the iPhone.
- **Group/current hole:** shows all golfers on the hole currently being played.
- **Individual golfer:** swipe between golfers; use the Digital Crown to inspect other holes.
- **Out / In / Total:** shows the round summary.
- **Finished / no signal:** makes the status clear and shows the last update time when available.

The watch reads the live card itself through the worker. It does not depend on the iPhone relaying every score after the initial link handoff. The active watch view refreshes about every 20 seconds while on screen, subject to connectivity and watchOS lifecycle behavior.

### Watch face and Smart Stack widgets

The WidgetKit extension provides two useful views:

1. **My score** — the golfer most recently selected on the watch.
2. **The group** — all golfers on the current hole.

The user can add the Marker widgets to a watch face or Smart Stack using the normal watchOS widget/complication customization flow. watchOS controls scheduled widget refresh frequency (the source comments describe roughly 10–20 minutes); the app requests a timeline reload when it receives new live scores. A widget is therefore a glanceable summary, not a second-by-second guarantee.

## 9. Course search and scorecard recognition

Course lookup is routed through the worker. The private golf/course lookup key stays server-side; it is not sent to the phone.

The cardcheck.js module merges course-card readings hole by hole. This allows a picture of the front nine and a later picture of the back nine to contribute to one course record. Retaking a picture replaces the readings for the holes shown in the new image.

The worker normalizes course/tee readings and applies validation before the course data is used for trusted posting. Manual course entry remains a separate fallback where supported.

## 10. Authentication, local storage and privacy boundaries

- The Marker creates its own named Firebase app instance so its sign-in session is separated from The Scorecard's session on the same web address.
- A signed-in member uses the same Scorecard email/password to load their groups and golfers.
- A guest can use an anonymous session or continue with locally saved/hand-entered course data.
- The card is saved on the phone during scoring.
- The worker holds temporary live-card and submission data needed for caddie/follower/posting flows; the code enforces a 12-hour live-card lifetime.
- The watch uses its own anonymous Firebase sign-in for read-only live viewing.
- Never place service-account credentials or private worker secrets in the client app or documentation.

## 11. Appearance and accessibility notes

The current Marker stylesheet defines the Lake-blue and fairway-green visual palette. It also includes a scalable text-size control, with rem-based sizing.

**Dark-mode status:** the reviewed main-branch styles.css does not define a dedicated [data-theme="dark"] color-variable set. Do not describe The Marker as having confirmed automatic or manual dark mode based on this source snapshot. If dark mode is added or verified in a later branch/build, update this section from the actual implementation.

## 12. Source map

| If investigating… | Start with… |
|---|---|
| Screen, button or navigation | app.js |
| Hole order, stroke allocation, totals | card.js |
| Handicap calculation | model.js |
| Local save/readback | storage.js |
| Sign-in, group lookup, submission | store.js |
| Course-card reading merge | cardcheck.js |
| Trusted submission and Scorecard writes | worker/src/post.js |
| Caddie session/code | worker/src/caddie.js |
| Follower code and live view | worker/src/follow.js |
| Worker endpoints | worker/src/index.js |
| Watch live-data refresh | build/ios/watch/MarkerWatch/FollowStore.swift |
| Watch screens | build/ios/watch/MarkerWatch/Views.swift |
| Watch face / Smart Stack widgets | build/ios/watch/MarkerWidgets/MarkerWidgets.swift |
| iPhone-to-watch handoff | build/ios/native/WatchLinkPlugin.swift |

## 13. Change-control status

This guide is documentation only. It does not authorize application-code changes, Firebase rule changes, worker deployment, iOS/Android builds, App Store submission or release. The Scorecard/Marker development freeze remains in force unless the owner explicitly authorizes development.
