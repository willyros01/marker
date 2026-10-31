/* The Scorecard's App Store pictures with made-up golfers (Willy, 31 Oct 2026:
 * "change the names and get it ready when we do the update release"). The real
 * Scorecard web app (main, served from ./sc) against the Firebase emulators
 * (demo-scorecard: cannot reach live data), seeded with fictional golfers,
 * courses, rounds and games built by the app's own model.js.
 * Pictures go to $SHOTS:
 *   iPhone 6.9-inch  1320 x 2868  (440 x 956 at 3x)
 *   iPad 13-inch     2752 x 2064  (1376 x 1032 at 2x, landscape like before) */
import { chromium } from "playwright";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SC = path.resolve(process.env.SC || "sc");
const model = await import(pathToFileURL(path.join(SC, "model.js")).href);
const SHOTS = process.env.SHOTS || "/tmp/sc-shots";
const APP = "http://127.0.0.1:8000/?emulators=1";
const P = "demo-scorecard";
const FS = `http://127.0.0.1:8080/v1/projects/${P}/databases/(default)/documents`;
const AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const OWNER = { Authorization: "Bearer owner" };
const value = (v) => v === null || v === undefined ? { nullValue: null } : v instanceof Date ? { timestampValue: v.toISOString() } : Array.isArray(v) ? { arrayValue: { values: v.map(value) } }
  : typeof v === "number" ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === "boolean" ? { booleanValue: v }
  : typeof v === "object" ? { mapValue: { fields: fields(v) } } : { stringValue: String(v) };
const fields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, value(v)]));
const pending = [];
const put = (docPath, data) => pending.push({ update: { name: `projects/${P}/databases/(default)/documents/${docPath}`, fields: fields(data) } });
async function flush() {
  while (pending.length) {
    const writes = pending.splice(0, 400);
    const r = await fetch(`${FS}:commit`, { method: "POST", headers: { ...OWNER, "Content-Type": "application/json" }, body: JSON.stringify({ writes }) });
    if (!r.ok) throw new Error(`seed: ${r.status} ${await r.text()}`);
  }
}
async function signUp(email, password) {
  const r = await fetch(`${AUTH}/accounts:signUp?key=fake-api-key`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }) });
  const j = await r.json(); if (!j.localId) throw new Error(`sign-up ${email}: ${JSON.stringify(j)}`); return j.localId;
}

/* ---------------- the made-up group ---------------- */
const EMAIL = "sam.carter@example.com", PASSWORD = "sample-pass-1";
const G = "G1", GROUP = "Cedar Brook Golfers";
const uid = await signUp(EMAIL, PASSWORD);
let seedN = 7;
const rnd = () => ((seedN = (seedN * 16807) % 2147483647) / 2147483647);

const COURSES = [
  ["Cedar Brook Golf Club", [["White", 70.6, 126, 72], ["Blue", 72.4, 131, 72]]],
  ["Maple Hill Golf Course", [["White", 69.8, 122, 71], ["Gold", 71.9, 128, 71]]],
  ["Riverbend Golf Club", [["White", 70.2, 124, 72]]],
  ["Lakeshore Links", [["White", 68.9, 119, 70], ["Blue", 70.7, 125, 70]]],
  ["Willow Creek Golf Club", [["White", 71.0, 127, 72]]],
  ["Stonegate Country Club", [["White", 70.4, 129, 72], ["Black", 73.1, 136, 72]]],
].map(([name, tees]) => model.buildCourse({ name, tees: tees.map(([n, rating, slope, par]) => ({ name: n, rating, slope, par })), createdBy: uid }));

/* name, skill (average strokes over par), rounds */
const PEOPLE = [["Sam Carter", 17, 12], ["Lee Park", 9, 14], ["Jordan Diaz", 21, 10], ["Pat Kelly", 13, 13],
  ["Dana Brooks", 25, 8], ["Robin Hayes", 11, 11], ["Terry Quinn", 19, 9], ["Morgan Ellis", 15, 12]];
const golfers = PEOPLE.map(([name]) => model.buildGolfer({ name, linkedUid: name === "Sam Carter" ? uid : null }));
const me = golfers[0];

const GAMES = [
  model.buildGame({ assocId: G, date: "2026-10-24", courseId: COURSES[0].id, name: "Fall Classic", createdBy: uid, endDate: "2026-10-25" }),
  model.buildGame({ assocId: G, date: "2026-10-03", courseId: COURSES[1].id, name: "Club Championship", createdBy: uid }),
  model.buildGame({ assocId: G, date: "2026-09-12", courseId: COURSES[3].id, name: "Lakeshore Shootout", createdBy: uid }),
  model.buildGame({ assocId: G, date: "2026-08-15", courseId: COURSES[2].id, name: "Summer Scramble", createdBy: uid }),
];

