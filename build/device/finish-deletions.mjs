/* Runs the helper's deletion job (worker/src/deletions.js) once, against the
 * Firebase EMULATORS used by the device tests, as the helper does every 5
 * minutes. Every request counts as older than 5 minutes. Prints the job's log. */
import { client } from "../../worker/src/firestore.js";
import { finishDeletions, authAdmin } from "../../worker/src/deletions.js";

const P = "demo-scorecard";
const fs = client({ project: P, token: async () => "owner", base: "http://127.0.0.1:8080/v1" });
const auth = authAdmin({ project: P, token: async () => "owner", base: "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1" });
const r = await finishDeletions(fs, auth, { now: Date.now() + 10 * 60 * 1000, log: (l) => console.log(l) });
console.log("Summary:", JSON.stringify(r));
process.exit(r.failed ? 1 : 0);
