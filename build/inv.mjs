/* inv.mjs — READ-ONLY (Willy, 6 Nov 2026, 8:10 am: "I want all of them done"):
 * the lists for the five data clean-ups, for Willy to check before anything
 * is changed. Writes nothing. */
import { client } from "../worker/src/firestore.js";
const P = process.env.PROJECT, T = process.env.TOKEN;
const fs = client({ project: P, token: async () => T });
const base = `https://firestore.googleapis.com/v1/projects/${P}/databases/(default)/documents`;
const call = async (url, body) => { const r = await fetch(url, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${T}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const groupOf = (path) => path.split("/")[1];

const [assocs, rounds, rosters, dirs, members, names, games, golfers, userGroups, subs] = await Promise.all([
  fs.query("", "associations", [], 200), fs.queryGroup("rounds"), fs.queryGroup("roster"), fs.queryGroup("directory"),
  fs.queryGroup("members"), fs.query("", "golferNames", [], 5000), fs.queryGroup("games"), fs.query("", "golfers", [], 5000),
  fs.queryGroup("groups"), fs.query("", "markerSubmissions", [], 3000),
]);
const assocName = Object.fromEntries(assocs.map((a) => [a.id, a.data.name]));
console.log(`groups: ${assocs.map((a) => `${a.data.name} (${a.id})${a.data.hidden ? " hidden" : ""}`).join(" | ")}`);

/* ---- Step 22: the golfer named after an email, and group-list entries for groups that no longer exist ---- */
console.log("\n=== STEP 22: golfers named after an email ===");
for (const g of golfers.filter((x) => String(x.data.name || "").includes("@"))) {
  const id = g.id;
  console.log(`golfer ${id} "${g.data.name}" linkedUid ${String(g.data.linkedUid || "").slice(0, 6)} groups ${JSON.stringify(g.data.groups || [])}`);
  console.log(`  rounds: ${rounds.filter((r) => r.data.golferId === id).length}; rosters: ${rosters.filter((r) => r.id === id).map((r) => assocName[groupOf(r.path)] || groupOf(r.path)).join(", ") || "none"}; directory: ${dirs.filter((r) => r.id === id).map((r) => assocName[groupOf(r.path)] || groupOf(r.path)).join(", ") || "none"}`);
  console.log(`  members pointing at it: ${members.filter((m) => m.data.golferId === id).map((m) => `${assocName[groupOf(m.path)]} ${m.data.role}`).join(", ") || "none"}; name claims: ${names.filter((n) => n.data.golferId === id).map((n) => n.id).join(", ") || "none"}; games: ${games.filter((x) => JSON.stringify(x.data).includes(id)).length}; Marker cards: ${subs.filter((s) => JSON.stringify(s.data).includes(id)).length}`);
}
console.log("group-list entries (userGroups/*/groups/*) for a group that no longer exists:");
const live = new Set(assocs.map((a) => a.id));
for (const u of userGroups.filter((x) => x.path.startsWith("userGroups/") && !live.has(x.id))) console.log(`  ${u.path} name "${u.data.name || ""}"`);

/* ---- Fix 4: rounds pointing to a game that no longer exists ---- */
console.log("\n=== FIX 4: rounds whose game no longer exists ===");
const gameIds = new Set(games.map((g) => `${groupOf(g.path)}/${g.id}`));
const stale = rounds.filter((r) => r.data.gameId && !gameIds.has(`${groupOf(r.path)}/${r.data.gameId}`));
const byGame = {};
for (const r of stale) { const k = `${assocName[groupOf(r.path)] || groupOf(r.path)} · game ${r.data.gameId}`; (byGame[k] = byGame[k] || []).push(r); }
for (const [k, rs] of Object.entries(byGame)) console.log(`${k}: ${rs.length} rounds, ${rs.map((r) => r.data.date).sort()[0]} to ${rs.map((r) => r.data.date).sort().slice(-1)[0]}`);
console.log(`total: ${stale.length}`);

/* ---- Step 19: the Philippine Golfers test group ---- */
console.log("\n=== STEP 19: Philippine Golfers ===");
for (const a of assocs.filter((x) => /philippine/i.test(x.data.name || ""))) {
  const id = a.id;
  const rs = rounds.filter((r) => groupOf(r.path) === id);
  const ms = members.filter((m) => groupOf(m.path) === id);
  const ro = rosters.filter((r) => groupOf(r.path) === id);
  const gs = games.filter((g) => groupOf(g.path) === id);
  console.log(`group ${a.data.name} (${id}) created ${a.createTime || ""}: ${rs.length} rounds, ${ro.length} on roster, ${ms.length} members, ${gs.length} games`);
  for (const r of ro) {
    const g = golfers.find((x) => x.id === r.id) || { data: {} };
    const elsewhere = (g.data.groups || []).filter((x) => x !== id).map((x) => assocName[x] || x);
    const own = rs.filter((x) => x.data.golferId === r.id).length;
    const other = rounds.filter((x) => x.data.golferId === r.id && groupOf(x.path) !== id).length;
    console.log(`  golfer "${g.data.name}" ${r.id}: ${own} rounds here, ${other} elsewhere; also in: ${elsewhere.join(", ") || "no other group"}; account: ${g.data.linkedUid ? "yes" : "no"}`);
  }
  for (const m of ms) console.log(`  member ${String(m.id).slice(0, 6)} role ${m.data.role} "${m.data.displayName || ""}"`);
  console.log(`  group-list entries pointing here: ${userGroups.filter((u) => u.id === id).length}; Marker cards for it: ${subs.filter((s) => JSON.stringify(s.data).includes(id)).length}`);
}

/* ---- Step 12: version 1 leftovers under users/{uid} ---- */
console.log("\n=== STEP 12: users/{uid} with anything besides terms and prefs ===");
let users = [], tok = "";
do { const { j } = await call(`${base}/users?pageSize=300&showMissing=true${tok ? "&pageToken=" + tok : ""}`); users = users.concat(j.documents || []); tok = j.nextPageToken || ""; } while (tok);
let n12 = 0;
for (const u of users) {
  const ids = (await call(`${u.name}:listCollectionIds`, { pageSize: 50 })).j.collectionIds || [];
  const extra = ids.filter((c) => !["terms", "prefs"].includes(c));
  if (extra.length) { n12++; console.log(`  users/${u.name.split("/").pop().slice(0, 6)}…: ${extra.join(", ")} (kept: ${ids.filter((c) => !extra.includes(c)).join(", ") || "nothing"})`); }
}
console.log(`accounts checked: ${users.length}; with version 1 leftovers: ${n12}`);

/* ---- Step 13: guest sign-ins that belong to no group ---- */
console.log("\n=== STEP 13: guest sign-ins in no group ===");
const all = []; let next = "";
for (let i = 0; i < 50; i++) {
  const { status, j } = await call(`https://identitytoolkit.googleapis.com/v1/projects/${P}/accounts:batchGet?maxResults=500${next ? "&nextPageToken=" + next : ""}`);
  if (status !== 200) { console.log(`  the account list could not be read here (${status} ${JSON.stringify(j).slice(0, 160)}); step 13 then needs Willy's Cloud Shell script`); break; }
  all.push(...(j.users || [])); next = j.nextPageToken || ""; if (!next) break;
}
if (all.length) {
  const memberUids = new Set(members.map((m) => m.id));
  const guests = all.filter((u) => !u.email && !(u.providerUserInfo || []).length);
  const lonely = guests.filter((u) => !memberUids.has(u.localId));
  console.log(`sign-in accounts: ${all.length}; guests: ${guests.length}; guests in no group: ${lonely.length}`);
  for (const u of lonely.slice(0, 60)) console.log(`  ${u.localId.slice(0, 6)}… made ${new Date(+u.createdAt).toISOString().slice(0, 10)}, last used ${u.lastLoginAt ? new Date(+u.lastLoginAt).toISOString().slice(0, 10) : "never"}`);
}
console.log("\nREAD-ONLY: nothing was changed.");
