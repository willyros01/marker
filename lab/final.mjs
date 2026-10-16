/* Final check: the worker's own scan() with Cloudflare's AI over REST, on the real pictures. */
import { readFileSync, writeFileSync } from "node:fs";
import * as search from "../worker/src/search.js";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN, ACC = process.env.ACC;
const ai = { run: async (model, input) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/ai/run/${model}`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j.errors)); return j.result; } };
const fs = { get: async () => null, commit: async () => ({}), name: (p) => p };
const out = [];
for (const f of ["lab/front.jpg", "lab/back.jpg", "lab/card1.jpg"]) {
  const img = "data:image/jpeg;base64," + readFileSync(f).toString("base64");
  try {
    const r = await search.scan(fs, { uid: "lab", anonymous: false }, img, ai);
    const w = r.tees.find((t) => /white/i.test(t.name)) || r.tees[0];
    out.push(`${f}: read ${r.holesRead.join(",")} · tees ${r.tees.map((t) => t.name).join("/")} · white ${w.rating}/${w.slope}`);
    out.push(`  par  ${w.holes.map((h) => h.par ?? "-").join(" ")}`);
    out.push(`  hcp  ${w.holes.map((h) => h.si ?? "-").join(" ")}`);
    out.push(`  yds  ${w.holes.map((h) => h.yards ?? "-").join(" ")}`);
    out.push(`  doubt ${JSON.stringify(w.doubt)}`);
  } catch (e) { out.push(`${f}: ERROR ${e.message}`); }
}
console.log(out.join("\n")); writeFileSync("lab-result.txt", out.join("\n"));