const day = (d) => new Date(Date.UTC(2026, 4, 2) + d * 86400000).toISOString().slice(0, 10);
const rounds = [];
PEOPLE.forEach(([, skill, n], gi) => {
  const g = golfers[gi];
  const dates = [];
  for (let k = 0; k < n; k++) dates.push(day(Math.floor((k + rnd() * 0.8) * (178 / n))));
  /* every golfer plays the games */
  for (const gm of GAMES) dates.push(gm.date);
  if (gi % 2 === 0) dates.push("2026-10-25");
  dates.sort();
  dates.forEach((date, k) => {
    const game = GAMES.find((x) => model.gameCovers(x, date)) || null;
    const course = game ? COURSES.find((c) => c.id === game.courseId) : COURSES[Math.floor(rnd() * COURSES.length)];
    const tee = course.tees[0];
    const trend = (k / dates.length) * (gi % 3 === 0 ? -3 : 1);     /* some improve over the season */
    const gross = Math.round(tee.par + skill + trend + (rnd() - 0.5) * 8);
    const round = model.buildRound({ assocId: G, golferId: g.id, gameId: game ? game.id : null, date, course, tee,
      gross, adjusted: gross - (rnd() < 0.3 ? 1 : 0), notes: "", enteredBy: uid,
      handicapIndexAtEntry: g.recentWindow.length ? model.indexFromWindow(g.recentWindow) : null });
    g.recentWindow = model.insertIntoWindow(g.recentWindow, { roundId: round.id, date: round.date, differential: round.differential, assocId: G });
    g.roundCount += 1;
    rounds.push(round);
  });
  g.handicapIndex = model.displayIndex(g.recentWindow);
});

put(`associations/${G}`, { name: GROUP, ownerUid: uid, joinCode: "CEDAR1" });
put(`associations/${G}/members/${uid}`, { uid, role: "owner", displayName: me.name, golferId: me.id });
put(`userGroups/${uid}/groups/${G}`, { assocId: G, name: GROUP });
put(`groupCreators/${uid}`, { note: "App Store pictures" });
put(`users/${uid}/prefs/account`, { passwordCreated: true });
put(`users/${uid}/terms/accepted`, { version: 1, appVersion: "pictures" });
put("settings/publicApplications", { mode: "auto" });
put("settings/invitationLinks", { version: 2 });
for (const c of COURSES) put(`courses/${c.id}`, c);
for (const g of golfers) {
  put(`golfers/${g.id}`, { ...g, groups: [G] });
  put(`golferNames/${g.nameKey}`, { golferId: g.id, name: g.name });
  put(`associations/${G}/roster/${g.id}`, { golferId: g.id, addedAt: 1760000000000 });
  put(`associations/${G}/directory/${g.id}`, { golferId: g.id, displayName: g.name, handicapIndex: g.handicapIndex });
}
for (const r of rounds) put(`associations/${G}/rounds/${r.id}`, { ...r, enteredAt: new Date(r.date + "T18:00:00Z") });
for (const gm of GAMES) put(`associations/${G}/games/${gm.id}`, gm);
await flush();
console.log(`seeded: ${golfers.length} golfers, ${COURSES.length} courses, ${rounds.length} rounds, ${GAMES.length} games`);

/* ---------------- the pictures ---------------- */
const browser = await chromium.launch();
const sizes = {
  iphone: { viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  ipad: { viewport: { width: 1376, height: 1032 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
for (const [dev, ctx] of Object.entries(sizes)) {
  const context = await browser.newContext(ctx);
  await context.addInitScript(() => { try { localStorage.setItem("golf:terms", JSON.stringify({ version: 1, acceptedAt: Date.now() })); } catch {} });
  const page = await context.newPage();
  page.on("dialog", (d) => d.dismiss());
  const shot = async (name) => { await page.waitForTimeout(1500); await page.screenshot({ path: `${SHOTS}/${dev}-${name}.png` }); console.log("ok -", `${dev}-${name}`); };
  const tab = async (t) => { await page.click(`button[data-tab="${t}"]`); await page.waitForTimeout(1200); await page.evaluate(() => window.scrollTo(0, 0)); };

  await page.goto(APP, { waitUntil: "load" });
  await page.waitForSelector('[name="email"]', { timeout: 30000 });
  await page.fill('[name="email"]', EMAIL); await page.fill('[name="password"]', PASSWORD);
  await page.click('[data-act="sign-in"]');
  await page.waitForSelector('button[data-tab="enter"]', { timeout: 45000 });
  await page.waitForFunction(() => /Cedar Brook/.test(document.body.innerText), null, { timeout: 30000 });

  await tab("enter"); await shot("1-enter");
  await tab("history"); await shot("2-history");
  await tab("summary"); await shot("3-summary");
  if (dev === "iphone") {
    await tab("manage"); await shot("4-golfers");
    const courses = page.locator("text=Courses").first();
    await courses.scrollIntoViewIfNeeded(); await page.evaluate(() => window.scrollBy(0, -60));
    await shot("5-courses");
  } else {
    await tab("history");
    const sel = page.locator("select").first();
    await sel.selectOption({ label: "Lee Park" }).catch(async () => { await sel.selectOption({ index: 2 }); });
    await page.waitForTimeout(1500);
    await shot("4-trend");
    await tab("games"); await shot("5-games");
  }
  await context.close();
}
await browser.close();
console.log("ALL PICTURES TAKEN");
