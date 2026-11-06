/* sc-update.mjs — The Scorecard 2.31.2 App Store update (Willy, 6 Nov 2026,
 * 3:24 pm: "Everything checks out. You can start the update"). In order, each
 * step checked before the next; any problem STOPS before the submission:
 *  1. find build 33 (2.31.2), processed and valid
 *  2. the 2.31.2 version (made if missing), release MANUAL, build 33 attached
 *  3. text: description, keywords, What's New; subtitle on the app info
 *  4. review details carried over from 2.30.0 if missing
 *  5. pictures: the iPhone 6.9" and iPad 13" sets replaced by the 6 new ones each
 *  6. Dark Interface declared, if Apple's API offers it (else reported)
 *  7. submitted for review */
import crypto from "node:crypto"; import fs from "node:fs";
const e = process.env;
const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = () => { const t = Math.floor(Date.now() / 1000); const h = b({ alg: "ES256", kid: e.ASC_KEY_ID.trim(), typ: "JWT" }); const p = b({ iss: e.ASC_ISSUER_ID.trim(), iat: t, exp: t + 900, aud: "appstoreconnect-v1" });
  return `${h}.${p}.` + crypto.sign("sha256", Buffer.from(h + "." + p), { key: crypto.createPrivateKey(e.ASC_KEY_P8.trim()), dsaEncoding: "ieee-p1363" }).toString("base64url"); };
