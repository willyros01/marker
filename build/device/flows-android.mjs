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
  catch (e) { fail++; try { snap(`${id}-failed`); } catch {} report(`FAIL  ${id}  —  ${String(e.message || e).slice(0, 600)}`); }
}
async function fresh() { d.reinstall(PKG, APK); await d.sleep(2000); }
async function acceptTerms() {
  await d.waitText(/Terms of Use/); snap("terms");
  await d.tick(/I have read and agree/); await d.tapText(/^Accept$/);
}
const inFront = () => { const f = d.front(); if (!f.startsWith(PKG)) throw new Error(`the app is not in front: ${f}`); };

await seed();

await flow("F1", "Invitation for Ivy on a fresh phone: Terms, create account, 'Yes, that's me — join', lands in Saturday Group", async () => {
  await fresh();
  const link = await invitation("gI", "Ivy Invitee");
  d.view(link); await d.sleep(6000); inFront();
  await acceptTerms();
  await d.waitText(/You.re invited|Create your account/); snap("invited-create-account");
  await d.typeField(0, "ivy@example.com"); await d.typeField(1, "ivy-pass-1");
  if (d.nodes().filter((n) => /EditText/.test(n.cls)).length > 2) await d.typeField(2, "ivy-pass-1");
  d.hideKeyboard(); await d.tapText(/^Create account$/);
  await d.waitText(/Joining as|Ivy Invitee/, 45000); snap("joining-as-ivy");
  await d.tapText(/Yes, that.s me/);
  await d.waitText(/Saturday Group|Enter|My rounds/, 45000); snap("in-the-group");
  const acct = await accountByEmail("ivy@example.com");
  if (!acct) throw new Error("no account was created");
  const m = await getDoc(`associations/G1/members/${acct.localId}`);
  if (!m || m.golferId !== "gI") throw new Error(`membership not as expected: ${JSON.stringify(m)}`);
  report("    database: Ivy is a member of Saturday Group, linked to her golfer");
});

await flow("F2", "Application on a fresh phone (Auto): apply in the app, open the approval link, Create your password, lands in the public group", async () => {
  await fresh(); d.launch(PKG); await d.sleep(5000);
  await acceptTerms();
  await d.tapText(/Become a member or request a group/); await d.tapText(/^Become a member(?! or)/);
  await d.waitText(/Full name/); snap("apply-form");
  await d.typeField(0, "Pat Applicant"); await d.typeField(1, "pat.applicant@example.com"); d.hideKeyboard();
  await d.tick(/I agree|conditions|Code of Conduct/);
  await d.tapText(/^Send my application$/);
  await d.waitText(/Check your email/, 30000); snap("check-your-email");
  const link = await approvalLink("pat.applicant@example.com");
  if (!link) throw new Error("no sign-in email was sent");
  d.view(link); await d.sleep(6000); inFront();
  await d.waitText(/Create your password/, 30000); snap("create-your-password");
  await d.typeField(1, "pat-pass-1"); await d.typeField(2, "pat-pass-1"); d.hideKeyboard();
  await d.tapText(/^Save my password$/);
  await d.waitText(/public group|Enter|My rounds|Welcome/i, 45000); snap("in-the-public-group");
  const acct = await accountByEmail("pat.applicant@example.com");
  if (!acct) throw new Error("no account was created");
  if (!(await getDoc(`associations/PUBLIC/members/${acct.localId}`))) throw new Error("not a member of the public group");
  report("    database: Pat is a member of the public group");
});

await flow("F3", "Someone else (Rex) is signed in; an invitation for Jay arrives: the app asks whether it is for him", async () => {
  await fresh(); d.launch(PKG); await d.sleep(5000);
  await acceptTerms();
  await d.waitText(/Sign in/); await d.typeField(0, R1.email); await d.typeField(1, R1.password); d.hideKeyboard();
  await d.tapText(/^Sign in$/);
  await d.waitText(/Saturday Group|Enter|My rounds/, 45000); snap("rex-signed-in");
  d.view(await invitation("gJ", "Jay Unjoined")); await d.sleep(6000); inFront();
  await d.waitText(/Is this invitation for you|for a new person/, 30000); snap("is-this-for-you");
});

report(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
