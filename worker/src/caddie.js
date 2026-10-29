/* caddie.js — a caddie scores a member's card on their own phone (Willy, 29 Oct 2026).
 *
 * The member starts the card and asks for a code. A caddie, with no account
 * (anonymous sign-in), joins with that code and enters the scores; they arrive
 * on the member's phone, and the member checks and posts the card as usual.
 * The caddie can never post, and sees only what is needed to score: the
 * course, the tee's holes and the players' names and course handicaps.
 *
 *   markerLive/{liveId}       the shared card: owner, setup, scores, status
 *   markerCaddieCodes/{CODE}  the code, pointing at the card
 *
 * Willy's choices: the caddie types the code or opens the QR link with the
 * phone's own camera; the code stops working when the member takes over or
 * the card is finished, and after 12 hours at the latest. One caddie per card.
 * Every write is one commit with a precondition (Willy's rule). */
import * as model from "../../model.js";
import * as card from "../../card.js";
import { setWrite, updateWrite } from "./firestore.js";
import { Refusal } from "./post.js";

export const HOURS = 12;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   /* no 0/O, 1/I */
export const MAX_TRIES = 20;                                   /* wrong codes a phone may try per day */
const refuse = (why) => { throw new Refusal(why); };
const day = (now) => new Date(now).toISOString().slice(0, 10);

