/* Caddie scoring, end to end in two browsers (member and caddie), against the
 * Firebase emulators and the worker stand-in (caddie-server.mjs). Run by
 * test/ui/run-caddie.sh. Screenshots go to $SHOTS. */
import { chromium } from "playwright";
import { client, setWrite } from "../../worker/src/firestore.js";

const APP = "http://127.0.0.1:8099/?emulators";
const SHOTS = process.env.SHOTS || "/tmp/caddie-shots";
const fs = client({ project: "demo-marker", base: "http://127.0.0.1:8080/v1", token: async () => "owner" });
const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("ok -", m); };

/* seed: a member account, a course with 18 holes, the worker's address */
await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "willy@example.com", password: "pass-W-123", returnSecureToken: true }),
});
const holes = [4, 5, 3, 4, 4, 5, 3, 4, 4, 4, 3, 5, 4, 4, 3, 4, 5, 4].map((par, i) => ({ par, yards: 300 + i * 10, si: [7, 1, 17, 3, 11, 5, 15, 9, 13, 8, 18, 2, 10, 4, 16, 12, 6, 14][i] }));
await fs.commit([
  setWrite(fs, "markerCourses/123", { providerId: "123", name: "Royal Ontario Golf Club", where: "Milton, ON", tees: [{ name: "White (M)", rating: 70.1, slope: 125, par: 72, holes }] }),
  setWrite(fs, "markerConfig/public", { workerUrl: "http://127.0.0.1:8788", version: "test" }),
]);

const browser = await chromium.launch();
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 };
const member = await (await browser.newContext(phone)).newPage();
const cad = await (await browser.newContext(phone)).newPage();
for (const p of [member, cad]) p.on("dialog", (d) => d.accept());
const act = (p, a, v) => p.click(v == null ? `[data-act="${a}"]` : `[data-act="${a}"][data-v="${v}"]`);
const shot = (p, name) => p.screenshot({ path: `${SHOTS}/${name}.png` });
const text = (p) => p.locator("#app").innerText();

async function memberToCode() {
  await act(member, "new-round");
  await act(member, "go-course");
  await member.waitForSelector('[data-act="pick-saved"]', { timeout: 20000 });
  await member.locator('[data-act="pick-saved"]').first().click();
  await member.waitForSelector('[data-act="tee"]');
  await act(member, "tee", 0);
  await act(member, "go-players");
  for (const n of ["Ana Cruz", "Ben Reyes"]) { await member.fill("#guest", n); await act(member, "add-guest"); }
  await act(member, "caddie-start");
  await member.waitForSelector(".bigcode", { timeout: 20000 });
  return (await member.locator(".bigcode").innerText()).replace(/\s/g, "");
}
async function caddieJoins(code, typed) {
  await cad.goto(APP); await cad.waitForSelector('[data-act="caddie-open"]', { timeout: 20000 });
  await act(cad, "caddie-open");
  await cad.fill("#caddiecode", typed || code);
  await act(cad, "caddie-join");
  await cad.waitForSelector('[data-act="score"]', { timeout: 20000 });
}
async function scoreHole(v) {
  for (let i = 0; i < 2; i++) { await act(cad, "who", i); await act(cad, "score", v); }
}

/* 1. the member signs in and asks for a code */
await member.goto(APP); await member.waitForSelector('[data-act="go-signin"]', { timeout: 20000 });
await shot(member, "01-member-start");
await act(member, "go-signin");
await member.fill("#email", "willy@example.com"); await member.fill("#password", "pass-W-123");
await act(member, "sign-in");
await member.waitForSelector('[data-act="new-round"]', { timeout: 20000 });
ok(!(await member.locator('[data-act="caddie-open"]').count()), "a signed-in member's first screen has no Caddie icon");
const code = await memberToCode();
ok(/^[A-Z2-9]{6}$/.test(code), `the member gets a code (${code}) and a QR square`);
ok(await member.locator("svg.qr").count() === 1, "the QR square is shown");
await shot(member, "02-member-code");

/* 2. the caddie, with no account, joins with the code typed loosely */
await cad.goto(APP); await cad.waitForSelector('[data-act="caddie-open"]', { timeout: 20000 });
await shot(cad, "03-caddie-first-screen");
await caddieJoins(code, code.slice(0, 3).toLowerCase() + " " + code.slice(3));
ok((await text(cad)).includes("Joined"), "the caddie joins and sees the first hole");
await scoreHole(4);
await cad.waitForFunction(() => document.body.innerText.includes("Sent to the golfer"), null, { timeout: 15000 });
ok(true, "the caddie's phone says the scores reached the golfer");
await shot(cad, "04-caddie-scoring");

/* 3. the member sees the scores arrive */
await member.waitForFunction(() => document.body.innerText.includes("Caddie connected"), null, { timeout: 20000 });
await member.waitForFunction(() => document.body.innerText.includes("last score at"), null, { timeout: 20000 });
ok(true, "the member sees the caddie connected and the first scores");
await shot(member, "05-member-live");

