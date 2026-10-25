/* fillholes.js — one-time fill-in (Willy, 25 Oct 2026, item 22).
 *
 * Rounds posted by The Marker before 25 Oct have their 18 scores but not each
 * hole's par and stroke index. This adds holePar and holeSi to each of them,
 * from the tee frozen on its card when it was posted (postedTee) — never from
 * today's course list, which may have been corrected since.
 *
 * Only adds the two fields. One commit per round, refused if the round
 * changed since it was read. A round is skipped (and reported) when it is
 * gone, already has them, belongs to another card, or its card has no frozen
 * tee with 18 holes. dry: reads and reports only, writes nothing. */
import * as card from "../../card.js";
import { updateWrite } from "./firestore.js";
import { STATUS, checkTee } from "./post.js";

export async function fillHoles(fs, { go = false, log = () => {} } = {}) {
  const subs = await fs.query("", "markerSubmissions", [["status", "EQUAL", STATUS.POSTED]], 5000);
  const out = { cards: subs.length, filled: 0, already: 0, gone: 0, otherCard: 0, noTee: 0, changed: 0 };
  for (const sub of subs) {
    const c = sub.data.card || {};
    let frozen = null;
    try { frozen = sub.data.postedTee ? card.frozenHoles(checkTee(sub.data.postedTee)) : null; } catch { frozen = null; }
    const rounds = sub.data.rounds || {};
    for (const p of c.players || []) {
      const rid = rounds[p.golferId];
      if (!rid) continue;
      const r = await fs.get(`associations/${p.assocId}/rounds/${rid}`);
      const who = `${c.date || "?"} ${(c.course && c.course.name) || "?"} — ${p.name || p.golferId}`;
      if (!r) { out.gone++; log(`gone      ${who}`); continue; }
      if (Array.isArray(r.data.holePar)) { out.already++; continue; }
      if (r.data.cardId !== sub.id) { out.otherCard++; log(`otherCard ${who}`); continue; }
      if (!frozen) { out.noTee++; log(`noTee     ${who}`); continue; }
      if (!go) { out.filled++; log(`would fill ${who}`); continue; }
      try {
        await fs.commit([updateWrite(fs, r.path, { holePar: frozen.holePar, holeSi: frozen.holeSi }, { updateTime: r.updateTime })]);
        out.filled++; log(`filled    ${who}`);
      } catch (e) {
        out.changed++; log(`changed   ${who} (${e.message})`);
      }
    }
  }
  return out;
}
