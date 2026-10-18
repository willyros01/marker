/* correct.js — correcting a card that is already posted (Willy, 18 Oct 2026).
 *
 * Who may correct:
 *   - the scorer who posted the card, until 24 hours after it was posted;
 *   - an owner or admin of every group on the card, at any time.
 *
 * What a correction is: new hole scores for the golfers already on the card.
 * Nothing else changes — not the golfers, course, tee, date, game, or the
 * handicap frozen on each round when it was posted.
 *
 * ONE commit writes everything or nothing:
 *   - each changed round: hole scores, gross, adjusted, differential, and a
 *     record of the correction (who, when, as what, the scores before);
 *   - each changed golfer's 20-round window and index (when that round is in
 *     the window), and their directory entry in every group that has one;
 *   - the card kept with the submission, so the next correction starts from it.
 * Every document is written only if unchanged since it was read.
 *
 * Refused, with the reason, when a round was deleted or its scores changed in
 * The Scorecard since: the card and the round no longer agree, and a
 * correction would overwrite somebody else's change.
 */
import * as model from "../../model.js";
import * as card from "../../card.js";
import { setWrite, updateWrite } from "./firestore.js";
import { Refusal, STATUS, checkCard, checkTee, teeFor } from "./post.js";

export const CORRECT_HOURS = 24;
const refuse = (why) => { throw new Refusal(why); };
const first = (name) => String(name || "A golfer").split(" ")[0];
const ms = (t) => (typeof t === "string" ? Date.parse(t) : Number(t) || NaN);

/* Is this caller an owner or admin of the group? */
async function manages(fs, uid, assocId, cache) {
  if (cache.has(assocId)) return cache.get(assocId);
  let ok = false;
  const m = await fs.get(`associations/${assocId}/members/${uid}`);
  if (m && (m.data.role === "admin" || m.data.role === "owner")) ok = true;
  if (!ok) {
    const a = await fs.get(`associations/${assocId}`);
    ok = !!(a && a.data.ownerUid === uid);
  }
  cache.set(assocId, ok);
  return ok;
}

/* How this caller may correct the submission: "scorer", "admin" or null,
   with the time the scorer's window closes. */
async function rights(fs, who, sub, now, cache = new Map()) {
  const d = sub.data;
  const posted = ms(d.postedAt);
  const until = Number.isFinite(posted) ? posted + CORRECT_HOURS * 3600_000 : NaN;
  const groups = [...new Set((d.card && d.card.players || []).map((p) => p.assocId))];
  let admin = groups.length > 0;
  for (const a of groups) if (!(await manages(fs, who.uid, a, cache))) { admin = false; break; }
  if (admin) return { as: "admin", until };
  if (d.scorer === who.uid && Number.isFinite(until) && now < until) return { as: "scorer", until };
  return { as: null, until };
}

/* The card as the worker posted it, with each golfer's frozen handicap from
   their round, and the rounds themselves. Refuses when a round is gone or no
   longer matches the card. */
