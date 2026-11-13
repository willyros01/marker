/* sendlink.js — The Scorecard's sign-in emails, sent by this worker
 * (Willy, 13 Nov 2026).
 *
 * Firebase makes the same sign-in link it always made (Identity Toolkit,
 * returnOobLink), but its address is swapped from Firebase's own page
 * (…firebaseapp.com/__/auth/action) to the Cuberoot join page, with the very
 * same values after it. That is exactly what the locked "action URL" setting
 * would have done; the apps (2.31.4) already read it. The email is then sent
 * from the apps' Gmail account, with our own wording.
 *
 * Nobody is signed in when an applicant asks for a link, so this route needs no
 * sign-in. To keep it from being misused:
 *   - the link can only lead to the Cuberoot join page;
 *   - one address gets at most 3 emails an hour (6 a day);
 *   - all addresses together at most 300 a day (Gmail allows about 500).
 * Each email is counted before Gmail sends it, in one commit, so two requests at
 * once cannot both slip under the limit.
 */
import { setWrite } from "./firestore.js";
import { send, MailError } from "./mail.js";

export const JOIN = "https://www.cuberoot-systems.com/scorecard/join/";
const HOUR = 3600_000, DAY = 24 * HOUR;
export const LIMITS = { perHour: 3, perDay: 6, allDay: 300 };
export class LinkRefused extends Error {}

const EMAIL = /^[^\s@<>"',;:()\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

async function sha(s) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* What kind of email this is, from the link the app built (store.js
   signInLinkSettings): apply=1, approved=1, reset=1. */
export function kindOf(url) {
  const q = new URL(url).searchParams;
  if (q.get("reset") === "1") return "reset";
  if (q.get("approved") === "1") return "approved";
  return "apply";
}

const WORDS = {
  reset: {
    subject: "Choose a new password for The Scorecard",
    lead: "You asked to change your password for The Scorecard.",
    button: "Choose a new password",
  },
  approved: {
    subject: "Welcome to The Scorecard",
    lead: "Your request to join The Scorecard was approved.",
    button: "Open The Scorecard",
  },
  apply: {
    subject: "Confirm your email for The Scorecard",
    lead: "Please confirm this is your email address, to continue joining The Scorecard.",
    button: "Confirm my email",
  },
};

export function compose(kind, link) {
  const w = WORDS[kind] || WORDS.apply;
  const text = [
    "Hello,", "", w.lead, "", `${w.button}:`, link, "",
    "The link works once, on the phone or computer where you open it, and for a limited time.",
    "If you did not ask for this, you can ignore this email.", "", "The Scorecard",
  ].join("\n");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:17px;color:#1d2a36;line-height:1.5;max-width:520px;margin:0 auto;padding:16px">
<p>Hello,</p><p>${esc(w.lead)}</p>
<p style="margin:28px 0"><a href="${esc(link)}" style="background:#1f6fb2;color:#fff;text-decoration:none;padding:14px 22px;border-radius:10px;font-weight:600;display:inline-block">${esc(w.button)}</a></p>
<p style="font-size:15px;color:#4a5866">The link works once, on the phone or computer where you open it, and for a limited time. If you did not ask for this, you can ignore this email.</p>
<p>The Scorecard</p></body></html>`;
  return { subject: w.subject, text, html };
}

/* Firebase's link, with its own page swapped for the join page. */
export function joinLink(oobLink) {
  const u = new URL(oobLink);
  if (!/\/__\/auth\/action$/.test(u.pathname)) throw new Error("Unexpected link from Firebase.");
  if (u.searchParams.get("mode") !== "signIn" || !u.searchParams.get("oobCode")) throw new Error("Unexpected link from Firebase.");
  return JOIN + u.search;
}

/* Counts this email (one commit) or refuses when a limit is reached. */
async function count(fs, email, now) {
  const id = await sha(email);
  const day = new Date(now).toISOString().slice(0, 10);
  const one = await fs.get(`mailLimits/${id}`);
  const all = await fs.get(`mailLimits/day-${day}`);
  const times = ((one && one.data.times) || []).map(Number).filter((t) => now - t < DAY);
  if (times.filter((t) => now - t < HOUR).length >= LIMITS.perHour || times.length >= LIMITS.perDay) {
    throw new LinkRefused("Too many emails were sent to this address just now. Please wait an hour and try again.");
  }
  const n = Number((all && all.data.count) || 0);
  if (n >= LIMITS.allDay) throw new LinkRefused("The Scorecard has sent its emails for today. Please try again tomorrow.");
  await fs.commit([
    setWrite(fs, `mailLimits/${id}`, { times: [...times, now] }, one ? { updateTime: one.updateTime } : { exists: false }),
    setWrite(fs, `mailLimits/day-${day}`, { count: n + 1 }, all ? { updateTime: all.updateTime } : { exists: false }),
  ]);
}

export async function sendLink(fs, { email, url } = {}, { token, open, fetchFn = (...a) => fetch(...a), now = Date.now(), project } = {}) {
  const address = String(email || "").trim().toLowerCase();
  if (!EMAIL.test(address)) throw new LinkRefused("That email address does not look right.");
  let continueUrl;
  try { continueUrl = new URL(String(url || "")); } catch { throw new LinkRefused("The link is not for The Scorecard."); }
  if (continueUrl.href.slice(0, JOIN.length) !== JOIN || continueUrl.hash) throw new LinkRefused("The link is not for The Scorecard.");

  const sender = await fs.get("secretKeys/mailSender");
  const user = sender && String(sender.data.user || "").trim();
  const pass = sender && String(sender.data.appPassword || "").replace(/\s+/g, "");
  if (!user || !pass) throw new MailError("The apps' Gmail account is not set up yet.");


  const res = await fetchFn(`https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:sendOobCode`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requestType: "EMAIL_SIGNIN", email: address, continueUrl: continueUrl.href, canHandleCodeInApp: true, returnOobLink: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.oobLink) throw new Error(`Firebase did not make the link (${res.status} ${(data.error && data.error.message) || ""})`);

  /* Counted only once Firebase has made the link, just before Gmail sends it. */
  await count(fs, address, now);
  const kind = kindOf(continueUrl.href);
  const m = compose(kind, joinLink(data.oobLink));
  await send({ user, pass, to: address, ...m }, { open });
  return { sent: true, kind };
}
