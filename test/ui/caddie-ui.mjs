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
const signup = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "willy@example.com", password: "pass-W-123", returnSecureToken: true }),
});
const memberUid = (await signup.json()).localId;
const holes = [4, 5, 3, 4, 4, 5, 3, 4, 4, 4, 3, 5, 4, 4, 3, 4, 5, 4].map((par, i) => ({ par, yards: 300 + i * 10, si: [7, 1, 17, 3, 11, 5, 15, 9, 13, 8, 18, 2, 10, 4, 16, 12, 6, 14][i] }));
await fs.commit([
  setWrite(fs, "markerCourses/123", { providerId: "123", name: "Royal Ontario Golf Club", where: "Milton, ON", tees: [{ name: "White (M)", rating: 70.1, slope: 125, par: 72, holes }] }),
  setWrite(fs, "markerConfig/public", { workerUrl: "http://127.0.0.1:8788", version: "test" }),
  /* 1.1.0: a Scorecard group with a game today, for following a whole game */
  setWrite(fs, "associations/G1", { name: "Golfing Buddies", ownerUid: memberUid }),
  setWrite(fs, `associations/G1/members/${memberUid}`, { uid: memberUid, role: "owner" }),
  setWrite(fs, "associations/G1/games/gm1", { name: "Thursday Skins", date: new Date().toISOString().slice(0, 10), createdBy: memberUid }),
]);

const browser = await chromium.launch();
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 };
const member = await (await browser.newContext(phone)).newPage();
const cad = await (await browser.newContext(phone)).newPage();
for (const p of [member, cad]) p.on("dialog", (d) => d.accept());
const shot = (p, name) => p.screenshot({ path: `${SHOTS}/${name}.png` });
let fails = 0;
/* On a failure, a picture of the page first, then the error (1.1.0). */
async function act(p, a, v) {
  try { await p.click(v == null ? `[data-act="${a}"]` : `[data-act="${a}"][data-v="${v}"]`); }
  catch (e) { await shot(p, `FAIL-${++fails}-${a}`).catch(() => {}); console.log("page text:", (await p.locator("#app").innerText().catch(() => "")).slice(0, 600)); throw e; }
}
async function until(p, fn, what) {
  try { await p.waitForFunction(fn, null, { timeout: 45000 }); }
  catch (e) { await shot(p, `FAIL-${++fails}-wait`).catch(() => {}); console.log("waiting for:", what, "\npage text:", (await p.locator("#app").innerText().catch(() => "")).slice(0, 800)); throw e; }
}
const text = (p) => p.locator("#app").innerText();

