/* google.js — sign in to Google as the marker-worker service account.
 *
 * The key (a JSON service-account key) is a Cloudflare secret, replaced at
 * every deploy. An access token lasts an hour; it is kept until five minutes
 * before it runs out.
 */
const SCOPE = "https://www.googleapis.com/auth/datastore";
let cached = null;

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (s) => b64url(new TextEncoder().encode(s));

function pemBytes(pem) {
  const body = String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

export async function signJwt(claims, privateKeyPem, kid) {
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const head = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT", ...(kid ? { kid } : {}) }));
  const body = b64urlText(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

export async function accessToken(saJson, fetchFn = (...a) => fetch(...a)) {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.until > now + 300) return cached.token;
  const sa = typeof saJson === "string" ? JSON.parse(saJson) : saJson;
  const assertion = await signJwt({
    iss: sa.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }, sa.private_key, sa.private_key_id);
  const res = await fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${assertion}`,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Google sign-in failed (${res.status} ${data.error || ""})`);
  cached = { token: data.access_token, until: now + Number(data.expires_in || 3600) };
  return cached.token;
}
