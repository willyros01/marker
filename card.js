/* card.js — the scoring card, with no Firebase and no screen in it.
 *
 * Pure functions only, so every rule of play is unit tested without a browser.
 * The handicap arithmetic itself comes from The Scorecard's own model.js (a
 * copy, kept identical), so both apps always agree on a course handicap.
 */
import * as model from "./model.js";

export const PICKED_UP = "X";

/* Which holes are played, in playing order.
 *   holes: "18" | "front" | "back"; start: the first hole played (1-18).
 * An 18-hole round started on 10 goes 10..18 then 1..9. A nine started on a
 * hole outside it starts at that nine's first hole. */
export function holeOrder(holes, start) {
  const set = holes === "front" ? [1, 2, 3, 4, 5, 6, 7, 8, 9]
    : holes === "back" ? [10, 11, 12, 13, 14, 15, 16, 17, 18]
    : Array.from({ length: 18 }, (_, i) => i + 1);
  const s = set.includes(Number(start)) ? Number(start) : set[0];
  const i = set.indexOf(s);
  return [...set.slice(i), ...set.slice(0, i)];
}

/* The starting holes allowed for a choice of holes. */
export const startChoices = (holes) => holeOrder(holes, 0).slice().sort((a, b) => a - b);

/* Course handicap for a player on this tee, or null when it cannot be known
   (no index, or the tee has no rating and slope). */
export function courseHandicapFor(index, tee) {
  if (index == null || !Number.isFinite(Number(index))) return null;
  if (!tee || !Number(tee.rating) || !Number(tee.slope) || !Number(tee.par)) return null;
  return model.courseHandicap(Number(index), Number(tee.slope), Number(tee.rating), Number(tee.par));
}

/* Strokes received on a hole of stroke index si (1 = hardest), World Handicap
   System allocation over 18 holes. A plus handicap gives strokes back on the
   easiest holes. */
export function strokesOn(ch, si) {
  if (ch == null) return 0;
  /* No stroke index known (a course entered by hand without one): spread the
     strokes evenly, the fairest guess there is. */
  if (!si) return Number(ch) > 0 ? Math.round(Number(ch) / 18) : 0;
  const n = Number(ch);
  if (n >= 0) return Math.floor(n / 18) + ((n % 18) >= si ? 1 : 0);
  const give = Math.abs(n);
  return -(Math.floor(give / 18) + ((19 - si) <= (give % 18) ? 1 : 0)) || 0;
}

/* The most a hole can count for the handicap: net double bogey; without an
   index, par plus five (Rule 3.1). */
export function holeCap(par, ch, si) {
  if (ch == null) return Number(par) + 5;
  return Number(par) + 2 + strokesOn(ch, si);
}

/* What a score on a hole counts as. A picked-up hole counts as its cap. */
export function grossOn(score, cap) {
  if (score === PICKED_UP) return cap;
  return Number(score);
}

const entered = (s) => s === PICKED_UP || (Number.isInteger(s) && s >= 1 && s <= 20);

/* The hole details for a hole number on the card's tee. */
export function holeInfo(card, n) {
  const h = (card.tee.holes || [])[n - 1] || {};
  return { n, par: Number(h.par) || 4, yards: h.yards ? Number(h.yards) : null, si: h.si ? Number(h.si) : null };
}

/* Running totals for one player. */
export function totals(card, p) {
  const player = card.players[p];
  let gross = 0, adjusted = 0, toPar = 0, done = 0, pickedUp = 0;
  for (const n of card.order) {
    const s = player.scores[n];
    if (!entered(s)) continue;
    const h = holeInfo(card, n);
    const cap = holeCap(h.par, player.ch, h.si);
    const g = grossOn(s, cap);
    gross += g;
    adjusted += Math.min(g, cap);
    toPar += g - h.par;
    done++;
    if (s === PICKED_UP) pickedUp++;
  }
  const complete = done === card.order.length;
  const net = complete && player.ch != null ? gross - player.ch : null;
  return { gross, adjusted, toPar, done, pickedUp, complete, net };
}

export const formatToPar = (d) => (d === 0 ? "E" : d > 0 ? `+${d}` : `−${Math.abs(d)}`);

export const holeComplete = (card, n) => card.players.every((p) => entered(p.scores[n]));
export const cardComplete = (card) => card.order.every((n) => holeComplete(card, n));
export const isEntered = entered;

/* A new card. Each player: { name, golferId|null, assocId|null, guest, index|null }. */
export function newCard({ id = model.newId(), mode, date, course, tee, holes, start, entry, game = null, players }) {
  const order = holeOrder(holes, start);
  return {
    id, v: 1, mode, date, holes, start: order[0], entry,
    course: { providerId: course.providerId || null, name: course.name, where: course.where || "" },
    tee: {
      name: tee.name, rating: tee.rating == null ? null : Number(tee.rating),
      slope: tee.slope == null ? null : Number(tee.slope), par: Number(tee.par) || 72,
      holes: (tee.holes || []).map((h) => ({ par: Number(h.par) || 4, yards: h.yards ? Number(h.yards) : null, si: h.si ? Number(h.si) : null })),
    },
    order, pos: 0, who: 0,
    game: game ? { id: game.id, name: game.name, assocId: game.assocId } : null,
    players: players.map((p) => ({
      name: String(p.name).trim(),
      golferId: p.golferId || null,
      assocId: p.assocId || null,
      groupName: p.groupName || "",
      guest: !p.golferId,
      index: p.index == null ? null : Number(p.index),
      ch: courseHandicapFor(p.index, tee),
      scores: {},
    })),
    state: "playing",       /* playing | finished | posting | posted | failed */
    createdAt: Date.now(),
  };
}

