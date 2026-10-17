/* cardcheck.js — putting the pictures of a club's scorecard together, and
 * deciding whether the result is a VERIFIED card (Willy, 16 Oct 2026).
 *
 * Shared by the app (to show the scorer what is still missing) and the worker
 * (which decides, from the readings it stored itself, never from values the
 * phone sends). Pure functions only.
 *
 * A reading (worker/src/search.js normalizeScan) covers one or both nines:
 *   { course, holesRead:[n], parOut, parIn,
 *     tees:[{ name, rating, slope, out, in, holes:[18 x {par, yards, si}] }] }
 * mergeReadings() lays later pictures over earlier ones, hole by hole, so a
 * picture of holes 10-18 completes a picture of holes 1-9, and a retaken
 * picture replaces the holes it shows.
 */

/* Yards do not affect handicaps; a card whose printed yard totals do not
   match its holes (a misprint) may still be verified when this is true.
   Decided by Willy: see the design document. */
export const LENIENT_YARDS = true;

export const teeKey = (name) => String(name || "").trim().toLowerCase().replace(/[^a-z]/g, "");
const FRONT = [1, 2, 3, 4, 5, 6, 7, 8, 9], BACK = [10, 11, 12, 13, 14, 15, 16, 17, 18];
const sum = (arr, holes) => holes.reduce((a, n) => a + (arr[n - 1] == null ? NaN : arr[n - 1]), 0);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export function mergeReadings(readings) {
  const m = { course: "", read: [], par: Array(18).fill(null), hcp: Array(18).fill(null), parOut: null, parIn: null, tees: [] };
  const byKey = new Map();
  for (const r of readings || []) {
    if (!r || !Array.isArray(r.holesRead)) continue;
    if (r.course && !m.course) m.course = r.course;
    const holes = r.holesRead.filter((n) => Number.isInteger(n) && n >= 1 && n <= 18);
    const first = r.tees && r.tees[0] && r.tees[0].holes ? r.tees[0].holes : [];
    for (const n of holes) {
      m.par[n - 1] = first[n - 1] ? first[n - 1].par : null;
      m.hcp[n - 1] = first[n - 1] ? first[n - 1].si : null;
    }
    if (holes.some((n) => n <= 9) && r.parOut != null) m.parOut = r.parOut;
    if (holes.some((n) => n >= 10) && r.parIn != null) m.parIn = r.parIn;
    for (const t of r.tees || []) {
      const k = teeKey(t.name);
      if (!k) continue;
      let tee = byKey.get(k);
      if (!tee) {
        tee = { key: k, name: t.name, rating: null, slope: null, out: null, in: null, total: null, yards: Array(18).fill(null) };
        byKey.set(k, tee);
        m.tees.push(tee);
      }
      if (t.rating != null) tee.rating = t.rating;
      if (t.slope != null) tee.slope = t.slope;
      if (holes.some((n) => n <= 9) && t.out != null) tee.out = t.out;
      if (holes.some((n) => n >= 10) && t.in != null) tee.in = t.in;
      if (t.total != null) tee.total = t.total;
      for (const n of holes) tee.yards[n - 1] = t.holes && t.holes[n - 1] ? t.holes[n - 1].yards : null;
    }
    m.read = [...new Set([...m.read, ...holes])].sort((a, b) => a - b);
  }
  /* A tee name in capitals from one picture and in plain letters from the
     other is the same tee; show it the way the first picture had it, tidied. */
  for (const t of m.tees) t.name = t.name.length > 2 && t.name === t.name.toUpperCase() ? t.name[0] + t.name.slice(1).toLowerCase() : t.name;
  return m;
}

/* Is the card complete and consistent? Stringent on purpose: every tee printed
 * on the card must be complete, not only the one being played. Returns
 *   { ok, problems: [plain words], front, back (each true when that nine's
 *     pars add up), holes: { par:[n], hcp:[n] } to mark, tees: { key: { ok, problems, yards:[n] } } } */
