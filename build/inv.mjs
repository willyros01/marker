/* inv.mjs — Willy, 22 Oct 2026, 6:12 pm: "i want it cleaned up". Deletes the
 * eleven golfers Tidy lists as "in no group, with no rounds", ONLY when every
 * check passes for that golfer: no round anywhere, on no roster, no linked
 * account, no member pointing at them, in no game. One commit, all or nothing,
 * each golfer guarded by its updateTime. MODE=dry prints the plan only. */
import { client, deleteWrite } from "../worker/src/firestore.js";
const MODE = "go";
const P = process.env.PROJECT, T = process.env.TOKEN;
const fs = client({ project: P, token: async () => T });
const root = `projects/${P}/databases/(default)/documents`;
async function group(collectionId) {          /* every collection of this name, anywhere */
  const r = await fetch(`https://firestore.googleapis.com/v1/${root}:runQuery`, { method: "POST",
    headers: { Authorization: "Bearer " + T, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId, allDescendants: true }], limit: 20000 } }) });
  if (!r.ok) throw new Error(`${collectionId}: ${r.status} ${await r.text()}`);
  const rows = (await r.json()).filter((x) => x.document);
  return rows.map((x) => ({ path: x.document.name.slice(root.length + 1), id: x.document.name.split("/").pop(), updateTime: x.document.updateTime, raw: JSON.stringify(x.document.fields || {}) }));
}
const names = ["Ruben Brina", "Daphne Brina", "Test Admin1", "Test Public1", "Test Public2", "Demo Public1", "Demo User3", "Test V25", "Public Test02", "Pubic Test10", "John Appleseed"];
const golfers = (await fs.query("", "golfers", [], 5000)).filter((g) => names.includes(g.data.name));
const [rounds, rosters, members, games, directory, blocks, claims] = await Promise.all(
  ["rounds", "roster", "members", "games", "directory", "golfers", "golferNames"].map(group));
console.log(`read: ${rounds.length} rounds, ${rosters.length} roster entries, ${members.length} members, ${games.length} games`);
const writes = []; let refused = 0;
for (const g of golfers) {
  const id = g.id, d = g.data;
  const why = [];
  if (rounds.some((r) => r.raw.includes(`"${id}"`))) why.push("has a round");
  if (rosters.some((r) => r.id === id)) why.push("on a roster");
  if (d.linkedUid) why.push("account linked");
  if (members.some((m) => m.raw.includes(`"${id}"`))) why.push("a member points at them");
  if (games.some((x) => x.raw.includes(`"${id}"`))) why.push("in a game");
  if (why.length) { refused++; console.log(`KEEP   ${d.name} (${id.slice(0, 6)}): ${why.join(", ")}`); continue; }
  const extra = [
    ...directory.filter((x) => x.id === id),
    ...blocks.filter((x) => x.id === id && x.path.startsWith("userBlocks/")),
    ...claims.filter((x) => x.path.startsWith("golferNames/") && x.raw.includes(`"${id}"`)),
  ];
  writes.push(deleteWrite(fs, g.path, { updateTime: g.updateTime }));
  for (const x of extra) writes.push(deleteWrite(fs, x.path, { updateTime: x.updateTime }));
  console.log(`DELETE ${d.name} (${id.slice(0, 6)}) archived=${d.archived === true}` + (extra.length ? ` + ${extra.map((x) => x.path.split("/")[0] + (x.path.includes("/directory/") ? "/directory" : "")).join(", ")}` : ""));
}
console.log(`found ${golfers.length} of ${names.length} names; ${golfers.length - refused} to delete, ${refused} kept; ${writes.length} deletes in one commit`);
if (MODE === "go" && writes.length) { await fs.commit(writes); console.log("COMMITTED: all deleted together"); }
else console.log("DRY RUN: nothing changed");
