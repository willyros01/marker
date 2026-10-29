/* The Marker worker (Cloudflare). See docs in the design document.
 *
 *   GET  /health             -> { ok, version }
 *   GET  /search?q=...       -> { courses: [...] }       any sign-in, counted
 *   GET  /course?id=...      -> { course: {...} }        any sign-in, counted, saved to the library
 *   GET  /withdrawn          -> { courses: [...] }       withdrawn courses: names, tee figures, ids
 *   GET  /scan-status        -> { left, why }            about how many pictures can still be read today
 *   POST /scan  {image}      -> { scan: {course, tees} } any sign-in, counted: reads a scorecard photo
 *   POST /verify {scanIds, replaceId?, name?} -> { course }  signed-in only: a verified card replaces the course
 *   POST /wake  {cardId}     -> { status, reason?, rounds? }   the card's own scorer only
 *   POST /correctable        -> { cards: [...] }  posted cards this caller may correct
 *   POST /correction-card {cardId} -> { card, handicaps, ... }  one card, to correct
 *   POST /correct {cardId, scores} -> { status, changed }  saves a correction in one commit
 *   POST /delete-rounds {cardId} -> { status, deleted }  deletes a card's rounds from The Scorecard in one commit
 *   POST /discard-editable {cardId} -> { status }  deletes a card with deleted rounds from the lists for good
 *   POST /my-cards           -> { correctable, editable }  for the Your cards screen
 *   POST /hide-editable {cardId, hidden} -> { status }  hides (or shows again) a card with deleted rounds
 *   POST /caddie/start {card}        -> { liveId, code, expiresAt }   members: a code for a caddie
 *   POST /caddie/status {liveId}     -> { status, joined, scores, lastAt }   the card's member
 *   POST /caddie/stop {liveId}       -> { status }   the member takes the card back
 *   POST /caddie/join {code}         -> { liveId, setup, scores }   any sign-in (a caddie needs no account)
 *   POST /caddie/scores {liveId, scores, done} -> { status }   the caddie who joined
 *   every 5 minutes          -> posts a card still waiting (one per run)
 *   GET  /cleanup-status     -> { ok, lastRun, hoursAgo, ... }  no sign-in; 503 when the
 *                               daily clean-up has not run for 48 hours (cron-job.org watchdog)
 *   once a day (07:00 UTC)   -> deletes golfers unused for 7 days (cleanup.js)
 *
 * Secrets: SA_KEY (marker-worker service-account key, JSON), GOLF_KEY.
 * Binding: AI (Cloudflare Workers AI, free allowance) for /scan.
 * Vars:    PROJECT, ORIGINS (comma-separated), VERSION.
 */
import { client } from "./firestore.js";
import { accessToken } from "./google.js";
import { verifyIdToken } from "./verify.js";
import { processSubmission, sweep } from "./post.js";
import * as search from "./search.js";
import * as fix from "./correct.js";
import { Refusal } from "./post.js";
import { cleanGolfers, cleanupStatus } from "./cleanup.js";
import * as caddie from "./caddie.js";

/* Must match the daily line in wrangler.toml. 07:00 UTC = 3 am Toronto (summer), 2 am (winter). */
const DAILY = "0 7 * * *";

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
      if (url.pathname === "/cleanup-status" && req.method === "GET") {
        const st = await cleanupStatus(fsFor(env));
        return reply(st, st.ok ? 200 : 503, h);   /* 503 makes the watchdog send its email */
      }

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
      if (url.pathname === "/withdrawn" && req.method === "GET") {
        return reply({ courses: await search.withdrawnList(fs) }, 200, h);
      }
      if (url.pathname === "/scan-status" && req.method === "GET") {
        return reply(await search.scanStatus(fs, who), 200, h);
      }
      if (url.pathname === "/scan" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        try { return reply({ scan: await search.scan(fs, who, body.image, env.AI) }, 200, h); }
        catch (e) { return reply({ error: e instanceof search.LimitReached ? "SCAN_LIMIT" : e.message }, 200, h); }
      }
      if (url.pathname === "/verify" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        try { return reply({ course: await search.verify(fs, who, body) }, 200, h); }
        catch (e) { return reply({ error: e.message, problems: e.problems || [] }, 200, h); }
      }
      if (url.pathname === "/wake" && req.method === "POST") {
        if (who.anonymous) return reply({ error: "SIGN_IN" }, 403, h);
        const body = await req.json().catch(() => ({}));
        return reply(await processSubmission(fs, body.cardId, { onlyScorer: who.uid }), 200, h);
      }
      if (["/correctable", "/correction-card", "/correct", "/my-cards", "/hide-editable", "/delete-rounds", "/discard-editable"].includes(url.pathname) && req.method === "POST") {
        if (who.anonymous) return reply({ error: "SIGN_IN" }, 403, h);
        const body = await req.json().catch(() => ({}));
        try {
          if (url.pathname === "/discard-editable") return reply(await fix.discardEditable(fs, who, body.cardId), 200, h);
          if (url.pathname === "/delete-rounds") return reply(await fix.deleteRounds(fs, who, body.cardId), 200, h);
          if (url.pathname === "/my-cards") return reply(await fix.myCards(fs, who), 200, h);
          if (url.pathname === "/hide-editable") return reply(await fix.hideEditable(fs, who, body.cardId, { hidden: body.hidden !== false }), 200, h);
          if (url.pathname === "/correctable") return reply({ cards: await fix.correctable(fs, who) }, 200, h);
          if (url.pathname === "/correction-card") return reply(await fix.cardForCorrection(fs, who, body.cardId), 200, h);
          return reply(await fix.correct(fs, who, body), 200, h);
        } catch (e) {
          if (e instanceof Refusal) return reply({ error: "REFUSED", reason: e.message }, 200, h);
          throw e;
        }
      }
      if (url.pathname.startsWith("/caddie/") && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        try {
          if (url.pathname === "/caddie/start") return reply(await caddie.start(fs, who, body.card), 200, h);
          if (url.pathname === "/caddie/status") return reply(await caddie.status(fs, who, body.liveId), 200, h);
          if (url.pathname === "/caddie/stop") return reply(await caddie.stop(fs, who, body.liveId), 200, h);
          if (url.pathname === "/caddie/join") return reply(await caddie.join(fs, who, body.code), 200, h);
          if (url.pathname === "/caddie/scores") return reply(await caddie.scores(fs, who, body), 200, h);
        } catch (e) {
          if (e instanceof Refusal) return reply({ error: "REFUSED", reason: e.message }, 200, h);
          throw e;
        }
      }
      return reply({ error: "NOT_FOUND" }, 404, h);
    } catch (e) {
      console.log("failed:", e && e.message);
      return reply({ error: "TRY_LATER" }, 503, h);
    }
  },

  async scheduled(event, env, ctx) {
    if (event && event.cron === DAILY) {
      ctx.waitUntil(cleanGolfers(fsFor(env), { log: (m) => console.log(m) })
        .then((r) => console.log("golfer clean-up", JSON.stringify({ ...r, pending: undefined })))
        .catch((e) => console.log("golfer clean-up failed, nothing deleted:", e && e.message)));
      return;
    }
    ctx.waitUntil(sweep(fsFor(env), { log: (m) => console.log(m) }).then((r) => console.log("sweep", JSON.stringify(r))));
  },
};
