/* The daily golfer clean-up (worker/src/cleanup.js). Willy, 22 Oct 2026:
 * a golfer with no rounds, no group and no linked account is deleted after
 * 7 days; anything still in use is never touched; one commit per golfer. */
import test from "node:test";
import assert from "node:assert/strict";
import { fakeFs } from "./fakefs.mjs";
import { cleanGolfers, STATE } from "../../worker/src/cleanup.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 23, 7);

function world() {
  return fakeFs({
    "associations/G1": { name: "Golf Buddies" },
    "associations/G1/roster/gOnRoster": { golferId: "gOnRoster" },
    "associations/G1/members/u1": { uid: "u1", golferId: "gMember" },
    "associations/G1/rounds/r1": { golferId: "gRound", differential: 12 },
    "associations/G1/games/m1": { name: "Cup", golferIds: ["gGame"] },
    "associations/PUBLIC/directory/gUnused": { golferId: "gUnused", displayName: "Test Person" },
    "markerSubmissions/s1": { status: "sent", players: [{ golferId: "gCard" }] },
    "userBlocks/u9/golfers/gUnused": { at: 1 },
    "golferNames/test person": { golferId: "gUnused", name: "Test Person" },
    "golferNames/kept name": { golferId: "gOnRoster", name: "Kept" },
    "golfers/gUnused": { name: "Test Person", groups: ["PUBLIC"] },
    "golfers/gUnused2": { name: "Other Test", archived: true },
    "golfers/gOnRoster": { name: "On Roster" },
    "golfers/gMember": { name: "Member" },
    "golfers/gRound": { name: "Has Round" },
    "golfers/gCount": { name: "Count Only", roundCount: 3 },
    "golfers/gLinked": { name: "Linked", linkedUid: "u5" },
    "golfers/gGame": { name: "In Game" },
    "golfers/gCard": { name: "On a Card" },
  });
}

test("CL1 first run: unused golfers are only noted, nothing deleted", async () => {
  const fs = world();
  const r = await cleanGolfers(fs, { now: T0 });
  assert.deepEqual(Object.keys(r.pending).sort(), ["gUnused", "gUnused2"]);
  assert.deepEqual(r.deleted, []);
  assert.ok(fs.data("golfers/gUnused"));
  assert.equal(fs.data(STATE).lastRun, new Date(T0).toISOString());
  assert.equal(fs.data(STATE).checked, 9);
});

test("CL2 after 7 days: deleted with name claim, directory entry and block; nothing else touched", async () => {
  const fs = world();
  await cleanGolfers(fs, { now: T0 });
  const before = [...fs.docs.keys()].length;
  await cleanGolfers(fs, { now: T0 + 6 * DAY });
  assert.ok(fs.data("golfers/gUnused"), "not before 7 days");
  const r = await cleanGolfers(fs, { now: T0 + 7 * DAY });
  assert.deepEqual(r.deleted.sort(), ["Other Test", "Test Person"]);
  for (const p of ["golfers/gUnused", "golfers/gUnused2", "golferNames/test person",
    "associations/PUBLIC/directory/gUnused", "userBlocks/u9/golfers/gUnused"]) assert.equal(fs.data(p), null, p);
  for (const g of ["gOnRoster", "gMember", "gRound", "gCount", "gLinked", "gGame", "gCard"]) assert.ok(fs.data(`golfers/${g}`), g);
  assert.ok(fs.data("golferNames/kept name"));
  assert.equal([...fs.docs.keys()].length, before - 5);
  assert.deepEqual(fs.data(STATE).pending, {});
});

test("CL3 used again during the wait: dropped from the list, never deleted", async () => {
  const fs = world();
  await cleanGolfers(fs, { now: T0 });
  fs.docs.set("associations/G1/roster/gUnused", { data: { golferId: "gUnused" }, updateTime: "2026-10-24T00:00:00.000Z" });
  const r = await cleanGolfers(fs, { now: T0 + 3 * DAY });
  assert.equal(r.pending.gUnused, undefined);
  fs.docs.delete("associations/G1/roster/gUnused");
  const r2 = await cleanGolfers(fs, { now: T0 + 8 * DAY });
  assert.equal(r2.pending.gUnused, T0 + 8 * DAY, "the 7 days start again");
  assert.ok(fs.data("golfers/gUnused"));
});

