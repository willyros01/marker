/* sc-look.mjs — READ-ONLY: The Scorecard 2.31.2 in App Store Connect — every
 * picture set and the App Review notes. Changes nothing. */
import crypto from "node:crypto";
const e = process.env;
const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const t = Math.floor(Date.now() / 1000); const h = b({ alg: "ES256", kid: e.ASC_KEY_ID.trim(), typ: "JWT" }); const p = b({ iss: e.ASC_ISSUER_ID.trim(), iat: t, exp: t + 900, aud: "appstoreconnect-v1" });
const jwt = `${h}.${p}.` + crypto.sign("sha256", Buffer.from(h + "." + p), { key: crypto.createPrivateKey(e.ASC_KEY_P8.trim()), dsaEncoding: "ieee-p1363" }).toString("base64url");
const get = async (q) => (await fetch("https://api.appstoreconnect.apple.com/v1/" + q, { headers: { Authorization: "Bearer " + jwt } })).json();
const app = (await get("apps?filter[bundleId]=io.github.willyros01.scorecard&limit=1")).data[0];
for (const v of (await get(`apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=3`)).data) {
  console.log(`\n===== ${v.attributes.versionString} (${v.attributes.appStoreState})`);
  const loc = (await get(`appStoreVersions/${v.id}/appStoreVersionLocalizations`)).data[0];
  for (const st of (await get(`appStoreVersionLocalizations/${loc.id}/appScreenshotSets?limit=50`)).data) {
    const sh = (await get(`appScreenshotSets/${st.id}/appScreenshots?limit=20`)).data || [];
    console.log(`  ${st.attributes.screenshotDisplayType}: ${sh.map((x) => `${x.attributes.fileName}[${(x.attributes.assetDeliveryState || {}).state}]`).join(", ")}`);
  }
  try { const rd = (await get(`appStoreVersions/${v.id}/appStoreReviewDetail`)).data; console.log(`  REVIEW: demo=${rd.attributes.demoAccountName} required=${rd.attributes.demoAccountRequired}\n  NOTES:\n${rd.attributes.notes}`); } catch { console.log("  REVIEW: none"); }
}