async function load(fs, sub) {
  const c = sub.data.card;
  const order = checkCard(c, "2999-01-01");
  /* The tee the card was posted with; for cards posted before that was kept,
     the library's (never the phone's own copy). */
  const tee = sub.data.postedTee ? checkTee(sub.data.postedTee) : await teeFor(fs, c);
  const rounds = sub.data.rounds || {};
  const players = [];
  const docs = [];
  for (const p of c.players) {
    const rid = rounds[p.golferId];
    const r = rid ? await fs.get(`associations/${p.assocId}/rounds/${rid}`) : null;
    if (!r) refuse(`${first(p.name)}'s round from this card was deleted in The Scorecard, so the card can no longer be corrected here. An owner or admin can enter the round again.`);
    /* The handicap frozen on the round when it was posted, never today's. */
    const index = r.data.indexAtEntry == null ? null : Number(r.data.indexAtEntry);
    players.push({ name: p.name || "", golferId: p.golferId, assocId: p.assocId, guest: false, index, ch: card.courseHandicapFor(index, roundTee(tee, r)), scores: Object.fromEntries(order.map((n) => [n, p.scores[n]])) });
    docs.push(r);
  }
  /* The round must still say what the card says. */
  const trusted = { id: sub.id, mode: "member", date: c.date, holes: "18", start: order[0], order, course: c.course, tee, game: null, players };
  players.forEach((p, i) => {
    const r = docs[i].data;
    const expect = card.roundFor({ ...trusted, tee: roundTee(tee, docs[i]) }, i, { uid: r.enteredBy, courseId: r.courseId, teeId: r.teeId, roundId: docs[i].id });
    if (Number(r.gross) !== expect.gross || JSON.stringify(r.holes || null) !== JSON.stringify(expect.holes)) {
      refuse(`${first(p.name)}'s round was changed in The Scorecard after this card was posted, so the card and the round no longer agree. An owner or admin can correct it in The Scorecard.`);
    }
  });
  return { c, order, tee, players, docs, trusted };
}

/* The rating, slope and par frozen on the round; the holes from the card. */
const roundTee = (tee, doc) => ({
  ...tee,
  rating: Number.isFinite(Number(doc.data.rating)) ? Number(doc.data.rating) : tee.rating,
  slope: Number.isFinite(Number(doc.data.slope)) ? Number(doc.data.slope) : tee.slope,
  par: Number.isFinite(Number(doc.data.par)) ? Number(doc.data.par) : tee.par,
});

const summary = (sub, r) => {
  const c = sub.data.card || {};
  return {
    cardId: sub.id, date: c.date || "", course: (c.course && c.course.name) || "", tee: (c.tee && c.tee.name) || "",
    players: (c.players || []).map((p) => p.name || ""), as: r.as, until: Number.isFinite(r.until) ? new Date(r.until).toISOString() : null,
    corrections: Number(sub.data.corrections) || 0,
  };
};

/* The posted cards this caller may correct, newest first. */
export async function correctable(fs, who, { now = Date.now(), limit = 40 } = {}) {
  if (!who || who.anonymous) refuse("Sign in to correct a card.");
  const posted = await fs.query("", "markerSubmissions", [["status", "EQUAL", STATUS.POSTED]], 500);
  const cache = new Map();
  const out = [];
  for (const s of posted) {
    if (!s.data.card) continue;
    const r = await rights(fs, who, s, now, cache);
    if (r.as) out.push(summary(s, r));
  }
  out.sort((a, b) => (b.date + b.cardId).localeCompare(a.date + a.cardId));
  return out.slice(0, limit);
}

/* One card, ready to be corrected on the phone. */
export async function cardForCorrection(fs, who, cardId, { now = Date.now() } = {}) {
  if (!who || who.anonymous) refuse("Sign in to correct a card.");
  const sub = await fs.get(`markerSubmissions/${String(cardId || "").slice(0, 80)}`);
  if (!sub || sub.data.status !== STATUS.POSTED || !sub.data.card) refuse("This card is not posted in The Scorecard.");
  const r = await rights(fs, who, sub, now);
  if (!r.as) refuse(sub.data.scorer === who.uid ? `A card can be corrected by its scorer for ${CORRECT_HOURS} hours after posting. After that, an owner or admin of the group can correct it.` : "Only the scorer, or an owner or admin of the group, can correct this card.");
  const { c, players } = await load(fs, sub);
  return { ...summary(sub, r), card: c, handicaps: players.map((p) => ({ golferId: p.golferId, index: p.index, ch: p.ch })) };
}

/* Save a correction: `scores` is { golferId: { hole: score } } for the golfers
   on the card. Returns { status: "corrected" | "unchanged", changed: [names] }. */
