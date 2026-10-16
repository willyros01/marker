/* The Marker — rules tests against the Firebase emulator.
 *
 * Runs in GitHub Actions only (firebase emulators:exec). Nothing live is
 * touched. Each test names what it proves; a failure says which rule broke.
 *
 * Covers the four small additions (markerSubmissions, markerCourses,
 * markerConfig, markerLimits) AND checks that The Scorecard's own behaviour
 * is unchanged: no phone can post anybody else's round, and none of the
 * 0.1.0 openings (cards, lookup, anonymous counters) exist any more.
 */
import { readFileSync } from "node:fs";
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from "@firebase/rules-unit-testing";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, collection, getDocs, Timestamp,
} from "firebase/firestore";

let env;

/* Accounts. A real Scorecard account has an email on its token. */
const OWNER = "owner1", ADMIN = "admin1", MEMBER = "member1", OTHER = "other1", ANON = "anon1", ANON2 = "anon2";
const real = (uid) => env.authenticatedContext(uid, { email: `${uid}@example.com`, email_verified: true, firebase: { sign_in_provider: "password" } }).firestore();
const anon = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: "anonymous" } }).firestore();

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-marker",
    firestore: { rules: readFileSync("firebase/firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
after(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    /* Two groups. MEMBER is a regular member of both; OTHER only of G2. */
    for (const g of ["G1", "G2", "G3"]) await setDoc(doc(db, "associations", g), { name: g, ownerUid: OWNER });
    await setDoc(doc(db, "associations/G1/members", OWNER), { uid: OWNER, role: "owner" });
    await setDoc(doc(db, "associations/G1/members", ADMIN), { uid: ADMIN, role: "admin" });
    await setDoc(doc(db, "associations/G1/members", MEMBER), { uid: MEMBER, role: "member" });
    await setDoc(doc(db, "associations/G2/members", MEMBER), { uid: MEMBER, role: "member" });
    await setDoc(doc(db, "associations/G2/members", OTHER), { uid: OTHER, role: "member" });
    /* Golfers: A, B on G1's roster; C on G2's; D on G3's (a group MEMBER is not in). */
    for (const [g, assoc, linked] of [["A", "G1", MEMBER], ["B", "G1", null], ["C", "G2", OTHER], ["D", "G3", null]]) {
      await setDoc(doc(db, "golfers", g), { name: g, linkedUid: linked, groups: [assoc], recentWindow: [], roundCount: 0 });
      await setDoc(doc(db, `associations/${assoc}/roster`, g), { golferId: g });
    }
    await setDoc(doc(db, "groupCreators", OWNER), { at: 1 });
    await setDoc(doc(db, "markerCourses", "123"), { name: "Royal Ontario", tees: [] });
    await setDoc(doc(db, "markerConfig", "public"), { workerUrl: "https://marker.example.workers.dev" });
    await setDoc(doc(db, "markerLimits", "u1"), { day: "1", count: 1 });
    await setDoc(doc(db, "courses", "X"), { name: "X", tees: [], createdBy: OWNER });
  });
});

/* A finished card as the app drops it off. */
const sub = (uid, n = 2, extra = {}) => ({
  scorer: uid, status: "sent", createdAt: serverTimestamp(), app: "0.2.0",
  card: { id: "c1", date: "2026-10-16", courseId: "123", teeId: "t",
          players: Array.from({ length: n }, (_, i) => ({ golferId: "AB"[i % 2] || "A", assocId: "G1", scores: [] })) },
  ...extra,
});
const put = (db, id, data) => setDoc(doc(db, "markerSubmissions", id), data);

/* ---------------- markerSubmissions: the drop-off ---------------- */

test("N1 a real account drops off its own card", async () => {
  await assertSucceeds(put(real(MEMBER), "c1", sub(MEMBER)));
});

test("N2 a card naming somebody else as the scorer is refused", async () => {
  await assertFails(put(real(MEMBER), "c1", sub(OTHER)));
});

test("N3 an anonymous player cannot drop off a card", async () => {
  await assertFails(put(anon(ANON), "c1", sub(ANON)));
});

test("N4 only status 'sent' and the server's own time are accepted", async () => {
  await assertFails(put(real(MEMBER), "c1", sub(MEMBER, 2, { status: "posted" })));
  await assertFails(put(real(MEMBER), "c1", sub(MEMBER, 2, { createdAt: Timestamp.fromMillis(1) })));
});

test("N5 one to four golfers only, and no extra fields", async () => {
  await assertFails(put(real(MEMBER), "c1", sub(MEMBER, 5)));
  await assertFails(put(real(MEMBER), "c1", sub(MEMBER, 0)));
  await assertFails(put(real(MEMBER), "c1", sub(MEMBER, 2, { postedRounds: ["x"] })));
  await assertSucceeds(put(real(MEMBER), "c4", sub(MEMBER, 4)));
});

