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
import { HOURS, cleanCode, setupFrom, cleanScores } from "./caddie.js";
import * as game from "./game.js";

/* Follow codes are six digits (Willy, 31 Oct 2026: easy to type on the
   watch's number pad). A phone or watch that types about 10 wrong codes in an
   hour must wait (codes are short, and anyone with the code may follow). */
export const WRONG_PER_HOUR = 10;
const hour = (now) => new Date(now).toISOString().slice(0, 13);
async function wrongFollow(fs, who, now) {
  const at = `markerLimits/follow-${who.uid}`;
  const d = await fs.get(at);
  const used = d && d.data.hour === hour(now) ? Number(d.data.count) || 0 : 0;
  try { await fs.commit([setWrite(fs, at, { hour: hour(now), count: used + 1 }, d ? { updateTime: d.updateTime } : { exists: false })]); } catch { /* best effort */ }
}

const refuse = (why) => { throw new Refusal(why); };
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
  /* A card that is part of a Scorecard game is tagged, so the game's
     followers see it on the leaderboard (option B, Willy 31 Oct 2026). */
  const g = cardIn ? await game.gameOf(fs, who.uid, cardIn) : null;
  for (let i = 0; i < 6; i++) {
    const code = game.newDigits(rand);
    const writes = [];
    let id, expiresAt;
    if (liveId) {
      const d = await liveFor(fs, liveId);
      if (d.data.owner !== who.uid) refuse("This is not your card.");
      if (now >= d.data.expiresAt) refuse("This card is past its 12 hours.");
      const tag = g && !d.data.gameKey ? { gameKey: g.key } : {};
      if (d.data.followCode && !tag.gameKey) return { liveId: d.id, code: d.data.followCode, expiresAt: d.data.expiresAt };
      if (d.data.followCode) {
        try { await fs.commit([updateWrite(fs, d.path, tag, { updateTime: d.updateTime })]); }
        catch (e) { if (!e.conflict) throw e; continue; }
        return { liveId: d.id, code: d.data.followCode, expiresAt: d.data.expiresAt };
      }
      id = d.id; expiresAt = d.data.expiresAt;
      writes.push(updateWrite(fs, d.path, { followCode: code, ...tag }, { updateTime: d.updateTime }));
    } else {
      const setup = setupFrom(cardIn);
      id = model.newId(); expiresAt = now + HOURS * 3600_000;
      writes.push(setWrite(fs, `markerLive/${id}`, {
        owner: who.uid, cardId: String((cardIn && cardIn.id) || ""), setup,
        scores: cleanScores(Object.fromEntries((cardIn.players || []).map((p, k) => [k, (p && p.scores) || {}])), setup),
        status: "self", caddieUid: null, code: null, followCode: code, createdAt: now, expiresAt, lastAt: now,
        ...(g ? { gameKey: g.key } : {}),
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
  const lim = await fs.get(`markerLimits/follow-${who.uid}`);
  if (lim && lim.data.hour === hour(now) && Number(lim.data.count) >= WRONG_PER_HOUR) refuse("Too many wrong codes in the last hour on this device. Wait a little, then ask the golfer to read the code out again, or scan it.");
  const code = cleanCode(codeIn);
  const c = code.length === 6 ? await fs.get(`markerFollowCodes/${code}`) : null;
  if (c && c.data.kind === "game") return game.view(fs, c, { now });
  const d = c ? await fs.get(`markerLive/${c.data.liveId}`) : null;
  if (!c || !d) { await wrongFollow(fs, who, now); refuse("This follow code doesn't work. Check it, or ask the golfer for it again."); }
  if (now >= d.data.expiresAt) refuse("This follow code has stopped working (12 hours have passed).");
  return {
    kind: "card", setup: d.data.setup, scores: d.data.scores || {}, lastAt: d.data.lastAt || null,
    status: d.data.status === "finished" ? "finished" : "live",
    byCaddie: !!d.data.caddieUid, expiresAt: d.data.expiresAt, posted: d.data.posted === true,
  };
}

/* "Let others follow this game" (Willy, 31 Oct 2026): the scorer's card is
   made live (and tagged with its game) if it is not yet, then the game's one
   code of the day is handed out. Returns the card's own follow code too. */
export async function gameStart(fs, who, { card: cardIn = null, liveId = null } = {}, { now = Date.now(), rand = Math.random } = {}) {
  if (!who || who.anonymous) refuse("Sign in with your Scorecard account to let others follow.");
  if (!cardIn) refuse("The card is missing.");
  const g = await game.gameOf(fs, who.uid, cardIn);
  if (!g) refuse("This card is not part of a game in The Scorecard, or you are not a member of its group.");
  const mine = await start(fs, who, { card: cardIn, liveId }, { now, rand });
  const gc = await game.code(fs, g, { now, rand });
  return { ...mine, gameCode: gc.code, gameExpiresAt: gc.expiresAt, gameName: g.name };
}
