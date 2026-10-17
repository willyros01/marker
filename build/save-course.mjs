/* save-course.mjs — one-off: makes Royal Ontario Golf Club, as printed on the
 * club's card, the course every scorer gets (Willy's OK, 17 Oct 2026, 9:28 am).
 *
 * The numbers were read by Claude from Willy's picture of the card (16 Oct)
 * and are the same ones the tests use (test/unit/royal-ontario.mjs). They go
 * through the app's own checks (cardcheck.js) exactly like a picture reading,
 * and are saved the way the worker's verify() saves one: the database's copy
 * of the course is replaced in place, other copies of the same name point to
 * it. Run by .github/workflows/save-course.yml with marker-deployer.
 * Nothing in The Scorecard is touched. */
import { client, setWrite, updateWrite } from "../worker/src/firestore.js";
import * as check from "../cardcheck.js";
import { reading } from "../test/unit/royal-ontario.mjs";

const NAME = "Royal Ontario Golf Club";
const isRoyal = (n) => /royal\s+ontario/i.test(String(n || ""));
const say = (s) => console.log(s);
const describe = (d) => `${d.id}: "${d.data.name}" source=${d.data.source || "database"}${d.data.replacedBy ? " replacedBy=" + d.data.replacedBy : ""} tees=${(d.data.tees || []).map((t) => `${t.name} ${t.rating}/${t.slope} par ${t.par}`).join("; ")}`;

const m = check.mergeReadings([reading("front"), reading("back")]);
const v = check.verifyCard(m, { lenientYards: check.LENIENT_YARDS });
if (!v.ok) { say("The card does not pass the checks: " + v.problems.join(" ")); process.exit(1); }
for (const n of v.notes) say("Note: " + n);
for (const [k, t] of Object.entries(v.tees)) for (const w of t.warnings) say(`Amber (${k}): ${w}`);
const course = check.courseFromCard(m);
if (course.tees.length !== 5 || course.tees[0].par !== 72 || course.tees[0].holes[2].par !== 5) { say("Unexpected card."); process.exit(1); }

const fs = client({ project: process.env.PROJECT, token: async () => process.env.TOKEN });
const all = await fs.query("", "markerCourses", [], 500);
const royal = all.filter((d) => isRoyal(d.data.name));
say(`Before: ${royal.length} saved cop${royal.length === 1 ? "y" : "ies"} of Royal Ontario.`);
royal.forEach((d) => say("  " + describe(d)));

/* The copy the golf database search leads to: a numbered id, not a hand entry. */
const db = royal.filter((d) => !d.id.startsWith("m-") && !d.id.startsWith("v-") && !d.data.replacedBy);
const target = db.length === 1 ? db[0] : royal.find((d) => d.data.source === "verified" && !d.data.replacedBy);
const id = target ? target.id : "v-royal-ontario-golf-club";
if (db.length > 1) { say("More than one database copy; stopping so nothing is guessed."); process.exit(1); }
say(`Saving as markerCourses/${id}.`);

const record = {
  providerId: id, name: NAME, where: (target && target.data.where) || "", tees: course.tees,
  source: "verified", verifiedBy: "willy-approved",
  verifiedNote: "Read by Claude from the club's printed card (picture sent by Willy, 16 Oct 2026); approved by Willy 17 Oct 2026.",
  scanIds: [],
};
const writes = [setWrite(fs, `markerCourses/${id}`, record,
  target ? { updateTime: target.updateTime, now: ["savedAt", "verifiedAt"] } : { exists: false, now: ["savedAt", "verifiedAt"] })];
for (const d of royal) {
  if (d.id === id || d.data.replacedBy || d.id.startsWith("m-")) continue;
  writes.push(updateWrite(fs, d.path, { replacedBy: id }, { updateTime: d.updateTime }));
}
await fs.commit(writes);

const after = await fs.query("", "markerCourses", [], 500);
say("After:");
after.filter((d) => isRoyal(d.data.name)).forEach((d) => say("  " + describe(d)));
const saved = (await fs.get(`markerCourses/${id}`)).data;
say(`Check: hole 3 par ${saved.tees[0].holes[2].par}; handicap numbers ${saved.tees[0].holes.map((h) => h.si).join(",")}`);
