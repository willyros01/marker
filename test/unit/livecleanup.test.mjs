/* Old live cards (worker/src/cleanup.js cleanLiveCards). Willy, 30 Oct 2026:
 * the follow / caddie copy of a card is deleted 30 days after its codes
 * stopped working, with its codes; nothing younger and nothing else is touched. */
import test from "node:test";
import assert from "node:assert/strict";
import { fakeFs } from "./fakefs.mjs";
import { cleanLiveCards, LIVE_STATE } from "../../worker/src/cleanup.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1, 12);          /* when the old cards' codes stopped working */

function world() {
  return fakeFs({
    "markerLive/old1": { owner: "u1", followCode: "F1", code: null, expiresAt: T0, setup: { players: [{ name: "Guest" }] } },
    "markerLive/old2": { owner: "u1", followCode: null, code: "C2", caddieUid: "c9", expiresAt: T0 },
    "markerLive/young": { owner: "u1", followCode: "F3", expiresAt: T0 + 20 * DAY },
    "markerLive/nodate": { owner: "u1" },
    "markerFollowCodes/F1": { liveId: "old1", expiresAt: T0 },
    "markerCaddieCodes/C2": { liveId: "old2", expiresAt: T0 },
    "markerFollowCodes/F3": { liveId: "young", expiresAt: T0 + 20 * DAY },
    "markerFollowCodes/F9": { liveId: "someoneElse", expiresAt: T0 },
    "markerSubmissions/s1": { status: "posted", liveId: "old1" },
  });
}

test("LC1 before 30 days nothing is deleted", async () => {
  const fs = world();
  const r = await cleanLiveCards(fs, { now: T0 + 29 * DAY });
  assert.equal(r.deleted, 0);
  assert.ok(fs.data("markerLive/old1"));
  assert.equal(fs.data(LIVE_STATE).checked, 4);
});

test("LC2 after 30 days: old cards and their own codes go; young, undated and other documents stay", async () => {
  const fs = world();
  const r = await cleanLiveCards(fs, { now: T0 + 30 * DAY });
  assert.equal(r.deleted, 2);
  for (const p of ["markerLive/old1", "markerLive/old2", "markerFollowCodes/F1", "markerCaddieCodes/C2"]) assert.equal(fs.data(p), null, p);
  for (const p of ["markerLive/young", "markerLive/nodate", "markerFollowCodes/F3", "markerFollowCodes/F9", "markerSubmissions/s1"]) assert.ok(fs.data(p), p);
  assert.equal(fs.commits.length, 3, "one commit per card, then the record");
});

test("LC3 a card changed since it was read is kept for the next run, the others still go", async () => {
  const fs = world();
  const orig = fs.query.bind(fs);
  fs.query = async (...a) => { const rows = await orig(...a); fs.touch("markerLive/old1", { lastAt: 1 }); return rows; };
  const r = await cleanLiveCards(fs, { now: T0 + 31 * DAY });
  assert.equal(r.deleted, 1);
  assert.equal(r.keptBecauseChanged, 1);
  assert.ok(fs.data("markerLive/old1"));
  assert.ok(fs.data("markerFollowCodes/F1"), "its code stays with it");
  assert.equal(fs.data("markerLive/old2"), null);
});

test("LC4 a code that points at another card is never deleted with this one", async () => {
  const fs = world();
  fs.docs.set("markerLive/old3", { data: { followCode: "F9", expiresAt: T0 }, updateTime: "2026-10-16T12:00:00.500Z" });
  await cleanLiveCards(fs, { now: T0 + 40 * DAY });
  assert.equal(fs.data("markerLive/old3"), null);
  assert.ok(fs.data("markerFollowCodes/F9"));
});

test("LC5 at most `max` cards a run; the rest wait for the next day", async () => {
  const fs = world();
  const r = await cleanLiveCards(fs, { now: T0 + 30 * DAY, max: 1 });
  assert.equal(r.deleted, 1);
  assert.equal(r.waitingForNextRun, 1);
});

test("LC6 a game's follow code and its pointer go 30 days after the code stopped; a recent one stays (1.1.0)", async () => {
  const { fakeFs } = await import("./fakefs.mjs");
  const { cleanLiveCards } = await import("../../worker/src/cleanup.js");
  const DAYMS = 86400_000, NOW = Date.UTC(2026, 11, 15);
  const fs = fakeFs({
    "markerGameFollow/G1_gm1_2026-11-01": { code: "123456", expiresAt: NOW - 31 * DAYMS },
    "markerFollowCodes/123456": { kind: "game", gameKey: "G1_gm1_2026-11-01", expiresAt: NOW - 31 * DAYMS },
    "markerGameFollow/G1_gm1_2026-12-10": { code: "654321", expiresAt: NOW - 5 * DAYMS },
    "markerFollowCodes/654321": { kind: "game", gameKey: "G1_gm1_2026-12-10", expiresAt: NOW - 5 * DAYMS },
  });
  const r = await cleanLiveCards(fs, { now: NOW });
  assert.equal(r.gameCodesDeleted, 1);
  assert.ok(!fs.docs.has("markerGameFollow/G1_gm1_2026-11-01") && !fs.docs.has("markerFollowCodes/123456"));
  assert.ok(fs.docs.has("markerGameFollow/G1_gm1_2026-12-10") && fs.docs.has("markerFollowCodes/654321"));
});
