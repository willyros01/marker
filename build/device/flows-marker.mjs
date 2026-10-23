/* The Marker on the Android emulator, against the same Firebase EMULATORS:
 * Rex scores a whole round for himself and Jay, posts it, the worker's own code
 * posts it into The Scorecard, and Rex then sees it in The Scorecard's test copy. */
import fs from "node:fs";
import * as d from "./adb.mjs";
import { getDoc } from "./seed.mjs";
import { client } from "../../worker/src/firestore.js";
import { sweep } from "../../worker/src/post.js";
const OUT = process.argv[2] || "out"; const MK_APK = process.argv[3]; const SC_APK = process.argv[4];
const MK = "io.github.willyros01.marker", SC = "io.github.willyros01.scorecard";
const report = (s) => { console.log(s); fs.appendFileSync(`${OUT}/report.txt`, s + "\n"); };
let step = 100, pass = 0, fail = 0;
const snap = (name) => { const f = `${String(++step)}-${name}.png`; d.shot(`${OUT}/${f}`); report(`    screenshot ${f}  (in front: ${d.front()})`); };
async function flow(id, what, fn) {
  report(`\n${id}  ${what}`);
  try { await fn(); pass++; report(`PASS  ${id}`); }
  catch (e) { fail++; try { snap(`${id}-failed`); } catch {} report(`FAIL  ${id}  —  ${String(e.message || e).slice(0, 600)}`); }
}
const fsx = client({ project: "demo-scorecard", token: async () => "owner", base: "http://127.0.0.1:8080/v1" });
const R1 = { email: "rex@example.com", password: "rex-pass-1" };

await flow("M1", "The Marker: Rex signs in, scores 18 holes for himself and Jay, and posts the card", async () => {
  d.use(MK); d.reinstall(MK, MK_APK); d.launch(MK); await d.sleep(5000);
  await d.waitApp(/The Marker/); snap("marker-start");
  await d.press('[data-act="go-signin"]');
  await d.fill("#email", R1.email); await d.fill("#password", R1.password); await d.press('[data-act="sign-in"]');
  await d.waitApp(/Start a new round/, 40000); snap("marker-signed-in");
  await d.press('[data-act="new-round"]'); await d.waitApp(/Set up the round/);
  await d.press('[data-act="go-course"]'); await d.waitApp(/Wack Wack/, 30000);
  await d.press('[data-act="pick-saved"]'); await d.waitApp(/White \(M\)/);
  await d.press('[data-act="tee"][data-v="0"]'); await d.press('[data-act="entry"][data-v="all"]'); snap("marker-setup");
  await d.press('[data-act="go-players"]'); await d.waitApp(/Rex Regular/, 30000);
  await d.press('[data-act="pick"][data-v="gR"]'); await d.press('[data-act="pick"][data-v="gJ"]'); snap("marker-players");
  await d.press('[data-act="tee-off"]');
  for (let h = 1; h <= 18; h++) {
    await d.waitApp(new RegExp(`hole ${h} of 18`, "i"), 20000);
    await d.fill('[data-score="0"]', "5"); await d.fill('[data-score="1"]', "6");
    if (h === 9) snap("marker-hole-9");
    await d.press(h === 18 ? '[data-act="finish"]' : '[data-act="next"]');
  }
  await d.waitApp(/Post 2 rounds to The Scorecard/, 20000); snap("marker-totals");
  await d.press('[data-act="post"]'); await d.sleep(4000); snap("marker-posted");
});

await flow("M2", "The worker posts the card into The Scorecard: two rounds, gross 90 and 108, in one commit", async () => {
  const r = await sweep(fsx, { log: (m) => report(`    worker: ${m}`) });
  report(`    worker result: ${JSON.stringify(r).slice(0, 300)}`);
  const rounds = (await fsx.query("associations/G1", "rounds", [], 100)).map((x) => x.data);
  const rex = rounds.find((x) => x.golferId === "gR"), jay = rounds.find((x) => x.golferId === "gJ");
  if (!rex || !jay) throw new Error(`rounds not found in The Scorecard: ${JSON.stringify(rounds).slice(0, 300)}`);
  report(`    database: Rex gross ${rex.gross}, Jay gross ${jay.gross}, entered via ${rex.enteredVia}`);
  if (rex.gross !== 90 || jay.gross !== 108) throw new Error("gross scores are not 90 and 108");
});

await flow("M3", "Rex opens The Scorecard: the Marker round is in his rounds", async () => {
  d.use(SC); d.reinstall(SC, SC_APK); d.launch(SC); await d.sleep(5000);
  await d.waitApp(/Terms of Use/); await d.check("[data-terms-tick]"); await d.press("#termsAccept");
  await d.waitApp(/Sign in/); await d.fill('[name="email"]', R1.email); await d.fill('[name="password"]', R1.password);
  await d.press('[data-act="sign-in"]'); await d.waitApp(/Saturday Group/i, 45000);
  await d.press('button[data-tab="history"]');
  await d.waitApp(/Wack Wack/, 30000); await d.sleep(1500); snap("scorecard-my-rounds");
});

report(`\nMARKER RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
