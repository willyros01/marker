/* search.js — course search for the app, with the key kept here.
 *
 * The golf key never reaches a phone. Searches are counted per account per
 * day (UTC): 10 for a player without an account, 100 for a member; and all
 * players without an account together stop at 300 a day. Fetching a course
 * with its holes counts as a search, and saves it in the library
 * (markerCourses/{id}) for everybody.
 */
import * as courses from "../../courses.js";
import * as W from "../../withdrawn.js";
import { setWrite, updateWrite } from "./firestore.js";
import * as check from "../../cardcheck.js";

export const LIMITS = { anon: 10, member: 100, anonTotal: 300 };
/* Reading a scorecard picture uses Cloudflare's free AI allowance (10,000
   units a day, about 350-500 a picture), so pictures have their own limits:
   20 a day in all is about 10 courses, two pictures each. */
export const SCAN_LIMITS = { anon: 2, member: 8, total: 20 };
export class LimitReached extends Error {}

const day = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/* Count one search for this caller, or throw LimitReached. */
export async function count(fs, who, { now = Date.now(), tries = 4, kind = "search" } = {}) {
  const d = day(now);
  const scan = kind === "scan";
  const mineAt = scan ? `markerLimits/scan-${who.uid}` : `markerLimits/${who.uid}`;
  const allAt = scan ? `markerLimits/scans-${d}` : `markerLimits/day-${d}`;
  const cap = scan ? (who.anonymous ? SCAN_LIMITS.anon : SCAN_LIMITS.member) : (who.anonymous ? LIMITS.anon : LIMITS.member);
  for (let i = 0; ; i++) {
    const mine = await fs.get(mineAt);
    const used = mine && mine.data.day === d ? Number(mine.data.count) || 0 : 0;
    if (used >= cap) throw new LimitReached("LIMIT");
    const writes = [setWrite(fs, mineAt, { day: d, count: used + 1, anonymous: !!who.anonymous },
      mine ? { updateTime: mine.updateTime } : { exists: false })];
    if (scan || who.anonymous) {
      const all = await fs.get(allAt);
      const total = all ? Number(all.data.count) || 0 : 0;
      if (total >= (scan ? SCAN_LIMITS.total : LIMITS.anonTotal)) throw new LimitReached("LIMIT");
      writes.push(setWrite(fs, allAt, { count: total + 1 }, all ? { updateTime: all.updateTime } : { exists: false }));
    }
    try { await fs.commit(writes); return; }
    catch (e) { if (!e.conflict || i >= tries) throw e; }
  }
}

export async function search(fs, who, query, key) {
  if (String(query || "").trim().length < 3) throw new Error("TOO_SHORT");
  await count(fs, who);
  return courses.search(query, key);
}

/* The withdrawn courses (names, tee figures, ids). Read at most every
   five minutes per worker instance. A withdrawn course has withdrawn: true. */
let withdrawnCache = null;
export async function withdrawnList(fs, { now = Date.now() } = {}) {
  if (withdrawnCache && now - withdrawnCache.at < 300_000) return withdrawnCache.list;
  const docs = await fs.query("", "courses", [["withdrawn", "EQUAL", true]], 1000);
  withdrawnCache = { at: now, list: W.summary(docs) };
  return withdrawnCache.list;
}
export const forgetWithdrawn = () => { withdrawnCache = null; };

/* Each tee marked withdrawn: true when it carries withdrawn details. */
const marked = (record, list) => ({ ...record, tees: (record.tees || []).map((t) => ({ ...t, withdrawn: W.teeWithdrawn(list, record.name, t) })) });

/* One course with every tee and hole, saved to the library. When a course of
   that name was withdrawn, the golf course database is asked again (its
   details may have been corrected since), and the library copy replaced. */
export async function course(fs, who, id, key) {
  const pid = String(id || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(pid)) throw new Error("NO_MATCH");
  const list = await withdrawnList(fs);
  let saved = await fs.get(`markerCourses/${pid}`);
  /* Replaced by a verified card: that card is the course now. */
  if (saved && saved.data.replacedBy && /^[A-Za-z0-9_-]{1,64}$/.test(saved.data.replacedBy)) {
    const better = await fs.get(`markerCourses/${saved.data.replacedBy}`);
    if (better) return marked({ ...better.data, providerId: better.id }, list);
  }
  const fromHand = !!W.scorecardIdOf(pid);
  const verified = saved && saved.data.source === "verified";
  if (saved && Array.isArray(saved.data.tees) && saved.data.tees.length && (fromHand || verified || !W.nameWithdrawn(list, saved.data.name))) {
    if (fromHand && list.some((w) => w.id === W.scorecardIdOf(pid))) {
      return marked({ ...saved.data, providerId: pid, tees: saved.data.tees.map((t) => ({ ...t, withdrawn: true })) }, []);
    }
    return marked({ ...saved.data, providerId: pid }, list);
  }
  if (fromHand) throw new Error("NO_MATCH");
  await count(fs, who);
  const c = await courses.byId(pid, key);
  const record = { providerId: pid, name: c.name, where: c.where, tees: c.tees, savedBy: who.uid };
  try {
    await fs.commit([setWrite(fs, `markerCourses/${pid}`, record,
      saved ? { updateTime: saved.updateTime, now: ["savedAt"] } : { exists: false, now: ["savedAt"] })]);
  } catch (e) { if (!e.conflict) throw e; }
  return marked(record, list);
}

