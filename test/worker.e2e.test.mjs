/* The whole path against the Firebase emulator, nothing live:
 *   a member's phone (the real Firebase SDK, under the real rules) drops off a
 *   card exactly as store.js builds it; the worker's own code (worker/src) then
 *   posts it through Firestore's REST API: real commits, real preconditions,
 *   real server timestamps. Run by `npm run test:rules` in GitHub Actions. */
import { readFileSync } from "node:fs";
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initializeTestEnvironment, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, serverTimestamp } from "firebase/firestore";
import * as card from "../card.js";
import * as model from "../model.js";
import { submissionCard } from "../store.js";
import { client } from "../worker/src/firestore.js";
import { processSubmission, sweep } from "../worker/src/post.js";

const PROJECT = "demo-marker-e2e";   /* its own data: the rules tests clear theirs in parallel */
const SCORER = "member1";
let env, fs;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: readFileSync("firebase/firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
  /* "owner" is the emulator's stand-in for a service account: rules do not apply. */
  fs = client({ project: PROJECT, token: async () => "owner", base: "http://127.0.0.1:8080/v1" });
});
after(async () => { await env.cleanup(); });

const pars = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 5, 4, 4, 4, 3, 4, 5];
const tee = { name: "White (M)", rating: 68.8, slope: 133, par: 72, holes: pars.map((p, i) => ({ par: p, yards: 350, si: i + 1 })) };

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "associations", "G1"), { name: "Philippine Golfers", ownerUid: "owner1" });
    await setDoc(doc(db, "associations/G1/members", SCORER), { uid: SCORER, role: "member" });
    for (const [g, linked, n] of [["A", SCORER, 6], ["B", null, 0]]) {
      await setDoc(doc(db, "golfers", g), {
        name: g === "A" ? "Ana Cruz" : "Ben Reyes", linkedUid: linked, groups: ["G1"], roundCount: n,
        recentWindow: Array.from({ length: n }, (_, i) => ({ roundId: `o${i}`, date: `2026-09-0${i + 1}`, differential: 12 + i, assocId: "G1" })),
      });
      await setDoc(doc(db, "associations/G1/roster", g), { golferId: g });
      await setDoc(doc(db, "associations/G1/directory", g), { golferId: g, displayName: g, handicapIndex: null, updatedAt: 1 });
    }
    await setDoc(doc(db, "markerCourses", "77"), { providerId: "77", name: "Wack Wack — East", where: "Manila", tees: [tee] });
  });
});

function finishedCard() {
  let c = card.newCard({
    mode: "member", date: "2026-10-16", course: { providerId: "77", name: "Wack Wack — East", where: "Manila" }, tee,
    holes: "18", start: 10, entry: "one",
    players: [
      { name: "Ana Cruz", golferId: "A", assocId: "G1", groupName: "Philippine Golfers", index: 3 },
      { name: "Ben Reyes", golferId: "B", assocId: "G1", groupName: "Philippine Golfers", index: null },
      { name: "Tony (guest)" },
    ],
  });
  for (const n of c.order) for (let p = 0; p < 3; p++) c = card.setScore(c, p, n, n === 5 && p === 1 ? "X" : pars[n - 1] + 1);
  return c;
}

async function dropOff(c) {
  const phone = env.authenticatedContext(SCORER, { email: "member1@example.com", firebase: { sign_in_provider: "password" } }).firestore();
  await assertSucceeds(setDoc(doc(phone, "markerSubmissions", c.id), {
    scorer: SCORER, status: "sent", createdAt: serverTimestamp(), app: "0.2.0", card: submissionCard(c),
  }));
  return phone;
}

