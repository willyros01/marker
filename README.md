# The Marker

Hole-by-hole scorecard for a foursome, an add-on to The Scorecard.

- Web app: https://willyros01.github.io/marker/ (iPhone and Android builds follow, same code).
- Signed in with a Scorecard account, the scorer picks golfers from their own groups. A finished
  card is dropped off in Firebase (`markerSubmissions`) and a small Cloudflare worker checks it
  from scratch and posts the rounds into The Scorecard in one go, or refuses it with the reason.
  Phones never write Scorecard records themselves.
- Without an account, the card is kept on the phone and shared.
- Course search runs on the worker; the golf key never reaches a phone.
- Every score is saved on the phone the moment it is entered, checked by reading it back.

## Files

- `app.js` screens · `card.js` rules of play (pure, tested) · `store.js` Firebase and the worker ·
  `courses.js` course search with holes (used by the worker) · `storage.js` saving on the phone ·
  `model.js` The Scorecard's own handicap model (copy).
- `worker/` the Cloudflare worker: `post.js` checks and posts a card, `search.js` course search and
  limits, `verify.js` checks Firebase sign-ins, `google.js` signs in as marker-worker,
  `firestore.js` Firestore's REST API.
- `firebase/firestore.rules` The Scorecard's rules plus The Marker's four additions;
  `firebase/scorecard-live.rules` the rules they replace. Published by `build/mk2.txt` (Cloud Shell),
  which also switches on anonymous sign-in and sets up the two service accounts and keyless deploy.
  (`mk1.txt` is retired and must not be run.)
- `.github/workflows/tests.yml` unit tests, rules tests and an end-to-end posting test on the
  Firebase emulator, on every push. `.github/workflows/deploy-worker.yml` deploys the worker.
