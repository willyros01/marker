/* A stand-in for The Marker's Cloudflare worker, for the caddie UI test only:
 * the same caddie.js, against the Firestore emulator. Emulator sign-in tokens
 * are unsigned, so this reads them without checking a signature, which the
 * real worker never does. Never deployed. */
import http from "node:http";
import { client } from "../../worker/src/firestore.js";
import * as caddie from "../../worker/src/caddie.js";
import { Refusal } from "../../worker/src/post.js";

const fs = client({ project: process.env.PROJECT || "demo-marker", base: "http://127.0.0.1:8080/v1", token: async () => "owner" });
const who = (req) => {
  const t = String(req.headers.authorization || "").replace(/^Bearer /, "");
  const p = JSON.parse(Buffer.from(t.split(".")[1] || "", "base64url").toString() || "{}");
  return { uid: p.user_id || p.sub, anonymous: (p.firebase || {}).sign_in_provider === "anonymous" };
};
const routes = {
  "/caddie/start": (w, b) => caddie.start(fs, w, b.card),
  "/caddie/status": (w, b) => caddie.status(fs, w, b.liveId),
  "/caddie/stop": (w, b) => caddie.stop(fs, w, b.liveId),
  "/caddie/join": (w, b) => caddie.join(fs, w, b.code),
  "/caddie/scores": (w, b) => caddie.scores(fs, w, b),
};
http.createServer(async (req, res) => {
  const h = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") { res.writeHead(204, h); return res.end(); }
  let body = ""; for await (const c of req) body += c;
  const send = (code, obj) => { res.writeHead(code, h); res.end(JSON.stringify(obj)); };
  const fn = routes[new URL(req.url, "http://x").pathname];
  if (!fn) return send(404, { error: "NOT_FOUND" });
  try { send(200, await fn(who(req), JSON.parse(body || "{}"))); }
  catch (e) { if (e instanceof Refusal) send(200, { error: "REFUSED", reason: e.message }); else { console.log(e); send(503, { error: "TRY_LATER" }); } }
}).listen(8788, () => console.log("caddie worker stand-in on 8788"));
