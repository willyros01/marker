/* Probe: what does Cloudflare's AI answer right now, for the model the worker uses? */
import { readFileSync, writeFileSync } from "node:fs";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN, ACC = process.env.ACC;
const out = [];
const run = async (model, body) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/ai/run/${model}`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  out.push(`${model}: HTTP ${r.status} ${JSON.stringify(j.errors || [])} usage ${JSON.stringify((j.result && j.result.usage) || {})}`);
};
await run("@cf/qwen/qwen3.8-27b", { messages: [{ role: "user", content: "Say OK /no_think" }], max_tokens: 10, chat_template_kwargs: { enable_thinking: false } });
await run("@cf/meta/llama-4-scout-17b-16e-instruct", { messages: [{ role: "user", content: "Say OK" }], max_tokens: 5 });
/* Neurons used today, from Cloudflare's analytics (if the token may read them). */
const since = new Date(); since.setUTCHours(0, 0, 0, 0);
const q = { query: `query { viewer { accounts(filter:{accountTag:"${ACC}"}) { aiInferenceAdaptiveGroups(limit: 50, filter:{datetime_geq:"${since.toISOString()}"}) { sum { totalNeurons } count dimensions { modelId } } } } }` };
const g = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(q) });
out.push("analytics: " + JSON.stringify(await g.json()).slice(0, 1500));
console.log(out.join("\n")); writeFileSync("lab-result.txt", out.join("\n"));
