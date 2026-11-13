/* The Scorecard's sign-in emails sent by the worker (sendlink.js, mail.js). */
import test from "node:test";
import assert from "node:assert/strict";
import { fakeFs } from "./fakefs.mjs";
import { sendLink, joinLink, kindOf, LIMITS, JOIN } from "../../worker/src/sendlink.js";
import { send, message } from "../../worker/src/mail.js";

const SENDER = { "secretKeys/mailSender": { user: "thescorecard.marker@gmail.com", appPassword: "abcd efgh ijkl mnop" } };
const APPLY = `${JOIN}?apply=1&approved=1&e=lee%40example.com`;
const RESET = `${JOIN}?apply=1&e=lee%40example.com&reset=1`;

/* A fake Gmail: answers like smtp.gmail.com and keeps what it was told. */
function fakeGmail({ refuseAuth = false } = {}) {
  const seen = { lines: [], data: "", opened: null };
  const enc = new TextEncoder(), dec = new TextDecoder();
  const open = async (addr) => {
    seen.opened = addr;
    let push;
    const readable = new ReadableStream({ start(c) { push = (s) => c.enqueue(enc.encode(s)); push("220 smtp.gmail.com ESMTP ready\r\n"); } });
    let inData = false;
    const writable = new WritableStream({
      write(chunk) {
        const s = dec.decode(chunk);
        if (inData) { seen.data += s; if (s.endsWith("\r\n.\r\n")) { inData = false; push("250 2.0.0 OK queued\r\n"); } return; }
        const line = s.trim(); seen.lines.push(line);
        if (line.startsWith("EHLO")) push("250-smtp.gmail.com at your service\r\n250-AUTH LOGIN PLAIN\r\n250 SMTPUTF8\r\n");
        else if (line.startsWith("AUTH PLAIN")) push(refuseAuth ? "535 5.7.8 Username and Password not accepted\r\n" : "235 2.7.0 Accepted\r\n");
        else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) push("250 2.1.0 OK\r\n");
        else if (line === "DATA") { inData = true; push("354 Go ahead\r\n"); }
        else if (line === "QUIT") push("221 2.0.0 closing\r\n");
      },
    });
    return { readable, writable, close: async () => {} };
  };
  return { open, seen };
}

/* A fake Identity Toolkit: returns Firebase's usual link. */
function fakeGoogle() {
  const calls = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, auth: init.headers.Authorization });
    const q = new URLSearchParams({ apiKey: "AIzaFAKE", mode: "signIn", oobCode: "CODE123", continueUrl: body.continueUrl, lang: "en" });
    return new Response(JSON.stringify({ email: body.email, oobLink: `https://scorecard-f41b8.firebaseapp.com/__/auth/action?${q}` }), { status: 200 });
  };
  return { fetchFn, calls };
}
const opts = (g, gm, now = Date.UTC(2026, 10, 13, 15)) => ({ token: async () => "TOKEN", project: "scorecard-f41b8", fetchFn: g.fetchFn, open: gm.open, now });

test("SL1 the link leads straight to the join page, with Firebase's own values", () => {
  const l = joinLink("https://scorecard-f41b8.firebaseapp.com/__/auth/action?apiKey=K&mode=signIn&oobCode=C&continueUrl=x&lang=en");
  assert.equal(l, `${JOIN}?apiKey=K&mode=signIn&oobCode=C&continueUrl=x&lang=en`);
  assert.throws(() => joinLink("https://evil.example/__/auth/action?mode=resetPassword&oobCode=C"));
});

test("SL2 an approval email: Firebase asked for the link, Gmail sent our wording", async () => {
  const fs = fakeFs(SENDER), g = fakeGoogle(), gm = fakeGmail();
  const r = await sendLink(fs, { email: " Lee@Example.com ", url: APPLY }, opts(g, gm));
  assert.deepEqual(r, { sent: true, kind: "approved" });
  assert.equal(g.calls[0].body.requestType, "EMAIL_SIGNIN");
  assert.equal(g.calls[0].body.returnOobLink, true);
  assert.equal(g.calls[0].body.email, "lee@example.com");
  assert.equal(g.calls[0].body.continueUrl, APPLY);
  assert.deepEqual(gm.seen.opened, { hostname: "smtp.gmail.com", port: 465 });
  assert.ok(gm.seen.lines.includes("AUTH PLAIN " + btoa("\0thescorecard.marker@gmail.com\0abcdefghijklmnop")), "the app password without spaces");
  assert.ok(gm.seen.lines.includes("RCPT TO:<lee@example.com>"));
  assert.match(gm.seen.data, /Subject: Welcome to The Scorecard/);
  const html = Buffer.from(gm.seen.data.split("text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n")[1].split("--b-")[0].replace(/\r\n/g, ""), "base64").toString();
  assert.ok(html.includes(`href="${JOIN}?apiKey=AIzaFAKE&amp;mode=signIn&amp;oobCode=CODE123`), "the button opens the join page directly");
  assert.ok(!html.includes("firebaseapp.com/__/auth"), "no Firebase page");
});

