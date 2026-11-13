/* Read-only check (Willy, 13 Nov 2026): can marker-worker make The Scorecard's
 * sign-in links? Uses a short-lived key for marker-worker that is deleted at
 * the end, whatever happens. Sends NO email; changes nothing else. */
import crypto from "node:crypto";
const P = "scorecard-f41b8", SA = `marker-worker@${P}.iam.gserviceaccount.com`, T = process.env.TOKEN;
const j = async (url, init = {}) => { const r = await fetch(url, init); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; } return { ok: r.ok, status: r.status, b }; };
const auth = (t) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
const made = await j(`https://iam.googleapis.com/v1/projects/-/serviceAccounts/${SA}/keys`, { method: "POST", headers: auth(T), body: "{}" });
if (!made.ok) { console.log("Could not make a short-lived key:", made.status, JSON.stringify(made.b)); process.exit(1); }
try {
  const sa = JSON.parse(Buffer.from(made.b.privateKeyData, "base64").toString());
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT", kid: sa.private_key_id })}.${b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 600 })}`;
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
  let tok;
  for (let i = 0; i < 6 && !tok; i++) {   /* a new key can take a few seconds to work */
    const r = await j("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${unsigned}.${sig}` });
    if (r.ok) tok = r.b.access_token; else await new Promise((s) => setTimeout(s, 5000));
  }
  if (!tok) throw new Error("marker-worker could not sign in");
  const perms = ["firebaseauth.users.get", "firebaseauth.users.create", "firebaseauth.users.update", "firebaseauth.users.sendEmail", "firebaseauth.configs.get", "datastore.entities.get", "serviceusage.services.use"];
  const has = await j(`https://cloudresourcemanager.googleapis.com/v1/projects/${P}:testIamPermissions`, { method: "POST", headers: auth(tok), body: JSON.stringify({ permissions: perms }) });
  console.log("marker-worker holds:", JSON.stringify(has.b.permissions || has.b));
  for (const [name, url] of [["projects path", `https://identitytoolkit.googleapis.com/v1/projects/${P}/accounts:sendOobCode`], ["plain path", "https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode"]]) {
    const r = await j(url, { method: "POST", headers: { ...auth(tok), "x-goog-user-project": P }, body: JSON.stringify({ requestType: "EMAIL_SIGNIN", email: "thescorecard.marker@gmail.com", continueUrl: "https://www.cuberoot-systems.com/scorecard/join/?apply=1&e=thescorecard.marker%40gmail.com", canHandleCodeInApp: true, returnOobLink: true, targetProjectId: P }) });
    console.log(`Link (${name}):`, r.status, r.ok ? "MADE, starts " + String(r.b.oobLink).slice(0, 60) : JSON.stringify(r.b).slice(0, 300));
  }
} finally {
  const del = await j(`https://iam.googleapis.com/v1/${made.b.name}`, { method: "DELETE", headers: auth(T) });
  console.log("Short-lived key deleted:", del.ok);
}
