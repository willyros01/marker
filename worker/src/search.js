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
import { setWrite } from "./firestore.js";

export const LIMITS = { anon: 10, member: 100, anonTotal: 300 };
/* Reading a scorecard photo uses Cloudflare's free AI allowance (10,000 units
   a day, about 150-250 a photo), so photos have their own, smaller limits. */
export const SCAN_LIMITS = { anon: 3, member: 10, total: 40 };
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
  const saved = await fs.get(`markerCourses/${pid}`);
  const fromHand = !!W.scorecardIdOf(pid);
  if (saved && Array.isArray(saved.data.tees) && saved.data.tees.length && (fromHand || !W.nameWithdrawn(list, saved.data.name))) {
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

export const SCAN_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const MAX_IMAGE = 1_500_000;   /* characters of the data address: about 1.1 MB of picture */

const SCAN_SCHEMA = {
  type: "object",
  properties: {
    course: { type: "string" },
    tees: { type: "array", items: { type: "object", properties: {
      name: { type: "string" }, rating: { type: ["number", "null"] }, slope: { type: ["number", "null"] },
      pars: { type: "array", items: { type: ["number", "null"] } },
      yards: { type: "array", items: { type: ["number", "null"] } },
      si: { type: "array", items: { type: ["number", "null"] } },
    }, required: ["name", "pars"] } },
    si: { type: "array", items: { type: ["number", "null"] } },
    pars: { type: "array", items: { type: ["number", "null"] } },
  },
  required: ["tees"],
};

const PROMPT = `This is a photo of a golf course scorecard. Read it and answer with JSON only.
- "course": the course or club name printed on the card, or "" if none.
- "tees": one entry per tee (row of yardages), with "name" (the tee name or colour), "rating" and "slope" if printed for that tee (else null), "yards" (18 numbers, hole 1 to 18), and "pars" and "si" if that tee has its own par or handicap row (else empty arrays).
- "pars": the par of holes 1 to 18 (18 numbers), from the row marked Par.
- "si": the stroke index of holes 1 to 18 (18 numbers), from the row marked Handicap, HCP, Hdcp, S.I. or Index.
Use null for anything you cannot read. Never guess a number. Leave out totals (Out, In, Total).`;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const within = (v, lo, hi) => (v != null && v >= lo && v <= hi ? v : null);
const eighteen = (arr, lo, hi, whole = true) => {
  const a = Array.isArray(arr) ? arr.map(num) : [];
  if (a.length < 18) return null;
  const out = a.slice(0, 18).map((v) => within(whole && v != null ? Math.round(v) : v, lo, hi));
  return out;
};

/* What the model said, made safe: only believable numbers survive, anything
   else is left empty for the scorer to fill in. Never invents a value. */
export function normalizeScan(raw) {
  let r = raw;
  if (typeof r === "string") {
    const m = r.match(/\{[\s\S]*\}/);
    try { r = JSON.parse(m ? m[0] : r); } catch { r = null; }
  }
  if (!r || typeof r !== "object") throw new Error("SCAN_UNREADABLE");
  const pars = eighteen(r.pars, 3, 6);
  let si = eighteen(r.si, 1, 18);
  if (si && si.every((v) => v != null) && new Set(si).size !== 18) si = null;   /* a misread: two holes the same */
  const tees = (Array.isArray(r.tees) ? r.tees : []).slice(0, 8).map((t) => {
    const tp = eighteen(t && t.pars, 3, 6) || pars;
    let ts = eighteen(t && t.si, 1, 18) || si;
    if (ts && ts.every((v) => v != null) && new Set(ts).size !== 18) ts = null;
    const yards = eighteen(t && t.yards, 50, 800) || Array(18).fill(null);
    return {
      name: String((t && t.name) || "Tee").trim().slice(0, 40) || "Tee",
      rating: within(num(t && t.rating), 55, 85),
      slope: within(num(t && t.slope) == null ? null : Math.round(num(t.slope)), 55, 155),
      holes: Array.from({ length: 18 }, (_, i) => ({ par: tp ? tp[i] : null, yards: yards[i], si: ts ? ts[i] : null })),
    };
  }).filter((t) => t.holes.some((h) => h.par != null || h.yards != null));
  if (!tees.length && pars) tees.push({ name: "Tee", rating: null, slope: null, holes: pars.map((p, i) => ({ par: p, yards: null, si: si ? si[i] : null })) });
  if (!tees.length) throw new Error("SCAN_UNREADABLE");
  return { course: String(r.course || "").trim().slice(0, 120), tees };
}

export async function scan(fs, who, image, ai) {
  if (!ai) throw new Error("NOT_SET_UP");
  if (typeof image !== "string" || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) throw new Error("SCAN_BAD_PHOTO");
  if (image.length > MAX_IMAGE) throw new Error("SCAN_TOO_BIG");
  await count(fs, who, { kind: "scan" });
  let out;
  try {
    out = await ai.run(SCAN_MODEL, {
      messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: image } }] }],
      max_tokens: 2500, temperature: 0,
      response_format: { type: "json_schema", json_schema: SCAN_SCHEMA },
    });
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/agree|licen[cs]e/i.test(m)) throw new Error("AI_LICENCE");
    if (/limit|quota|neurons|capacity|429/i.test(m)) throw new Error("SCAN_BUSY");
    throw new Error("SCAN_FAILED");
  }
  return normalizeScan(out && (out.response !== undefined ? out.response : out));
}
