/* inv.mjs — READ-ONLY look, third pass (Willy's report, 18 Oct 2026). Writes nothing. */
import { client } from "../worker/src/firestore.js";
const fs = client({ project: process.env.PROJECT, token: async () => process.env.TOKEN });
const say = (s) => console.log(s);
const A = "mss0iqvqder7g2";
const july = await fs.query(`associations/${A}`, "rounds", [["date", "EQUAL", "2025-07-17"]], 50);
say(`rounds dated 2025-07-17 in Golfing Buddies: ${july.length}`);
for (const r of july) say(`  ${r.id}: course ${r.data.courseId} game ${r.data.gameId || "-"} via ${r.data.enteredVia || "-"} card ${r.data.cardId || "-"} created ${r.createTime}`);
const viaMarker = await fs.query(`associations/${A}`, "rounds", [["enteredVia", "EQUAL", "marker"]], 50);
say(`rounds entered via The Marker: ${viaMarker.length}`);
for (const r of viaMarker) say(`  ${r.id}: date ${r.data.date} course ${r.data.courseId} game ${r.data.gameId || "-"}`);
const withGame = await fs.query(`associations/${A}`, "rounds", [["gameId", "EQUAL", "msngo2mu2yqef3"]], 200);
say(`rounds pointing to game msngo2mu2yqef3: ${withGame.length}; that game document exists: ${!!(await fs.get(`associations/${A}/games/msngo2mu2yqef3`))}`);
for (const id of ["v1-golfer-raul-rosales", "mskprf1hohe4va", "v1-golfer-raul-reynoso"]) {
  const g = await fs.get(`golfers/${id}`);
  const w = (g.data.recentWindow || []).filter((x) => String(x.roundId).startsWith("mvdak5"));
  say(`golfer ${id}: window has the Lakeview round: ${w.length ? JSON.stringify(w) : "no"}; roundCount ${g.data.roundCount}; updated ${g.updateTime}`);
}
const lake = await fs.get("courses/mvdak5q2dikg2u");
say(`Lakeview course fields: ${Object.keys(lake.data).sort().join(", ")}`);
const ro = await fs.get("courses/v1-course-0ya4t98r");
say(`Royal Ontario course fields: ${Object.keys(ro.data).sort().join(", ")}`);
const all = await fs.query("", "courses", [], 1000);
say(`courses without their own id field: ${all.filter((c) => c.data.id !== c.id).map((c) => `${c.id} "${c.data.name}" (${c.data.createdVia || "-"})`).join("; ") || "none"}`);
