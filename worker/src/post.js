/* post.js — the worker posting one finished card to The Scorecard.
 *
 * A phone drops the card into markerSubmissions/{cardId} with status "sent".
 * Here, with the service account, it is checked from scratch — nothing the
 * phone worked out is trusted: the course and tee come from the library when
 * the course is there, each golfer's index comes from the golfer record, and
 * the totals are recalculated with card.js and The Scorecard's own model.js.
 *
 * Then ONE commit writes everything or nothing:
 *   - one round per golfer (created, never overwritten), enteredAt = server time;
 *   - each golfer's 20-round window, index and round count, only if the golfer
 *     has not changed since it was read;
 *   - each golfer's directory entry (name and index) in every group that has one;
 *   - the Scorecard course, if it is new, or the tee, if the course lacks it;
 *   - the submission: "posted" with the round ids, only if still "sent".
 * A card that cannot be posted is marked "refused" with the reason in plain
 * words. Anything temporary leaves it "sent" for the next try.
 */
import * as model from "../../model.js";
import * as card from "../../card.js";
import * as W from "../../withdrawn.js";
import { setWrite, updateWrite } from "./firestore.js";
import { repostWrite } from "./correct.js";

export const STATUS = { SENT: "sent", POSTED: "posted", REFUSED: "refused" };

/* A refusal: the card is wrong, or no longer allowed; trying again won't help. */
export class Refusal extends Error {}
const refuse = (why) => { throw new Refusal(why); };

const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
/* Full names in every message: a group can have two golfers with the same first name. */
const full = (name) => String(name || "").trim() || "A golfer";
const lower = (s) => String(s || "").trim().toLowerCase();

/* ---------------- checks that need nothing but the card ---------------- */

/* The tee: real numbers a handicap can be worked out from. */
export function checkTee(tee) {
  if (!tee || typeof tee !== "object") refuse("The card has no tee.");
  const rating = Number(tee.rating), slope = Number(tee.slope), par = Number(tee.par);
  if (!(rating >= 50 && rating <= 85)) refuse("The tee's course rating is missing or not believable, so no handicap can be worked out.");
  if (!(slope >= 55 && slope <= 155)) refuse("The tee's slope is missing or not between 55 and 155.");
  if (!(Number.isInteger(par) && par >= 54 && par <= 80)) refuse("The tee's par is not believable for 18 holes.");
  const holes = Array.isArray(tee.holes) ? tee.holes : [];
  if (holes.length && holes.length !== 18) refuse("The tee does not have 18 holes.");
  const sis = [];
  for (const h of holes) {
    const p = Number(h && h.par);
    if (!(Number.isInteger(p) && p >= 3 && p <= 6)) refuse("A hole's par is not 3 to 6.");
    if (h.si != null) {
      const si = Number(h.si);
      if (!(Number.isInteger(si) && si >= 1 && si <= 18)) refuse("A hole's stroke index is not 1 to 18.");
      sis.push(si);
    }
  }
  if (sis.length === 18 && new Set(sis).size !== 18) refuse("Two holes share a stroke index.");
  return {
    name: String(tee.name || "Tee").trim().slice(0, 80) || "Tee",
    rating, slope, par,
    holes: holes.map((h) => ({ par: Number(h.par), yards: h.yards ? Number(h.yards) : null, si: h.si ? Number(h.si) : null })),
  };
}

