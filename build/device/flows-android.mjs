/* Device flows on the Android emulator against the Firebase EMULATORS.
 * Each flow starts from a fresh install, drives the app the way a person does,
 * screenshots every step, and checks the result in the test database. */
import fs from "node:fs";
import * as d from "./adb.mjs";
import { seed, invitation, approvalLink, getDoc, accountByEmail, R1 } from "./seed.mjs";
const OUT = process.argv[2] || "out"; const APK = process.argv[3]; const PKG = "io.github.willyros01.scorecard";
fs.mkdirSync(OUT, { recursive: true });
const report = (s) => { console.log(s); fs.appendFileSync(`${OUT}/report.txt`, s + "\n"); };
let step = 0, pass = 0, fail = 0;
const snap = (name) => { const f = `${String(++step).padStart(2, "0")}-${name}.png`; d.shot(`${OUT}/${f}`); report(`    screenshot ${f}  (in front: ${d.front()})`); };
async function flow(id, what, fn) {
  report(`\n${id}  ${what}`);
  try { await fn(); pass++; report(`PASS  ${id}`); }
  catch (e) {
    fail++; try { snap(`${id}-failed`); } catch {}
    report(`FAIL  ${id}  —  ${String(e.message || e).slice(0, 600)}`);
    try { report("    last app messages:\n" + d.logcat().split("\n").slice(-25).map((l) => "      " + l).join("\n")); } catch {}
  }
  try { d.clearLog(); } catch {}
}
async function fresh() { d.reinstall(PKG, APK); await d.sleep(2000); }
async function acceptTerms() {
  await d.waitApp(/Terms of Use/); snap("terms");
  await d.check("[data-terms-tick]"); await d.press("#termsAccept");
  await d.sleep(1500);
  if (/Please read these terms/.test(await d.appText())) throw new Error("the Terms of Use did not go away after Accept");
}
const inFront = () => { const f = d.front(); if (!f.startsWith(PKG)) throw new Error(`the app is not in front: ${f}`); };

await seed();

await flow("F1", "Invitation for Ivy on a fresh phone: Terms, create account, 'Yes, that's me — join', lands in Saturday Group", async () => {
  await fresh();
  const link = await invitation("gI", "Ivy Invitee");
  d.view(link); await d.sleep(6000); inFront();
  await acceptTerms();
  await d.waitApp(/You.re invited|Create your account/); snap("invited-create-account");
  await d.fill('[name="email"]', "ivy@example.com"); await d.fill('[name="password"]', "ivy-pass-1"); await d.fill('[name="password-again"]', "ivy-pass-1");
  await d.press('[data-act="create-account"]');
  await d.waitApp(/Joining as[\s\S]*Ivy Invitee/, 45000); snap("joining-as-ivy");
  await d.press('[data-act="accept-named"]');
  await d.waitApp(/Saturday Group/i, 45000);
  for (let i = 0; i < 20 && /Joining the group/.test(await d.appText()); i++) await d.sleep(1000);
  await d.sleep(1000); snap("in-the-group");
  const acct = await accountByEmail("ivy@example.com");
  if (!acct) throw new Error("no account was created");
  const m = await getDoc(`associations/G1/members/${acct.localId}`);
  if (!m || m.golferId !== "gI") throw new Error(`membership not as expected: ${JSON.stringify(m)}`);
  report("    database: Ivy is a member of Saturday Group, linked to her golfer");
});

await flow("F2", "Application on a fresh phone (Auto): apply in the app, open the approval link, Create your password, lands in the public group", async () => {
  await fresh(); d.launch(PKG); await d.sleep(5000);
  await acceptTerms();
  await d.press('[data-act="show-choose"]'); await d.press('[data-act="show-apply"]');
  await d.waitApp(/Full name/i); snap("apply-form");
  await d.fill('[name="apply-name"]', "Pat Applicant"); await d.fill('[name="apply-email"]', "pat.applicant@example.com");
  await d.check('[name="ap-agree"]');
  await d.press('[data-act="submit-application"]');
  try { await d.waitApp(/Check your email/, 30000); }
  catch (e) { snap("after-send"); throw new Error(`after Send my application: ${e.message}`); }
  snap("check-your-email");
  const link = await approvalLink("pat.applicant@example.com");
  if (!link) throw new Error("no sign-in email was sent");
  d.view(link); await d.sleep(6000); inFront();
  await d.waitApp(/Create your password/, 30000); snap("create-your-password");
  await d.fill('[name="password"]', "pat-pass-1"); await d.fill('[name="password-again"]', "pat-pass-1");
  await d.press('[data-act="finish-apply"]');
  await d.waitApp(/public group|Welcome/i, 45000); await d.sleep(2000); snap("in-the-public-group");
  const acct = await accountByEmail("pat.applicant@example.com");
  if (!acct) throw new Error("no account was created");
  if (!(await getDoc(`associations/PUBLIC/members/${acct.localId}`))) throw new Error("not a member of the public group");
  report("    database: Pat is a member of the public group");
});

await flow("F3", "Someone else (Rex) is signed in; an invitation for Jay arrives: the app asks whether it is for him", async () => {
  await fresh(); d.launch(PKG); await d.sleep(5000);
  await acceptTerms();
  await d.waitApp(/Sign in/); await d.fill('[name="email"]', R1.email); await d.fill('[name="password"]', R1.password);
  await d.press('[data-act="sign-in"]');
  await d.waitApp(/Saturday Group/i, 45000); snap("rex-signed-in");
  d.view(await invitation("gJ", "Jay Unjoined")); await d.sleep(6000); inFront();
  await d.waitApp(/Is this invitation for you|for a new person/, 30000); snap("is-this-for-you");
});

report(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
