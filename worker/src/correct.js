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
import { setWrite, updateWrite, deleteWrite } from "./firestore.js";
import { Refusal, STATUS, checkCard, checkTee, teeFor } from "./post.js";

export const CORRECT_HOURS = 24;
const refuse = (why) => { throw new Refusal(why); };
/* Full names in every message: a group can have two golfers with the same first name. */
const full = (name) => String(name || "").trim() || "A golfer";
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

/* The app owner's override (Willy, 23 Oct 2026, "like SAP_ALL"): a signed-in
   account listed in appOwners/{uid} may act as owner in every group, including
   groups created by someone else. The record can only be written outside the
   apps (no rule allows it); every use is recorded with as: "appOwner". */
export async function isAppOwner(fs, uid, cache = new Map()) {
  if (!uid) return false;
  const key = `appOwner:${uid}`;
  if (cache.has(key)) return cache.get(key);
  const d = await fs.get(`appOwners/${uid}`);
  const ok = !!(d && d.data && d.data.active === true);
  cache.set(key, ok);
  return ok;
}

/* How this caller may correct the submission: "scorer", "admin", "appOwner"
   or null, with the time the scorer's window closes. */
async function rights(fs, who, sub, now, cache = new Map()) {
  const d = sub.data;
  const posted = ms(d.postedAt);
  const until = Number.isFinite(posted) ? posted + CORRECT_HOURS * 3600_000 : NaN;
  const groups = [...new Set((d.card && d.card.players || []).map((p) => p.assocId))];
  let admin = groups.length > 0;
  for (const a of groups) if (!(await manages(fs, who.uid, a, cache))) { admin = false; break; }
  if (admin) return { as: "admin", until };
  if (!who.anonymous && groups.length > 0 && (await isAppOwner(fs, who.uid, cache))) return { as: "appOwner", until };
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
    if (!r) refuse(`${full(p.name)}'s round from this card was deleted in The Scorecard, so the card can no longer be corrected. It can be re-posted from Your cards: by the scorer for 24 hours after posting, by an owner or admin of the group at any time.`);
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
      refuse(`${full(p.name)}'s round was changed in The Scorecard after this card was posted, so the card and the round no longer agree. An owner or admin can correct it in The Scorecard.`);
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

/* Each golfer's round from the card: the document, or null when it was
   deleted in The Scorecard. */
async function roundsOf(fs, sub) {
  const c = sub.data.card || {};
  const rounds = sub.data.rounds || {};
  const out = [];
  for (const p of c.players || []) {
    const rid = rounds[p.golferId];
    out.push(rid ? await fs.get(`associations/${p.assocId}/rounds/${rid}`) : null);
  }
  return out;
}

/* May this caller re-post (or hide) the card: the same rights as correcting
   it (Willy, 20 Oct 2026) — its scorer for 24 hours after it was posted, an
   owner or admin of every group on it at any time. */
async function mayRepost(fs, who, sub, now, cache = new Map()) {
  return !!(await rights(fs, who, sub, now, cache)).as;
}

/* A card whose rounds were (some or all) deleted in The Scorecard can be
   re-posted: only the golfers whose rounds are gone go on the new card. */
const repostable = (sub) => !sub.data.repostedAs && !sub.data.discarded;

/* Everything the Your cards screen needs from The Scorecard, newest first:
   - correctable: posted cards this caller may correct, every round still there;
   - editable: cards with deleted rounds this caller may re-post, with the
     golfers whose rounds are gone and their index today. */
export async function myCards(fs, who, { now = Date.now(), limit = 40 } = {}) {
  if (!who || who.anonymous) refuse("Sign in to see your cards.");
  const posted = await fs.query("", "markerSubmissions", [["status", "EQUAL", STATUS.POSTED]], 500);
  const cache = new Map();
  const correctable = [];
  const editable = [];
  for (const s of posted) {
    if (!s.data.card) continue;
    const r = await rights(fs, who, s, now, cache);
    const canRepost = repostable(s) && !!r.as;
    if (!r.as && !canRepost) continue;
    const docs = await roundsOf(fs, s);
    const gone = docs.map((d, i) => (d ? null : i)).filter((i) => i !== null);
    if (!gone.length) { if (r.as) correctable.push(summary(s, r)); continue; }
    if (!canRepost) continue;
    const c = s.data.card;
    const players = [];
    for (const i of gone) {
      const p = c.players[i];
      const g = await fs.get(`golfers/${p.golferId}`);
      players.push({ ...p, index: g ? model.effectiveIndex(g.data).index : null });
    }
    /* Hidden ones come too, marked: they are left off the list and the count,
       but opening the card on the phone still offers Edit and re-post. */
    editable.push({ ...summary(s, r), hidden: !!s.data.repostHidden, gone: players.map((p) => p.name || ""), card: { ...c, players } });
  }
  const order = (a, b) => (b.date + b.cardId).localeCompare(a.date + a.cardId);
  return { correctable: correctable.sort(order).slice(0, limit), editable: editable.sort(order).slice(0, limit) };
}

/* The posted cards this caller may correct (kept for The Marker 0.6.0). */
export async function correctable(fs, who, opts = {}) {
  return (await myCards(fs, who, opts)).correctable;
}

/* Hide a card with deleted rounds from the list, or show it again (hidden:
   false). Nothing in The Scorecard changes. */
export async function hideEditable(fs, who, cardId, { hidden = true, now = Date.now() } = {}) {
  if (!who || who.anonymous) refuse("Sign in to see your cards.");
  const sub = await fs.get(`markerSubmissions/${String(cardId || "").slice(0, 80)}`);
  if (!sub || sub.data.status !== STATUS.POSTED) refuse("This card is not posted in The Scorecard.");
  if (!(await mayRepost(fs, who, sub, now))) refuse(sub.data.scorer === who.uid ? `The scorer can hide or show this card for ${CORRECT_HOURS} hours after it was posted. After that, an owner or admin of the group can.` : "Only the scorer, or an owner or admin of the group, can hide or show this card.");
  try {
    await fs.commit([updateWrite(fs, sub.path, { repostHidden: hidden ? { by: who.uid } : null }, { updateTime: sub.updateTime, now: ["repostHiddenAt"] })]);
  } catch (e) {
    if (e.conflict) refuse("This card changed a moment ago. Open Your cards again.");
    throw e;
  }
  return { status: hidden ? "hidden" : "shown" };
}

/* Delete a card with deleted rounds for good (Willy, 20 Oct 2026): it leaves
   the lists and can never be re-posted. Nothing in The Scorecard changes; the
   submission keeps who did it and when, as a record. */
export async function discardEditable(fs, who, cardId, { now = Date.now() } = {}) {
  if (!who || who.anonymous) refuse("Sign in to delete this card.");
  const sub = await fs.get(`markerSubmissions/${String(cardId || "").slice(0, 80)}`);
  if (!sub || sub.data.status !== STATUS.POSTED) refuse("This card is not posted in The Scorecard.");
  if (sub.data.discarded) return { status: "deleted" };
  if (!(await mayRepost(fs, who, sub, now))) refuse(sub.data.scorer === who.uid ? `The scorer can delete this card for ${CORRECT_HOURS} hours after it was posted. After that, an owner or admin of the group can.` : "Only the scorer, or an owner or admin of the group, can delete this card.");
  if (!(await roundsOf(fs, sub)).some((d) => !d)) refuse("This card's rounds are still in The Scorecard. Delete its rounds first.");
  try {
    await fs.commit([updateWrite(fs, sub.path, { discarded: { by: who.uid } }, { updateTime: sub.updateTime, now: ["discardedAt"] })]);
  } catch (e) {
    if (e.conflict) refuse("This card changed a moment ago. Open Your cards again.");
    throw e;
  }
  return { status: "deleted" };
}

/* Called while posting a re-posted card (post.js): the old card, checked.
   Every golfer on the new card who was on the old one must have lost that
   round, so nobody is ever counted twice. Returns the write marking the old
   card as re-posted, to go in the same commit as the new rounds. */
export async function repostWrite(fs, sub, oldId) {
  const old = await fs.get(`markerSubmissions/${String(oldId || "").slice(0, 80)}`);
  if (!old || old.data.status !== STATUS.POSTED || !old.data.card) refuse("The card this one re-posts is not in The Scorecard.");
  if (old.data.repostedAs && old.data.repostedAs !== sub.id) refuse("That card has already been re-posted.");
  if (old.data.discarded) refuse("That card was deleted, so it can no longer be re-posted.");
  /* Judged at the time the new card was handed in (its drop-off), so a card
     re-posted with no signal is not refused for arriving late. */
  const at = Number.isFinite(ms(sub.data.createdAt)) ? ms(sub.data.createdAt) : Date.now();
  if (!(await mayRepost(fs, { uid: sub.data.scorer }, old, at))) {
    refuse(old.data.scorer === sub.data.scorer
      ? `The scorer can re-post a card for ${CORRECT_HOURS} hours after it was first posted. After that, an owner or admin of the group can re-post it.`
      : "Only the scorer, or an owner or admin of the group, can re-post this card.");
  }
  const docs = await roundsOf(fs, old);
  const before = new Map((old.data.card.players || []).map((p, i) => [p.golferId, docs[i]]));
  for (const p of sub.data.card.players || []) {
    if (before.get(p.golferId)) refuse(`${full(p.name)}'s round from the card of ${old.data.card.date} is still in The Scorecard, so posting it again would count it twice. Take ${full(p.name)} off this card.`);
  }
  return updateWrite(fs, old.path, { repostedAs: sub.id }, { updateTime: old.updateTime });
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
      ...(after.holePar ? { holePar: after.holePar, holeSi: after.holeSi } : {}),
      corrections: [...(Array.isArray(doc.data.corrections) ? doc.data.corrections : []), record],
    }, { updateTime: doc.updateTime }));

    /* The golfer's index, when this round counts in it. */
    const g = await fs.get(`golfers/${players[i].golferId}`);
    if (!g) refuse(`${full(players[i].name)} is no longer in The Scorecard.`);
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