test("E1 a card dropped off by a phone is posted by the worker, all of it in one commit", async () => {
  const c = finishedCard();
  const phone = await dropOff(c);
  const r = await processSubmission(fs, c.id, { onlyScorer: SCORER, today: "2026-10-16" });
  assert.equal(r.status, "posted", r.reason);

  const a = await fs.get(`associations/G1/rounds/${r.rounds.A}`);
  assert.equal(a.data.gross, 72 + 18);
  assert.equal(a.data.rating, 68.8);
  assert.equal(a.data.enteredBy, SCORER);
  assert.match(a.data.enteredAt, /^\d{4}-\d\d-\d\dT/, "the server's own time");
  assert.equal(a.data.cardId, c.id);
  const golferA = (await fs.get("golfers/A")).data;
  assert.equal(golferA.roundCount, 7);
  assert.equal(golferA.handicapIndex, model.displayIndex(golferA.recentWindow));
  assert.equal((await fs.get("associations/G1/directory/A")).data.handicapIndex, golferA.handicapIndex);
  const b = await fs.get(`associations/G1/rounds/${r.rounds.B}`);
  assert.equal(b.data.holes[4], "X");
  assert.ok(JSON.stringify(b.data).indexOf("Tony") === -1, "guests are never posted");

  /* The phone sees the answer on its own card, and nothing else. */
  const seen = await getDoc(doc(phone, "markerSubmissions", c.id));
  assert.equal(seen.data().status, "posted");
  assert.deepEqual(Object.keys(seen.data().rounds).sort(), ["A", "B"]);

  /* The Scorecard has the course now; a second card reuses it. */
  const courses = await fs.query("", "courses", [], 10);
  assert.equal(courses.length, 1);
  assert.equal(courses[0].data.name, "Wack Wack — East");
  assert.equal(courses[0].data.id, courses[0].id, "the course keeps its own id inside, as The Scorecard reads it");
});

test("E2 the same card twice: posted once", async () => {
  const c = finishedCard();
  await dropOff(c);
  await processSubmission(fs, c.id, { today: "2026-10-16" });
  const again = await processSubmission(fs, c.id, { today: "2026-10-16" });
  assert.equal(again.status, "posted");
  assert.equal((await fs.query("associations/G1", "rounds", [], 50)).length, 2);
  assert.equal((await fs.get("golfers/A")).data.roundCount, 7);
});

test("E3 a card for somebody taken off the roster is refused with the reason, nothing posted", async () => {
  const c = finishedCard();
  await dropOff(c);
  await env.withSecurityRulesDisabled(async (ctx) => {
    const { deleteDoc } = await import("firebase/firestore");
    await deleteDoc(doc(ctx.firestore(), "associations/G1/roster/B"));
  });
  const r = await processSubmission(fs, c.id, { today: "2026-10-16" });
  assert.equal(r.status, "refused");
  assert.match(r.reason, /Ben Reyes is no longer on the group's roster/);
  assert.equal((await fs.query("associations/G1", "rounds", [], 50)).length, 0);
  assert.equal((await fs.get("golfers/A")).data.roundCount, 6);
});

test("E4 the timer finds a card whose wake-up was lost", async () => {
  const c = finishedCard();
  await dropOff(c);
  const r = await sweep(fs);
  assert.equal(r.posted, 1);
  assert.equal((await fs.get(`markerSubmissions/${c.id}`)).data.status, "posted");
});

test("E5 after a withdrawal: the withdrawn details are refused, a hand entry becomes a new course", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "courses", "K"), { name: "Wack Wack — East", tees: [{ id: "t", name: "White (M)", rating: 68.8, slope: 133, par: 72 }], withdrawn: true, createdBy: "x" });
  });
  const c1 = finishedCard();
  await dropOff(c1);
  assert.equal((await processSubmission(fs, c1.id, { today: "2026-10-16" })).status, "refused");
  let c2 = finishedCard();
  c2 = { ...c2, id: c2.id + "b", course: { providerId: null, name: "Wack Wack — East", where: "" }, tee: { ...tee, rating: 69.4, slope: 128 } };
  await dropOff(c2);
  const r = await processSubmission(fs, c2.id, { today: "2026-10-16" });
  assert.equal(r.status, "posted", r.reason);
  const round = await fs.get(`associations/G1/rounds/${r.rounds.A}`);
  assert.notEqual(round.data.courseId, "K");
  assert.equal((await fs.get("courses/K")).data.tees.length, 1, "the withdrawn course is never changed");
  assert.equal((await fs.get(`markerCourses/m-${round.data.courseId}`)).data.manual, true);
  assert.equal((await fs.get(`courses/${round.data.courseId}`)).data.id, round.data.courseId);
});

