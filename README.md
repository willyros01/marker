# The Marker

Hole-by-hole scorecard for a foursome, an add-on to The Scorecard.

- Web app: https://willyros01.github.io/marker/ (iPhone and Android builds follow, same code).
- Signed in with a Scorecard account, the scorer picks golfers from their own groups and posts
  their rounds straight into The Scorecard (same Firebase project). Without an account, the card is
  kept on the phone and shared.
- Every score is saved on the phone the moment it is entered, checked by reading it back.

## Files

- `app.js` screens · `card.js` rules of play (pure, tested) · `store.js` Firebase · `courses.js` course
  search with holes · `storage.js` saving on the phone · `model.js` The Scorecard's own handicap model (copy).
- `firebase/firestore.rules` The Scorecard's rules plus The Marker's additions; `firebase/scorecard-live.rules`
  the rules they replace. Published by `build/mk1.txt` (Cloud Shell), which also switches on anonymous
  sign-in and sets up the handicap job's keyless access.
- `.github/scripts/apply-cards.mjs` the handicap job (every 15 minutes).
- `test/` unit tests and emulator rules tests, run by GitHub Actions on every push.
