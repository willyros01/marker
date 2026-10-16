/* verify.js — who is calling. Checks a Firebase ID token the way Firebase's
 * own Admin SDK does: Google's signature, this project, not expired.
 * Returns { uid, email, anonymous } or throws.
 */
const JWKS = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let keys = null;   /* { at, byKid } */

const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const json = (s) => JSON.parse(new TextDecoder().decode(unb64(s)));

async function googleKeys(fetchFn) {
  if (keys && Date.now() - keys.at < 3600_000) return keys.byKid;
  const res = await fetchFn(JWKS);
  if (!res.ok) throw new Error("KEYS_UNAVAILABLE");
  const { keys: list } = await res.json();
  keys = { at: Date.now(), byKid: Object.fromEntries(list.map((k) => [k.kid, k])) };
  return keys.byKid;
}

export async function verifyIdToken(token, project, { fetchFn = (...a) => fetch(...a), jwks = null, now = Date.now() } = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("NO_TOKEN");
  let head, claims;
  try { head = json(parts[0]); claims = json(parts[1]); } catch { throw new Error("BAD_TOKEN"); }
  if (head.alg !== "RS256" || !head.kid) throw new Error("BAD_TOKEN");
  const byKid = jwks || await googleKeys(fetchFn);
  const jwk = byKid[head.kid];
  if (!jwk) { keys = null; throw new Error("BAD_TOKEN"); }
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error("BAD_TOKEN");
  const t = Math.floor(now / 1000);
  if (claims.aud !== project || claims.iss !== `https://securetoken.google.com/${project}`) throw new Error("BAD_TOKEN");
  if (!(claims.exp > t) || !(claims.iat <= t + 300) || !(claims.auth_time <= t + 300)) throw new Error("EXPIRED");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 128) throw new Error("BAD_TOKEN");
  const provider = (claims.firebase && claims.firebase.sign_in_provider) || "";
  const email = typeof claims.email === "string" ? claims.email : "";
  return { uid: claims.sub, email, anonymous: provider === "anonymous" || !email };
}
