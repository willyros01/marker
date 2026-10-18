/* inv.mjs — READ-ONLY (Willy, 18 Oct 2026, 3:04 am): are the rounds of the
 * three Marker cards really gone, or are they somewhere else? Writes nothing. */
import { client } from "../worker/src/firestore.js";
const fs = client({ project: process.env.PROJECT, token: async () => process.env.TOKEN });
const posted = await fs.query("", "markerSubmissions", [["status", "EQUAL", "posted"]], 500);
for (const s of posted) {
  const c = s.data.card;
  console.log(`card ${s.id.slice(0, 6)} ${c.date} ${c.course.name}: rounds kept on the card ${JSON.stringify(s.data.rounds)}`);
  const groups = [...new Set(c.players.map((p) => p.assocId))];
  for (const a of groups) {
    const same = await fs.query(`associations/${a}`, "rounds", [["date", "EQUAL", c.date]], 50);
    console.log(`  group ${a.slice(0, 6)}: rounds dated ${c.date} now: ${same.length}`);
    for (const r of same) console.log(`    ${r.id} golfer=${String(r.data.golferId).slice(0, 6)} gross=${r.data.gross} via=${r.data.enteredVia || "scorecard"} entered=${r.data.enteredAt || ""}`);
  }
}
