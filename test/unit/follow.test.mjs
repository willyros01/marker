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
  assert.match(r.code, /^[1-9]\d{5}$/);   /* six digits (1.1.0) */
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

test("F5 after 12 hours the follow code stops; about 10 wrong codes in an hour make the device wait", async () => {
  const fs = fakeFs();
  const r = await follow.start(fs, MEMBER, { card: theCard() }, { now: NOW, rand });
  await assert.rejects(follow.view(fs, GUEST, r.code, { now: NOW + 12 * 3600_000 + 1 }), refused(/stopped working/));
  await assert.rejects(follow.scores(fs, MEMBER, { liveId: r.liveId, scores: {} }, { now: NOW + 12 * 3600_000 + 1 }), refused(/^EXPIRED$/));
  for (let i = 0; i < 10; i++) await assert.rejects(follow.view(fs, GUEST, "999999", { now: NOW }), refused(/doesn't work/));
  await assert.rejects(follow.view(fs, GUEST, r.code, { now: NOW }), refused(/Too many wrong codes in the last hour/));
  /* an hour later the device may try again */
  const fresh = await follow.start(fs, MEMBER, { card: theCard() }, { now: NOW + 3600_000, rand });
  assert.equal((await follow.view(fs, GUEST, fresh.code, { now: NOW + 3600_000 + 1000 })).status, "live");
});

test("F6 a caddie code is not a follow code, and a follow code is not a caddie code", async () => {
  const fs = fakeFs();
  const k = await caddie.start(fs, MEMBER, theCard(), { now: NOW, rand });
  const f = await follow.start(fs, MEMBER, { card: theCard() }, { now: NOW, rand });
  await assert.rejects(follow.view(fs, GUEST, k.code, { now: NOW }), refused(/doesn't work/));
  await assert.rejects(caddie.join(fs, CADDIE, f.code, { now: NOW }), refused(/doesn't work/));
});

test("F7 posting ends following: followers see the card as posted (Willy, 30 Oct 2026)", async () => {
  const fs = fakeFs();
  const r = await follow.start(fs, MEMBER, { card: theCard() }, { now: NOW, rand });
  let v = await follow.view(fs, FRIEND, r.code, { now: NOW + 1000 });
  assert.equal(v.posted, false);
  await follow.scores(fs, MEMBER, { liveId: r.liveId, scores: { 0: { 1: 5 }, 1: { 1: 6 } }, done: true, posted: true }, { now: NOW + 60_000 });
  v = await follow.view(fs, FRIEND, r.code, { now: NOW + 61_000 });
  assert.equal(v.posted, true);
  assert.equal(v.status, "finished");
  /* a caddie's card the caddie handed back (finished): posting afterwards still marks it posted */
  const fs2 = fakeFs();
  const k = await caddie.start(fs2, MEMBER, theCard(), { now: NOW, rand });
  await caddie.join(fs2, CADDIE, k.code, { now: NOW + 1000 });
  const f = await follow.start(fs2, MEMBER, { liveId: k.liveId }, { now: NOW + 2000, rand });
  await caddie.scores(fs2, CADDIE, { liveId: k.liveId, scores: { 0: { 1: 4 } }, done: true }, { now: NOW + 3000 });
  assert.equal((await follow.view(fs2, FRIEND, f.code, { now: NOW + 4000 })).posted, false);
  await follow.scores(fs2, MEMBER, { liveId: k.liveId, scores: { 0: { 1: 4 } }, done: true, posted: true }, { now: NOW + 5000 });
  assert.equal((await follow.view(fs2, FRIEND, f.code, { now: NOW + 6000 })).posted, true);
});

/* ---------------- following a whole game (option B, Willy 31 Oct 2026) ---------------- */

const OTHER = { uid: "u-other", anonymous: false };
const gameSeed = () => ({
  "associations/G1": { name: "Golfing Buddies" },
  "associations/G1/members/u-member": { role: "member" },
  "associations/G1/members/u-other": { role: "member" },
  "associations/G1/games/gm1": { name: "Thursday Skins", date: "2026-10-29" },
  "associations/G1/games/gold": { name: "Last week", date: "2026-10-22" },
});
const inGame = (id = "c1", gameId = "gm1") => ({ ...theCard(), id, game: { id: gameId, assocId: "G1" } });
const secondCard = () => ({ ...inGame("c2"), players: [{ name: "Hermie Ticsay", ch: 18, scores: {} }, { name: "Ruben Castillo", ch: 9, scores: {} }] });

test("G1 one code per game: every scorer who asks gets the same six digits, and both cards are on it", async () => {
  const fs = fakeFs(gameSeed());
  const a = await follow.gameStart(fs, MEMBER, { card: inGame() }, { now: NOW, rand });
  const b = await follow.gameStart(fs, OTHER, { card: secondCard() }, { now: NOW + 5000, rand });
  assert.match(a.gameCode, /^[1-9]\d{5}$/);
  assert.equal(b.gameCode, a.gameCode);
  assert.equal(a.gameName, "Thursday Skins");
  assert.notEqual(a.code, a.gameCode);   /* each card keeps its own code too */
  const v = await follow.view(fs, GUEST, a.gameCode, { now: NOW + 6000 });
  assert.equal(v.kind, "game");
  assert.equal(v.game.name, "Thursday Skins");
  assert.equal(v.cards.length, 2);
  assert.deepEqual(v.cards.map((c) => c.setup.players.map((p) => p.name)), [["Willy Rosales", "Raul Rosales"], ["Hermie Ticsay", "Ruben Castillo"]]);
  assert.ok(!JSON.stringify(v).includes("u-member") && !JSON.stringify(v).includes("gW"));   /* no ids */
});

test("G2 a game card made live on its own (tee-off) is on the leaderboard; scores arrive live; finished when every card is", async () => {
  const fs = fakeFs(gameSeed());
  const a = await follow.start(fs, MEMBER, { card: inGame() }, { now: NOW, rand });          /* automatic, at tee-off */
  const g = await follow.gameStart(fs, OTHER, { card: secondCard() }, { now: NOW + 1000, rand });
  await follow.scores(fs, MEMBER, { liveId: a.liveId, scores: { 0: { 1: 5, 2: 4 }, 1: { 1: 6 } } }, { now: NOW + 60_000 });
  let v = await follow.view(fs, FRIEND, g.gameCode, { now: NOW + 61_000 });
  assert.equal(v.cards.length, 2);
  assert.deepEqual(v.cards[0].scores, { 0: { 1: 5, 2: 4 }, 1: { 1: 6 } });
  assert.equal(v.lastAt, NOW + 60_000);
  assert.equal(v.finished, false);
  await follow.scores(fs, MEMBER, { liveId: a.liveId, scores: { 0: { 1: 5 } }, done: true, posted: true }, { now: NOW + 70_000 });
  await follow.scores(fs, OTHER, { liveId: g.liveId, scores: { 0: { 1: 5 } }, done: true }, { now: NOW + 80_000 });
  v = await follow.view(fs, FRIEND, g.gameCode, { now: NOW + 81_000 });
  assert.equal(v.finished, true);
  assert.equal(v.cards[0].posted, true);
});

test("G3 a caddie's card in a game is on the leaderboard with the caddie's scores", async () => {
  const fs = fakeFs(gameSeed());
  const k = await caddie.start(fs, MEMBER, inGame(), { now: NOW, rand });
  await caddie.join(fs, CADDIE, k.code, { now: NOW + 1000 });
  await caddie.scores(fs, CADDIE, { liveId: k.liveId, scores: { 0: { 1: 3 } } }, { now: NOW + 2000 });
  const g = await follow.gameStart(fs, OTHER, { card: secondCard() }, { now: NOW + 3000, rand });
  const v = await follow.view(fs, GUEST, g.gameCode, { now: NOW + 4000 });
  assert.equal(v.cards.length, 2);
  assert.equal(v.cards[0].byCaddie, true);
  assert.equal(v.cards[0].scores["0"]["1"], 3);
});

test("G4 not part of a game: no game code, and nothing tagged; a game of another day or group does not count", async () => {
  const fs = fakeFs(gameSeed());
  await assert.rejects(follow.gameStart(fs, MEMBER, { card: theCard() }, { now: NOW, rand }), refused(/not part of a game/));
  await assert.rejects(follow.gameStart(fs, MEMBER, { card: inGame("c3", "gold") }, { now: NOW, rand }), refused(/not part of a game/));
  await assert.rejects(follow.gameStart(fs, FRIEND, { card: inGame() }, { now: NOW, rand }), refused(/not part of a game|not a member/));
  await assert.rejects(follow.gameStart(fs, GUEST, { card: inGame() }, { now: NOW, rand }), refused(/Sign in/));
  const r = await follow.start(fs, FRIEND, { card: inGame() }, { now: NOW, rand });   /* not a member of G1: followed alone, untagged */
  assert.equal(fs.docs.get(`markerLive/${r.liveId}`).data.gameKey, undefined);
});

test("G5 the game code stops after 12 hours; the next day's play gets a new code", async () => {
  const fs = fakeFs(gameSeed());
  const a = await follow.gameStart(fs, MEMBER, { card: inGame() }, { now: NOW, rand });
  await assert.rejects(follow.view(fs, GUEST, a.gameCode, { now: NOW + 12 * 3600_000 + 1 }), refused(/stopped working/));
  const later = await follow.gameStart(fs, OTHER, { card: secondCard() }, { now: NOW + 12 * 3600_000 + 5, rand });
  assert.notEqual(later.gameCode, a.gameCode);
  assert.equal((await follow.view(fs, GUEST, later.gameCode, { now: NOW + 12 * 3600_000 + 10 })).kind, "game");
});

test("G6 a card made live before it was tagged gets its game when the scorer asks for the game code", async () => {
  const fs = fakeFs(gameSeed());
  const k = await caddie.start(fs, MEMBER, { ...inGame(), game: null }, { now: NOW, rand });   /* older phone: no game sent */
  const f = await follow.start(fs, MEMBER, { liveId: k.liveId }, { now: NOW + 1000, rand });
  assert.equal(fs.docs.get(`markerLive/${k.liveId}`).data.gameKey, undefined);
  const g = await follow.gameStart(fs, MEMBER, { card: inGame(), liveId: k.liveId }, { now: NOW + 2000, rand });
  assert.equal(g.code, f.code);
  assert.equal(fs.docs.get(`markerLive/${k.liveId}`).data.gameKey, "G1_gm1_2026-10-29");
  assert.equal((await follow.view(fs, GUEST, g.gameCode, { now: NOW + 3000 })).cards.length, 1);
});
