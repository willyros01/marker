/* inv.mjs — READ-ONLY look, second pass (Willy's report, 18 Oct 2026). Writes nothing. */
import { client } from "../worker/src/firestore.js";
const fs = client({ project: process.env.PROJECT, token: async () => process.env.TOKEN });
const say = (s) => console.log(s);
const s = await fs.get("markerSubmissions/mvd9fqrz6musio");
const c = s.data.card;
say("card players: " + JSON.stringify(c.players.map((p) => ({ golferId: p.golferId, assocId: p.assocId, groupName: p.groupName }))));
say("card game: " + JSON.stringify(c.game || null) + " rounds: " + JSON.stringify(s.data.rounds));
for (const p of c.players) {
  const rid = s.data.rounds[p.golferId];
  const r = rid && await fs.get(`associations/${p.assocId}/rounds/${rid}`);
  say(`round ${rid} in ${p.assocId}: ` + (r ? JSON.stringify({ date: r.data.date, courseId: r.data.courseId, teeId: r.data.teeId, gameId: r.data.gameId || null, enteredVia: r.data.enteredVia, gross: r.data.gross }) : "NOT FOUND"));
}
const A = "mss0iqvqder7g2";
const games = await fs.query(`associations/${A}`, "games", [], 500);
for (const g of games) say(`game ${g.id}: ${JSON.stringify(g.data).slice(0, 400)} updated ${g.updateTime}`);
const rounds = await fs.query(`associations/${A}`, "rounds", [], 5000);
say(`Golfing Buddies rounds fetched: ${rounds.length}`);
const recent = rounds.filter((r) => r.updateTime >= "2026-10-16T00:00:00Z" || r.createTime >= "2026-10-16T00:00:00Z");
say(`changed since 16 Oct: ${recent.length}`);
for (const r of recent) say(`  ${r.id}: date ${r.data.date} course ${r.data.courseId} game ${r.data.gameId || "-"} via ${r.data.enteredVia || "-"} updated ${r.updateTime}`);
const marker = rounds.filter((r) => r.data.enteredVia === "marker" || r.data.cardId);
say(`with cardId or via marker: ${marker.length}`);
for (const r of marker) say(`  ${r.id}: date ${r.data.date} course ${r.data.courseId} game ${r.data.gameId || "-"} card ${r.data.cardId || "-"}`);
const byGame = {}; for (const r of rounds) { const k = (r.data.gameId || "-") + " " + String(r.data.date).slice(0, 4); byGame[k] = (byGame[k] || 0) + 1; }
say("rounds by game and year: " + JSON.stringify(byGame));
