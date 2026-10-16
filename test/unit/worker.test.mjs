/* The worker, run against an in-memory Firestore (test/unit/fakefs.mjs).
 * The same code runs on Cloudflare; only the Firestore underneath differs. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { fakeFs } from "./fakefs.mjs";
import { processSubmission, sweep, checkTee } from "../../worker/src/post.js";
import * as search from "../../worker/src/search.js";
import { verifyIdToken } from "../../worker/src/verify.js";
import { signJwt } from "../../worker/src/google.js";
import { FirestoreError } from "../../worker/src/firestore.js";
import * as model from "../../model.js";

const SCORER = "u-member";
const TODAY = "2026-10-16";
const holes = Array.from({ length: 18 }, (_, i) => ({ par: 4, yards: 380, si: i + 1 }));
const libTee = { name: "White (M)", rating: 70.1, slope: 125, par: 72, holes };
const win = (n, assocId = "G1") => Array.from({ length: n }, (_, i) => ({ roundId: `old${i}`, date: `2026-0${1 + (i % 8)}-1${i % 9}`, differential: 10 + i, assocId }));

function world(extra = {}) {
  return fakeFs({
    "associations/G1": { name: "Philippine Golfers" },
    "associations/G2": { name: "Saturday Group" },
    "associations/G3": { name: "Not mine" },
    [`associations/G1/members/${SCORER}`]: { uid: SCORER, role: "member" },
    [`associations/G2/members/${SCORER}`]: { uid: SCORER, role: "member" },
    "golfers/A": { name: "Ana Cruz", linkedUid: SCORER, groups: ["G1"], recentWindow: win(5), roundCount: 5, handicapIndex: 9.9 },
    "golfers/B": { name: "Ben Reyes", linkedUid: null, groups: ["G1", "G2"], recentWindow: [], roundCount: 0, manualIndex: 18 },
    "golfers/C": { name: "Cora Lim", linkedUid: null, groups: ["G2"], recentWindow: win(2, "G2"), roundCount: 2 },
    "golfers/D": { name: "Dan Go", groups: ["G3"], recentWindow: [], roundCount: 0 },
    "golfers/Z": { name: "Zed Old", groups: ["G1"], archived: true, recentWindow: [] },
    "associations/G1/roster/A": { golferId: "A" }, "associations/G1/roster/B": { golferId: "B" },
    "associations/G2/roster/C": { golferId: "C" }, "associations/G2/roster/B": { golferId: "B" },
    "associations/G3/roster/D": { golferId: "D" }, "associations/G1/roster/Z": { golferId: "Z" },
    "associations/G1/directory/A": { golferId: "A", displayName: "Ana Cruz", handicapIndex: 9.9 },
    "associations/G1/directory/B": { golferId: "B", displayName: "Ben Reyes", handicapIndex: 18 },
    "associations/G2/directory/B": { golferId: "B", displayName: "Ben Reyes", handicapIndex: 18 },
    "markerCourses/123": { providerId: "123", name: "Royal Ontario", where: "Milton, ON", tees: [libTee] },
    ...extra,
  });
}

const scoresOf = (v) => Object.fromEntries(Array.from({ length: 18 }, (_, i) => [String(i + 1), typeof v === "function" ? v(i + 1) : v]));
const player = (golferId, assocId, name, v = 5) => ({ golferId, assocId, name, index: 0, scores: scoresOf(v) });
function submission(fs, id, { players, ...c } = {}) {
  const card = {
    id, date: TODAY, holes: "18", start: 1, order: Array.from({ length: 18 }, (_, i) => i + 1),
    course: { providerId: "123", name: "Royal Ontario", where: "Milton, ON" },
    tee: { ...libTee, rating: 60, slope: 100 },    /* the phone's copy is NOT trusted when the library has the course */
    game: null,
    players: players || [player("A", "G1", "Ana Cruz"), player("B", "G1", "Ben Reyes", 6), player("C", "G2", "Cora Lim", (n) => (n === 7 ? "X" : 4))],
    ...c,
  };
  fs.docs.set(`markerSubmissions/${id}`, { data: { scorer: SCORER, status: "sent", createdAt: "t", app: "0.2.0", card }, updateTime: "2026-10-16T11:00:00.000Z" });
}
const post = (fs, id, opts = {}) => processSubmission(fs, id, { today: TODAY, onlyScorer: SCORER, ...opts });
const roundsIn = (fs, a) => [...fs.docs.keys()].filter((k) => k.startsWith(`associations/${a}/rounds/`)).map((k) => fs.data(k));

