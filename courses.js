/* courses.js — course search at GolfCourseAPI, with the holes.
 *
 * Runs on the worker only (worker/src/search.js), where the key is a secret.
 * The app uses explain() for the messages; it never holds the key.
 *
 * Search results carry no tees; the course record fetched by id has every
 * tee with its holes: par, yardage and "handicap" (the stroke index).
 * The provider has changed shapes before, so nothing here assumes one.
 */
const BASE = "https://api.golfcourseapi.com";
const AUTH = (key) => ({ Authorization: "Key " + key });

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

function asList(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if ("course_rating" in value || "tee_name" in value || "rating" in value) return [value];
  return Object.values(value);
}

function holesFrom(raw) {
  return asList(raw).filter((h) => h && typeof h === "object").map((h) => ({
    par: num(h.par) || 4,
    yards: num(h.yardage ?? h.yards ?? h.length),
    si: num(h.handicap ?? h.stroke_index ?? h.si ?? h.hcp),
  }));
}

/* Every tee, men's and women's, with holes. A tee with no rating or slope is
   still kept (it can be scored and shared), marked so posting refuses it. */
export function teesFrom(raw) {
  const out = [];
  const add = (value, tag) => {
    for (const t of asList(value)) {
      if (!t || typeof t !== "object") continue;
      const name = String(t.tee_name ?? t.name ?? "Tee").trim() + (tag ? ` (${tag})` : "");
      const holes = holesFrom(t.holes);
      out.push({
        name,
        rating: num(t.course_rating ?? t.rating),
        slope: num(t.slope_rating ?? t.slope),
        par: num(t.par_total ?? t.par) || (holes.length ? holes.reduce((a, h) => a + h.par, 0) : 72),
        yards: num(t.total_yards),
        holes,
      });
    }
  };
  if (Array.isArray(raw)) add(raw, "");
  else if (raw && typeof raw === "object") {
    add(raw.male, "M");
    add(raw.female, "W");
    for (const [k, v] of Object.entries(raw)) {
      if (k === "male" || k === "female") continue;
      add(v, /wom|female|ladies/i.test(k) ? "W" : /men|male/i.test(k) ? "M" : "");
    }
  }
  const seen = new Set();
  return out.filter((t) => {
    const key = `${t.name}|${t.rating}|${t.slope}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function courseFrom(c) {
  const club = String(c.club_name || "").trim();
  const course = String(c.course_name || "").trim();
  const name = !course || course === club ? club || course : `${club} — ${course}`;
  const loc = c.location || {};
  const where = String(loc.address || [loc.city, loc.state, loc.country].filter(Boolean).join(", ") || "");
  return { providerId: String(c.id ?? "").trim(), name: name || "Unnamed course", where, tees: teesFrom(c.tees) };
}

async function call(url, key) {
  if (!key) throw new Error("NO_KEY");
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error("OFFLINE");
  let res;
  try { res = await fetch(url, { headers: AUTH(key) }); }
  catch { throw new Error("UNREACHABLE"); }
  if (res.status === 401 || res.status === 403) throw new Error("BAD_KEY");
  if (res.status === 429) throw new Error("RATE");
  if (res.status === 404) throw new Error("NO_MATCH");
  if (!res.ok) throw new Error("HTTP_" + res.status);
  try { return await res.json(); } catch { throw new Error("BAD_RESPONSE"); }
}

/* Names matching the words typed. Tried as typed, then without filler words. */
export async function search(query, key) {
  const raw = String(query || "").trim();
  if (raw.length < 3) throw new Error("TOO_SHORT");
  const trimmed = raw.replace(/\b(golf|club|course|country|links|and|the|&|cc|gc|g&cc)\b/gi, " ").replace(/\s+/g, " ").trim();
  const attempts = [raw];
  if (trimmed && trimmed.toLowerCase() !== raw.toLowerCase() && trimmed.length >= 3) attempts.push(trimmed);
  const seen = new Set();
  const found = [];
  let lastError = null;
  for (const q of attempts) {
    try {
      const data = await call(`${BASE}/v1/search?search_query=${encodeURIComponent(q)}`, key);
      const list = Array.isArray(data) ? data : data.courses || data.results || [];
      for (const c of list.map(courseFrom)) {
        if (!c.providerId || seen.has(c.providerId)) continue;
        seen.add(c.providerId);
        found.push(c);
      }
    } catch (e) { lastError = e; }
  }
  if (!found.length) throw lastError || new Error("NO_MATCH");
  return found.slice(0, 12);
}

/* One course with all its tees and holes. */
export async function byId(id, key) {
  const data = await call(`${BASE}/v1/courses/${encodeURIComponent(String(id))}`, key);
  const record = data && (data.course || data.data || data);
  const course = courseFrom(record || {});
  if (!course.tees.length) throw new Error("NO_TEES");
  return course;
}

export function explain(code) {
  switch (String(code && code.message ? code.message : code)) {
    case "NO_KEY":
    case "NOT_SET_UP": return "Course search is not set up yet. Enter the course yourself — it takes a minute.";
    case "SIGN_IN": return "Course search needs a moment of signal to sign in. Try again, or enter the course yourself.";
    case "TRY_LATER": return "The course search is having a problem. Try again shortly, or enter the course yourself.";
    case "TOO_SHORT": return "Type at least three letters of the course or club name.";
    case "OFFLINE": return "No signal, so search is not available. Choose a saved course, or enter one yourself.";
    case "UNREACHABLE": return "The course search could not be reached. Try again, or enter the course yourself.";
    case "BAD_KEY": return "The course search key was refused. Willy needs to check it.";
    case "RATE": return "The course search is busy or its daily limit is reached. Try later, or enter the course yourself.";
    case "NO_MATCH": return "No course matched. Try the club name, or just the town.";
    case "NO_TEES": return "That course has no tee details. Enter the course yourself.";
    case "LIMIT": return "Today's searches without an account are used up. Choose a saved course, or enter one yourself.";
    case "SCAN_LIMIT": return "Today's photo readings are used up. Type the course in below.";
    case "SCAN_BUSY": return "Photo reading has reached its free allowance for today. Type the course in below.";
    case "SCAN_UNREADABLE": return "The photo could not be read. Try again with the whole card flat, in good light and in focus, or type it in below.";
    case "SCAN_BAD_PHOTO": return "That file is not a photo the app can read. Take a picture of the card instead.";
    case "SCAN_TOO_BIG": return "That photo is too large. Take a new picture of the card.";
    case "SCAN_FAILED": return "Reading the photo did not work this time. Try again, or type the course in below.";
    case "AI_LICENCE": return "Photo reading is not switched on yet. Willy needs to finish setting it up. Type the course in below.";
    case "BAD_RESPONSE": return "The course search sent something unreadable. Try again, or enter the course yourself.";
    default: return `Course search did not work (${String(code && code.message ? code.message : code)}). Enter the course yourself.`;
  }
}
