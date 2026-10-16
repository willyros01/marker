/* The Marker — rules tests against the Firebase emulator.
 *
 * Runs in GitHub Actions only (firebase emulators:exec). Nothing live is
 * touched. Each test names what it proves; a failure says which rule broke.
 *
 * Covers the additions (cards, markerCourses, lookup, anonymous search limits)
 * AND checks that The Scorecard's own behaviour is unchanged where the rules
 * were touched (posting rounds as admin, as yourself, and refused for others).
 */
import { readFileSync } from "node:fs";
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from "@firebase/rules-unit-testing";
import {
  doc, getDoc, setDoc, updateDoc, writeBatch, serverTimestamp, collection, getDocs,
} from "firebase/firestore";

let env;
const DAY = () => String(Math.floor(Date.now() / 86400000));

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
    await setDoc(doc(db, "lookup", "courseSearch"), { key: "SECRET", updatedAt: 1 });
    await setDoc(doc(db, "courses", "X"), { name: "X", tees: [], createdBy: OWNER });
  });
});

/* A round shaped as The Marker sends it. */
const round = (uid, assocId, golferId, cardId) => ({
  id: `r-${golferId}`, assocId, golferId, gameId: null, date: "2026-10-16",
  courseId: "X", courseName: "X", teeId: "t", teeName: "White", rating: 70, slope: 120, par: 72,
  gross: 90, adjusted: 88, differential: 16.9, courseHandicap: null, indexAtEntry: null,
  notes: "", enteredBy: uid, enteredAt: serverTimestamp(), ...(cardId ? { cardId } : {}),
});
const card = (uid, groupOf) => ({
  scorer: uid, createdAt: serverTimestamp(), indexPending: true,
  golferIds: Object.keys(groupOf), groupOf, date: "2026-10-16", players: [],
});
async function postCard(db, uid, cardId, groupOf) {
  const b = writeBatch(db);
  b.set(doc(db, "cards", cardId), card(uid, groupOf));
  for (const [g, a] of Object.entries(groupOf)) b.set(doc(db, `associations/${a}/rounds`, `r-${g}`), round(uid, a, g, cardId));
  return b.commit();
}

/* ---------------- cards: posting for the foursome ---------------- */

test("M1 a regular member posts a card and rounds for golfers in two of their groups", async () => {
  await assertSucceeds(postCard(real(MEMBER), MEMBER, "c1", { A: "G1", B: "G1", C: "G2" }));
});

test("M2 a regular member may NOT post for somebody else without a card (Scorecard rule unchanged)", async () => {
  const db = real(MEMBER);
  await assertFails(setDoc(doc(db, "associations/G1/rounds", "r-B"), round(MEMBER, "G1", "B")));
});

test("M3 a card cannot be reused to post another round later", async () => {
  await assertSucceeds(postCard(real(MEMBER), MEMBER, "c1", { A: "G1" }));
  const db = real(MEMBER);
  await assertFails(setDoc(doc(db, "associations/G1/rounds", "r-B2"), { ...round(MEMBER, "G1", "B", "c1"), id: "r-B2" }));
});

test("M4 a card naming a golfer from a group the scorer is not in is refused", async () => {
  await assertFails(postCard(real(MEMBER), MEMBER, "c1", { A: "G1", D: "G3" }));
});

test("M5 a card naming a golfer who is not on that group's roster is refused", async () => {
  await assertFails(postCard(real(MEMBER), MEMBER, "c1", { C: "G1" }));
});

test("M6 a round whose card puts the golfer in a different group is refused", async () => {
  const db = real(MEMBER);
  const b = writeBatch(db);
  b.set(doc(db, "cards", "c1"), card(MEMBER, { A: "G1" }));
  b.set(doc(db, "associations/G2/rounds", "r-A"), round(MEMBER, "G2", "A", "c1"));
  await assertFails(b.commit());
});

test("M7 a card cannot name somebody else as the scorer", async () => {
  const db = real(MEMBER);
  const b = writeBatch(db);
  b.set(doc(db, "cards", "c1"), card(OTHER, { A: "G1" }));
  b.set(doc(db, "associations/G1/rounds", "r-A"), round(MEMBER, "G1", "A", "c1"));
  await assertFails(b.commit());
});

test("M8 a card can never be changed or deleted, and only its scorer reads it", async () => {
  await assertSucceeds(postCard(real(MEMBER), MEMBER, "c1", { A: "G1" }));
  await assertFails(updateDoc(doc(real(MEMBER), "cards", "c1"), { indexPending: false }));
  await assertSucceeds(getDoc(doc(real(MEMBER), "cards", "c1")));
  await assertFails(getDoc(doc(real(OTHER), "cards", "c1")));
  await assertSucceeds(getDoc(doc(real(OTHER), "cards", "nothing-here")));   /* "not there" is an answer, not a refusal */
  await assertSucceeds(getDoc(doc(real(OWNER), "cards", "c1")));
});

test("M9 more than four golfers on a card is refused", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const g of ["E", "F"]) {
      await setDoc(doc(db, "golfers", g), { name: g, groups: ["G1"] });
      await setDoc(doc(db, "associations/G1/roster", g), { golferId: g });
    }
  });
  await assertFails(postCard(real(MEMBER), MEMBER, "c1", { A: "G1", B: "G1", C: "G2", E: "G1", F: "G1" }));
});

