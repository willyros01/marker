/* search.js — course search for the app, with the key kept here.
 *
 * The golf key never reaches a phone. Searches are counted per account per
 * day (UTC): 10 for a player without an account, 100 for a member; and all
 * players without an account together stop at 300 a day. Fetching a course
 * with its holes counts as a search, and saves it in the library
 * (markerCourses/{id}) for everybody.
 */
import * as courses from "../../courses.js";
import { setWrite } from "./firestore.js";

export const LIMITS = { anon: 10, member: 100, anonTotal: 300 };
export class LimitReached extends Error {}

const day = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/* Count one search for this caller, or throw LimitReached. */
export async function count(fs, who, { now = Date.now(), tries = 4 } = {}) {
  const d = day(now);
  for (let i = 0; ; i++) {
    const mine = await fs.get(`markerLimits/${who.uid}`);
    const used = mine && mine.data.day === d ? Number(mine.data.count) || 0 : 0;
    if (used >= (who.anonymous ? LIMITS.anon : LIMITS.member)) throw new LimitReached("LIMIT");
    const writes = [setWrite(fs, `markerLimits/${who.uid}`, { day: d, count: used + 1, anonymous: !!who.anonymous },
      mine ? { updateTime: mine.updateTime } : { exists: false })];
    if (who.anonymous) {
      const all = await fs.get(`markerLimits/day-${d}`);
      const total = all ? Number(all.data.count) || 0 : 0;
      if (total >= LIMITS.anonTotal) throw new LimitReached("LIMIT");
      writes.push(setWrite(fs, `markerLimits/day-${d}`, { count: total + 1 }, all ? { updateTime: all.updateTime } : { exists: false }));
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

/* One course with every tee and hole, saved to the library. */
export async function course(fs, who, id, key) {
  const pid = String(id || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(pid)) throw new Error("NO_MATCH");
  const saved = await fs.get(`markerCourses/${pid}`);
  if (saved && Array.isArray(saved.data.tees) && saved.data.tees.length) return { ...saved.data, providerId: pid };
  await count(fs, who);
  const c = await courses.byId(pid, key);
  const record = { providerId: pid, name: c.name, where: c.where, tees: c.tees, savedBy: who.uid };
  try { await fs.commit([setWrite(fs, `markerCourses/${pid}`, record, { exists: false, now: ["savedAt"] })]); }
  catch (e) { if (!e.conflict) throw e; }
  return record;
}
