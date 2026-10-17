/* Royal Ontario Golf Club, as printed on the club's card (read by hand from
   the picture Willy sent, 16 Oct 2026). Used to test the card checks. */
export const PAR = [4, 3, 5, 4, 4, 4, 4, 3, 5, 5, 3, 4, 4, 4, 4, 4, 3, 5];
export const HCP = [6, 10, 4, 8, 16, 2, 14, 18, 12, 13, 17, 15, 7, 3, 11, 5, 9, 1];
export const TEES = {
  BLACK: { rating: 75.0, slope: 146, out: 3436, in: 3638, yards: [421, 183, 536, 457, 271, 458, 360, 162, 588, 543, 165, 434, 360, 436, 441, 430, 220, 609] },
  /* The club's card itself prints IN 3457 for Gold; its holes add up to 3467,
     and the card's TOTAL 6786 agrees with the holes. A real misprint. */
  GOLD: { rating: 71.5, slope: 142, out: 3319, in: 3457, total: 6786, misprintIn: 3467, yards: [412, 177, 522, 446, 262, 435, 344, 157, 564, 490, 157, 409, 343, 422, 428, 416, 207, 595] },
  BLUE: { rating: 71.5, slope: 136, out: 3148, in: 3237, yards: [394, 166, 502, 426, 239, 405, 332, 142, 542, 452, 139, 384, 332, 407, 373, 390, 189, 571] },
  WHITE: { rating: 69.7, slope: 130, out: 2916, in: 3042, yards: [375, 143, 482, 363, 216, 385, 322, 124, 506, 434, 116, 359, 319, 386, 347, 371, 171, 539] },
  /* Red OUT is printed 2529, its holes add up to 2539, and the card's TOTAL
     5225 agrees with 2529: one Red hole is misprinted, and the card cannot
     say which. */
  RED: { rating: 70.8, slope: 124, out: 2529, in: 2696, total: 5225, misprintOut: 2539, yards: [332, 126, 415, 312, 196, 346, 270, 111, 431, 374, 100, 329, 290, 355, 305, 334, 148, 461] },
};
/* A reading as the worker's normalizeScan returns it, for one nine. */
export function reading(nine, { tweak = () => {} } = {}) {
  const holes = nine === "front" ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [10, 11, 12, 13, 14, 15, 16, 17, 18];
  const on = (i) => holes.includes(i + 1);
  const r = {
    course: nine === "front" ? "Royal Ontario Golf Club" : "",
    holesRead: holes,
    parOut: nine === "front" ? 36 : null, parIn: nine === "back" ? 36 : null,
    tees: Object.entries(TEES).map(([name, t]) => ({
      name: nine === "front" ? name : name[0] + name.slice(1).toLowerCase(),
      rating: nine === "front" ? t.rating : null, slope: nine === "front" ? t.slope : null,
      out: nine === "front" ? t.out : null, in: nine === "back" ? t.in : null,
      total: nine === "back" ? (t.total || t.out + t.in) : null,
      holes: PAR.map((p, i) => (on(i) ? { par: p, yards: t.yards[i], si: HCP[i] } : { par: null, yards: null, si: null })),
    })),
  };
  tweak(r);
  return r;
}
