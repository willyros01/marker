/* The Marker — index job.
 *
 * A regular member may post a foursome's rounds through The Marker, but may
 * not read or change the other golfers' records (Willy's privacy rule). So
 * the handicap indexes are brought up to date here, with the service
 * account, for every card still marked indexPending.
 *
 * For each golfer on a card it does what The Scorecard's own rebuild does
 * (store.js rebuildGolferIndex), across every group it can scan:
 *   - reads the golfer's rounds in each of their groups (archived ones left out);
 *   - keeps window entries from groups it did not scan, exactly as they are;
 *   - writes the new 20-round window, the index and the round count, only if
 *     the golfer has not changed since it was read (otherwise next run);
 *   - updates the golfer's directory entry in those groups (name and index
 *     only, as The Scorecard publishes it);
 * then marks the card done. Nothing is ever deleted.
 *
 * Settings (environment): ACCESS_TOKEN (required), PROJECT (scorecard-f41b8),
 * FS_BASE (https://firestore.googleapis.com/v1), DRY_RUN=1 to change nothing.
 */
import * as model from "../../model.js";

const PROJECT = process.env.PROJECT || "scorecard-f41b8";
const FS_BASE = process.env.FS_BASE || "https://firestore.googleapis.com/v1";
const TOKEN = process.env.ACCESS_TOKEN;
const DRY = process.env.DRY_RUN === "1";

const ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const mask = (id) => String(id).slice(0, 4) + "…";

/* ---------------- Firestore REST values ---------------- */

export function fromValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromValue);
  if ("mapValue" in v) return fromFields(v.mapValue.fields || {});
  return null;
}
export const fromFields = (fields) => Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, fromValue(v)]));

export function toValue(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === "boolean") return { booleanValue: x };
  if (typeof x === "number") return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (typeof x === "string") return { stringValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(toValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, toValue(v)])) } };
}

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) { const e = new Error(`${method} ${res.status}: ${text.slice(0, 300)}`); e.status = res.status; throw e; }
  return text ? JSON.parse(text) : {};
}

async function getDoc(path) {
  try { return await call("GET", `${FS_BASE}/${ROOT}/${path}`); }
  catch (e) { if (e.status === 404) return null; throw e; }
}

async function query(parent, collectionId, field, op, value, limit = 500) {
  const url = `${FS_BASE}/${ROOT}${parent ? "/" + parent : ""}:runQuery`;
  const rows = await call("POST", url, { structuredQuery: {
    from: [{ collectionId }],
    where: { fieldFilter: { field: { fieldPath: field }, op, value: toValue(value) } },
    limit,
  } });
  return rows.filter((r) => r.document).map((r) => r.document);
}

async function patch(path, data, { exists = null, updateTime = null } = {}) {
  const params = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`);
  if (updateTime) params.push(`currentDocument.updateTime=${encodeURIComponent(updateTime)}`);
  else if (exists !== null) params.push(`currentDocument.exists=${exists}`);
  const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toValue(v)]));
  if (DRY) { log("DRY RUN, would update", path.replace(/\/[^/]+$/, "/…"), Object.keys(data).join(", ")); return; }
  return call("PATCH", `${FS_BASE}/${ROOT}/${path}?${params.join("&")}`, { fields });
}

/* ---------------- the rebuild ---------------- */

/* The new window for a golfer, from the rounds read in `scanned` groups and
   the entries kept from groups not scanned. Same rules as The Scorecard. */
export function rebuild(golfer, roundsByGroup) {
  const scanned = new Set(Object.keys(roundsByGroup));
  const kept = (golfer.recentWindow || []).filter((e) => e && e.assocId && !scanned.has(e.assocId));
  const fresh = [];
  for (const [assocId, rounds] of Object.entries(roundsByGroup)) {
    for (const r of rounds) {
      if (r.archived) continue;
      if (typeof r.date !== "string" || r.date.length < 10) continue;
      if (r.differential == null || !Number.isFinite(Number(r.differential))) continue;
      fresh.push({ roundId: r.id, date: r.date, differential: Number(r.differential), assocId });
    }
  }
  fresh.sort((a, b) => b.date.localeCompare(a.date) || String(b.roundId).localeCompare(String(a.roundId)));
  const top = fresh.slice(0, 20);
  const window = model.mergeWindow(kept, top);
  return {
    recentWindow: window,
    handicapIndex: model.displayIndex(window),
    roundCount: top.length + kept.length,
    directoryIndex: model.effectiveIndex({ ...golfer, recentWindow: window }).index,
  };
}

async function applyGolfer(golferId, cardGroups) {
  const docu = await getDoc(`golfers/${golferId}`);
  if (!docu) { log("golfer", mask(golferId), "not found; skipped"); return true; }
  const golfer = fromFields(docu.fields);
  const groups = [...new Set([...(golfer.groups || []), ...cardGroups].filter((g) => typeof g === "string" && g))];
  const roundsByGroup = {};
  for (const g of groups) {
    const docs = await query(`associations/${g}`, "rounds", "golferId", "EQUAL", golferId);
    roundsByGroup[g] = docs.map((d) => ({ ...fromFields(d.fields), id: d.name.split("/").pop() }));
  }
  const next = rebuild(golfer, roundsByGroup);
  try {
    await patch(`golfers/${golferId}`, {
      recentWindow: next.recentWindow, handicapIndex: next.handicapIndex, roundCount: next.roundCount,
    }, { updateTime: docu.updateTime });
  } catch (e) {
    if (e.status === 400 || e.status === 409 || e.status === 412 || /FAILED_PRECONDITION/.test(e.message)) {
      log("golfer", mask(golferId), "changed while being read; left for the next run");
      return false;
    }
    throw e;
  }
  for (const g of groups) {
    const entry = await getDoc(`associations/${g}/directory/${golferId}`);
    if (!entry) continue;
    await patch(`associations/${g}/directory/${golferId}`, { handicapIndex: next.directoryIndex }, { exists: true });
  }
  log("golfer", mask(golferId), "index", next.handicapIndex, "from", next.recentWindow.length, "rounds");
  return true;
}

async function main() {
  if (!TOKEN) throw new Error("ACCESS_TOKEN is required");
  const cards = await query("", "cards", "indexPending", "EQUAL", true, 50);
  log(`${cards.length} card(s) waiting`);
  let done = 0, left = 0;
  for (const d of cards) {
    const id = d.name.split("/").pop();
    const c = fromFields(d.fields);
    const groupOf = c.groupOf || {};
    let ok = true;
    for (const g of c.golferIds || []) {
      try { ok = (await applyGolfer(g, [groupOf[g]])) && ok; }
      catch (e) { ok = false; log("golfer", mask(g), "failed:", e.message); }
    }
    if (!ok) { left++; continue; }
    await patch(`cards/${id}`, { indexPending: false, indexAppliedAt: new Date().toISOString() }, { exists: true });
    log("card", mask(id), "done");
    done++;
  }
  log(`finished: ${done} done, ${left} left for the next run`);
  if (left && !done) process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
}
