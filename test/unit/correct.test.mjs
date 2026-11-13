/* Correcting a posted card (worker/src/correct.js), against the in-memory
 * Firestore. Willy, 18 Oct 2026: the scorer for 24 hours, an owner or admin
 * at any time; everything in one commit; refused when The Scorecard changed
 * or deleted the round since. */
import test from "node:test";
import assert from "node:assert/strict";
import { fakeFs } from "./fakefs.mjs";
import { processSubmission } from "../../worker/src/post.js";
import * as fix from "../../worker/src/correct.js";
import * as model from "../../model.js";

const SCORER = "u-member", ADMIN = "u-admin", OTHER = "u-other";
const TODAY = "2026-10-16";
const holes = Array.from({ length: 18 }, (_, i) => ({ par: 4, yards: 380, si: i + 1 }));
const libTee = { name: "White (M)", rating: 70.1, slope: 125, par: 72, holes };
const win = (n) => Array.from({ length: n }, (_, i) => ({ roundId: `old${i}`, date: `2026-0${1 + (i % 8)}-1${i % 9}`, differential: 10 + i, assocId: "G1" }));
const scoresOf = (v) => Object.fromEntries(Array.from({ length: 18 }, (_, i) => [String(i + 1), v]));

function world() {
  const fs = fakeFs({
    "associations/G1": { name: "Golf Buddies", ownerUid: "u-owner" },
    [`associations/G1/members/${SCORER}`]: { uid: SCORER, role: "member" },
    [`associations/G1/members/${ADMIN}`]: { uid: ADMIN, role: "admin" },
    [`associations/G1/members/${OTHER}`]: { uid: OTHER, role: "member" },
    "golfers/A": { name: "Ana Cruz", groups: ["G1"], recentWindow: win(5), roundCount: 5, handicapIndex: 9.9 },
    "golfers/B": { name: "Ben Reyes", groups: ["G1"], recentWindow: [], roundCount: 0, manualIndex: 18 },
    "associations/G1/roster/A": { golferId: "A" }, "associations/G1/roster/B": { golferId: "B" },
    "associations/G1/directory/A": { golferId: "A", displayName: "Ana Cruz", handicapIndex: 9.9 },
    "associations/G1/directory/B": { golferId: "B", displayName: "Ben Reyes", handicapIndex: 18 },
    "markerCourses/123": { providerId: "123", name: "Royal Ontario", where: "Milton, ON", tees: [libTee] },
  });
  const card = {
    id: "c1", date: TODAY, holes: "18", start: 1, order: Array.from({ length: 18 }, (_, i) => i + 1),
    course: { providerId: "123", name: "Royal Ontario", where: "Milton, ON" }, tee: { ...libTee }, game: null,
    players: [{ golferId: "A", assocId: "G1", name: "Ana Cruz", scores: scoresOf(5) }, { golferId: "B", assocId: "G1", name: "Ben Reyes", scores: scoresOf(6) }],
  };
  fs.docs.set("markerSubmissions/c1", { data: { scorer: SCORER, status: "sent", createdAt: "t", app: "0.5.9", card }, updateTime: "2026-10-16T11:00:00.000Z" });
  return fs;
}
const posted = async () => { const fs = world(); const r = await processSubmission(fs, "c1", { today: TODAY }); assert.equal(r.status, "posted"); return { fs, rounds: r.rounds }; };
const postedAt = (fs) => Date.parse(fs.data("markerSubmissions/c1").postedAt);
const who = (uid) => ({ uid, anonymous: false });
const fixHole1 = (v = 4) => ({ A: { ...scoresOf(5), 1: v }, B: scoresOf(6) });

test("C1 the scorer corrects a score: round, index, directory and card change together, with a record", async () => {
  const { fs, rounds } = await posted();
  const before = fs.data(`associations/G1/rounds/${rounds.A}`);
  const commits = fs.commits.length;
  const r = await fix.correct(fs, who(SCORER), { cardId: "c1", scores: fixHole1(4) }, { now: postedAt(fs) + 3600_000 });
  assert.equal(r.status, "corrected");
  assert.deepEqual(r.changed, ["Ana Cruz"]);
  assert.equal(fs.commits.length, commits + 1, "one commit");
  const after = fs.data(`associations/G1/rounds/${rounds.A}`);
  assert.equal(after.gross, before.gross - 1);
  assert.equal(after.holes[0], 4);
  assert.equal(after.corrections.length, 1);
  assert.equal(after.corrections[0].as, "scorer");
  assert.equal(after.corrections[0].before.gross, before.gross);
  assert.equal(after.indexAtEntry, before.indexAtEntry, "the frozen handicap stays");
  const a = fs.data("golfers/A");
  const entry = a.recentWindow.find((e) => e.roundId === rounds.A);
  assert.equal(entry.differential, after.differential);
  assert.equal(a.handicapIndex, model.displayIndex(a.recentWindow));
  assert.equal(fs.data("associations/G1/directory/A").handicapIndex, model.effectiveIndex(a).index);
  assert.equal(fs.data(`associations/G1/rounds/${rounds.B}`).corrections, undefined, "an unchanged golfer is not touched");
  assert.equal(fs.data("markerSubmissions/c1").card.players[0].scores["1"], 4);
  assert.equal(fs.data("markerSubmissions/c1").corrections, 1);
});

