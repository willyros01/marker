/* An in-memory Firestore with the same face as worker/src/firestore.js client(),
 * strict about the things that matter: preconditions (exists / updateTime),
 * all-or-nothing commits, update masks and server-time transforms. */
import { fromFields, FirestoreError } from "../../worker/src/firestore.js";

export function fakeFs(seed = {}) {
  const root = "projects/demo/databases/(default)/documents";
  const docs = new Map();
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 16, 12, 0, 0) + ++tick).toISOString();
  for (const [path, data] of Object.entries(seed)) docs.set(path, { data: structuredClone(data), updateTime: stamp() });

  const asDoc = (path, d) => ({ id: path.split("/").pop(), path, updateTime: d.updateTime, data: structuredClone(d.data) });
  const parentOf = (path) => path.split("/").slice(0, -2).join("/");
  const collOf = (path) => path.split("/").slice(-2, -1)[0];
  const commits = [];

  return {
    root,
    name: (path) => `${root}/${path}`,
    docs,
    commits,
    calls: 0,
    async get(path) { this.calls++; const d = docs.get(path); return d ? asDoc(path, d) : null; },
    async query(parent, collectionId, filters = [], limit = 100) {
      this.calls++;
      const out = [];
      for (const [path, d] of [...docs.entries()].sort((a, b) => a[1].updateTime.localeCompare(b[1].updateTime))) {
        if (parentOf(path) !== parent || collOf(path) !== collectionId) continue;
        if (filters.every(([f, op, v]) => op === "EQUAL" && d.data[f] === v)) out.push(asDoc(path, d));
      }
      return out.slice(0, limit);
    },
    async queryGroup(collectionId, limit = 20000) {
      this.calls++;
      const out = [];
      for (const [path, d] of docs) if (collOf(path) === collectionId) out.push(asDoc(path, d));
      return out.slice(0, limit);
    },
    async commit(writes) {
      this.calls++;
      if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
      const next = new Map(docs);
      const now = stamp();
      for (const w of writes) {
        if (w.delete) {
          const path = w.delete.slice(root.length + 1);
          const cur = next.get(path);
          const pre = w.currentDocument || {};
          if (pre.updateTime && (!cur || cur.updateTime !== pre.updateTime)) throw new FirestoreError(400, "FAILED_PRECONDITION " + path);
          next.delete(path);
          continue;
        }
        const path = w.update.name.slice(root.length + 1);
        const cur = next.get(path);
        const pre = w.currentDocument || {};
        if (pre.exists === false && cur) throw new FirestoreError(409, "ALREADY_EXISTS " + path);
        if (pre.exists === true && !cur) throw new FirestoreError(404, "NOT_FOUND " + path);
        if (pre.updateTime && (!cur || cur.updateTime !== pre.updateTime)) throw new FirestoreError(400, "FAILED_PRECONDITION " + path);
        if (w.updateMask && !cur) throw new FirestoreError(404, "NOT_FOUND " + path);
        const fields = fromFields(w.update.fields);
        const data = w.updateMask ? { ...cur.data, ...fields } : fields;
        for (const t of w.updateTransforms || []) data[t.fieldPath] = now;
        next.set(path, { data, updateTime: now });
      }
      docs.clear();
      for (const [k, v] of next) docs.set(k, v);
      commits.push(writes);
      return {};
    },
    data(path) { const d = docs.get(path); return d ? d.data : null; },
    touch(path, patch) { const d = docs.get(path); docs.set(path, { data: { ...d.data, ...patch }, updateTime: stamp() }); },
  };
}
