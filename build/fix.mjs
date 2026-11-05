/* fix.mjs — one-off fix for one card (Willy, 4 Nov 2026, 9:04 pm: "Can you
 * just directly update it on the db? Just for this one").
 *
 * At Carlisle on 4 Nov 2026 Willy's own round on a Marker card went to the
 * leftover golfer "willyros01@gmail.com" (the copy made when he created the
 * Apple Test Group; to-do step 21/22) instead of "Willy Rosales". Other
 * golfers are on the same card, so deleting and re-posting the whole card is
 * not wanted. This moves ONLY that one round to Willy Rosales, in ONE commit,
 * every document guarded by its update time (all or nothing):
 *   - the wrong round is deleted;
 *   - the leftover golfer's window, index and round count are worked out
 *     again without it, and its directory entries updated;
 *   - a new round for Willy Rosales is built from the card exactly as the
 *     server builds it when posting (card.roundFor, the tee frozen at
 *     posting, Willy's own index), in the card's group and game;
 *   - Willy Rosales's window, index and round count, and directory entries;
 *   - the card itself: that player becomes Willy Rosales, with the new round
 *     id, and a note of the fix.
 * The other golfers' rounds are not touched.
 *
 * GO = false: reads only and prints exactly what would change. Nothing is
 * written. GO = true only after Willy has seen that and said go.
 */
import { client, setWrite, updateWrite, deleteWrite } from "../worker/src/firestore.js";
import * as model from "../model.js";
import * as card from "../card.js";
import { checkCard, checkTee, teeFor } from "../worker/src/post.js";

const GO = true;   /* Willy said go, 4 Nov 2026, 9:13 pm */
const DATE = "2026-11-04";
const WRONG = "willyros01@gmail.com";
const RIGHT = "Willy Rosales";

const fs = client({ project: process.env.PROJECT, token: async () => process.env.TOKEN });
const say = (s) => console.log(s);
const stop = (s) => { say("STOPPED, nothing written: " + s); process.exit(0); };
const low = (s) => String(s || "").trim().toLowerCase();

say(GO ? "MODE: GO (writes in one commit)" : "MODE: LOOK ONLY (nothing is written)");

/* 1. The card. */
const subs = (await fs.query("", "markerSubmissions", [["status", "EQUAL", "posted"]], 2000))
  .filter((s) => s.data.card && s.data.card.date === DATE && /carlisle/i.test((s.data.card.course && s.data.card.course.name) || ""));
say(`Posted Carlisle cards dated ${DATE}: ${subs.length}`);
for (const s of subs) say(`  card ${s.id}: ${(s.data.card.players || []).map((p) => p.name).join(", ")}`);
const hits = subs.filter((s) => s.data.card.players.some((p) => low(p.name) === WRONG));
if (hits.length !== 1) stop(`expected exactly one Carlisle card with "${WRONG}" on it, found ${hits.length}.`);
const sub = hits[0];
const c = sub.data.card;
const i = c.players.findIndex((p) => low(p.name) === WRONG);
const wrongP = c.players[i];
say(`\nCARD ${sub.id}, scorer ${sub.data.scorer}, course "${c.course.name}", tee "${c.tee && c.tee.name}", game ${c.game ? `${c.game.id} in ${c.game.assocId}` : "none"}`);
c.players.forEach((p, k) => say(`  ${k === i ? ">>" : "  "} ${p.name}: golfer ${p.golferId}, group ${p.assocId}, round ${(sub.data.rounds || {})[p.golferId] || "-"}`));
if (sub.data.repostedAs || sub.data.discarded) stop("the card was re-posted or deleted.");
if (sub.data.roundsDeleted) stop("this card's rounds were deleted in The Marker.");

/* 2. The wrong round. */
const rid = (sub.data.rounds || {})[wrongP.golferId];
const wrongRound = rid ? await fs.get(`associations/${wrongP.assocId}/rounds/${rid}`) : null;
if (!wrongRound) stop("the wrong round is not in The Scorecard any more.");
say(`\nWRONG ROUND ${wrongRound.path}: gross ${wrongRound.data.gross}, adjusted ${wrongRound.data.adjusted}, differential ${wrongRound.data.differential}, game ${wrongRound.data.gameId || "-"}`);

