/* The Scorecard user guide pictures (Willy, 13 Nov 2026: "do docs now"; all
 * real screens, Lake blue, made-up golfers). Same seed as sc-store-shots.mjs,
 * plus: a regular member (Lee Park), hole-by-hole Marker rounds, the public
 * group with one application waiting, and the worker stand-in (doc-server.mjs)
 * for course search and scorecard photos. The real Scorecard web app (./sc)
 * against the emulators (demo-scorecard): nothing live is touched.
 * Each scene is tried on its own: a scene that fails is logged with what the
 * screen showed, and the run goes on. Pictures: $SHOTS/sc-<scene>.png. */
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
/* the regular member, Lee Park, has an account linked to his golfer */
const LEE_EMAIL = "lee.park@example.com";
const leeUid = await signUp(LEE_EMAIL, PASSWORD);
const lee = golfers[1];
lee.linkedUid = leeUid;

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

/* ---------- guide extras ---------- */
put(`associations/${G}/members/${leeUid}`, { uid: leeUid, role: "member", displayName: lee.name, golferId: lee.id });
put(`userGroups/${leeUid}/groups/${G}`, { assocId: G, name: GROUP });
put(`users/${leeUid}/prefs/account`, { passwordCreated: true });
put(`users/${leeUid}/terms/accepted`, { version: 1, appVersion: "pictures" });
/* hole-by-hole Marker rounds: the latest round of Sam and of Lee */
const PAR18 = [4, 5, 3, 4, 4, 5, 3, 4, 4, 4, 3, 5, 4, 4, 3, 4, 5, 4];
const SI18 = [7, 1, 17, 3, 11, 5, 15, 9, 13, 8, 18, 2, 10, 4, 16, 12, 6, 14];
for (const g of [me, lee]) {
  const r = rounds.filter((x) => x.golferId === g.id).sort((a, b) => b.date.localeCompare(a.date))[0];
  const over = r.gross - PAR18.reduce((a, b) => a + b, 0);
  const holes = PAR18.map((p) => p);
  for (let k = 0; k < Math.abs(over); k++) holes[(k * 7) % 18] += Math.sign(over);
  r.holes = holes; r.holePar = PAR18; r.holeSi = SI18; r.teeName = "White";
  r.notes = "Scored hole by hole with The Marker";
}
/* the public group, with one application waiting */
put("associations/PUBLIC", { name: "The Scorecard public group", ownerUid: uid });
put(`associations/PUBLIC/members/${uid}`, { uid, role: "owner", displayName: me.name, golferId: me.id });
put(`userGroups/${uid}/groups/PUBLIC`, { assocId: "PUBLIC", name: "The Scorecard public group" });
put("publicApplications/alex.morgan@example.com", { fullName: "Alex Morgan", email: "alex.morgan@example.com", status: "pending", createdAt: new Date(Date.UTC(2026, 10, 12, 15)) });
/* the worker stand-in, and a course it can find */
put("markerConfig/public", { workerUrl: "http://127.0.0.1:8788", version: "test" });
const holes = PAR18.map((par, i) => ({ par, yards: 330 + ((i * 37) % 200), si: SI18[i] }));
put("markerCourses/950", { providerId: "950", name: "Cedar Ridge Golf Club", where: "Example Town", tees: [{ name: "White", rating: 70.1, slope: 124, par: 72, holes }] });

for (const r of rounds) put(`associations/${G}/rounds/${r.id}`, { ...r, enteredAt: new Date(r.date + "T18:00:00Z") });
for (const gm of GAMES) put(`associations/${G}/games/${gm.id}`, gm);
await flush();
console.log(`seeded: ${golfers.length} golfers, ${COURSES.length} courses, ${rounds.length} rounds, ${GAMES.length} games`);

/* ---------------- the pictures ---------------- */
const browser = await chromium.launch();
/* The app turns to its night look from 7 pm to 6 am (local time). The guide
   shows the day look: a time zone where it is daytime now. */
const DAY_TZ = ["Pacific/Honolulu", "America/Los_Angeles", "America/Toronto", "Europe/London", "Europe/Berlin", "Asia/Dubai", "Asia/Kolkata", "Asia/Tokyo", "Australia/Sydney"]
  .find((z) => { const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: z }).format(new Date())); return h >= 9 && h <= 16; }) || "America/Toronto";