async function memberToCode() {
  await act(member, "new-round");
  await act(member, "go-course");
  await member.waitForSelector('[data-act="pick-saved"]', { timeout: 20000 });
  await member.locator('[data-act="pick-saved"]').first().click();
  await member.waitForSelector('[data-act="tee"]');
  await act(member, "tee", 0);
  await act(member, "go-players");
  await member.waitForFunction(() => !document.body.innerText.includes("Loading golfers") && !!document.querySelector("#guest"), null, { timeout: 20000 });   /* the golfer list redraws the screen when it arrives */
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
await member.waitForFunction(() => !document.body.innerText.includes("Loading golfers") && !!document.querySelector("#guest"), null, { timeout: 20000 });   /* the golfer list redraws the screen when it arrives */
for (const n of ["Ana Cruz", "Ben Reyes"]) { await member.fill("#guest", n); await act(member, "add-guest"); }
await act(member, "tee-off");
await member.waitForSelector('[data-act="menu"]');
await act(member, "menu");
await act(member, "follow-start");
await member.waitForSelector(".bigcode", { timeout: 20000 });
const fcode = (await member.locator(".bigcode").innerText()).replace(/\s/g, "");
ok(/^[1-9]\d{5}$/.test(fcode), `the member gets a six-number follow code (${fcode})`);
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
await fan.waitForFunction(() => /Thru 1\b/.test(document.body.innerText), null, { timeout: 45000 });
const row1 = await fan.locator(".crow").nth(1).innerText();
ok(/\b3\b[\s\S]*\b6\b/.test(row1.split("\n").slice(4).join(" ")), `the member's scores reach the follower by themselves (hole 1: ${row1.replace(/\s+/g, " ")})`);
await shot(fan, "13-follower-live");

/* 9. a follow link opens the card straight away */
const fan2 = await (await browser.newContext(phone)).newPage();
await fan2.goto(`${APP}&follow=${fcode}`);
await fan2.waitForFunction(() => document.body.innerText.includes("Following"), null, { timeout: 20000 });
ok(true, "the follow link opens the card directly");

/* 10. a follow link that can't open shows the Follow screen with the code and the reason, never a silent first screen */
const fan3 = await (await browser.newContext(phone)).newPage();
await fan3.goto(`${APP}&follow=ZZZZ22`);
await fan3.waitForSelector('[role="alert"]', { timeout: 20000 });
ok((await fan3.inputValue("#followcode")) === "ZZZZ22", "a failed follow link leaves the code filled in on the Follow screen");
ok(/doesn't work/.test(await fan3.locator('[role="alert"]').innerText()), "and says why");

/* 11. following a whole game (1.1.0): the card goes live by itself at tee-off; one code for the game */
await member.goto(APP); await member.waitForSelector('[data-act="new-round"]', { timeout: 20000 });
await act(member, "new-round");
await member.waitForSelector('[data-act="game"][data-v="gm1"]', { timeout: 20000 });
await act(member, "game", "gm1");
await act(member, "go-course");
await member.waitForSelector('[data-act="pick-saved"]', { timeout: 20000 });
await member.locator('[data-act="pick-saved"]').first().click();
await member.waitForSelector('[data-act="tee"]'); await act(member, "tee", 0);
await act(member, "go-players");
await member.waitForFunction(() => !document.body.innerText.includes("Loading golfers") && !!document.querySelector("#guest"), null, { timeout: 20000 });   /* the golfer list redraws the screen when it arrives */
ok(await member.locator("main .caddie-choice").count() === 1, "Let my caddie score is on the Who's playing screen itself, not under Tee off");
await shot(member, "14-whos-playing-caddie");
for (const n of ["Cora Diaz", "Dan Kim"]) { await member.fill("#guest", n); await act(member, "add-guest"); }
await act(member, "tee-off");
await member.waitForSelector('[data-act="menu"]');
ok(/Thursday Skins/.test(await member.locator(".gamepill").innerText()), "the Game button on the hole shows the game's name");
await shot(member, "15-hole-with-game-button");
await act(member, "game-tap");
await member.waitForSelector(".bigcode", { timeout: 20000 });
const gcode = (await member.locator(".bigcode").innerText()).replace(/\s/g, "");
ok(/^[1-9]\d{5}$/.test(gcode) && /thursday skins/i.test(await text(member)), `the member gets the game's code (${gcode})`);
await shot(member, "16-game-code");
await member.click('[data-act="follow-back"]');
await member.waitForSelector('[data-act="score"], [data-act="plus"]');
for (let i = 0; i < 2; i++) { if (await member.locator('[data-act="who"]').count()) { await act(member, "who", i); await act(member, "score", i === 0 ? 3 : 5); } else { await member.locator(`[data-act="plus"][data-v="${i}"]`).click(); } }
const gfan = await (await browser.newContext(phone)).newPage();
await gfan.goto(`${APP}&follow=${gcode}`);
await until(gfan, () => document.body.innerText.includes("Following the game"), "the game's leaderboard");
await until(gfan, () => document.querySelectorAll(".board-row:not(.hd)").length === 2 && /Cora Diaz/.test(document.body.innerText), "two golfers on the leaderboard");
ok(true, "the game's follower sees the leaderboard with the card's golfers");
await until(gfan, () => /−1|\+1/.test(document.querySelector(".board").innerText), "scores on the leaderboard");
ok(true, "the scores reach the game's leaderboard by themselves");
await shot(gfan, "17-game-leaderboard");
await gfan.locator(".board-row:not(.hd)").first().click();
await gfan.waitForSelector('[data-act="game-back"]');
await shot(gfan, "18-game-card");
await act(gfan, "game-back");

/* 12. handing the card to a caddie in the middle of the round (1.1.0) */
await act(member, "menu");
await act(member, "caddie-mid");
await member.waitForSelector(".bigcode", { timeout: 20000 });
const mid = (await member.locator(".bigcode").innerText()).replace(/\s/g, "");
ok(/^[A-Z2-9]{6}$/.test(mid), `the member gets a caddie code mid-round (${mid})`);
await caddieJoins(mid);
ok(/hole 2|Hole 2/i.test(await text(cad)), "the caddie joins on hole 2, after the scores so far");
await scoreHole(4);
await until(gfan, () => [...document.querySelectorAll(".board-row:not(.hd) .th")].some((e) => e.textContent.trim() === "2"), "the caddie's hole 2 on the leaderboard");
ok(true, "the caddie's scores reach the game's leaderboard, on the same card (still two golfers)");
await shot(gfan, "19-game-after-caddie");

/* 13. starting a game in The Marker and joining it with its code (Willy, 5 Nov 2026, option A) */
const startRound = async (p, guests) => {
  await p.goto(APP); await p.waitForSelector('[data-act="new-round"]', { timeout: 20000 });
  await act(p, "new-round");
  await act(p, "go-course");
  await p.waitForSelector('[data-act="pick-saved"]', { timeout: 20000 });
  await p.locator('[data-act="pick-saved"]').first().click();
  await p.waitForSelector('[data-act="tee"]'); await act(p, "tee", 0);
  await act(p, "go-players");
  await p.waitForFunction(() => !document.body.innerText.includes("Loading golfers") && !!document.querySelector("#guest"), null, { timeout: 20000 });   /* the golfer list redraws the screen when it arrives */
  for (const n of guests) { await p.fill("#guest", n); await act(p, "add-guest"); }
};
await startRound(member, ["Eve Lim", "Fay Ong"]);
await act(member, "game-start-open");
await member.fill("#gamename", "Saturday Medal");
await act(member, "game-create");
await until(member, () => /game code \d{3} \d{3}/.test(document.body.innerText), "the new game's code on Who's playing?");
const scode = (await text(member)).match(/game code (\d{3}) (\d{3})/i).slice(1).join("");
ok(/^[1-9]\d{5}$/.test(scode), `the member starts a game in The Marker and gets its code (${scode})`);
const game = (await fs.query("associations/G1", "games", [], 20)).find((g) => g.data.name === "Saturday Medal");
ok(game && game.data.createdVia === "marker" && game.data.courseId, "it is a real game in The Scorecard, with its course");
await shot(member, "20-game-started");
await act(member, "tee-off");
await member.waitForSelector('[data-act="menu"]');
/* a second scorer (same account, another phone) joins with the code */
const other = await (await browser.newContext(phone)).newPage();
other.on("dialog", (d) => d.accept());
await other.goto(APP); await other.waitForSelector('[data-act="go-signin"]', { timeout: 20000 });
await act(other, "go-signin");
await other.fill("#email", "willy@example.com"); await other.fill("#password", "pass-W-123");
await act(other, "sign-in");
await other.waitForSelector('[data-act="new-round"]', { timeout: 20000 });
await startRound(other, ["Gil Tan", "Hal Yu"]);
await act(other, "game-join-open");
await other.fill("#gamecode", scode.slice(0, 3) + " " + scode.slice(3));
await act(other, "game-join");
await until(other, () => /Joined Saturday Medal/.test(document.body.innerText), "joined the game");
await shot(other, "21-game-joined");
await act(other, "tee-off");
await other.waitForSelector('[data-act="menu"]');
await act(other, "game-tap");
await other.waitForSelector(".bigcode", { timeout: 20000 });
ok((await other.locator(".bigcode").innerText()).replace(/\s/g, "") === scode, "the joined card shows the same game code");
const sfan = await (await browser.newContext(phone)).newPage();
await sfan.goto(`${APP}&follow=${scode}`);
await until(sfan, () => document.querySelectorAll(".board-row:not(.hd)").length === 4 && /Gil Tan/.test(document.body.innerText) && /Eve Lim/.test(document.body.innerText), "both cards on the started game's leaderboard");
ok(true, "both foursomes are on the game's leaderboard");
await shot(sfan, "22-started-game-leaderboard");

/* 14. joining a game from the Menu, mid-round (Willy, 5 Nov 2026: "from the menu wherever I am") */
const third = await (await browser.newContext(phone)).newPage();
third.on("dialog", (d) => d.accept());
await third.goto(APP); await third.waitForSelector('[data-act="go-signin"]', { timeout: 20000 });
await act(third, "go-signin");
await third.fill("#email", "willy@example.com"); await third.fill("#password", "pass-W-123");
await act(third, "sign-in");
await third.waitForSelector('[data-act="new-round"]', { timeout: 20000 });
await startRound(third, ["Ivy Wu"]);
await act(third, "tee-off");
await third.waitForSelector('[data-act="menu"]');
ok((await third.locator(".gamepill").innerText()).trim() === "No game", "a card not in a game says No game at the top of the hole");
await shot(third, "23-hole-no-game");
await act(third, "game-tap");
await third.fill("#gamecode", "999999");
await act(third, "game-join");
await until(third, () => { const b = document.querySelector('[data-act="game-join"]'); const m = b && b.nextElementSibling; return !!m && m.classList.contains("bad") && /not a game code/i.test(m.textContent); }, "the refusal right under the Join button");
ok(true, "a wrong code is answered right under the Join button");
await shot(third, "24-join-refused");
await third.fill("#gamecode", scode);
await act(third, "game-join");
await third.waitForSelector(".bigcode", { timeout: 20000 });
ok((await third.locator(".bigcode").innerText()).replace(/\s/g, "") === scode && /Joined Saturday Medal/.test(await text(third)), "joined mid-round from the Menu: the game code shows");
await shot(third, "25-joined-mid-round");
await act(third, "game-board");
await until(third, () => document.querySelectorAll(".board-row:not(.hd)").length === 5 && /Ivy Wu/.test(document.body.innerText), "the mid-round card on the leaderboard");
ok(true, "the card that joined mid-round is on the game's leaderboard (five golfers)");
await shot(third, "26-own-leaderboard");
await act(third, "game-own-back");
await third.waitForSelector('[data-act="menu"]');
ok(/Saturday Medal/.test(await third.locator(".gamepill").innerText()), "after joining, the Game button shows the game's name");
await act(third, "menu");
ok(await third.locator('[data-act="follow-start"]').count() === 0 && await third.locator('[data-act="game-here"]').count() === 0, "the Menu has no game buttons and no separate card code in a game");
await act(third, "back-play");

/* 15. a golfer joins on the 3rd hole (Willy, 5 Nov 2026) */
const scoreHere = async (p, i, v) => {
  if (await p.locator('[data-act="who"]').count()) { await act(p, "who", i); await act(p, "score", v); }
  else await p.locator(`[data-act="plus"][data-v="${i}"]`).click();
};
await third.waitForSelector('[data-act="score"], [data-act="plus"]');
await scoreHere(third, 0, 4); await act(third, "next");
await scoreHere(third, 0, 5); await act(third, "next");
await act(third, "late-open");
await third.waitForFunction(() => !document.body.innerText.includes("Loading") && !!document.querySelector("#lateguest"), null, { timeout: 20000 });
await shot(third, "27-add-a-golfer");
await third.locator('[data-act="late-pick"]').first().click();
await third.waitForSelector('[data-act="score"], [data-act="plus"]');
ok(/from hole 3/.test(await text(third)) && (await third.locator('[data-act="who"]').count() === 2 || await third.locator(".player").count() === 2), "a group member is added on hole 3");
await scoreHere(third, 1, 5);
ok(!/to go/.test(await third.locator("footer").innerText()), "hole 3 is complete with both golfers' scores");
await act(third, "prev");
ok(/no score needed here|–/.test(await text(third)) && !/to go/.test(await third.locator("footer").innerText()), "hole 2 needs no score from the late golfer");
await act(third, "next");
await until(sfan, () => document.querySelectorAll(".board-row:not(.hd)").length === 6, "the late golfer on the game's leaderboard");
ok(true, "the late golfer reaches the game's leaderboard");
await shot(third, "28-late-golfer-on-hole-3");

await browser.close();
console.log("ALL PASSED");
