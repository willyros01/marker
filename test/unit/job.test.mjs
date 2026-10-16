import test from "node:test";
import assert from "node:assert/strict";
import { rebuild, toValue, fromValue } from "../../.github/scripts/apply-cards.mjs";

test("J1 Firestore values survive the round trip", () => {
  const x = { a: 1, b: 2.5, c: "s", d: null, e: [1, { f: true }], g: { h: [] } };
  assert.deepEqual(fromValue(toValue(x)), x);
});

test("J2 the rebuild keeps other groups' entries and recounts this group's", () => {
  const golfer = { recentWindow: [
    { roundId: "old1", date: "2026-09-01", differential: 20, assocId: "G9" },
    { roundId: "x", date: "2026-09-02", differential: 99, assocId: "G1" },   // replaced by the rescan
  ] };
  const next = rebuild(golfer, { G1: [
    { id: "r1", date: "2026-10-01", differential: 18.2 },
    { id: "r2", date: "2026-10-05", differential: 22.0 },
    { id: "r3", date: "2026-10-16", differential: 15.1, archived: true },
    { id: "r4", date: "bad", differential: 10 },
    { id: "r5", date: "2026-10-10", differential: null },
  ] });
  assert.deepEqual(next.recentWindow.map((e) => e.roundId), ["r2", "r1", "old1"]);
  assert.equal(next.roundCount, 3);
  assert.equal(next.handicapIndex, 18.2 - 2, "three rounds: lowest one, minus 2.0");
});

test("J3 no index below three rounds; a manual index stands in for the directory", () => {
  const next = rebuild({ recentWindow: [], manualIndex: 12.4 }, { G1: [{ id: "r1", date: "2026-10-01", differential: 18 }] });
  assert.equal(next.handicapIndex, null);
  assert.equal(next.directoryIndex, 12.4);
});
