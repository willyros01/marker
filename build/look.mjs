/* look.mjs — READ ONLY (second look, 18 Oct 2026). Nothing is written. */
import { client } from "../worker/src/firestore.js";
const fs = client({ project: process.env.PROJECT, token: async () => process.env.TOKEN });
const say = (s) => console.log(s);
const lv = await fs.get("courses/mvdak5q2dikg2u");
say("Lakeview course fields: " + Object.keys(lv.data).sort().join(", ") + " | id field: " + JSON.stringify(lv.data.id));
const ro = await fs.get("courses/v1-course-0ya4t98r");
say("Royal Ontario course fields: " + Object.keys(ro.data).sort().join(", ") + " | id field: " + JSON.stringify(ro.data.id));
const courses = await fs.query("", "courses", [], 1000);
say("Courses without an id field: " + courses.filter((c) => c.data.id !== c.id).map((c) => `${c.id} "${c.data.name}" (id field ${JSON.stringify(c.data.id)})`).join("; "));
const A = "associations/mss0iqvqder7g2";
const inGame = await fs.query(A, "rounds", [["gameId", "EQUAL", "msngo2mu2yqef3"]], 500);
const dates = inGame.map((r) => r.data.date).sort();
say(`Rounds with gameId msngo2mu2yqef3: ${inGame.length}, dates ${dates[0]} to ${dates[dates.length - 1]}`);
say("That game document exists: " + !!(await fs.get(`${A}/games/msngo2mu2yqef3`)));
const viaMarker = await fs.query(A, "rounds", [["enteredVia", "EQUAL", "marker"]], 100);
say("Rounds entered by The Marker in Golfing Buddies: " + viaMarker.map((r) => `${r.data.date} course=${r.data.courseId} game=${r.data.gameId || "-"}`).join("; "));
