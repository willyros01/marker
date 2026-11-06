/* The Scorecard 2.31.1 (Willy, 6 Nov 2026): the cases found testing 2.31.0,
 * on the real iPhone simulator and Android emulator. Shared by both:
 *   ctx.start()   a fresh install, started, Terms accepted
 *   ctx.link(url) hands a link to the running app the way the phone does
 * Each flow checks the screen AND the test database. */
import { put, invitation, getDoc, accountByEmail, W, R1 } from "./seed.mjs";

async function golfer(id, name) {
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  await put(`golfers/${id}`, { name, nameKey: key, linkedUid: null, groups: ["G1"] });
  await put(`golferNames/${key}`, { golferId: id, name });
  await put(`associations/G1/roster/${id}`, { golferId: id });
  await put(`associations/G1/directory/${id}`, { golferId: id, displayName: name, handicapIndex: null });
}
async function signIn(d, who) {
  await d.waitApp(/Sign in/); await d.fill('[name="email"]', who.email); await d.fill('[name="password"]', who.password);
  /* Signed in, in whichever group opens first (the owner lands in PUBLIC). */
  await d.press('[data-act="sign-in"]'); await d.waitApp(/Enter[\s\S]*Summary/, 45000); await d.sleep(2500);
}
async function sheetOpen(d) { return d.js(`(() => { const s = document.getElementById("sheet"); return !!(s && !s.hidden); })()`); }
async function joinAs(d, email, password, golferId, snap) {
  if (await sheetOpen(d)) throw new Error("a box covers the welcome screen: " + (await d.js(`document.getElementById("sheet").innerText`)).replace(/\s+/g, " ").slice(0, 120));
  await d.fill('[name="email"]', email); await d.fill('[name="password"]', password); await d.fill('[name="password-again"]', password);
  await d.press('[data-act="create-account"]');
  for (let i = 0; i < 45; i++) {
    const t = await d.appText();
    if (/Joining as/.test(t) && /accept-named/.test(await d.js(`document.body.innerHTML`))) { await d.press('[data-act="accept-named"]'); }
    const acct = await accountByEmail(email);
    if (acct && (await getDoc(`associations/G1/members/${acct.localId}`))) break;
    await d.sleep(1000);
  }
  await d.sleep(1500); snap("joined");
  const acct = await accountByEmail(email);
  const m = acct && await getDoc(`associations/G1/members/${acct.localId}`);
  if (!m || m.golferId !== golferId) throw new Error(`membership not as expected: ${JSON.stringify(m)}`);
  const g = await getDoc(`golfers/${golferId}`);
  if (!g || g.linkedUid !== acct.localId) throw new Error("the golfer is not linked to the new account");
}

export async function flows231(ctx) {
  const { d, flow, start, link, snap } = ctx;
  const P = ctx.prefix;

  await flow(`${P}4`, "item 1: Rex (plays as his own golfer) is signed in; an invitation for Jay arrives: signed out by itself, no question; Jay joins", async () => {
    await start(); await signIn(d, R1); snap("rex-signed-in");
    await link(await invitation("gJ", "Jay Unjoined"));
    await d.waitApp(/You.re invited/, 40000); snap("signed-out-by-itself");
    if (!/this invitation is for someone else/.test(await d.appText())) throw new Error("no message says why it signed out");
    await joinAs(d, "jay@example.com", "jay-pass-1", "gJ", snap);
  });

  await flow(`${P}5`, "item 8: the group owner (no golfer of his own) is signed in; invitation; 'No, it's for someone else': no box over Join; the new person joins", async () => {
    await golfer("gK", "Kim Newcomer");
    await start(); await signIn(d, W);
    await link(await invitation("gK", "Kim Newcomer"));
    await d.waitApp(/Is this invitation for you\?/, 40000); snap("is-this-for-you");
    await d.press('[data-act="link-not-me"]');
    await d.waitApp(/You.re invited/, 30000); await d.sleep(2500); snap("welcome-no-box");
    await joinAs(d, "kim@example.com", "kim-pass-1", "gK", snap);
  });

  await flow(`${P}6`, "item 7: signed in with a box open; an invitation link arrives: the box closes and the link's screen shows", async () => {
    await golfer("gM", "Mia Later");
    await start(); await signIn(d, W);
    await d.js(`(() => { const s = document.getElementById("sheet"); s.innerHTML = '<div class="sheet-body"><h2>Invitation</h2></div>'; s.hidden = false; return true; })()`);
    snap("box-open");
    await link(await invitation("gM", "Mia Later"));
    await d.waitApp(/Is this invitation for you\?|You.re invited/, 40000); snap("link-screen");
    if (await sheetOpen(d)) throw new Error("the box still covers the link's screen");
  });

  await flow(`${P}7`, "item 11: applying with a wrong email: a pop-up in the middle stays until OK; then the email box is outlined", async () => {
    await start();
    await d.press('[data-act="show-choose"]'); await d.press('[data-act="show-apply"]');
    await d.waitApp(/Full name/i);
    await d.fill('[name="apply-name"]', "Format Tester"); await d.fill('[name="apply-email"]', "format.tester-at-example.com");
    await d.check('[name="ap-agree"]'); await d.press('[data-act="submit-application"]');
    await d.waitApp(/That email does not look right/, 20000); snap("pop-up");
    if (!(await d.js(`!!document.querySelector("#sheet.pop-centre [data-form-ok]")`))) throw new Error("not the centred pop-up with OK");
    await d.press("[data-form-ok]"); await d.sleep(1200); snap("after-ok");
    if (await sheetOpen(d)) throw new Error("the pop-up did not close with OK");
    if (!(await d.js(`document.querySelector('[name="apply-email"]').classList.contains("needs-fix")`))) throw new Error("the email box is not outlined");
  });
}