test("CL4 changed between read and delete: that golfer kept, the others go ahead", async () => {
  const fs = world();
  await cleanGolfers(fs, { now: T0 });
  const { FirestoreError } = await import("../../worker/src/firestore.js");
  fs.failNext = new FirestoreError(400, "FAILED_PRECONDITION");
  const r = await cleanGolfers(fs, { now: T0 + 7 * DAY });
  assert.equal(r.deleted.length, 1);
  assert.equal(r.keptBecauseChanged.length, 1);
  const left = ["gUnused", "gUnused2"].filter((g) => fs.data(`golfers/${g}`));
  assert.equal(left.length, 1);
  assert.ok(r.pending[left[0]], "still waiting, looked at again next run");
  const r2 = await cleanGolfers(fs, { now: T0 + 8 * DAY });
  assert.equal(r2.deleted.length, 1);
});

test("CL5 at most `max` deletions per run; the rest wait for the next run", async () => {
  const fs = world();
  await cleanGolfers(fs, { now: T0 });
  const r = await cleanGolfers(fs, { now: T0 + 7 * DAY, max: 1 });
  assert.equal(r.deleted.length, 1);
  assert.equal(r.waiting, 1);
});

test("CL6 a read that fails stops the run: nothing deleted, no record written", async () => {
  const fs = world();
  await cleanGolfers(fs, { now: T0 });
  const last = fs.data(STATE).lastRun;
  fs.queryGroup = async () => { throw new Error("network"); };
  await assert.rejects(cleanGolfers(fs, { now: T0 + 7 * DAY }));
  assert.ok(fs.data("golfers/gUnused"));
  assert.equal(fs.data(STATE).lastRun, last);
});

test("CL7 status: healthy under 48 hours, not before the first run or after 48 hours, no names", async () => {
  const { cleanupStatus } = await import("../../worker/src/cleanup.js");
  const fs = world();
  assert.equal((await cleanupStatus(fs, { now: T0 })).ok, false);
  await cleanGolfers(fs, { now: T0 });
  const ok = await cleanupStatus(fs, { now: T0 + 47 * 36e5 });
  assert.equal(ok.ok, true);
  assert.ok(!JSON.stringify(ok).includes("Test Person"));
  assert.equal((await cleanupStatus(fs, { now: T0 + 48 * 36e5 })).ok, false);
});

/* Deleted accounts (Willy, 7 Nov 2026): a golfer whose account was deleted
 * with "Delete my account" and who has no rounds, games or Marker cards is
 * cleaned up even though it stays on a roster; one with rounds is kept. */
import { noteDeletedAccounts, ACCOUNT_STATE } from "../../worker/src/cleanup.js";

function accountWorld() {
  const fs = fakeFs({
    "associations/PUBLIC": { name: "Public group" },
    "associations/PUBLIC/roster/gGone": { golferId: "gGone" },
    "associations/PUBLIC/roster/gPlayed": { golferId: "gPlayed" },
    "associations/PUBLIC/roster/gAdmin": { golferId: "gAdmin" },
    "associations/PUBLIC/rounds/r1": { golferId: "gPlayed", differential: 14 },
    "associations/PUBLIC/directory/gGone": { golferId: "gGone", displayName: "Devin Test" },
    "golferNames/devin test": { golferId: "gGone", name: "Devin Test" },
    "golfers/gGone": { name: "Devin Test", linkedUid: "uGone", groups: ["PUBLIC"] },
    "golfers/gPlayed": { name: "Has Played", linkedUid: "uPlayed", roundCount: 1 },
    "golfers/gAdmin": { name: "Added By Admin", linkedUid: null },
  });
  /* What "Delete my account" does: the request first, then the golfer unlinked. */
  fs.deleteAccount = (uid, golferIds) => {
    fs.docs.set(`accountDeletions/${uid}`, { data: { stage: "requested", golferIds }, updateTime: "2026-10-17T00:00:00.000Z", createTime: "2026-10-17T00:00:00.000Z" });
    for (const g of golferIds) if (fs.data(`golfers/${g}`) && fs.data(`golfers/${g}`).linkedUid === uid) {
      const d = fs.docs.get(`golfers/${g}`);
      fs.docs.set(`golfers/${g}`, { data: { ...d.data, linkedUid: null }, updateTime: "2026-10-17T00:00:05.000Z", createTime: d.createTime });
    }
  };
  return fs;
}

