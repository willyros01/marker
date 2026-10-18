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
      if (user && !user.anonymous) flush();
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
    /* Courses replaced by a verified card are hidden: one entry per course. */
    const list = snap.docs.map((d) => ({ ...d.data(), providerId: d.data().providerId || d.id })).filter((c) => c && c.name && Array.isArray(c.tees) && !c.replacedBy);
    list.sort((a, b) => a.name.localeCompare(b.name));
    local.save("library", list);
    return list;
  } catch {
    return local.load("library", []);
  }
}

/* ---------------- the worker: course search and posting ---------------- */

/* Its address is in markerConfig/public, written by the deploy job. Kept on
   the phone so a card can still be sent after the address was read once. */
async function workerUrl() {
  try {
    const snap = await fb.store.getDoc(ref("markerConfig", "public"));
    const url = snap.exists() ? String(snap.data().workerUrl || "") : "";
    if (/^https:\/\//.test(url)) { local.save("workerUrl", url); return url.replace(/\/+$/, ""); }
  } catch { /* fall back to the saved one */ }
  const saved = local.load("workerUrl", "");
  if (saved) return saved.replace(/\/+$/, "");
  throw new Error("NOT_SET_UP");
}

async function callWorker(path, { method = "GET", body = null } = {}) {
  if (!fb || !fb.a.currentUser) throw new Error("UNREACHABLE");
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error("OFFLINE");
  const base = await workerUrl();
  const token = await fb.a.currentUser.getIdToken();
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new Error("UNREACHABLE"); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new Error("SIGN_IN");
  if (!res.ok) throw new Error("UNREACHABLE");
  /* A refusal carries its reason in plain words. */
  if (data.error === "REFUSED") throw new Error(data.reason || "The Scorecard refused this.");
  if (data.error) throw new Error(data.error);
  return data;
}

/* Course search. The golf key stays on the worker; the phone never sees it. */
export async function searchCourses(query) {
  if (!user) throw new Error("UNREACHABLE");
  return (await callWorker(`/search?q=${encodeURIComponent(query)}`)).courses || [];
}

/* One course with all its tees and holes (the worker also keeps it in the
   library for everybody). */
export async function courseById(id) {
  if (!user) throw new Error("UNREACHABLE");
  return (await callWorker(`/course?id=${encodeURIComponent(id)}`)).course;
}

/* The withdrawn courses, kept on the phone so they are marked even with no
   signal. Every course list and the tee choice checks them. */
export async function withdrawnCourses() {
  try {
    const list = (await callWorker("/withdrawn")).courses || [];
    local.save("withdrawn", list);
    return list;
  } catch {
    return local.load("withdrawn", []);
  }
}
export const withdrawnSaved = () => local.load("withdrawn", []);

/* A photo of the club's scorecard, read by the worker (Cloudflare's AI). */
export async function scanCard(image) {
  if (!user) throw new Error("UNREACHABLE");
  return (await callWorker("/scan", { method: "POST", body: { image } })).scan;
}

/* About how many pictures can still be read today (null when unknown). */
export async function scanStatus() {
  try { return await callWorker("/scan-status"); } catch { return null; }
}

/* A signed-in scorer confirms the card: the worker checks its own copies of
   the readings and, if verified, makes it THE course for everybody. */
export async function verifyCourse({ scanIds, replaceId = null, name = "" }) {
  if (!user || user.anonymous) throw new Error("SIGN_IN");
  const r = await callWorker("/verify", { method: "POST", body: { scanIds, replaceId, name } });
  return r.course;
}

/* ---------------- posting a finished card ---------------- */

/* The phone never writes The Scorecard's own records. A finished card is
 * dropped off in markerSubmissions/{cardId}, and the worker is told; it checks
 * the card again from scratch and posts it, or refuses it with the reason.
 * The card here shows what that document says, nothing more:
 *   sent -> "Checking"; posted -> "Posted"; refused -> "Not posted" + reason. */
export function queuePost(c) {
  const queued = { ...c, state: "posting", sent: false, postError: "" };
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

/* Deletes a card kept on this phone that was never posted. Refused while the
   card is being sent, so a card can never be posted after it was deleted. */
export function deleteCard(id) {
  const c = local.finishedCards().find((x) => x.id === id);
  if (!c) return;
  if (!card.canDelete(c)) throw new Error(c.state === "posted" ? "This card is posted in The Scorecard, so it cannot be deleted here." : "The Scorecard is checking this card right now, so it cannot be deleted.");
  if (flushing && local.load("outbox", []).includes(id)) throw new Error("This card is being sent right now. Wait a moment and try again.");
  dropFromOutbox(id);
  local.dropFinished(id);
  const cur = local.currentCard();
  if (cur && cur.id === id) local.clearCurrent();
}

/* A re-posted card replaces the old one on this phone once it is posted
   (Willy, 18 Oct 2026: keep the corrected copy, not both). Only this phone's
   copy goes; the old card's rounds were already deleted in The Scorecard. */
export function dropReplaced() {
  for (const c of local.finishedCards()) {
    if (c.repostOf && c.state === "posted") { try { local.dropFinished(c.repostOf); } catch {} }
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

/* What is dropped off: the members only (guests' names stay on the phone and
   in what is shared), their hole scores, and the course as chosen. No totals
   or indexes: the worker works those out itself. */
export function submissionCard(c) {
  const members = c.players.filter((p) => !p.guest);
  return {
    id: c.id, date: c.date, holes: c.holes, start: c.start, order: c.order.slice(),
    course: { providerId: c.course.providerId || null, name: c.course.name, where: c.course.where || "" },
    tee: {
      name: c.tee.name, rating: c.tee.rating, slope: c.tee.slope, par: c.tee.par,
      holes: (c.tee.holes || []).map((h) => ({ par: h.par, yards: h.yards == null ? null : h.yards, si: h.si == null ? null : h.si })),
    },
    game: c.game ? { id: c.game.id, name: c.game.name || "", assocId: c.game.assocId } : null,
    ...(c.repostOf ? { repostOf: c.repostOf } : {}),
    players: members.map((p) => ({
      golferId: p.golferId, assocId: p.assocId, name: p.name,
      scores: Object.fromEntries(c.order.map((n) => [String(n), p.scores[n]])),
    })),
  };
}

function settle(c, status, reason) {
  if (status === "posted") { updateCard(c, { state: "posted", sent: true, postError: "", postedAt: Date.now() }); dropReplaced(); return "posted"; }
  if (status === "refused") { updateCard(c, { state: "failed", sent: true, postError: reason || "The Scorecard did not accept this card." }); return "failed"; }
  if (!c.sent) updateCard(c, { sent: true });
  return "waiting";
}

async function postOne(c) {
  const { getDoc, setDoc, serverTimestamp } = fb.store;
  const check = card.postable(c);
  if (!check.ok) { updateCard(c, { state: "failed", postError: check.why }); return "failed"; }

  /* 1. Dropped off already? (Perhaps the answer was lost.) Otherwise drop it off. */
  let status;
  try {
    const snap = await getDoc(ref("markerSubmissions", c.id));
    if (snap.exists()) {
      status = snap.data().status;
      if (status !== "sent") return settle(c, status, snap.data().reason);
    } else {
      await setDoc(ref("markerSubmissions", c.id), {
        scorer: user.uid, status: "sent", createdAt: serverTimestamp(),
        app: String(self.APP_VERSION || ""), card: submissionCard(c),
      });
    }
  } catch (e) {
    const code = String((e && e.code) || e);
    if (code.includes("permission")) {
      updateCard(c, { state: "failed", postError: "The Scorecard refused this card from your account. It is kept here; share it instead." });
      return "failed";
    }
    return "retry";
  }
  if (!c.sent) c = updateCard(c, { sent: true });

  /* 2. Wake the worker. If it cannot be reached, it finds the card by itself
        within minutes; this phone looks again on its next try. */
  try {
    const r = await callWorker("/wake", { method: "POST", body: { cardId: c.id } });
    return settle(c, r.status, r.reason);
  } catch {
    return "waiting";
  }
}

/* ---------------- correcting a posted card ---------------- */

/* The posted cards this account may correct: its own for 24 hours, and every
   card of a group it owns or runs. The worker decides, not the phone. */
export async function correctableCards() {
  if (!user || user.anonymous) throw new Error("SIGN_IN");
  return (await callWorker("/correctable", { method: "POST", body: {} })).cards || [];
}

/* Everything Your cards needs from The Scorecard: cards to correct, and
   cards whose rounds were deleted (editable: re-post or hide). */
export async function myCards() {
  if (!user || user.anonymous) throw new Error("SIGN_IN");
  const r = await callWorker("/my-cards", { method: "POST", body: {} });
  return { correctable: r.correctable || [], editable: r.editable || [] };
}

/* Takes a card with deleted rounds off the list. Nothing in The Scorecard changes. */
export async function hideEditable(cardId) {
  if (!user || user.anonymous) throw new Error("SIGN_IN");
  return callWorker("/hide-editable", { method: "POST", body: { cardId } });
}

/* One posted card, as the worker kept it, with each golfer's frozen handicap. */
export async function cardForCorrection(cardId) {
  if (!user || user.anonymous) throw new Error("SIGN_IN");
  return callWorker("/correction-card", { method: "POST", body: { cardId } });
}

/* Saved only when the worker has written everything in one commit. */
export async function saveCorrection(cardId, scores) {
  if (!user || user.anonymous) throw new Error("SIGN_IN");
  return callWorker("/correct", { method: "POST", body: { cardId, scores } });
}