export const cleanCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/O/g, "0").replace(/I/g, "1");
export function newCode(rand = Math.random) {
  let s = "";
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

/* Only what a caddie needs to score, never golfer or group ids. */
export function setupFrom(c) {
  if (!c || typeof c !== "object") refuse("The card is empty.");
  const order = (Array.isArray(c.order) ? c.order : []).map(Number);
  if (!order.length || order.length > 18 || order.some((n) => !(n >= 1 && n <= 18)) || new Set(order).size !== order.length) refuse("The card has no proper holes.");
  const players = Array.isArray(c.players) ? c.players : [];
  if (players.length < 1 || players.length > 4) refuse("A card holds one to four golfers.");
  const tee = c.tee || {};
  return {
    date: String(c.date || "").slice(0, 10),
    course: { name: String((c.course && c.course.name) || "").slice(0, 120) },
    tee: {
      name: String(tee.name || "").slice(0, 60), par: Number(tee.par) || 72,
      holes: (Array.isArray(tee.holes) ? tee.holes : []).slice(0, 18).map((h) => ({ par: Number(h && h.par) || 4, yards: h && h.yards ? Number(h.yards) : null, si: h && h.si ? Number(h.si) : null })),
    },
    holes: c.holes === "9" ? "9" : "18", start: order[0], order,
    players: players.map((p) => ({ name: String((p && p.name) || "").slice(0, 80), ch: p && Number.isFinite(Number(p.ch)) && p.ch !== null ? Number(p.ch) : null })),
  };
}

/* Scores from a phone: { "<player index>": { "<hole>": 1..20 | "X" } } for the card's holes only. */
export function cleanScores(raw, setup) {
  const out = {};
  setup.players.forEach((_, i) => {
    const mine = raw && typeof raw === "object" ? raw[i] || raw[String(i)] || {} : {};
    const s = {};
    for (const n of setup.order) {
      const v = mine[n] ?? mine[String(n)];
      if (v === card.PICKED_UP || (Number.isInteger(v) && v >= 1 && v <= 20)) s[String(n)] = v;
    }
    out[String(i)] = s;
  });
  return out;
}

const view = (d, now) => ({
  status: d.status === "open" && now >= d.expiresAt ? "expired" : d.status,
  joined: !!d.caddieUid, lastAt: d.lastAt || null, expiresAt: d.expiresAt,
  scores: d.scores || {},
});

/* The member asks for a code. */
export async function start(fs, who, cardIn, { now = Date.now(), rand = Math.random } = {}) {
  if (!who || who.anonymous) refuse("Sign in with your Scorecard account to let a caddie score.");
  const setup = setupFrom(cardIn);
  const liveId = model.newId();
  const expiresAt = now + HOURS * 3600_000;
  for (let i = 0; i < 6; i++) {
    const code = newCode(rand);
    try {
      await fs.commit([
        setWrite(fs, `markerCaddieCodes/${code}`, { liveId, expiresAt }, { exists: false }),
        setWrite(fs, `markerLive/${liveId}`, {
          owner: who.uid, cardId: String((cardIn && cardIn.id) || ""), setup, scores: cleanScores(Object.fromEntries((cardIn.players || []).map((p, i) => [i, (p && p.scores) || {}])), setup),
          status: "open", caddieUid: null, code, createdAt: now, expiresAt, lastAt: null,
        }, { exists: false }),
      ]);
      return { liveId, code, expiresAt };
    } catch (e) {
      if (!e.conflict) throw e;   /* that code is taken: try another */
    }
  }
  refuse("No code could be made just now. Try again.");
}

async function liveFor(fs, liveId) {
  if (typeof liveId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(liveId)) refuse("This caddie card does not exist.");
  const d = await fs.get(`markerLive/${liveId}`);
  if (!d) refuse("This caddie card does not exist.");
  return d;
}

/* The member: what the caddie has entered so far. */
export async function status(fs, who, liveId, { now = Date.now() } = {}) {
  const d = await liveFor(fs, liveId);
  if (d.data.owner !== who.uid) refuse("This is not your card.");
  return view(d.data, now);
}

/* The member takes the card back, or ends it. The code stops working at once. */
export async function stop(fs, who, liveId, { now = Date.now() } = {}) {
  const d = await liveFor(fs, liveId);
  if (d.data.owner !== who.uid) refuse("This is not your card.");
  if (d.data.status === "open") {
    await fs.commit([updateWrite(fs, d.path, { status: "taken", endedAt: now }, { updateTime: d.updateTime })]);
  }
  return view({ ...d.data, status: d.data.status === "open" ? "taken" : d.data.status }, now);
}

export async function wrongTry(fs, who, now) {
  const at = `markerLimits/caddie-${who.uid}`;
  const d = await fs.get(at);
  const used = d && d.data.day === day(now) ? Number(d.data.count) || 0 : 0;
  try { await fs.commit([setWrite(fs, at, { day: day(now), count: used + 1 }, d ? { updateTime: d.updateTime } : { exists: false })]); } catch { /* best effort */ }
}

/* The caddie joins with the code. One caddie per card: the first phone in
   keeps it (the same phone may join again, after a restart). */
export async function join(fs, who, codeIn, { now = Date.now() } = {}) {
  if (!who || !who.uid) refuse("Open The Marker again and try once more.");
  const lim = await fs.get(`markerLimits/caddie-${who.uid}`);
  if (lim && lim.data.day === day(now) && Number(lim.data.count) >= MAX_TRIES) refuse("Too many wrong codes today on this phone. Ask the golfer to read the code out again tomorrow, or scan their code.");
  const code = cleanCode(codeIn);
  const c = code.length === 6 ? await fs.get(`markerCaddieCodes/${code}`) : null;
  const d = c ? await fs.get(`markerLive/${c.data.liveId}`) : null;
  if (!c || !d) { await wrongTry(fs, who, now); refuse("This code doesn't work. Check it, or ask the golfer for a new one."); }
  if (d.data.status !== "open" || now >= d.data.expiresAt) refuse("This code has stopped working. Ask the golfer for a new one.");
  if (d.data.caddieUid && d.data.caddieUid !== who.uid) refuse("Another phone is already scoring this card. Ask the golfer for a new code.");
  if (!d.data.caddieUid) {
    await fs.commit([updateWrite(fs, d.path, { caddieUid: who.uid, joinedAt: now }, { updateTime: d.updateTime })]);
  }
  return { liveId: d.id, setup: d.data.setup, scores: d.data.scores || {}, expiresAt: d.data.expiresAt };
}

/* The caddie sends the scores entered so far (the whole card each time, so a
   send that is late or repeated does no harm). `done` hands the card back. */
export async function scores(fs, who, { liveId, scores: raw, done = false } = {}, { now = Date.now() } = {}) {
  for (let i = 0; i < 3; i++) {
    const d = await liveFor(fs, liveId);
    if (d.data.caddieUid !== who.uid) refuse("This card is not yours to score.");
    if (d.data.status === "taken") refuse("TAKEN_BACK");
    if (d.data.status === "finished") refuse("FINISHED");
    if (now >= d.data.expiresAt) refuse("EXPIRED");
    const clean = cleanScores(raw, d.data.setup);
    try {
      await fs.commit([updateWrite(fs, d.path, { scores: clean, lastAt: now, ...(done ? { status: "finished", endedAt: now } : {}) }, { updateTime: d.updateTime })]);
      return { status: done ? "finished" : "open" };
    } catch (e) {
      if (!e.conflict) throw e;   /* the member stopped it meanwhile, or a second send: read again */
    }
  }
  refuse("TRY_LATER");
}