/* 3. Willy Rosales: the golfer linked to the scorer's account. */
const scorer = sub.data.scorer;
const named = await fs.query("", "golfers", [["name", "EQUAL", RIGHT]], 20);
say(`\nGolfers named "${RIGHT}": ${named.map((g) => `${g.id} (linked ${g.data.linkedUid || "-"}, groups ${(g.data.groups || []).join("/") || "-"}, rounds ${g.data.roundCount || 0}${g.data.archived ? ", ARCHIVED" : ""})`).join("; ") || "none"}`);
const live = named.filter((g) => !g.data.archived);
const linked = live.filter((g) => g.data.linkedUid === scorer);
const right = linked.length === 1 ? linked[0] : live.length === 1 ? live[0] : null;
if (!right) stop(`cannot tell which "${RIGHT}" is Willy's (none or more than one).`);
if (c.players.some((p) => p.golferId === right.id)) stop(`${RIGHT} is already on this card.`);

/* 4. The group for the new round: the card's game group, else the group of
   the other golfers, where Willy Rosales is on the roster and the scorer a member. */
const others = c.players.filter((_, k) => k !== i).map((p) => p.assocId);
const candidates = [...new Set([c.game && c.game.assocId, ...others, ...(right.data.groups || [])].filter(Boolean))];
let assocId = null;
for (const a of candidates) {
  const onRoster = !!(await fs.get(`associations/${a}/roster/${right.id}`));
  const member = !!(await fs.get(`associations/${a}/members/${scorer}`));
  const g = await fs.get(`associations/${a}`);
  say(`  group ${a} "${g ? g.data.name : "?"}": ${RIGHT} on roster ${onRoster}, scorer member ${member}`);
  if (!assocId && onRoster && member) assocId = a;
}
if (!assocId) stop(`no group found with ${RIGHT} on the roster.`);
const groupDoc = await fs.get(`associations/${assocId}`);
say(`New round goes to group ${assocId} "${groupDoc.data.name}"`);

/* 5. The new round, built the way the server posts it. */
const order = checkCard(c, "2999-01-01");
const tee = sub.data.postedTee ? checkTee(sub.data.postedTee) : await teeFor(fs, c);
const index = model.effectiveIndex(right.data).index;
const newP = { name: right.data.name, golferId: right.id, assocId, guest: false, index, ch: card.courseHandicapFor(index, tee),
  scores: Object.fromEntries(order.map((n) => [n, wrongP.scores[n]])) };
const game = c.game && c.game.assocId === assocId ? c.game : null;
const trusted = { id: sub.id, mode: "member", date: c.date, holes: "18", start: order[0], order,
  course: { providerId: c.course.providerId || null, name: String(c.course.name).trim(), where: c.course.where || "" },
  tee, game, players: [newP], ...(c.scoredBy === "caddie" ? { scoredBy: "caddie" } : {}) };
const r = card.roundFor(trusted, 0, { uid: scorer, courseId: wrongRound.data.courseId, teeId: wrongRound.data.teeId });
say(`\nNEW ROUND associations/${assocId}/rounds/${r.id}: ${RIGHT}, gross ${r.gross}, adjusted ${r.adjusted}, differential ${r.differential}, index at entry ${index}, course handicap ${newP.ch}, game ${r.gameId || "-"}`);
if (r.gross !== Number(wrongRound.data.gross)) stop(`the gross does not match the wrong round (${r.gross} vs ${wrongRound.data.gross}).`);

const writes = [];
writes.push(deleteWrite(fs, wrongRound.path, { updateTime: wrongRound.updateTime }));
writes.push(setWrite(fs, `associations/${assocId}/rounds/${r.id}`, { ...r, enteredVia: "marker" }, { exists: false, now: ["enteredAt"] }));

