import test from "node:test";
import assert from "node:assert/strict";
import * as check from "../../cardcheck.js";
import { TEES, PAR, reading } from "./royal-ontario.mjs";

test("K1 the true sums of the club's card (the test data itself is right)", () => {
  const add = (a, from, to) => a.slice(from, to).reduce((x, y) => x + y, 0);
  assert.equal(add(PAR, 0, 9), 36); assert.equal(add(PAR, 9, 18), 36);
  for (const [n, t] of Object.entries(TEES)) {
    assert.equal(add(t.yards, 0, 9), t.misprintOut || t.out, n + " OUT");
    assert.equal(add(t.yards, 9, 18), t.misprintIn || t.in, n + " IN");
  }
});

test("K2 two pictures, nine by nine, make one verified card with every tee", () => {
  const m = check.mergeReadings([reading("front"), reading("back")]);
  assert.equal(m.read.length, 18);
  assert.deepEqual(m.tees.map((t) => t.name), ["Black", "Gold", "Blue", "White", "Red"]);
  assert.deepEqual(m.tees[3].yards, TEES.WHITE.yards);
  assert.equal(m.tees[3].rating, 69.7, "rating from the first picture, kept");
  /* Fully strict: the Red misprint on the club's card stops it. */
  const strict = check.verifyCard(m);
  assert.equal(strict.ok, false);
  assert.deepEqual(strict.problems, ["Red: its yards do not add up to the OUT total 2529."]);
  /* Yards only warned about (they do not affect handicaps): verified. */
  const v = check.verifyCard(m, { lenientYards: true });
  assert.deepEqual(v.problems, []);
  assert.equal(v.ok, true);
  assert.deepEqual(v.tees.red.warnings, ["the card prints OUT 2529, but its holes add up to 2539"]);
  assert.equal(v.par, 72);
  assert.match(v.notes.join(" "), /Gold: the card prints IN 3457, but its holes add up to 3467, which the card's own total 6786 confirms/);
  const c = check.courseFromCard(m);
  assert.equal(c.tees.length, 5);
  assert.equal(c.tees[3].holes[2].par, 5, "hole 3 is a par 5 (the database said 4)");
  assert.equal(c.tees[3].holes[17].si, 1);
});

test("K3 one nine only is not verified, and says what is missing", () => {
  const v = check.verifyCard(check.mergeReadings([reading("front")]));
  assert.equal(v.ok, false);
  assert.match(v.problems[0], /Holes 10 to 18 have not been read yet/);
  assert.equal(v.front, true);
});

test("K4 every tee must be complete, not only the one played", () => {
  const m = check.mergeReadings([reading("front", { tweak: (r) => { r.tees[0].holes[3].yards = null; } }), reading("back")]);
  const v = check.verifyCard(m, { lenientYards: true });
  assert.equal(v.ok, false);
  assert.equal(v.tees.white.ok, true);
  assert.equal(v.tees.black.ok, false);
  assert.deepEqual(v.tees.black.yards, [4]);
  assert.match(v.problems.join(" "), /Black: some yards were not read/);
});

test("K5 pars, handicap numbers, totals and ratings are all checked", () => {
  const bad = (tweak) => check.verifyCard(check.mergeReadings([reading("front", { tweak }), reading("back")]), { lenientYards: true });
  let v = bad((r) => { r.tees.forEach((t) => { t.holes[2].par = 4; }); });
  assert.equal(v.ok, false); assert.equal(v.front, false); assert.match(v.problems.join(" "), /pars of holes 1 to 9 do not add up to 36/);
  v = bad((r) => { r.tees.forEach((t) => { t.holes[0].si = 10; }); });
  assert.equal(v.ok, false); assert.deepEqual(v.holes.hcp.sort((a, b) => a - b), [1, 2]);
  v = bad((r) => { r.parOut = null; });
  assert.match(v.problems.join(" "), /par total for holes 1 to 9 was not read/);
  v = bad((r) => { r.tees[0].rating = null; });
  assert.match(v.problems.join(" "), /Black: its rating was not read/);
  v = bad((r) => { r.course = ""; });
  assert.match(v.problems.join(" "), /course name was not read/);
});

test("K6 a retaken picture replaces the holes it shows", () => {
  const wrong = reading("back", { tweak: (r) => { r.tees[3].holes[16].yards = 148; } });
  let v = check.verifyCard(check.mergeReadings([reading("front"), wrong]));
  assert.equal(v.tees.white.ok, false);
  v = check.verifyCard(check.mergeReadings([reading("front"), wrong, reading("back")]));
  assert.equal(v.tees.white.ok, true);
});

test("K7 a misprinted nine total is accepted only when the card's 18-hole total proves it", () => {
  /* Without the TOTAL, the Gold misprint makes the card unverifiable. */
  const noTotal = check.mergeReadings([reading("front"), reading("back", { tweak: (r) => { r.tees.forEach((t) => { t.total = null; }); } })]);
  assert.equal(check.verifyCard(noTotal).ok, false);
  /* A wrong yardage that the TOTAL does not confirm is still refused. */
  const wrong = check.mergeReadings([reading("front"), reading("back", { tweak: (r) => { r.tees[3].holes[16].yards = 148; } })]);
  assert.equal(check.verifyCard(wrong).tees.white.ok, false);
});

test("K8 one picture of the whole card is enough when everything is read", () => {
  const f = reading("front"), b = reading("back");
  const whole = { ...f, holesRead: [...f.holesRead, ...b.holesRead], parIn: 36,
    tees: f.tees.map((t, i) => ({ ...t, in: b.tees[i].in, total: b.tees[i].total, holes: t.holes.map((h, j) => (j < 9 ? h : b.tees[i].holes[j])) })) };
  const v = check.verifyCard(check.mergeReadings([whole]), { lenientYards: check.LENIENT_YARDS });
  assert.equal(v.ok, true);
});
