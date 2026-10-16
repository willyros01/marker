/* store.js — everything The Marker does with Firebase.
 *
 * Same Firebase project as The Scorecard (scorecard-f41b8) and the same
 * bundled Firebase (10.12.0, nothing downloaded at run time). The Marker uses
 * its OWN Firebase app name, so its sign-in is kept apart from The Scorecard's
 * on the same web address: playing without an account here never signs
 * anybody out of The Scorecard.
 */
import * as model from "./model.js";
import * as card from "./card.js";
import * as local from "./storage.js";

const FIREBASE_BUNDLE = "./vendor/firebase/firebase-10.12.0.js";
const EMULATORS = (() => { try { return new URLSearchParams(location.search).has("emulators"); } catch { return false; } })();

let fb = null;
let user = null;            /* { uid, email, anonymous } */
let listeners = [];
let lastError = "";

export const onChange = (fn) => { listeners.push(fn); };
const changed = () => listeners.forEach((fn) => { try { fn(); } catch {} });
export const currentUser = () => user;
export const ready = () => !!fb;
export const lastProblem = () => lastError;

export async function init() {
  const config = await import("./firebase-config.js");
  const { app, auth, store } = await import(FIREBASE_BUNDLE);
  const firebaseConfig = EMULATORS
    ? { apiKey: "fake-api-key", projectId: "demo-marker", authDomain: "localhost", appId: "demo" }
    : config.firebaseConfig;
  const instance = app.initializeApp(firebaseConfig, "marker");
  const authInstance = auth.initializeAuth(instance, { persistence: [auth.indexedDBLocalPersistence] });
  if (EMULATORS) auth.connectAuthEmulator(authInstance, "http://127.0.0.1:9099", { disableWarnings: true });
  const db = store.getFirestore(instance);
  if (EMULATORS) store.connectFirestoreEmulator(db, "127.0.0.1", 8080);
  fb = { auth, store, a: authInstance, db };
  await new Promise((resolve) => {
    auth.onAuthStateChanged(authInstance, (u) => {
      user = u ? { uid: u.uid, email: u.email || "", anonymous: !!u.isAnonymous } : null;
      resolve();
      changed();
      if (user && !user.anonymous) { syncSearchKey(); flush(); }
    });
  });
  addEventListener("online", () => flush());
  setInterval(() => flush(), 30000);
}

const ref = (...path) => fb.store.doc(fb.db, ...path);
const col = (...path) => fb.store.collection(fb.db, ...path);

/* ---------------- signing in ---------------- */

export async function signIn(email, password) {
  try {
    await fb.auth.signInWithEmailAndPassword(fb.a, String(email).trim(), String(password));
  } catch (e) {
    const code = String((e && e.code) || e);
    if (/network/.test(code)) throw new Error("No signal. Signing in needs the internet.");
    if (/too-many/.test(code)) throw new Error("Too many attempts. Wait a few minutes, then try again.");
    throw new Error("That email and password did not match. Use the ones you sign in to The Scorecard with.");
  }
}

export async function sendReset(email) {
  await fb.auth.sendPasswordResetEmail(fb.a, String(email).trim());
}

export async function playWithoutAccount() {
  if (user && user.anonymous) return;
  if (user && !user.anonymous) await signOut();
  try { await fb.auth.signInAnonymously(fb.a); }
  catch { /* offline: the card still works with saved or hand-entered courses */ }
}

export async function signOut() {
  await fb.auth.signOut(fb.a);
  local.remove("groups");
}

/* ---------------- the scorer's groups and golfers ---------------- */

/* Every group this account is a member of, with its name and the scorer's
   role. Kept on the phone too, so choosing players works with no signal. */
export async function myGroups() {
  if (!user || user.anonymous) return [];
  const { collectionGroup, query, where, getDocs, getDoc } = fb.store;
  try {
    const found = await getDocs(query(collectionGroup(fb.db, "members"), where("uid", "==", user.uid)));
    const groups = [];
    for (const d of found.docs) {
      const assoc = d.ref.parent && d.ref.parent.parent;
      if (!assoc || assoc.parent.id !== "associations") continue;
      let name = "Group";
      try { const s = await getDoc(assoc); if (s.exists()) name = s.data().name || name; } catch {}
      groups.push({ id: assoc.id, name, role: (d.data() || {}).role || "member" });
    }
    groups.sort((a, b) => a.name.localeCompare(b.name));
    local.save("groups", { uid: user.uid, groups });
    return groups;
  } catch (e) {
    const saved = local.load("groups");
    if (saved && saved.uid === user.uid) return saved.groups;
    lastError = String((e && (e.code || e.message)) || e);
    throw new Error("Your groups could not be read. Check the signal and try again.");
  }
}

/* The golfers of one group, with their handicap index: the group's
   directory, which every member may read. */