export function verifyCard(m, { lenientYards = false } = {}) {
  const problems = [];
  const mark = { par: [], hcp: [] };
  const missing = [...FRONT, ...BACK].filter((n) => !m.read.includes(n));
  if (missing.length) problems.push(missing.every((n) => n >= 10) ? "Holes 10 to 18 have not been read yet." : missing.every((n) => n <= 9) ? "Holes 1 to 9 have not been read yet." : `Holes ${missing.join(", ")} have not been read.`);
  if (!String(m.course || "").trim()) problems.push("The course name was not read.");

  m.par.forEach((p, i) => { if (m.read.includes(i + 1) && !(Number.isInteger(p) && p >= 3 && p <= 6)) mark.par.push(i + 1); });
  const nine = (holes, total, label) => {
    if (!holes.every((n) => m.read.includes(n))) return false;
    if (!isNum(total)) { problems.push(`The par total for ${label} was not read.`); return false; }
    if (sum(m.par, holes) !== total) { problems.push(`The pars of ${label} do not add up to ${total}.`); holes.forEach((n) => mark.par.includes(n) || mark.par.push(n)); return false; }
    return true;
  };
  const front = nine(FRONT, m.parOut, "holes 1 to 9");
  const back = nine(BACK, m.parIn, "holes 10 to 18");
  if (mark.par.length && !problems.some((p) => /pars of/.test(p))) problems.push("Some pars were not read.");

  const seen = {};
  m.hcp.forEach((h, i) => { if (m.read.includes(i + 1)) { if (!(Number.isInteger(h) && h >= 1 && h <= 18)) mark.hcp.push(i + 1); else (seen[h] = seen[h] || []).push(i + 1); } });
  Object.values(seen).filter((l) => l.length > 1).forEach((l) => l.forEach((n) => mark.hcp.push(n)));
  if (mark.hcp.length) problems.push("The handicap numbers must run from 1 to 18, each once. Some were not read or repeat.");

  const tees = {};
  if (!m.tees.length) problems.push("No tee was read.");
  for (const t of m.tees) {
    const tp = [];
    const warn = [];
    const yards = [];
    t.yards.forEach((y, i) => { if (m.read.includes(i + 1) && !(Number.isInteger(y) && y >= 50 && y <= 800)) yards.push(i + 1); });
    if (yards.length) tp.push("some yards were not read");
    /* A nine whose yards do not add up to its printed total is accepted only
       when the card's own 18-hole TOTAL proves the printed nine total wrong:
       the other nine adds up and both nines together make the TOTAL. (Royal
       Ontario's card prints Gold IN 3457; the holes add up to 3467, and the
       card's TOTAL 6786 = OUT 3319 + 3467.) */
    const fOk = isNum(t.out) && sum(t.yards, FRONT) === t.out;
    const bOk = isNum(t.in) && sum(t.yards, BACK) === t.in;
    const allOk = isNum(t.total) && sum(t.yards, [...FRONT, ...BACK]) === t.total;
    const check = (holes, total, word, ok, otherOk) => {
      if (!holes.every((n) => m.read.includes(n))) return;
      if (!isNum(total)) { tp.push(`its ${word} total was not read`); return; }
      if (ok) return;
      if (otherOk && allOk) { (tees.notes = tees.notes || []).push(`${t.name}: the card prints ${word} ${total}, but its holes add up to ${sum(t.yards, holes)}, which the card's own total ${t.total} confirms; the holes are used.`); return; }
      if (lenientYards) { warn.push(`the card prints ${word} ${total}, but its holes add up to ${sum(t.yards, holes)}`); return; }
      tp.push(`its yards do not add up to the ${word} total ${total}`); holes.forEach((n) => yards.includes(n) || yards.push(n));
    };
    check(FRONT, t.out, "OUT", fOk, bOk);
    check(BACK, t.in, "IN", bOk, fOk);
    if (!(isNum(t.rating) && t.rating >= 55 && t.rating <= 85)) tp.push("its rating was not read");
    if (!(Number.isInteger(t.slope) && t.slope >= 55 && t.slope <= 155)) tp.push("its slope was not read");
    tees[t.key] = { ok: !tp.length && m.read.length === 18, problems: tp, warnings: warn, yards: yards.sort((a, b) => a - b) };
    if (tp.length) problems.push(`${t.name}: ${tp.join(", ")}.`);
  }
  const par = sum(m.par, [...FRONT, ...BACK]);
  const notes = tees.notes || [];
  delete tees.notes;
  return {
    ok: !problems.length, problems, notes, front, back, holes: mark, tees,
    par: Number.isFinite(par) ? par : null,
  };
}

/* The course as The Marker keeps it: every tee, with its holes. */
export function courseFromCard(m, { where = "" } = {}) {
  const par = m.par.reduce((a, b) => a + (b || 0), 0);
  return {
    name: String(m.course || "").trim(),
    where,
    tees: m.tees.map((t) => ({
      name: t.name, rating: t.rating, slope: t.slope, par,
      holes: m.par.map((p, i) => ({ par: p, yards: t.yards[i], si: m.hcp[i] })),
    })),
  };
}
