/* The Scorecard's Forgot password on an Android phone (emulator), against the
 * LIVE Firebase and the live Cloudflare helper, the way a golfer does it:
 * fresh install, Terms, Sign in screen, type the email, tap Forgot the password.
 * The email itself is then checked in the apps' Gmail inbox (inbox.py).
 * usage: node live-email-android.mjs OUT APK ADDRESS */
import fs from "node:fs";
import * as d from "./adb.mjs";
const [OUT = "out", APK, ADDRESS] = process.argv.slice(2);
const PKG = "io.github.willyros01.scorecard";
fs.mkdirSync(OUT, { recursive: true });
let step = 0;
const snap = (name) => d.shot(`${OUT}/${String(++step).padStart(2, "0")}-${name}.png`);
try {
  d.reinstall(PKG, APK); await d.sleep(2000);
  d.launch(PKG); await d.sleep(6000);
  await d.waitApp(/Terms of Use/, 60000); snap("terms");
  await d.check("[data-terms-tick]"); await d.press("#termsAccept"); await d.sleep(1500);
  await d.waitApp(/Forgot the password/, 30000);
  const version = await d.js("self.APP_VERSION");
  console.log(`PASS the app opened at the Sign in screen (version ${version})`);
  await d.fill('[name="email"]', ADDRESS); snap("sign-in-email-typed");
  await d.press('[data-act="reset-password"]');
  const t = await d.waitApp(/Link sent to[\s\S]*Choose a new password for The Scorecard|Couldn.t send|Sign in to The Scorecard"/, 60000);
  snap("after-forgot-password");
  if (!/Choose a new password for The Scorecard/.test(t)) throw new Error(`the helper did not send it: ${t.replace(/\s+/g, " ").slice(0, 300)}`);
  console.log('PASS the app says the email "Choose a new password for The Scorecard" was sent (sent by the helper)');
} catch (e) {
  try { snap("failed"); } catch {}
  console.log(`FAIL ${String(e.message || e).slice(0, 500)}`);
  try { console.log(d.logcat().split("\n").slice(-25).join("\n")); } catch {}
  process.exitCode = 1;
}