export async function groupGolfers(assocId) {
  const key = `golfers:${assocId}`;
  try {
    const snap = await fb.store.getDocs(col("associations", assocId, "directory"));
    const list = snap.docs.map((d) => {
      const e = d.data() || {};
      const index = e.handicapIndex == null || !Number.isFinite(Number(e.handicapIndex)) ? null : Number(e.handicapIndex);
      return { golferId: d.id, name: e.displayName || "Unknown", index };
    }).sort((a, b) => a.name.localeCompare(b.name));
    local.save(key, list);
    return list;
  } catch {
    const saved = local.load(key);
    if (saved) return saved;
    throw new Error("This group's golfers could not be read. Check the signal and try again.");
  }
}

/* Games of a group that cover a date. An admin sees all of the group's games;
   a member sees the ones they created or played in. */
export async function gamesOn(group, date) {
  const { query, where, getDocs } = fb.store;
  const games = [];
  const add = (snap) => snap.forEach((d) => games.push({ ...d.data(), id: d.id, assocId: group.id }));
  try {
    if (group.role === "owner" || group.role === "admin") add(await getDocs(col("associations", group.id, "games")));
    else add(await getDocs(query(col("associations", group.id, "games"), where("createdBy", "==", user.uid))));
  } catch { return []; }
  const seen = new Set();
  return games.filter((g) => !seen.has(g.id) && seen.add(g.id) && !g.archived && model.gameCovers(g, date))
    .map((g) => ({ id: g.id, name: g.name || "Game", assocId: group.id, groupName: group.name }));
}

/* ---------------- courses with holes ---------------- */

export async function library() {
  try {
    const snap = await fb.store.getDocs(col("markerCourses"));
    const list = snap.docs.map((d) => d.data()).filter((c) => c && c.name && Array.isArray(c.tees));
    list.sort((a, b) => a.name.localeCompare(b.name));
    local.save("library", list);
    return list;
  } catch {
    return local.load("library", []);
  }
}

export async function saveCourse(course) {
  if (!course.providerId) return;
  const { getDoc, setDoc, serverTimestamp } = fb.store;
  try {
    const existing = await getDoc(ref("markerCourses", course.providerId));
    if (existing.exists()) return;
    await setDoc(ref("markerCourses", course.providerId), {
      providerId: course.providerId, name: course.name, where: course.where || "",
      tees: course.tees, savedBy: user.uid, savedAt: serverTimestamp(),
    });
  } catch { /* the card works without the shared copy */ }
}

/* The search key, fetched for ONE search and handed back; never stored.
   Without an account, each search is counted first (10 a day each, 300 a
   day for everybody); the rules let the key be read only right after. */
export async function searchKey() {
  if (!user) throw new Error("UNREACHABLE");
  const { getDoc, writeBatch, serverTimestamp } = fb.store;
  if (user.anonymous) {
    const day = String(Math.floor(Date.now() / 86400000));
    try {
      const mine = await getDoc(ref("anonSearch", user.uid));
      const all = await getDoc(ref("anonSearchDays", day));
      const used = mine.exists() && mine.data().day === day ? Number(mine.data().count) || 0 : 0;
      const total = all.exists() ? Number(all.data().count) || 0 : 0;
      if (used >= 10 || total >= 300) throw new Error("LIMIT");
      const b = writeBatch(fb.db);
      b.set(ref("anonSearch", user.uid), { day, count: used + 1, at: serverTimestamp() });
      b.set(ref("anonSearchDays", day), { count: total + 1, lastAt: serverTimestamp() });
      await b.commit();
    } catch (e) {
      if (e && e.message === "LIMIT") throw e;
      if (String(e && e.code).includes("permission")) throw new Error("LIMIT");
      throw new Error("UNREACHABLE");
    }
  }
  try {
    const snap = await getDoc(ref("lookup", "courseSearch"));
    const key = snap.exists() ? String(snap.data().key || "") : "";
    if (key) return key;
  } catch { /* fall through */ }
  if (!user.anonymous) {
    /* Not shared yet: a member's own group carries The Scorecard's key. */
    for (const g of local.load("groups", { groups: [] }).groups || []) {
      try {
        const s = await getDoc(ref("associations", g.id));
        const key = s.exists() ? String(s.data().lookupKey || "") : "";
        if (key) return key;
      } catch {}
    }
  }
  throw new Error("NO_KEY");
}

/* Willy's account keeps the shared key in step with The Scorecard's, so
   players without an account can search too. Quiet when anything fails. */
async function syncSearchKey() {
  try {
    const { getDoc, setDoc, serverTimestamp } = fb.store;
    const creator = await getDoc(ref("groupCreators", user.uid));
    if (!creator.exists()) return;
    const groups = await myGroups();
    let key = "";
    for (const g of groups) {
      const s = await getDoc(ref("associations", g.id));
      if (s.exists() && s.data().lookupKey) { key = String(s.data().lookupKey); break; }
    }
    if (!key) return;
    const now = await getDoc(ref("lookup", "courseSearch"));
    if (now.exists() && now.data().key === key) return;
    await setDoc(ref("lookup", "courseSearch"), { key, updatedAt: serverTimestamp() });
  } catch { /* not Willy, or no signal */ }
}