/* Delete the rounds of a posted card from The Scorecard (Willy, 20 Oct 2026).
 * Same rights as correcting: the scorer for 24 hours after posting, an owner or
 * admin of every group on the card at any time.
 *
 * ONE commit, everything or nothing:
 *   - each of the card's rounds still there is deleted, only if unchanged since
 *     it was read;
 *   - each of those golfers' 20-round window is rebuilt from their remaining
 *     rounds in every group they play in (the next older round moves in), with
 *     the index and the round count;
 *   - their directory entry in every group that has one;
 *   - the submission records who deleted the rounds and when. It stays
 *     "posted", so the card becomes editable: it can be re-posted. */
export async function deleteRounds(fs, who, cardId, { now = Date.now() } = {}) {
  if (!who || who.anonymous) refuse("Sign in to delete a card's rounds.");
  const sub = await fs.get(`markerSubmissions/${String(cardId || "").slice(0, 80)}`);
  if (!sub || sub.data.status !== STATUS.POSTED || !sub.data.card) refuse("This card is not posted in The Scorecard.");
  const r = await rights(fs, who, sub, now);
  if (!r.as) refuse(sub.data.scorer === who.uid ? `The scorer can delete a card's rounds for ${CORRECT_HOURS} hours after posting it. After that, an owner or admin of the group can.` : "Only the scorer, or an owner or admin of the group, can delete this card's rounds.");
  const c = sub.data.card;
  const docs = await roundsOf(fs, sub);
  const there = c.players.map((p, i) => ({ p, doc: docs[i] })).filter((x) => x.doc);
  if (!there.length) refuse("This card's rounds were already deleted in The Scorecard.");

  const gone = new Set(there.map((x) => x.doc.id));
  const writes = there.map((x) => deleteWrite(fs, x.doc.path, { updateTime: x.doc.updateTime }));
  for (const { p } of there) {
    const g = await fs.get(`golfers/${p.golferId}`);
    if (!g) continue;   /* the golfer is gone: only the round is deleted */
    const win = Array.isArray(g.data.recentWindow) ? g.data.recentWindow : [];
    const groups = new Set([...(Array.isArray(g.data.groups) ? g.data.groups : []), ...win.map((e) => e.assocId), p.assocId]
      .filter((a) => typeof a === "string" && a));
    const fresh = [];
    let count = 0;
    for (const a of groups) {
      const rows = await fs.query(`associations/${a}`, "rounds", [["golferId", "EQUAL", g.id]], 1000);
      for (const row of rows) {
        if (gone.has(row.id)) continue;
        count++;
        const d = Number(row.data.differential);
        if (typeof row.data.date === "string" && Number.isFinite(d)) fresh.push({ roundId: row.id, date: row.data.date, differential: d, assocId: a });
      }
    }
    const window = model.mergeWindow([], fresh);
    writes.push(updateWrite(fs, g.path, { recentWindow: window, handicapIndex: model.displayIndex(window), roundCount: count }, { updateTime: g.updateTime }));
    const index = model.effectiveIndex({ ...g.data, recentWindow: window }).index;
    for (const a of new Set([...(Array.isArray(g.data.groups) ? g.data.groups : []), p.assocId])) {
      if (typeof a !== "string" || !a) continue;
      const entry = await fs.get(`associations/${a}/directory/${g.id}`);
      if (!entry) continue;
      writes.push(setWrite(fs, entry.path, { golferId: g.id, displayName: g.data.name || "", handicapIndex: index, updatedAt: now }, { updateTime: entry.updateTime }));
    }
  }
  writes.push(updateWrite(fs, sub.path, { roundsDeleted: { by: who.uid, as: r.as, golfers: there.map((x) => x.p.name || "") } }, { updateTime: sub.updateTime, now: ["roundsDeletedAt"] }));
  try { await fs.commit(writes); }
  catch (e) {
    if (e.conflict) refuse("Somebody changed one of these rounds or golfers a moment ago. Open the card again and try again.");
    throw e;
  }
  return { status: "deleted", deleted: there.map((x) => x.p.name || "") };
}
