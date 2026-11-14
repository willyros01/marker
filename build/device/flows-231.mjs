/* The Scorecard 2.31.1 (Willy, 6 Nov 2026): the cases found testing 2.31.0,
 * on the real iPhone simulator and Android emulator. Shared by both:
 *   ctx.start()   a fresh install, started, Terms accepted
 *   ctx.link(url) hands a link to the running app the way the phone does
 * Each flow checks the screen AND the test database. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { put, invitation, getDoc, accountByEmail, signUp, W, R1 } from "./seed.mjs";

async function golfer(id, name) {
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  await put(`golfers/${id}`, { name, nameKey: key, linkedUid: null, groups: ["G1"] });
  await put(`golferNames/${key}`, { golferId: id, name });
  await put(`associations/G1/roster/${id}`, { golferId: id });
  await put(`associations/G1/directory/${id}`, { golferId: id, displayName: name, handicapIndex: null });
}
async function signIn(d, who) {
  await d.waitApp(/Sign in/); await d.fill('[name="email"]', who.email); await d.fill('[name="password"]', who.password);
  /* Signed in, in whichever group opens first (the owner lands in PUBLIC). */
  await d.press('[data-act="sign-in"]'); await d.waitApp(/Enter[\s\S]*Summary/, 45000); await d.sleep(2500);
}
async function sheetOpen(d) { return d.js(`(() => { const s = document.getElementById("sheet"); return !!(s && !s.hidden); })()`); }
async function joinAs(d, email, password, golferId, snap) {
  if (await sheetOpen(d)) throw new Error("a box covers the welcome screen: " + (await d.js(`document.getElementById("sheet").innerText`)).replace(/\s+/g, " ").slice(0, 120));
  await d.fill('[name="email"]', email); await d.fill('[name="password"]', password); await d.fill('[name="password-again"]', password);
  await d.press('[data-act="create-account"]');
  for (let i = 0; i < 45; i++) {
    const t = await d.appText();
    if (/Joining as/.test(t) && /accept-named/.test(await d.js(`document.body.innerHTML`))) { await d.press('[data-act="accept-named"]'); }
    const acct = await accountByEmail(email);
    if (acct && (await getDoc(`associations/G1/members/${acct.localId}`))) break;
    await d.sleep(1000);
  }
  await d.sleep(1500); snap("joined");
  const acct = await accountByEmail(email);
  const m = acct && await getDoc(`associations/G1/members/${acct.localId}`);
  if (!m || m.golferId !== golferId) throw new Error(`membership not as expected: ${JSON.stringify(m)}`);
  const g = await getDoc(`golfers/${golferId}`);
  if (!g || g.linkedUid !== acct.localId) throw new Error("the golfer is not linked to the new account");
}

