# The Marker — handoff (16 Oct 2026, 4:10 pm Toronto)

Design document: "The Marker — Design and Build Plan"
https://claude.ai/code/artifact/ba5e28e0-6260-43ba-964b-4bcfda12191a

Built and tested (0.2.0): rules (15 emulator tests), worker (posting, course search, limits,
sign-in checks), app switched to drop-off posting, end-to-end posting on the emulator (4 tests),
31 unit tests. The old handicap job and mk1.txt are gone.

Waiting on Willy, in this order:
1. Cloudflare: create an API token from the template "Edit Cloudflare Workers"; add it to the
   marker repo as the GitHub secret CLOUDFLARE_API_TOKEN.
2. Cloud Shell: run `bash mk2.txt` (pinned to the tested commit). Then `bash mk2.txt verify`.
3. Re-run the "Deploy the worker" workflow (or Claude pushes). It deploys and writes the address.
4. GitHub Pages for the repo: main branch, root.
5. First real round in Philippine Golfers.

Later, with Willy's OK: copy the rules into the scorecard repo; iPhone/Android builds.
