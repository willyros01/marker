/* mail.js — sends one email through Gmail (Willy, 13 Nov 2026).
 *
 * Google locked the setting that points Firebase's email links at the Cuberoot
 * join page (EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED), so The Scorecard's sign-in
 * emails are sent here instead, from the apps' own Gmail account
 * (thescorecard.marker@gmail.com) with a Gmail app password. The account and
 * its app password are kept in secretKeys/mailSender (no app can read it).
 *
 * Plain SMTP over TLS (smtp.gmail.com:465), one connection per email.
 * `open` is injected so the tests can talk to a fake server.
 */
export class MailError extends Error {}

const CRLF = "\r\n";
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (s) => btoa(String.fromCharCode(...enc.encode(s)));

/* A header value with anything outside plain ASCII written as UTF-8 base64. */
const header = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
/* No line breaks can be smuggled into a header. */
const clean = (s) => String(s || "").replace(/[\r\n]+/g, " ").trim();

/* The message itself: plain text and HTML, both base64 (safe line lengths). */
export function message({ from, fromName, to, subject, text, html, now = Date.now(), id = crypto.randomUUID() }) {
  const wrap = (s) => b64(s).replace(/.{1,76}/g, "$&" + CRLF);
  const b = `b-${id}`;
  return [
    `From: ${header(clean(fromName))} <${clean(from)}>`,
    `To: <${clean(to)}>`,
    `Subject: ${header(clean(subject))}`,
    `Date: ${new Date(now).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${id}@thescorecard>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${b}"`,
    "",
    `--${b}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(text),
    `--${b}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(html),
    `--${b}--`,
    "",
  ].join(CRLF);
}

/* Reads one SMTP reply (all its lines); returns { code, text }. */
function replies(reader) {
  let buf = "";
  return async function next() {
    for (;;) {
      const lines = buf.split(CRLF);
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const all = lines.slice(0, i + 1);
          buf = lines.slice(i + 1).join(CRLF);
          return { code: Number(lines[i].slice(0, 3)), text: all.join(" | ") };
        }
      }
      const { value, done } = await reader.read();
      if (done) throw new MailError("Gmail closed the connection.");
      buf += dec.decode(value, { stream: true });
    }
  };
}

export async function send({ user, pass, to, subject, text, html, fromName = "The Scorecard" }, { open, timeoutMs = 20000 } = {}) {
  if (!user || !pass) throw new MailError("The apps' Gmail account is not set up yet.");
  const socket = await open({ hostname: "smtp.gmail.com", port: 465 });
  const writer = socket.writable.getWriter();
  const next = replies(socket.readable.getReader());
  const say = (line) => writer.write(enc.encode(line + CRLF));
  const expect = async (want, what) => {
    const r = await next();
    if (r.code !== want) throw new MailError(`Gmail refused (${what}): ${r.text}`);
    return r;
  };
  let timer;
  const timeout = new Promise((_, no) => { timer = setTimeout(() => no(new MailError("Gmail did not answer in time.")), timeoutMs); });
  const talk = (async () => {
    await expect(220, "greeting");
    await say("EHLO thescorecard"); await expect(250, "hello");
    await say(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`); await expect(235, "sign-in");
    await say(`MAIL FROM:<${clean(user)}>`); await expect(250, "sender");
    await say(`RCPT TO:<${clean(to)}>`); await expect(250, "recipient");
    await say("DATA"); await expect(354, "message");
    /* A line starting with a dot gets a second dot (SMTP rule). */
    const body = message({ from: user, fromName, to, subject, text, html }).replace(/^\./gm, "..");
    await writer.write(enc.encode(body + "." + CRLF)); await expect(250, "message");
    await say("QUIT");
  })();
  try { await Promise.race([talk, timeout]); }
  finally { clearTimeout(timer); try { await socket.close(); } catch { /* already closed */ } }
}
