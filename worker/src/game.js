/* game.js — follow every card of a Scorecard game at once (Willy, 31 Oct 2026,
 * "option B": a live leaderboard for a game).
 *
 * Willy's decisions (31 Oct 2026):
 *   1. anyone with the code may follow;
 *   2. one code per game (per day: a game can last several days);
 *   3. the live leaderboard is in gross; the final tally shows gross and net,
 *      like a Game in The Scorecard, when the golfers have a handicap;
 *   4. on the Apple Watch too.
 *
 * Every card that is part of a game has a live copy (markerLive), made by the
 * scorer's phone at tee-off, tagged with gameKey = "<group>_<game>_<date>".
 * The game code (markerFollowCodes/{CODE} with kind "game") points at that
 * key; markerGameFollow/{gameKey} keeps the one code of the day, so every
 * scorer who asks gets the same code. A follower reads every live card with
 * that key: names, course handicaps and scores only, never ids.
 * Every write is one commit with a precondition (Willy's rule). */
import * as model from "../../model.js";
import { setWrite } from "./firestore.js";
import { Refusal } from "./post.js";

export const HOURS = 12;
const refuse = (why) => { throw new Refusal(why); };
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/* Six digits, never starting with 0 (easy to read out and to type on a watch). */
export function newDigits(rand = Math.random) {
  let s = String(1 + Math.floor(rand() * 9));
  for (let i = 0; i < 5; i++) s += String(Math.floor(rand() * 10) % 10);
  return s;
}

/* The game a card belongs to, checked against The Scorecard: the game exists,
   is not archived, covers the card's date, and the scorer is a member of its
   group. Null when the card is not (or no longer) part of a game. */
export async function gameOf(fs, uid, cardIn) {
  const g = cardIn && cardIn.game;
  if (!g || !ID.test(String(g.id || "")) || !ID.test(String(g.assocId || "")) || !isDate(cardIn.date)) return null;
  const gd = await fs.get(`associations/${g.assocId}/games/${g.id}`);
  if (!gd || gd.data.archived || !model.gameCovers(gd.data, cardIn.date)) return null;
  if (!(await fs.get(`associations/${g.assocId}/members/${uid}`))) return null;
  return { key: `${g.assocId}_${g.id}_${cardIn.date}`, name: String(gd.data.name || "").slice(0, 80), date: cardIn.date };
}

/* The game's follow code of the day: the existing one while it works, else a
   new one. Needs a card of the game already live (the caller makes sure). */
export async function code(fs, game, { now = Date.now(), rand = Math.random } = {}) {
  for (let i = 0; i < 6; i++) {
    const ptr = await fs.get(`markerGameFollow/${game.key}`);
    if (ptr && now < ptr.data.expiresAt) return { code: ptr.data.code, expiresAt: ptr.data.expiresAt };
    const c = newDigits(rand);
    const expiresAt = now + HOURS * 3600_000;
    try {
      await fs.commit([
        setWrite(fs, `markerFollowCodes/${c}`, { kind: "game", gameKey: game.key, game: { name: game.name }, date: game.date, expiresAt }, { exists: false }),
        setWrite(fs, `markerGameFollow/${game.key}`, { code: c, expiresAt, createdAt: now }, ptr ? { updateTime: ptr.updateTime } : { exists: false }),
      ]);
      return { code: c, expiresAt };
    } catch (e) {
      if (!e.conflict) throw e;   /* the code is taken, or another scorer made the day's code meanwhile: look again */
    }
  }
  refuse("No follow code could be made for the game just now. Try again.");
}

/* What a follower sees: every live card of the game, oldest first. */
export async function view(fs, codeDoc, { now = Date.now() } = {}) {
  const d = codeDoc.data;
  if (now >= d.expiresAt) refuse("This follow code has stopped working (12 hours have passed).");
  const live = (await fs.query("", "markerLive", [["gameKey", "EQUAL", d.gameKey]], 60))
    .sort((a, b) => (Number(a.data.createdAt) || 0) - (Number(b.data.createdAt) || 0));
  const cards = live.map((x) => ({
    setup: x.data.setup, scores: x.data.scores || {}, lastAt: x.data.lastAt || null,
    status: x.data.status === "finished" ? "finished" : "live",
    posted: x.data.posted === true, byCaddie: !!x.data.caddieUid,
  }));
  const lastAt = cards.reduce((m, c) => Math.max(m, Number(c.lastAt) || 0), 0) || null;
  const finished = cards.length > 0 && cards.every((c) => c.status === "finished");
  /* Phones and watches still on 1.0.0 know only one card: they get the first
     card of the game in the old shape, so they show something useful. */
  const first = cards[0] ? { setup: cards[0].setup, scores: cards[0].scores, status: cards[0].status, posted: cards[0].posted, byCaddie: cards[0].byCaddie } : {};
  return {
    ...first,
    kind: "game", game: { name: (d.game && d.game.name) || "" }, date: d.date || "",
    cards, lastAt, expiresAt: d.expiresAt, finished,
  };
}