/* ---------------- posting a finished card ---------------- */

/* Queues the card for posting. The writes are built when there is signal,
   because they need The Scorecard's course list and rosters. */
export function queuePost(c) {
  const roundIds = {};
  for (const p of c.players) if (!p.guest) roundIds[p.golferId] = model.newId();
  const queued = { ...c, state: "posting", roundIds, postError: "" };
  local.saveCurrent(queued);
  local.keepFinished(queued);
  const outbox = local.load("outbox", []).filter((id) => id !== c.id);
  outbox.push(c.id);
  local.save("outbox", outbox);
  flush();
  return queued;
}

export const waitingToPost = () => local.load("outbox", []).length;

let flushing = false;
export async function flush() {
  if (!fb || flushing || !user || user.anonymous) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const outbox = local.load("outbox", []);
  if (!outbox.length) return;
  flushing = true;
  try {
    for (const id of outbox) {
      const c = local.finishedCards().find((x) => x.id === id);
      if (!c) { dropFromOutbox(id); continue; }
      const result = await postOne(c);
      if (result === "posted" || result === "failed") dropFromOutbox(id);
      if (result === "retry") break;
    }
  } finally {
    flushing = false;
    changed();
  }
}

function dropFromOutbox(id) {
  local.save("outbox", local.load("outbox", []).filter((x) => x !== id));
}

function updateCard(c, patch) {
  const next = { ...c, ...patch };
  local.keepFinished(next);
  const cur = local.currentCard();
  if (cur && cur.id === c.id) local.saveCurrent(next);
  return next;
}

/* The Scorecard's course and tee for this card: the course with the same name
   and a tee with the same rating and slope; failing that, a new course entry
   written in the same batch. */
async function scorecardCourse(c) {
  const snap = await fb.store.getDocs(col("courses"));
  const want = String(c.course.name).trim().toLowerCase();
  const courses = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  const same = courses.filter((x) => String(x.name || "").trim().toLowerCase() === want);
  for (const x of same) {
    const t = (x.tees || []).find((t) => Number(t.rating) === Number(c.tee.rating) && Number(t.slope) === Number(c.tee.slope));
    if (t) return { courseId: x.id, teeId: t.id, create: null };
  }
  if (same.length) return { courseId: same[0].id, teeId: model.newId(), create: null };
  const created = model.buildCourse({
    name: c.course.name, location: c.course.where || "",
    tees: [{ name: c.tee.name, rating: c.tee.rating, slope: c.tee.slope, par: c.tee.par }],
    createdBy: user.uid,
  });
  return { courseId: created.id, teeId: created.tees[0].id, create: created };
}

async function postOne(c) {
  const { getDoc, writeBatch, serverTimestamp } = fb.store;
  const check = card.postable(c);
  if (!check.ok) { updateCard(c, { state: "failed", postError: check.why }); return "failed"; }

  /* Already there? (An earlier attempt landed but its answer was lost.) */
  try {
    const existing = await getDoc(ref("cards", c.id));
    if (existing.exists()) { updateCard(c, { state: "posted", postError: "", postedAt: Date.now() }); return "posted"; }
  } catch (e) {
    if (!String(e && e.code).includes("permission")) return "retry";
  }

  let target;
  try {
    target = await scorecardCourse(c);
    for (const p of c.players) {
      if (p.guest) continue;
      const onRoster = await getDoc(ref("associations", p.assocId, "roster", p.golferId));
      if (!onRoster.exists()) {
        updateCard(c, { state: "failed", postError: `${p.name} is no longer on the roster of ${p.groupName || "their group"}, so the card cannot be posted. Share it instead, or ask an admin.` });
        return "failed";
      }
    }
  } catch {
    return "retry";
  }

  const b = writeBatch(fb.db);
  if (target.create) b.set(ref("courses", target.create.id), target.create);
  const rounds = {};
  c.players.forEach((p, i) => {
    if (p.guest) return;
    const r = card.roundFor(c, i, { uid: user.uid, courseId: target.courseId, teeId: target.teeId, roundId: c.roundIds[p.golferId] });
    rounds[p.golferId] = r.id;
    b.set(ref("associations", p.assocId, "rounds", r.id), { ...r, enteredAt: serverTimestamp() });
  });
  b.set(ref("cards", c.id), { ...card.cardRecord(c, { uid: user.uid, rounds }), createdAt: serverTimestamp() });

  try {
    await b.commit();
    updateCard(c, { state: "posted", postError: "", postedAt: Date.now() });
    return "posted";
  } catch (e) {
    const code = String((e && e.code) || e);
    if (code.includes("permission")) {
      updateCard(c, { state: "failed", postError: "The Scorecard refused this card. You may no longer be a member of one of these groups. The card is kept here; share it instead." });
      return "failed";
    }
    return "retry";
  }
}
