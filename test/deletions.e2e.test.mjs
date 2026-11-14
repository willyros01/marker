/* The helper's deletion job (worker/src/deletions.js) against the Firebase
 * EMULATORS (Firestore and Authentication; nothing live). The same cases as The
 * Scorecard's GitHub job tests (SEC1-SEC5, PUB-DEL1-4), plus the 50-call limit.
 * Run: firebase emulators:exec --only firestore,auth --project demo-marker 'node --test test/deletions.e2e.test.mjs' */
import test from "node:test";
import assert from "node:assert/strict";
import { client } from "../worker/src/firestore.js";
import { finishDeletions, purgeBackups, authAdmin } from "../worker/src/deletions.js";

const P = "demo-marker";
const FSB = "http://127.0.0.1:8080/v1";
const AUTHB = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const ROOT = `projects/${P}/databases/(default)/documents`;
const OWNER = { Authorization: "Bearer owner", "Content-Type": "application/json" };
let calls = 0;
const counted = (...a) => { calls++; return fetch(...a); };
const fs = client({ project: P, token: async () => "owner", base: FSB, fetchFn: counted });
const auth = authAdmin({ project: P, token: async () => "owner", base: AUTHB, fetchFn: counted });
const NOW = () => Date.now() + 10 * 60 * 1000;   /* every request is older than 5 minutes */

async function reset() {
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${P}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${P}/accounts`, { method: "DELETE" });
}
const val = (v) => v === null ? { nullValue: null } : Array.isArray(v) ? { arrayValue: { values: v.map(val) } } : { stringValue: String(v) };
async function raw(writes) {
  const r = await fetch(`${FSB}/${ROOT}:commit`, { method: "POST", headers: OWNER, body: JSON.stringify({ writes }) });
  if (!r.ok) throw new Error(await r.text());
}
const put = (path, o) => raw([{ update: { name: `${ROOT}/${path}`, fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, val(v)])) } }]);
const exists = async (path) => (await fetch(`${FSB}/${ROOT}/${path}`, { headers: OWNER })).status === 200;
const field = async (path, f) => { const j = await (await fetch(`${FSB}/${ROOT}/${path}`, { headers: OWNER })).json(); const v = (j.fields || {})[f]; return v ? ("nullValue" in v ? null : Object.values(v)[0]) : undefined; };
async function user() {
  const r = await fetch(`${AUTHB}/accounts:signUp?key=fake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }) });
  return (await r.json()).localId;
}
const userExists = async (u) => (await auth.lookup(u)).exists;
const backups = async (g) => (await fs.query("", "deletionBackups", [], 100)).filter((d) => d.data.golferId === g);
const run = (opts = {}) => finishDeletions(fs, opts.auth || auth, { now: NOW(), log: (l) => lines.push(l), ...opts });
let lines = [];