/* ---------------- reading a scorecard photo ---------------- */

/* Chosen by testing four models on a real card (Royal Ontario, 16 Oct 2026):
   Qwen read every par, handicap number and yardage of a table, and did best
   on the whole page too. It costs about 350-500 of the 10,000 free units a
   day per picture, hence the limits below. Its "thinking" is switched off:
   it costs far more and read no better. */
export const SCAN_MODEL = "@cf/qwen/qwen3.8-27b";
const MAX_IMAGE = 1_500_000;   /* characters of the data address: about 1.1 MB of picture */

/* The model is asked for every number by its hole column, so a card that
   prints holes 10-18 above 1-9, or only one nine per picture, is read right.
   Tested on a real card (Royal Ontario, 16 Oct 2026): one table per picture
   read every par, handicap number and yardage correctly; a whole screenshot
   with both nines and photos around them did not. Hence the app asks for one
   table at a time, and the totals printed on the card are checked here. */
const PROMPT = `This picture shows a golf course scorecard (a photo or a screenshot, possibly with other things around it).
The scorecard table has one COLUMN per hole; the hole numbers are in the header row (often labelled HOLE). Some cards print holes 10-18 in a separate table, sometimes above holes 1-9.
Each tee is one ROW of yardages, usually named by a colour (Black, Gold, Blue, White, Red...); next to the name there may be "rating / slope", e.g. "69.7 / 130". There is a row for PAR and a row for HANDICAP (or HCP, Hdcp, S.I., Index).
Read every table and answer with JSON only, in this shape:
{"course": "<course name or empty>",
 "holes": [ { "hole": <hole number>, "par": <par>, "hcp": <handicap number>, "yards": { "<tee name>": <yards>, ... } }, ... one entry per hole column shown ],
 "tees": [ { "name": "<tee name>", "rating": <number or null>, "slope": <number or null>, "ratings": [ { "for": "<men | ladies | empty>", "rating": <number>, "slope": <number> } ], "out": <OUT total or null>, "in": <IN total or null>, "total": <TOTAL (18 holes) or null> } ],
 "parOut": <par OUT total or null>, "parIn": <par IN total or null> }
Some tees show two ratings, one for men and one for ladies, e.g. "M 63.8 / 109" and "L 68.2 / 115": list BOTH in "ratings" (for: "men" and "ladies"); a tee with one rating has one entry in "ratings".
Read each number from the column of its own hole. Use null for anything you cannot read. Never guess. Do not include OUT, IN or TOTAL columns as holes.
For holes 10-18, a tee row may not be named; it is the same tee as the row in the same position (same colour) in the holes 1-9 table; if there is no holes 1-9 table, name it by its colour.`;

const num = (v) => { const n = Number(v); return v !== null && v !== "" && Number.isFinite(n) ? n : null; };
const within = (v, lo, hi) => (v != null && v >= lo && v <= hi ? v : null);
const whole = (v, lo, hi) => { const n = num(v); return n != null && Number.isInteger(n) ? within(n, lo, hi) : null; };
const FRONT = [1, 2, 3, 4, 5, 6, 7, 8, 9], BACK = [10, 11, 12, 13, 14, 15, 16, 17, 18];
const teeKey = (name) => String(name || "").trim().toLowerCase().replace(/[^a-z]/g, "");

/* What the model said, made safe:
 *   - only believable numbers survive, nothing is invented;
 *   - holes not in the picture are simply absent (holesRead), so a second
 *     picture of the other nine can complete the course;
 *   - a nine whose pars or yards do not add up to the totals printed on the
 *     card is flagged (doubt), and so are repeated handicap numbers.
 * Returns { course, holesRead: [n...], tees: [{ name, rating, slope,
 *   holes: [18 x { par, yards, si }], doubt: { par:[n], yards:[n], si:[n] } }] }. */
