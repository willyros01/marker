/* The Marker 1.0.0 to App Review (Willy, 31 Oct 2026, 11:48 am: "Go ahead").
 * Run by .github/workflows/asc-marker-submit.yml with STAGE:
 *   inspect  - read only: what App Store Connect holds now
 *   prepare  - version 1.0.0, latest build, listing, categories, age rating,
 *              review notes + contact, video, screenshots, automatic release
 *   submit   - send version 1.0.0 to App Review
 * Never prints the key or the review sign-in. Assets are read from ASSETS. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const e = process.env;
const STAGE = e.STAGE || "inspect";
const ASSETS = e.ASSETS || "assets";
const say = (s) => console.log(s);
const BUNDLE = "io.github.willyros01.marker";
const VERSION = "1.0.0";

const key = crypto.createPrivateKey((e.ASC_KEY_P8 || "").trim());
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "ES256", kid: e.ASC_KEY_ID.trim(), typ: "JWT" });
  const body = b64({ iss: e.ASC_ISSUER_ID.trim(), iat: now, exp: now + 900, aud: "appstoreconnect-v1" });
  const sig = crypto.sign("sha256", Buffer.from(head + "." + body), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${head}.${body}.${sig}`;
}
async function api(method, p, data) {
  const r = await fetch(p.startsWith("http") ? p : "https://api.appstoreconnect.apple.com/v1/" + p, {
    method, headers: { Authorization: "Bearer " + jwt(), "Content-Type": "application/json" }, body: data ? JSON.stringify(data) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json, ok: r.status >= 200 && r.status < 300 };
}
const errs = (r) => JSON.stringify((r.json.errors || []).map((x) => `${x.code || ""} ${x.detail || x.title}`)).slice(0, 600);
const must = (r, what) => { if (!r.ok) throw new Error(`${what}: ${r.status} ${errs(r)}`); return r.json; };

/* ---------- text ---------- */
const T = JSON.parse(fs.readFileSync(path.join(ASSETS, "listing.json"), "utf8"));

/* ---------- uploads (screenshots, review attachment) ---------- */
async function upload(createType, attrsExtra, rel, file) {
  const buf = fs.readFileSync(file);
  const md5 = crypto.createHash("md5").update(buf).digest("hex");
  const res = must(await api("POST", createType, { data: { type: createType, attributes: { fileName: path.basename(file), fileSize: buf.length, ...attrsExtra }, relationships: rel } }), `reserve ${path.basename(file)}`);
  const d = res.data;
  for (const op of d.attributes.uploadOperations) {
    const headers = Object.fromEntries((op.requestHeaders || []).map((h) => [h.name, h.value]));
    const part = buf.subarray(op.offset, op.offset + op.length);
    const r = await fetch(op.url, { method: op.method, headers, body: part });
    if (!r.ok) throw new Error(`upload part of ${path.basename(file)}: ${r.status}`);
  }
  must(await api("PATCH", `${createType}/${d.id}`, { data: { type: createType, id: d.id, attributes: { uploaded: true, sourceFileChecksum: md5 } } }), `commit ${path.basename(file)}`);
  return d.id;
}

