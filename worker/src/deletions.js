/* deletions.js — finishes "Delete my account" (Willy, 13 Nov 2026).
 *
 * Moved here from The Scorecard's GitHub job (.github/scripts/finish-deletions.sh),
 * whose timer GitHub runs only every few hours. This runs every 5 minutes with
 * the card sweep (index.js), one deletion per run (Cloudflare's free plan
 * allows 50 calls per run; one deletion takes about 20).
 *
 * For each request accountDeletions/{uid} older than 5 minutes (the app has
 * finished or stopped by then):
 *   1. an account that owns a group: nothing is deleted, the request is marked
 *      "blocked-owns-groups";
 *   2. its memberships, invitation claims and group list go;
 *   3. its golfer is unlinked;
 *   4. the Public group: a golfer who plays ONLY there is deleted for good —
 *      golfer, name, rounds, list place, ranking entry — in one commit together
 *      with a backup (deletionBackups/, 30 days; rgf.txt restores it); a golfer
 *      who also plays in a club is only taken off the Public list;
 *   5. old version-1 data under users/{uid}, and its email entry, go;
 *   6. the sign-in is deleted if still there, and confirmed gone with Firebase;
 *      only then is the request removed.
 *
 * SAFEGUARDS (as in the GitHub job): the request is written by the person and
 * this runs with full rights, so nothing in it is trusted. The account comes
 * only from the document's path; groups, memberships, invitations and golfers
 * are found in the database. The request's golfer list is only a hint for
 * step 4, and a hinted golfer counts only if the app unlinked it in the same
 * commit that set the request to "auth-deleting" (both then carry the very
 * same update time; the rules allow a deleting account no other golfer change).
 * Every delete requires the document to be unchanged since it was read. A
 * failed read stops that request; it is tried again in 5 minutes.
 */
import { deleteWrite, setWrite, updateWrite } from "./firestore.js";

export const MIN_AGE_MS = 5 * 60 * 1000;
export const BACKUP_DAYS = 30;
export const PUBLIC = "PUBLIC";
export const STATE = "maintenance/deletionJob";
const DAY = 24 * 60 * 60 * 1000;
const UID = /^[A-Za-z0-9]{1,128}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const NAME_KEY = /^[a-z0-9-]{1,200}$/;
const mask = (s) => `${String(s).slice(0, 4)}…`;