let A, B, O, Pp, Q;
async function seed() {
  A = await user(); B = await user(); O = await user();
  await put("associations/G1", { name: "Group one", ownerUid: O });
  await put("associations/G2", { name: "Group two", ownerUid: O });
  await put(`associations/G1/members/${O}`, { uid: O, role: "owner" });
  await put(`associations/G1/members/${A}`, { uid: A, role: "member", golferId: "gA" });
  await put(`associations/G1/members/${B}`, { uid: B, role: "member", golferId: "gB" });
  await put(`associations/G2/members/${O}`, { uid: O, role: "owner" });
  await put(`associations/G2/members/${B}`, { uid: B, role: "member", golferId: "gB" });
  await put("associations/G1/invites/gA", { acceptedBy: A, role: "member" });
  await put("associations/G1/invites/gB", { acceptedBy: B, role: "member" });
  await put("associations/G2/invites/gB", { acceptedBy: B, role: "member" });
  await put("associations/G1/roster/gA", { golferId: "gA" });
  await put("associations/G1/roster/gB", { golferId: "gB" });
  await put("associations/G2/roster/gB", { golferId: "gB" });
  await put("associations/G1/rounds/r1", { golferId: "gA", enteredBy: A });
  await put("golfers/gA", { name: "Alice Golfer", linkedUid: A });
  await put("golfers/gB", { name: "Bob Golfer", linkedUid: B });
  await put(`userGroups/${A}/groups/G1`, { assocId: "G1" });
  await put(`userGroups/${B}/groups/G1`, { assocId: "G1" });
  await put(`userGroups/${B}/groups/G2`, { assocId: "G2" });
}
async function seedPublic() {
  Pp = await user(); Q = await user();
  await put("associations/PUBLIC", { name: "Public", ownerUid: O });
  await put(`associations/PUBLIC/members/${O}`, { uid: O, role: "owner" });
  await put(`associations/PUBLIC/members/${Pp}`, { uid: Pp, role: "member", golferId: "gP" });
  await put(`associations/PUBLIC/members/${Q}`, { uid: Q, role: "member", golferId: "gQ" });
  await put("associations/PUBLIC/roster/gP", { golferId: "gP" });
  await put("associations/PUBLIC/directory/gP", { golferId: "gP", displayName: "Pat Public" });
  await put("associations/PUBLIC/rounds/pr1", { golferId: "gP", enteredBy: Pp });
  await put("associations/PUBLIC/rounds/pr2", { golferId: "gP", enteredBy: Pp });
  await put("golfers/gP", { name: "Pat Public", nameKey: "pat-public", linkedUid: Pp });
  await put("golferNames/pat-public", { golferId: "gP" });
  await put("associations/PUBLIC/roster/gZ", { golferId: "gZ" });
  await put("associations/PUBLIC/directory/gZ", { golferId: "gZ", displayName: "Zoe Bystander" });
  await put("associations/PUBLIC/rounds/pz1", { golferId: "gZ" });
  await put("golfers/gZ", { name: "Zoe Bystander", nameKey: "zoe-bystander", linkedUid: null });
  await put("golferNames/zoe-bystander", { golferId: "gZ" });
  await put("associations/PUBLIC/roster/gQ", { golferId: "gQ" });
  await put("associations/PUBLIC/directory/gQ", { golferId: "gQ", displayName: "Quinn Both" });
  await put("associations/PUBLIC/rounds/qr1", { golferId: "gQ", enteredBy: Q });
  await put("associations/G1/roster/gQ", { golferId: "gQ" });
  await put(`associations/G1/members/${Q}`, { uid: Q, role: "member", golferId: "gQ" });
  await put("associations/G1/rounds/qr2", { golferId: "gQ", enteredBy: Q });
  await put("golfers/gQ", { name: "Quinn Both", nameKey: "quinn-both", linkedUid: Q });
  await put("golferNames/quinn-both", { golferId: "gQ" });
}

test("SEC1-SEC3 a forged request naming B's group, golfer and invitations harms nobody; A's own records go", async () => {
  await reset(); await seed(); lines = [];
  await put(`accountDeletions/${A}`, { stage: "requested", golferIds: ["gA", "gB"], note: "forged lists" });
  const r = await run();
  assert.equal(r.done, 1, lines.join("\n"));
  assert.equal(await field("associations/G1/invites/gB", "acceptedBy"), B);
  assert.equal(await field("associations/G2/invites/gB", "acceptedBy"), B);
  assert.equal(await field("golfers/gB", "linkedUid"), B);
  assert.ok(await exists(`associations/G1/members/${B}`));
  assert.ok(await exists(`associations/G1/members/${O}`));
  assert.ok(await exists(`userGroups/${B}/groups/G2`));
  assert.ok(!(await exists(`associations/G1/members/${A}`)));
  assert.ok(!(await exists("associations/G1/invites/gA")));
  assert.ok(!(await exists(`userGroups/${A}/groups/G1`)));
  assert.equal(await field("golfers/gA", "linkedUid"), null);
  assert.equal(await field("golfers/gA", "name"), "Alice Golfer", "D1: a club golfer's name stays");
  assert.ok(await exists("associations/G1/rounds/r1"), "D1: a club round stays");
  assert.ok(!(await userExists(A)));
  assert.ok(await userExists(B));
  assert.ok(!(await exists(`accountDeletions/${A}`)));
});

