/* marker-update.mjs — The Marker 1.1.0 App Store update (Willy approved the
 * text and pictures on 6 Nov 2026, 8:22 pm, and said to submit on 7 Nov, 9:48 am).
 * In order, each step checked before the next; any problem STOPS before the submission:
 *  1. find build BUILD (1.1.0), processed and valid
 *  2. the 1.1.0 version (made if missing), release MANUAL, the build attached
 *  3. text: description, keywords, What's New, Promotional Text; name and subtitle on the app info
 *  4. review details: contact and demo sign-in carried over from 1.0.0, new notes, the review video
 *  5. pictures: iPhone 6.9" (9), iPad 13" (9), Apple Watch Ultra (5); other sizes emptied
 *  6. submitted for review (only when SUBMIT=yes)
 * Text and pictures come from ASSETS (the appstore-assets branch, marker-1.1.0). */
import crypto from "node:crypto"; import fs from "node:fs"; import path from "node:path";
const e = process.env;
const VERSION = "1.1.0";
const BUILD = String(e.BUILD || "");
const ASSETS = e.ASSETS || "assets";
const VIDEO = e.VIDEO || "";
const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = () => { const t = Math.floor(Date.now() / 1000); const h = b({ alg: "ES256", kid: e.ASC_KEY_ID.trim(), typ: "JWT" }); const p = b({ iss: e.ASC_ISSUER_ID.trim(), iat: t, exp: t + 900, aud: "appstoreconnect-v1" });
  return `${h}.${p}.` + crypto.sign("sha256", Buffer.from(h + "." + p), { key: crypto.createPrivateKey(e.ASC_KEY_P8.trim()), dsaEncoding: "ieee-p1363" }).toString("base64url"); };
