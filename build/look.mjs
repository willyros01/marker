/* look.mjs — READ ONLY. Investigates Willy's report (18 Oct 2026, 12:07 am):
 * after posting the Lakeview card dated 2025-07-17, the 2025 games of Golf
 * Buddies show "Lakeview" as their course. Nothing is written. Prints only
 * ids, course and game names, dates and change times (no golfer names). */
import { client } from "../worker/src/firestore.js";
const fs = client({ project: process.env.PROJECT, token: async () => process.env.TOKEN });
const say = (s) => console.log(s);
const assocs = await fs.query("", "associations", [], 200);
say("Groups: " + assocs.map((a) => `${a.id}="${a.data.name}"`).join(", "));
const courses = await fs.query("", "courses", [], 1000);
const cname = (id) => { const c = courses.find((x) => x.id === id); return c ? c.data.name : `(no course ${id})`; };
say(`\nCourses (${courses.length}), most recently changed first:`);
for (const c of [...courses].sort((a, b) => b.updateTime.localeCompare(a.updateTime)).slice(0, 12))
  say(`  ${c.id} "${c.data.name}" tees=${(c.data.tees || []).length} changed ${c.updateTime} createdVia=${c.data.createdVia || "-"} withdrawn=${!!c.data.withdrawn}`);
say("\nCourses named like Lakeview:");
for (const c of courses.filter((x) => /lake/i.test(x.data.name || ""))) say(`  ${c.id} "${c.data.name}" changed ${c.updateTime} tees=${JSON.stringify((c.data.tees || []).map((t) => [t.id, t.name, t.rating, t.slope]))}`);
const subs = await fs.query("", "markerSubmissions", [], 200);
say(`\nMarker cards (${subs.length}):`);
for (const s of subs) say(`  ${s.id} status=${s.data.status} date=${s.data.card && s.data.card.date} course="${s.data.card && s.data.card.course && s.data.card.course.name}" game=${JSON.stringify(s.data.card && s.data.card.game)} courseId=${s.data.courseId || "-"} rounds=${Object.keys(s.data.rounds || {}).length} changed ${s.updateTime}`);
for (const a of assocs) {
  const games = await fs.query(`associations/${a.id}`, "games", [], 500);
  say(`\nGames of "${a.data.name}" (${games.length}):`);
  for (const g of games.sort((x, y) => String(x.data.date).localeCompare(String(y.data.date))))
    say(`  ${g.id} name="${g.data.name || ""}" ${g.data.date}${g.data.endDate ? " to " + g.data.endDate : ""} courseId=${g.data.courseId} -> "${cname(g.data.courseId)}" archived=${!!g.data.archived} changed ${g.updateTime}`);
  const rounds = await fs.query(`associations/${a.id}`, "rounds", [], 2000);
  const recent = rounds.filter((r) => r.data.enteredVia === "marker" || r.updateTime > "2026-10-17");
  say(`Rounds: ${rounds.length}. Entered by The Marker or changed since 17 Oct:`);
  for (const r of recent) say(`  ${r.id} date=${r.data.date} courseId=${r.data.courseId} -> "${cname(r.data.courseId)}" gameId=${r.data.gameId || "-"} via=${r.data.enteredVia || "-"} changed ${r.updateTime}`);
  const byGame = {};
  for (const r of rounds) if (r.data.gameId) byGame[r.data.gameId] = (byGame[r.data.gameId] || 0) + 1;
  say("Rounds per game: " + JSON.stringify(byGame));
}
