/* A small iPhone-simulator driver: xcrun simctl for the phone itself, and the
 * app's web view through Safari's Web Inspector protocol (ios_webkit_debug_proxy),
 * test copy only. Same helpers as adb.mjs: fill, press, check, waitApp. */
import { execFileSync } from "node:child_process";
const UDID = process.env.UDID;
const sim = (...a) => execFileSync("xcrun", ["simctl", ...a], { encoding: "utf8", maxBuffer: 64 << 20 });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function shot(file) { sim("io", UDID, "screenshot", file); }
export function openurl(url) { sim("openurl", UDID, url); }
export function launch(bid) { sim("launch", UDID, bid); }
export function terminate(bid) { try { sim("terminate", UDID, bid); } catch {} }
export function reinstall(bid, app) { try { sim("uninstall", UDID, bid); } catch {} sim("install", UDID, app); }
export function running(bid) { try { return /\S/.test(sim("spawn", UDID, "launchctl", "list").split("\n").filter((l) => l.includes(`UIKitApplication:${bid}`)).join("")); } catch { return false; } }

let ws = null, target = null, seq = 0;
const waiting = new Map();
async function connect() {
  if (ws && ws.readyState === 1 && target !== undefined) return;
  try { ws && ws.close(); } catch {}
  ws = null; target = null;
  let page = null;
  for (let i = 0; i < 90 && !page; i++) {
    try { page = (await (await fetch("http://127.0.0.1:9222/json")).json()).find((p) => /^capacitor:\/\/localhost/.test(p.url || "")); } catch {}
    if (!page) await sleep(1000);
  }
  if (!page) throw new Error("could not reach the app's web view (Web Inspector)");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Target.targetCreated" && m.params && m.params.targetInfo && m.params.targetInfo.type === "page") target = m.params.targetInfo.targetId;
    if (m.method === "Target.dispatchMessageFromTarget") { const inner = JSON.parse(m.params.message); const w = waiting.get(inner.id); if (w) { waiting.delete(inner.id); w(inner); } }
    else if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); w(m); }
  };
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error("Web Inspector connection failed")); });
  for (let i = 0; i < 30 && !target; i++) await sleep(100);   // newer iOS announces the page as a target
}
export function disconnect() { try { ws && ws.close(); } catch {} ws = null; target = null; }
async function js1(expression) {
  await connect();
  const id = ++seq;
  const msg = { id, method: "Runtime.evaluate", params: { expression, returnByValue: true } };
  const reply = new Promise((ok, bad) => { waiting.set(id, ok); setTimeout(() => { if (waiting.delete(id)) bad(new Error("the app did not answer")); }, 15000); });
  ws.send(JSON.stringify(target ? { id: ++seq, method: "Target.sendMessageToTarget", params: { targetId: target, message: JSON.stringify(msg) } } : msg));
  const m = await reply;
  const r = m.result || {};
  if (r.wasThrown) throw new Error(`in the app: ${JSON.stringify(r.result).slice(0, 200)}`);
  return r.result ? r.result.value : undefined;
}
/* The page can be replaced under us (sign-in reloads it): reconnect and try again once. */
export async function js(expression) {
  try { return await js1(expression); }
  catch (e) { if (!/did not answer|connection/.test(e.message)) throw e; disconnect(); await sleep(2000); return js1(expression); }
}
export const appText = () => js("document.body.innerText");
export async function waitApp(re, ms = 30000) {
  const end = Date.now() + ms; let t = "";
  while (Date.now() < end) { try { t = await appText(); if (re.test(t)) return t; } catch (e) { t = String(e.message); disconnect(); } await sleep(1000); }
  throw new Error(`waited for ${re}; the app shows: ${String(t).replace(/\s+/g, " ").slice(0, 400)}`);
}
export async function fill(selector, value) {
  const ok = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
    el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  if (!ok) throw new Error(`no field ${selector}; the app shows: ${(await appText()).replace(/\s+/g, " ").slice(0, 300)}`);
}
export async function press(selector) {
  const ok = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`);
  if (!ok) throw new Error(`no button ${selector}; the app shows: ${(await appText()).replace(/\s+/g, " ").slice(0, 300)}`);
  await sleep(1200);
}
export async function check(selector) {
  const ok = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; if (!el.checked) el.click(); return el.checked; })()`);
  if (!ok) throw new Error(`could not tick ${selector}`);
}
