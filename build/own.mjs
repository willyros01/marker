/* own.mjs — item 21 (Willy, 26 Oct 2026, 8:34 am: "Yes, pls go ahead").
 * Writes the one app-owner record, appOwners/{uid} = { active: true }, for
 * Willy. MODE=dry only shows who would get it (the group creators, their
 * golfer name and the groups they own); MODE=go writes it for the single
 * group creator, refusing if there is not exactly one. Nothing else changes. */
import { client, setWrite } from "../worker/src/firestore.js";
const MODE = "dry";
const fs = client({ project: process.env.PROJECT, token: async () => process.env.TOKEN });
console.log("mode:", MODE);
const creators = await fs.query("", "groupCreators", [], 50);
const golfers = await fs.query("", "golfers", [], 5000);
const groups = await fs.query("", "associations", [], 500);
for (const c of creators) {
  const g = golfers.filter((x) => x.data.linkedUid === c.id).map((x) => x.data.name);
  const owns = groups.filter((a) => a.data.ownerUid === c.id).map((a) => a.data.name);
  const already = await fs.get(`appOwners/${c.id}`);
  console.log(`creator uid=${c.id.slice(0, 6)}… golfer=${JSON.stringify(g)} owns ${owns.length} of ${groups.length} groups ${JSON.stringify(owns)} appOwner=${already ? JSON.stringify(already.data) : "none"}`);
}
const notOwned = groups.filter((a) => !creators.some((c) => c.id === a.data.ownerUid)).map((a) => a.data.name);
console.log("groups not owned by a group creator:", JSON.stringify(notOwned));
if (MODE === "go") {
  if (creators.length !== 1) throw new Error(`expected exactly one group creator, found ${creators.length}`);
  const uid = creators[0].id;
  await fs.commit([setWrite(fs, `appOwners/${uid}`, { active: true, note: "App owner override (item 21), Willy 26 Oct 2026" }, { exists: false, now: ["since"] })]);
  console.log("written: appOwners/" + uid.slice(0, 6) + "…", JSON.stringify((await fs.get(`appOwners/${uid}`)).data));
}
