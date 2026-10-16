/* Scan lab: tries Cloudflare AI models and prompts on real scorecard pictures,
   scores each reading against the true card. Runs only in GitHub Actions. */
import { readFileSync, writeFileSync } from "node:fs";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN, ACC = process.env.ACC;
const api = (p, body) => fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}${p}`, {
  method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

const TRUTH = {
  par: [4,3,5,4,4,4,4,3,5, 5,3,4,4,4,4,4,3,5],
  hcp: [6,10,4,8,16,2,14,18,12, 13,17,15,7,3,11,5,9,1],
  white: [375,143,482,363,216,385,322,124,506, 434,116,359,319,386,347,371,171,539],
  rating: 69.7, slope: 130,
};

const PROMPT = `This picture shows a golf course scorecard (it may be a photo or a screenshot, possibly with other things around it).
The scorecard table has one COLUMN per hole; the hole numbers are in the header row (often labelled HOLE). Some cards print holes 10-18 in a separate table, sometimes above holes 1-9.
Each tee is one ROW of yardages, usually named by a colour (Black, Gold, Blue, White, Red...); next to the name there may be "rating / slope", e.g. "69.7 / 130". There is a row for PAR and a row for HANDICAP (or HCP, Hdcp, S.I., Index).
Read every table and answer with JSON only, in this shape:
{"course": "<course name or empty>",
 "holes": [ { "hole": <hole number>, "par": <par>, "hcp": <handicap number>, "yards": { "<tee name>": <yards>, ... } }, ... one entry per hole column, holes 1 to 18 ],
 "tees": [ { "name": "<tee name>", "rating": <number or null>, "slope": <number or null>, "out": <OUT total or null>, "in": <IN total or null> } ],
 "parOut": <par OUT total or null>, "parIn": <par IN total or null> }
Read each number from the column of its own hole. Use null for anything you cannot read. Never guess. Do not include OUT, IN or TOTAL columns as holes.
For holes 10-18, a tee row may not be named; it is the same tee as the row in the same position (same colour) in the holes 1-9 table.`;

function grade(r) {
  const holes = Array.isArray(r && r.holes) ? r.holes : [];
  const by = Object.fromEntries(holes.map((h) => [Number(h.hole), h]));
  let par = 0, hcp = 0, yds = 0;
  for (let i = 0; i < 18; i++) {
    const h = by[i + 1] || {};
    if (Number(h.par) === TRUTH.par[i]) par++;
    if (Number(h.hcp) === TRUTH.hcp[i]) hcp++;
    const y = h.yards || {}; const k = Object.keys(y).find((k) => /white/i.test(k));
    if (k && Number(y[k]) === TRUTH.white[i]) yds++;
  }
  const w = (r && r.tees || []).find((t) => /white/i.test(t.name || ""));
  return { par, hcp, whiteYards: yds, whiteRating: w ? `${w.rating}/${w.slope}` : "none", holes: holes.length };
}

const img = (f) => "data:image/jpeg;base64," + readFileSync(f).toString("base64");
const out = [];
const log = (...a) => { const s = a.join(" "); console.log(s); out.push(s); };

const list = await api("/ai/models/search?per_page=200");
const vision = (list.json.result || []).filter((m) => /vision|image-to-text|multimodal|image understanding|vision-language/i.test(JSON.stringify([m.description, m.task, m.properties])));
log("VISION-ISH MODELS:", vision.map((m) => m.name).join(", "));

const MODELS = (process.env.MODELS || "").split(",").filter(Boolean);
const IMAGES = ["lab/card1.jpg", "lab/card3.jpg", "lab/front.jpg", "lab/back.jpg"];
for (const model of MODELS) {
  for (const f of IMAGES) {
    const t0 = Date.now();
    const res = await api(`/ai/run/${model}`, {
      messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: img(f) } }] }],
      max_tokens: 4000, temperature: 0,
    });
    const ms = Date.now() - t0;
    let resp = res.json.result && (res.json.result.response ?? res.json.result);
    let parsed = resp;
    if (typeof resp === "string") { const m = resp.match(/\{[\s\S]*\}/); try { parsed = JSON.parse(m ? m[0] : resp); } catch { parsed = null; } }
    const usage = res.json.result && res.json.result.usage;
    log(`\n=== ${model} · ${f} · HTTP ${res.status} · ${ms} ms · usage ${JSON.stringify(usage || {})}`);
    if (res.status !== 200) { log("ERROR", JSON.stringify(res.json.errors || res.json).slice(0, 400)); continue; }
    log("GRADE", JSON.stringify(grade(parsed)));
    log("RAW", (typeof resp === "string" ? resp : JSON.stringify(resp)).slice(0, 3000));
  }
}
writeFileSync("lab-result.txt", out.join("\n"));
