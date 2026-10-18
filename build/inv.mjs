/* inv.mjs — READ-ONLY look at what the Lakeview card of 17 July 2025 changed
 * (Willy's report, 18 Oct 2026, 00:11). Writes nothing. Prints ids, course
 * names, dates and counts only — no golfer names (the log is public). */
import { client } from "../worker/src/firestore.js";
const fs = client({ project: process.env.PROJECT, token: async () => process.env.TOKEN });
const say = (s) => console.log(s);
const since = "2026-10-17T00:00:00Z";

const subs = (await fs.query("", "markerSubmissions", [], 500)).filter((d) => d.data.card && d.data.card.date && d.data.card.date.startsWith("2025"));
say(`Marker cards dated 2025: ${subs.length}`);
for (const s of subs) {
  const c = s.data.card;
  say(`  card ${s.id}: date ${c.date}, course "${c.course && c.course.name}", tee ${c.tee && c.tee.name} ${c.tee && c.tee.rating}/${c.tee && c.tee.slope}, game ${JSON.stringify(c.game || null)}, status ${s.data.status}, postedAt ${s.data.postedAt}, courseId ${s.data.courseId}, rounds ${Object.keys(s.data.rounds || {}).length}`);
}

const courses = await fs.query("", "courses", [], 1000);
say(`\nScorecard courses: ${courses.length}`);
for (const c of courses.filter((c) => /lakeview/i.test(c.data.name || "") || c.updateTime >= since))
  say(`  course ${c.id}: "${c.data.name}" updated ${c.updateTime} createdVia ${c.data.createdVia || "-"} tees ${(c.data.tees || []).map((t) => `${t.id}:${t.name} ${t.rating}/${t.slope}`).join("; ")}`);

const assocs = await fs.query("", "associations", [], 100);
for (const a of assocs) {
  const games = await fs.query(`associations/${a.id}`, "games", [], 500);
  const changed = games.filter((g) => g.updateTime >= since);
  const g25 = games.filter((g) => String(g.data.date || "").startsWith("2025") || String(g.data.endDate || "").startsWith("2025"));
  say(`\nGroup ${a.id} "${a.data.name}": ${games.length} games, ${g25.length} touching 2025, ${changed.length} changed since 17 Oct`);
  for (const g of g25.concat(changed.filter((x) => !g25.includes(x))))
    say(`  game ${g.id}: "${g.data.name || ""}" ${g.data.date}..${g.data.endDate || ""} course ${g.data.courseId} ("${(courses.find((c) => c.id === g.data.courseId) || { data: {} }).data.name || "?"}") updated ${g.updateTime}`);
  const rounds = await fs.query(`associations/${a.id}`, "rounds", [], 5000);
  const r25 = rounds.filter((r) => String(r.data.date || "").startsWith("2025"));
  const viaMarker = rounds.filter((r) => r.data.enteredVia === "marker");
  const changedR = rounds.filter((r) => r.updateTime >= since);
  say(`  rounds: ${rounds.length} total, ${r25.length} dated 2025, ${viaMarker.length} via The Marker, ${changedR.length} changed since 17 Oct`);
  const byCourse = {};
  for (const r of r25) { const k = (courses.find((c) => c.id === r.data.courseId) || { data: { name: r.data.courseId } }).data.name; byCourse[k] = (byCourse[k] || 0) + 1; }
  say(`  2025 rounds by course: ${JSON.stringify(byCourse)}`);
  const byGame = {};
  for (const r of r25) byGame[r.data.gameId || "-"] = (byGame[r.data.gameId || "-"] || 0) + 1;
  say(`  2025 rounds by game: ${JSON.stringify(byGame)}`);
  for (const r of viaMarker.concat(changedR.filter((x) => !viaMarker.includes(x))))
    say(`  round ${r.id}: date ${r.data.date} course ${r.data.courseId} tee ${r.data.teeId} game ${r.data.gameId || "-"} via ${r.data.enteredVia || "-"} updated ${r.updateTime}`);
}
