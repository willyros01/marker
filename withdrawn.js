/* withdrawn.js — which course details may no longer be used.
 *
 * An administrator of The Scorecard withdraws a course whose details may be
 * wrong (Willy, 16 Oct 2026). A withdrawn course is never used or edited
 * again; it stays only because posted rounds point to it. There may be any
 * number of withdrawn versions of the same course.
 *
 * Shared by the worker and the app, so both judge a tee the same way:
 *   - a tee with the same course name and the same rating and slope (and par,
 *     when both have one) as a tee of a withdrawn course carries the withdrawn
 *     details, and is never used, whoever offers it;
 *   - anything else is new details (a corrected entry from the golf course
 *     database, or a course entered by hand) and may be used.
 * `list` is [{ id, name, tees: [{ name, rating, slope, par }] }].
 */
export const lower = (s) => String(s || "").trim().toLowerCase();

export const isWithdrawnCourse = (c) => !!c && (c.withdrawn === true || c.deleted === true || !!c.deletedAt);

export function teeWithdrawn(list, courseName, tee) {
  if (!tee) return false;
  const name = lower(courseName);
  return (list || []).some((w) => lower(w.name) === name && (w.tees || []).some((t) =>
    Number(t.rating) === Number(tee.rating) && Number(t.slope) === Number(tee.slope)
    && (!Number(t.par) || !Number(tee.par) || Number(t.par) === Number(tee.par))));
}

/* A course entered by hand and kept in The Marker's library is "m-" + the id
   of the Scorecard course made from it. */
export const scorecardIdOf = (providerId) => (/^m-/.test(String(providerId || "")) ? String(providerId).slice(2) : "");

export function nameWithdrawn(list, courseName) {
  const name = lower(courseName);
  return (list || []).some((w) => lower(w.name) === name);
}

/* What the worker hands the app: names, figures and ids only. */
export const summary = (docs) => docs.filter((d) => isWithdrawnCourse(d.data)).map((d) => ({
  id: d.id, name: d.data.name || "",
  tees: (d.data.tees || []).map((t) => ({ name: t.name || "", rating: Number(t.rating), slope: Number(t.slope), par: Number(t.par) || null })),
}));
