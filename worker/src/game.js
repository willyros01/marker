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
import { Refusal, checkTee, teeFor, matchCourse } from "./post.js";

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
  return { key: `${g.assocId}_${g.id}_${cardIn.date}`, name: String(gd.data.name || "").slice(0, 80), date: cardIn.date, assocId: g.assocId, id: g.id };
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
        setWrite(fs, `markerFollowCodes/${c}`, { kind: "game", gameKey: game.key, game: { name: game.name, id: game.id, assocId: game.assocId }, date: game.date, expiresAt }, { exists: false }),
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
  const all = (await fs.query("", "markerLive", [["gameKey", "EQUAL", d.gameKey]], 60))
    .sort((a, b) => (Number(a.data.createdAt) || 0) - (Number(b.data.createdAt) || 0));
  /* One card is never shown twice: if a scorer's card got two live copies,
     the newest one counts (it is the one receiving the scores). */
  const newest = new Map();
  for (const x of all) newest.set(`${x.data.owner}|${x.data.cardId || x.id}`, x);
  const live = all.filter((x) => newest.get(`${x.data.owner}|${x.data.cardId || x.id}`) === x);
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

/* ---------------- starting and joining a game in The Marker (Willy, 5 Nov 2026, option A) ----------------
 *
 * "This is cumbersome": a scorer starts the game from The Marker. It is a real
 * Scorecard game (associations/{group}/games/{id}, the same fields The
 * Scorecard writes: id, assocId, date, endDate, courseId, name, createdBy), so
 * the posted rounds land in it with its gross and net results. The course is
 * The Scorecard's own one matched by name and rating/slope, as posting does;
 * a course The Scorecard does not have yet is added in the same commit. The
 * scorer gets the game's six-number code at once; the other scorers join with
 * it, and followers use the same code. Only a member of the group may start or
 * join (The Scorecard counts a game's rounds in its own group only). */
export async function create(fs, who, { assocId, name, date, course, tee } = {}, { now = Date.now(), rand = Math.random } = {}) {
  if (!who || who.anonymous) refuse("Sign in with your Scorecard account to start a game.");
  if (!ID.test(String(assocId || ""))) refuse("Choose the group the game is for.");
  if (!isDate(date)) refuse("The round has no proper date.");
  const title = String(name || "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (title.length < 2) refuse("Give the game a name, for example Saturday Medal.");
  if (!(await fs.get(`associations/${assocId}/members/${who.uid}`))) refuse("You are not a member of that group, so you cannot start a game for it.");
  const group = await fs.get(`associations/${assocId}`);
  if (!group) refuse("That group no longer exists.");
  if (!course || !String(course.name || "").trim()) refuse("Choose the course first.");
  const t = await teeFor(fs, { course, tee });   /* the library's tee when there is one; refuses a withdrawn course */
  checkTee(t);
  const courses = await fs.query("", "courses", [], 1000);
  const matched = matchCourse(courses, String(course.name).trim(), t);
  const writes = [];
  let courseId;
  if (matched) courseId = matched.course.id;
  else {
    const made = model.buildCourse({ name: String(course.name).trim().slice(0, 120), location: String(course.where || "").slice(0, 160),
      tees: [{ name: t.name, rating: t.rating, slope: t.slope, par: t.par }], createdBy: who.uid });
    courseId = made.id;
    const { id, ...data } = made;
    writes.push(setWrite(fs, `courses/${id}`, { id, ...data, createdVia: "marker" }, { exists: false }));
  }
  const gameId = model.newId();
  const game = { id: gameId, assocId, date, endDate: null, courseId, name: title, createdBy: who.uid, createdVia: "marker" };
  writes.push(setWrite(fs, `associations/${assocId}/games/${gameId}`, game, { exists: false }));
  const key = `${assocId}_${gameId}_${date}`;
  const expiresAt = now + HOURS * 3600_000;
  for (let i = 0; i < 6; i++) {
    const c = newDigits(rand);
    try {
      await fs.commit([...writes,
        setWrite(fs, `markerFollowCodes/${c}`, { kind: "game", gameKey: key, game: { name: title, id: gameId, assocId }, date, expiresAt }, { exists: false }),
        setWrite(fs, `markerGameFollow/${key}`, { code: c, expiresAt, createdAt: now }, { exists: false }),
      ]);
      return { game: { id: gameId, assocId, name: title, groupName: String(group.data.name || "") }, date, code: c, expiresAt };
    } catch (e) {
      if (!e.conflict) throw e;   /* the code is taken: try another (nothing was written) */
    }
  }
  refuse("The game could not be started just now. Try again.");
}

/* Another scorer joins with the six-number code (the same one followers use). */
export async function join(fs, who, codeIn, { now = Date.now() } = {}) {
  if (!who || who.anonymous) refuse("Sign in with your Scorecard account to join a game.");
  const code = String(codeIn || "").replace(/[^0-9]/g, "");
  const c = code.length === 6 ? await fs.get(`markerFollowCodes/${code}`) : null;
  if (!c || c.data.kind !== "game") refuse("This is not a game code. Check it, or ask the scorer who started the game.");
  if (now >= c.data.expiresAt) refuse("This game code has stopped working (12 hours have passed).");
  /* Codes made before 5 Nov 2026, 9:15 am hold only the game's name: the game
     is read from its key "<group>_<game>_<date>" (ids have no "_"). */
  const k = /^([A-Za-z0-9-]{1,80})_([A-Za-z0-9-]{1,80})_(\d{4}-\d{2}-\d{2})$/.exec(String(c.data.gameKey || ""));
  const id = (c.data.game && c.data.game.id) || (k && k[2]);
  const assocId = (c.data.game && c.data.game.assocId) || (k && k[1]);
  const name = c.data.game && c.data.game.name;
  if (!id || !assocId || !ID.test(id) || !ID.test(assocId)) refuse("This is not a game code. Check it, or ask the scorer who started the game.");
  const gd = await fs.get(`associations/${assocId}/games/${id}`);
  if (!gd || gd.data.archived) refuse("This game no longer exists in The Scorecard.");
  const group = await fs.get(`associations/${assocId}`);
  if (!(await fs.get(`associations/${assocId}/members/${who.uid}`))) {
    refuse(`This game is for ${(group && group.data.name) || "another group"}, and you are not a member of it, so your card cannot join it. Your golfers can still be followed with their own card's code.`);
  }
  return { game: { id, assocId, name: name || gd.data.name || "", groupName: String((group && group.data.name) || "") }, date: c.data.date, code, expiresAt: c.data.expiresAt };
}