test("CL8 deleted account, no rounds: noted, then after 7 days deleted with its roster entry, name claim and directory entry in one commit", async () => {
  const fs = accountWorld();
  fs.deleteAccount("uGone", ["gGone"]);
  const n = await noteDeletedAccounts(fs, { now: T0 });
  assert.equal(n.added, 1);
  assert.ok(fs.data(ACCOUNT_STATE).golfers.gGone);
  fs.docs.delete("accountDeletions/uGone");                       /* the completion job removes the request */
  const r1 = await cleanGolfers(fs, { now: T0 });
  assert.ok(r1.pending.gGone, "waiting");
  assert.deepEqual(r1.deleted, []);
  const commits = fs.commits.length;
  const r2 = await cleanGolfers(fs, { now: T0 + 7 * DAY });
  assert.deepEqual(r2.deleted, ["Devin Test"]);
  for (const p of ["golfers/gGone", "associations/PUBLIC/roster/gGone", "golferNames/devin test", "associations/PUBLIC/directory/gGone"]) assert.equal(fs.data(p), null, p);
  assert.equal(fs.commits.length - commits, 2, "one commit for the golfer, one for the record");
  assert.ok(fs.data("golfers/gPlayed") && fs.data("associations/PUBLIC/roster/gPlayed"));
  assert.ok(fs.data("golfers/gAdmin") && fs.data("associations/PUBLIC/roster/gAdmin"));
});

test("CL9 deleted account WITH rounds: noted but kept on the roster, as before", async () => {
  const fs = accountWorld();
  fs.deleteAccount("uPlayed", ["gPlayed"]);
  await noteDeletedAccounts(fs, { now: T0 });
  await cleanGolfers(fs, { now: T0 });
  const r = await cleanGolfers(fs, { now: T0 + 30 * DAY });
  assert.equal(r.pending.gPlayed, undefined);
  assert.ok(fs.data("golfers/gPlayed") && fs.data("associations/PUBLIC/roster/gPlayed"));
});

test("CL10 a request naming somebody else's golfer notes nothing: that golfer was not changed by the deletion", async () => {
  const fs = accountWorld();
  fs.deleteAccount("uBad", ["gAdmin", "../x", 7]);
  const n = await noteDeletedAccounts(fs, { now: T0 });
  assert.equal(n.added, 0);
  assert.equal(fs.data(ACCOUNT_STATE), null, "nothing written");
  await cleanGolfers(fs, { now: T0 });
  await cleanGolfers(fs, { now: T0 + 30 * DAY });
  assert.ok(fs.data("golfers/gAdmin") && fs.data("associations/PUBLIC/roster/gAdmin"));
});

test("CL11 a noted golfer linked again or given a round during the wait is never deleted", async () => {
  const fs = accountWorld();
  fs.deleteAccount("uGone", ["gGone"]);
  await noteDeletedAccounts(fs, { now: T0 });
  await cleanGolfers(fs, { now: T0 });
  fs.touch("golfers/gGone", { linkedUid: "uNew" });
  const r = await cleanGolfers(fs, { now: T0 + 7 * DAY });
  assert.deepEqual(r.deleted, []);
  assert.equal(r.pending.gGone, undefined);
  fs.touch("golfers/gGone", { linkedUid: null });
  fs.docs.set("associations/PUBLIC/rounds/r2", { data: { golferId: "gGone" }, updateTime: "2026-10-30T00:00:00.000Z" });
  await cleanGolfers(fs, { now: T0 + 8 * DAY });
  const r2 = await cleanGolfers(fs, { now: T0 + 20 * DAY });
  assert.deepEqual(r2.deleted, []);
  assert.ok(fs.data("golfers/gGone") && fs.data("associations/PUBLIC/roster/gGone"));
});

test("CL12 no deletion requests: one read, nothing written; a noted golfer already gone is dropped from the list", async () => {
  const fs = accountWorld();
  const calls = fs.calls;
  const n = await noteDeletedAccounts(fs, { now: T0 });
  assert.deepEqual(n, { requests: 0, added: 0 });
  assert.equal(fs.calls - calls, 1);
  assert.equal(fs.commits.length, 0);
  fs.deleteAccount("uGone", ["gGone"]);
  await noteDeletedAccounts(fs, { now: T0 });
  fs.docs.delete("golfers/gGone");
  fs.deleteAccount("uPlayed", ["gPlayed"]);
  const n2 = await noteDeletedAccounts(fs, { now: T0 + DAY });
  assert.equal(n2.dropped, 1);
  assert.deepEqual(Object.keys(fs.data(ACCOUNT_STATE).golfers), ["gPlayed"]);
});
