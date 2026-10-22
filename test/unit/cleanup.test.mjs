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
