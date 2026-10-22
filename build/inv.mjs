/* inv.mjs — READ-ONLY (Willy, 22 Oct 2026, 6:34 pm): the Marker server's
 * address and what /cleanup-status answers. Writes nothing. */
import { client } from "../worker/src/firestore.js";
const fs = client({ project: process.env.PROJECT, token: async () => process.env.TOKEN });
const cfg = await fs.get("markerConfig/public");
const url = String(cfg && cfg.data.workerUrl || "").replace(/\/+$/, "");
console.log("server:", url, "version:", cfg && cfg.data.version);
await new Promise((r) => setTimeout(r, 90000));      /* let the new version settle */
const res = await fetch(url + "/cleanup-status");
console.log("GET /cleanup-status ->", res.status, await res.text());