test("W1 a member's card posts every golfer, in their own group, in one commit", async () => {
  const fs = world();
  submission(fs, "c1");
  const r = await post(fs, "c1");
  assert.equal(r.status, "posted");
  assert.equal(fs.commits.length, 1);
  const g1 = roundsIn(fs, "G1"), g2 = roundsIn(fs, "G2");
  assert.deepEqual(g1.map((x) => x.golferId).sort(), ["A", "B"]);
  assert.deepEqual(g2.map((x) => x.golferId), ["C"]);
  const a = g1.find((x) => x.golferId === "A");
  assert.equal(a.gross, 90);
  assert.equal(a.enteredBy, SCORER);
  assert.ok(a.enteredAt);
  assert.equal(a.cardId, "c1");
  assert.equal(a.holes.length, 18);
  assert.equal(a.enteredVia, "marker");
  const sub = fs.data("markerSubmissions/c1");
  assert.equal(sub.status, "posted");
  assert.deepEqual(Object.keys(sub.rounds).sort(), ["A", "B", "C"]);
  assert.ok(sub.postedAt);
});

test("W2 the library's tee is used, not the phone's copy", async () => {
  const fs = world();
  submission(fs, "c1");
  await post(fs, "c1");
  for (const r of [...roundsIn(fs, "G1"), ...roundsIn(fs, "G2")]) {
    assert.equal(r.rating, 70.1);
    assert.equal(r.slope, 125);
    assert.equal(r.differential, model.differential(r.adjusted, 70.1, 125));
  }
});

test("W3 indexes come from the golfer records; picked-up holes count as net double bogey", async () => {
  const fs = world();
  submission(fs, "c1");
  await post(fs, "c1");
  const b = roundsIn(fs, "G1").find((x) => x.golferId === "B");
  assert.equal(b.indexAtEntry, 18);                       /* manual starting index, not the phone's 0 */
  assert.equal(b.courseHandicap, model.courseHandicap(18, 125, 70.1, 72));
  assert.equal(b.gross, 108);
  /* Ben's course handicap is 18: a stroke on every hole, so the cap is
     4+2+1 = 7 and his 6s are not cut. */
  assert.equal(b.adjusted, 108);
  const c = roundsIn(fs, "G2")[0];
  assert.equal(c.indexAtEntry, null);                     /* two rounds: no index yet */
  assert.equal(c.gross, 17 * 4 + 9);                      /* hole 7 picked up: par + 5 with no index */
  assert.equal(c.holes[6], "X");
});

test("W4 windows, indexes, round counts and directory entries move with the rounds", async () => {
  const fs = world();
  submission(fs, "c1");
  const { rounds } = await post(fs, "c1");
  const a = fs.data("golfers/A");
  assert.equal(a.roundCount, 6);
  assert.equal(a.recentWindow.length, 6);
  assert.ok(a.recentWindow.some((e) => e.roundId === rounds.A && e.assocId === "G1"));
  assert.equal(a.handicapIndex, model.displayIndex(a.recentWindow));
  assert.equal(fs.data("associations/G1/directory/A").handicapIndex, a.handicapIndex);
  /* Ben has a directory entry in both of his groups: both updated. */
  const b = fs.data("golfers/B");
  assert.equal(b.roundCount, 1);
  assert.ok(fs.data("associations/G1/directory/B").updatedAt > 0);
  assert.ok(fs.data("associations/G2/directory/B").updatedAt > 0);
  /* Cora has no directory entry: none is invented. */
  assert.equal(fs.data("associations/G2/directory/C"), null);
});

