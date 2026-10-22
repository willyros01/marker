/* cleanup.js — the daily golfer clean-up (Willy, 22 Oct 2026, 6:12 pm):
 * "any new golfer with no scorecard and no group and no linked email should be
 * deleted (after 7 days)".
 *
 * Run once a day by Cloudflare's scheduler (wrangler.toml, triggers.crons).
 * A golfer is UNUSED when ALL of these hold:
 *   - no linked account (linkedUid),
 *   - on no group's roster,
 *   - no round anywhere names them, and their own record shows no rounds,
 *   - no member, game or Marker card names them.
 * An unused golfer is first noted with the time it was seen unused. Only when
 * it has stayed unused for WAIT_DAYS (so a round still waiting on an offline
 * phone has time to arrive) is it deleted, together with its name claim,
 * its directory entries and any block pointing at it, in ONE commit per
 * golfer, guarded by every document's updateTime: if anything about that
 * golfer changed since it was read, nothing of it is deleted and it is
 * looked at again the next day. A golfer used again is dropped from the list.
 *
 * Every run writes maintenance/golferCleanup: when it ran, how many golfers it
 * checked, which it deleted, which are waiting and since when. A missed or late
 * run does no harm: the next run catches up.
 */
import { deleteWrite, setWrite } from "./firestore.js";

export const WAIT_DAYS = 7;
export const STATE = "maintenance/golferCleanup";
const DAY = 24 * 60 * 60 * 1000;

const names = (doc, id) => JSON.stringify(doc.data || {}).includes(`"${id}"`);

export async function cleanGolfers(fs, { now = Date.now(), max = 10, log = () => {} } = {}) {
  /* Read everything first. If any read fails the run stops here: nothing deleted. */
  const [allGolfers, rounds, rosters, members, games, cards, directory, claims, state] = await Promise.all([
    fs.queryGroup("golfers"), fs.queryGroup("rounds"), fs.queryGroup("roster"), fs.queryGroup("members"),
    fs.queryGroup("games"), fs.query("", "markerSubmissions", [], 5000), fs.queryGroup("directory"),
    fs.query("", "golferNames", [], 5000), fs.get(STATE),
  ]);
  const golfers = allGolfers.filter((g) => g.path === `golfers/${g.id}`);
  const blocks = allGolfers.filter((g) => g.path.startsWith("userBlocks/"));
  const before = (state && state.data && state.data.pending) || {};

  const unused = (g) => {
    const d = g.data || {};
    if (d.linkedUid) return false;
    if (Number(d.roundCount) > 0 || (Array.isArray(d.recentWindow) && d.recentWindow.length)) return false;
    if (rosters.some((r) => r.id === g.id || (r.data && r.data.golferId === g.id))) return false;
    for (const list of [rounds, members, games, cards]) if (list.some((x) => names(x, g.id))) return false;
    return true;
  };

  const pending = {};
  const due = [];
  for (const g of golfers) {
    if (!unused(g)) continue;
    const since = Number(before[g.id]) || now;
    pending[g.id] = since;
    if (now - since >= WAIT_DAYS * DAY) due.push(g);
  }

  const deleted = [], kept = [];
  for (const g of due.slice(0, max)) {
    const extra = [
      ...claims.filter((c) => c.data && c.data.golferId === g.id),
      ...directory.filter((x) => x.id === g.id),
      ...blocks.filter((x) => x.id === g.id),
    ];
    try {
      await fs.commit([g, ...extra].map((x) => deleteWrite(fs, x.path, { updateTime: x.updateTime })));
      delete pending[g.id];
      deleted.push(g.data.name || g.id);
    } catch (e) {
      kept.push(g.data.name || g.id);          /* changed since it was read: next run looks again */
      log(`kept ${g.id}: ${e && e.message}`);
    }
  }

  const record = {
    lastRun: new Date(now).toISOString(),
    checked: golfers.length,
    deleted,
    keptBecauseChanged: kept,
    waiting: Object.keys(pending).length,
    pending,
  };
  await fs.commit([setWrite(fs, STATE, record)]);
  return record;
}