async function main() {
  const app = must(await api("GET", `apps?filter[bundleId]=${BUNDLE}&limit=2`), "app").data[0];
  if (!app) throw new Error("The Marker not found");
  say(`app: ${app.attributes.name}, primary locale ${app.attributes.primaryLocale}, content rights ${app.attributes.contentRightsDeclaration}`);
  const versions = must(await api("GET", `apps/${app.id}/appStoreVersions?limit=10&include=build`), "versions");
  const ver = versions.data.find((v) => v.attributes.platform === "IOS" && ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "WAITING_FOR_REVIEW", "IN_REVIEW", "READY_FOR_REVIEW"].includes(v.attributes.appStoreState));
  for (const v of versions.data) say(`version ${v.attributes.versionString} ${v.attributes.platform}: ${v.attributes.appStoreState}, release ${v.attributes.releaseType}`);
  if (!ver) throw new Error("no version being prepared");
  const builds = must(await api("GET", `builds?filter[app]=${app.id}&sort=-uploadedDate&limit=5&include=preReleaseVersion`), "builds");
  const pre = Object.fromEntries((builds.included || []).filter((x) => x.type === "preReleaseVersions").map((x) => [x.id, x.attributes.version]));
  for (const b of builds.data) say(`build ${b.attributes.version} (${pre[b.relationships.preReleaseVersion.data.id]}) ${b.attributes.processingState}, uploaded ${b.attributes.uploadedDate}`);
  const appInfos = must(await api("GET", `apps/${app.id}/appInfos?include=primaryCategory,secondaryCategory,ageRatingDeclaration`), "appInfos");
  const info = appInfos.data.find((x) => !["READY_FOR_DISTRIBUTION", "REPLACED_WITH_NEW_INFO"].includes(x.attributes.appStoreState || x.attributes.state)) || appInfos.data[0];
  say(`app info ${info.id}: ${info.attributes.appStoreState || info.attributes.state}, categories ${JSON.stringify(info.relationships.primaryCategory.data)} / ${JSON.stringify(info.relationships.secondaryCategory.data)}`);
  const vlocs = must(await api("GET", `appStoreVersions/${ver.id}/appStoreVersionLocalizations`), "version localizations").data;
  const ilocs = must(await api("GET", `appInfos/${info.id}/appInfoLocalizations`), "info localizations").data;
  for (const l of vlocs) say(`version text ${l.attributes.locale}: description ${(l.attributes.description || "").length} chars, keywords ${(l.attributes.keywords || "").length}, support ${l.attributes.supportUrl || "-"}`);
  for (const l of ilocs) say(`app text ${l.attributes.locale}: name ${l.attributes.name}, subtitle ${l.attributes.subtitle || "-"}, privacy ${l.attributes.privacyPolicyUrl || "-"}`);
  const rd = (await api("GET", `appStoreVersions/${ver.id}/appStoreReviewDetail`)).json.data;
  if (rd) { const a = rd.attributes; say(`review: contact ${a.contactFirstName ? "yes" : "no"}, phone ${a.contactPhone ? "yes" : "no"}, email ${a.contactEmail ? "yes" : "no"}, sign-in ${a.demoAccountName ? "yes" : "no"}, notes ${(a.notes || "").length} chars`); }
  const age = (await api("GET", `appInfos/${info.id}/ageRatingDeclaration`)).json.data;
  say(`age rating: ${age ? JSON.stringify(age.attributes) : "none"}`);

  if (STAGE === "inspect") return;

  if (STAGE === "prepare") {
    /* 1. version 1.0.0, automatic release, build */
    const build = builds.data.find((b) => pre[b.relationships.preReleaseVersion.data.id] === VERSION && b.attributes.processingState === "VALID");
    if (!build) throw new Error("no processed 1.0.0 build yet");
    must(await api("PATCH", `appStoreVersions/${ver.id}`, { data: { type: "appStoreVersions", id: ver.id, attributes: { versionString: VERSION, releaseType: "AFTER_APPROVAL", copyright: T.copyright } } }), "version");
    must(await api("PATCH", `appStoreVersions/${ver.id}/relationships/build`, { data: { type: "builds", id: build.id } }), "attach build");
    say(`version ${VERSION}, release after approval, build ${build.attributes.version} attached`);
    if (app.attributes.contentRightsDeclaration !== "DOES_NOT_USE_THIRD_PARTY_CONTENT") {
      must(await api("PATCH", `apps/${app.id}`, { data: { type: "apps", id: app.id, attributes: { contentRightsDeclaration: "DOES_NOT_USE_THIRD_PARTY_CONTENT" } } }), "content rights");
    }
    /* 2. text */
    const loc = app.attributes.primaryLocale;
    const vl = vlocs.find((l) => l.attributes.locale === loc);
    const vattrs = { description: T.description, keywords: T.keywords, promotionalText: T.promotionalText, supportUrl: T.supportUrl };
    if (vl) must(await api("PATCH", `appStoreVersionLocalizations/${vl.id}`, { data: { type: "appStoreVersionLocalizations", id: vl.id, attributes: vattrs } }), "version text");
    else must(await api("POST", "appStoreVersionLocalizations", { data: { type: "appStoreVersionLocalizations", attributes: { locale: loc, ...vattrs }, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: ver.id } } } } }), "version text");
    const il = ilocs.find((l) => l.attributes.locale === loc);
    must(await api("PATCH", `appInfoLocalizations/${il.id}`, { data: { type: "appInfoLocalizations", id: il.id, attributes: { subtitle: T.subtitle, privacyPolicyUrl: T.privacyPolicyUrl } } }), "app text");
    say("listing text, subtitle, links: done");
    /* 3. categories */
    must(await api("PATCH", `appInfos/${info.id}`, { data: { type: "appInfos", id: info.id, relationships: {
      primaryCategory: { data: { type: "appCategories", id: "SPORTS" } }, secondaryCategory: { data: { type: "appCategories", id: "UTILITIES" } } } } }), "categories");
    say("categories: Sports, Utilities");
    /* 4. age rating: nothing objectionable */
    if (age) {
      const BOOL = ["advertising", "ageAssurance", "gambling", "healthOrWellnessTopics", "lootBox", "messagingAndChat", "parentalControls", "unrestrictedWebAccess", "userGeneratedContent"];
      const a = {};
      for (const k of Object.keys(age.attributes)) {
        if (BOOL.includes(k)) a[k] = false;
        else if (/kidsAgeBand|Override|Url|ageRatingOverride/.test(k)) continue;
        else a[k] = "NONE";
      }
      const r = await api("PATCH", `ageRatingDeclarations/${age.id}`, { data: { type: "ageRatingDeclarations", id: age.id, attributes: a } });
      say("age rating: " + (r.ok ? "set, nothing objectionable" : `REFUSED ${r.status} ${errs(r)}`));
    }
    /* 5. review: contact copied from The Scorecard, notes, video */
    const sc = must(await api("GET", "apps?filter[bundleId]=io.github.willyros01.scorecard&limit=2"), "scorecard").data[0];
    let contact = null;
    for (const v of must(await api("GET", `apps/${sc.id}/appStoreVersions?limit=5`), "sc versions").data) {
      const d = (await api("GET", `appStoreVersions/${v.id}/appStoreReviewDetail`)).json.data;
      if (d && d.attributes.contactEmail) { contact = d.attributes; break; }
    }
    if (!contact) throw new Error("no contact details on The Scorecard to copy");
    const rattrs = { contactFirstName: contact.contactFirstName, contactLastName: contact.contactLastName, contactPhone: contact.contactPhone, contactEmail: contact.contactEmail, notes: T.reviewNotes, demoAccountRequired: true };
    let rdId = rd && rd.id;
    if (rdId) must(await api("PATCH", `appStoreReviewDetails/${rdId}`, { data: { type: "appStoreReviewDetails", id: rdId, attributes: rattrs } }), "review details");
    else rdId = must(await api("POST", "appStoreReviewDetails", { data: { type: "appStoreReviewDetails", attributes: rattrs, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: ver.id } } } } }), "review details").data.id;
    say("review contact (copied from The Scorecard) and notes: done");
    const atts = must(await api("GET", `appStoreReviewDetails/${rdId}/appStoreReviewAttachments`), "attachments").data;
    if (!atts.some((a) => a.attributes.fileName === "TheMarker.review.video.v1.0.0.mp4")) {
      await upload("appStoreReviewAttachments", {}, { appStoreReviewDetail: { data: { type: "appStoreReviewDetails", id: rdId } } }, path.join(ASSETS, "TheMarker.review.video.v1.0.0.mp4"));
      say("review video: uploaded");
    } else say("review video: already there");
    /* 6. screenshots */
    const vlNow = must(await api("GET", `appStoreVersions/${ver.id}/appStoreVersionLocalizations`), "loc").data.find((l) => l.attributes.locale === loc);
    const sets = must(await api("GET", `appStoreVersionLocalizations/${vlNow.id}/appScreenshotSets?include=appScreenshots`), "sets");
    for (const [type, prefix] of [["APP_IPHONE_67", "iphone-"], ["APP_IPAD_PRO_3GEN_129", "ipad-"], ["APP_WATCH_ULTRA", "watch-"]]) {
      const files = fs.readdirSync(ASSETS).filter((f) => f.startsWith(prefix) && f.endsWith(".png")).sort();
      let set = sets.data.find((s) => s.attributes.screenshotDisplayType === type);
      if (set) {
        const old = (set.relationships.appScreenshots.data || []);
        for (const s of old) await api("DELETE", `appScreenshots/${s.id}`);
      } else {
        set = must(await api("POST", "appScreenshotSets", { data: { type: "appScreenshotSets", attributes: { screenshotDisplayType: type }, relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: vlNow.id } } } } }), `set ${type}`).data;
      }
      for (const f of files) await upload("appScreenshots", {}, { appScreenshotSet: { data: { type: "appScreenshotSets", id: set.id } } }, path.join(ASSETS, f));
      say(`screenshots ${type}: ${files.length}`);
    }
    say("RESULT: prepared. App Privacy is answered on the App Store Connect website (Apple has no way to set it here).");
    return;
  }

  if (STAGE === "submit") {
    const sub = must(await api("POST", "reviewSubmissions", { data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: { data: { type: "apps", id: app.id } } } } }), "review submission").data;
    must(await api("POST", "reviewSubmissionItems", { data: { type: "reviewSubmissionItems", relationships: { reviewSubmission: { data: { type: "reviewSubmissions", id: sub.id } }, appStoreVersion: { data: { type: "appStoreVersions", id: ver.id } } } } }), "submission item");
    must(await api("PATCH", `reviewSubmissions/${sub.id}`, { data: { type: "reviewSubmissions", id: sub.id, attributes: { submitted: true } } }), "submit");
    const after = must(await api("GET", `appStoreVersions/${ver.id}`), "after").data;
    say(`RESULT: submitted; version ${after.attributes.versionString} is ${after.attributes.appStoreState}`);
  }
}
main().catch((x) => { say("STOPPED: " + x.message); process.exitCode = 1; });
