/* App Store pictures (Willy, 31 Oct 2026: "start the pictures"). The real web
 * app (the same code the iPhone and Android apps run) against the Firebase
 * emulators and the worker stand-in, with fictional golfers and a fictional
 * course. Nothing live is touched. Run by test/ui/run-store-shots.sh.
 * Pictures go to $SHOTS at Apple's sizes:
 *   iPhone 6.9-inch  1320 x 2868  (440 x 956 at 3x)
 *   iPad 13-inch     2064 x 2752  (1032 x 1376 at 2x) */
import { chromium } from "playwright";
import { client, setWrite } from "../../worker/src/firestore.js";

const APP = "http://127.0.0.1:8099/?emulators";
const SHOTS = process.env.SHOTS || "/tmp/store-shots";
const fs = client({ project: "demo-marker", base: "http://127.0.0.1:8080/v1", token: async () => "owner" });
const log = (m) => console.log("ok -", m);

await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "member@example.com", password: "pass-M-123", returnSecureToken: true }),
});
const pars = [4, 5, 3, 4, 4, 5, 3, 4, 4, 4, 3, 5, 4, 4, 3, 4, 5, 4];
const si = [7, 1, 17, 3, 11, 5, 15, 9, 13, 8, 18, 2, 10, 4, 16, 12, 6, 14];
const holes = pars.map((par, i) => ({ par, yards: [365, 512, 168, 402, 377, 534, 152, 418, 390, 371, 181, 497, 355, 428, 143, 386, 541, 404][i], si: si[i] }));
await fs.commit([
  setWrite(fs, "markerCourses/900", { providerId: "900", name: "Cedar Brook Golf Club", where: "Example Town", tees: [{ name: "White", rating: 70.6, slope: 126, par: 72, holes }] }),
  setWrite(fs, "markerConfig/public", { workerUrl: "http://127.0.0.1:8788", version: "test" }),
]);

const GOLFERS = ["Sam Carter", "Lee Park", "Jordan Diaz", "Pat Kelly"];
/* strokes per golfer for holes 1-6 */
const PLAY = [[5, 5, 3, 4, 5, 6], [4, 6, 4, 5, 4, 5], [5, 5, 3, 5, 4, 6], [4, 5, 3, 4, 4, 5]];

const browser = await chromium.launch();
const sizes = {
  iphone: { viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  ipad: { viewport: { width: 1032, height: 1376 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

for (const [dev, ctx] of Object.entries(sizes)) {
  const page = async () => { const p = await (await browser.newContext(ctx)).newPage(); p.on("dialog", (d) => d.accept()); return p; };
  const act = (p, a, v) => p.click(v == null ? `[data-act="${a}"]` : `[data-act="${a}"][data-v="${v}"]`);
  const shot = async (p, name) => { await p.waitForTimeout(600); await p.screenshot({ path: `${SHOTS}/${dev}-${name}.png` }); log(`${dev}-${name}`); };
  const scoreOne = async (p, i, v) => { await act(p, "who", i); await act(p, "score", v); };

  const member = await page();
  await member.goto(APP); await member.waitForSelector('[data-act="go-signin"]', { timeout: 30000 });
  await act(member, "go-signin");
  await member.fill("#email", "member@example.com"); await member.fill("#password", "pass-M-123");
  await act(member, "sign-in");
  await member.waitForSelector('[data-act="new-round"]', { timeout: 30000 });

  const newRound = async (p, guests) => {
    await act(p, "new-round");
    await act(p, "go-course");
    await p.waitForSelector('[data-act="pick-saved"]', { timeout: 30000 });
    await p.locator('[data-act="pick-saved"]').first().click();
    await p.waitForSelector('[data-act="tee"]'); await act(p, "tee", 0);
    await act(p, "go-players");
    for (const n of guests) { await p.fill("#guest", n); await act(p, "add-guest"); }
  };

  /* 1. a round scored one golfer at a time, six holes in */
  await newRound(member, GOLFERS);
  await act(member, "tee-off");
  await member.waitForSelector('[data-act="who"]', { timeout: 20000 });
  for (let h = 0; h < 6; h++) {
    for (let i = 0; i < 4; i++) await scoreOne(member, i, PLAY[i][h]);
    await act(member, "next");
  }
  await scoreOne(member, 0, 3);
  await act(member, "who", 1);
  await shot(member, "02-one-golfer");

  /* 2. let others follow: the code */
  await act(member, "menu");
  await act(member, "follow-start");
  await member.waitForSelector(".bigcode", { timeout: 20000 });
  const code = (await member.locator(".bigcode").innerText()).replace(/\s/g, "");
  await shot(member, "03-follow-code");
  await member.click('[data-act="follow-back"]');
  await member.waitForSelector('[data-act="who"]');

  /* 3. a follower's live view */
  const fan = await page();
  await fan.goto(`${APP}&follow=${code}`);
  await fan.waitForFunction(() => document.body.innerText.includes("Following"), null, { timeout: 30000 });
  await scoreOne(member, 1, 4);
  await fan.waitForFunction(() => /Thru 7\b/.test(document.body.innerText), null, { timeout: 45000 });
  await shot(fan, "04-follower-live");

  /* 4. all four together */
  await act(member, "menu"); await act(member, "switch-entry");
  await member.waitForSelector('[data-act="plus"]', { timeout: 20000 });
  await shot(member, "05-all-four");

  /* 5. the whole card */
  await act(member, "menu"); await act(member, "card");
  await shot(member, "06-whole-card");

  /* 6. the caddie keeps the card: a second round with a caddie */
  await member.goto(APP); await member.waitForSelector('[data-act="new-round"]', { timeout: 30000 });
  await newRound(member, GOLFERS);
  await act(member, "caddie-start");
  await member.waitForSelector(".bigcode", { timeout: 20000 });
  const ccode = (await member.locator(".bigcode").innerText()).replace(/\s/g, "");
  const cad = await page();
  await cad.goto(`${APP}&caddie=${ccode}`); await cad.waitForSelector("#caddiecode", { timeout: 30000 });
  await act(cad, "caddie-join");
  await cad.waitForSelector('[data-act="score"]', { timeout: 30000 });
  for (let h = 0; h < 3; h++) {
    for (let i = 0; i < 4; i++) await scoreOne(cad, i, PLAY[i][h]);
    await act(cad, "next");
  }
  await scoreOne(cad, 0, 4);
  await act(cad, "who", 1);
  await cad.waitForFunction(() => document.body.innerText.includes("Sent to the golfer"), null, { timeout: 30000 });
  await shot(cad, "01-caddie-scoring");
  await member.waitForFunction(() => document.body.innerText.includes("last score at"), null, { timeout: 30000 });
  await shot(member, "07-caddie-live");

  /* 7. reading a club scorecard from a picture */
  const solo = await page();
  await solo.goto(APP); await solo.waitForSelector('[data-act="go-signin"]', { timeout: 30000 });
  await act(solo, "go-signin");
  await solo.fill("#email", "member@example.com"); await solo.fill("#password", "pass-M-123");
  await act(solo, "sign-in");
  await solo.waitForSelector('[data-act="new-round"]', { timeout: 30000 });
  await act(solo, "new-round"); await act(solo, "go-course");
  await solo.waitForSelector('[data-act="manual"]', { timeout: 30000 });
  await act(solo, "manual");
  await solo.waitForSelector("#scanfile", { state: "attached", timeout: 20000 });
  await shot(solo, "08-course-from-picture");
}

await browser.close();
console.log("ALL PICTURES TAKEN");
