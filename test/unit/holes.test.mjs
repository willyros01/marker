/* Item 22 (Willy, 25 Oct 2026): every Marker round keeps each hole's par and
 * stroke index as played, so The Scorecard can show the card read-only in
 * History even after the course is corrected later. */
import test from "node:test";
import assert from "node:assert/strict";
import { fakeFs } from "./fakefs.mjs";
import { processSubmission } from "../../worker/src/post.js";
import { fillHoles } from "../../worker/src/fillholes.js";
import * as fix from "../../worker/src/correct.js";
import * as card from "../../card.js";

const SCORER = "u-member";
const TODAY = "2026-10-16";
const PARS = [4, 5, 3, 4, 4, 5, 3, 4, 4, 4, 3, 5, 4, 4, 3, 4, 5, 4];      /* 72 */
const SI = [7, 1, 17, 3, 11, 5, 15, 9, 13, 8, 18, 2, 10, 4, 16, 12, 6, 14];
const holes = PARS.map((par, i) => ({ par, yards: 300 + i, si: SI[i] }));
const libTee = { name: "White (M)", rating: 70.1, slope: 125, par: 72, holes };
const scoresOf = (v) => Object.fromEntries(Array.from({ length: 18 }, (_, i) => [String(i + 1), v]));

function world() {
  const fs = fakeFs({
    "associations/G1": { name: "Golf Buddies", ownerUid: "u-owner" },
    [`associations/G1/members/${SCORER}`]: { uid: SCORER, role: "member" },
    "golfers/A": { name: "Ana Cruz", groups: ["G1"], recentWindow: [], roundCount: 0, manualIndex: 10 },
    "golfers/B": { name: "Ben Reyes", groups: ["G1"], recentWindow: [], roundCount: 0, manualIndex: 18 },
    "associations/G1/roster/A": { golferId: "A" }, "associations/G1/roster/B": { golferId: "B" },
    "markerCourses/123": { providerId: "123", name: "Royal Ontario", where: "Milton, ON", tees: [libTee] },
  });
  const c = {
    id: "c1", date: TODAY, holes: "18", start: 10, order: [...Array.from({ length: 9 }, (_, i) => i + 10), ...Array.from({ length: 9 }, (_, i) => i + 1)],
    course: { providerId: "123", name: "Royal Ontario", where: "Milton, ON" }, tee: { ...libTee }, game: null,
    players: [{ golferId: "A", assocId: "G1", name: "Ana Cruz", scores: { ...scoresOf(5), 3: "X" } }, { golferId: "B", assocId: "G1", name: "Ben Reyes", scores: scoresOf(6) }],
  };
  fs.docs.set("markerSubmissions/c1", { data: { scorer: SCORER, status: "sent", createdAt: "t", app: "0.5.9", card: c }, updateTime: "2026-10-16T11:00:00.000Z" });
  return fs;
}
const post = async () => { const fs = world(); const r = await processSubmission(fs, "c1", { today: TODAY }); assert.equal(r.status, "posted"); return { fs, rounds: r.rounds }; };

test("H1 a posted round keeps each hole's par and stroke index, hole 1 to 18, even when the round starts on 10", async () => {
  const { fs, rounds } = await post();
  for (const g of ["A", "B"]) {
    const r = fs.data(`associations/G1/rounds/${rounds[g]}`);
    assert.deepEqual(r.holePar, PARS);
    assert.deepEqual(r.holeSi, SI);
    assert.equal(r.holes.length, 18);
  }
  assert.equal(fs.data(`associations/G1/rounds/${rounds.A}`).holes[2], "X");
});

test("H2 a later change to the course list does not change what the round shows", async () => {
  const { fs, rounds } = await post();
  const lib = fs.data("markerCourses/123");
  lib.tees[0].holes = lib.tees[0].holes.map((h) => ({ ...h, par: 4, si: 1 }));
  fs.docs.set("markerCourses/123", { data: lib, updateTime: new Date().toISOString() });
  assert.deepEqual(fs.data(`associations/G1/rounds/${rounds.A}`).holePar, PARS);
});

test("H3 a correction keeps the pars and stroke indexes as played", async () => {
  const { fs, rounds } = await post();
  const now = Date.parse(fs.data("markerSubmissions/c1").postedAt) + 3600_000;
  const r = await fix.correct(fs, { uid: SCORER, anonymous: false }, { cardId: "c1", scores: { A: { ...scoresOf(5), 3: "X", 1: 4 }, B: scoresOf(6) } }, { now });
  assert.equal(r.status, "corrected");
  const after = fs.data(`associations/G1/rounds/${rounds.A}`);
  assert.equal(after.holes[0], 4);
  assert.deepEqual(after.holePar, PARS);
  assert.deepEqual(after.holeSi, SI);
});

test("H4 a tee without 18 holes gives no pars at all (never par 4 made up)", () => {
  assert.equal(card.frozenHoles({ holes: [] }), null);
  assert.equal(card.frozenHoles({ holes: holes.slice(0, 9) }), null);
  assert.deepEqual(card.frozenHoles({ holes: holes.map((h) => ({ par: h.par })) }).holeSi, Array(18).fill(null));
});

/* An old round: posted before 25 Oct, so without the two fields. */
async function oldRound() {
  const { fs, rounds } = await post();
  for (const g of ["A", "B"]) {
    const p = `associations/G1/rounds/${rounds[g]}`;
    const d = fs.data(p); delete d.holePar; delete d.holeSi;
    fs.docs.set(p, { data: d, updateTime: "2026-10-16T13:00:00.000Z" });
  }
  /* The course list changed since; the fill-in must use the card's frozen tee. */
  const lib = fs.data("markerCourses/123");
  lib.tees[0].holes = lib.tees[0].holes.map((h) => ({ ...h, par: 4 }));
  fs.docs.set("markerCourses/123", { data: lib, updateTime: "2026-10-16T13:00:00.000Z" });
  return { fs, rounds };
}

test("H5 the fill-in: dry writes nothing; go adds the two fields from the card's frozen tee, and nothing else", async () => {
  const { fs, rounds } = await oldRound();
  const before = fs.data(`associations/G1/rounds/${rounds.A}`);
  const commits = fs.commits.length;
  const dry = await fillHoles(fs, { go: false });
  assert.equal(dry.filled, 2);
  assert.equal(fs.commits.length, commits);
  const go = await fillHoles(fs, { go: true });
  assert.equal(go.filled, 2);
  assert.equal(fs.commits.length, commits + 2);           /* one commit per round */
  const after = fs.data(`associations/G1/rounds/${rounds.A}`);
  assert.deepEqual(after.holePar, PARS);
  assert.deepEqual(after.holeSi, SI);
  const { holePar, holeSi, ...rest } = after;
  assert.deepEqual(rest, before);
  const again = await fillHoles(fs, { go: true });
  assert.equal(again.filled, 0);
  assert.equal(again.already, 2);
});

test("H6 the fill-in skips a deleted round and a card without a frozen tee, and reports them", async () => {
  const { fs, rounds } = await oldRound();
  fs.docs.delete(`associations/G1/rounds/${rounds.B}`);
  let r = await fillHoles(fs, { go: true });
  assert.equal(r.gone, 1);
  assert.equal(r.filled, 1);
  const { fs: fs2 } = await oldRound();
  const sub = fs2.data("markerSubmissions/c1"); delete sub.postedTee;
  fs2.docs.set("markerSubmissions/c1", { data: sub, updateTime: "2026-10-16T14:00:00.000Z" });
  r = await fillHoles(fs2, { go: true });
  assert.equal(r.noTee, 2);
  assert.equal(r.filled, 0);
});
