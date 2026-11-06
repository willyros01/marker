/* fix.mjs — DATA CLEAN-UP, ONE COMMIT (Willy, 6 Nov 2026, 8:15 am: "Ok" to the
 * lists of 8:13 am). All of it is written together or none of it is; each
 * write carries the record's last-change time, so anything changed since the
 * list was made stops the whole commit.
 *   Step 22: the golfers "willyros01@gmail.com" and "willyros01@yahoo.com"
 *            (0 rounds each), their roster, directory and name-claim records;
 *            the group-list entry for the removed Ronnie Rosales' Memorial
 *            Tournament. Willy Rosales is not touched. Marker cards stay.
 *   Fix 4:   the deleted game cleared from the 54 Golfing Buddies rounds
 *            (scores, dates and courses unchanged).
 *   Step 12: the version 1 "data" folder on Willy's gmail account (terms and
 *            prefs kept).
 * NOT here: Philippine Golfers (Willy, 8:13 am: not yet); guest sign-ins
 * (Cloud Shell script). */
import { client, deleteWrite } from "../worker/src/firestore.js";
const P = process.env.PROJECT, T = process.env.TOKEN;
const fs = client({ project: P, token: async () => T });
const base = `https://firestore.googleapis.com/v1/projects/${P}/databases/(default)/documents`;
const call = async (url, body) => { const r = await fetch(url, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${T}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return r.json(); };
const stop = (m) => { console.log("STOPPED, nothing written: " + m); process.exit(1); };

const LEFTOVERS = ["mss0ir7tagkms5", "mt2woyfy7pygjj"];
const APPLE = "mv41i2sx1c9tyw", BUDDIES = "mss0iqvqder7g2", GONE_GAME = "msngo2mu2yqef3", RONNIE = "mst71vmrsw4jvv";
const writes = [], plan = [];
const del = (doc, why) => { writes.push(deleteWrite(fs, doc.path, { updateTime: doc.updateTime })); plan.push(`delete ${doc.path}  (${why})`); };

const [rounds, rosters, dirs, members, names, userGroups] = await Promise.all([
  fs.queryGroup("rounds"), fs.queryGroup("roster"), fs.queryGroup("directory"), fs.queryGroup("members"),
  fs.query("", "golferNames", [], 5000), fs.queryGroup("groups"),
]);
/* Step 22 */
for (const id of LEFTOVERS) {
  const g = await fs.get(`golfers/${id}`);
  if (!g) { plan.push(`golfer ${id}: already gone`); continue; }
  if (!String(g.data.name || "").includes("@")) stop(`golfer ${id} is not named after an email`);
  if (rounds.some((r) => r.data.golferId === id)) stop(`golfer ${id} has rounds`);
  if (members.some((m) => m.data.golferId === id)) stop(`a membership points at golfer ${id}`);
  del(g, `golfer "${g.data.name}"`);
  for (const r of rosters.filter((x) => x.id === id)) del(r, "its roster entry");
  for (const d of dirs.filter((x) => x.id === id)) del(d, "its directory entry");
  for (const n of names.filter((x) => x.data.golferId === id)) del(n, "its name claim");
}
for (const u of userGroups.filter((x) => x.path.startsWith("userGroups/") && x.id === RONNIE)) del(u, "group-list entry for a removed group");
/* Fix 4 */
const stale = rounds.filter((r) => r.path.startsWith(`associations/${BUDDIES}/`) && r.data.gameId === GONE_GAME);
if (await fs.get(`associations/${BUDDIES}/games/${GONE_GAME}`)) stop("the game exists again");
for (const r of stale) writes.push({ update: { name: fs.name(r.path), fields: {} }, updateMask: { fieldPaths: ["gameId"] }, currentDocument: { updateTime: r.updateTime } });
plan.push(`clear the deleted game from ${stale.length} Golfing Buddies rounds`);
/* Step 12 */
const owner = members.find((m) => m.path.startsWith(`associations/${APPLE}/`) && m.data.role === "owner");
if (!owner || !owner.id.startsWith("wJ1NLF")) stop("Willy's account was not found");
const listAll = async (parent) => {
  const out = []; let tok = "";
  do { const j = await call(`${base}/${parent}?pageSize=300&showMissing=true${tok ? "&pageToken=" + tok : ""}`); out.push(...(j.documents || [])); tok = j.nextPageToken || ""; } while (tok);
  return out;
};
const walk = async (parentPath) => {
  for (const d of await listAll(parentPath)) {
    const path = d.name.split("/documents/")[1];
    const subs = (await call(`https://firestore.googleapis.com/v1/${d.name}:listCollectionIds`, { pageSize: 50 })).collectionIds || [];
    for (const c of subs) await walk(`${path}/${c}`);
    if (d.updateTime) del({ path, updateTime: d.updateTime }, "version 1 data");
  }
};
await walk(`users/${owner.id}/data`);

console.log(plan.join("\n"));
console.log(`writes: ${writes.length}`);
if (writes.length > 500) stop("more than 500 writes");
let res; try { res = await fs.commit(writes); } catch (e) { stop(`the commit was refused (${String(e.message || e).slice(0, 300)})`); }
console.log(res && res.commitTime ? `DONE: one commit at ${res.commitTime}` : `NOT DONE: ${JSON.stringify(res).slice(0, 300)}`);