test("M10 an anonymous player cannot post a card", async () => {
  await assertFails(postCard(anon(ANON), ANON, "c1", { A: "G1" }));
});

test("S1 Scorecard unchanged: an admin still posts for anybody, a member for themselves", async () => {
  await assertSucceeds(setDoc(doc(real(ADMIN), "associations/G1/rounds", "r-B"), round(ADMIN, "G1", "B")));
  await assertSucceeds(setDoc(doc(real(MEMBER), "associations/G1/rounds", "r-A"), round(MEMBER, "G1", "A")));
});

/* ---------------- courses with holes ---------------- */

const mcourse = (uid, id) => ({ providerId: id, name: "Royal Ontario", where: "Milton, ON", tees: [{ name: "White", rating: 68.8, slope: 133, par: 72, holes: [{ par: 4, yards: 385, si: 7 }] }], savedBy: uid, savedAt: serverTimestamp() });

test("C1 an anonymous player reads and adds Marker courses, but not Scorecard courses", async () => {
  const db = anon(ANON);
  await assertSucceeds(setDoc(doc(db, "markerCourses", "123"), mcourse(ANON, "123")));
  await assertSucceeds(getDocs(collection(db, "markerCourses")));
  await assertFails(getDoc(doc(db, "courses", "X")));
});

test("C2 a Marker course cannot be overwritten except by Willy's account", async () => {
  await assertSucceeds(setDoc(doc(anon(ANON), "markerCourses", "123"), mcourse(ANON, "123")));
  await assertFails(setDoc(doc(anon(ANON2), "markerCourses", "123"), mcourse(ANON2, "123")));
  await assertFails(setDoc(doc(real(MEMBER), "markerCourses", "123"), mcourse(MEMBER, "123")));
  await assertSucceeds(updateDoc(doc(real(OWNER), "markerCourses", "123"), { name: "Royal Ontario GC" }));
});

test("C3 a Marker course with a mismatched id or extra fields is refused", async () => {
  await assertFails(setDoc(doc(anon(ANON), "markerCourses", "124"), mcourse(ANON, "123")));
  await assertFails(setDoc(doc(anon(ANON), "markerCourses", "123"), { ...mcourse(ANON, "123"), extra: 1 }));
});

/* ---------------- the search key and the anonymous limits ---------------- */

async function countedSearch(db, uid) {
  const mine = await getDoc(doc(db, "anonSearch", uid)).catch(() => null);
  const day = await getDoc(doc(db, "anonSearchDays", DAY())).catch(() => null);
  const prev = mine && mine.exists() && mine.data().day === DAY() ? mine.data().count : 0;
  const total = day && day.exists() ? day.data().count : 0;
  const b = writeBatch(db);
  b.set(doc(db, "anonSearch", uid), { day: DAY(), count: prev + 1, at: serverTimestamp() });
  b.set(doc(db, "anonSearchDays", DAY()), { count: total + 1, lastAt: serverTimestamp() });
  return b.commit();
}

test("K1 members read the search key; an anonymous player only right after a counted search", async () => {
  await assertSucceeds(getDoc(doc(real(MEMBER), "lookup", "courseSearch")));
  const db = anon(ANON);
  await assertFails(getDoc(doc(db, "lookup", "courseSearch")));
  await assertSucceeds(countedSearch(db, ANON));
  await assertSucceeds(getDoc(doc(db, "lookup", "courseSearch")));
});

test("K2 an anonymous player gets 10 searches a day, the 11th is refused", async () => {
  const db = anon(ANON);
  for (let i = 1; i <= 10; i++) await assertSucceeds(countedSearch(db, ANON));
  await assertFails(countedSearch(db, ANON));
});

test("K3 the counters cannot be skipped, faked or written for somebody else", async () => {
  const db = anon(ANON);
  /* Only the player's own counter, without the day's total: refused. */
  await assertFails(setDoc(doc(db, "anonSearch", ANON), { day: DAY(), count: 1, at: serverTimestamp() }));
  /* Starting at 0 to get extra searches: refused. */
  const b = writeBatch(db);
  b.set(doc(db, "anonSearch", ANON), { day: DAY(), count: 0, at: serverTimestamp() });
  b.set(doc(db, "anonSearchDays", DAY()), { count: 1, lastAt: serverTimestamp() });
  await assertFails(b.commit());
  /* Somebody else's counter: refused. */
  const c = writeBatch(db);
  c.set(doc(db, "anonSearch", ANON2), { day: DAY(), count: 1, at: serverTimestamp() });
  c.set(doc(db, "anonSearchDays", DAY()), { count: 1, lastAt: serverTimestamp() });
  await assertFails(c.commit());
});

test("K4 all anonymous players together stop at 300 a day", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "anonSearchDays", DAY()), { count: 300, lastAt: 1 });
  });
  await assertFails(countedSearch(anon(ANON), ANON));
});

test("K5 only Willy's account writes the search key", async () => {
  await assertFails(setDoc(doc(real(MEMBER), "lookup", "courseSearch"), { key: "x", updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(anon(ANON), "lookup", "courseSearch"), { key: "x", updatedAt: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(real(OWNER), "lookup", "courseSearch"), { key: "x", updatedAt: serverTimestamp() }));
});