test("C2 after 24 hours the scorer may not; an admin may, at any time; another member never", async () => {
  const { fs } = await posted();
  const late = postedAt(fs) + 25 * 3600_000;
  await assert.rejects(fix.correct(fs, who(SCORER), { cardId: "c1", scores: fixHole1() }, { now: late }), /owner or admin/);
  await assert.rejects(fix.correct(fs, who(OTHER), { cardId: "c1", scores: fixHole1() }, { now: postedAt(fs) }), /no longer be corrected by you|Only the scorer/);
  const r = await fix.correct(fs, who(ADMIN), { cardId: "c1", scores: fixHole1() }, { now: late });
  assert.equal(r.status, "corrected");
  const list = await fix.correctable(fs, who(SCORER), { now: late });
  assert.equal(list.length, 0);
  assert.equal((await fix.correctable(fs, who(ADMIN), { now: late })).length, 1);
  assert.equal((await fix.correctable(fs, who("u-owner"), { now: late })).length, 1, "the group's owner too");
});

test("C3 refused when The Scorecard changed or deleted the round since posting; nothing written", async () => {
  const { fs, rounds } = await posted();
  const path = `associations/G1/rounds/${rounds.A}`;
  const doc = fs.docs.get(path);
  fs.docs.set(path, { ...doc, data: { ...doc.data, gross: doc.data.gross + 2 }, updateTime: "2026-10-17T00:00:00.000Z" });
  const commits = fs.commits.length;
  await assert.rejects(fix.correct(fs, who(SCORER), { cardId: "c1", scores: fixHole1() }, { now: postedAt(fs) }), /changed in The Scorecard/);
  fs.docs.delete(path);
  await assert.rejects(fix.correct(fs, who(SCORER), { cardId: "c1", scores: fixHole1() }, { now: postedAt(fs) }), /deleted in The Scorecard/);
  assert.equal(fs.commits.length, commits);
});

test("C4 bad scores are refused; the same scores change nothing; a second correction builds on the first", async () => {
  const { fs, rounds } = await posted();
  const now = postedAt(fs) + 60_000;
  await assert.rejects(fix.correct(fs, who(SCORER), { cardId: "c1", scores: { A: { ...scoresOf(5), 3: 0 }, B: scoresOf(6) } }, { now }), /no score on hole 3/);
  assert.equal((await fix.correct(fs, who(SCORER), { cardId: "c1", scores: { A: scoresOf(5), B: scoresOf(6) } }, { now })).status, "unchanged");
  await fix.correct(fs, who(SCORER), { cardId: "c1", scores: fixHole1(4) }, { now });
  await fix.correct(fs, who(SCORER), { cardId: "c1", scores: { A: { ...scoresOf(5), 1: 4, 2: "X" }, B: scoresOf(6) } }, { now });
  const r = fs.data(`associations/G1/rounds/${rounds.A}`);
  assert.equal(r.corrections.length, 2);
  assert.equal(r.holes[1], "X");
  assert.equal(fs.data("markerSubmissions/c1").corrections, 2);
});

test("C5 a golfer changed at the same moment: the whole correction is refused, nothing half-written", async () => {
  const { fs, rounds } = await posted();
  const real = fs.get.bind(fs);
  fs.get = async (p) => {
    const d = await real(p);
    if (p === "golfers/A") { const cur = fs.docs.get(p); fs.docs.set(p, { ...cur, updateTime: "2099-01-01T00:00:00.000Z" }); }
    return d;
  };
  const before = fs.data(`associations/G1/rounds/${rounds.A}`).gross;
  await assert.rejects(fix.correct(fs, who(SCORER), { cardId: "c1", scores: fixHole1() }, { now: postedAt(fs) }), /a moment ago/);
  assert.equal(fs.data(`associations/G1/rounds/${rounds.A}`).gross, before);
});

