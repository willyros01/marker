/* Following a card live, read-only (worker/src/follow.js). Willy, 29 Oct 2026 (option A). */
import test from "node:test";
import assert from "node:assert/strict";
import { fakeFs } from "./fakefs.mjs";
import * as caddie from "../../worker/src/caddie.js";
import * as follow from "../../worker/src/follow.js";
import { Refusal } from "../../worker/src/post.js";

const MEMBER = { uid: "u-member", anonymous: false };
const FRIEND = { uid: "u-friend", anonymous: false };
const GUEST = { uid: "u-guest", anonymous: true };
const CADDIE = { uid: "u-caddie", anonymous: true };
const NOW = Date.UTC(2026, 9, 29, 14, 0, 0);
const holes = Array.from({ length: 18 }, (_, i) => ({ par: 4, yards: 380, si: i + 1 }));
const theCard = () => ({
  id: "c1", date: "2026-10-29", holes: "18", start: 1, order: Array.from({ length: 18 }, (_, i) => i + 1),
  course: { name: "Royal Ontario" }, tee: { name: "White (M)", par: 72, holes },
  players: [{ name: "Willy Rosales", golferId: "gW", assocId: "G1", ch: 27, scores: { 1: 5 } }, { name: "Raul Rosales", golferId: "gR", assocId: "G1", ch: 13, scores: {} }],
});
const refused = (re) => (e) => e instanceof Refusal && re.test(e.message);
let n = 0; const rand = () => ((n++ * 11) % 32) / 32;

test("F1 a member scoring the card gets a follow code; followers see the card, without ids", async () => {
  const fs = fakeFs();
  const r = await follow.start(fs, MEMBER, { card: theCard() }, { now: NOW, rand });
  assert.match(r.code, /^[A-Z2-9]{6}$/);
  const v = await follow.view(fs, GUEST, r.code.toLowerCase(), { now: NOW + 1000 });
  assert.equal(v.status, "live");
  assert.equal(v.scores["0"]["1"], 5);
  assert.deepEqual(v.setup.players, [{ name: "Willy Rosales", ch: 27 }, { name: "Raul Rosales", ch: 13 }]);
  assert.ok(!JSON.stringify(v).includes("gW"));
});

test("F2 the member's scores reach followers; finishing marks the card finished", async () => {
  const fs = fakeFs();
  const r = await follow.start(fs, MEMBER, { card: theCard() }, { now: NOW, rand });
  await follow.scores(fs, MEMBER, { liveId: r.liveId, scores: { 0: { 1: 5, 2: 4 }, 1: { 1: 6 } } }, { now: NOW + 60_000 });
  let v = await follow.view(fs, FRIEND, r.code, { now: NOW + 61_000 });
  assert.deepEqual(v.scores, { 0: { 1: 5, 2: 4 }, 1: { 1: 6 } });
  assert.equal(v.lastAt, NOW + 60_000);
  await follow.scores(fs, MEMBER, { liveId: r.liveId, scores: { 0: { 1: 5 } }, done: true }, { now: NOW + 120_000 });
  v = await follow.view(fs, FRIEND, r.code, { now: NOW + 121_000 });
  assert.equal(v.status, "finished");
});

test("F3 only the card's member can send scores, and only a signed-in member can ask for a code", async () => {
  const fs = fakeFs();
  const r = await follow.start(fs, MEMBER, { card: theCard() }, { now: NOW, rand });
  await assert.rejects(follow.scores(fs, FRIEND, { liveId: r.liveId, scores: {} }, { now: NOW }), refused(/not your card/));
  await assert.rejects(follow.start(fs, GUEST, { card: theCard() }, { now: NOW }), refused(/Sign in/));
});

test("F4 a card a caddie is scoring: the follow code joins it, followers see the caddie's scores, the member cannot overwrite them", async () => {
  const fs = fakeFs();
  const k = await caddie.start(fs, MEMBER, theCard(), { now: NOW, rand });
  await caddie.join(fs, CADDIE, k.code, { now: NOW });
  const f = await follow.start(fs, MEMBER, { liveId: k.liveId }, { now: NOW + 1000, rand });
  assert.equal(f.liveId, k.liveId);
  const again = await follow.start(fs, MEMBER, { liveId: k.liveId }, { now: NOW + 2000, rand });
  assert.equal(again.code, f.code);   /* asking twice gives the same code */
  await caddie.scores(fs, CADDIE, { liveId: k.liveId, scores: { 0: { 1: 4 }, 1: { 1: 7 } } }, { now: NOW + 3000 });
  const v = await follow.view(fs, GUEST, f.code, { now: NOW + 4000 });
  assert.deepEqual(v.scores, { 0: { 1: 4 }, 1: { 1: 7 } });
  assert.equal(v.byCaddie, true);
  await assert.rejects(follow.scores(fs, MEMBER, { liveId: k.liveId, scores: {} }, { now: NOW + 5000 }), refused(/^CADDIE_SCORING$/));
  /* after taking over, the member's scores reach followers */
  await caddie.stop(fs, MEMBER, k.liveId, { now: NOW + 6000 });
  await follow.scores(fs, MEMBER, { liveId: k.liveId, scores: { 0: { 1: 4, 2: 5 }, 1: { 1: 7 } } }, { now: NOW + 7000 });
  assert.equal((await follow.view(fs, GUEST, f.code, { now: NOW + 8000 })).scores["0"]["2"], 5);
});

test("F5 after 12 hours the follow code stops; wrong codes are counted", async () => {
  const fs = fakeFs();
  const r = await follow.start(fs, MEMBER, { card: theCard() }, { now: NOW, rand });
  await assert.rejects(follow.view(fs, GUEST, r.code, { now: NOW + 12 * 3600_000 + 1 }), refused(/stopped working/));
  await assert.rejects(follow.scores(fs, MEMBER, { liveId: r.liveId, scores: {} }, { now: NOW + 12 * 3600_000 + 1 }), refused(/^EXPIRED$/));
  for (let i = 0; i < 20; i++) await assert.rejects(follow.view(fs, GUEST, "ZZZZZZ", { now: NOW }), refused(/doesn't work/));
  await assert.rejects(follow.view(fs, GUEST, r.code, { now: NOW }), refused(/Too many/));
});

test("F6 a caddie code is not a follow code, and a follow code is not a caddie code", async () => {
  const fs = fakeFs();
  const k = await caddie.start(fs, MEMBER, theCard(), { now: NOW, rand });
  const f = await follow.start(fs, MEMBER, { card: theCard() }, { now: NOW, rand });
  await assert.rejects(follow.view(fs, GUEST, k.code, { now: NOW }), refused(/doesn't work/));
  await assert.rejects(caddie.join(fs, CADDIE, f.code, { now: NOW }), refused(/doesn't work/));
});
