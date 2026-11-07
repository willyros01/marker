/* inv.mjs — READ-ONLY (7 Nov 2026, Willy: "why was Devin Booker not included in
 * the user cleanup today?"). Shows the daily golfer clean-up's last record and,
 * for every golfer named like Devin, why the clean-up kept it. Writes nothing. */
import { client } from "../worker/src/firestore.js";
const fs = client({ project: process.env.PROJECT, token: async () => process.env.TOKEN });
const t = (ms) => (ms ? new Date(Number(ms)).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "-");
const st = await fs.get("maintenance/golferCleanup");
const s = (st && st.data) || {};
console.log(`daily clean-up: last run ${s.lastRun || "never"}; checked ${s.checked}; deleted ${JSON.stringify(s.deleted || [])}; kept because changed ${JSON.stringify(s.keptBecauseChanged || [])}; waiting ${s.waiting}`);
const [all, rounds, rosters, members, games, cards, directory, claims] = await Promise.all([
  fs.queryGroup("golfers"), fs.queryGroup("rounds"), fs.queryGroup("roster"), fs.queryGroup("members"),
  fs.queryGroup("games"), fs.query("", "markerSubmissions", [], 5000), fs.queryGroup("directory"), fs.query("", "golferNames", [], 5000)]);
const names = (doc, id) => JSON.stringify(doc.data || {}).includes(`"${id}"`);
const hits = all.filter((g) => /devin|booker/i.test(String((g.data || {}).name || "")));
console.log(`golfer records named like Devin Booker: ${hits.length}`);
for (const g of hits) {
  const d = g.data || {};
  console.log(`\n"${d.name}" at ${g.path}`);
  console.log(`  made ${t(d.createdAt)}; record last changed ${g.updateTime}; archived ${JSON.stringify(d.archived || d.archivedAt || false)}`);
  console.log(`  linked sign-in: ${d.linkedUid ? "yes" : "no"}; roundCount ${d.roundCount || 0}; fields: ${Object.keys(d).sort().join(", ")}`);
  console.log(`  clean-up list: ${s.pending && s.pending[g.id] ? "waiting since " + t(s.pending[g.id]) + " (deleted 7 days after that)" : "not on the waiting list"}`);
  const r = rosters.filter((x) => x.id === g.id || (x.data && x.data.golferId === g.id)).map((x) => x.path);
  const by = (list) => list.filter((x) => names(x, g.id)).map((x) => x.path);
  console.log(`  on a roster: ${r.join(", ") || "no"}`);
  console.log(`  named by rounds: ${by(rounds).length}; members: ${by(members).join(", ") || "none"}; games: ${by(games).join(", ") || "none"}; Marker cards: ${by(cards).length}`);
  console.log(`  directory entries: ${directory.filter((x) => x.id === g.id).map((x) => x.path).join(", ") || "none"}; name claim: ${claims.filter((c) => c.data && c.data.golferId === g.id).map((c) => c.id).join(", ") || "none"}`);
}
console.log("\nREAD-ONLY: nothing was changed.");
