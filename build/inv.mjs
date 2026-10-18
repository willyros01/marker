/* inv.mjs — READ-ONLY (Willy, 18 Oct 2026, 3:04 am: why the Lakeview card
 * shows no Re-post). Runs the worker's own Your-cards list as the scorer and
 * counts the requests it needs. Writes nothing. */
import { client } from "../worker/src/firestore.js";
import * as fix from "../worker/src/correct.js";
let calls = 0;
const fs = client({ project: process.env.PROJECT, token: async () => process.env.TOKEN, fetchFn: (...a) => { calls++; return fetch(...a); } });
const posted = await fs.query("", "markerSubmissions", [["status", "EQUAL", "posted"]], 500);
console.log(`posted cards: ${posted.length}`);
for (const s of posted) {
  const c = s.data.card || {};
  console.log(`${s.id.slice(0, 6)} ${c.date} ${(c.course || {}).name} players=${(c.players || []).length} scorer=${String(s.data.scorer).slice(0, 5)} repostedAs=${s.data.repostedAs || ""} hidden=${!!s.data.repostHidden}`);
}
const lake = posted.find((s) => (s.data.card || {}).date === "2025-07-17");
if (!lake) { console.log("no Lakeview card"); process.exit(0); }
for (const p of lake.data.card.players) {
  const rid = (lake.data.rounds || {})[p.golferId];
  const r = rid ? await fs.get(`associations/${p.assocId}/rounds/${rid}`) : null;
  console.log(`  ${p.name}: round ${rid ? rid.slice(0, 6) : "none"} ${r ? "still there" : "gone"}`);
}
calls = 0;
try {
  const m = await fix.myCards(fs, { uid: lake.data.scorer, anonymous: false });
  console.log(`myCards as scorer: correctable=${m.correctable.length} editable=${m.editable.length} (${m.editable.map((x) => x.cardId.slice(0, 6) + " gone:" + x.gone.join("/")).join(", ")})`);
} catch (e) { console.log("myCards failed: " + e.message); }
console.log(`requests needed: ${calls} (a free-plan worker call is allowed 50)`);