console.log("time zone for the day look:", DAY_TZ);
const CTX = { viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: DAY_TZ, colorScheme: "light" };
const missing = [];
async function open(email) {
  const context = await browser.newContext(CTX);
  await context.addInitScript(() => { try { localStorage.setItem("golf:terms", JSON.stringify({ version: 1, acceptedAt: Date.now() })); } catch {} });
  const page = await context.newPage();
  page.on("dialog", (d) => d.dismiss());
  await page.goto(APP, { waitUntil: "load" });
  await page.waitForSelector('[name="email"]', { timeout: 30000 });
  if (email) {
    await page.fill('[name="email"]', email); await page.fill('[name="password"]', PASSWORD);
    await page.click('[data-act="sign-in"]');
    await page.waitForSelector('button[data-tab="enter"]', { timeout: 45000 });
    await page.waitForFunction(() => /Cedar Brook/.test(document.body.innerText), null, { timeout: 30000 });
  }
  return page;
}
const tab = async (p, t) => { await p.click(`button[data-tab="${t}"]`); await p.waitForTimeout(1200); };
/* full: the whole page from the top; view: the screen as it is now;
   sheet: only the pop-up sheet at the bottom. */
const snap = async (p, name, mode = "full") => {
  await p.waitForTimeout(900);
  const path = `${SHOTS}/sc-${name}.png`;
  if (mode === "sheet") await p.locator("#sheet .sheet-body").first().screenshot({ path, animations: "disabled" });
  else {
    if (mode === "full") await p.evaluate(() => window.scrollTo(0, 0));
    await p.screenshot({ path, fullPage: mode === "full", animations: "disabled" });
  }
  console.log("ok -", name);
};
async function scene(p, name, fn, mode = "full") {
  try { await fn(); await snap(p, name, mode); }
  catch (e) {
    missing.push(name);
    console.log(`MISSING ${name}: ${String(e.message).split("\n")[0]}`);
    try { console.log(`--- the screen showed:\n${(await p.evaluate(() => document.body.innerText)).slice(0, 1500)}\n---`); } catch {}
  }
}
const closeSheet = async (p) => { const c = p.locator('#sheet [data-close="1"]').first(); if (await c.count()) await c.click().catch(() => {}); await p.waitForTimeout(400); };
const text = (p, t, timeout = 20000) => p.waitForFunction((s) => document.body.innerText.includes(s), t, { timeout });

/* ---- signed out ---- */
const A = await open(null);
await scene(A, "signin", async () => {});
await scene(A, "choose", async () => { await A.click('[data-act="show-choose"]'); await text(A, "Become a member"); });
await scene(A, "apply", async () => { await A.click('[data-act="show-apply"]'); await A.waitForTimeout(800);
  const n = A.locator('input[name="fullName"], input[name="name"]').first(); if (await n.count()) await n.fill("Alex Morgan");
  const e = A.locator('input[type="email"]').first(); if (await e.count()) await e.fill("alex.morgan@example.com"); });
await scene(A, "code", async () => { await A.goto(APP); await A.waitForSelector('[data-act="enter-code"]', { timeout: 20000 }); await A.click('[data-act="enter-code"]'); await A.waitForTimeout(800); });

/* ---- a regular member: Lee Park ---- */
const L = await open(LEE_EMAIL);
await scene(L, "member-enter", async () => { await tab(L, "enter"); const s = L.locator('[data-act="enter-steps"]'); if (await s.count()) { await s.click(); await L.waitForTimeout(800); } });
await scene(L, "member-course", async () => {
  const next = L.locator('[data-act="step-next"]'); if (await next.count() && await next.isEnabled()) { await next.click(); await L.waitForTimeout(800); }
  await L.selectOption('select[name="courseId"]', { label: "Cedar Brook Golf Club" }); await L.waitForTimeout(800);
  await L.locator("[data-tee]").first().click(); await L.waitForTimeout(600); });
await scene(L, "member-score", async () => { await L.click('[data-act="step-next"]'); await L.waitForTimeout(800); await L.fill('input[name="gross"]', "84"); await L.waitForTimeout(600); });
await scene(L, "member-rounds", async () => { await tab(L, "history"); });
await scene(L, "marker-card", async () => { await L.locator('[data-act="show-card"]').first().click(); await text(L, "Scored in The Marker"); }, "sheet");
await closeSheet(L);
await scene(L, "member-summary", async () => { await tab(L, "summary"); });