export function normalizeScan(raw) {
  let r = raw;
  if (r && typeof r === "object" && !Array.isArray(r) && r.choices) r = r.choices[0] && r.choices[0].message && r.choices[0].message.content;
  if (typeof r === "string") {
    const m = r.match(/\{[\s\S]*\}/);
    try { r = JSON.parse(m ? m[0] : r); } catch { r = null; }
  }
  if (!r || typeof r !== "object") throw new Error("SCAN_UNREADABLE");
  const byHole = {};
  for (const h of Array.isArray(r.holes) ? r.holes : []) {
    const n = whole(h && h.hole, 1, 18);
    if (n != null && !byHole[n]) byHole[n] = h;
  }
  const holesRead = Object.keys(byHole).map(Number).sort((a, b) => a - b);
  if (!holesRead.length) throw new Error("SCAN_UNREADABLE");

  /* Tee names: from the tee list, then any extra names used in the yardages. */
  const named = new Map();
  for (const t of Array.isArray(r.tees) ? r.tees : []) if (t && teeKey(t.name)) named.set(teeKey(t.name), t);
  for (const n of holesRead) for (const k of Object.keys((byHole[n] && byHole[n].yards) || {})) if (teeKey(k) && !named.has(teeKey(k))) named.set(teeKey(k), { name: k });

  const pars = Array.from({ length: 18 }, (_, i) => (byHole[i + 1] ? whole(byHole[i + 1].par, 3, 6) : null));
  let si = Array.from({ length: 18 }, (_, i) => (byHole[i + 1] ? whole(byHole[i + 1].hcp, 1, 18) : null));
  const siSeen = {};
  si.forEach((v) => { if (v != null) siSeen[v] = (siSeen[v] || 0) + 1; });
  const siDoubt = si.map((v, i) => (v != null && siSeen[v] > 1 ? i + 1 : null)).filter(Boolean);

  const parDoubt = [];
  const checkSum = (holes, total, values, out) => {
    const t = num(total);
    if (t == null || !holes.every((n) => byHole[n])) return;
    const got = holes.map((n) => values[n - 1]);
    if (got.some((v) => v == null) || got.reduce((a, b) => a + b, 0) !== t) out.push(...holes);
  };
  checkSum(FRONT, r.parOut, pars, parDoubt);
  checkSum(BACK, r.parIn, pars, parDoubt);

  const tees = [...named.values()].slice(0, 8).flatMap((t) => {
    const k = teeKey(t.name);
    const yards = Array.from({ length: 18 }, (_, i) => {
      const y = (byHole[i + 1] && byHole[i + 1].yards) || {};
      const key = Object.keys(y).find((x) => teeKey(x) === k);
      return key ? whole(y[key], 50, 800) : null;
    });
    const yardDoubt = [];
    checkSum(FRONT, t.out, yards, yardDoubt);
    checkSum(BACK, t.in, yards, yardDoubt);
    const name = String(t.name || "Tee").trim().slice(0, 40) || "Tee";
    const one = (label, rating, slope) => ({
      name: label, base: teeKey(name),
      rating: within(num(rating), 55, 85),
      slope: whole(slope, 55, 155),
      out: whole(t.out, 400, 5000), in: whole(t.in, 400, 5000), total: whole(t.total, 1000, 10000),
      holes: Array.from({ length: 18 }, (_, i) => ({ par: pars[i], yards: yards[i], si: si[i] })),
      doubt: { par: parDoubt, yards: yardDoubt, si: siDoubt },
    });
    /* One coloured row with a men's and a ladies' rating is two tees with
       the same yards (Lakeview's Red: M 63.8 / 109, L 68.2 / 115). */
    const who = (f) => (/^(l|w|lad|wom|fem)/i.test(String(f || "").trim()) ? "ladies" : /^(m|men|male|gent)/i.test(String(f || "").trim()) ? "men" : "");
    const rs = (Array.isArray(t.ratings) ? t.ratings : []).filter((x) => x && within(num(x.rating), 55, 85) != null);
    const kinds = new Set(rs.map((x) => who(x.for)));
    if (rs.length >= 2 && kinds.has("men") && kinds.has("ladies")) {
      return ["men", "ladies"].map((k) => { const x = rs.find((y) => who(y.for) === k); return one(`${name} (${k})`, x.rating, x.slope); });
    }
    const single = rs.length === 1 ? rs[0] : t;
    return [one(name, t.rating ?? single.rating, t.slope ?? single.slope)];
  }).filter((t) => t.holes.some((h) => h.yards != null));
  if (!tees.length) {
    if (!pars.some((p) => p != null)) throw new Error("SCAN_UNREADABLE");
    tees.push({ name: "Tee", rating: null, slope: null, out: null, in: null, holes: pars.map((p, i) => ({ par: p, yards: null, si: si[i] })), doubt: { par: parDoubt, yards: [], si: siDoubt } });
  }
  return { course: String(r.course || "").trim().slice(0, 120), holesRead, tees, parOut: whole(r.parOut, 27, 45), parIn: whole(r.parIn, 27, 45) };
}

