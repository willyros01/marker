/* Item 21 (Willy, 23 Oct 2026): the app owner's override, "like SAP_ALL".
 * An account listed (active) in appOwners/{uid} may correct, hide, delete
 * and re-post any Marker card at any time, even for groups it does not
 * belong to; every use is recorded as "appOwner". Nobody else gains anything. */
import test from "node:test";
import assert from "node:assert/strict";
import { fakeFs } from "./fakefs.mjs";
import { processSubmission } from "../../worker/src/post.js";
import * as fix from "../../worker/src/correct.js";

const SCORER = "u-member", BOSS = "u-boss", OTHER_OWNER = "u-owner2";
const TODAY = "2026-10-16";
const holes = Array.from({ length: 18 }, (_, i) => ({ par: 4, yards: 380, si: i + 1 }));
const libTee = { name: "White (M)", rating: 70.1, slope: 125, par: 72, holes };
const scoresOf = (v) => Object.fromEntries(Array.from({ length: 18 }, (_, i) => [String(i + 1), v]));

async function posted(extra = {}) {
  const fs = fakeFs({
    "associations/G1": { name: "Somebody's group", ownerUid: "u-owner" },
    "associations/G9": { name: "Another group", ownerUid: OTHER_OWNER },
    [`associations/G1/members/${SCORER}`]: { uid: SCORER, role: "member" },
    [`associations/G9/members/${OTHER_OWNER}`]: { uid: OTHER_OWNER, role: "owner" },
    "golfers/A": { name: "Ana Cruz", groups: ["G1"], recentWindow: [], roundCount: 0, manualIndex: 10 },
    "associations/G1/roster/A": { golferId: "A" },
    "associations/G1/directory/A": { golferId: "A", displayName: "Ana Cruz", handicapIndex: 10 },
    "markerCourses/123": { providerId: "123", name: "Royal Ontario", where: "Milton, ON", tees: [libTee] },
    ...extra,
  });
  const card = {
    id: "c1", date: TODAY, holes: "18", start: 1, order: Array.from({ length: 18 }, (_, i) => i + 1),
    course: { providerId: "123", name: "Royal Ontario", where: "Milton, ON" }, tee: { ...libTee }, game: null,
    players: [{ golferId: "A", assocId: "G1", name: "Ana Cruz", scores: scoresOf(5) }],
  };
  fs.docs.set("markerSubmissions/c1", { data: { scorer: SCORER, status: "sent", createdAt: "t", app: "0.6.5", card }, updateTime: "2026-10-16T11:00:00.000Z" });
  const r = await processSubmission(fs, "c1", { today: TODAY });
  assert.equal(r.status, "posted");
  return { fs, rounds: r.rounds, late: Date.parse(fs.data("markerSubmissions/c1").postedAt) + 30 * 86400_000 };
}
const who = (uid) => ({ uid, anonymous: false });
const fixed = { A: { ...scoresOf(5), 1: 4 } };

test("O1 the app owner corrects a card of a group he did not create, a month later; recorded as appOwner", async () => {
  const { fs, rounds, late } = await posted({ [`appOwners/${BOSS}`]: { active: true } });
  const r = await fix.correct(fs, who(BOSS), { cardId: "c1", scores: fixed }, { now: late });
  assert.equal(r.status, "corrected");
  const round = fs.data(`associations/G1/rounds/${rounds.A}`);
  assert.equal(round.holes[0], 4);
  assert.equal(round.corrections.at(-1).as, "appOwner");
  assert.equal(round.corrections.at(-1).by, BOSS);
  const list = await fix.myCards(fs, who(BOSS), { now: late });
  assert.equal(list.correctable.length, 1);
  assert.equal(list.correctable[0].as, "appOwner");
});

test("O2 without an active appOwners record, nothing extra is allowed", async () => {
  for (const extra of [{}, { [`appOwners/${BOSS}`]: { active: false } }, { [`appOwners/${BOSS}`]: { active: "yes" } }]) {
    const { fs, late } = await posted(extra);
    await assert.rejects(fix.correct(fs, who(BOSS), { cardId: "c1", scores: fixed }, { now: late }));
    assert.equal((await fix.myCards(fs, who(BOSS), { now: late })).correctable.length, 0);
  }
});

test("O3 the owner of another group still cannot touch this card", async () => {
  const { fs, late } = await posted({ [`appOwners/${BOSS}`]: { active: true } });
  await assert.rejects(fix.correct(fs, who(OTHER_OWNER), { cardId: "c1", scores: fixed }, { now: late }));
  await assert.rejects(fix.deleteRounds(fs, who(OTHER_OWNER), "c1", { now: late }));
});

test("O4 the app owner may also delete the card's rounds; the record says appOwner", async () => {
  const { fs, rounds, late } = await posted({ [`appOwners/${BOSS}`]: { active: true } });
  await fix.deleteRounds(fs, who(BOSS), "c1", { now: late });
  assert.equal(fs.data(`associations/G1/rounds/${rounds.A}`), null);
  assert.equal(fs.data("markerSubmissions/c1").roundsDeleted.as, "appOwner");
});

test("O5 a group admin is still recorded as admin, not appOwner", async () => {
  const { fs, rounds, late } = await posted({ [`appOwners/u-owner`]: { active: true } });
  await fix.correct(fs, who("u-owner"), { cardId: "c1", scores: fixed }, { now: late });
  assert.equal(fs.data(`associations/G1/rounds/${rounds.A}`).corrections.at(-1).as, "admin");
});