test("W5 a new course goes into The Scorecard once; the same course and tee are reused", async () => {
  const fs = world();
  submission(fs, "c1");
  await post(fs, "c1");
  const courses = [...fs.docs.keys()].filter((k) => /^courses\/[^/]+$/.test(k));
  assert.equal(courses.length, 1);
  const course = fs.data(courses[0]);
  assert.equal(course.name, "Royal Ontario");
  assert.equal(course.createdBy, SCORER);
  submission(fs, "c2", { players: [player("A", "G1", "Ana Cruz")] });
  await post(fs, "c2");
  assert.equal([...fs.docs.keys()].filter((k) => /^courses\/[^/]+$/.test(k)).length, 1);
  const ids = new Set(roundsIn(fs, "G1").map((r) => r.teeId));
  assert.equal(ids.size, 1);
});

test("W6 an existing course without this tee gets the tee added", async () => {
  const fs = world({ "courses/K": { name: "royal ontario", tees: [{ id: "t1", name: "Blue", rating: 72.5, slope: 131, par: 72 }], createdBy: "x" } });
  submission(fs, "c1");
  await post(fs, "c1");
  const k = fs.data("courses/K");
  assert.equal(k.tees.length, 2);
  assert.equal(roundsIn(fs, "G1")[0].courseId, "K");
  assert.equal(roundsIn(fs, "G1")[0].teeId, k.tees[1].id);
});

test("W7 posting twice writes nothing twice", async () => {
  const fs = world();
  submission(fs, "c1");
  await post(fs, "c1");
  const r = await post(fs, "c1");
  assert.equal(r.status, "posted");
  assert.equal(fs.commits.length, 1);
  assert.equal(roundsIn(fs, "G1").length, 2);
});

test("W8 a golfer changed by somebody else meanwhile: read again, post once", async () => {
  const fs = world();
  submission(fs, "c1");
  fs.failNext = new FirestoreError(400, "FAILED_PRECONDITION");
  const r = await post(fs, "c1");
  assert.equal(r.status, "posted");
  assert.equal(roundsIn(fs, "G1").length, 2);
  assert.equal(fs.data("golfers/A").roundCount, 6);
});

test("W9 only the scorer can wake their card", async () => {
  const fs = world();
  submission(fs, "c1");
  const r = await processSubmission(fs, "c1", { today: TODAY, onlyScorer: "someone-else" });
  assert.equal(r.status, "unknown");
  assert.equal(fs.data("markerSubmissions/c1").status, "sent");
});

const refusedFor = async (t, mutate, why) => {
  const fs = world(mutate.seed || {});
  submission(fs, "c1", mutate.card || {});
  const r = await post(fs, "c1");
  assert.equal(r.status, "refused", t);
  assert.match(r.reason, why, t);
  assert.equal(fs.data("markerSubmissions/c1").status, "refused");
  assert.equal(roundsIn(fs, "G1").length + roundsIn(fs, "G2").length, 0, t + ": nothing posted");
};

