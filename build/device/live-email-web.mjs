/* The Scorecard's web app: Forgot password against the LIVE Firebase and the
 * live Cloudflare helper, in a phone-sized browser. The files come from the
 * branch being tested (./scw), served at the web app's real address
 * (https://willyros01.github.io/scorecard/) so the helper accepts it exactly
 * as it accepts the published web app. Nothing is published.
 * usage: node live-email-web.mjs OUT BROWSER ADDRESS   (BROWSER: chromium | webkit) */
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, devices } from "playwright";
const [OUT = "out", NAME = "chromium", ADDRESS] = process.argv.slice(2);
const ROOT = path.resolve("scw"), BASE = "https://willyros01.github.io/scorecard/";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
fs.mkdirSync(OUT, { recursive: true });
const browser = await (NAME === "webkit" ? webkit : chromium).launch();
const ctx = await browser.newContext({ ...devices[NAME === "webkit" ? "iPhone 13" : "Pixel 7"], serviceWorkers: "block" });
await ctx.route(BASE + "**", async (route) => {
  let rel = decodeURIComponent(new URL(route.request().url()).pathname.slice("/scorecard/".length)) || "index.html";
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: "not found" });
  return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || "application/octet-stream", body: fs.readFileSync(file) });
});
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: `${OUT}/web-${NAME}-${n}.png` });
try {
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => /Terms of Use|Forgot the password/.test(document.body.innerText), null, { timeout: 60000 });
  if (await page.locator("[data-terms-tick]").count()) { await page.locator("[data-terms-tick]").check(); await page.locator("#termsAccept").click(); }
  await page.getByText("Forgot the password").waitFor({ timeout: 30000 });
  console.log(`PASS ${NAME}: the web app opened at the Sign in screen (version ${await page.evaluate(() => self.APP_VERSION)})`);
  await page.locator('[name="email"]').fill(ADDRESS); await shot("email-typed");
  await page.locator('[data-act="reset-password"]').click();
  await page.waitForFunction(() => /Link sent to|Couldn.t send/.test(document.body.innerText), null, { timeout: 60000 });
  await shot("after-forgot-password");
  const t = await page.evaluate(() => document.body.innerText);
  if (!/Choose a new password for The Scorecard/.test(t)) throw new Error(`the helper did not send it: ${t.replace(/\s+/g, " ").slice(0, 300)}`);
  console.log(`PASS ${NAME}: the web app says the email "Choose a new password for The Scorecard" was sent (sent by the helper)`);
} catch (e) {
  try { await shot("failed"); } catch {}
  console.log(`FAIL ${NAME}: ${String(e.message || e).slice(0, 500)}`);
  process.exitCode = 1;
} finally { await browser.close(); }