test("N6 a card can never be changed, replaced or deleted from a phone", async () => {
  await assertSucceeds(put(real(MEMBER), "c1", sub(MEMBER)));
  await assertFails(updateDoc(doc(real(MEMBER), "markerSubmissions", "c1"), { status: "posted" }));
  await assertFails(put(real(MEMBER), "c1", sub(MEMBER)));
  await assertFails(deleteDoc(doc(real(MEMBER), "markerSubmissions", "c1")));
});

test("N7 only the scorer reads a card; 'not there' is an answer; nobody lists them", async () => {
  await assertSucceeds(put(real(MEMBER), "c1", sub(MEMBER)));
  await assertSucceeds(getDoc(doc(real(MEMBER), "markerSubmissions", "c1")));
  await assertFails(getDoc(doc(real(OTHER), "markerSubmissions", "c1")));
  await assertFails(getDoc(doc(real(OWNER), "markerSubmissions", "c1")));
  await assertSucceeds(getDoc(doc(real(OTHER), "markerSubmissions", "nothing-here")));
  await assertFails(getDocs(collection(real(MEMBER), "markerSubmissions")));
});

test("N8 an account that asked to be deleted cannot drop off a card", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "accountDeletions", MEMBER), { at: 1 });
  });
  await assertFails(put(real(MEMBER), "c1", sub(MEMBER)));
});

/* ---------------- courses, config, limits ---------------- */

test("C1 any sign-in reads Marker courses; nobody writes them from a phone", async () => {
  await assertSucceeds(getDocs(collection(anon(ANON), "markerCourses")));
  await assertSucceeds(getDoc(doc(real(MEMBER), "markerCourses", "123")));
  await assertFails(setDoc(doc(anon(ANON), "markerCourses", "124"), { name: "x" }));
  await assertFails(setDoc(doc(real(OWNER), "markerCourses", "123"), { name: "x" }));
  await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(), "markerCourses")));
});

test("C2 the worker's address is readable by any sign-in, writable by none", async () => {
  await assertSucceeds(getDoc(doc(anon(ANON), "markerConfig", "public")));
  await assertFails(setDoc(doc(real(OWNER), "markerConfig", "public"), { workerUrl: "https://evil.example" }));
});

test("C3 search limits are the worker's alone", async () => {
  await assertFails(getDoc(doc(anon(ANON), "markerLimits", "u1")));
  await assertFails(setDoc(doc(real(OWNER), "markerLimits", "u1"), { count: 0 }));
});

/* ---------------- The Scorecard unchanged ---------------- */

const round = (uid, assocId, golferId) => ({
  id: `r-${golferId}`, assocId, golferId, gameId: null, date: "2026-10-16",
  courseId: "X", courseName: "X", teeId: "t", teeName: "White", rating: 70, slope: 120, par: 72,
  gross: 90, adjusted: 88, differential: 16.9, courseHandicap: null, indexAtEntry: null,
  notes: "", enteredBy: uid, enteredAt: serverTimestamp(),
});

test("S1 an admin still posts for anybody, a member for themselves", async () => {
  await assertSucceeds(setDoc(doc(real(ADMIN), "associations/G1/rounds", "r-B"), round(ADMIN, "G1", "B")));
  await assertSucceeds(setDoc(doc(real(MEMBER), "associations/G1/rounds", "r-A"), round(MEMBER, "G1", "A")));
});

test("S2 a regular member still cannot post somebody else's round, with or without a card id", async () => {
  await assertFails(setDoc(doc(real(MEMBER), "associations/G1/rounds", "r-B"), round(MEMBER, "G1", "B")));
  await assertFails(setDoc(doc(real(MEMBER), "associations/G1/rounds", "r-B"), { ...round(MEMBER, "G1", "B"), cardId: "c1" }));
});

test("S3 the 0.1.0 openings are gone: cards, lookup, anonymous counters", async () => {
  await assertFails(setDoc(doc(real(MEMBER), "cards", "c1"), { scorer: MEMBER }));
  await assertFails(getDoc(doc(anon(ANON), "lookup", "courseSearch")));
  await assertFails(setDoc(doc(anon(ANON), "anonSearch", ANON), { day: "1", count: 1 }));
});

test("S4 anonymous players still see nothing of The Scorecard", async () => {
  await assertFails(getDoc(doc(anon(ANON), "courses", "X")));
  await assertFails(getDoc(doc(anon(ANON), "golfers", "A")));
  await assertFails(getDoc(doc(anon(ANON), "associations", "G1")));
});