test("W10 cards that must not be posted are refused, with the reason, and nothing is written", async () => {
  await refusedFor("group not mine", { card: { players: [player("D", "G3", "Dan Go")] } }, /not a member of Dan's group/);
  await refusedFor("archived", { card: { players: [player("Z", "G1", "Zed Old")] } }, /archived/);
  await refusedFor("not on roster", { card: { players: [player("C", "G1", "Cora Lim")] } }, /no longer on the group's roster/);
  await refusedFor("unknown golfer", { card: { players: [player("Q", "G1", "Quin")] } }, /no longer in The Scorecard/);
  await refusedFor("hole missing", { card: { players: [{ ...player("A", "G1", "Ana Cruz"), scores: { ...scoresOf(5), 12: null } }] } }, /no score on hole 12/);
  await refusedFor("21 on a hole", { card: { players: [player("A", "G1", "Ana Cruz", 21)] } }, /no score on hole 1/);
  await refusedFor("nine holes", { card: { holes: "front", order: [1, 2, 3, 4, 5, 6, 7, 8, 9] } }, /18-hole/);
  await refusedFor("twice", { card: { players: [player("A", "G1", "Ana"), player("A", "G1", "Ana")] } }, /twice/);
  await refusedFor("five", { card: { players: ["A", "B", "C", "A", "B"].map((g) => player(g, "G1", g)) } }, /one to four/);
  await refusedFor("future", { card: { date: "2026-10-20" } }, /future/);
  await refusedFor("the withdrawn details", { seed: { "courses/K": { name: "Royal Ontario", tees: [{ id: "t", name: "White", rating: 70.1, slope: 125, par: 72 }], withdrawn: true } } }, /withdrawn from The Scorecard.*Enter the course yourself/);
  await refusedFor("course withdrawn in the library", { seed: { "markerCourses/123": { name: "Royal Ontario", tees: [libTee], withdrawn: true } } }, /withdrawn/);
  await refusedFor("hand-entered tee without a slope", { card: { course: { providerId: null, name: "Home Course" }, tee: { name: "W", rating: 70, slope: null, par: 72, holes } } }, /slope/);
  await refusedFor("account being deleted", { seed: { [`accountDeletions/${SCORER}`]: { at: 1 } } }, /being deleted/);
});

test("W11 a game counts only for golfers of its group, and only on its day", async () => {
  const fs = world({ "associations/G1/games/gm": { name: "Saturday", date: TODAY, courseId: "x" } });
  submission(fs, "c1", { game: { id: "gm", name: "Saturday", assocId: "G1" } });
  await post(fs, "c1");
  assert.ok(roundsIn(fs, "G1").every((r) => r.gameId === "gm"));
  assert.equal(roundsIn(fs, "G2")[0].gameId, null);
  const fs2 = world({ "associations/G1/games/gm": { name: "Saturday", date: "2026-10-01", courseId: "x" } });
  submission(fs2, "c1", { game: { id: "gm", name: "Saturday", assocId: "G1" } });
  await post(fs2, "c1");
  assert.ok(roundsIn(fs2, "G1").every((r) => r.gameId === null));
});

test("W12 the sweep posts a card whose wake-up never arrived, one per run", async () => {
  const fs = world();
  submission(fs, "c1");
  submission(fs, "c2", { players: [player("A", "G1", "Ana Cruz")] });
  const r1 = await sweep(fs);
  assert.deepEqual(r1, { posted: 1, refused: 0, left: 0 });
  const r2 = await sweep(fs);
  assert.deepEqual(r2, { posted: 1, refused: 0, left: 0 });
  assert.deepEqual(await sweep(fs), { posted: 0, refused: 0, left: 0 });
});

test("W13 one card stays well inside the free plan's 50 requests", async () => {
  const fs = world();
  submission(fs, "c1", { players: [player("A", "G1", "Ana"), player("B", "G1", "Ben"), player("C", "G2", "Cora"), player("B", "G2", "Ben")].slice(0, 3) });
  await post(fs, "c1");
  assert.ok(fs.calls <= 40, `used ${fs.calls}`);
});

test("W14 a tee's numbers are checked", () => {
  assert.throws(() => checkTee({ name: "x", rating: 70, slope: 160, par: 72 }), /slope/);
  assert.throws(() => checkTee({ name: "x", rating: 70, slope: 120, par: 72, holes: holes.map((h) => ({ ...h, si: 1 })) }), /share a stroke index/);
  assert.throws(() => checkTee({ name: "x", rating: 70, slope: 120, par: 72, holes: holes.slice(0, 9) }), /18 holes/);
  assert.equal(checkTee(libTee).rating, 70.1);
});

/* ---------------- search limits ---------------- */

test("L1 without an account: 10 searches a day each; members 100", async () => {
  const fs = fakeFs();
  const anon = { uid: "a1", anonymous: true };
  for (let i = 0; i < 10; i++) await search.count(fs, anon);
  await assert.rejects(search.count(fs, anon), search.LimitReached);
  const member = { uid: "m1", anonymous: false };
  for (let i = 0; i < 100; i++) await search.count(fs, member);
  await assert.rejects(search.count(fs, member), search.LimitReached);
  /* Tomorrow starts again. */
  await search.count(fs, anon, { now: Date.now() + 86400000 });
});

test("L2 all players without an account stop at 300 a day together", async () => {
  const day = new Date().toISOString().slice(0, 10);
  const fs = fakeFs({ [`markerLimits/day-${day}`]: { count: 300 } });
  await assert.rejects(search.count(fs, { uid: "a9", anonymous: true }), search.LimitReached);
  await search.count(fs, { uid: "m9", anonymous: false });   /* members are not in that total */
});

test("L3 a course fetched once is saved for everybody and not counted again", async () => {
  const fs = fakeFs();
  const real = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = async (url, opts) => {
    hits++;
    assert.equal(opts.headers.Authorization, "Key K");
    return new Response(JSON.stringify({ course: { id: 77, club_name: "Wack Wack", location: { city: "Manila" }, tees: { male: [{ tee_name: "Blue", course_rating: 72, slope_rating: 128, par_total: 72, holes }] } } }), { status: 200 });
  };
  try {
    const who = { uid: "a1", anonymous: true };
    const c = await search.course(fs, who, "77", "K");
    assert.equal(c.tees[0].holes.length, 18);
    assert.equal(fs.data("markerCourses/77").name, "Wack Wack");
    await search.course(fs, who, "77", "K");
    assert.equal(hits, 1);
    assert.equal(fs.data("markerLimits/a1").count, 1);
  } finally { globalThis.fetch = real; }
});

/* ---------------- who is calling ---------------- */

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const jwks = { k1: { ...publicKey.export({ format: "jwk" }), kid: "k1" } };
const now = Math.floor(Date.now() / 1000);
const claims = (x = {}) => ({ aud: "scorecard-f41b8", iss: "https://securetoken.google.com/scorecard-f41b8", sub: "u1", iat: now, auth_time: now, exp: now + 3600, email: "a@b.c", firebase: { sign_in_provider: "password" }, ...x });

test("V1 a Firebase sign-in is checked properly", async () => {
  const ok = await verifyIdToken(await signJwt(claims(), pem, "k1"), "scorecard-f41b8", { jwks });
  assert.deepEqual(ok, { uid: "u1", email: "a@b.c", anonymous: false });
  const anon = await verifyIdToken(await signJwt(claims({ email: undefined, firebase: { sign_in_provider: "anonymous" } }), pem, "k1"), "scorecard-f41b8", { jwks });
  assert.equal(anon.anonymous, true);
  await assert.rejects(verifyIdToken(await signJwt(claims({ aud: "other" }), pem, "k1"), "scorecard-f41b8", { jwks }), /BAD_TOKEN/);
  await assert.rejects(verifyIdToken(await signJwt(claims({ exp: now - 10 }), pem, "k1"), "scorecard-f41b8", { jwks }), /EXPIRED/);
  await assert.rejects(verifyIdToken(await signJwt(claims(), pem, "nope"), "scorecard-f41b8", { jwks }), /BAD_TOKEN/);
  const t = await signJwt(claims(), pem, "k1");
  const [h, , s] = t.split(".");
  const forged = `${h}.${Buffer.from(JSON.stringify(claims({ sub: "admin" }))).toString("base64url")}.${s}`;
  await assert.rejects(verifyIdToken(forged, "scorecard-f41b8", { jwks }), /BAD_TOKEN/);
  await assert.rejects(verifyIdToken("", "scorecard-f41b8", { jwks }), /NO_TOKEN/);
});

/* ---------------- the front door ---------------- */

import worker from "../../worker/src/index.js";
const env = { PROJECT: "scorecard-f41b8", ORIGINS: "https://willyros01.github.io", VERSION: "t" };

test("R1 health, CORS for the app's site only, and nothing without a sign-in", async () => {
  const h = await worker.fetch(new Request("https://w/health", { headers: { Origin: "https://willyros01.github.io" } }), env);
  assert.equal(h.status, 200);
  assert.equal(h.headers.get("Access-Control-Allow-Origin"), "https://willyros01.github.io");
  const evil = await worker.fetch(new Request("https://w/health", { headers: { Origin: "https://evil.example" } }), env);
  assert.equal(evil.headers.get("Access-Control-Allow-Origin"), null);
  const pre = await worker.fetch(new Request("https://w/wake", { method: "OPTIONS", headers: { Origin: "https://willyros01.github.io" } }), env);
  assert.equal(pre.status, 204);
  for (const path of ["/search?q=royal", "/course?id=1"]) {
    const r = await worker.fetch(new Request("https://w" + path), env);
    assert.equal(r.status, 401);
  }
  const w = await worker.fetch(new Request("https://w/wake", { method: "POST", body: "{}" }), env);
  assert.equal(w.status, 401);
});

/* ---------------- withdrawn courses (Willy, 16 Oct 2026) ---------------- */

const withdrawnK = { "courses/K": { name: "Royal Ontario", tees: [{ id: "t", name: "White", rating: 70.1, slope: 125, par: 72 }], withdrawn: true, createdBy: "x" } };
const handTee = (rating, slope) => ({ name: "White", rating, slope, par: 72, holes });
const handCard = (rating, slope) => ({ course: { providerId: null, name: "Royal Ontario", where: "" }, tee: handTee(rating, slope), players: [player("A", "G1", "Ana Cruz")] });
const scorecardCourses = (fs) => [...fs.docs.keys()].filter((k) => /^courses\/[^/]+$/.test(k));

test("X1 a course entered by hand after a withdrawal is accepted as a new course, and shared in the course list", async () => {
  const fs = world(withdrawnK);
  submission(fs, "c1", handCard(71.4, 129));
  const r = await post(fs, "c1");
  assert.equal(r.status, "posted", r.reason);
  assert.equal(scorecardCourses(fs).length, 2, "the withdrawn one stays, untouched");
  assert.deepEqual(fs.data("courses/K").tees.length, 1);
  const round = roundsIn(fs, "G1")[0];
  assert.notEqual(round.courseId, "K");
  assert.equal(round.rating, 71.4);
  const lib = fs.data(`markerCourses/m-${round.courseId}`);
  assert.equal(lib.manual, true);
  assert.equal(lib.tees[0].holes.length, 18);
  /* The next card picks it from the list ("m-" id) and posts to that same course. */
  submission(fs, "c2", { course: { providerId: `m-${round.courseId}`, name: "Royal Ontario" }, tee: handTee(71.4, 129), players: [player("B", "G1", "Ben Reyes")] });
  assert.equal((await post(fs, "c2")).status, "posted");
  assert.equal(scorecardCourses(fs).length, 2);
  assert.equal(roundsIn(fs, "G1").find((x) => x.golferId === "B").courseId, round.courseId);
});

test("X2 the withdrawn details are refused however they come: typed in by hand, or from the database", async () => {
  const fs = world(withdrawnK);
  submission(fs, "c1", handCard(70.1, 125));
  assert.equal((await post(fs, "c1")).status, "refused");
  const fs2 = world(withdrawnK);
  submission(fs2, "c1");   /* the library still holds the old 70.1 / 125 */
  const r = await post(fs2, "c1");
  assert.equal(r.status, "refused");
  assert.match(r.reason, /can never be used again/);
});

test("X3 corrected details from the golf course database are accepted after a withdrawal", async () => {
  const fs = world({ ...withdrawnK, "markerCourses/123": { providerId: "123", name: "Royal Ontario", tees: [{ ...libTee, rating: 71.0, slope: 131 }] } });
  submission(fs, "c1");
  const r = await post(fs, "c1");
  assert.equal(r.status, "posted", r.reason);
  assert.equal(roundsIn(fs, "G1")[0].rating, 71.0);
  assert.notEqual(roundsIn(fs, "G1")[0].courseId, "K");
  assert.equal(fs.data("markerCourses/m-" + roundsIn(fs, "G1")[0].courseId), null, "a database course is not copied as a hand entry");
});

test("X4 a hand-entered course that is itself withdrawn later is refused", async () => {
  const fs = world({ "courses/M": { name: "Home Course", tees: [{ id: "t", name: "W", rating: 69, slope: 120, par: 72 }], withdrawn: true },
    "markerCourses/m-M": { providerId: "m-M", name: "Home Course", tees: [handTee(69, 120)], manual: true } });
  submission(fs, "c1", { course: { providerId: "m-M", name: "Home Course" }, tee: handTee(69, 120), players: [player("A", "G1", "Ana")] });
  assert.equal((await post(fs, "c1")).status, "refused");
});

test("X5 looking a course up after a withdrawal asks the database again and marks withdrawn tees", async () => {
  search.forgetWithdrawn();
  const fs = world(withdrawnK);
  const real = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = async () => {
    hits++;
    return new Response(JSON.stringify({ course: { id: 123, club_name: "Royal Ontario", tees: { male: [
      { tee_name: "White", course_rating: 70.1, slope_rating: 125, par_total: 72, holes },
      { tee_name: "Blue", course_rating: 72.2, slope_rating: 133, par_total: 72, holes }] } } }), { status: 200 });
  };
  try {
    const c = await search.course(fs, { uid: "m1", anonymous: false }, "123", "K");
    assert.equal(hits, 1, "asked again even though the library had it");
    assert.deepEqual(c.tees.map((t) => [t.name, t.withdrawn]), [["White (M)", true], ["Blue (M)", false]]);
    assert.equal(fs.data("markerCourses/123").tees.length, 2, "the library copy is replaced");
    assert.deepEqual((await search.withdrawnList(fs)).map((w) => w.id), ["K"]);
  } finally { globalThis.fetch = real; search.forgetWithdrawn(); }
});

/* ---------------- reading a scorecard photo ---------------- */

const p18 = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 5, 4, 4, 4, 3, 4, 5];
const s18 = [7, 3, 15, 1, 11, 5, 17, 13, 9, 8, 14, 2, 6, 12, 4, 18, 16, 10];

/* What the model answers for one table: holes 1-9 of Royal Ontario (the
   answer the lab got from a real picture, trimmed to two tees). */
const FRONT_PARS = [4, 3, 5, 4, 4, 4, 4, 3, 5], FRONT_HCP = [6, 10, 4, 8, 16, 2, 14, 18, 12];
const FRONT_WHITE = [375, 143, 482, 363, 216, 385, 322, 124, 506], FRONT_BLUE = [394, 166, 502, 426, 239, 405, 332, 142, 542];
const frontAnswer = (over = {}) => ({
  course: "Royal Ontario Golf Club",
  holes: FRONT_PARS.map((p, i) => ({ hole: i + 1, par: p, hcp: FRONT_HCP[i], yards: { BLUE: FRONT_BLUE[i], WHITE: FRONT_WHITE[i] } })),
  tees: [{ name: "BLUE", rating: 71.5, slope: 136, out: 3148, in: null }, { name: "WHITE", rating: 69.7, slope: 130, out: 2916, in: null }],
  parOut: 36, parIn: null, ...over,
});

test("P1 a table read by hole number: only those holes, totals checked, nothing invented", () => {
  const r = search.normalizeScan("```json\n" + JSON.stringify(frontAnswer()) + "\n```");
  assert.deepEqual(r.holesRead, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const w = r.tees.find((t) => t.name === "WHITE");
  assert.equal(w.rating, 69.7); assert.equal(w.slope, 130);
  assert.deepEqual(w.holes.slice(0, 9).map((h) => h.yards), FRONT_WHITE);
  assert.deepEqual(w.holes.slice(0, 9).map((h) => h.par), FRONT_PARS);
  assert.deepEqual(w.holes.slice(0, 9).map((h) => h.si), FRONT_HCP);
  assert.equal(w.holes[9].par, null, "hole 10 was not in the picture");
  assert.deepEqual(w.doubt, { par: [], yards: [], si: [] });
});

test("P2 numbers that do not add up to the card's totals, or repeat, are flagged", () => {
  const bad = frontAnswer();
  bad.holes[2].par = 4;                 /* hole 3 misread: pars now add to 35, card says 36 */
  bad.holes[0].yards.WHITE = 357;       /* white yards no longer add to 2916 */
  bad.holes[4].hcp = 6;                 /* handicap 6 twice */
  const w = search.normalizeScan(bad).tees.find((t) => t.name === "WHITE");
  assert.deepEqual(w.doubt.par, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(w.doubt.yards, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(w.doubt.si, [1, 5]);
  const b = search.normalizeScan(bad).tees.find((t) => t.name === "BLUE");
  assert.deepEqual(b.doubt.yards, [], "blue still adds up");
  assert.throws(() => search.normalizeScan("I cannot see a scorecard"), /SCAN_UNREADABLE/);
  assert.throws(() => search.normalizeScan({ holes: [] }), /SCAN_UNREADABLE/);
  assert.equal(search.normalizeScan({ ...frontAnswer(), holes: frontAnswer().holes.map((h) => ({ ...h, par: 9 })) }).tees[0].holes[0].par, null, "par 9 is not believable");
  /* A chat-style answer (some models) is read the same way. */
  assert.equal(search.normalizeScan({ choices: [{ message: { content: JSON.stringify(frontAnswer()) } }] }).holesRead.length, 9);
});

test("P2b a picture goes to Cloudflare's AI once, counted; limits and failures are explained", async () => {
  const fs = fakeFs();
  const calls = [];
  const ai = { run: async (model, input) => { calls.push({ model, input }); return { response: frontAnswer() }; } };
  const img = "data:image/jpeg;base64,/9j/4AAQ";
  const who = { uid: "m1", anonymous: false };
  const r = await search.scan(fs, who, img, ai);
  assert.equal(r.tees.length, 2);
  assert.equal(calls[0].model, search.SCAN_MODEL);
  assert.equal(calls[0].input.messages[0].content[1].image_url.url, img);
  await assert.rejects(search.scan(fs, who, "http://evil/x.jpg", ai), /SCAN_BAD_PHOTO/);
  await assert.rejects(search.scan(fs, who, "data:image/jpeg;base64," + "A".repeat(1_600_000), ai), /SCAN_TOO_BIG/);
  for (let i = 1; i < search.SCAN_LIMITS.member; i++) await search.scan(fs, who, img, ai);
  await assert.rejects(search.scan(fs, who, img, ai), search.LimitReached);
  await assert.rejects(search.scan(fakeFs(), who, img, { run: async () => { throw new Error("You must agree to the license"); } }), /AI_LICENCE/);
  await assert.rejects(search.scan(fakeFs(), who, img, { run: async () => { throw new Error("daily free allocation of neurons exceeded"); } }), /SCAN_BUSY/);
  await assert.rejects(search.scan(fakeFs(), who, img, null), /NOT_SET_UP/);
});

test("P3 all photos together stop at the day's total", async () => {
  const day = new Date().toISOString().slice(0, 10);
  const fs = fakeFs({ [`markerLimits/scans-${day}`]: { count: search.SCAN_LIMITS.total } });
  const ai = { run: async () => ({ response: frontAnswer() }) };
  await assert.rejects(search.scan(fs, { uid: "m2", anonymous: false }, "data:image/png;base64,iVBO", ai), search.LimitReached);
});