/* ---- the owner: Sam Carter ---- */
const S = await open(EMAIL);
await scene(S, "admin-enter", async () => { await tab(S, "enter"); });
await scene(S, "course-search", async () => {
  await S.selectOption('select[name="courseId"]', { index: 1 }); await S.waitForTimeout(800);
  await S.fill('input[name="cf-q"]', "Cedar Ridge"); await S.click('[data-act="cf-find"]');
  await text(S, "Cedar Ridge Golf Club"); });
await scene(S, "admin-history", async () => { await S.goto(APP); await S.waitForSelector('button[data-tab="history"]', { timeout: 45000 }); await tab(S, "history"); });
await scene(S, "round-edit", async () => { await S.locator('[data-edit], [data-act="edit-round"], .round-row button, .list-row').first().click(); await S.waitForTimeout(1200); });
await scene(S, "rankings", async () => { await S.goto(APP); await S.waitForSelector('button[data-tab="summary"]', { timeout: 45000 }); await tab(S, "summary"); });
await scene(S, "games", async () => { await tab(S, "games"); });
await scene(S, "game-board", async () => { await S.locator(".list-row", { hasText: "Fall Classic" }).first().click(); await text(S, "Fall Classic"); await S.waitForTimeout(1500); });
await scene(S, "new-game", async () => { await S.goto(APP); await S.waitForSelector('button[data-tab="games"]', { timeout: 45000 }); await tab(S, "games"); await S.click('[data-act="new-game"]'); await S.waitForTimeout(1000); });
await scene(S, "golfers", async () => { await S.goto(APP); await S.waitForSelector('button[data-tab="manage"]', { timeout: 45000 }); await tab(S, "manage"); });
await scene(S, "invite", async () => {
  const show = S.locator('[data-act="toggle-golfer-list"]'); if (await show.count()) { await show.first().click(); await S.waitForTimeout(800); }
  await snap(S, "golfer-list", "full");
  await S.locator(".roster-row [data-invite-golfer]:visible").first().click(); await text(S, "They join as"); }, "sheet");
await closeSheet(S);
await scene(S, "courses", async () => {
  await S.goto(APP); await S.waitForSelector('button[data-tab="manage"]', { timeout: 45000 }); await tab(S, "manage");
  const c = S.locator('[data-act="toggle-course-list"]'); if (await c.count() && /Show/.test(await c.first().innerText())) await c.first().click(); await S.waitForTimeout(800);
  await S.locator("h2, .panel-title, .eyebrow, b", { hasText: /^Courses/ }).first().evaluate((e) => e.scrollIntoView({ block: "start" })); await S.waitForTimeout(500); }, "view");
await scene(S, "course-new", async () => { await S.click('[data-act="new-course"]'); await S.waitForTimeout(1200);
  await S.getByText("New course", { exact: false }).first().evaluate((e) => e.scrollIntoView({ block: "start" })); await S.waitForTimeout(500); }, "view");
await scene(S, "cockpit", async () => { await S.goto(APP); await S.waitForSelector('button[data-tab="admin"]', { timeout: 45000 }); await tab(S, "admin"); await S.waitForTimeout(2500); });
await scene(S, "members", async () => { await S.click('[data-act="admin-tab"][data-id="members"]'); await S.waitForTimeout(1500); });
await scene(S, "group-settings", async () => { await S.click('[data-act="admin-tab"][data-id="settings"]'); await S.waitForTimeout(1500); });
await scene(S, "delete-account", async () => { await S.locator('[data-act="delete-account"]').first().click(); await text(S, "Delete your account"); }, "sheet");
await closeSheet(S);
await scene(S, "switcher", async () => { await S.goto(APP); await S.waitForSelector('button[data-tab="enter"]', { timeout: 45000 }); await S.click("#brandSub"); await text(S, "Your groups"); }, "sheet");
await scene(S, "applications", async () => {
  await S.click('[data-goto-group="PUBLIC"]'); await S.waitForTimeout(2500);
  await tab(S, "admin"); await S.click('[data-act="admin-tab"][data-id="applications"]'); await text(S, "Alex Morgan"); });

await browser.close();
console.log(missing.length ? `PICTURES TAKEN, MISSING: ${missing.join(", ")}` : "ALL PICTURES TAKEN");
