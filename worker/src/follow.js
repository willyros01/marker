/* follow.js — the other golfers follow a card live, read-only (Willy, 29 Oct 2026, option A).
 *
 * The member who keeps the card taps "Let others follow" and gets a follow
 * code (and a QR square). Anyone with the code, account or not, sees the card
 * as it fills in, signal permitting. Followers can never change anything.
 *
 * It uses the same live card as caddie scoring (markerLive/{liveId}):
 *   - a card a caddie is scoring: the follow code is added to it, and
 *     followers see the caddie's scores;
 *   - a card the member scores: a live card is made with status "self", and
 *     the member's phone sends its scores to it.
 *   markerFollowCodes/{CODE} points at the live card.
 * The follow code stops when the live card is past its 12 hours. A finished
 * card stays readable (marked finished) until then. Every write is one commit
 * with a precondition. */
import * as model from "../../model.js";
import { setWrite, updateWrite } from "./firestore.js";
import { Refusal } from "./post.js";
import { HOURS, MAX_TRIES, cleanCode, newCode, setupFrom, cleanScores, wrongTry } from "./caddie.js";

const refuse = (why) => { throw new Refusal(why); };
const day = (now) => new Date(now).toISOString().slice(0, 10);
const OWNER_WRITES = ["self", "taken", "finished"];   /* not while a caddie is scoring ("open") */

async function liveFor(fs, liveId) {
  if (typeof liveId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(liveId)) refuse("This card is not live.");
  const d = await fs.get(`markerLive/${liveId}`);
  if (!d) refuse("This card is not live.");
  return d;
}

/* The member: a follow code for the card. With `liveId` (a caddie is scoring
   it), the code is added to that live card; otherwise a live card is made. */
export async function start(fs, who, { card: cardIn = null, liveId = null } = {}, { now = Date.now(), rand = Math.random } = {}) {
  if (!who || who.anonymous) refuse("Sign in with your Scorecard account to let others follow.");
  for (let i = 0; i < 6; i++) {
    const code = newCode(rand);
    const writes = [];
    let id, expiresAt;
    if (liveId) {
      const d = await liveFor(fs, liveId);
      if (d.data.owner !== who.uid) refuse("This is not your card.");
      if (now >= d.data.expiresAt) refuse("This card is past its 12 hours.");
      if (d.data.followCode) return { liveId: d.id, code: d.data.followCode, expiresAt: d.data.expiresAt };
      id = d.id; expiresAt = d.data.expiresAt;
      writes.push(updateWrite(fs, d.path, { followCode: code }, { updateTime: d.updateTime }));
    } else {
      const setup = setupFrom(cardIn);
      id = model.newId(); expiresAt = now + HOURS * 3600_000;
      writes.push(setWrite(fs, `markerLive/${id}`, {
        owner: who.uid, cardId: String((cardIn && cardIn.id) || ""), setup,
        scores: cleanScores(Object.fromEntries((cardIn.players || []).map((p, k) => [k, (p && p.scores) || {}])), setup),
        status: "self", caddieUid: null, code: null, followCode: code, createdAt: now, expiresAt, lastAt: now,
      }, { exists: false }));
    }
    writes.unshift(setWrite(fs, `markerFollowCodes/${code}`, { liveId: id, expiresAt }, { exists: false }));
    try {
      await fs.commit(writes);
      return { liveId: id, code, expiresAt };
    } catch (e) {
      if (!e.conflict) throw e;   /* the code is taken, or the card changed: try again */
    }
  }
  refuse("No follow code could be made just now. Try again.");
}

/* The member's phone sends its scores (the whole card each time). Not while a
   caddie is scoring: then the caddie's scores are what followers see. */
/* `posted` (Willy, 30 Oct 2026): the member has posted the round; following ends there. */
export async function scores(fs, who, { liveId, scores: raw, done = false, posted = false } = {}, { now = Date.now() } = {}) {
  for (let i = 0; i < 3; i++) {
    const d = await liveFor(fs, liveId);
    if (d.data.owner !== who.uid) refuse("This is not your card.");
    if (now >= d.data.expiresAt) refuse("EXPIRED");
    if (!OWNER_WRITES.includes(d.data.status)) refuse("CADDIE_SCORING");
    try {
      const ends = done || posted === true;
      await fs.commit([updateWrite(fs, d.path, { scores: cleanScores(raw, d.data.setup), lastAt: now, ...(ends ? { status: "finished", endedAt: now } : {}), ...(posted === true ? { posted: true, postedAt: now } : {}) }, { updateTime: d.updateTime })]);
      return { status: ends ? "finished" : d.data.status };
    } catch (e) {
      if (!e.conflict) throw e;
    }
  }
  refuse("TRY_LATER");
}

/* A follower (any sign-in, no account needed): the card as it stands. */
export async function view(fs, who, codeIn, { now = Date.now() } = {}) {
  if (!who || !who.uid) refuse("Open The Marker again and try once more.");
  const lim = await fs.get(`markerLimits/caddie-${who.uid}`);
  if (lim && lim.data.day === day(now) && Number(lim.data.count) >= MAX_TRIES) refuse("Too many wrong codes today on this phone. Ask the golfer to read the code out again, or scan it.");
  const code = cleanCode(codeIn);
  const c = code.length === 6 ? await fs.get(`markerFollowCodes/${code}`) : null;
  const d = c ? await fs.get(`markerLive/${c.data.liveId}`) : null;
  if (!c || !d) { await wrongTry(fs, who, now); refuse("This follow code doesn't work. Check it, or ask the golfer for it again."); }
  if (now >= d.data.expiresAt) refuse("This follow code has stopped working (12 hours have passed).");
  return {
    setup: d.data.setup, scores: d.data.scores || {}, lastAt: d.data.lastAt || null,
    status: d.data.status === "finished" ? "finished" : "live",
    byCaddie: !!d.data.caddieUid, expiresAt: d.data.expiresAt, posted: d.data.posted === true,
  };
}