const API = "https://api.appstoreconnect.apple.com/v1/";
async function call(method, p, body) {
  const r = await fetch(p.startsWith("http") ? p : API + p, { method, headers: { Authorization: "Bearer " + jwt(), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch {}
  if (!r.ok) throw new Error(`${method} ${p.split("?")[0]} -> ${r.status} ${JSON.stringify(j.errors || txt).slice(0, 400)}`);
  return j;
}
const get = (p) => call("GET", p);
const say = (s) => console.log(s);
const stop = (s) => { say("\nSTOPPED before the submission: " + s); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = JSON.parse(fs.readFileSync(path.join(ASSETS, "listing.json"), "utf8"));
for (const [k, lim] of [["name", 30], ["subtitle", 30], ["promotionalText", 170], ["keywords", 100], ["description", 4000], ["whatsNew", 4000], ["reviewNotes", 4000]]) {
  if (!T[k] || T[k].length > lim) stop(`text ${k} is missing or over ${lim} characters`);
}
/* Reserve, send the parts, commit: the same for pictures and the review video. */
async function upload(kind, rel, file) {
  const buf = fs.readFileSync(file);
  const res = (await call("POST", kind, { data: { type: kind, attributes: { fileName: path.basename(file), fileSize: buf.length }, relationships: rel } })).data;
  for (const op of res.attributes.uploadOperations) {
    const r = await fetch(op.url, { method: op.method, headers: Object.fromEntries((op.requestHeaders || []).map((h) => [h.name, h.value])), body: buf.subarray(op.offset, op.offset + op.length) });
    if (!r.ok) stop(`upload of ${path.basename(file)} refused (${r.status})`);
  }
  await call("PATCH", `${kind}/${res.id}`, { data: { type: kind, id: res.id, attributes: { uploaded: true, sourceFileChecksum: crypto.createHash("md5").update(buf).digest("hex") } } });
  return res.id;
}
const stateOf = async (kind, id) => (((await get(`${kind}/${id}`)).data.attributes.assetDeliveryState) || {}).state || "";
try {
  const app = (await get("apps?filter[bundleId]=io.github.willyros01.marker&limit=1")).data[0];
  if (!app) stop("The Marker not found");
  /* 1 */
  if (!BUILD) stop("no build number given");
  const build = ((await get(`builds?filter[app]=${app.id}&filter[version]=${BUILD}&filter[preReleaseVersion.version]=${VERSION}&limit=5`)).data || [])[0];
  if (!build) stop(`build ${BUILD} (${VERSION}) not found`);
  say(`1. build ${BUILD} (${VERSION}): ${build.attributes.processingState}, expired=${build.attributes.expired}`);
  if (build.attributes.processingState !== "VALID" || build.attributes.expired) stop(`build ${BUILD} is not ready`);
  /* 2 */
  const vs = (await get(`apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=10`)).data || [];
  for (const v of vs) say(`   version ${v.attributes.versionString}: ${v.attributes.appStoreState}`);
  const editable = ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED"];
  const other = vs.find((v) => v.attributes.versionString !== VERSION && editable.concat(["WAITING_FOR_REVIEW", "IN_REVIEW"]).includes(v.attributes.appStoreState));
  if (other) stop(`another version is open (${other.attributes.versionString}, ${other.attributes.appStoreState})`);
  let ver = vs.find((v) => v.attributes.versionString === VERSION);
  if (!ver) {
    ver = (await call("POST", "appStoreVersions", { data: { type: "appStoreVersions", attributes: { platform: "IOS", versionString: VERSION, releaseType: "MANUAL", copyright: T.copyright }, relationships: { app: { data: { type: "apps", id: app.id } } } } })).data;
    say(`2. version ${VERSION} made (release: manual)`);
  } else if (!editable.includes(ver.attributes.appStoreState)) stop(`version ${VERSION} is ${ver.attributes.appStoreState}`);
  else { await call("PATCH", `appStoreVersions/${ver.id}`, { data: { type: "appStoreVersions", id: ver.id, attributes: { releaseType: "MANUAL", copyright: T.copyright } } }); say(`2. version ${VERSION} found (release: manual)`); }
  await call("PATCH", `appStoreVersions/${ver.id}/relationships/build`, { data: { type: "builds", id: build.id } });
  say(`   build ${BUILD} attached`);
  /* 3 */
  let locs = (await get(`appStoreVersions/${ver.id}/appStoreVersionLocalizations`)).data || [];
  let loc = locs.find((l) => l.attributes.locale === "en-US") || locs[0];
  const vattrs = { description: T.description, keywords: T.keywords, whatsNew: T.whatsNew, promotionalText: T.promotionalText, supportUrl: T.supportUrl };
  if (loc) await call("PATCH", `appStoreVersionLocalizations/${loc.id}`, { data: { type: "appStoreVersionLocalizations", id: loc.id, attributes: vattrs } });
  else loc = (await call("POST", "appStoreVersionLocalizations", { data: { type: "appStoreVersionLocalizations", attributes: { locale: "en-US", ...vattrs }, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: ver.id } } } } })).data;
  say(`3. text saved (${loc.attributes.locale}): description ${T.description.length} chars, keywords ${T.keywords.length}/100, What's New ${T.whatsNew.length}, Promotional Text ${T.promotionalText.length}/170`);
  const live = ["READY_FOR_SALE", "READY_FOR_DISTRIBUTION", "REPLACED_WITH_NEW_INFO"];
  const info = ((await get(`apps/${app.id}/appInfos`)).data || []).find((i) => !live.includes(i.attributes.appStoreState || i.attributes.state));
  if (!info) stop("no editable app info for the name and subtitle");
  const il = ((await get(`appInfos/${info.id}/appInfoLocalizations`)).data || []).find((l) => l.attributes.locale === "en-US");
  if (!il) stop("no en-US app info text");
  const oldName = il.attributes.name;
  await call("PATCH", `appInfoLocalizations/${il.id}`, { data: { type: "appInfoLocalizations", id: il.id, attributes: { name: T.name, subtitle: T.subtitle, privacyPolicyUrl: T.privacyPolicyUrl } } });
  say(`   name: "${T.name}" (was "${oldName}"); subtitle: "${T.subtitle}"`);
  /* 4 */
  let rd = null; try { rd = (await get(`appStoreVersions/${ver.id}/appStoreReviewDetail`)).data; } catch {}
  const prev = vs.find((v) => v.attributes.versionString === "1.0.0");
  const p = prev && (await get(`appStoreVersions/${prev.id}/appStoreReviewDetail`)).data;
  if (!p || !p.attributes.demoAccountName) stop("no review details on 1.0.0 to carry over");
  const a = p.attributes;
  const rattrs = { contactFirstName: a.contactFirstName, contactLastName: a.contactLastName, contactPhone: a.contactPhone, contactEmail: a.contactEmail, demoAccountName: a.demoAccountName, demoAccountPassword: a.demoAccountPassword, demoAccountRequired: true, notes: T.reviewNotes };
  if (rd) await call("PATCH", `appStoreReviewDetails/${rd.id}`, { data: { type: "appStoreReviewDetails", id: rd.id, attributes: rattrs } });
  else rd = (await call("POST", "appStoreReviewDetails", { data: { type: "appStoreReviewDetails", attributes: rattrs, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: ver.id } } } } })).data;
  say(`4. review details: contact and demo sign-in from 1.0.0, notes ${T.reviewNotes.length} chars`);
  if (VIDEO) {
    const name = path.basename(VIDEO);
    const atts = (await get(`appStoreReviewDetails/${rd.id}/appStoreReviewAttachments`)).data || [];
    let att = atts.find((x) => x.attributes.fileName === name && ((x.attributes.assetDeliveryState || {}).state === "COMPLETE"));
    if (att) say("   review video: already there");
    else {
      for (const x of atts.filter((x) => x.attributes.fileName === name)) await call("DELETE", `appStoreReviewAttachments/${x.id}`);
      const id = await upload("appStoreReviewAttachments", { appStoreReviewDetail: { data: { type: "appStoreReviewDetails", id: rd.id } } }, VIDEO);
      let st = "";
      for (let i = 0; i < 60; i++) { st = await stateOf("appStoreReviewAttachments", id); if (st === "COMPLETE" || st === "FAILED") break; await sleep(5000); }
      if (st !== "COMPLETE") stop(`review video not accepted by Apple (${st})`);
      say("   review video: uploaded and accepted");
    }
  }
  /* 5 */
  const WANT = [["APP_IPHONE_67", "iphone-", 9], ["APP_IPAD_PRO_3GEN_129", "ipad-", 9], ["APP_WATCH_ULTRA", "watch-", 5]];
  const sets = (await get(`appStoreVersionLocalizations/${loc.id}/appScreenshotSets?limit=50`)).data || [];
  for (const st of sets.filter((x) => !WANT.some((w) => w[0] === x.attributes.screenshotDisplayType))) {
    const sh = (await get(`appScreenshotSets/${st.id}/appScreenshots?limit=20`)).data || [];
    for (const o of sh) await call("DELETE", `appScreenshots/${o.id}`);
    await call("DELETE", `appScreenshotSets/${st.id}`).catch(() => {});
    say(`5. ${st.attributes.screenshotDisplayType}: ${sh.length} old pictures removed (the new ones scale to it)`);
  }
  for (const [type, prefix, count] of WANT) {
    const files = fs.readdirSync(ASSETS).filter((f) => f.startsWith(prefix) && f.endsWith(".png")).sort();
    if (files.length !== count) stop(`${prefix}: expected ${count} pictures, found ${files.length}`);
    let set = sets.find((s) => s.attributes.screenshotDisplayType === type);
    if (!set) set = (await call("POST", "appScreenshotSets", { data: { type: "appScreenshotSets", attributes: { screenshotDisplayType: type }, relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: loc.id } } } } })).data;
    const rel = { appScreenshotSet: { data: { type: "appScreenshotSets", id: set.id } } };
    const old = (await get(`appScreenshotSets/${set.id}/appScreenshots?limit=20`)).data || [];
    const ids = []; let kept = 0, removed = 0, sent = 0;
    /* Old pictures go first (Apple allows at most 10 per size). */
    for (const o of old.filter((o) => !files.includes(o.attributes.fileName))) { await call("DELETE", `appScreenshots/${o.id}`); removed++; }
    for (const f of files) {
      const have = old.find((o) => o.attributes.fileName === f);
      if (have && (have.attributes.assetDeliveryState || {}).state === "COMPLETE") { ids.push(have.id); kept++; continue; }
      if (have) { await call("DELETE", `appScreenshots/${have.id}`); removed++; }
      ids.push(await upload("appScreenshots", rel, path.join(ASSETS, f))); sent++;
    }
    /* Wait for Apple; a picture still not processed after 4 minutes is sent once more. */
    for (let round = 0; round < 3; round++) {
      let st = [];
      for (let i = 0; i < 48; i++) {
        st = await Promise.all(ids.map((id) => stateOf("appScreenshots", id)));
        if (st.every((x) => x === "COMPLETE")) break;
        await sleep(5000);
      }
      if (st.every((x) => x === "COMPLETE")) break;
      if (round === 2) stop(`${prefix}: Apple did not finish the pictures (${st.join(",")})`);
      for (let k = 0; k < ids.length; k++) if (st[k] !== "COMPLETE") {
        say(`   ${files[k]}: still ${st[k]} — sent once more`);
        await call("DELETE", `appScreenshots/${ids[k]}`); ids[k] = await upload("appScreenshots", rel, path.join(ASSETS, files[k])); sent++;
      }
    }
    await call("PATCH", `appScreenshotSets/${set.id}/relationships/appScreenshots`, { data: ids.map((id) => ({ type: "appScreenshots", id })) });
    say(`5. ${type}: ${kept} already done, ${sent} sent, ${removed} old removed; all ${count} accepted, in order`);
  }
  /* 6 */
  if (e.SUBMIT !== "yes") { const v2 = (await get(`appStoreVersions/${ver.id}`)).data; say(`\nREADY, NOT SUBMITTED: version ${VERSION} is ${v2.attributes.appStoreState}`); process.exit(0); }
  const open = (await get(`reviewSubmissions?filter[app]=${app.id}&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES&limit=5`)).data || [];
  if (open.some((s) => s.attributes.state !== "READY_FOR_REVIEW")) stop(`a submission is already ${open.map((s) => s.attributes.state).join(",")}`);
  let sub = open.find((s) => s.attributes.state === "READY_FOR_REVIEW");
  if (!sub) sub = (await call("POST", "reviewSubmissions", { data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: { data: { type: "apps", id: app.id } } } } })).data;
  await call("POST", "reviewSubmissionItems", { data: { type: "reviewSubmissionItems", relationships: { reviewSubmission: { data: { type: "reviewSubmissions", id: sub.id } }, appStoreVersion: { data: { type: "appStoreVersions", id: ver.id } } } } });
  const done = (await call("PATCH", `reviewSubmissions/${sub.id}`, { data: { type: "reviewSubmissions", id: sub.id, attributes: { submitted: true } } })).data;
  const v2 = (await get(`appStoreVersions/${ver.id}`)).data;
  say(`6. SUBMITTED: submission ${done.attributes.state}; version ${VERSION} is ${v2.attributes.appStoreState}; release: manual (you release it after approval)`);
} catch (x) { stop(x.message); }
