/* The Marker user guide and quick start pictures (Willy, 13 Nov 2026: "do docs
 * now"). The real web app (the same code the iPhone and Android apps run)
 * against the Firebase emulators and the worker stand-in (doc-server.mjs),
 * with made-up golfers, groups and courses. Nothing live is touched.
 * Run by test/ui/run-doc-shots.sh. Pictures go to $SHOTS as <scene>.png,
 * 860 pixels wide (430 at 2x), the names the guides already use. */
import { chromium } from "playwright";
import { client, setWrite } from "../../worker/src/firestore.js";

const APP = "http://127.0.0.1:8099/?emulators";
const SHOTS = process.env.SHOTS || "/tmp/doc-shots";
const fs = client({ project: "demo-marker", base: "http://127.0.0.1:8080/v1", token: async () => "owner" });
const log = (m) => console.log("ok -", m);

const signUp = async (email, password) => (await (await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, returnSecureToken: true }),
})).json()).localId;
const uid1 = await signUp("sam.carter@example.com", "sample-pass-1");
const todayIso = new Date().toISOString().slice(0, 10);
const PARS = [4, 5, 3, 4, 4, 5, 3, 4, 4, 4, 3, 5, 4, 4, 3, 4, 5, 4];
const si = [7, 1, 17, 3, 11, 5, 15, 9, 13, 8, 18, 2, 10, 4, 16, 12, 6, 14];
const yards = [365, 512, 168, 402, 377, 534, 152, 418, 390, 371, 181, 497, 355, 428, 143, 386, 541, 404];
const holes = PARS.map((par, i) => ({ par, yards: yards[i], si: si[i] }));
const blue = holes.map((h) => ({ ...h, yards: h.yards + 24 }));

/* Made-up golfers of the made-up group, with handicap indexes. */
const GOLFERS = [["g-sam", "Sam Carter", 16.4], ["g-lee", "Lee Park", 8.7], ["g-jordan", "Jordan Diaz", 20.1], ["g-pat", "Pat Kelly", 12.9],
  ["g-dana", "Dana Brooks", 24.3], ["g-robin", "Robin Hayes", 10.8], ["g-morgan", "Morgan Ellis", 14.6]];
const seed = [
  setWrite(fs, "markerCourses/900", { providerId: "900", name: "Cedar Brook Golf Club", where: "Example Town", tees: [
    { name: "White", rating: 70.6, slope: 126, par: 72, holes },
    { name: "Blue", rating: 72.4, slope: 131, par: 72, holes: blue }] }),
  setWrite(fs, "markerCourses/901", { providerId: "901", name: "Cedar Valley Golf Course", where: "Sample County", tees: [
    { name: "White", rating: 69.4, slope: 121, par: 71, holes }] }),
  setWrite(fs, "markerConfig/public", { workerUrl: "http://127.0.0.1:8788", version: "test" }),
  setWrite(fs, "associations/CB", { name: "Cedar Brook Golfers", ownerUid: uid1 }),
  setWrite(fs, `associations/CB/members/${uid1}`, { uid: uid1, role: "owner", golferId: "g-sam" }),
  setWrite(fs, "associations/CB/games/gm-sat", { id: "gm-sat", assocId: "CB", name: "Saturday Medal", date: todayIso, endDate: null, createdBy: uid1 }),
];
for (const [id, name, index] of GOLFERS) {
  seed.push(setWrite(fs, `golfers/${id}`, { id, name, nameKey: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), linkedUid: id === "g-sam" ? uid1 : null,
    manualIndex: index, handicapIndex: null, roundCount: 0, recentWindow: [], groups: ["CB"] }));
  seed.push(setWrite(fs, `associations/CB/roster/${id}`, { golferId: id, addedAt: 1760000000000 }));
  seed.push(setWrite(fs, `associations/CB/directory/${id}`, { golferId: id, displayName: name, handicapIndex: index }));
}
await fs.commit(seed);

/* Strokes over par on each hole, per golfer (made up). */
const OVER = [
  [1, 0, 0, 1, 2, 1, 0, 1, 0, 1, 1, 0, 2, 1, 0, 1, 1, 0],
  [0, -1, 0, 0, 1, 0, 0, 0, 1, 0, -1, 1, 0, 0, 0, 1, 0, 0],
  [1, 1, 0, 2, 1, 1, 1, 0, 2, 1, 1, 1, 0, 2, 1, 1, 2, 1],
  [0, 1, 1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1],
];

