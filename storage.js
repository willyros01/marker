/* storage.js — what The Marker keeps on this phone.
 *
 * Every save is checked by reading it back: a save counts only once it is
 * really there (Willy's rule). A failed save throws, and the screen says so,
 * rather than carrying on with scores that exist only in memory.
 *
 * Keys are prefixed "marker:" so nothing collides with The Scorecard, which
 * runs on the same web address (willyros01.github.io).
 */
const PREFIX = "marker:";

let backend = null;
function store() {
  if (backend) return backend;
  try { backend = globalThis.localStorage; } catch { backend = null; }
  return backend;
}
/* For tests. */
export function useBackend(b) { backend = b; }

export function save(key, value) {
  const s = store();
  if (!s) throw new Error("This browser will not let The Marker save anything. Turn off private browsing and try again.");
  const text = JSON.stringify(value);
  try { s.setItem(PREFIX + key, text); }
  catch { throw new Error("The phone's storage for The Marker is full, so the score was NOT saved."); }
  if (s.getItem(PREFIX + key) !== text) throw new Error("The score could not be saved on this phone. Try again.");
}

export function load(key, fallback = null) {
  const s = store();
  if (!s) return fallback;
  try {
    const text = s.getItem(PREFIX + key);
    return text == null ? fallback : JSON.parse(text);
  } catch { return fallback; }
}

export function remove(key) {
  const s = store();
  if (!s) return;
  try { s.removeItem(PREFIX + key); } catch {}
}

/* ---------------- the card being played ---------------- */

export const currentCard = () => load("current");
export const saveCurrent = (card) => save("current", card);
export const clearCurrent = () => remove("current");

/* ---------------- finished cards (the last 30) ---------------- */

export const finishedCards = () => load("cards", []);
export function keepFinished(card) {
  const list = finishedCards().filter((c) => c.id !== card.id);
  list.unshift(card);
  save("cards", list.slice(0, 30));
}

/* ---------------- courses used recently (offline choice) ---------------- */

export const recentCourses = () => load("courses", []);
export function rememberCourse(course) {
  const key = (c) => c.providerId || `manual:${String(c.name).toLowerCase()}`;
  const list = recentCourses().filter((c) => key(c) !== key(course));
  list.unshift(course);
  save("courses", list.slice(0, 30));
}

/* ---------------- preferences ---------------- */

export const prefs = () => load("prefs", { entry: "one" });
export const savePrefs = (p) => save("prefs", { ...prefs(), ...p });
