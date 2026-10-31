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

/* For an outside watchdog (cron-job.org, Willy 22 Oct 2026): healthy when the
 * last run is under 48 hours old. Read-only; shows no names. */
export const STALE_HOURS = 48;
export async function cleanupStatus(fs, { now = Date.now() } = {}) {
  const st = await fs.get(STATE);
  const last = st && st.data && Date.parse(st.data.lastRun);
  if (!last) return { ok: false, why: "the daily clean-up has not run yet" };
  const hoursAgo = Math.round((now - last) / 36e5);
  return {
    ok: hoursAgo < STALE_HOURS,
    lastRun: st.data.lastRun,
    hoursAgo,
    deletedLastRun: (st.data.deleted || []).length,
    waiting: Number(st.data.waiting) || 0,
    ...(hoursAgo < STALE_HOURS ? {} : { why: `the daily clean-up last ran ${hoursAgo} hours ago` }),
  };
}

/* Old live cards (Willy, 30 Oct 2026, "do 2"): the copy of a card made for
 * followers or a caddie (markerLive/{id}) stops working after 12 hours but was
 * kept for ever. Once a day, every live card whose codes stopped working more
 * than LIVE_DAYS ago is deleted together with its follow and caddie codes, in
 * ONE commit per card, guarded by each document's updateTime: if anything of
 * it changed since it was read, nothing of it is deleted and the next run
 * looks again. Posted rounds never depend on live cards. */
export const LIVE_DAYS = 30;
export const LIVE_STATE = "maintenance/liveCardCleanup";

export async function cleanLiveCards(fs, { now = Date.now(), max = 200, log = () => {} } = {}) {
  const cards = await fs.query("", "markerLive", [], 5000);
  const ended = (d) => Number(d.expiresAt) || Number(d.createdAt) || 0;
  const due = cards.filter((c) => {
    const t = ended(c.data || {});
    return t > 0 && now - t >= LIVE_DAYS * DAY;
  });

  let deleted = 0, kept = 0;
  for (const c of due.slice(0, max)) {
    try {
      const codes = [];
      if (c.data.code) codes.push(`markerCaddieCodes/${c.data.code}`);
      if (c.data.followCode) codes.push(`markerFollowCodes/${c.data.followCode}`);
      const found = (await Promise.all(codes.map((p) => fs.get(p))))
        .filter((x) => x && x.data && x.data.liveId === c.id);        /* only codes pointing at this card */
      await fs.commit([c, ...found].map((x) => deleteWrite(fs, x.path, { updateTime: x.updateTime })));
      deleted++;
    } catch (e) {
      kept++;                                   /* changed since it was read: next run looks again */
      log(`kept live card ${c.id}: ${e && e.message}`);
    }
  }

  const record = {
    lastRun: new Date(now).toISOString(),
    checked: cards.length,
    deleted,
    keptBecauseChanged: kept,
    waitingForNextRun: Math.max(due.length - max, 0),
  };
  await fs.commit([setWrite(fs, LIVE_STATE, record)]);
  return record;
}
