/* firestore.js — the little of Firestore's REST API the worker needs.
 *
 * Works the same in a Cloudflare Worker, in Node and against the emulator:
 * give it the project, a function that returns an access token, and (for
 * tests) another base address. Nothing here knows about golf.
 */

export function fromValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("referenceValue" in v) return v.referenceValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromValue);
  if ("mapValue" in v) return fromFields(v.mapValue.fields || {});
  return null;
}
export const fromFields = (fields) =>
  Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, fromValue(v)]));

export function toValue(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === "boolean") return { booleanValue: x };
  if (typeof x === "number") return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (typeof x === "string") return { stringValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(toValue) } };
  return { mapValue: { fields: toFields(x) } };
}
export const toFields = (o) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, toValue(v)]));

/* Field names in an update mask need back-quotes unless they are plain. */
const fieldPath = (k) => (/^[A-Za-z_][A-Za-z_0-9]*$/.test(k) ? k : "`" + k.replace(/[`\\]/g, "\\$&") + "`");

export class FirestoreError extends Error {
  constructor(status, body) {
    super(`Firestore ${status}: ${String(body).slice(0, 300)}`);
    this.status = status;
    this.conflict = status === 409 || /FAILED_PRECONDITION|ABORTED|ALREADY_EXISTS/.test(String(body));
    this.notFound = status === 404 || /NOT_FOUND/.test(String(body));
  }
}

export function client({ project, token, base = "https://firestore.googleapis.com/v1", fetchFn = (...a) => fetch(...a) }) {
  const root = `projects/${project}/databases/(default)/documents`;
  const name = (path) => `${root}/${path}`;

  async function call(method, url, body) {
    const t = await token();
    const res = await fetchFn(url, {
      method,
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new FirestoreError(res.status, text);
    return text ? JSON.parse(text) : {};
  }

  const asDoc = (d) => ({ id: d.name.split("/").pop(), path: d.name.slice(root.length + 1), updateTime: d.updateTime, data: fromFields(d.fields) });

  return {
    root,
    name,

    /* One document, or null when it is not there. */
    async get(path) {
      try { return asDoc(await call("GET", `${base}/${name(path)}`)); }
      catch (e) { if (e.notFound) return null; throw e; }
    },

    /* Documents of one collection under `parent` ("" for the top) matching
       every [field, op, value] filter. */
    async query(parent, collectionId, filters = [], limit = 100) {
      const where = filters.length === 0 ? undefined
        : filters.length === 1 ? { fieldFilter: f(filters[0]) }
        : { compositeFilter: { op: "AND", filters: filters.map((x) => ({ fieldFilter: f(x) })) } };
      const rows = await call("POST", `${base}/${root}${parent ? "/" + parent : ""}:runQuery`, {
        structuredQuery: { from: [{ collectionId }], ...(where ? { where } : {}), limit },
      });
      return rows.filter((r) => r.document).map((r) => asDoc(r.document));
    },

    /* Every collection named `collectionId`, at any depth (a collection-group
       read), unfiltered. Used by the daily golfer clean-up. */
    async queryGroup(collectionId, limit = 20000) {
      const rows = await call("POST", `${base}/${root}:runQuery`, {
        structuredQuery: { from: [{ collectionId, allDescendants: true }], limit },
      });
      return rows.filter((r) => r.document).map((r) => asDoc(r.document));
    },

    /* Every write in one go: all happen or none do. */
    async commit(writes) {
      return call("POST", `${base}/${root}:commit`, { writes });
    },
  };
}

const f = ([field, op, value]) => ({ field: { fieldPath: field }, op, value: toValue(value) });

/* ---- write builders for commit() ----
 *   set:    the whole document becomes `data`.
 *   update: only the named fields change (mask = Object.keys(data)).
 * Options: exists (true/false), updateTime (unchanged since read),
 *          now: [field names set to the server's time]. */
export function setWrite(fs, path, data, opts = {}) { return write(fs, path, data, opts, false); }
export function updateWrite(fs, path, data, opts = {}) { return write(fs, path, data, opts, true); }
/* delete: the document goes, only if unchanged since it was read (updateTime). */
export function deleteWrite(fs, path, { updateTime = null } = {}) {
  const w = { delete: fs.name(path) };
  if (updateTime) w.currentDocument = { updateTime };
  return w;
}

function write(fs, path, data, { exists = null, updateTime = null, now = [] }, masked) {
  const w = { update: { name: fs.name(path), fields: toFields(data) } };
  if (masked) w.updateMask = { fieldPaths: Object.keys(data).map(fieldPath) };
  if (updateTime) w.currentDocument = { updateTime };
  else if (exists !== null) w.currentDocument = { exists };
  if (now.length) w.updateTransforms = now.map((k) => ({ fieldPath: fieldPath(k), setToServerValue: "REQUEST_TIME" }));
  return w;
}
