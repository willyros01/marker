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

test("U15 saved courses: a searched course replaces same-name copies; a course can be deleted from the device", async () => {
  const local = await import("../../storage.js");
  const mem = new Map();
  local.useBackend({ getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) });
  local.rememberConfirmed({ providerId: null, name: "Royal Ontario Golf Club", tees: [{}] });
  local.rememberCourse({ providerId: "99", name: "Lakeview", tees: [{}] });
  local.rememberCourse({ providerId: "kk", name: "royal ontario golf club ", tees: [{}, {}] });
  assert.deepEqual(local.recentCourses().map((c) => local.courseKey(c)), ["kk", "99"]);
  local.forgetCourse("99");
  assert.deepEqual(local.recentCourses().map((c) => c.providerId), ["kk"]);
  local.forgetCourse("nothing");
  assert.equal(local.recentCourses().length, 1);
});

test("U16 a re-posted card replaces the old copy on the phone, only once it is posted", async () => {
  const local = await import("../../storage.js");
  const store = await import("../../store.js");
  const mem = new Map();
  local.useBackend({ getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) });
  local.keepFinished({ id: "old", state: "posted" });
  local.keepFinished({ id: "new", state: "posting", repostOf: "old" });
  store.dropReplaced();
  assert.deepEqual(local.finishedCards().map((c) => c.id).sort(), ["new", "old"], "kept while the re-post is not posted");
  local.keepFinished({ id: "new", state: "posted", repostOf: "old" });
  store.dropReplaced();
  assert.deepEqual(local.finishedCards().map((c) => c.id), ["new"]);
});

test("U17 a posted card can be removed from the phone only; an unposted one cannot this way", async () => {
  const local = await import("../../storage.js");
  const store = await import("../../store.js");
  const mem = new Map();
  local.useBackend({ getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) });
  local.keepFinished({ id: "p", state: "posted" });
  local.keepFinished({ id: "w", state: "posting", sent: true });
  assert.throws(() => store.removeFromPhone("w"), /Only a posted card/);
  store.removeFromPhone("p");
  assert.deepEqual(local.finishedCards().map((c) => c.id), ["w"]);
});

test("U30 the game leaderboard: live in gross with ties, golfers not started last; final in gross and net (1.1.0)", async () => {
  const card = await import("../../card.js");
  const holes = Array.from({ length: 18 }, (_, i) => ({ par: 4, yards: 380, si: i + 1 }));
  const setup = (names, chs) => ({ course: { name: "Carlisle" }, tee: { name: "White", par: 72, holes }, order: Array.from({ length: 18 }, (_, i) => i + 1),
    players: names.map((name, i) => ({ name, ch: chs[i] })) });
  const all = (v) => Object.fromEntries(Array.from({ length: 18 }, (_, i) => [String(i + 1), v]));
  const live = card.gameBoard({ cards: [
    { setup: setup(["Willy Rosales", "Raul Rosales"], [22, 13]), scores: { 0: { 1: 5, 2: 4 }, 1: { 1: 3 } }, status: "live" },
    { setup: setup(["Hermie Ticsay", "Ruben Castillo"], [18, null]), scores: { 0: { 1: 4, 2: 5 }, 1: {} }, status: "live" },
  ] });
  assert.deepEqual(live.live.map((r) => [r.place, r.name, r.toPar, r.thru]),
    [["1", "Raul Rosales", -1, 1], ["T2", "Hermie Ticsay", 1, 2], ["T2", "Willy Rosales", 1, 2], ["", "Ruben Castillo", 0, 0]]);
  assert.equal(live.final, false);
  assert.deepEqual([live.live[0].card, live.live[0].player], [0, 1]);
  const fin = card.gameBoard({ finished: true, cards: [
    { setup: setup(["Willy Rosales", "Raul Rosales"], [22, 13]), scores: { 0: all(5), 1: all(5) }, status: "finished", posted: true },
    { setup: setup(["Hermie Ticsay", "Ruben Castillo"], [18, null]), scores: { 0: all(6), 1: { 1: 4 } }, status: "finished" },
  ] });
  assert.equal(fin.final, true);
  assert.deepEqual(fin.gross.map((r) => [r.place, r.name, r.gross]), [["T1", "Raul Rosales", 90], ["T1", "Willy Rosales", 90], ["3", "Hermie Ticsay", 108]]);
  assert.deepEqual(fin.net.map((r) => [r.place, r.name, r.net]), [["1", "Willy Rosales", 68], ["2", "Raul Rosales", 77], ["3", "Hermie Ticsay", 90]]);
  assert.deepEqual(fin.unfinished.map((r) => r.name), ["Ruben Castillo"]);
});

test("U31 a golfer who joined on the 3rd hole: missed holes need no score; 14+ holes posts, fewer is shared only (5 Nov 2026)", async () => {
  let c = make({ start: 1 });
  c = { ...c, players: [...c.players, { name: "Late Lou", golferId: "l", assocId: "G1", groupName: "", guest: false, index: 10, ch: card.courseHandicapFor(10, tee), scores: {}, from: 2 }] };
  for (const n of c.order) for (let p = 0; p < 3; p++) c = card.setScore(c, p, n, 4);
  for (const n of c.order.slice(2)) c = card.setScore(c, 3, n, 5);
  assert.equal(card.joinedOn(c, c.players[3]), 3);
  assert.deepEqual(card.missedOf(c, c.players[3]), [1, 2]);
  assert.ok(card.holeComplete(c, 1) && card.cardComplete(c));
  const t = card.totals(c, 3);
  assert.equal(t.done, 16); assert.equal(t.missed, 2); assert.ok(t.complete); assert.equal(t.net, null);
  const ok = card.postable(c);
  assert.ok(ok.ok); assert.deepEqual(ok.members.map((p) => p.name), ["Willy Rosales", "Allan Elardo", "Late Lou"]);
  /* joined on hole 6: 13 holes, not posted; the others still are */
  const short = { ...c, players: c.players.map((p, i) => (i === 3 ? { ...p, from: 5, scores: Object.fromEntries(Object.entries(p.scores).filter(([n]) => Number(n) >= 6)) } : p)) };
  const s = card.postable(short);
  assert.ok(s.ok); assert.deepEqual(s.members.map((p) => p.name), ["Willy Rosales", "Allan Elardo"]); assert.deepEqual(s.short.map((p) => p.name), ["Late Lou"]);
  /* a score typed on a missed hole simply counts */
  const typed = card.setScore(c, 3, 1, 6);
  assert.deepEqual(card.missedOf(typed, typed.players[3]), [2]);
  /* the leaderboard copy keeps when they joined */
  const lc = card.liveCard({ setup: { course, tee, order: c.order, players: c.players.map((p) => ({ name: p.name, ch: p.ch, ...(p.from ? { from: p.from } : {}) })) }, scores: { 3: c.players[3].scores } });
  assert.ok(card.totals(lc, 3).complete);
});