/* 6. The leftover golfer, worked out again without the round. */
const wrongG = await fs.get(`golfers/${wrongP.golferId}`);
if (wrongG) {
  const groups = new Set([...(wrongG.data.groups || []), ...(wrongG.data.recentWindow || []).map((e) => e.assocId), wrongP.assocId].filter((a) => typeof a === "string" && a));
  const fresh = []; let count = 0;
  for (const a of groups) {
    for (const row of await fs.query(`associations/${a}`, "rounds", [["golferId", "EQUAL", wrongG.id]], 1000)) {
      if (row.id === wrongRound.id) continue;
      count++;
      const d = Number(row.data.differential);
      if (typeof row.data.date === "string" && Number.isFinite(d)) fresh.push({ roundId: row.id, date: row.data.date, differential: d, assocId: a });
    }
  }
  const window = model.mergeWindow([], fresh);
  const after = model.effectiveIndex({ ...wrongG.data, recentWindow: window }).index;
  say(`\nLEFTOVER GOLFER ${wrongG.id} "${wrongG.data.name}": rounds ${wrongG.data.roundCount || 0} -> ${count}, index ${model.effectiveIndex(wrongG.data).index} -> ${after}`);
  writes.push(updateWrite(fs, wrongG.path, { recentWindow: window, handicapIndex: model.displayIndex(window), roundCount: count }, { updateTime: wrongG.updateTime }));
  for (const a of new Set([...(wrongG.data.groups || []), wrongP.assocId])) {
    const e = typeof a === "string" && a ? await fs.get(`associations/${a}/directory/${wrongG.id}`) : null;
    if (e) writes.push(setWrite(fs, e.path, { golferId: wrongG.id, displayName: wrongG.data.name || "", handicapIndex: after, updatedAt: Date.now() }, { updateTime: e.updateTime }));
  }
}

/* 7. Willy Rosales, with the new round. */
const winR = model.insertIntoWindow(right.data.recentWindow, { roundId: r.id, date: r.date, differential: r.differential, assocId });
const afterR = model.effectiveIndex({ ...right.data, recentWindow: winR }).index;
say(`${RIGHT} ${right.id}: rounds ${right.data.roundCount || 0} -> ${(Number(right.data.roundCount) || 0) + 1}, index ${index} -> ${afterR}`);
writes.push(updateWrite(fs, right.path, { recentWindow: winR, handicapIndex: model.displayIndex(winR), roundCount: (Number(right.data.roundCount) || 0) + 1 }, { updateTime: right.updateTime }));
for (const a of new Set([...(right.data.groups || []), assocId])) {
  const e = typeof a === "string" && a ? await fs.get(`associations/${a}/directory/${right.id}`) : null;
  if (e) writes.push(setWrite(fs, e.path, { golferId: right.id, displayName: right.data.name || "", handicapIndex: afterR, updatedAt: Date.now() }, { updateTime: e.updateTime }));
}

/* 8. The card: that player is now Willy Rosales, with the new round id. */
const players = c.players.map((p, k) => (k === i ? { ...p, name: right.data.name, golferId: right.id, assocId } : p));
const rounds = { ...(sub.data.rounds || {}) }; delete rounds[wrongP.golferId]; rounds[right.id] = r.id;
writes.push(updateWrite(fs, sub.path, {
  card: { ...c, players }, rounds,
  golferFixed: { from: wrongP.golferId, fromName: wrongP.name, to: right.id, toName: right.data.name, oldRound: wrongRound.path, newRound: `associations/${assocId}/rounds/${r.id}`, by: "Willy's request, 4 Nov 2026" },
}, { updateTime: sub.updateTime, now: ["golferFixedAt"] }));

say(`\n${writes.length} writes planned, in one commit. The other golfers' rounds are not touched.`);
if (!GO) { say("LOOK ONLY: nothing written."); process.exit(0); }
await fs.commit(writes);
const check = await fs.get(`associations/${assocId}/rounds/${r.id}`);
const gone = await fs.get(wrongRound.path);
say(`COMMITTED. New round there: ${!!check} (gross ${check && check.data.gross}). Wrong round gone: ${!gone}.`);
