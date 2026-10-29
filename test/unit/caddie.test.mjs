/* Caddie scoring (worker/src/caddie.js), against the in-memory Firestore.
 * Willy, 29 Oct 2026: the member asks for a code; a caddie with no account
 * joins with it and enters scores; the member sees them and posts. The code
 * stops when the member takes over, the card is finished, or after 12 hours.
 * One caddie per card. The caddie never sees golfer or group ids. */
import test from "node:test";
import assert from "node:assert/strict";
import { fakeFs } from "./fakefs.mjs";
import * as caddie from "../../worker/src/caddie.js";
import { Refusal } from "../../worker/src/post.js";

const MEMBER = { uid: "u-member", anonymous: false };
const CADDIE = { uid: "u-caddie", anonymous: true };
const OTHER = { uid: "u-other", anonymous: true };
const NOW = Date.UTC(2026, 9, 29, 14, 0, 0);
const holes = Array.from({ length: 18 }, (_, i) => ({ par: 4, yards: 380, si: i + 1 }));
const theCard = () => ({
  id: "c1", date: "2026-10-29", holes: "18", start: 1, order: Array.from({ length: 18 }, (_, i) => i + 1),
  course: { providerId: "123", name: "Royal Ontario" }, tee: { name: "White (M)", rating: 70.1, slope: 125, par: 72, holes },
  players: [
    { name: "Willy Rosales", golferId: "gW", assocId: "G1", index: 24.3, ch: 27, scores: { 1: 5 } },
    { name: "Raul Rosales", golferId: "gR", assocId: "G1", index: 12, ch: 13, scores: {} },
  ],
});
const refused = (re) => (e) => e instanceof Refusal && re.test(e.message);
let n = 0;
const rand = () => ((n++ * 7) % 32) / 32;

test("K1 a member gets a code; the shared card holds only what a caddie needs", async () => {
  const fs = fakeFs();
  const r = await caddie.start(fs, MEMBER, theCard(), { now: NOW, rand });
  assert.match(r.code, /^[A-Z2-9]{6}$/);
  assert.equal(r.expiresAt, NOW + 12 * 3600_000);
  const live = fs.data(`markerLive/${r.liveId}`);
  assert.equal(live.owner, MEMBER.uid);
  assert.equal(live.status, "open");
  assert.deepEqual(live.setup.players, [{ name: "Willy Rosales", ch: 27 }, { name: "Raul Rosales", ch: 13 }]);
  assert.ok(!JSON.stringify(live.setup).includes("gW") && !JSON.stringify(live.setup).includes("G1"));
  assert.equal(live.scores["0"]["1"], 5);
  assert.equal(fs.data(`markerCaddieCodes/${r.code}`).liveId, r.liveId);
});

test("K2 only a signed-in member can ask for a code", async () => {
  await assert.rejects(caddie.start(fakeFs(), CADDIE, theCard(), { now: NOW }), refused(/Sign in/));
});

test("K3 the caddie joins with the code (typed loosely), and scores reach the member", async () => {
  const fs = fakeFs();
  const r = await caddie.start(fs, MEMBER, theCard(), { now: NOW, rand });
  const loose = r.code.slice(0, 3).toLowerCase() + " " + r.code.slice(3);
  const j = await caddie.join(fs, CADDIE, loose, { now: NOW + 60_000 });
  assert.equal(j.liveId, r.liveId);
  assert.equal(j.setup.course.name, "Royal Ontario");
  await caddie.scores(fs, CADDIE, { liveId: r.liveId, scores: { 0: { 1: 5, 2: 6 }, 1: { 1: 4, 2: "X", 3: 99 } } }, { now: NOW + 120_000 });
  const st = await caddie.status(fs, MEMBER, r.liveId, { now: NOW + 130_000 });
  assert.equal(st.joined, true);
  assert.deepEqual(st.scores, { 0: { 1: 5, 2: 6 }, 1: { 1: 4, 2: "X" } });   /* 99 is not a score */
});