test("C6 the card for correction carries each golfer's frozen handicap", async () => {
  const { fs } = await posted();
  const c = await fix.cardForCorrection(fs, who(SCORER), "c1", { now: postedAt(fs) });
  assert.equal(c.as, "scorer");
  assert.equal(c.card.players.length, 2);
  assert.equal(c.handicaps.length, 2);
  assert.ok(c.until);
});

/* 0.6.1 (Willy, 18 Oct 2026): a card whose rounds were deleted in The
   Scorecard is not correctable; it is "editable": re-post it as a new card
   (only the golfers whose rounds are gone) or hide it. */
/* Handed in `after` ms after the old card was posted (1 hour by default). */
const repostSub = (fs, id, players, repostOf = "c1", scorer = SCORER, after = 3600_000) => {
  const old = fs.data("markerSubmissions/c1").card;
  const createdAt = new Date(postedAt(fs) + after).toISOString();
  fs.docs.set(`markerSubmissions/${id}`, { data: { scorer, status: "sent", createdAt, app: "0.6.1", card: { ...old, id, repostOf, players } }, updateTime: "2026-10-18T01:00:00.000Z" });
};

test("C7 deleted rounds: not correctable, editable with only the golfers whose rounds are gone, full names", async () => {
  const { fs, rounds } = await posted();
  fs.docs.delete(`associations/G1/rounds/${rounds.B}`);
  const m = await fix.myCards(fs, who(SCORER), { now: postedAt(fs) + 3600_000 });
  assert.equal(m.correctable.length, 0);
  assert.equal(m.editable.length, 1);
  assert.deepEqual(m.editable[0].gone, ["Ben Reyes"]);
  assert.deepEqual(m.editable[0].card.players.map((p) => p.golferId), ["B"]);
  assert.equal(m.editable[0].card.players[0].index, 18);
  assert.equal((await fix.myCards(fs, who(OTHER))).editable.length, 0, "another member never sees it");
  /* Willy, 20 Oct 2026: the scorer for 24 hours, an owner or admin at any time. */
  assert.equal((await fix.myCards(fs, who(SCORER), { now: postedAt(fs) + 25 * 3600_000 })).editable.length, 0, "the scorer, not after 24 hours");
  assert.equal((await fix.myCards(fs, who(ADMIN), { now: postedAt(fs) + 30 * 86400_000 })).editable.length, 1, "an admin, at any time");
  await assert.rejects(fix.cardForCorrection(fs, who(SCORER), "c1", { now: postedAt(fs) }), /Ben Reyes's round/);
});

test("C8 re-post: posted as a new card, the old card marked in the same commit, then gone from the list", async () => {
  const { fs, rounds } = await posted();
  fs.docs.delete(`associations/G1/rounds/${rounds.B}`);
  const old = fs.data("markerSubmissions/c1").card;
  repostSub(fs, "c2", [{ ...old.players[1], scores: scoresOf(5) }]);
  const commits = fs.commits.length;
  const r = await processSubmission(fs, "c2", { today: TODAY });
  assert.equal(r.status, "posted");
  assert.equal(fs.commits.length, commits + 1, "one commit");
  assert.equal(fs.data("markerSubmissions/c1").repostedAs, "c2");
  assert.ok(fs.data(`associations/G1/rounds/${r.rounds.B}`));
  assert.equal(fs.data("golfers/B").roundCount, 2, "the old posting plus the re-post (this fake store does not undo counts on delete)");
  const m = await fix.myCards(fs, who(SCORER), { now: postedAt(fs) });
  assert.equal(m.editable.length, 0);
});

test("C12 the scorer may re-post for 24 hours after posting; an owner or admin at any time", async () => {
  const { fs, rounds } = await posted();
  fs.docs.delete(`associations/G1/rounds/${rounds.B}`);
  const old = fs.data("markerSubmissions/c1").card;
  repostSub(fs, "c7", [old.players[1]], "c1", SCORER, 25 * 3600_000);
  const late = await processSubmission(fs, "c7", { today: TODAY });
  assert.equal(late.status, "refused");
  assert.match(late.reason, /24 hours/);
  assert.equal(fs.data("markerSubmissions/c1").repostedAs, undefined, "nothing written");
  repostSub(fs, "c8", [old.players[1]], "c1", ADMIN, 30 * 86400_000);
  assert.equal((await processSubmission(fs, "c8", { today: TODAY })).status, "posted");
  assert.equal(fs.data("markerSubmissions/c1").repostedAs, "c8");
});

test("C9 re-post refused when a golfer's old round is still there (never counted twice), or already re-posted", async () => {
  const { fs, rounds } = await posted();
  fs.docs.delete(`associations/G1/rounds/${rounds.B}`);
  const old = fs.data("markerSubmissions/c1").card;
  repostSub(fs, "c2", old.players);
  const r = await processSubmission(fs, "c2", { today: TODAY });
  assert.equal(r.status, "refused");
  assert.match(r.reason, /Ana Cruz's round .* still in The Scorecard/);
  assert.equal(fs.data("golfers/A").roundCount, 6, "nothing written");
  repostSub(fs, "c3", [old.players[1]]);
  assert.equal((await processSubmission(fs, "c3", { today: TODAY })).status, "posted");
  repostSub(fs, "c4", [old.players[1]]);
  const again = await processSubmission(fs, "c4", { today: TODAY });
  assert.equal(again.status, "refused");
  assert.match(again.reason, /already been re-posted/);
});

test("C10 hide: only the scorer or an admin; nothing in The Scorecard changes", async () => {
  const { fs, rounds } = await posted();
  fs.docs.delete(`associations/G1/rounds/${rounds.A}`);
  fs.docs.delete(`associations/G1/rounds/${rounds.B}`);
  const soon = { now: postedAt(fs) + 3600_000 };
  assert.equal((await fix.myCards(fs, who(ADMIN))).editable.length, 1, "an admin sees it too");
  await assert.rejects(fix.hideEditable(fs, who(OTHER), "c1", soon), /Only the scorer/);
  await assert.rejects(fix.hideEditable(fs, who(SCORER), "c1", { now: postedAt(fs) + 25 * 3600_000 }), /24 hours/);
  const golferB = JSON.stringify(fs.data("golfers/B"));
  await fix.hideEditable(fs, who(ADMIN), "c1");
  const after = (await fix.myCards(fs, who(SCORER), soon)).editable;
  assert.equal(after.filter((x) => !x.hidden).length, 0, "off the list");
  assert.equal(after.length, 1, "still offered when the card is opened");
  assert.equal(JSON.stringify(fs.data("golfers/B")), golferB);
  await fix.hideEditable(fs, who(SCORER), "c1", { ...soon, hidden: false });
  assert.equal((await fix.myCards(fs, who(SCORER), soon)).editable.filter((x) => !x.hidden).length, 1, "unhidden: back on the list");
});

test("C11 a member who is not the scorer nor an admin cannot re-post somebody else's card", async () => {
  const { fs, rounds } = await posted();
  fs.docs.delete(`associations/G1/rounds/${rounds.B}`);
  const old = fs.data("markerSubmissions/c1").card;
  repostSub(fs, "c6", [old.players[1]], "c1", OTHER);
  const r = await processSubmission(fs, "c6", { today: TODAY });
  assert.equal(r.status, "refused");
  assert.match(r.reason, /Only the scorer/);
});

/* 0.6.7 (Willy, 20 Oct 2026): delete a posted card's rounds from The Scorecard. */
test("D1 deleting a card's rounds: rounds gone, windows rebuilt from the remaining rounds, one commit; the card becomes editable", async () => {
  const { fs, rounds } = await posted();
  /* Ana also has an older round elsewhere in the group, outside the old window. */
  fs.docs.set("associations/G1/rounds/older", { data: { id: "older", golferId: "A", date: "2025-05-01", differential: 7.5 }, updateTime: "2026-01-01T00:00:00.000Z" });
  const commits = fs.commits.length;
  const r = await fix.deleteRounds(fs, who(SCORER), "c1", { now: postedAt(fs) + 3600_000 });
  assert.equal(r.status, "deleted");
  assert.deepEqual(r.deleted, ["Ana Cruz", "Ben Reyes"]);
  assert.equal(fs.commits.length, commits + 1, "one commit");
  assert.equal(fs.data(`associations/G1/rounds/${rounds.A}`), null);
  assert.equal(fs.data(`associations/G1/rounds/${rounds.B}`), null);
  const a = fs.data("golfers/A");
  assert.ok(!a.recentWindow.some((e) => e.roundId === rounds.A));
  assert.deepEqual(a.recentWindow.map((e) => e.roundId), ["older"], "rebuilt from the rounds really there");
  assert.equal(a.roundCount, 1);
  assert.equal(a.handicapIndex, model.displayIndex(a.recentWindow));
  assert.equal(fs.data("associations/G1/directory/A").handicapIndex, model.effectiveIndex(a).index);
  assert.equal(fs.data("markerSubmissions/c1").roundsDeleted.by, SCORER);
  const m = await fix.myCards(fs, who(SCORER), { now: postedAt(fs) + 3600_000 });
  assert.equal(m.editable.length, 1, "can be re-posted");
  await assert.rejects(fix.deleteRounds(fs, who(SCORER), "c1", { now: postedAt(fs) + 3600_000 }), /already deleted/);
});

test("D2 delete rights: the scorer for 24 hours, an owner or admin at any time, another member never", async () => {
  const { fs } = await posted();
  const late = postedAt(fs) + 25 * 3600_000;
  await assert.rejects(fix.deleteRounds(fs, who(SCORER), "c1", { now: late }), /24 hours/);
  await assert.rejects(fix.deleteRounds(fs, who(OTHER), "c1", { now: postedAt(fs) }), /Only the scorer/);
  assert.equal((await fix.deleteRounds(fs, who(ADMIN), "c1", { now: late })).status, "deleted");
});

test("D3 a round or golfer changed at the same moment: nothing is deleted", async () => {
  const { fs, rounds } = await posted();
  fs.failNext = Object.assign(new Error("FAILED_PRECONDITION"), { conflict: true });
  await assert.rejects(fix.deleteRounds(fs, who(SCORER), "c1", { now: postedAt(fs) }), /a moment ago/);
  assert.ok(fs.data(`associations/G1/rounds/${rounds.A}`));
  assert.ok(fs.data(`associations/G1/rounds/${rounds.B}`));
  assert.equal(fs.data("markerSubmissions/c1").roundsDeleted, undefined);
});

test("D4 a card with deleted rounds can be deleted for good: off the lists, never re-posted, nothing else changes", async () => {
  const { fs, rounds } = await posted();
  const soon = { now: postedAt(fs) + 3600_000 };
  await assert.rejects(fix.discardEditable(fs, who(SCORER), "c1", soon), /still in The Scorecard/);
  fs.docs.delete(`associations/G1/rounds/${rounds.A}`);
  fs.docs.delete(`associations/G1/rounds/${rounds.B}`);
  await assert.rejects(fix.discardEditable(fs, who(OTHER), "c1", soon), /Only the scorer/);
  await assert.rejects(fix.discardEditable(fs, who(SCORER), "c1", { now: postedAt(fs) + 25 * 3600_000 }), /24 hours/);
  const golferA = JSON.stringify(fs.data("golfers/A"));
  assert.equal((await fix.discardEditable(fs, who(SCORER), "c1", soon)).status, "deleted");
  assert.equal((await fix.myCards(fs, who(ADMIN))).editable.length, 0, "on nobody's list");
  assert.equal(JSON.stringify(fs.data("golfers/A")), golferA);
  const old = fs.data("markerSubmissions/c1").card;
  repostSub(fs, "c9", [old.players[1]]);
  const r = await processSubmission(fs, "c9", { today: TODAY });
  assert.equal(r.status, "refused");
  assert.match(r.reason, /was deleted/);
});

test("C20 Your cards for the app owner with 40 posted cards of four golfers: a handful of database calls, far under Cloudflare's 50 (5 Nov 2026)", async () => {
  const { fs } = await posted();
  fs.docs.set("appOwners/u-boss", { data: { active: true }, updateTime: "t" });
  const base = fs.data("markerSubmissions/c1");
  for (let k = 0; k < 40; k++) {
    const rounds = {}, players = [];
    for (const g of ["A", "B", "C", "D"]) {
      const rid = `r${k}${g}`;
      rounds[g] = rid;
      players.push({ golferId: g, assocId: "G1", name: g, scores: scoresOf(5) });
      if (!(k === 3 && g === "D")) fs.docs.set(`associations/G1/rounds/${rid}`, { data: { golferId: g }, updateTime: "t" });
    }
    fs.docs.set(`markerSubmissions/k${k}`, { data: { ...base, card: { ...base.card, id: `k${k}`, players }, rounds }, updateTime: "t" });
  }
  fs.calls = 0;
  const m = await fix.myCards(fs, who("u-boss"), { limit: 100 });
  assert.ok(fs.calls <= 10, `calls: ${fs.calls}`);
  assert.equal(m.correctable.length, 40);   /* c1 and 39 of the 40; k3 has a deleted round */
  assert.equal(m.editable.length, 1);
  assert.deepEqual(m.editable[0].gone, ["D"]);
});

/* Willy, 13 Nov 2026: a golfer who joined late (holes 1 and 2 not played,
   counted at net par when posted). Found by the guide-picture run. */
async function postedLate() {
  const fs = world();
  const sub = fs.data("markerSubmissions/c1");
  const B = sub.card.players[1];
  const scores = { ...B.scores }; delete scores["1"]; delete scores["2"];
  sub.card.players[1] = { ...B, scores, missed: [1, 2] };
  fs.docs.set("markerSubmissions/c1", { data: sub, updateTime: "2026-10-16T11:00:00.000Z" });
  const r = await processSubmission(fs, "c1", { today: TODAY });
  assert.equal(r.status, "posted");
  return { fs, rounds: r.rounds };
}

test("L1 a card with a late golfer can be corrected; the missed holes stay at net par whatever the phone sends", async () => {
  const { fs, rounds } = await postedLate();
  const before = fs.data(`associations/G1/rounds/${rounds.B}`);
  const netPar = before.holes[0];
  assert.ok(Number.isInteger(netPar), "posted at net par");
  /* The Marker 1.1.0 sends nothing for the missed holes; a phone could also send a number. */
  const sent = { A: fixHole1(4).A, B: { ...scoresOf(6) } }; delete sent.B["1"]; sent.B["2"] = 3; sent.B["5"] = 5;
  const r = await fix.correct(fs, who(SCORER), { cardId: "c1", scores: sent }, { now: postedAt(fs) + 3600_000 });
  assert.equal(r.status, "corrected");
  assert.deepEqual(r.changed.sort(), ["Ana Cruz", "Ben Reyes"]);
  const after = fs.data(`associations/G1/rounds/${rounds.B}`);
  assert.equal(after.holes[0], netPar, "hole 1 still net par");
  assert.equal(after.holes[1], before.holes[1], "hole 2 still net par, the phone's 3 ignored");
  assert.equal(after.holes[4], 5, "a played hole is corrected");
  assert.equal(after.gross, before.gross - 1);
  const kept = fs.data("markerSubmissions/c1").card.players[1];
  assert.deepEqual(kept.missed, [1, 2], "still marked as missed");
  assert.equal(kept.scores["1"], undefined);
  /* and the corrected card can be opened and corrected again */
  const again = await fix.cardForCorrection(fs, who(SCORER), "c1", { now: postedAt(fs) + 3700_000 });
  assert.equal(again.card.players[1].scores["5"], 5);
});

test("L2 nothing changed on a late golfer's card: unchanged, not refused", async () => {
  const { fs } = await postedLate();
  const sent = { A: scoresOf(5), B: scoresOf(6) }; delete sent.B["1"]; delete sent.B["2"];
  const r = await fix.correct(fs, who(SCORER), { cardId: "c1", scores: sent }, { now: postedAt(fs) + 3600_000 });
  assert.equal(r.status, "unchanged");
});

test("L3 a late golfer's card re-posted by The Marker 1.1.0 (missed holes empty, not marked): posted, at net par", async () => {
  const { fs, rounds } = await postedLate();
  const netPar = fs.data(`associations/G1/rounds/${rounds.B}`).holes[0];
  fs.docs.delete(`associations/G1/rounds/${rounds.B}`);
  const B = fs.data("markerSubmissions/c1").card.players[1];
  const { missed, ...plain } = B;   /* 1.1.0 forgets which holes were missed */
  repostSub(fs, "c2", [plain]);
  const r = await processSubmission(fs, "c2", { today: TODAY });
  assert.equal(r.status, "posted", r.reason);
  const round = fs.data(`associations/G1/rounds/${r.rounds.B}`);
  assert.equal(round.holes[0], netPar);
  assert.match(round.notes, /Joined late: holes 1, 2 not played/);
});

test("L4 a re-post with other empty holes is still refused (only exactly the missed holes are taken)", async () => {
  const { fs, rounds } = await postedLate();
  fs.docs.delete(`associations/G1/rounds/${rounds.B}`);
  const { missed, ...plain } = fs.data("markerSubmissions/c1").card.players[1];
  const scores = { ...plain.scores }; delete scores["7"];
  repostSub(fs, "c2", [{ ...plain, scores }]);
  const r = await processSubmission(fs, "c2", { today: TODAY });
  assert.equal(r.status, "refused");
  assert.match(r.reason, /no score on hole 1/);
});