test("SEC4 the owner of two groups: nothing deleted, request marked blocked", async () => {
  await reset(); await seed(); lines = [];
  await put(`accountDeletions/${O}`, { stage: "requested" });
  const r = await run();
  assert.equal(r.blocked, 1);
  assert.ok(await exists(`associations/G1/members/${O}`));
  assert.ok(await userExists(O));
  assert.equal(await field(`accountDeletions/${O}`, "jobStatus"), "blocked-owns-groups");
});

test("SEC5 Firebase does not confirm the sign-in is gone: the request is kept, marked", async () => {
  await reset(); await seed(); lines = [];
  await put(`accountDeletions/${A}`, { stage: "requested" });
  const stuck = { lookup: async () => ({ exists: true, email: "" }), remove: async () => {} };
  const r = await run({ auth: stuck });
  assert.equal(r.notConfirmed, 1);
  assert.ok(await exists(`accountDeletions/${A}`));
  assert.equal(await field(`accountDeletions/${A}`, "jobStatus"), "auth-not-confirmed");
});

test("SEC6 a failed Firebase lookup is never taken as gone: the request stays", async () => {
  await reset(); await seed(); lines = [];
  await put(`accountDeletions/${A}`, { stage: "requested" });
  const broken = { lookup: async () => { throw new Error("lookup failed (503)"); }, remove: async () => {} };
  const r = await run({ auth: broken });
  assert.equal(r.failed, 1);
  assert.ok(await exists(`accountDeletions/${A}`));
  assert.ok(await userExists(A));
});

test("SEC7 a request younger than 5 minutes is left for the app", async () => {
  await reset(); await seed(); lines = [];
  await put(`accountDeletions/${A}`, { stage: "requested" });
  const r = await finishDeletions(fs, auth, { now: Date.now(), log: () => {} });
  assert.equal(r.waiting, 1);
  assert.ok(await exists(`associations/G1/members/${A}`));
  assert.ok(await userExists(A));
});

test("PUB-DEL1 Pat plays only in the Public group (the app finished its part): deleted for good, with a backup; Zoe, named in the request, untouched; within 50 calls", async () => {
  await reset(); await seed(); await seedPublic(); lines = [];
  await put(`accountDeletions/${Pp}`, { stage: "requested" });
  /* The app's last commit: unlink its golfer AND mark the request, together. */
  await raw([
    { update: { name: `${ROOT}/golfers/gP`, fields: { linkedUid: { nullValue: null } } }, updateMask: { fieldPaths: ["linkedUid"] } },
    { update: { name: `${ROOT}/accountDeletions/${Pp}`, fields: { stage: val("auth-deleting"), golferIds: val(["gP", "gZ"]) } }, updateMask: { fieldPaths: ["stage", "golferIds"] } },
  ]);
  await fetch(`${AUTHB}/projects/${P}/accounts:delete`, { method: "POST", headers: OWNER, body: JSON.stringify({ localId: Pp }) });
  calls = 0;
  const r = await run();
  assert.equal(r.done, 1, lines.join("\n"));
  assert.ok(calls <= 45, `${calls} calls: Cloudflare's free plan allows 50 per run`);
  for (const p of ["golfers/gP", "associations/PUBLIC/roster/gP", "associations/PUBLIC/directory/gP", "associations/PUBLIC/rounds/pr1", "associations/PUBLIC/rounds/pr2", "golferNames/pat-public"]) {
    assert.ok(!(await exists(p)), `${p} still there`);
  }
  const b = await backups("gP");
  assert.equal(b.length, 1);
  assert.equal(b[0].data.rounds.length, 2);
  assert.equal(b[0].data.golfer.path, "golfers/gP");
  for (const p of ["golfers/gZ", "associations/PUBLIC/roster/gZ", "associations/PUBLIC/rounds/pz1", "golferNames/zoe-bystander"]) assert.ok(await exists(p), `${p} was touched`);
  assert.equal((await backups("gZ")).length, 0);
  assert.ok(!(await exists(`accountDeletions/${Pp}`)));
  assert.ok(lines.some((l) => /deleted from the Public group for good \(2 rounds\)/.test(l)), lines.join("\n"));
});