test("K4 one caddie per card; the same phone may join again", async () => {
  const fs = fakeFs();
  const r = await caddie.start(fs, MEMBER, theCard(), { now: NOW, rand });
  await caddie.join(fs, CADDIE, r.code, { now: NOW });
  await caddie.join(fs, CADDIE, r.code, { now: NOW + 1000 });
  await assert.rejects(caddie.join(fs, OTHER, r.code, { now: NOW + 2000 }), refused(/Another phone/));
  await assert.rejects(caddie.scores(fs, OTHER, { liveId: r.liveId, scores: {} }, { now: NOW }), refused(/not yours/));
});

test("K5 the member takes over: the code and the caddie's sends stop at once", async () => {
  const fs = fakeFs();
  const r = await caddie.start(fs, MEMBER, theCard(), { now: NOW, rand });
  await caddie.join(fs, CADDIE, r.code, { now: NOW });
  const s = await caddie.stop(fs, MEMBER, r.liveId, { now: NOW + 5000 });
  assert.equal(s.status, "taken");
  await assert.rejects(caddie.scores(fs, CADDIE, { liveId: r.liveId, scores: { 0: { 1: 4 } } }, { now: NOW + 6000 }), refused(/^TAKEN_BACK$/));
  await assert.rejects(caddie.join(fs, OTHER, r.code, { now: NOW + 7000 }), refused(/stopped working/));
});

test("K6 after 12 hours the code and the sends stop", async () => {
  const fs = fakeFs();
  const r = await caddie.start(fs, MEMBER, theCard(), { now: NOW, rand });
  await caddie.join(fs, CADDIE, r.code, { now: NOW });
  const late = NOW + 12 * 3600_000 + 1;
  await assert.rejects(caddie.join(fs, CADDIE, r.code, { now: late }), refused(/stopped working/));
  await assert.rejects(caddie.scores(fs, CADDIE, { liveId: r.liveId, scores: {} }, { now: late }), refused(/^EXPIRED$/));
  assert.equal((await caddie.status(fs, MEMBER, r.liveId, { now: late })).status, "expired");
});

test("K7 the caddie finishes: the card is handed back and closed", async () => {
  const fs = fakeFs();
  const r = await caddie.start(fs, MEMBER, theCard(), { now: NOW, rand });
  await caddie.join(fs, CADDIE, r.code, { now: NOW });
  const all = { 0: Object.fromEntries(Array.from({ length: 18 }, (_, i) => [i + 1, 5])), 1: Object.fromEntries(Array.from({ length: 18 }, (_, i) => [i + 1, 4])) };
  assert.equal((await caddie.scores(fs, CADDIE, { liveId: r.liveId, scores: all, done: true }, { now: NOW + 9000 })).status, "finished");
  const st = await caddie.status(fs, MEMBER, r.liveId, { now: NOW + 9500 });
  assert.equal(st.status, "finished");
  assert.equal(Object.keys(st.scores["1"]).length, 18);
  await assert.rejects(caddie.scores(fs, CADDIE, { liveId: r.liveId, scores: all }, { now: NOW + 10000 }), refused(/^FINISHED$/));
});

test("K8 a wrong code is refused, and a phone gets 20 tries a day", async () => {
  const fs = fakeFs();
  for (let i = 0; i < 20; i++) await assert.rejects(caddie.join(fs, OTHER, "ZZZZZZ", { now: NOW }), refused(/doesn't work/));
  await assert.rejects(caddie.join(fs, OTHER, "ZZZZZZ", { now: NOW }), refused(/Too many/));
});

test("K9 only the card's member can see or stop it", async () => {
  const fs = fakeFs();
  const r = await caddie.start(fs, MEMBER, theCard(), { now: NOW, rand });
  await assert.rejects(caddie.status(fs, { uid: "u-x", anonymous: false }, r.liveId, { now: NOW }), refused(/not your card/));
  await assert.rejects(caddie.stop(fs, CADDIE, r.liveId, { now: NOW }), refused(/not your card/));
});

test("K10 a code that is already taken is not reused: another is made", async () => {
  const fs = fakeFs();
  const same = () => 0;   /* every first try is AAAAAA */
  const a = await caddie.start(fs, MEMBER, theCard(), { now: NOW, rand: same });
  let k = 0;
  const b = await caddie.start(fs, MEMBER, theCard(), { now: NOW, rand: () => (k++ < 6 ? 0 : 0.5) });
  assert.notEqual(a.code, b.code);
  assert.equal(fs.data(`markerCaddieCodes/${a.code}`).liveId, a.liveId);
});
