/* inv.mjs — READ-ONLY (Willy, 22 Oct 2026, 2:46 pm): why Tidy keeps listing
 * five golfers as "in no group, with no rounds". Writes nothing. */
import { client } from "../worker/src/firestore.js";
const fs = client({ project: process.env.PROJECT, token: async () => process.env.TOKEN });
const all = await fs.query("", "golfers", [], 2000);
const want = ["Ruben Brina", "Daphne Brina", "Test Public1", "Test Public2", "Test V25"];
for (const g of all.filter((x) => want.includes(x.data.name))) {
  const d = g.data;
  console.log(`${d.name} (${g.id.slice(0, 6)}): archived=${d.archived === true} groups=${JSON.stringify(d.groups || null)} linkedUid=${d.linkedUid ? "set" : "none"} nameKey=${d.nameKey === null ? "null" : d.nameKey ? "set" : "absent"} editedIn=${d.editedIn || ""}`);
  for (const a of d.groups || []) {
    const grp = await fs.get(`associations/${a}`);
    console.log(`    group ${a.slice(0, 6)}: ${grp ? "exists" : "MISSING"}`);
  }
}
