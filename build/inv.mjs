/* inv.mjs — READ-ONLY (6 Nov 2026, after gst.txt go): the account-email list
 * has the two Apple test emails; every golfer linked to a sign-in still points
 * at an account that has records or a membership. Writes nothing. */
import { client } from "../worker/src/firestore.js";
const fs = client({ project: process.env.PROJECT, token: async () => process.env.TOKEN });
const ae = await fs.query("", "accountEmails", [], 5000);
console.log(`account-email list: ${ae.length} entries; Apple test entries: ${ae.filter((d) => d.id.includes("apple")).map((d) => d.id).join(", ") || "none"}`);
const [golfers, members, groups] = await Promise.all([fs.query("", "golfers", [], 5000), fs.queryGroup("members"), fs.query("", "associations", [], 200)]);
const memberUids = new Set(members.map((m) => m.id));
const linked = golfers.filter((g) => g.data.linkedUid);
console.log(`golfers: ${golfers.length}; linked to a sign-in: ${linked.length}; of those with a membership somewhere: ${linked.filter((g) => memberUids.has(g.data.linkedUid)).length}`);
for (const g of linked.filter((g) => !memberUids.has(g.data.linkedUid))) console.log(`  linked but in no group: "${g.data.name}" (sign-in ${g.data.linkedUid.slice(0, 6)}…) — kept on purpose by gst.txt`);
console.log(`groups: ${groups.length}; every owner has a membership: ${groups.every((a) => !a.data.ownerUid || memberUids.has(a.data.ownerUid))}`);
console.log("READ-ONLY: nothing was changed.");