/* The card itself, before any golfer is looked up. `today` is YYYY-MM-DD. */
export function checkCard(c, today) {
  if (!c || typeof c !== "object") refuse("The card is empty.");
  if (c.holes !== "18") refuse("The Scorecard keeps 18-hole rounds only.");
  const order = (Array.isArray(c.order) ? c.order : []).map(Number);
  if (order.length !== 18 || new Set(order).size !== 18 || order.some((n) => !(n >= 1 && n <= 18))) refuse("The card does not cover holes 1 to 18.");
  if (!isDate(c.date)) refuse("The card has no proper date.");
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  if (c.date > tomorrow) refuse("The card is dated in the future.");
  if (!c.course || !String(c.course.name || "").trim()) refuse("The card has no course name.");
  const players = Array.isArray(c.players) ? c.players : [];
  if (players.length < 1 || players.length > 4) refuse("A card holds one to four golfers.");
  const ids = new Set();
  for (const p of players) {
    if (!p || typeof p.golferId !== "string" || !p.golferId || typeof p.assocId !== "string" || !p.assocId) refuse("A golfer on the card is not from a group.");
    if (ids.has(p.golferId)) refuse(`${full(p.name)} is on the card twice.`);
    ids.add(p.golferId);
    const scores = p.scores && typeof p.scores === "object" ? p.scores : {};
    for (const n of order) {
      const s = scores[n];
      if (!(s === card.PICKED_UP || (Number.isInteger(s) && s >= 1 && s <= 20))) refuse(`${full(p.name)} has no score on hole ${n}.`);
    }
  }
  return order;
}

/* ---------------- reading what the card names ---------------- */

/* The tee to post with: the library's when the course is in it (the phone's
   copy could be old or altered), the card's own for a course typed in by hand. */
export async function teeFor(fs, c) {
  const pid = c.course && c.course.providerId ? String(c.course.providerId) : "";
  if (pid && /^[A-Za-z0-9_-]{1,64}$/.test(pid)) {
    const lib = await fs.get(`markerCourses/${pid}`);
    if (lib) {
      if (W.isWithdrawnCourse(lib.data)) refuse(withdrawnWhy(c.course.name));
      const t = (lib.data.tees || []).find((x) => lower(x.name) === lower(c.tee && c.tee.name));
      if (t) return checkTee(t);
    }
  }
  return checkTee(c.tee);
}

const withdrawnWhy = (name, teeName) =>
  `The details of ${name}${teeName ? ` (${teeName})` : ""} have been withdrawn from The Scorecard because they may be wrong, and can never be used again. Enter the course yourself from the club's scorecard, then post again. The card is kept.`;
const isWithdrawn = W.isWithdrawnCourse;

/* The Scorecard course and tee to post against. Same name (any case) and same
   rating and slope is the same tee. Withdrawn courses are never used or
   changed: when only withdrawn ones carry the name, a new course is made. */
export function matchCourse(courses, name, tee) {
  const usable = courses.filter((x) => lower(x.data.name) === lower(name) && !isWithdrawn(x.data));
  for (const x of usable) {
    const t = (x.data.tees || []).find((t) => Number(t.rating) === tee.rating && Number(t.slope) === tee.slope);
    if (t) return { course: x, teeId: t.id, addTee: null };
  }
  if (usable.length) {
    const t = { id: model.newId(), name: tee.name, rating: tee.rating, slope: tee.slope, par: tee.par };
    return { course: usable[0], teeId: t.id, addTee: t };
  }
  return null;
}

/* ---------------- the whole thing ---------------- */

/* Post the card in markerSubmissions/{cardId}. `onlyScorer` (a uid) refuses to
   act for anybody else's card (the /wake call). Returns { status, reason?, rounds? }. */
export async function processSubmission(fs, cardId, { onlyScorer = null, today = new Date().toISOString().slice(0, 10), tries = 3 } = {}) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(cardId || ""))) return { status: "unknown", reason: "No such card." };
  for (let attempt = 1; ; attempt++) {
    const sub = await fs.get(`markerSubmissions/${cardId}`);
    if (!sub) return { status: "unknown", reason: "The card has not arrived." };
    if (onlyScorer && sub.data.scorer !== onlyScorer) return { status: "unknown", reason: "No such card." };
    if (sub.data.status !== STATUS.SENT) return { status: sub.data.status, reason: sub.data.reason || "", rounds: sub.data.rounds || {} };
    try {
      const { writes, rounds } = await plan(fs, sub, today);
      await fs.commit(writes);
      return { status: STATUS.POSTED, rounds };
    } catch (e) {
      if (e instanceof Refusal) {
        try {
          await fs.commit([updateWrite(fs, sub.path, { status: STATUS.REFUSED, reason: e.message },
            { updateTime: sub.updateTime, now: ["refusedAt"] })]);
        } catch (e2) { if (!e2.conflict) throw e2; continue; }
        return { status: STATUS.REFUSED, reason: e.message };
      }
      /* Somebody else changed a golfer (or the card) between read and write:
         read everything again. */
      if (e.conflict && attempt < tries) continue;
      if (e.conflict) return { status: STATUS.SENT, reason: "Busy; it will be posted on the next try." };
      throw e;
    }
  }
}

