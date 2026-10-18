/* inv.mjs — READ-ONLY (Willy, 18 Oct 2026, 1:32 am: verify what is still open).
 * Are version 1 records still under users/{uid}? Counts only; writes nothing. */
const P = process.env.PROJECT, T = process.env.TOKEN;
const base = `https://firestore.googleapis.com/v1/projects/${P}/databases/(default)/documents`;
const call = async (url, body) => { const r = await fetch(url, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${T}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return r.json(); };
let users = [], tok = "";
do { const j = await call(`${base}/users?pageSize=300&showMissing=true&mask.fieldPaths=__none__${tok ? "&pageToken=" + tok : ""}`); users = users.concat(j.documents || []); tok = j.nextPageToken || ""; } while (tok);
console.log(`users/{uid} entries: ${users.length}`);
const tally = {};
let withLegacy = 0;
for (const u of users) {
  const ids = (await call(`${u.name.replace("/documents/", "/documents/")}:listCollectionIds`, { pageSize: 50 })).collectionIds || [];
  for (const c of ids) tally[c] = (tally[c] || 0) + 1;
  if (ids.some((c) => !["terms", "prefs"].includes(c))) withLegacy++;
}
console.log(`subcollections under users (count of accounts having each): ${JSON.stringify(tally)}`);
console.log(`accounts with anything besides terms and prefs (version 1 leftovers): ${withLegacy}`);
