/* A stand-in for The Marker's Cloudflare worker, for the user-guide pictures
 * only (Willy, 13 Nov 2026: "do docs now"). The same worker modules as the
 * real one (posting, corrections, caddie, follow, games, course library and
 * photo checks), against the Firestore emulator. Two things are faked:
 *   - the online course search answers with the made-up course already in
 *     the library (no golf course database is called);
 *   - the AI that reads a scorecard photo answers with a made-up card.
 * Emulator sign-in tokens are unsigned, so they are read without a signature
 * check, which the real worker never does. Never deployed. */
import http from "node:http";
import { client } from "../../worker/src/firestore.js";
import * as caddie from "../../worker/src/caddie.js";
import * as follow from "../../worker/src/follow.js";
import * as game from "../../worker/src/game.js";
import * as search from "../../worker/src/search.js";
import * as fix from "../../worker/src/correct.js";
import { Refusal, processSubmission } from "../../worker/src/post.js";

const fs = client({ project: process.env.PROJECT || "demo-marker", base: "http://127.0.0.1:8080/v1", token: async () => "owner" });
const who = (req) => {
  const t = String(req.headers.authorization || "").replace(/^Bearer /, "");
  const p = JSON.parse(Buffer.from(t.split(".")[1] || "", "base64url").toString() || "{}");
  return { uid: p.user_id || p.sub, anonymous: (p.firebase || {}).sign_in_provider === "anonymous" };
};

/* The made-up club card the fake AI "reads": Maple Ridge, White and Blue tees. */
const PAR = [4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 5, 3, 4, 4, 3, 4, 5, 4];
const HCP = [5, 11, 17, 1, 9, 13, 15, 3, 7, 6, 2, 18, 12, 8, 16, 10, 4, 14];
const WHITE = [372, 341, 156, 498, 388, 330, 171, 512, 395, 380, 505, 148, 352, 401, 162, 366, 520, 389];
const BLUE = WHITE.map((y) => y + 22);
const sum = (a, from, to) => a.slice(from, to).reduce((x, y) => x + y, 0);
const FAKE_CARD = {
  course: "Maple Ridge Golf Club",
  holes: PAR.map((par, i) => ({ hole: i + 1, par, hcp: HCP[i], yards: { White: WHITE[i], Blue: BLUE[i] } })),
  tees: [
    { name: "Blue", rating: 71.8, slope: 129, out: sum(BLUE, 0, 9), in: sum(BLUE, 9, 18), total: sum(BLUE, 0, 18) },
    { name: "White", rating: 69.9, slope: 123, out: sum(WHITE, 0, 9), in: sum(WHITE, 9, 18), total: sum(WHITE, 0, 18) },
  ],
  parOut: sum(PAR, 0, 9), parIn: sum(PAR, 9, 18),
};
const fakeAI = { run: async () => ({ response: JSON.stringify(FAKE_CARD), usage: { neurons: 400 } }) };

const fixRoutes = {
  "/correctable": async (w) => ({ cards: await fix.correctable(fs, w) }),
  "/correction-card": (w, b) => fix.cardForCorrection(fs, w, b.cardId),
  "/correct": (w, b) => fix.correct(fs, w, b),
  "/my-cards": (w) => fix.myCards(fs, w),
  "/hide-editable": (w, b) => fix.hideEditable(fs, w, b.cardId, { hidden: b.hidden !== false }),
  "/delete-rounds": (w, b) => fix.deleteRounds(fs, w, b.cardId),
  "/discard-editable": (w, b) => fix.discardEditable(fs, w, b.cardId),
};
const routes = {
  ...fixRoutes,
  "/search": async (w, b, q) => {
    const words = String(q.get("q") || "").toLowerCase();
    const all = await fs.query("", "markerCourses", [], 50);
    return { courses: all.filter((d) => !d.data.manual && d.data.name.toLowerCase().includes(words.split(" ")[0]))
      .map((d) => ({ id: d.id, providerId: d.id, name: d.data.name, where: d.data.where })) };
  },
  "/course": async (w, b, q) => ({ course: await search.course(fs, w, q.get("id"), null) }),
  "/withdrawn": async () => ({ courses: await search.withdrawnList(fs) }),
  "/scan-status": (w) => search.scanStatus(fs, w),
  "/scan": async (w, b) => ({ scan: await search.scan(fs, w, b.image, fakeAI) }),
  "/verify": async (w, b) => ({ course: await search.verify(fs, w, b) }),
  "/wake": (w, b) => processSubmission(fs, b.cardId, { onlyScorer: w.uid }),
  "/caddie/start": (w, b) => caddie.start(fs, w, b.card, { liveId: b.liveId || null }),
  "/caddie/status": (w, b) => caddie.status(fs, w, b.liveId),
  "/caddie/stop": (w, b) => caddie.stop(fs, w, b.liveId),
  "/caddie/join": (w, b) => caddie.join(fs, w, b.code),
  "/caddie/scores": (w, b) => caddie.scores(fs, w, b),
  "/follow/start": (w, b) => follow.start(fs, w, { card: b.card, liveId: b.liveId || null }),
  "/follow/scores": (w, b) => follow.scores(fs, w, b),
  "/follow/view": (w, b) => follow.view(fs, w, b.code),
  "/follow/game": (w, b) => follow.gameStart(fs, w, { card: b.card, liveId: b.liveId || null }),
  "/follow/game-create": (w, b) => game.create(fs, w, b),
  "/follow/game-join": (w, b) => game.join(fs, w, b.code),
};
http.createServer(async (req, res) => {
  const h = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") { res.writeHead(204, h); return res.end(); }
  let body = ""; for await (const c of req) body += c;
  const send = (code, obj) => { res.writeHead(code, h); res.end(JSON.stringify(obj)); };
  const url = new URL(req.url, "http://x");
  const fn = routes[url.pathname];
  if (!fn) return send(404, { error: "NOT_FOUND" });
  try { send(200, await fn(who(req), JSON.parse(body || "{}"), url.searchParams)); }
  catch (e) {
    if (e instanceof Refusal) send(200, { error: "REFUSED", reason: e.message });
    else if (e instanceof search.LimitReached) send(200, { error: "LIMIT" });
    else if (e && /^[A-Z_]+$/.test(e.message || "")) send(200, { error: e.message, problems: e.problems || [] });
    else { console.log(url.pathname, e); send(503, { error: "TRY_LATER" }); }
  }
}).listen(8788, () => console.log("doc worker stand-in on 8788"));
