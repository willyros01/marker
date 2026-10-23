/* The same journeys as on Android, on the iPhone simulator, against the
 * Firebase EMULATORS. Links are handed to the app the way iOS does it
 * (appUrlOpen), because the simulator on GitHub's machines does not
 * finish setting up web app-links; which app opens a real link is proven on
 * Android and by the website/Apple checks in the report. */
import fs from "node:fs";
import * as d from "./sim.mjs";
import { seed, invitation, approvalLink, getDoc, accountByEmail, R1 } from "./seed.mjs";
const OUT = process.argv[2] || "out"; const APP = process.argv[3]; const BID = "io.github.willyros01.scorecard";
fs.mkdirSync(OUT, { recursive: true });
const report = (s) => { console.log(s); fs.appendFileSync(`${OUT}/report.txt`, s + "\n"); };
let step = 200, pass = 0, fail = 0;
const snap = (name) => { const f = `${String(++step)}-${name}.png`; d.shot(`${OUT}/${f}`); report(`    screenshot ${f}`); };
/* Hands a link to the running app exactly as iOS's link delivery does (appUrlOpen). */
async function openLink(url) { const ok = await d.js(`globalThis.__testOpenLink(${JSON.stringify(url)})`); if (!ok) throw new Error("the app did not take the link"); await d.sleep(3000); }
async function flow(id, what, fn) {
  report(`\n${id}  ${what}`);
  try { await fn(); pass++; report(`PASS  ${id}`); }
  catch (e) { fail++; try { snap(`${id}-failed`); } catch {} report(`FAIL  ${id}  —  ${String(e.message || e).slice(0, 600)}`); }
  d.disconnect();
}
async function fresh() { d.disconnect(); d.terminate(BID); d.reinstall(BID, APP); await d.sleep(1500); }
async function acceptTerms() {
  await d.waitApp(/Terms of Use/, 40000); snap("terms");
  await d.check("[data-terms-tick]"); await d.press("#termsAccept"); await d.sleep(1500);
  if (/Please read these terms/.test(await d.appText())) throw new Error("the Terms of Use did not go away after Accept");
}
await seed();

await flow("I1", "iPhone: invitation for Ivy on a fresh phone — Terms, create account, 'Yes, that's me', lands in Saturday Group", async () => {
  await fresh();
  d.launch(BID); await d.sleep(5000);
  await openLink(await invitation("gI", "Ivy Invitee"));
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
  const m = acct && await getDoc(`associations/G1/members/${acct.localId}`);
  if (!m || m.golferId !== "gI") throw new Error(`membership not as expected: ${JSON.stringify(m)}`);
  report("    database: Ivy is a member of Saturday Group, linked to her golfer");
});

await flow("I2", "iPhone: application on a fresh phone (Auto) — apply, approval link, Create your password, lands in the public group", async () => {
  await fresh(); d.launch(BID); await d.sleep(5000);
  await acceptTerms();
  await d.press('[data-act="show-choose"]'); await d.press('[data-act="show-apply"]');
  await d.waitApp(/Full name/i); snap("apply-form");
  await d.fill('[name="apply-name"]', "Pia Applicant"); await d.fill('[name="apply-email"]', "pia.applicant@example.com");
  await d.check('[name="ap-agree"]'); await d.press('[data-act="submit-application"]');
  await d.waitApp(/Check your email/, 30000); snap("check-your-email");
  const link = await approvalLink("pia.applicant@example.com");
  if (!link) throw new Error("no sign-in email was sent");
  await openLink(link);
  await d.waitApp(/Create your password/, 30000); snap("create-your-password");
  await d.fill('[name="password"]', "pia-pass-1"); await d.fill('[name="password-again"]', "pia-pass-1");
  await d.press('[data-act="finish-apply"]');
  await d.waitApp(/public group|Welcome/i, 45000); await d.sleep(2000); snap("in-the-public-group");
  const acct = await accountByEmail("pia.applicant@example.com");
  if (!acct || !(await getDoc(`associations/PUBLIC/members/${acct.localId}`))) throw new Error("not a member of the public group");
  report("    database: Pia is a member of the public group");
});

await flow("I3", "iPhone: Rex is signed in; an invitation for Jay arrives — the app asks whether it is for him", async () => {
  await fresh(); d.launch(BID); await d.sleep(5000);
  await acceptTerms();
  await d.waitApp(/Sign in/); await d.fill('[name="email"]', R1.email); await d.fill('[name="password"]', R1.password);
  await d.press('[data-act="sign-in"]'); await d.waitApp(/Saturday Group/i, 45000); snap("rex-signed-in");
  await openLink(await invitation("gJ", "Jay Unjoined"));
  await d.waitApp(/Is this invitation for you|for a new person/, 30000); snap("is-this-for-you");
});

report(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
