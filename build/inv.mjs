/* inv.mjs — READ-ONLY (Willy, 26 Oct 2026, 8:50 am): the two golfer records
 * linked to Willy's account. Shows each record and everything that points at
 * it. Writes nothing. */
import { client } from "../worker/src/firestore.js";
const fs = client({ project: process.env.PROJECT, token: async () => process.env.TOKEN });
const uid = (await fs.query("", "groupCreators", [], 5))[0].id;
const mine = (await fs.query("", "golfers", [["linkedUid", "EQUAL", uid]], 20));
const [rounds, rosters, dirs, members, names, games, subs] = await Promise.all([
  fs.queryGroup("rounds"), fs.queryGroup("roster"), fs.queryGroup("directory"), fs.queryGroup("members"),
  fs.query("", "golferNames", [], 5000), fs.queryGroup("games"), fs.query("", "markerSubmissions", [], 2000),
]);
const short = (o) => JSON.stringify(o, (k, v) => (k === "recentWindow" ? `[${(v || []).length} entries]` : v));
for (const g of mine) {
  const id = g.id;
  console.log("\n=== golfer", id, "updated", g.updateTime);
  console.log("record:", short(g.data));
  const rs = rounds.filter((r) => r.data.golferId === id);
  console.log("rounds:", rs.length, rs.slice(0, 40).map((r) => `${r.path.split("/")[1]} ${r.data.date} ${r.data.courseName || (r.data.course && r.data.course.name) || ""} gross ${r.data.gross}${r.data.enteredVia ? " (" + r.data.enteredVia + ")" : ""}`).join(" | "));
  console.log("window rounds:", (g.data.recentWindow || []).length, "roundCount:", g.data.roundCount);
  console.log("on rosters:", rosters.filter((r) => r.id === id || r.data.golferId === id).map((r) => r.path.split("/")[1]).join(", ") || "none");
  console.log("directory entries:", dirs.filter((r) => r.id === id).map((r) => `${r.path.split("/")[1]}:${r.data.displayName}/${r.data.handicapIndex}`).join(", ") || "none");
  console.log("members pointing at it:", members.filter((m) => m.data.golferId === id).map((m) => `${m.path.split("/")[1]} role ${m.data.role} uid ${String(m.id).slice(0, 6)}`).join(", ") || "none");
  console.log("name claims:", names.filter((n) => n.data.golferId === id).map((n) => n.id).join(", ") || "none");
  console.log("games naming it:", games.filter((x) => JSON.stringify(x.data).includes(id)).map((x) => x.path).join(", ") || "none");
  console.log("Marker cards naming it:", subs.filter((s) => JSON.stringify(s.data.card || {}).includes(id)).map((s) => `${s.id} ${s.data.status}`).join(", ") || "none");
}
const groups = await fs.query("", "associations", [], 50);
for (const a of groups) {
  const m = await fs.get(`associations/${a.id}/members/${uid}`);
  console.log(`\nmy membership in ${a.data.name} (${a.id}): ${m ? short(m.data) : "none"}`);
}