test("SL3 Forgot password is titled as a password change, never Sign in", async () => {
  const fs = fakeFs(SENDER), g = fakeGoogle(), gm = fakeGmail();
  assert.equal(kindOf(RESET), "reset");
  await sendLink(fs, { email: "lee@example.com", url: RESET }, opts(g, gm));
  assert.match(gm.seen.data, /Subject: Choose a new password for The Scorecard/);
});

test("SL4 only links to the Cuberoot join page; only real-looking addresses", async () => {
  const fs = fakeFs(SENDER), g = fakeGoogle(), gm = fakeGmail();
  await assert.rejects(sendLink(fs, { email: "lee@example.com", url: "https://evil.example/scorecard/join/?apply=1" }, opts(g, gm)), /not for The Scorecard/);
  await assert.rejects(sendLink(fs, { email: "lee@example.com", url: "https://www.cuberoot-systems.com.evil.example/scorecard/join/" }, opts(g, gm)), /not for The Scorecard/);
  await assert.rejects(sendLink(fs, { email: "not an email", url: APPLY }, opts(g, gm)), /does not look right/);
  await assert.rejects(sendLink(fs, { email: "a@b.com\r\nBcc: x@y.com", url: APPLY }, opts(g, gm)), /does not look right/);
  assert.equal(g.calls.length, 0, "Firebase was never asked");
});

test("SL5 at most 3 emails an hour to one address; counted before Gmail sends", async () => {
  const fs = fakeFs(SENDER), g = fakeGoogle(), gm = fakeGmail();
  const t = Date.UTC(2026, 10, 13, 15);
  for (let i = 0; i < LIMITS.perHour; i++) await sendLink(fs, { email: "lee@example.com", url: APPLY }, opts(g, gm, t + i));
  await assert.rejects(sendLink(fs, { email: "lee@example.com", url: APPLY }, opts(g, gm, t + 10)), /wait an hour/);
  await sendLink(fs, { email: "pat@example.com", url: APPLY }, opts(g, gm, t + 11));   /* another address is fine */
  await sendLink(fs, { email: "lee@example.com", url: APPLY }, opts(g, gm, t + 3600_001));   /* an hour later */
  assert.equal(g.calls.length, 6, "Firebase made 6 links; the refused one was never emailed");
});

test("SL6 the day's total is capped for everyone together", async () => {
  const day = new Date(Date.UTC(2026, 10, 13, 15)).toISOString().slice(0, 10);
  const fs = fakeFs({ ...SENDER, [`mailLimits/day-${day}`]: { count: LIMITS.allDay } }), g = fakeGoogle(), gm = fakeGmail();
  await assert.rejects(sendLink(fs, { email: "lee@example.com", url: APPLY }, opts(g, gm)), /tomorrow/);
});

test("SL7 no Gmail account set up, or Gmail refuses the password: an error, so the app falls back", async () => {
  const g = fakeGoogle();
  await assert.rejects(sendLink(fakeFs(), { email: "lee@example.com", url: APPLY }, opts(g, fakeGmail())), /not set up/);
  await assert.rejects(sendLink(fakeFs(SENDER), { email: "lee@example.com", url: APPLY }, opts(g, fakeGmail({ refuseAuth: true }))), /Gmail refused \(sign-in\)/);
});

test("SL8 the message: no header can be smuggled in; a line starting with a dot is safe", async () => {
  const m = message({ from: "a@b.com", fromName: "The Scorecard", to: "c@d.com\r\nBcc: e@f.com", subject: "Hi\r\nBcc: x@y.com", text: "x", html: "y" });
  assert.ok(!/\r\nBcc:/.test(m));
  const gm = fakeGmail();
  await send({ user: "a@b.com", pass: "p", to: "c@d.com", subject: "s", text: ".\nend", html: "h" }, { open: gm.open });
  assert.ok(!/\r\n\.\r\n[^]*\r\n\.\r\n/.test(gm.seen.data.slice(0, -5)), "the message ends only once");
});