const API = "https://api.appstoreconnect.apple.com/v1/";
async function call(method, path, body) {
  const r = await fetch(path.startsWith("http") ? path : API + path, { method, headers: { Authorization: "Bearer " + jwt(), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch {}
  if (!r.ok) throw new Error(`${method} ${path.split("?")[0]} -> ${r.status} ${JSON.stringify(j.errors || txt).slice(0, 400)}`);
  return j;
}
const get = (p) => call("GET", p);
const say = (s) => console.log(s);
const stop = (s) => { say("\nSTOPPED before the submission: " + s); process.exit(1); };
const T = JSON.parse(fs.readFileSync("build/sc-update-text.json", "utf8"));
try {
  const app = (await get("apps?filter[bundleId]=io.github.willyros01.scorecard&limit=1")).data[0];
  if (!app) stop("app not found");
  /* 1 */
  const builds = (await get(`builds?filter[app]=${app.id}&filter[version]=33&filter[preReleaseVersion.version]=2.31.2&limit=5`)).data || [];
  const build = builds[0];
  if (!build) stop("build 33 (2.31.2) not found");
  say(`1. build 33: ${build.attributes.processingState}, expired=${build.attributes.expired}`);
  if (build.attributes.processingState !== "VALID" || build.attributes.expired) stop("build 33 is not ready");
  /* 2 */
  const vs = (await get(`apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=10`)).data || [];
  for (const v of vs) say(`   version ${v.attributes.versionString}: ${v.attributes.appStoreState}`);
  let ver = vs.find((v) => v.attributes.versionString === "2.31.2");
  const editable = ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED"];
  const other = vs.find((v) => v.attributes.versionString !== "2.31.2" && editable.concat(["WAITING_FOR_REVIEW", "IN_REVIEW"]).includes(v.attributes.appStoreState));
  if (other) stop(`another version is open (${other.attributes.versionString}, ${other.attributes.appStoreState})`);
  if (!ver) {
    ver = (await call("POST", "appStoreVersions", { data: { type: "appStoreVersions", attributes: { platform: "IOS", versionString: "2.31.2", releaseType: "MANUAL" }, relationships: { app: { data: { type: "apps", id: app.id } } } } })).data;
    say("2. version 2.31.2 made (release: manual)");
  } else if (!editable.includes(ver.attributes.appStoreState)) stop(`version 2.31.2 is ${ver.attributes.appStoreState}`);
  else { await call("PATCH", `appStoreVersions/${ver.id}`, { data: { type: "appStoreVersions", id: ver.id, attributes: { releaseType: "MANUAL" } } }); say("2. version 2.31.2 found (release: manual)"); }
  await call("PATCH", `appStoreVersions/${ver.id}/relationships/build`, { data: { type: "builds", id: build.id } });
  say("   build 33 attached");
  /* 3 */
  const locs = (await get(`appStoreVersions/${ver.id}/appStoreVersionLocalizations`)).data || [];
  const loc = locs.find((l) => l.attributes.locale === "en-US") || locs[0];
  if (!loc) stop("no en-US text on the version");
  await call("PATCH", `appStoreVersionLocalizations/${loc.id}`, { data: { type: "appStoreVersionLocalizations", id: loc.id, attributes: { description: T.description, keywords: T.keywords, whatsNew: T.whatsNew } } });
  say(`3. text saved (${loc.attributes.locale}): description ${T.description.length} chars, keywords ${T.keywords.length}/100, What's New`);
  const infos = (await get(`apps/${app.id}/appInfos`)).data || [];
  const info = infos.find((i) => ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED"].includes(i.attributes.appStoreState || i.attributes.state)) || null;
  if (!info) say("   subtitle: no editable app info yet (Apple makes it with the version) — will retry");
  const info2 = info || ((await get(`apps/${app.id}/appInfos`)).data || []).find((i) => (i.attributes.appStoreState || i.attributes.state) !== "READY_FOR_SALE");
  if (!info2) stop("no editable app info for the subtitle");
  const il = ((await get(`appInfos/${info2.id}/appInfoLocalizations`)).data || []).find((l) => l.attributes.locale === "en-US");
  await call("PATCH", `appInfoLocalizations/${il.id}`, { data: { type: "appInfoLocalizations", id: il.id, attributes: { subtitle: T.subtitle } } });
  say(`   subtitle: "${T.subtitle}" (${T.subtitle.length}/30); name unchanged: "${il.attributes.name}"`);
  /* 4 */
  let rd = null; try { rd = (await get(`appStoreVersions/${ver.id}/appStoreReviewDetail`)).data; } catch {}
  if (!rd || !rd.attributes.demoAccountName) {
    const prev = vs.find((v) => v.attributes.versionString === "2.30.0");
    const p = prev && (await get(`appStoreVersions/${prev.id}/appStoreReviewDetail`)).data;
    if (!p) stop("no review details to carry over");
    const a = p.attributes; const attrs = { contactFirstName: a.contactFirstName, contactLastName: a.contactLastName, contactPhone: a.contactPhone, contactEmail: a.contactEmail, demoAccountName: a.demoAccountName, demoAccountPassword: a.demoAccountPassword, demoAccountRequired: a.demoAccountRequired, notes: a.notes };
    if (rd) await call("PATCH", `appStoreReviewDetails/${rd.id}`, { data: { type: "appStoreReviewDetails", id: rd.id, attributes: attrs } });
    else await call("POST", "appStoreReviewDetails", { data: { type: "appStoreReviewDetails", attributes: attrs, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: ver.id } } } } });
    say("4. review details (demo sign-in and notes) carried over from 2.30.0");
  } else say("4. review details already there (demo sign-in present)");
  /* 5 */
  const sets = (await get(`appStoreVersionLocalizations/${loc.id}/appScreenshotSets?limit=50`)).data || [];
  for (const [type, prefix] of [["APP_IPHONE_67", "iphone"], ["APP_IPAD_PRO_3GEN_129", "ipad"]]) {
    const files = fs.readdirSync("shots").filter((f) => f.startsWith(prefix)).sort();
    if (files.length !== 6) stop(`${prefix}: expected 6 pictures, found ${files.length}`);
    let set = sets.find((s) => s.attributes.screenshotDisplayType === type);
    if (!set) set = (await call("POST", "appScreenshotSets", { data: { type: "appScreenshotSets", attributes: { screenshotDisplayType: type }, relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: loc.id } } } } })).data;
    let old = (await get(`appScreenshotSets/${set.id}/appScreenshots?limit=20`)).data || [];
    /* Already uploaded by an earlier run (same 6 names, none refused): keep
       them and only wait for Apple to finish processing. */
    const same = old.length === 6 && files.every((f) => old.some((o) => o.attributes.fileName === f))
      && !old.some((o) => ((o.attributes.assetDeliveryState || {}).state || "") === "FAILED");
    const ids = same ? files.map((f) => old.find((o) => o.attributes.fileName === f).id) : [];
    if (same) { say(`5. ${type}: the 6 new pictures are already uploaded; waiting for Apple`); old = []; }
    else for (const o of old) await call("DELETE", `appScreenshots/${o.id}`);
    for (const f of (same ? [] : files)) {
      const buf = fs.readFileSync("shots/" + f);
      const res = (await call("POST", "appScreenshots", { data: { type: "appScreenshots", attributes: { fileName: f, fileSize: buf.length }, relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: set.id } } } } })).data;
      for (const op of res.attributes.uploadOperations) {
        const r = await fetch(op.url, { method: op.method, headers: Object.fromEntries((op.requestHeaders || []).map((h) => [h.name, h.value])), body: buf.subarray(op.offset, op.offset + op.length) });
        if (!r.ok) stop(`upload of ${f} refused (${r.status})`);
      }
      await call("PATCH", `appScreenshots/${res.id}`, { data: { type: "appScreenshots", id: res.id, attributes: { uploaded: true, sourceFileChecksum: crypto.createHash("md5").update(buf).digest("hex") } } });
      ids.push(res.id);
    }
    for (let i = 0; i < 120; i++) {
      const st = await Promise.all(ids.map(async (id) => (await get(`appScreenshots/${id}`)).data.attributes.assetDeliveryState.state));
      if (st.every((s) => s === "COMPLETE")) break;
      if (st.some((s) => s === "FAILED")) stop(`${prefix}: Apple refused a picture (${st.join(",")})`);
      await new Promise((r) => setTimeout(r, 5000));
      if (i === 119) stop(`${prefix}: pictures still processing after 10 minutes (${st.join(",")})`);
    }
    await call("PATCH", `appScreenshotSets/${set.id}/relationships/appScreenshots`, { data: ids.map((id) => ({ type: "appScreenshots", id })) });
    say(`5. ${type}: ${old.length} old pictures removed, ${ids.length} new uploaded and accepted, in order`);
  }
  /* 6 */
  try {
    const d = await get(`apps/${app.id}/accessibilityDeclarations?limit=10`);
    say(`6. accessibility declarations Apple holds: ${JSON.stringify((d.data || []).map((x) => x.attributes)).slice(0, 300)}`);
    const iphone = (d.data || []).find((x) => x.attributes.deviceFamily === "IPHONE");
    const attrs = { supportsDarkInterface: true };
    if (iphone) await call("PATCH", `accessibilityDeclarations/${iphone.id}`, { data: { type: "accessibilityDeclarations", id: iphone.id, attributes: { ...attrs, publish: true } } });
    else await call("POST", "accessibilityDeclarations", { data: { type: "accessibilityDeclarations", attributes: { deviceFamily: "IPHONE", ...attrs }, relationships: { app: { data: { type: "apps", id: app.id } } } } });
    say("   Dark Interface declared for iPhone");
  } catch (x) { say(`6. Dark Interface: not set through the API (${String(x.message).slice(0, 160)}) — one tap in App Store Connect instead; it does not affect the review`); }
  /* 7 */
  const open = (await get(`reviewSubmissions?filter[app]=${app.id}&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES&limit=5`)).data || [];
  let sub = open.find((s) => s.attributes.state === "READY_FOR_REVIEW");
  if (open.some((s) => s.attributes.state !== "READY_FOR_REVIEW")) stop(`a submission is already ${open.map((s) => s.attributes.state).join(",")}`);
  if (!sub) sub = (await call("POST", "reviewSubmissions", { data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: { data: { type: "apps", id: app.id } } } } })).data;
  await call("POST", "reviewSubmissionItems", { data: { type: "reviewSubmissionItems", relationships: { reviewSubmission: { data: { type: "reviewSubmissions", id: sub.id } }, appStoreVersion: { data: { type: "appStoreVersions", id: ver.id } } } } });
  const done = (await call("PATCH", `reviewSubmissions/${sub.id}`, { data: { type: "reviewSubmissions", id: sub.id, attributes: { submitted: true } } })).data;
  const v2 = (await get(`appStoreVersions/${ver.id}`)).data;
  say(`7. SUBMITTED: submission ${done.attributes.state}; version 2.31.2 is ${v2.attributes.appStoreState}; release: manual (you release it after approval)`);
} catch (x) { stop(x.message); }