/* Setting a score returns a new card (nothing is changed in place). */
export function setScore(card, p, n, value) {
  if (!(value === PICKED_UP || (Number.isInteger(value) && value >= 1 && value <= 20))) {
    throw new Error("A score is a whole number from 1 to 20, or picked up.");
  }
  const players = card.players.map((pl, i) => (i === p ? { ...pl, scores: { ...pl.scores, [n]: value } } : pl));
  return { ...card, players };
}

/* Can this card be posted to The Scorecard, and if not, why. */
export function postable(card) {
  const members = card.players.filter((p) => !p.guest);
  if (card.mode !== "member") return { ok: false, why: "Played without an account: the card is kept and shared, not posted." };
  if (!members.length) return { ok: false, why: "Nobody on this card is a member of a group, so there is nothing to post." };
  if (card.holes !== "18") return { ok: false, why: "The Scorecard keeps 18-hole rounds only, so a 9-hole card is shared, not posted." };
  if (!Number(card.tee.rating) || !Number(card.tee.slope)) return { ok: false, why: "This tee has no rating and slope, which a handicap needs. Share the card instead." };
  const missing = members.filter((p) => card.order.some((n) => !entered(p.scores[n])));
  if (missing.length) return { ok: false, why: `Every hole needs a score first (${missing.map((p) => p.name.split(" ")[0]).join(", ")}).` };
  return { ok: true, members };
}

/* The text sent by WhatsApp, email or text message. */
export function shareText(card) {
  const lines = [];
  const holesWord = card.holes === "18" ? "18 holes" : card.holes === "front" ? "front 9" : "back 9";
  lines.push(`${card.course.name} · ${card.tee.name} · ${card.date} · ${holesWord}`);
  if (card.game) lines.push(`Game: ${card.game.name}`);
  lines.push("");
  const sorted = card.order.slice().sort((a, b) => a - b);
  const nines = [sorted.filter((n) => n <= 9), sorted.filter((n) => n >= 10)].filter((x) => x.length);
  card.players.forEach((pl, i) => {
    const t = totals(card, i);
    const head = `${pl.name}${pl.guest ? " (guest)" : ""}: ${t.gross}` +
      (t.done ? ` (${formatToPar(t.toPar)}${t.complete ? "" : ` thru ${t.done}`})` : "") +
      (t.net != null ? `, net ${t.net}` : "");
    lines.push(head);
    for (const nine of nines) {
      const cells = nine.map((n) => {
        const s = pl.scores[n];
        return entered(s) ? String(s) : "-";
      });
      lines.push(`  ${nine[0]}-${nine[nine.length - 1]}: ${cells.join(" ")}`);
    }
  });
  lines.push("");
  lines.push("Par: " + sorted.map((n) => holeInfo(card, n).par).join(" "));
  lines.push("Scored with The Marker");
  return lines.join("\n");
}

/* The Scorecard's round for one member player, built with The Scorecard's own
   buildRound so the record is exactly what its Enter screen makes. */
export function roundFor(card, p, { uid, courseId, teeId, roundId = model.newId() }) {
  const pl = card.players[p];
  const t = totals(card, p);
  const r = model.buildRound({
    id: roundId,
    assocId: pl.assocId,
    golferId: pl.golferId,
    gameId: card.game && card.game.assocId === pl.assocId ? card.game.id : null,
    date: card.date,
    course: { id: courseId, name: card.course.name },
    tee: { id: teeId, name: card.tee.name, rating: card.tee.rating, slope: card.tee.slope, par: card.tee.par },
    gross: t.gross,
    adjusted: t.adjusted,
    notes: "Scored hole by hole with The Marker",
    enteredBy: uid,
    handicapIndexAtEntry: pl.index,
  });
  return {
    ...r,
    cardId: card.id,
    holes: card.order.slice().sort((a, b) => a - b).map((n) => {
      const s = pl.scores[n];
      return s === PICKED_UP ? "X" : s;
    }),
  };
}

/* The card record kept in Firebase (members only: guests' names stay on the
   phone and in what is shared). */
export function cardRecord(card, { uid, rounds }) {
  const members = card.players.map((p, i) => ({ p, i })).filter((x) => !x.p.guest);
  const groupOf = {};
  for (const { p } of members) groupOf[p.golferId] = p.assocId;
  return {
    scorer: uid,
    indexPending: true,
    golferIds: members.map((x) => x.p.golferId),
    groupOf,
    date: card.date,
    course: { providerId: card.course.providerId, name: card.course.name, tee: card.tee.name, rating: card.tee.rating, slope: card.tee.slope, par: card.tee.par },
    players: members.map(({ p, i }) => {
      const t = totals(card, i);
      return { golferId: p.golferId, assocId: p.assocId, name: p.name, gross: t.gross, adjusted: t.adjusted, roundId: rounds[p.golferId] };
    }),
    app: "marker",
  };
}