export async function scan(fs, who, image, ai) {
  if (!ai) throw new Error("NOT_SET_UP");
  if (typeof image !== "string" || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) throw new Error("SCAN_BAD_PHOTO");
  if (image.length > MAX_IMAGE) throw new Error("SCAN_TOO_BIG");
  await count(fs, who, { kind: "scan" });
  let out;
  try {
    out = await ai.run(SCAN_MODEL, {
      messages: [{ role: "user", content: [{ type: "text", text: PROMPT + " /no_think" }, { type: "image_url", image_url: { url: image } }] }],
      max_tokens: 6000, temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    });
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/agree|licen[cs]e/i.test(m)) throw new Error("AI_LICENCE");
    if (/limit|quota|neurons|capacity|429/i.test(m)) throw new Error("SCAN_BUSY");
    throw new Error("SCAN_FAILED");
  }
  const result = normalizeScan(out && out.response !== undefined ? out.response : out);
  /* Kept so a card can later be verified from what was READ, never from
     values a phone sends (Willy: any change by hand makes it a hand entry). */
  const scanId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  try { await fs.commit([setWrite(fs, `markerScans/${scanId}`, { uid: who.uid, anonymous: !!who.anonymous, result }, { exists: false, now: ["at"] })]); }
  catch { return result; }   /* reading still usable for the round; it just cannot be verified */
  return { ...result, scanId };
}

/* ---------------- verifying a card from its readings ---------------- */

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);

/* A signed-in scorer confirms that the readings match the club's card. The
 * worker loads ITS OWN copies of those readings, puts them together and checks
 * them (cardcheck.js). If the card is verified it replaces the course in the
 * shared list, for every tee: the copy from the golf course database (the
 * entry it was started from, `replaceId`) and any other entry of the same
 * name, which are then hidden (replacedBy). The database never overwrites a
 * verified course again (see course()). */
export async function verify(fs, who, { scanIds, replaceId = null, name = "" } = {}, { now = Date.now() } = {}) {
  if (!who || who.anonymous) throw new Error("SIGN_IN");
  const ids = Array.isArray(scanIds) ? [...new Set(scanIds.map(String))].slice(0, 6) : [];
  if (!ids.length || ids.some((id) => !/^[a-z0-9]{6,40}$/.test(id))) throw new Error("NOT_VERIFIED");
  const readings = [];
  for (const id of ids) {
    const d = await fs.get(`markerScans/${id}`);
    if (!d || d.data.uid !== who.uid) throw new Error("NOT_VERIFIED");
    const at = Date.parse(d.data.at || "");
    if (Number.isFinite(at) && now - at > 6 * 3600_000) throw new Error("NOT_VERIFIED");
    readings.push(d.data.result);
  }
  const m = check.mergeReadings(readings);
  if (String(name || "").trim()) m.course = String(name).trim().slice(0, 120);
  const v = check.verifyCard(m, { lenientYards: check.LENIENT_YARDS });
  if (!v.ok) { const e = new Error("NOT_VERIFIED"); e.problems = v.problems; throw e; }

  const id = replaceId && /^[A-Za-z0-9_-]{1,64}$/.test(String(replaceId)) ? String(replaceId) : `v-${slug(m.course)}`;
  const course = check.courseFromCard(m);
  const existing = await fs.get(`markerCourses/${id}`);
  const record = {
    providerId: id, name: course.name, where: (existing && existing.data.where) || "", tees: course.tees,
    source: "verified", verifiedBy: who.uid, scanIds: ids,
  };
  const writes = [setWrite(fs, `markerCourses/${id}`, record, { now: ["savedAt", "verifiedAt"] })];
  const all = await fs.query("", "markerCourses", [], 500);
  for (const d of all) {
    if (d.id === id || W.lower(d.data.name) !== W.lower(course.name) || d.data.replacedBy) continue;
    writes.push(updateWrite(fs, d.path, { replacedBy: id }, { updateTime: d.updateTime }));
  }
  await fs.commit(writes);
  return { ...record, providerId: id };
}