/* 4. the caddie finishes the round and hands the card back */
for (let h = 2; h <= 18; h++) {
  await act(cad, "next");
  await scoreHole(h === 7 ? 5 : 4);
}
await act(cad, "finish");
await cad.waitForSelector('[data-act="caddie-handback"]');
ok(!(await cad.locator('[data-act="post"]').count()), "the caddie has no Post button");
await shot(cad, "06-caddie-finish");
await act(cad, "caddie-handback");
await cad.waitForFunction(() => document.body.innerText.includes("The card is with the golfer now"), null, { timeout: 15000 });
ok(true, "the caddie's phone confirms the card went back, and clears it");
await shot(cad, "07-caddie-done");

/* 5. the member gets the finished card to check */
await member.waitForFunction(() => document.body.innerText.includes("Your caddie has finished"), null, { timeout: 25000 });
const totals = await text(member);
ok(/\b73\b/.test(totals), "the member's card has every score (Ana: 73 with a 5 on hole 7)");
await shot(member, "08-member-finished");

/* 6. take over: the caddie's phone stops at once */
await act(member, "done");
await member.waitForSelector('[data-act="new-round"]');
const code2 = await memberToCode();
await caddieJoins(code2);
await scoreHole(4);
await member.waitForFunction(() => document.body.innerText.includes("Take over scoring myself"), null, { timeout: 20000 });
await act(member, "caddie-takeover");
await member.waitForSelector('[data-act="score"], [data-act="plus"]', { timeout: 20000 });
ok(true, "the member takes over and scores on their own phone");
await act(cad, "next"); await scoreHole(5);
await cad.waitForFunction(() => document.body.innerText.includes("taken the card back"), null, { timeout: 20000 });
ok(true, "the caddie's phone says the golfer has taken the card back");
await shot(cad, "09-caddie-taken-back");

/* 7. the old code no longer works */
/* the QR link opens the Join screen with the code already filled in */
await cad.goto(`${APP}&caddie=${code2}`); await cad.waitForSelector("#caddiecode", { timeout: 20000 });
ok((await cad.inputValue("#caddiecode")).replace(/\s/g, "") === code2, "the QR link opens the Join screen with the code filled in");
await act(cad, "caddie-join");
await cad.waitForFunction(() => document.body.innerText.includes("stopped working"), null, { timeout: 15000 });
ok(true, "the code stops working after the take-over");
await shot(cad, "10-caddie-code-stopped");

/* 8. following a card the member scores: read-only, live */
const fan = await (await browser.newContext(phone)).newPage();
fan.on("dialog", (d) => d.accept());
await member.goto(APP); await member.waitForSelector('[data-act="new-round"]', { timeout: 20000 });
await act(member, "new-round");
await act(member, "go-course");
await member.waitForSelector('[data-act="pick-saved"]', { timeout: 20000 });
await member.locator('[data-act="pick-saved"]').first().click();
await member.waitForSelector('[data-act="tee"]'); await act(member, "tee", 0);
await act(member, "go-players");
for (const n of ["Ana Cruz", "Ben Reyes"]) { await member.fill("#guest", n); await act(member, "add-guest"); }
await act(member, "tee-off");
await member.waitForSelector('[data-act="menu"]');
await act(member, "menu");
await act(member, "follow-start");
await member.waitForSelector(".bigcode", { timeout: 20000 });
const fcode = (await member.locator(".bigcode").innerText()).replace(/\s/g, "");
ok(/^[A-Z2-9]{6}$/.test(fcode), `the member gets a follow code (${fcode})`);
await shot(member, "11-member-follow-code");
await member.click('[data-act="follow-back"]');
await member.waitForSelector('[data-act="score"], [data-act="plus"]');
await fan.goto(APP); await fan.waitForSelector('[data-act="follow-open"]', { timeout: 20000 });
await shot(fan, "12-follower-first-screen");
await act(fan, "follow-open");
await fan.fill("#followcode", fcode);
await act(fan, "follow-join");
await fan.waitForFunction(() => document.body.innerText.includes("Following"), null, { timeout: 20000 });
ok(!(await fan.locator('[data-act="score"], [data-act="plus"], [data-act="jump"]').count()), "the follower sees the card read-only");
for (let i = 0; i < 2; i++) { if (await member.locator('[data-act="who"]').count()) { await act(member, "who", i); await act(member, "score", i === 0 ? 3 : 6); } else { await member.locator(`[data-act="plus"][data-v="${i}"]`).click(); } }
await fan.waitForFunction(() => /Updated at/.test(document.body.innerText) && /\b3\b/.test(document.body.innerText), null, { timeout: 40000 });
ok(true, "the member's scores reach the follower by themselves");
await shot(fan, "13-follower-live");

/* 9. a follow link opens the card straight away */
const fan2 = await (await browser.newContext(phone)).newPage();
await fan2.goto(`${APP}&follow=${fcode}`);
await fan2.waitForFunction(() => document.body.innerText.includes("Following"), null, { timeout: 20000 });
ok(true, "the follow link opens the card directly");

await browser.close();
console.log("ALL PASSED");
