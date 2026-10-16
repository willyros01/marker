# The Marker — handoff (16 Oct 2026, 12:45 pm Toronto)

Read the design document first: "The Marker — Design and Build Plan"
https://claude.ai/code/artifact/ba5e28e0-6260-43ba-964b-4bcfda12191a

- 0.1.0 in this repo: web app built and tested (15 logic tests, 19 rules tests green).
- Posting is being REDESIGNED (Willy, 16 Oct): phone stages the card in markerSubmissions,
  wakes a Cloudflare worker (Willy's existing account), the worker checks and posts in one commit;
  a 15-minute Cloudflare timer is the safety net; course search runs in the worker (key never on phones).
- build/mk1.txt is SUPERSEDED — it must NOT be run. It will be deleted and replaced (work step 7).
- 0.1.0's rules additions (cards, card-backed rounds, lookup, anonSearch) and the apply-cards job
  will be replaced (work steps 1 and 6).
- Resume at work step 1 of the design document ("Rules").