/* Everything to write for one card, or a Refusal. Reads only. */
export async function plan(fs, sub, today) {
  const s = sub.data;
  const c = s.card;
  const scorer = s.scorer;
  const order = checkCard(c, today);

  if (await fs.get(`accountDeletions/${scorer}`)) refuse("The scorer's account is being deleted.");
  /* A card re-posted from one whose rounds were deleted in The Scorecard:
     the old card is marked in the same commit, and refused if any golfer's
     old round is still there (never counted twice). */
  const repost = c.repostOf ? await repostWrite(fs, sub, c.repostOf) : null;

  const tee = await teeFor(fs, c);
  const courses = await fs.query("", "courses", [], 1000);
  const withdrawn = W.summary(courses);
  if (W.teeWithdrawn(withdrawn, c.course.name, tee)) refuse(withdrawnWhy(c.course.name, tee.name));

  /* A course entered by hand earlier and kept in the library ("m-" + its
     Scorecard id) posts to that same course, unless it was withdrawn since. */
  const ownId = W.scorecardIdOf(c.course.providerId);
  const own = ownId ? courses.find((x) => x.id === ownId) : null;
  if (own && isWithdrawn(own.data)) refuse(withdrawnWhy(c.course.name, tee.name));
  const fromDatabase = !!c.course.providerId && !ownId;
  const matched = own ? matchCourse([own], own.data.name, tee) : matchCourse(courses, c.course.name, tee);

  const writes = [];
  let courseId, teeId;
  if (matched) {
    courseId = matched.course.id;
    teeId = matched.teeId;
    if (matched.addTee) {
      writes.push(updateWrite(fs, matched.course.path, { tees: [...(matched.course.data.tees || []), matched.addTee] },
        { updateTime: matched.course.updateTime }));
    }
  } else {
    const created = model.buildCourse({
      name: String(c.course.name).trim().slice(0, 120), location: String(c.course.where || "").slice(0, 160),
      tees: [{ name: tee.name, rating: tee.rating, slope: tee.slope, par: tee.par }], createdBy: scorer,
    });
    courseId = created.id;
    teeId = created.tees[0].id;
    const { id, ...data } = created;
    /* The Scorecard reads a course's id from inside the document, so it must be
       stored there too (a course saved without it showed up in place of every
       missing course: Willy, 18 Oct 2026). */
    writes.push(setWrite(fs, `courses/${id}`, { id, ...data, createdVia: "marker" }, { exists: false }));
    /* Entered by hand: kept in The Marker's course list too, holes and all,
       so other scorers can pick it instead of typing it again. */
    if (!fromDatabase) {
      writes.push(setWrite(fs, `markerCourses/m-${id}`, {
        providerId: `m-${id}`, name: data.name, where: data.location || "Entered by hand", manual: true,
        scorecardCourseId: id, tees: [tee], savedBy: scorer,
      }, { exists: false, now: ["savedAt"] }));
    }
  }

  /* The card as the worker sees it: trusted tee, members only, fresh indexes. */
  const players = [];
  const golfers = [];
  for (const p of c.players) {
    const who = full(p.name);
    if (!(await fs.get(`associations/${p.assocId}/members/${scorer}`))) refuse(`The scorer is not a member of ${who}'s group.`);
    const g = await fs.get(`golfers/${p.golferId}`);
    if (!g) refuse(`${who} is no longer in The Scorecard.`);
    if (g.data.archived) refuse(`${g.data.name || who} has been archived in The Scorecard.`);
    if (!(await fs.get(`associations/${p.assocId}/roster/${p.golferId}`))) refuse(`${g.data.name || who} is no longer on the group's roster.`);
    const index = model.effectiveIndex(g.data).index;
    players.push({
      name: g.data.name || p.name || "", golferId: p.golferId, assocId: p.assocId, guest: false,
      index, ch: card.courseHandicapFor(index, tee), scores: Object.fromEntries(order.map((n) => [n, p.scores[n]])),
    });
    golfers.push(g);
  }

  let game = null;
  if (c.game && typeof c.game.id === "string" && typeof c.game.assocId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(c.game.id)) {
    const gd = await fs.get(`associations/${c.game.assocId}/games/${c.game.id}`);
    if (gd && !gd.data.archived && model.gameCovers(gd.data, c.date)) game = { id: c.game.id, name: gd.data.name || "", assocId: c.game.assocId };
  }

  const trusted = {
    id: sub.id, mode: "member", date: c.date, holes: "18", start: order[0], order,
    course: { providerId: c.course.providerId || null, name: String(c.course.name).trim(), where: c.course.where || "" },
    tee, game, players,
  };

  const rounds = {};
  players.forEach((p, i) => {
    const g = golfers[i];
    const r = card.roundFor(trusted, i, { uid: scorer, courseId, teeId });
    rounds[p.golferId] = r.id;
    writes.push(setWrite(fs, `associations/${p.assocId}/rounds/${r.id}`, { ...r, enteredVia: "marker" }, { exists: false, now: ["enteredAt"] }));

    const window = model.insertIntoWindow(g.data.recentWindow, { roundId: r.id, date: r.date, differential: r.differential, assocId: p.assocId });
    writes.push(updateWrite(fs, g.path, {
      recentWindow: window, handicapIndex: model.displayIndex(window), roundCount: (Number(g.data.roundCount) || 0) + 1,
    }, { updateTime: g.updateTime }));
    g.after = { ...g.data, recentWindow: window };
  });

  /* Directory entries: name and index, in every group that lists the golfer. */
  for (const g of golfers) {
    const groups = new Set([...(Array.isArray(g.data.groups) ? g.data.groups : []), ...players.filter((p) => p.golferId === g.id).map((p) => p.assocId)]);
    for (const a of groups) {
      if (typeof a !== "string" || !a) continue;
      const entry = await fs.get(`associations/${a}/directory/${g.id}`);
      if (!entry) continue;
      writes.push(setWrite(fs, entry.path, {
        golferId: g.id, displayName: g.data.name || "", handicapIndex: model.effectiveIndex(g.after).index, updatedAt: Date.now(),
      }, { updateTime: entry.updateTime }));
    }
  }

  /* The tee the rounds were worked out with, kept for corrections (the
     phone's copy is never trusted, and the library's may change later). */
  if (repost) writes.push(repost);
  writes.push(updateWrite(fs, sub.path, { status: STATUS.POSTED, reason: "", rounds, courseId, postedTee: tee },
    { updateTime: sub.updateTime, now: ["postedAt"] }));
  return { writes, rounds };
}

/* The cron sweep: cards still waiting (their phone's /wake never got through).
   One per run by default: a card can take ~35 requests and a free-plan run
   is allowed 50. The schedule runs every 5 minutes. */
export async function sweep(fs, { limit = 1, log = () => {} } = {}) {
  const waiting = await fs.query("", "markerSubmissions", [["status", "EQUAL", STATUS.SENT]], limit);
  const out = { posted: 0, refused: 0, left: 0 };
  for (const d of waiting) {
    try {
      const r = await processSubmission(fs, d.id);
      if (r.status === STATUS.POSTED) out.posted++;
      else if (r.status === STATUS.REFUSED) out.refused++;
      else out.left++;
      log(`card ${d.id.slice(0, 4)}… ${r.status}${r.reason ? ": " + r.reason : ""}`);
    } catch (e) {
      out.left++;
      log(`card ${d.id.slice(0, 4)}… left for later: ${e.message}`);
    }
  }
  return out;
}