test("E6 a verified card replaces the saved course, over Firestore's real interface", async () => {
  const { setWrite } = await import("../worker/src/firestore.js");
  const search = await import("../worker/src/search.js");
  const { reading } = await import("./unit/royal-ontario.mjs");
  await fs.commit([
    setWrite(fs, "markerScans/frontscan1", { uid: SCORER, anonymous: false, result: reading("front") }, { now: ["at"] }),
    setWrite(fs, "markerScans/backscan01", { uid: SCORER, anonymous: false, result: reading("back") }, { now: ["at"] }),
  ]);
  const c = await search.verify(fs, { uid: SCORER, anonymous: false }, { scanIds: ["frontscan1", "backscan01"], replaceId: "77" });
  assert.equal(c.providerId, "77");
  const lib = (await fs.get("markerCourses/77")).data;
  assert.equal(lib.source, "verified");
  assert.equal(lib.tees.length, 5);
  assert.match(lib.verifiedAt, /^\d{4}-/);
  /* A phone still cannot write it. */
  const phone = env.authenticatedContext(SCORER, { email: "member1@example.com", firebase: { sign_in_provider: "password" } }).firestore();
  const { assertFails } = await import("@firebase/rules-unit-testing");
  await assertFails(setDoc(doc(phone, "markerCourses", "77"), { name: "x" }));
  await assertFails(getDoc(doc(phone, "markerScans", "frontscan1")));
});

test("E7 a posted card is corrected over Firestore's real interface: one commit, preconditions honoured", async () => {
  const fix = await import("../worker/src/correct.js");
  const c = finishedCard();
  await dropOff(c);
  const r = await processSubmission(fs, c.id, { today: "2026-10-16" });
  assert.equal(r.status, "posted", r.reason);
  const before = (await fs.get(`associations/G1/rounds/${r.rounds.A}`)).data;
  const sub = (await fs.get(`markerSubmissions/${c.id}`)).data;
  assert.ok(sub.postedTee && sub.postedTee.rating === 68.8, "the tee used is kept for corrections");
  const scores = Object.fromEntries(sub.card.players.map((p) => [p.golferId, { ...p.scores }]));
  const firstHole = String(sub.card.order[0]);
  scores.A[firstHole] = Number(scores.A[firstHole]) - 1;
  const out = await fix.correct(fs, { uid: SCORER, anonymous: false }, { cardId: c.id, scores });
  assert.equal(out.status, "corrected");
  const after = (await fs.get(`associations/G1/rounds/${r.rounds.A}`)).data;
  assert.equal(after.gross, before.gross - 1);
  assert.equal(after.corrections.length, 1);
  assert.equal(after.corrections[0].before.gross, before.gross);
  const golfer = (await fs.get("golfers/A")).data;
  assert.equal(golfer.recentWindow.find((e) => e.roundId === r.rounds.A).differential, after.differential);
  assert.equal(golfer.handicapIndex, model.displayIndex(golfer.recentWindow));
  assert.equal((await fs.get("associations/G1/directory/A")).data.handicapIndex, golfer.handicapIndex);
  assert.match((await fs.get(`markerSubmissions/${c.id}`)).data.correctedAt, /^\d{4}-/);
  /* The round changed in The Scorecard since: refused, nothing written. */
  await env.withSecurityRulesDisabled(async (ctx) => {
    const { updateDoc } = await import("firebase/firestore");
    await updateDoc(doc(ctx.firestore(), `associations/G1/rounds/${r.rounds.A}`), { gross: 99 });
  });
  await assert.rejects(fix.correct(fs, { uid: SCORER, anonymous: false }, { cardId: c.id, scores }), /changed in The Scorecard/);
  /* The phone still cannot read anybody's submissions but its own, nor write a round. */
  const phone = env.authenticatedContext("member2", { email: "m2@example.com", firebase: { sign_in_provider: "password" } }).firestore();
  const { assertFails } = await import("@firebase/rules-unit-testing");
  await assertFails(getDoc(doc(phone, "markerSubmissions", c.id)));
});
