/* Lakeview Golf Course, Mississauga: Willy's paper card, 16 Oct 2026 (read by
   hand from his photo). Its Red row has a men's AND a ladies' rating. */
import test from "node:test";
import assert from "node:assert/strict";
import * as check from "../../cardcheck.js";
import * as search from "../../worker/src/search.js";

const PAR = [4, 4, 3, 4, 5, 4, 5, 4, 3, 3, 4, 4, 4, 4, 4, 5, 3, 4];
const HCP = [13, 9, 17, 7, 3, 1, 5, 15, 11, 16, 6, 10, 2, 12, 14, 8, 18, 4];
const Y = {
  BLUE: [356, 419, 135, 378, 594, 441, 469, 344, 214, 150, 414, 327, 414, 338, 317, 477, 95, 360],
  WHITE: [338, 384, 124, 350, 547, 433, 460, 315, 199, 134, 371, 294, 387, 334, 302, 467, 91, 333],
  RED: [286, 278, 113, 291, 420, 390, 417, 220, 137, 105, 291, 258, 300, 239, 289, 423, 86, 303],
};
const TOT = { BLUE: [3350, 2892, 6242], WHITE: [3150, 2713, 5863], RED: [2552, 2294, 4846] };
const RATINGS = { BLUE: [{ for: "", rating: 70.3, slope: 124 }], WHITE: [{ for: "", rating: 68.6, slope: 120 }], RED: [{ for: "M", rating: 63.8, slope: 109 }, { for: "L", rating: 68.2, slope: 115 }] };

/* What the model is asked to answer, for the given holes. */
const answer = (holes, { ratings = true } = {}) => ({
  course: "",
  holes: holes.map((n) => ({ hole: n, par: PAR[n - 1], hcp: HCP[n - 1], yards: Object.fromEntries(Object.keys(Y).map((k) => [k, Y[k][n - 1]])) })),
  tees: Object.keys(Y).map((k) => ({ name: k, ratings: ratings ? RATINGS[k] : [], rating: null, slope: null,
    out: holes.includes(1) ? TOT[k][0] : null, in: holes.includes(10) ? TOT[k][1] : null, total: holes.includes(10) ? TOT[k][2] : null })),
  parOut: holes.includes(1) ? 36 : null, parIn: holes.includes(10) ? 35 : null,
});
const all = Array.from({ length: 18 }, (_, i) => i + 1);

test("L1 a red row with men's and ladies' ratings becomes two tees with the same yards", () => {
  const r = search.normalizeScan(answer(all));
  assert.deepEqual(r.tees.map((t) => t.name), ["BLUE", "WHITE", "RED (men)", "RED (ladies)"]);
  const men = r.tees[2], ladies = r.tees[3];
  assert.equal(men.rating, 63.8); assert.equal(men.slope, 109);
  assert.equal(ladies.rating, 68.2); assert.equal(ladies.slope, 115);
  assert.deepEqual(men.holes.map((h) => h.yards), Y.RED);
  assert.deepEqual(ladies.holes.map((h) => h.yards), Y.RED);
  assert.equal(r.tees[0].rating, 70.3, "a single rating in the list is used");
});

test("L2 one picture of the whole Lakeview card is verified, with four tees", () => {
  const m = check.mergeReadings([{ ...search.normalizeScan(answer(all)) }]);
  m.course = "Lakeview Golf Course";
  const v = check.verifyCard(m, { lenientYards: check.LENIENT_YARDS });
  assert.deepEqual(v.problems, []);
  assert.equal(v.par, 71);
  assert.deepEqual(m.tees.map((t) => t.name), ["Blue", "White", "Red (men)", "Red (ladies)"]);
});

test("L3 two pictures: the split red row is completed by a plain red row, in either order", () => {
  const front = search.normalizeScan(answer(all.slice(0, 9)));
  const back = search.normalizeScan(answer(all.slice(9), { ratings: false }));
  for (const order of [[front, back], [back, front]]) {
    const m = check.mergeReadings(order);
    m.course = "Lakeview Golf Course";
    const v = check.verifyCard(m, { lenientYards: check.LENIENT_YARDS });
    assert.deepEqual(v.problems, [], JSON.stringify(m.tees.map((t) => t.name)));
    assert.equal(m.tees.length, 4);
    const ladies = m.tees.find((t) => /ladies/.test(t.name));
    assert.deepEqual(ladies.yards, Y.RED);
    assert.equal(ladies.rating, 68.2);
  }
});
