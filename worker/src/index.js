/* The Marker worker (Cloudflare). See docs in the design document.
 *
 *   GET  /health             -> { ok, version }
 *   GET  /search?q=...       -> { courses: [...] }       any sign-in, counted
 *   GET  /course?id=...      -> { course: {...} }        any sign-in, counted, saved to the library
 *   POST /wake  {cardId}     -> { status, reason?, rounds? }   the card's own scorer only
 *   every 5 minutes          -> posts a card still waiting (one per run)
 *
 * Secrets: SA_KEY (marker-worker service-account key, JSON), GOLF_KEY.
 * Vars:    PROJECT, ORIGINS (comma-separated), VERSION.
 */
import { client } from "./firestore.js";
import { accessToken } from "./google.js";
import { verifyIdToken } from "./verify.js";
import { processSubmission, sweep } from "./post.js";
import * as search from "./search.js";

const fsFor = (env) => client({ project: env.PROJECT, token: () => accessToken(env.SA_KEY) });

function cors(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = String(env.ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.includes(origin) ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  } : { Vary: "Origin" };
}

const reply = (body, status, headers) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
});

async function caller(req, env) {
  const h = req.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  return verifyIdToken(token, env.PROJECT);
}

export default {
  async fetch(req, env) {
    const h = cors(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    const url = new URL(req.url);
    try {
      if (url.pathname === "/health") return reply({ ok: true, version: env.VERSION || "" }, 200, h);

      let who;
      try { who = await caller(req, env); }
      catch { return reply({ error: "SIGN_IN" }, 401, h); }
      const fs = fsFor(env);

      if (url.pathname === "/search" && req.method === "GET") {
        try { return reply({ courses: await search.search(fs, who, url.searchParams.get("q"), env.GOLF_KEY) }, 200, h); }
        catch (e) { return reply({ error: e instanceof search.LimitReached ? "LIMIT" : e.message }, 200, h); }
      }
      if (url.pathname === "/course" && req.method === "GET") {
        try { return reply({ course: await search.course(fs, who, url.searchParams.get("id"), env.GOLF_KEY) }, 200, h); }
        catch (e) { return reply({ error: e instanceof search.LimitReached ? "LIMIT" : e.message }, 200, h); }
      }
      if (url.pathname === "/wake" && req.method === "POST") {
        if (who.anonymous) return reply({ error: "SIGN_IN" }, 403, h);
        const body = await req.json().catch(() => ({}));
        return reply(await processSubmission(fs, body.cardId, { onlyScorer: who.uid }), 200, h);
      }
      return reply({ error: "NOT_FOUND" }, 404, h);
    } catch (e) {
      console.log("failed:", e && e.message);
      return reply({ error: "TRY_LATER" }, 503, h);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sweep(fsFor(env), { log: (m) => console.log(m) }).then((r) => console.log("sweep", JSON.stringify(r))));
  },
};
