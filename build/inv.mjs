/* inv.mjs — Willy's go-ahead (18 Oct 2026, 00:21): add the missing id to the
 * Lakeview course the worker created, and nothing else. Checks the record is
 * the one expected first; one field, one record. */
import { client, updateWrite } from "../worker/src/firestore.js";
const fs = client({ project: process.env.PROJECT, token: async () => process.env.TOKEN });
const ID = "mvdak5q2dikg2u";
const c = await fs.get(`courses/${ID}`);
if (!c || c.data.name !== "Lakeview Golf Course" || c.data.createdVia !== "marker" || c.data.id) { console.log("Not as expected; nothing changed: " + JSON.stringify(c && { name: c.data.name, id: c.data.id })); process.exit(1); }
await fs.commit([updateWrite(fs, c.path, { id: ID }, { updateTime: c.updateTime })]);
const after = await fs.get(`courses/${ID}`);
console.log(`Lakeview course id field now: ${after.data.id}; fields: ${Object.keys(after.data).sort().join(", ")}`);
const all = await fs.query("", "courses", [], 1000);
console.log(`courses without their own id field: ${all.filter((x) => x.data.id !== x.id).map((x) => x.id).join(", ") || "none"}`);
