/* A small Android driver: adb + uiautomator. The app's screens are web pages
 * inside a WebView; Android exposes their text, fields and buttons to
 * uiautomator, so the tests tap and type the way a person does. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const sh = (args, opts = {}) => execFileSync("adb", args, { encoding: opts.binary ? "buffer" : "utf8", maxBuffer: 64 << 20, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function nodes() {
  try { sh(["shell", "uiautomator", "dump", "/sdcard/ui.xml"]); } catch { return []; }
  const xml = sh(["shell", "cat", "/sdcard/ui.xml"]);
  const out = [];
  for (const m of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")]));
    const b = (a.bounds || "").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    out.push({ text: a.text || "", desc: a["content-desc"] || "", hint: a.hint || "", cls: a.class || "", pkg: a.package || "",
      checkable: a.checkable === "true", checked: a.checked === "true", x: (+b[1] + +b[3]) >> 1, y: (+b[2] + +b[4]) >> 1, h: +b[4] - +b[2] });
  }
  return out;
}
export const screenText = () => nodes().map((n) => n.text || n.desc).filter(Boolean).join(" | ");
export function front() {
  const s = sh(["shell", "dumpsys", "activity", "activities"]);
  const m = s.match(/(?:topResumedActivity|mResumedActivity)[^\n]*\{[^ ]+ [^ ]+ ([^ }]+)/);
  return m ? m[1] : "?";
}
export async function waitText(re, ms = 30000) {
  const end = Date.now() + ms; let t = "";
  while (Date.now() < end) { t = screenText(); if (re.test(t)) return t; await sleep(1500); }
  throw new Error(`waited for ${re}; the screen says: ${t.slice(0, 400)}`);
}
const tap = (x, y) => sh(["shell", "input", "tap", String(x), String(y)]);
export async function tapText(re, ms = 20000) {
  const end = Date.now() + ms; let scrolls = 0;
  while (Date.now() < end) {
    const n = nodes().filter((n) => (re.test(n.text) || re.test(n.desc)) && n.y > 60 && n.y < screenSize().h - 60).pop();
    if (n) { tap(n.x, n.y); await sleep(1500); return; }
    if (scrolls++ < 8) await scroll(); else await sleep(1000);
  }
  throw new Error(`no ${re} to tap; the screen says: ${screenText().slice(0, 400)}`);
}
/* Fills the n-th text field on screen (0 = first). */
export async function typeField(index, text) {
  const f = nodes().filter((n) => /EditText/.test(n.cls));
  if (!f[index]) throw new Error(`no text field #${index + 1}; the screen says: ${screenText().slice(0, 300)}`);
  tap(f[index].x, f[index].y); await sleep(600);
  sh(["shell", "input", "text", text.replace(/ /g, "%s").replace(/([&|<>;'"()$`\\])/g, "\\$1")]);
  await sleep(500);
}
export async function tick(re) {
  for (let i = 0; i < 12; i++) {
    const all = nodes(); const { h } = screenSize();
    const label = all.find((x) => re.test(x.text) && x.y > 60 && x.y < h - 60);
    if (label) {
      const boxes = all.filter((n) => n.checkable && !n.checked);
      const box = boxes.sort((a, b) => Math.abs(a.y - label.y) - Math.abs(b.y - label.y))[0];
      if (box && Math.abs(box.y - label.y) < 200) { tap(box.x, box.y); } else { tap(label.x, label.y); }
      await sleep(900);
      /* Confirm it is ticked now; tap the label itself if the box did not take it. */
      const after = nodes().filter((n) => n.checkable).sort((a, b) => Math.abs(a.y - label.y) - Math.abs(b.y - label.y))[0];
      if (!after || after.checked) return;
      tap(label.x, label.y); await sleep(900);
      const again = nodes().filter((n) => n.checkable).sort((a, b) => Math.abs(a.y - label.y) - Math.abs(b.y - label.y))[0];
      if (!again || again.checked) return;
      throw new Error(`the tick box near ${re} would not tick`);
    }
    await scroll();
  }
  throw new Error(`no tick box near ${re}; the screen says: ${screenText().slice(0, 300)}`);
}
let size = null;
export function screenSize() {
  if (!size) { const m = sh(["shell", "wm", "size"]).match(/(\d+)x(\d+)\s*$/m); size = m ? { w: +m[1], h: +m[2] } : { w: 1080, h: 2400 }; }
  return size;
}
export async function scroll() { const { w, h } = screenSize(); sh(["shell", "input", "swipe", String(w >> 1), String(Math.round(h * 0.75)), String(w >> 1), String(Math.round(h * 0.3)), "300"]); await sleep(900); }
export function hideKeyboard() { try { sh(["shell", "input", "keyevent", "111"]); } catch {} }
export function shot(file) { fs.writeFileSync(file, sh(["exec-out", "screencap", "-p"], { binary: true })); }
export function view(url) { sh(["shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-c", "android.intent.category.BROWSABLE", "-d", `'${url}'`]); }
export function launch(pkg) { sh(["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"]); }
export function reinstall(pkg, apk) {
  try { sh(["uninstall", pkg]); } catch {}
  sh(["install", "-r", apk]);
  try { sh(["shell", "pm", "set-app-links-user-selection", "--user", "0", "--package", pkg, "true", "www.cuberoot-systems.com"]); } catch {}
}
export { sleep };
export const logcat = () => sh(["logcat", "-d", "-v", "brief", "AndroidRuntime:E", "Capacitor:*", "Capacitor/Console:*", "chromium:W", "ActivityTaskManager:I", "*:S"]);
export const clearLog = () => sh(["logcat", "-c"]);

/* ---- Inside the app's web view (test copy only: web debugging switched on).
   Reads the screen as text and fills fields / presses buttons by their names,
   the same handlers a tap runs. The OS-level parts (which app opens a link)
   still go through Android itself. ---- */
let cdp = null, cdpPid = null, seq = 0;
async function connect(pkg = "io.github.willyros01.scorecard") {
  const pid = sh(["shell", "pidof", pkg]).trim();
  if (!pid) throw new Error("the app is not running");
  if (cdp && cdpPid === pid && cdp.readyState === 1) return cdp;
  try { cdp && cdp.close(); } catch {}
  try { sh(["forward", "--remove", "tcp:9222"]); } catch {}
  sh(["forward", "tcp:9222", `localabstract:webview_devtools_remote_${pid}`]);
  let pages = [];
  for (let i = 0; i < 20 && !pages.length; i++) {
    try { pages = (await (await fetch("http://127.0.0.1:9222/json")).json()).filter((p) => p.type === "page" && p.webSocketDebuggerUrl); } catch {}
    if (!pages.length) await sleep(1000);
  }
  if (!pages.length) throw new Error("could not reach the app's web view");
  cdp = new WebSocket(pages[0].webSocketDebuggerUrl); cdpPid = pid;
  await new Promise((ok, bad) => { cdp.onopen = ok; cdp.onerror = () => bad(new Error("web view connection failed")); });
  return cdp;
}
export async function js(expression) {
  const ws = await connect();
  const id = ++seq;
  const reply = new Promise((ok) => { const h = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener("message", h); ok(m); } }; ws.addEventListener("message", h); });
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  const m = await reply;
  if (m.result && m.result.exceptionDetails) throw new Error(`in the app: ${m.result.exceptionDetails.text}`);
  return m.result && m.result.result ? m.result.result.value : undefined;
}
export const appText = () => js("document.body.innerText");
export async function waitApp(re, ms = 30000) {
  const end = Date.now() + ms; let t = "";
  while (Date.now() < end) { try { t = await appText(); if (re.test(t)) return t; } catch (e) { t = String(e.message); } await sleep(1000); }
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
