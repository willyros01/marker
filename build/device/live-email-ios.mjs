/* The Scorecard's Forgot password on the iPhone simulator, against the LIVE
 * Firebase and the live Cloudflare helper, the way a golfer does it: fresh
 * install, Terms, Sign in screen, type the email, tap Forgot the password.
 * The email itself is then checked in the apps' Gmail inbox (inbox.py).
 * usage: node live-email-ios.mjs OUT APP ADDRESS */
import fs from "node:fs";
import * as s from "./sim.mjs";
const [OUT = "out", APP, ADDRESS] = process.argv.slice(2);
const BID = "io.github.willyros01.scorecard";
fs.mkdirSync(OUT, { recursive: true });
let step = 0;
const snap = (name) => s.shot(`${OUT}/ios-${String(++step).padStart(2, "0")}-${name}.png`);
try {
  s.reinstall(BID, APP); s.launch(BID); await s.sleep(8000);
  await s.waitApp(/Terms of Use|Forgot the password/, 90000);
  if (await s.js(`!!document.querySelector("[data-terms-tick]")`)) {
    snap("terms"); await s.check("[data-terms-tick]"); await s.press("#termsAccept"); await s.sleep(1500);
  }
  await s.waitApp(/Forgot the password/, 30000);
  console.log(`PASS iphone: the app opened at the Sign in screen (version ${await s.js("self.APP_VERSION")})`);
  await s.fill('[name="email"]', ADDRESS); snap("sign-in-email-typed");
  await s.press('[data-act="reset-password"]');
  const t = await s.waitApp(/Link sent to|Couldn.t send/, 60000);
  snap("after-forgot-password");
  if (!/Choose a new password for The Scorecard/.test(t)) throw new Error(/Sign in to The Scorecard"/.test(t) ? "the screen names the wrong email title (Sign in to The Scorecard); the inbox check below shows which email really came" : `no confirmation on screen: ${t.replace(/\s+/g, " ").slice(0, 300)}`);
  console.log('PASS iphone: the app says the email "Choose a new password for The Scorecard" was sent (sent by the helper)');
} catch (e) {
  try { snap("failed"); } catch {}
  console.log(`FAIL iphone: ${String(e.message || e).slice(0, 500)}`);
  process.exitCode = 1;
} finally { s.disconnect(); }