const browser = await chromium.launch();
const CTX = { viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const page = async () => { const p = await (await browser.newContext(CTX)).newPage(); p.on("dialog", (d) => d.accept()); return p; };
const act = (p, a, v) => p.click(v == null ? `[data-act="${a}"]` : `[data-act="${a}"][data-v="${v}"]`);
const shot = async (p, name, full = true) => {
  await p.waitForTimeout(700);
  await p.evaluate(() => { window.scrollTo(0, 0); document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
  await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full, animations: "disabled" });
  log(name);
};
const text = async (p, t, timeout = 30000) => {
  try { await p.waitForFunction((s) => document.body.innerText.includes(s), t, { timeout }); }
  catch (e) { console.log(`--- waiting for "${t}", the screen shows:\n${await p.evaluate(() => document.body.innerText)}`); throw e; }
};

/* Every golfer on the hole on screen who has not missed it: who, then score. */
async function scoreHole(p, h, skip = []) {
  const n = await p.locator('nav.names [data-act="who"]').count();
  for (let i = 0; i < n; i++) {
    if (skip.includes(i)) continue;
    const label = (await p.locator(`nav.names [data-act="who"][data-v="${i}"]`).innerText()).trim();
    if (label.endsWith("–")) continue;   /* joined later: this hole counts as net par */
    await act(p, "who", i);
    await act(p, "score", PARS[h] + OVER[i][h]);
  }
}

/* ---------------- 1. start, sign in ---------------- */
const P = await page();
await P.goto(APP); await P.waitForSelector('[data-act="go-signin"]', { timeout: 30000 });
await shot(P, "choose");
await act(P, "go-signin"); await P.waitForSelector("#email");
await shot(P, "signin");
await P.fill("#email", "sam.carter@example.com"); await P.fill("#password", "sample-pass-1");
await act(P, "sign-in");
await P.waitForSelector('[data-act="new-round"]', { timeout: 30000 });
await shot(P, "start-member");

/* ---------------- 2. set up the round ---------------- */
await act(P, "new-round"); await P.waitForSelector('[data-act="go-course"]');
await act(P, "cal-open"); await P.waitForSelector(".cal");
await shot(P, "date");
await act(P, "cal-open");
await act(P, "go-course"); await P.waitForSelector("#cq");
await P.fill("#cq", "Cedar"); await act(P, "search");
await P.waitForSelector('[data-act="pick-online"]', { timeout: 30000 });
await shot(P, "course");
await act(P, "pick-online", 0);
await P.waitForSelector('[data-act="tee"]', { timeout: 30000 }); await act(P, "tee", 0);
await P.waitForSelector('[data-act="game"][data-v="gm-sat"]', { timeout: 30000 });
await shot(P, "setup");
await act(P, "game", "gm-sat");
await shot(P, "games");

/* ---------------- 3. players ---------------- */
await act(P, "go-players");
await P.waitForSelector('[data-act="pick"][data-v="g-sam"]', { timeout: 30000 });
await act(P, "pick", "g-sam"); await act(P, "pick", "g-lee");
await P.fill("#guest", "Chris Lane"); await act(P, "add-guest");
await shot(P, "players");
await act(P, "tee-off");
await P.waitForSelector('[data-act="who"]', { timeout: 20000 });

/* ---------------- 4. playing: a late golfer, one at a time, the game, the Menu ---------------- */
for (let h = 0; h < 2; h++) { await scoreHole(P, h); await act(P, "next"); }
await act(P, "late-open"); await P.waitForSelector('[data-act="late-pick"][data-v="g-jordan"]', { timeout: 30000 });
await shot(P, "late");
/* Not added here: a card with a late golfer cannot be corrected yet (found 13 Nov, reported to Willy). */
await act(P, "back-play"); await P.waitForSelector('[data-act="who"]', { timeout: 20000 });
for (let h = 2; h < 5; h++) { await scoreHole(P, h); await act(P, "next"); }
await act(P, "who", 0); await act(P, "score", PARS[5] + OVER[0][5]);
await act(P, "who", 1);
await shot(P, "one");
await act(P, "type"); await P.fill("#typed", "6");
await shot(P, "typed");
await act(P, "type-cancel");
await scoreHole(P, 5, [0]); await act(P, "next");

await act(P, "game-tap"); await P.waitForSelector(".bigcode", { timeout: 30000 });
await shot(P, "game-code");
await act(P, "game-board"); await P.waitForSelector(".board-row:not(.hd)", { timeout: 30000 });
await shot(P, "game-board");
await act(P, "game-own-back"); await P.waitForSelector('[data-act="who"]');

await act(P, "menu"); await shot(P, "menu");
await act(P, "switch-entry"); await P.waitForSelector('[data-act="plus"]', { timeout: 20000 });
await shot(P, "all");
await act(P, "menu"); await act(P, "switch-entry"); await P.waitForSelector('[data-act="who"]');

for (let h = 6; h < 18; h++) { await scoreHole(P, h); await act(P, h === 17 ? "finish" : "next"); }

/* ---------------- 5. finish: fix a score, totals, post ---------------- */
await text(P, "Round finished");
await act(P, "fix-score"); await P.waitForSelector('[data-act="jump"]');
await shot(P, "fixing");
await act(P, "jump", 4); await P.waitForSelector('[data-act="who"]');
await act(P, "who", 2); await act(P, "score", PARS[4] + 1);
await act(P, "finish"); await text(P, "Round finished");
await shot(P, "totals");
await shot(P, "post");
await act(P, "card"); await shot(P, "card");
await act(P, "back-play"); await P.waitForTimeout(300);
if (!(await P.locator('[data-act="post"]').count())) { await act(P, "finish"); await text(P, "Round finished"); }

await P.context().setOffline(true);
await act(P, "post");
await text(P, "Saved on this phone");
await shot(P, "help");
await P.context().setOffline(false);
await text(P, "Posted ✓", 90000);
await shot(P, "status");
await act(P, "share-card"); await text(P, "Share the card");
await shot(P, "share");
await act(P, "share-back"); await P.waitForTimeout(300);
await act(P, "done"); await P.waitForSelector('[data-act="new-round"]');

/* ---------------- 6. your cards, correct, delete, re-post ---------------- */
await act(P, "history"); await P.waitForSelector('[data-act="go-corrections"]', { timeout: 30000 });
await act(P, "go-corrections"); await P.waitForSelector('[data-act="correct-card"]', { timeout: 30000 });
await shot(P, "corrections");
await P.locator('[data-act="correct-card"]').first().click();
await text(P, "Save the correction");
await shot(P, "correct");
await act(P, "delete-rounds");
await P.waitForSelector('[data-act="repost-card"]', { timeout: 45000 });
await shot(P, "history");
await P.locator('[data-act="repost-card"]').first().click();
await text(P, "Re-post the card");
await shot(P, "repost");
await act(P, "cancel-repost"); await P.waitForSelector('[data-act="go-corrections"]', { timeout: 30000 });
await act(P, "home"); await P.waitForSelector('[data-act="new-round"]', { timeout: 30000 });

/* ---------------- 7. a caddie, followers, starting a game ---------------- */
await act(P, "new-round"); await act(P, "go-course");
await P.waitForSelector('[data-act="pick-saved"]', { timeout: 30000 });
await P.locator('[data-act="pick-saved"]').first().click();
await P.waitForSelector('[data-act="tee"]'); await act(P, "tee", 0);
await act(P, "go-players");
await P.waitForSelector('[data-act="pick"][data-v="g-pat"]', { timeout: 30000 });
for (const g of ["g-sam", "g-pat", "g-robin", "g-morgan"]) await act(P, "pick", g);
await act(P, "game-start-open"); await P.waitForSelector("#gamename");
await P.fill("#gamename", "Sunday Skins");
await shot(P, "game-start");
await act(P, "game-form-close");
await act(P, "caddie-start"); await P.waitForSelector(".bigcode", { timeout: 30000 });
const ccode = (await P.locator(".bigcode").innerText()).replace(/\s/g, "");
await shot(P, "caddie-offer");

const cad = await page();
await cad.goto(APP); await cad.waitForSelector('[data-act="caddie-open"]', { timeout: 30000 });
await act(cad, "caddie-open"); await cad.fill("#caddiecode", ccode);
await shot(cad, "caddie-join");
await act(cad, "caddie-join"); await cad.waitForSelector('[data-act="score"]', { timeout: 30000 });
for (let h = 0; h < 4; h++) { await scoreHole(cad, h); await act(cad, "next"); }
await scoreHole(cad, 4, [2, 3]);
await text(cad, "Sent to the golfer");
await shot(cad, "caddie-scoring");
await text(P, "last score at", 45000);
await shot(P, "caddie-live");
await act(P, "follow-start"); await P.waitForSelector(".bigcode", { timeout: 30000 });
const fcode = (await P.locator(".bigcode").innerText()).replace(/\s/g, "");
await shot(P, "follow-offer");

const fan = await page();
await fan.goto(APP); await fan.waitForSelector('[data-act="follow-open"]', { timeout: 30000 });
await act(fan, "follow-open"); await fan.fill("#followcode", fcode);
await shot(fan, "follow-join");
await act(fan, "follow-join"); await text(fan, "Following");
await fan.waitForSelector(".cgrid", { timeout: 30000 });
await shot(fan, "follow-live");

/* ---------------- 8. a course from a photo of the club's card ---------------- */
await P.screenshot({ path: "/tmp/club-card.png" });   /* any picture: the stand-in's AI answers with a made-up card */
await P.goto(APP); await P.waitForSelector('[data-act="new-round"]', { timeout: 30000 });
await act(P, "new-round"); await act(P, "go-course");
await P.waitForSelector('[data-act="manual"]', { timeout: 30000 }); await act(P, "manual");
await P.waitForSelector("#scanpick", { state: "attached", timeout: 20000 });
await shot(P, "photo", false);
await P.setInputFiles("#scanpick", "/tmp/club-card.png");
await text(P, "Check against the card", 60000);
await shot(P, "verify");
await act(P, "review-hand");
if (await P.locator('[data-act="review-hand-tee"]').count()) await act(P, "review-hand-tee", 1);
await P.waitForSelector("#m-name", { timeout: 20000 });
await shot(P, "manual");

await browser.close();
console.log("ALL PICTURES TAKEN");
