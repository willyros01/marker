/* inv.mjs — READ-ONLY (Willy, 22 Oct 2026, 6:01 pm): are the five removed public
 * golfers still stored. Writes nothing. Never prints an email: only a label. */
import { client } from "../worker/src/firestore.js";
const fs = client({ project: process.env.PROJECT, token: async () => process.env.TOKEN });
const label = (e) => { e = String(e || "").toLowerCase().trim();
  return e === "willyros01+apple@gmail.com" ? "APPLE ADMIN (demo account)" : e === "willyros01+apple02@gmail.com" ? "APPLE REGULAR USER" : e ? "other email" : "no email"; };
const golfers = await fs.query("", "golfers", [], 3000);
const gname = (id) => (golfers.find((g) => g.id === id) || { data: { name: "?" } }).data.name;
const groups = await fs.query("", "associations", [], 500);
for (const a of groups.filter((x) => /apple|public/i.test(x.data.name || ""))) {
  console.log(`\nGROUP "${a.data.name}" (${a.id.slice(0, 6)})`);
  const mem = await fs.query(`associations/${a.id}`, "members", [], 500);
  for (const m of mem) console.log(`  member: ${m.data.displayName || "?"} role=${m.data.role} golfer="${m.data.golferId ? gname(m.data.golferId) : "-"}" email=${label(m.data.email)}`);
  const ros = await fs.query(`associations/${a.id}`, "roster", [], 500);
  console.log(`  roster: ${ros.map((r) => gname(r.id)).join(", ")}`);
}
const names = ["Demo Public1", "Demo User3", "John Appleseed", "Pubic Test10", "Public Test02"];
console.log("\nGOLFERS");
for (const g of golfers.filter((x) => names.includes(x.data.name)))
  console.log(`  ${g.data.name}: linkedUid=${g.data.linkedUid ? "set" : "none"} archived=${g.data.archived === true} groups=${(g.data.groups || []).map((x) => (groups.find((a) => a.id === x) || { data: { name: "?" } }).data.name).join(" | ")}`);
const apps = await fs.query("", "applications", [], 500);
console.log("\nAPPLICATIONS");
for (const p of apps) console.log(`  ${p.data.fullName}: status=${p.data.status} email=${label(p.data.email)}`);
