import test from "node:test";
import assert from "node:assert/strict";
import * as card from "../../card.js";

const pars = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 5, 4, 4, 4, 3, 4, 5];
const sis = [7, 3, 15, 1, 11, 5, 17, 13, 9, 8, 14, 2, 6, 12, 4, 18, 16, 10];
const tee = { name: "White", rating: 68.8, slope: 133, par: 72, holes: pars.map((p, i) => ({ par: p, yards: 350, si: sis[i] })) };
const course = { providerId: "1", name: "Royal Ontario" };
const make = (over = {}) => card.newCard({
  mode: "member", date: "2026-10-16", course, tee, holes: "18", start: 10, entry: "one",
  players: [
    { name: "Willy Rosales", golferId: "w", assocId: "G1", index: 24.3 },
    { name: "Allan Elardo", golferId: "a", assocId: "G2", index: 2.5 },
    { name: "Tony Reyes" },
  ],
  ...over,
});
const fill = (c, value = (n) => card.holeInfo(c, n).par) => {
  for (const n of c.order) for (let p = 0; p < c.players.length; p++) c = card.setScore(c, p, n, typeof value === "function" ? value(n, p) : value);
  return c;
};

test("U1 playing order wraps from the starting hole", () => {
  assert.deepEqual(card.holeOrder("18", 10).slice(0, 10), [10, 11, 12, 13, 14, 15, 16, 17, 18, 1]);
  assert.deepEqual(card.holeOrder("front", 4), [4, 5, 6, 7, 8, 9, 1, 2, 3]);
  assert.deepEqual(card.holeOrder("back", 3), [10, 11, 12, 13, 14, 15, 16, 17, 18], "a start outside the nine begins at its first hole");
  assert.deepEqual(card.startChoices("back"), [10, 11, 12, 13, 14, 15, 16, 17, 18]);
});

test("U2 course handicap matches The Scorecard's formula", () => {
  assert.equal(card.courseHandicapFor(24.3, tee), Math.round(24.3 * 133 / 113 + (68.8 - 72)));
  assert.equal(card.courseHandicapFor(null, tee), null);
  assert.equal(card.courseHandicapFor(10, { ...tee, rating: null }), null);
});

test("U3 strokes received follow stroke index, including plus handicaps", () => {
  assert.equal(card.strokesOn(25, 1), 2);
  assert.equal(card.strokesOn(25, 7), 2);
  assert.equal(card.strokesOn(25, 8), 1);
  assert.equal(card.strokesOn(18, 18), 1);
  assert.equal(card.strokesOn(0, 1), 0);
  assert.equal(card.strokesOn(-2, 18), -1);
  assert.equal(card.strokesOn(-2, 17), -1);
  assert.equal(card.strokesOn(-2, 16), 0);
});

test("U4 net double bogey caps the adjusted score; no index caps at par plus five", () => {
  assert.equal(card.holeCap(4, 25, 1), 8);
  assert.equal(card.holeCap(4, 0, 1), 6);
  assert.equal(card.holeCap(4, null, 1), 9);
  let c = make();
  c = card.setScore(c, 1, 10, 9);           // Allan, hole 10 par 4, SI 8, CH 0 -> cap 6
  const t = card.totals(c, 1);
  assert.equal(t.gross, 9);
  assert.equal(t.adjusted, 6);
  assert.equal(t.toPar, 5);
  assert.equal(t.done, 1);
});

test("U5 a picked-up hole counts as its cap", () => {
  let c = card.setScore(make(), 2, 10, card.PICKED_UP);   // Tony, no index: par 4 + 5
  assert.equal(card.totals(c, 2).gross, 9);
  assert.equal(card.totals(c, 2).pickedUp, 1);
});

test("U6 scores outside 1-20 are refused", () => {
  assert.throws(() => card.setScore(make(), 0, 10, 0));
  assert.throws(() => card.setScore(make(), 0, 10, 21));
  assert.throws(() => card.setScore(make(), 0, 10, 4.5));
  assert.throws(() => card.setScore(make(), 0, 10, "5"));
});

test("U7 a full card: totals, net and completeness", () => {
  const c = fill(make(), (n) => card.holeInfo(make(), n).par + 1);
  assert.ok(card.cardComplete(c));
  const t = card.totals(c, 0);
  assert.equal(t.gross, 90);
  assert.equal(t.toPar, 18);
  assert.equal(t.net, 90 - c.players[0].ch);
  assert.equal(card.totals(c, 2).net, null, "a guest without an index has no net score");
});

