/* inv.mjs — READ-ONLY (7 Nov 2026, Willy said yes): golfers still on a roster
 * with no rounds, no games, no Marker cards, no member link and no linked
 * sign-in. Some may be golfers of accounts deleted before today (not noted by
 * the new clean-up); others may be golfers an admin added who have not played
 * yet. Listed for Willy to decide. Writes nothing. */
import { client } from "../worker/src/firestore.js";
const fs = client({ project: process.env.PROJECT, token: async () => process.env.TOKEN });
const made = (id) => { const t = parseInt(String(id).slice(0, 8), 36); return t > 1.7e12 && t < 2e12 ? new Date(t).toISOString().slice(0, 10) : "?"; };
const [assoc, all, rounds, rosters, members, games, cards, invites] = await Promise.all([
  fs.query("", "associations", [], 200), fs.queryGroup("golfers"), fs.queryGroup("rounds"), fs.queryGroup("roster"),
  fs.queryGroup("members"), fs.queryGroup("games"), fs.query("", "markerSubmissions", [], 5000), fs.queryGroup("invites")]);
const gname = Object.fromEntries(assoc.map((a) => [a.id, (a.data || {}).name || a.id]));
const names = (doc, id) => JSON.stringify(doc.data || {}).includes(`"${id}"`);
const golfers = all.filter((g) => g.path === `golfers/${g.id}`);
const out = [];
for (const g of golfers) {
  const d = g.data || {};
  if (d.linkedUid || d.archived) continue;
  if (Number(d.roundCount) > 0 || (Array.isArray(d.recentWindow) && d.recentWindow.length)) continue;
  const on = rosters.filter((r) => r.id === g.id || (r.data && r.data.golferId === g.id));
  if (!on.length) continue;
  if ([rounds, members, games, cards].some((list) => list.some((x) => names(x, g.id)))) continue;
  const inv = invites.filter((x) => names(x, g.id));
  const groups = [...new Set(on.map((r) => gname[r.path.split("/")[1]] || r.path.split("/")[1]))];
  out.push(`  ${d.name} — ${groups.join(", ")} — made ${made(g.id)}${inv.length ? ` — has ${inv.length} invitation(s)` : " — no invitation"}`);
}
console.log(`SUMMARY: ${out.length} golfer(s) on a roster with no rounds, games, cards, member or sign-in:`);
for (const l of out.sort()) console.log(l);
console.log("READ-ONLY: nothing was changed.");