export async function correct(fs, who, { cardId, scores } = {}, { now = Date.now() } = {}) {
  if (!who || who.anonymous) refuse("Sign in to correct a card.");
  const sub = await fs.get(`markerSubmissions/${String(cardId || "").slice(0, 80)}`);
  if (!sub || sub.data.status !== STATUS.POSTED || !sub.data.card) refuse("This card is not posted in The Scorecard.");
  const r = await rights(fs, who, sub, now);
  if (!r.as) refuse("This card can no longer be corrected by you. An owner or admin of the group can correct it.");
  const { c, order, tee, players, docs, trusted } = await load(fs, sub);

  /* The new scores: same golfers, same holes, each a score from 1 to 20 or picked up. */
  const given = scores && typeof scores === "object" ? scores : {};
  const fixed = players.map((p) => {
    const s = given[p.golferId] && typeof given[p.golferId] === "object" ? given[p.golferId] : {};
    return { ...p, scores: Object.fromEntries(order.map((n) => {
      const v = s[n] ?? s[String(n)];
      return [n, v === card.PICKED_UP || v === "X" ? card.PICKED_UP : Number(v)];
    })) };
  });
  const newCard = { ...c, players: c.players.map((p, i) => ({ ...p, scores: Object.fromEntries(order.map((n) => [String(n), fixed[i].scores[n]])) })) };
  checkCard(newCard, "2999-01-01");

  const at = new Date(now).toISOString();
  const writes = [];
  const changed = [];
  for (let i = 0; i < players.length; i++) {
    const doc = docs[i];
    const t = roundTee(tee, doc);
    const after = card.roundFor({ ...trusted, tee: t, players: fixed }, i, { uid: doc.data.enteredBy, courseId: doc.data.courseId, teeId: doc.data.teeId, roundId: doc.id });
    if (JSON.stringify(after.holes) === JSON.stringify(doc.data.holes)) continue;
    changed.push(players[i].name);
    const record = {
      at, by: who.uid, as: r.as,
      before: { gross: doc.data.gross, adjusted: doc.data.adjusted, differential: doc.data.differential, holes: doc.data.holes || [] },
    };
    writes.push(updateWrite(fs, doc.path, {
      gross: after.gross, adjusted: after.adjusted, differential: after.differential, holes: after.holes,
      corrections: [...(Array.isArray(doc.data.corrections) ? doc.data.corrections : []), record],
    }, { updateTime: doc.updateTime }));

    /* The golfer's index, when this round counts in it. */
    const g = await fs.get(`golfers/${players[i].golferId}`);
    if (!g) refuse(`${first(players[i].name)} is no longer in The Scorecard.`);
    const win = Array.isArray(g.data.recentWindow) ? g.data.recentWindow : [];
    if (!win.some((e) => e.roundId === doc.id)) continue;
    const window = win.map((e) => (e.roundId === doc.id ? { ...e, differential: after.differential } : e));
    writes.push(updateWrite(fs, g.path, { recentWindow: window, handicapIndex: model.displayIndex(window) }, { updateTime: g.updateTime }));
    const index = model.effectiveIndex({ ...g.data, recentWindow: window }).index;
    const groups = new Set([...(Array.isArray(g.data.groups) ? g.data.groups : []), players[i].assocId]);
    for (const a of groups) {
      if (typeof a !== "string" || !a) continue;
      const entry = await fs.get(`associations/${a}/directory/${g.id}`);
      if (!entry) continue;
      writes.push(setWrite(fs, entry.path, { golferId: g.id, displayName: g.data.name || "", handicapIndex: index, updatedAt: now }, { updateTime: entry.updateTime }));
    }
  }
  if (!changed.length) return { status: "unchanged", changed: [] };

  writes.push(updateWrite(fs, sub.path, {
    card: newCard, corrections: (Number(sub.data.corrections) || 0) + 1, lastCorrection: { by: who.uid, as: r.as, at },
  }, { updateTime: sub.updateTime, now: ["correctedAt"] }));
  try { await fs.commit(writes); }
  catch (e) {
    if (e.conflict) refuse("Somebody changed one of these rounds or golfers a moment ago. Open the card again and redo the correction.");
    throw e;
  }
  return { status: "corrected", changed };
}