test("U8 posting rules: members, 18 holes, rated tee, every hole", () => {
  assert.equal(card.postable(make()).ok, false);
  assert.equal(card.postable(fill(make())).ok, true);
  assert.equal(card.postable(fill(make({ holes: "front" }))).ok, false);
  assert.equal(card.postable(fill(make({ mode: "guest" }))).ok, false);
  assert.equal(card.postable(fill(make({ tee: { ...tee, rating: null } }))).ok, false);
});

test("U9 the round posted is The Scorecard's own shape, with the card and holes attached", () => {
  const c = fill(make(), (n, p) => card.holeInfo(make(), n).par + (p === 0 ? 1 : 0));
  const r = card.roundFor(c, 0, { uid: "u1", courseId: "C", teeId: "T", roundId: "R" });
  assert.equal(r.id, "R");
  assert.equal(r.assocId, "G1");
  assert.equal(r.golferId, "w");
  assert.equal(r.gross, 90);
  assert.equal(r.adjusted, 90);
  assert.equal(r.differential, Math.round((113 / 133) * (90 - 68.8) * 10) / 10);
  assert.equal(r.indexAtEntry, 24.3);
  assert.equal(r.cardId, c.id);
  assert.equal(r.holes.length, 18);
  assert.equal(r.holes[0], 5, "hole 1 first, whatever the starting hole");
  assert.equal(r.enteredBy, "u1");
});

test("U10 the game is attached only to rounds in the game's group", () => {
  const c = fill(make({ game: { id: "g1", name: "Wednesday", assocId: "G1" } }));
  assert.equal(card.roundFor(c, 0, { uid: "u", courseId: "C", teeId: "T" }).gameId, "g1");
  assert.equal(card.roundFor(c, 1, { uid: "u", courseId: "C", teeId: "T" }).gameId, null);
});

test("U11 what is dropped off for posting carries members and scores only, never guests", async () => {
  const store = await import("../../store.js");
  const c = fill(make());
  const sub = store.submissionCard(c);
  assert.deepEqual(sub.players.map((p) => p.golferId), ["w", "a"]);
  assert.ok(!JSON.stringify(sub).includes("Tony"));
  assert.equal(Object.keys(sub.players[0].scores).length, 18);
  assert.ok(!("index" in sub.players[0]) && !("ch" in sub.players[0]), "the worker works out indexes itself");
});

test("U12 the shared text lists every player and every hole", () => {
  const c = fill(make());
  const text = card.shareText(c);
  assert.match(text, /Royal Ontario · White · 2026-10-16 · 18 holes/);
  assert.match(text, /Willy Rosales: 72 \(E\), net/);
  assert.match(text, /Tony Reyes \(guest\): 72 \(E\)/);
  assert.match(text, /1-9: 4 4 3 5 4 4 3 4 5/);
  assert.match(text, /10-18: 4 3 5 4 4 4 3 4 5/);
});

test("U13 only cards that were never posted, and are not being checked, may be deleted", () => {
  assert.equal(card.canDelete({ state: "finished" }), true);
  assert.equal(card.canDelete({ state: "ended" }), true);
  assert.equal(card.canDelete({ state: "failed", sent: true }), true, "refused by The Scorecard");
  assert.equal(card.canDelete({ state: "posting", sent: false }), true, "never left the phone");
  assert.equal(card.canDelete({ state: "posting", sent: true }), false, "being checked: it may still be posted");
  assert.equal(card.canDelete({ state: "posted" }), false);
});

test("U14 deleting a kept card removes it from the phone and from the waiting list", async () => {
  const local = await import("../../storage.js");
  const store = await import("../../store.js");
  const mem = new Map();
  local.useBackend({ getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) });
  local.keepFinished({ id: "a", state: "posting", sent: false });
  local.keepFinished({ id: "b", state: "posted" });
  local.save("outbox", ["a"]);
  store.deleteCard("a");
  assert.deepEqual(local.finishedCards().map((c) => c.id), ["b"]);
  assert.deepEqual(local.load("outbox"), []);
  assert.throws(() => store.deleteCard("b"), /posted in The Scorecard/);
  assert.deepEqual(local.finishedCards().map((c) => c.id), ["b"]);
});