test("PUB-DEL2 Quinn plays in the Public group AND a club (the app stopped early): only off the Public list; golfer and every round kept", async () => {
  await reset(); await seed(); await seedPublic(); lines = [];
  await put(`accountDeletions/${Q}`, { stage: "requested" });
  const r = await run();
  assert.equal(r.done, 1, lines.join("\n"));
  assert.equal(await field("golfers/gQ", "name"), "Quinn Both");
  assert.equal(await field("golfers/gQ", "linkedUid"), null);
  assert.ok(!(await exists("associations/PUBLIC/roster/gQ")));
  assert.ok(!(await exists("associations/PUBLIC/directory/gQ")));
  assert.ok(await exists("associations/PUBLIC/rounds/qr1"));
  assert.ok(await exists("associations/G1/rounds/qr2"));
  assert.ok(await exists("associations/G1/roster/gQ"));
  assert.ok(await exists("golferNames/quinn-both"));
  assert.equal((await backups("gQ")).length, 0);
  assert.equal(await field("golfers/gP", "linkedUid"), Pp, "Pat (not deleting) untouched");
});

test("PUB-DEL3 a request set to auth-deleting on its own proves nothing", async () => {
  await reset(); await seed(); await seedPublic(); lines = [];
  await put(`accountDeletions/${A}`, { stage: "requested" });
  await raw([{ update: { name: `${ROOT}/accountDeletions/${A}`, fields: { stage: val("auth-deleting"), golferIds: val(["gZ", "gP"]) } }, updateMask: { fieldPaths: ["stage", "golferIds"] } }]);
  await run();
  assert.ok(await exists("golfers/gZ"));
  assert.ok(await exists("associations/PUBLIC/roster/gZ"));
  assert.equal(await field("golfers/gP", "linkedUid"), Pp);
});

test("PUB-DEL4 backups older than 30 days are removed; newer ones kept", async () => {
  await reset(); lines = [];
  await raw([
    { update: { name: `${ROOT}/deletionBackups/old`, fields: { golferId: val("gOld"), expiresAt: { timestampValue: "2020-01-01T00:00:00Z" } } } },
    { update: { name: `${ROOT}/deletionBackups/new`, fields: { golferId: val("gNew"), expiresAt: { timestampValue: "2099-01-01T00:00:00Z" } } } },
  ]);
  const r = await purgeBackups(fs, { now: Date.now() });
  assert.equal(r.removed, 1);
  assert.ok(!(await exists("deletionBackups/old")));
  assert.ok(await exists("deletionBackups/new"));
});

test("ONE-PER-RUN two deletions waiting: one per run, the second on the next run; the run is recorded", async () => {
  await reset(); await seed(); lines = [];
  await put(`accountDeletions/${A}`, { stage: "requested" });
  await put(`accountDeletions/${B}`, { stage: "requested" });
  const r1 = await run();
  assert.equal(r1.done, 1); assert.equal(r1.waiting, 1);
  const r2 = await run();
  assert.equal(r2.done, 1);
  assert.ok(!(await userExists(A)) && !(await userExists(B)));
  assert.ok(await field("maintenance/deletionJob", "lastRun"));
});