/* Firebase Authentication, as an administrator (the helper's own account). */
export function authAdmin({ project, token, base = "https://identitytoolkit.googleapis.com/v1", fetchFn = (...a) => fetch(...a) }) {
  async function call(what, body) {
    const res = await fetchFn(`${base}/projects/${project}/accounts:${what}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Firebase Authentication ${what} failed (${res.status}) ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }
  return {
    /* { exists, email }. A failed lookup throws: never taken as "gone". */
    async lookup(uid) {
      const r = await call("lookup", { localId: [uid] });
      const u = (r.users || [])[0];
      return { exists: !!u, email: (u && u.email) || "" };
    },
    async remove(uid) { await call("delete", { localId: uid }); },
  };
}

/* A raw document kept for the backup: its path and its fields, types untouched. */
const keep = (fs, d) => d ? { mapValue: { fields: { path: { stringValue: d.name.slice(fs.root.length + 1) }, data: { mapValue: { fields: d.fields || {} } } } } } : { nullValue: null };
const goneRaw = (d) => d ? [{ delete: d.name, currentDocument: { updateTime: d.updateTime } }] : [];

/* Step 4 for one golfer. Returns a line for the log. */
async function publicCleanup(fs, uid, g, groups, now) {
  const m = mask(uid);
  const [roster] = await fs.getMany([`associations/${PUBLIC}/roster/${g}`]);
  if (!roster) return null;
  const others = groups.filter((gid) => gid !== PUBLIC);
  const otherRosters = others.length ? (await fs.getMany(others.map((gid) => `associations/${gid}/roster/${g}`))).filter(Boolean) : [];
  /* Every round anywhere that names this golfer (one read of all rounds,
     as the daily clean-up does): a round in a club keeps the golfer. */
  const rounds = otherRosters.length ? [] : (await fs.queryGroup("rounds")).filter((r) => r.path.startsWith("associations/") && r.data && r.data.golferId === g);
  const elsewhere = otherRosters.length || rounds.some((r) => !r.path.startsWith(`associations/${PUBLIC}/`));
  if (elsewhere) {
    await fs.commit([deleteWrite(fs, `associations/${PUBLIC}/roster/${g}`), deleteWrite(fs, `associations/${PUBLIC}/directory/${g}`)]);
    return `PUBLIC ${m}: golfer ${mask(g)} taken off the Public group's list; golfer and rounds kept (also plays in another group).`;
  }
  const [golfer, rosterRaw, directory, invitation] = await fs.getRaw([
    `golfers/${g}`, `associations/${PUBLIC}/roster/${g}`, `associations/${PUBLIC}/directory/${g}`, `associations/${PUBLIC}/invitations/${g}`,
  ]);
  if (!golfer) return null;
  const nk = golfer.fields && golfer.fields.nameKey && golfer.fields.nameKey.stringValue;
  let claim = null;
  if (nk && NAME_KEY.test(nk)) {
    [claim] = await fs.getRaw([`golferNames/${nk}`]);
    if (!(claim && claim.fields && claim.fields.golferId && claim.fields.golferId.stringValue === g)) claim = null;
  }
  const roundsRaw = rounds.length ? (await fs.getRaw(rounds.map((r) => r.path))).filter(Boolean) : [];
  if (roundsRaw.length > 450) return `PUBLIC ${m}: golfer ${mask(g)} has more than 450 Public rounds; kept, for a person to look at.`;
  const backup = {
    update: {
      name: fs.name(`deletionBackups/${g}-${Math.floor(now / 1000)}`),
      fields: {
        golferId: { stringValue: g }, groupId: { stringValue: PUBLIC },
        deletedAt: { timestampValue: new Date(now).toISOString() },
        expiresAt: { timestampValue: new Date(now + BACKUP_DAYS * DAY).toISOString() },
        golfer: keep(fs, golfer), roster: keep(fs, rosterRaw), directory: keep(fs, directory),
        invitation: keep(fs, invitation), nameClaim: keep(fs, claim),
        rounds: { arrayValue: { values: roundsRaw.map((r) => keep(fs, r)) } },
      },
    },
    currentDocument: { exists: false },
  };
  const writes = [backup, ...goneRaw(golfer), ...goneRaw(rosterRaw), ...goneRaw(directory), ...goneRaw(invitation), ...goneRaw(claim), ...roundsRaw.flatMap(goneRaw)];
  if (JSON.stringify(writes).length > 900000) return `PUBLIC ${m}: golfer ${mask(g)} is too large to back up in one record; kept, for a person to look at.`;
  await fs.commit(writes);
  return `PUBLIC ${m}: golfer ${mask(g)} deleted from the Public group for good (${roundsRaw.length} rounds); backup kept ${BACKUP_DAYS} days.`;
}

/* One request. Returns "done" | "blocked" | "not-confirmed". Throws on any failure. */
async function finishOne(fs, auth, req, { now, log }) {
  const uid = req.id, m = mask(uid);

  /* 1. Ownership, straight from the database. */
  const owned = await fs.query("", "associations", [["ownerUid", "EQUAL", uid]], 50);
  if (owned.length) {
    if ((req.data && req.data.jobStatus) !== "blocked-owns-groups") {
      await fs.commit([updateWrite(fs, `accountDeletions/${uid}`, { jobStatus: "blocked-owns-groups", jobCheckedAt: new Date(now).toISOString() }, { exists: true })]);
      log(`BLOCKED ${m}: owns ${owned.length} group(s). Nothing deleted. The owner must delete those groups first.`);
    }
    return "blocked";
  }

  /* 2. Memberships, invitation claims and the group list. */
  const [groupsAll, members, invites, pointers] = await Promise.all([
    fs.query("", "associations", [], 5000),
    fs.queryGroup("members"),
    fs.queryGroup("invites"),
    fs.query(`userGroups/${uid}`, "groups", [], 500),
  ]);
  const groups = groupsAll.map((a) => a.id);
  const leave = [
    ...members.filter((d) => d.path.startsWith("associations/") && d.path.endsWith(`/members/${uid}`)),
    ...invites.filter((d) => d.path.startsWith("associations/") && d.data && d.data.acceptedBy === uid),
  ].map((d) => deleteWrite(fs, d.path, { updateTime: d.updateTime }));
  const ptrs = pointers.map((d) => deleteWrite(fs, d.path));
  if (leave.length + ptrs.length) {
    await fs.commit([...leave, ...ptrs]);
    log(`OK ${m}: left ${leave.length} membership/invitation record(s); ${ptrs.length} group pointer(s) removed.`);
  }

  /* 3. Golfers still linked: unlinked, only if unchanged since read. */
  const linked = (await fs.query("", "golfers", [["linkedUid", "EQUAL", uid]], 50)).filter((d) => d.data && d.data.linkedUid === uid);
  if (linked.length) await fs.commit(linked.map((d) => updateWrite(fs, d.path, { linkedUid: null }, { updateTime: d.updateTime })));

  /* 4. The Public group: the account's golfers, proven (see the top). */
  const mine = new Set(linked.map((d) => d.id));
  const hints = Array.isArray(req.data && req.data.golferIds) ? req.data.golferIds.filter((g) => typeof g === "string" && ID.test(g)).slice(0, 5) : [];
  if (req.data && req.data.stage === "auth-deleting" && hints.length) {
    for (const d of (await fs.getMany(hints.map((g) => `golfers/${g}`))).filter(Boolean)) {
      if (d.updateTime === req.updateTime && !(d.data && d.data.linkedUid)) mine.add(d.id);
    }
  }
  for (const g of mine) { const line = await publicCleanup(fs, uid, g, groups, now); if (line) log(line); }

  /* 5. Version-1 data under the account's own path, and its email entry. */
  for (const col of await fs.listCollectionIds(`users/${uid}`)) {
    const docs = await fs.query(`users/${uid}`, col, [], 500);
    if (docs.length) await fs.commit(docs.map((d) => deleteWrite(fs, d.path)));
  }
  await fs.commit([deleteWrite(fs, `users/${uid}`)]);
  const before = await auth.lookup(uid);
  const key = before.email.trim().toLowerCase();
  if (key && !key.includes("/")) await fs.commit([deleteWrite(fs, `accountEmails/${key}`)]);

  /* 6. The sign-in, then independent confirmation, then (only then) the request. */
  if (before.exists) await auth.remove(uid);
  if ((await auth.lookup(uid)).exists) {
    await fs.commit([updateWrite(fs, `accountDeletions/${uid}`, { jobStatus: "auth-not-confirmed", jobCheckedAt: new Date(now).toISOString() }, { exists: true })]);
    log(`NOT CONFIRMED ${m}: Firebase still has the account. Request kept; it will be retried.`);
    return "not-confirmed";
  }
  await fs.commit([deleteWrite(fs, `accountDeletions/${uid}`)]);
  log(`DONE ${m}: account confirmed gone; request removed.`);
  return "done";
}

/* Every 5 minutes. At most `max` requests are worked on (blocked ones cost
   one read and are skipped quickly). Records when it ran in maintenance/deletionJob. */
export async function finishDeletions(fs, auth, { now = Date.now(), max = 1, log = () => {} } = {}) {
  const reqs = (await fs.query("", "accountDeletions", [], 200))
    .filter((r) => UID.test(r.id))
    .sort((a, b) => String(a.createTime).localeCompare(String(b.createTime)));
  const out = { requests: reqs.length, done: 0, blocked: 0, waiting: 0, failed: 0, notConfirmed: 0 };
  let worked = 0;
  for (const r of reqs) {
    if (now - Date.parse(r.createTime) < MIN_AGE_MS) { out.waiting++; continue; }
    if (worked >= max && (r.data && r.data.jobStatus) !== "blocked-owns-groups") { out.waiting++; continue; }
    try {
      const res = await finishOne(fs, auth, r, { now, log });
      if (res === "blocked") out.blocked++;
      else { worked++; if (res === "done") out.done++; else out.notConfirmed++; }
    } catch (e) {
      worked++; out.failed++;
      log(`FAILED ${mask(r.id)}: ${String((e && e.message) || e).slice(0, 200)}; tried again in 5 minutes.`);
    }
  }
  await fs.commit([setWrite(fs, STATE, { lastRun: new Date(now).toISOString(), ...out })]);
  return out;
}

/* Once a day: backups older than 30 days are removed for good. */
export async function purgeBackups(fs, { now = Date.now(), log = () => {} } = {}) {
  const all = await fs.query("", "deletionBackups", [], 1000);
  const old = all.filter((d) => d.data && d.data.expiresAt && Date.parse(d.data.expiresAt) < now);
  if (old.length) {
    await fs.commit(old.map((d) => deleteWrite(fs, d.path, { updateTime: d.updateTime })));
    log(`Removed ${old.length} Public backup(s) older than ${BACKUP_DAYS} days.`);
  }
  return { removed: old.length };
}