export async function flows231(ctx) {
  const { d, flow, start, link, snap } = ctx;
  const P = ctx.prefix;

  await flow(`${P}4`, "item 1: Rex (plays as his own golfer) is signed in; an invitation for Jay arrives: signed out by itself, no question; Jay joins", async () => {
    await start(); await signIn(d, R1); snap("rex-signed-in");
    await link(await invitation("gJ", "Jay Unjoined"));
    await d.waitApp(/You.re invited/, 40000); snap("signed-out-by-itself");
    if (!/this invitation is for someone else/.test(await d.appText())) throw new Error("no message says why it signed out");
    await joinAs(d, "jay@example.com", "jay-pass-1", "gJ", snap);
  });

  await flow(`${P}5`, "item 8: the group owner (no golfer of his own) is signed in; invitation; 'No, it's for someone else': no box over Join; the new person joins", async () => {
    await golfer("gK", "Kim Newcomer");
    await start(); await signIn(d, W);
    await link(await invitation("gK", "Kim Newcomer"));
    await d.waitApp(/Is this invitation for you\?/, 40000); snap("is-this-for-you");
    await d.press('[data-act="link-not-me"]');
    await d.waitApp(/You.re invited/, 30000); await d.sleep(2500); snap("welcome-no-box");
    await joinAs(d, "kim@example.com", "kim-pass-1", "gK", snap);
  });

  await flow(`${P}6`, "item 7: signed in with a box open; an invitation link arrives: the box closes and the link's screen shows", async () => {
    await golfer("gM", "Mia Later");
    await start(); await signIn(d, W);
    await d.js(`(() => { const s = document.getElementById("sheet"); s.innerHTML = '<div class="sheet-body"><h2>Invitation</h2></div>'; s.hidden = false; return true; })()`);
    snap("box-open");
    await link(await invitation("gM", "Mia Later"));
    await d.waitApp(/Is this invitation for you\?|You.re invited/, 40000); snap("link-screen");
    if (await sheetOpen(d)) throw new Error("the box still covers the link's screen");
  });

  await flow(`${P}7`, "item 11: applying with a wrong email: a pop-up in the middle stays until OK; then the email box is outlined", async () => {
    await start();
    await d.press('[data-act="show-choose"]'); await d.press('[data-act="show-apply"]');
    await d.waitApp(/Full name/i);
    await d.fill('[name="apply-name"]', "Format Tester"); await d.fill('[name="apply-email"]', "format.tester-at-example.com");
    await d.check('[name="ap-agree"]'); await d.press('[data-act="submit-application"]');
    await d.waitApp(/That email does not look right/, 20000); snap("pop-up");
    if (!(await d.js(`!!document.querySelector("#popmsg:not([hidden]) [data-pop-ok]")`))) throw new Error("not the pop-up with OK");
    await d.press("[data-pop-ok]"); await d.sleep(1200); snap("after-ok");
    if (await d.js(`!document.getElementById("popmsg").hidden`)) throw new Error("the pop-up did not close with OK");
    if (!(await d.js(`document.querySelector('[name="apply-email"]').classList.contains("needs-fix")`))) throw new Error("the email box is not outlined");
  });

  /* Willy, 13 Nov 2026: whoever plays only in the Public group and deletes
     their account is deleted from it for good (the deletion job; 30-day
     backup). Tapped through on the phone, then the job runs as it does live. */
  await flow(`${P}8`, "Public only: Pia deletes her account on the phone (Summary, Delete my account); after the deletion job her golfer, name and rounds are gone, with a backup", async () => {
    const site = ["sca", "sc"].map((s) => path.resolve(s)).find((s) => fs.existsSync(`${s}/.github/scripts/finish-deletions.sh`));
    if (!site) throw new Error("the deletion job of the version under test was not found");
    const job = `${site}/.github/scripts/finish-deletions.sh`;
    if (!/5b\. The Public group/.test(fs.readFileSync(job, "utf8"))) throw new Error("this version's deletion job has no Public step");
    const pia = { email: "pia@example.com", password: "pia-pass-1" };
    const uid = await signUp(pia.email, pia.password);
    await put("golfers/gPia", { name: "Pia Public", nameKey: "pia-public", linkedUid: uid, groups: ["PUBLIC"], handicapIndex: 18 });
    await put("golferNames/pia-public", { golferId: "gPia", name: "Pia Public" });
    await put("associations/PUBLIC/roster/gPia", { golferId: "gPia" });
    await put("associations/PUBLIC/directory/gPia", { golferId: "gPia", displayName: "Pia Public", handicapIndex: 18 });
    await put(`associations/PUBLIC/members/${uid}`, { uid, role: "member", displayName: "Pia Public", golferId: "gPia" });
    await put(`userGroups/${uid}/groups/PUBLIC`, { assocId: "PUBLIC", name: "PUBLIC" });
    await put(`accountEmails/${pia.email}`, { at: "seeded" });
    await put("associations/PUBLIC/rounds/r-pia1", { id: "r-pia1", golferId: "gPia", assocId: "PUBLIC", date: "2026-11-01", differential: 20, gross: 95 });
    await start(); await signIn(d, pia); snap("pia-signed-in");
    await d.press('button[data-tab="summary"]'); await d.sleep(1200);
    await d.press('[data-act="delete-account"]');
    await d.waitApp(/Only in the Public group:[\s\S]*deleted too/, 20000); snap("delete-warning");
    await d.fill('[name="delete-password"]', pia.password);
    await d.press('[data-del="go"]');
    /* The warning itself says "deleted", so wait for the account to be gone,
       not for a word on the screen. */
    for (let i = 0; i < 60 && (await accountByEmail(pia.email)); i++) await d.sleep(1000);
    await d.sleep(2000); snap("after-delete");
    if (await accountByEmail(pia.email)) throw new Error("the sign-in still exists 60 seconds after Delete my account");
    if (!/Sign in/.test(await d.appText())) throw new Error("the app is not back at Sign in after the deletion");
    const run = spawnSync("bash", [job], { encoding: "utf8", env: { ...process.env, ACCESS_TOKEN: "owner", PROJECT: "demo-scorecard",
      FS_BASE: "http://127.0.0.1:8080/v1", AUTH_BASE: "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1", MIN_AGE_SECONDS: "0" } });
    if (run.status !== 0) throw new Error(`the deletion job failed: ${(run.stdout + run.stderr).slice(-300)}`);
    const left = [];
    if (await getDoc("golfers/gPia")) left.push("the golfer");
    if (await getDoc("associations/PUBLIC/roster/gPia")) left.push("the Public list place");
    if (await getDoc("associations/PUBLIC/directory/gPia")) left.push("the ranking entry");
    if (await getDoc("associations/PUBLIC/rounds/r-pia1")) left.push("the round");
    if (await getDoc("golferNames/pia-public")) left.push("the name");
    if (left.length) throw new Error(`still there after the job: ${left.join(", ")}`);
    if (!/deleted from the Public group for good \(1 rounds\); backup kept 30 days/.test(run.stdout)) throw new Error(`the job did not report the backup: ${run.stdout.slice(-300)}`);
  });
}
