/* fil.mjs — item 22 fill-in (Willy, 25 Oct 2026, 7:40 pm: "Build the Marker
 * portion now"). MODE=dry reads and reports only; MODE=go adds holePar and
 * holeSi to rounds already posted by The Marker. Nothing else is changed. */
import { client } from "../worker/src/firestore.js";
import { fillHoles } from "../worker/src/fillholes.js";
const MODE = "go";
const fs = client({ project: process.env.PROJECT, token: async () => process.env.TOKEN });
console.log("mode:", MODE);
const r = await fillHoles(fs, { go: MODE === "go", log: (s) => console.log(s) });
console.log(JSON.stringify(r));
