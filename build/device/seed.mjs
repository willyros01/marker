/* Seeds the Firebase EMULATORS (demo-scorecard: a throw-away project that cannot
 * reach live data) for the device tests. Prints the links the tests open. */
const P = "demo-scorecard";
const FS = `http://127.0.0.1:8080/v1/projects/${P}/databases/(default)/documents`;
const FS_ADMIN = `http://127.0.0.1:8080/emulator/v1/projects/${P}/databases/(default)/documents`;
const AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const AUTH_ADMIN = `http://127.0.0.1:9099/emulator/v1/projects/${P}`;
const OWNER = { Authorization: "Bearer owner" };
const value = (v) => v === null ? { nullValue: null } : v instanceof Date ? { timestampValue: v.toISOString() } : Array.isArray(v) ? { arrayValue: { values: v.map(value) } }
  : typeof v === "number" ? { doubleValue: v } : typeof v === "boolean" ? { booleanValue: v }
  : typeof v === "object" ? { mapValue: { fields: fields(v) } } : { stringValue: String(v) };
const fields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, value(v)]));
export async function put(docPath, data) {
  const r = await fetch(`${FS}:commit`, { method: "POST", headers: { ...OWNER, "Content-Type": "application/json" },
    body: JSON.stringify({ writes: [{ update: { name: `projects/${P}/databases/(default)/documents/${docPath}`, fields: fields(data) } }] }) });
  if (!r.ok) throw new Error(`seed ${docPath}: ${r.status} ${await r.text()}`);
}
export async function getDoc(docPath) {
  const r = await fetch(`${FS}/${docPath}`, { headers: OWNER });
  if (r.status === 404) return null;
  const j = await r.json();
  return Object.fromEntries(Object.entries(j.fields || {}).map(([k, v]) => [k, Object.values(v)[0]]));
}
export async function signUp(email, password) {
  const r = await fetch(`${AUTH}/accounts:signUp?key=fake-api-key`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }) });
  const j = await r.json(); if (!j.localId) throw new Error(`sign-up ${email}: ${JSON.stringify(j)}`); return j.localId;
}
export async function accountByEmail(email) {
  const r = await fetch(`${AUTH}/projects/${P}/accounts:lookup`, { method: "POST", headers: { ...OWNER, "Content-Type": "application/json" }, body: JSON.stringify({ email: [email] }) });
  return ((await r.json()).users || [])[0] || null;
}
export async function oobCodes(email) {
  const r = await fetch(`${AUTH_ADMIN}/oobCodes`); return ((await r.json()).oobCodes || []).filter((c) => !email || c.email === email);
}
const JOIN = "https://www.cuberoot-systems.com/scorecard/join/";
export const W = { email: "owner@example.com", password: "owner-pass-1" };
export const R1 = { email: "rex@example.com", password: "rex-pass-1" };

export async function seed() {
  await fetch(FS_ADMIN, { method: "DELETE", headers: OWNER });
  await fetch(`${AUTH_ADMIN}/accounts`, { method: "DELETE", headers: OWNER });
  W.uid = await signUp(W.email, W.password); R1.uid = await signUp(R1.email, R1.password);
  await put("associations/PUBLIC", { name: "PUBLIC", ownerUid: W.uid });
  await put(`associations/PUBLIC/members/${W.uid}`, { uid: W.uid, role: "owner", displayName: "Owner" });
  await put(`userGroups/${W.uid}/groups/PUBLIC`, { assocId: "PUBLIC", name: "PUBLIC" });
  await put(`groupCreators/${W.uid}`, { note: "device tests" });
  await put("settings/publicApplications", { mode: "auto" });
  await put("settings/invitationLinks", { version: 2 });
  await put("associations/G1", { name: "Saturday Group", ownerUid: W.uid, joinCode: "PRIV01" });
  await put(`associations/G1/members/${W.uid}`, { uid: W.uid, role: "owner", displayName: "Owner" });
  await put(`associations/G1/members/${R1.uid}`, { uid: R1.uid, role: "member", displayName: "Rex Regular", golferId: "gR" });
  await put(`userGroups/${R1.uid}/groups/G1`, { assocId: "G1", name: "Saturday Group" });
  for (const [id, name, linked] of [["gR", "Rex Regular", R1.uid], ["gI", "Ivy Invitee", null], ["gJ", "Jay Unjoined", null]]) {
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await put(`golfers/${id}`, { name, nameKey: key, linkedUid: linked, groups: ["G1"] });
    await put(`golferNames/${key}`, { golferId: id, name });
    await put(`associations/G1/roster/${id}`, { golferId: id });
    await put(`associations/G1/directory/${id}`, { golferId: id, displayName: name, handicapIndex: null });
  }
  const pars = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 5, 4, 4, 4, 3, 4, 5];
  await put("markerCourses/77", { providerId: "77", name: "Wack Wack — East", where: "Manila",
    tees: [{ name: "White (M)", rating: 68.8, slope: 133, par: 72, holes: pars.map((p, i) => ({ par: p, yards: 350, si: i + 1 })) }] });
  return { W, R1 };
}
/* A one-time named invitation, written exactly as the owner's app writes it. */
export async function invitation(golferId, name) {
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await put(`associations/G1/invitationTokens/${token}`, { slot: golferId, golferId, role: "member", name, handicapIndex: null, groupName: "Saturday Group", state: "pending", sentAt: new Date() });
  await put(`associations/G1/invitationSlots/${golferId}`, { token });
  return `${JOIN}?join=G1.${token}.${golferId}&v=2`;
}
/* The approval email's link, in the shape of the planned fix (straight to the join page). */
export async function approvalLink(email) {
  const codes = (await oobCodes(email)).filter((c) => c.requestType === "EMAIL_SIGNIN");
  if (!codes.length) return null;
  const code = codes[codes.length - 1].oobCode;
  return `${JOIN}?apply=1&e=${encodeURIComponent(email)}&apiKey=fake-api-key&mode=signIn&oobCode=${encodeURIComponent(code)}&lang=en`;
}
