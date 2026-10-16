/* app.js — The Marker's screens.
 *
 * One function per screen, each returning HTML; one click handler for the
 * whole page (data-act). Every score is saved on the phone the moment it is
 * entered, checked by reading it back, before the screen moves on.
 */
import * as card from "./card.js";
import * as courses from "./courses.js";
import * as local from "./storage.js";
import * as db from "./store.js";
import * as W from "./withdrawn.js";

const VERSION = self.APP_VERSION || "dev";
const app = document.getElementById("app");

/* ---------------- state ---------------- */

const S = {
  screen: "start",
  busy: "",
  flash: "",               /* a message shown once at the top of the body */
  error: "",
  /* setting up a round */
  setup: null,             /* { date, course, tee, holes, start, entry, game } */
  groups: [], groupTab: "", golfers: {}, games: [],
  picked: [],              /* players chosen: { name, golferId, assocId, groupName, index } */
  guestName: "",
  /* course choice */
  cs: { query: "", results: [], library: [], error: "", manual: null, withdrawn: [], scan: null },
  /* play */
  typing: false, typed: "", typeError: "",
  view: null,              /* a finished card being looked at */
  share: null,             /* text for the share screen */
};

const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const shiftDate = (iso, days) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const niceDate = (iso) => { try { return new Date(iso + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); } catch { return iso; } };
const first = (name) => String(name || "").split(" ")[0];
const user = () => db.currentUser();
const member = () => !!(user() && !user().anonymous);

function go(screen) { S.screen = screen; S.error = ""; render(); window.scrollTo(0, 0); }
function fail(e) { S.busy = ""; S.error = String((e && e.message) || e); render(); }

/* Saving the card being played. Throws if the phone would not keep it. */
function saveCard(c) {
  local.saveCurrent(c);
  return c;
}

/* ---------------- shared pieces ---------------- */

function top(title, sub = "", right = "") {
  return `<header class="top"><div class="row"><div class="sub">${esc(sub)}</div><div class="row">${right}</div></div>
    <div class="title">${esc(title)}</div></header>`;
}
const banner = () => (S.error ? `<div class="banner bad" role="alert">${esc(S.error)}</div>` : "")
  + (S.flash ? `<div class="banner ok">${esc(S.flash)}</div>` : "");
const netPill = () => {
  const waiting = db.waitingToPost();
  if (navigator.onLine === false) return `<span class="pill">No signal${waiting ? ` · ${waiting} waiting` : ""}</span>`;
  return waiting ? `<span class="pill">${waiting} waiting to post</span>` : "";
};

/* ---------------- 0 · start ---------------- */

function screenStart() {
  const cur = local.currentCard();
  const u = user();
  const cards = local.finishedCards();
  const resume = cur && (cur.state === "playing" || cur.state === "finished")
    ? `<button class="btn primary tall" data-act="resume"><span>Continue your round</span><small>${esc(cur.course.name)} · ${esc(niceDate(cur.date))} · hole ${esc(cur.order[cur.pos])}</small></button>` : "";
  let who;
  if (u && !u.anonymous) {
    who = `<button class="btn ${resume ? "" : "primary"} tall" data-act="new-round"><span>Start a new round</span><small>Signed in as ${esc(u.email)}. Rounds are posted to The Scorecard.</small></button>
      <button class="btn" data-act="sign-out">Sign out</button>`;
  } else {
    who = `<button class="btn ${resume ? "" : "primary"} tall" data-act="go-signin"><span>Sign in with The Scorecard</span><small>Pick golfers from your groups. Scores are posted for them.</small></button>
      <button class="btn outline tall" data-act="play-anon"><span>Play without an account</span><small>Type the players' names. Keep and share the card; nothing is posted.</small></button>`;
  }
  return `${top("The Marker", "Hole-by-hole scorecard", netPill())}
    <main class="body">${banner()}${resume}${who}
      ${cards.length ? `<button class="btn dashed" data-act="history">Your cards (${cards.length})</button>` : ""}
      <p class="muted">Every score is saved on this phone the moment you enter it, so a lost signal or a flat battery loses nothing.</p>
    </main>
    <footer class="foot"><div class="links">
      <a href="https://www.cuberoot-systems.com/scorecard/support/" target="_blank" rel="noopener">Support</a>
      <a href="https://www.cuberoot-systems.com/scorecard/privacy/" target="_blank" rel="noopener">Privacy</a>
      <span class="muted">v${esc(VERSION)}</span></div></footer>`;
}

/* ---------------- sign in ---------------- */

function screenSignIn() {
  return `${top("Sign in", "With your Scorecard account")}
    <main class="body">${banner()}
      <p>Use the same email and password as The Scorecard.</p>
      <label class="field"><span class="label">Email</span><input class="input" id="email" type="email" autocomplete="username" inputmode="email" autocapitalize="off"></label>
      <label class="field"><span class="label">Password</span><input class="input" id="password" type="password" autocomplete="current-password"></label>
      <button class="btn primary" data-act="sign-in" ${S.busy ? "disabled" : ""}>${S.busy ? "Signing in…" : "Sign in"}</button>
      <button class="btn dashed" data-act="reset">Forgot the password? Send a reset email</button>
    </main>
    <footer class="foot"><button class="btn" data-act="home">← Back</button></footer>`;
}

/* ---------------- 1 · set up the round ---------------- */

function newSetup() {
  const p = local.prefs();
  return { date: today(), course: null, tee: null, holes: "18", start: 1, entry: p.entry || "one", game: null };
}

function screenSetup() {
  const s = S.setup;
  const c = s.course;
  const tees = c ? c.tees : [];
  const holesCount = s.tee ? (s.tee.holes || []).length : 18;
  const nineOnly = holesCount > 0 && holesCount < 18;
  const holeBtn = (v, label) => `<button class="choice ${s.holes === v ? "on" : ""}" data-act="holes" data-v="${v}" ${nineOnly && v !== "front" ? "disabled" : ""}>${label}</button>`;
  const games = member() ? S.games : [];
  return `${top("Set up the round", member() ? user().email : "Playing without an account", netPill())}
    <main class="body">${banner()}
      <div class="field"><span class="label">Date</span>
        <div class="stepper"><button data-act="date" data-v="-1" aria-label="Day before">−</button><div class="val">${esc(niceDate(s.date))}</div><button data-act="date" data-v="1" aria-label="Day after">+</button></div></div>
      <div class="field"><span class="label">Course</span>
        <button class="btn" style="justify-content:flex-start" data-act="go-course">${c ? esc(c.name) : "Choose a course"} ▸</button></div>
      ${c ? `<div class="field"><span class="label">Tee</span><div class="list">${tees.map((t, i) => t.withdrawn ? `
        <button class="item" disabled><span class="box"></span>
          <span class="txt"><span class="name">${esc(t.name)} · withdrawn</span><span class="meta">These details were withdrawn from The Scorecard and cannot be used.</span></span></button>` : `
        <button class="item ${s.tee && s.tee.name === t.name && s.tee.rating === t.rating ? "on" : ""}" data-act="tee" data-v="${i}">
          <span class="box">${s.tee && s.tee.name === t.name && s.tee.rating === t.rating ? "✓" : ""}</span>
          <span class="txt"><span class="name">${esc(t.name)}</span><span class="meta">${t.rating && t.slope ? `${esc(t.rating)} / ${esc(t.slope)}` : "No rating"} · par ${esc(t.par)}${(t.holes || []).length ? "" : " · no hole details"}</span></span></button>`).join("")}</div></div>` : ""}
      <div class="field"><span class="label">Holes</span><div class="row3">${holeBtn("18", "18 holes")}${holeBtn("front", "Front 9")}${holeBtn("back", "Back 9")}</div></div>
      <div class="field"><span class="label">Starting hole</span>
        <div class="stepper"><button data-act="start" data-v="-1" aria-label="Earlier hole">−</button><div class="val">${esc(s.start)}</div><button data-act="start" data-v="1" aria-label="Later hole">+</button></div>
        <span class="muted">For a shotgun start, choose the hole you begin on.</span></div>
      <div class="field"><span class="label">Score entry</span><div class="row2">
        <button class="choice ${s.entry === "one" ? "on" : ""}" data-act="entry" data-v="one">One golfer at a time</button>
        <button class="choice ${s.entry === "all" ? "on" : ""}" data-act="entry" data-v="all">All four together</button></div></div>
      ${games.length ? `<div class="field"><span class="label">Part of a game</span><div class="list">
        <button class="item ${!s.game ? "on" : ""}" data-act="game" data-v=""><span class="box">${!s.game ? "✓" : ""}</span><span class="txt"><span class="name">Not part of a game</span></span></button>
        ${games.map((g) => `<button class="item ${s.game && s.game.id === g.id ? "on" : ""}" data-act="game" data-v="${esc(g.id)}"><span class="box">${s.game && s.game.id === g.id ? "✓" : ""}</span><span class="txt"><span class="name">${esc(g.name)}</span><span class="meta">${esc(g.groupName)}</span></span></button>`).join("")}
      </div></div>` : ""}
    </main>
    <footer class="foot"><button class="btn primary" data-act="go-players" ${c && s.tee ? "" : "disabled"}>Choose the players →</button>
      <button class="btn" data-act="home">← Back</button></footer>`;
}

/* ---------------- choosing a course ---------------- */

function screenCourse() {
  const cs = S.cs;
  const q = cs.query.trim().toLowerCase();
  const seen = new Set();
  const saved = [...cs.library, ...local.recentCourses()].filter((c) => {
    const k = c.providerId || `manual:${c.name.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return !q || c.name.toLowerCase().includes(q) || String(c.where || "").toLowerCase().includes(q);
  }).slice(0, 25);
  if (cs.manual) return screenManualCourse();
  return `${top("Choose a course", "Saved courses, or search")}
    <main class="body">${banner()}${cs.error ? `<div class="banner warn">${esc(cs.error)}</div>` : ""}
      <label class="field"><span class="label">Course or club name</span>
        <input class="input" id="cq" value="${esc(cs.query)}" placeholder="e.g. Royal Ontario" autocomplete="off"></label>
      <div class="row2"><button class="btn" data-act="filter">Show saved</button><button class="btn primary" data-act="search" ${S.busy ? "disabled" : ""}>${S.busy === "search" ? "Searching…" : "Search online"}</button></div>
      ${cs.results.length ? `<span class="label">Found online</span><div class="list">${cs.results.map((c, i) => `
        <button class="item" data-act="pick-online" data-v="${i}"><span class="txt"><span class="name">${esc(c.name)}</span><span class="meta">${esc(c.where)}</span></span></button>`).join("")}</div>` : ""}
      <span class="label">Saved courses</span>
      ${saved.length ? `<div class="list">${saved.map((c) => {
        const st = courseState(c);
        const meta = st === "blocked" ? "Withdrawn · cannot be used"
          : st === "check" ? "Withdrawn in The Scorecard · tap to look for corrected details"
          : `${esc(c.where || "")} · ${c.tees.length} tee${c.tees.length === 1 ? "" : "s"}`;
        return `
        <button class="item" data-act="pick-saved" data-v="${esc(c.providerId || "manual:" + c.name)}"><span class="txt"><span class="name">${esc(c.name)}</span><span class="meta"${st ? ' style="color:var(--over)"' : ""}>${meta}</span></span></button>`;
      }).join("")}</div>`
        : `<p class="muted">${q ? "No saved course matches. Search online, or enter the course yourself." : "No saved courses yet. Search online, or enter the course yourself."}</p>`}
      <button class="btn dashed" data-act="manual">Enter a course yourself</button>
    </main>
    <footer class="foot"><button class="btn" data-act="back-setup">← Back</button></footer>`;
}

function screenManualCourse() {
  const m = S.cs.manual;
  const sc = S.cs.scan;
  const miss = m.miss || { par: [], si: [] };
  const red = (on) => (on ? ' style="outline:3px solid var(--over);outline-offset:1px"' : "");
  const photo = `
      <label class="btn dashed" style="position:relative">${S.busy === "scan" ? "Reading the photo…" : "📷 Read it from a photo of the scorecard"}
        <input type="file" id="scanfile" accept="image/*" capture="environment" ${S.busy ? "disabled" : ""}
          style="position:absolute;inset:0;opacity:0;width:100%;height:100%"></label>
      ${S.cs.error ? `<div class="banner warn">${esc(S.cs.error)}</div>` : ""}
      ${sc && sc.tees.length > 1 && !sc.applied ? `<span class="label">The photo shows ${sc.tees.length} tees. Which one are you playing?</span>
        <div class="list">${sc.tees.map((t, i) => `<button class="item" data-act="scan-pick" data-v="${i}"><span class="txt"><span class="name">${esc(t.name)}</span>
          <span class="meta">${t.rating && t.slope ? `${t.rating} / ${t.slope}` : "No rating read"}</span></span></button>`).join("")}</div>` : ""}
      ${sc && sc.applied ? `<div class="banner ok">Read from the photo${sc.missing ? `; ${sc.missing} value${sc.missing === 1 ? " was" : "s were"} not readable and ${sc.missing === 1 ? "is" : "are"} marked in red for you to fill in` : ""}. Check every value against the card before using it.</div>` : ""}`;
  return `${top("Enter a course", "From the scorecard at the club")}
    <main class="body">${banner()}${photo}
      <label class="field"><span class="label">Course name</span><input class="input" id="m-name" value="${esc(m.name)}"></label>
      <label class="field"><span class="label">Tee</span><input class="input" id="m-tee" value="${esc(m.tee)}" placeholder="e.g. White"></label>
      <div class="row2">
        <label class="field"><span class="label">Rating</span><input class="input" id="m-rating"${red(miss.rating)} inputmode="decimal" value="${esc(m.rating)}" placeholder="e.g. 70.1"></label>
        <label class="field"><span class="label">Slope</span><input class="input" id="m-slope"${red(miss.slope)} inputmode="numeric" value="${esc(m.slope)}" placeholder="e.g. 125"></label></div>
      <p class="muted">Rating and slope are needed only to post rounds to The Scorecard.</p>
      <span class="label">Each hole: par, and stroke index (SI)</span>
      <div class="holes-grid" style="grid-template-columns: repeat(2, minmax(0, 1fr))">${m.pars.map((p, i) => `<label>${i + 1}
        <select data-hole="${i}"${red(miss.par.includes(i))} aria-label="Par of hole ${i + 1}">${[3, 4, 5, 6].map((v) => `<option ${v === p ? "selected" : ""}>${v}</option>`).join("")}</select>
        <select data-si="${i}"${red(miss.si.includes(i))} aria-label="Stroke index of hole ${i + 1}"><option value="">SI</option>${Array.from({ length: 18 }, (_, k) => k + 1).map((v) => `<option ${v === m.sis[i] ? "selected" : ""}>${v}</option>`).join("")}</select></label>`).join("")}</div>
      <p class="muted">The stroke index is on the club's scorecard, usually marked HCP or SI. It decides where strokes are given.</p>
    </main>
    <footer class="foot"><button class="btn primary" data-act="manual-save">Use this course</button><button class="btn" data-act="manual-cancel">← Back</button></footer>`;
}

/* ---------------- 2 · the players ---------------- */

function screenPlayers() {
  const s = S.setup;
  const count = S.picked.length;
  const full = count >= 4;
  let groupPart = "";
  if (member()) {
    const tab = S.groupTab;
    const list = S.golfers[tab];
    if (!S.groups.length) groupPart = `<div class="banner warn">You are not a member of any group yet, so golfers cannot be chosen. Add players as guests below.</div>`;
    else groupPart = `<div class="tabs">${S.groups.map((g) => `<button class="choice ${g.id === tab ? "on" : ""}" data-act="tab" data-v="${esc(g.id)}">${esc(g.name)}</button>`).join("")}</div>
      ${list === undefined ? `<p class="muted">Loading golfers…</p>` : `<div class="list">${list.map((g) => {
        const on = S.picked.some((p) => p.golferId === g.golferId);
        const off = full && !on;
        return `<button class="item ${on ? "on" : ""}" data-act="pick" data-v="${esc(g.golferId)}" ${off ? "disabled" : ""}><span class="box">${on ? "✓" : ""}</span>
          <span class="txt"><span class="name">${esc(g.name)}</span><span class="meta">${off ? "The foursome is full" : g.index == null ? "No index yet" : `Index ${esc(g.index)}`}</span></span></button>`;
      }).join("") || `<p class="muted">No golfers in this group yet.</p>`}</div>`}
      <p class="muted">Only golfers already in your groups can be posted. Anyone else: add them below as a guest.</p>`;
  }
  const guests = S.picked.filter((p) => !p.golferId);
  return `${top("Who's playing?", `${s.course.name} · ${s.tee.name}`, `<span class="pill">${count} of 4</span>`)}
    <main class="body">${banner()}${groupPart}
      <span class="label">${member() ? "Guests · scored and shared, not posted" : "Players"}</span>
      ${guests.map((g) => `<div class="item on"><span class="box">✓</span><span class="txt"><span class="name">${esc(g.name)}</span><span class="meta">${member() ? "Guest" : "Player"}</span></span><button class="btn" style="min-height:44px" data-act="unguest" data-v="${esc(g.name)}">Remove</button></div>`).join("")}
      ${full ? "" : `<div class="row2" style="grid-template-columns: minmax(0,1fr) auto"><input class="input" id="guest" placeholder="${member() ? "Guest's name" : "Player's name"}" value="${esc(S.guestName)}" autocomplete="off"><button class="btn" data-act="add-guest">Add</button></div>`}
    </main>
    <footer class="foot"><button class="btn primary" data-act="tee-off" ${count ? "" : "disabled"}>Tee off on hole ${esc(s.start)} →</button>
      <button class="btn" data-act="back-setup">← Back</button></footer>`;
}

/* ---------------- 3 · playing ---------------- */

function holeHeader(c, n) {
  const h = card.holeInfo(c, n);
  const pos = c.order.indexOf(n) + 1;
  return `<header class="top"><div class="row"><div class="sub">${esc(c.course.name)} · hole ${pos} of ${c.order.length}</div>
      <div class="row"><span class="pill">✓ Saved</span><button class="pill light" data-act="share-card">Share</button></div></div>
    <div class="hole-title"><span class="big">Hole ${n}</span><span class="par">Par ${h.par}</span></div>
    <div class="hole-meta">${h.yards ? `${h.yards} yds · ` : ""}${h.si ? `Stroke index ${h.si}` : "No stroke index"}</div></header>`;
}

function playerNote(c, pi, n) {
  const pl = c.players[pi];
  const h = card.holeInfo(c, n);
  const k = card.strokesOn(pl.ch, h.si);
  const cap = card.holeCap(h.par, pl.ch, h.si);
  const guest = pl.guest ? (c.mode === "member" ? "Guest · not posted · " : "") : "";
  if (pl.ch == null) return `${guest}No index · handicap limit ${cap}`;
  const strokes = !h.si ? `About ${k} stroke${k === 1 ? "" : "s"} a hole (no stroke index)` : k === 0 ? "No stroke here" : k > 0 ? `Gets ${k} stroke${k === 1 ? "" : "s"} here` : `Gives ${-k} stroke back here`;
  return `${guest}${strokes} · handicap limit ${cap}`;
}

function footPlay(c, n) {
  const last = c.order.indexOf(n) === c.order.length - 1;
  const done = card.holeComplete(c, n);
  const left = c.players.filter((p) => !card.isEntered(p.scores[n])).length;
  const next = done
    ? (last ? `<button class="btn primary" data-act="finish">Finish</button>` : `<button class="btn primary" data-act="next">Hole ${c.order[c.order.indexOf(n) + 1]} →</button>`)
    : `<div class="btn dashed" style="color:var(--ink-3)">${left} to go</div>`;
  return `<footer class="foot"><div class="row3">
      <button class="btn" data-act="prev" ${c.pos === 0 ? "disabled" : ""}>← Back</button>
      <button class="btn" data-act="card">Card</button>${next}</div></footer>`;
}

function screenPlayOne(c) {
  const n = c.order[c.pos];
  const h = card.holeInfo(c, n);
  const who = Math.min(c.who || 0, c.players.length - 1);
  const pl = c.players[who];
  const s = pl.scores[n];
  const has = card.isEntered(s);
  const words = { "-3": "Albatross", "-2": "Eagle", "-1": "Birdie", 0: "Par", 1: "Bogey", 2: "Double", 3: "Triple" };
  const lo = Math.max(1, h.par - 2);
  const tiles = [];
  for (let v = lo; v < lo + 9; v++) {
    const d = v - h.par;
    tiles.push(`<button class="tile ${s === v ? "on" : ""}" data-act="score" data-v="${v}"><b>${v}</b><span>${s === v ? "✓ Entered" : words[d] || `+${d}`}</span></button>`);
  }
  const names = c.players.map((p, i) => {
    const e = p.scores[n];
    const cls = i === who ? "now" : card.isEntered(e) ? "done" : "";
    return `<button class="${cls}" data-act="who" data-v="${i}">${esc(first(p.name))}${card.isEntered(e) ? ` ${esc(e)}` : ""}</button>`;
  }).join("");
  const status = has
    ? `<div class="status done">Entered: ${s === card.PICKED_UP ? "picked up" : esc(s)}. Tap another number to change it, or tap the next name above.</div>`
    : `<div class="status empty">No score yet. Tap the number of strokes.</div>`;
  const body = S.typing
    ? `<label class="field"><span class="label">Strokes on this hole</span>
        <input class="input" id="typed" type="number" inputmode="numeric" min="1" max="20" value="${esc(S.typed)}" style="height:96px;font-size:52px;font-weight:800;text-align:center;border:3px solid var(--green)"></label>
       ${S.typeError ? `<div class="banner bad">${esc(S.typeError)}</div>` : ""}
       <div class="row2"><button class="btn" data-act="type-cancel">Cancel</button><button class="btn primary" data-act="type-save">Save score</button></div>`
    : `<div class="tiles">${tiles.join("")}</div>
       <div class="row2"><button class="btn dashed" data-act="type">Type a score</button><button class="btn dashed ${s === card.PICKED_UP ? "outline" : ""}" data-act="score" data-v="X">${s === card.PICKED_UP ? "✓ Picked up" : "Picked up"}</button></div>`;
  return `${holeHeader(c, n)}<nav class="names">${names}</nav>
    <main class="body">${banner()}
      <div class="who"><div class="step">Golfer ${who + 1} of ${c.players.length}</div><div class="name">${esc(pl.name)}</div><div class="muted">${esc(playerNote(c, who, n))}</div></div>
      ${status}${body}
    </main>${footPlay(c, n)}`;
}

function screenPlayAll(c) {
  const n = c.order[c.pos];
  const h = card.holeInfo(c, n);
  const rows = c.players.map((pl, i) => {
    const s = pl.scores[n];
    const t = card.totals(c, i);
    const shown = s === card.PICKED_UP ? "X" : card.isEntered(s) ? s : "";
    const cls = card.isEntered(s) && s !== card.PICKED_UP ? (s < h.par ? "under" : s > h.par ? "over" : "") : "";
    return `<div class="player"><div class="head"><b>${esc(pl.name)}</b><span>${t.done ? `${card.formatToPar(t.toPar)} thru ${t.done}` : ""}</span></div>
      <div class="ctl"><button class="minus" data-act="minus" data-v="${i}" aria-label="One stroke fewer for ${esc(pl.name)}">−</button>
        <input class="${cls}" data-score="${i}" type="text" inputmode="numeric" value="${esc(shown)}" placeholder="–" aria-label="Score for ${esc(pl.name)}">
        <button class="plus" data-act="plus" data-v="${i}" aria-label="One stroke more for ${esc(pl.name)}">+</button></div>
      <div class="note">${esc(playerNote(c, i, n))}</div></div>`;
  }).join("");
  return `${holeHeader(c, n)}<main class="body">${banner()}${rows}
    <p class="muted">Tap + to start at par. Tap a number to type it; X means picked up.</p></main>${footPlay(c, n)}`;
}

/* ---------------- 4 · the whole card ---------------- */

function cardGrid(c, interactive) {
  const cur = c.order[c.pos];
  const head = `<div class="crow"><div class="hd">HOLE</div><div class="hd">PAR</div><div class="hd">SI</div>${c.players.map((p) => `<div class="hd">${esc(first(p.name).toUpperCase())}</div>`).join("")}</div>`;
  const rows = c.order.map((n, k) => {
    const h = card.holeInfo(c, n);
    const cls = interactive && n === cur ? "now-row" : k % 2 ? "zebra" : "plain";
    const cells = c.players.map((p) => {
      const s = p.scores[n];
      const t = s === card.PICKED_UP ? "X" : card.isEntered(s) ? s : "·";
      const col = card.isEntered(s) && s !== card.PICKED_UP ? (s < h.par ? "under" : s > h.par ? "over" : "") : "";
      return `<div class="${col}" style="font-weight:700">${esc(t)}</div>`;
    }).join("");
    const inner = `<div style="font-weight:800">${n}</div><div>${h.par}</div><div style="color:var(--ink-3)">${h.si || ""}</div>${cells}`;
    return interactive ? `<button class="crow ${cls}" data-act="jump" data-v="${k}" aria-label="Go to hole ${n}">${inner}</button>` : `<div class="crow ${cls}">${inner}</div>`;
  }).join("");
  const tot = c.players.map((p, i) => { const t = card.totals(c, i); return `<div>${t.done ? card.formatToPar(t.toPar) : "–"}</div>`; }).join("");
  const done = Math.max(...c.players.map((p, i) => card.totals(c, i).done));
  return `<div class="cgrid" style="--n:${c.players.length}">${head}${rows}<div class="crow total"><div style="grid-column: span 3">Thru ${done}</div>${tot}</div></div>`;
}

function screenCard(c) {
  return `${top("The card", "Tap a hole to go back and change it")}
    <main class="body" style="padding:10px">${banner()}${cardGrid(c, true)}</main>
    <footer class="foot"><button class="btn primary" data-act="back-play">Back to hole ${esc(c.order[c.pos])} →</button>
      <button class="btn" data-act="share-card">Share the card</button></footer>`;
}

/* ---------------- 5 · finish, post, share ---------------- */

function summaries(c) {
  return c.players.map((p, i) => {
    const t = card.totals(c, i);
    const where = p.guest ? (c.mode === "member" ? "Guest · shared only, not posted" : "") : p.groupName;
    return `<div class="sum"><b style="font-size:19px">${esc(p.name)}</b>${where ? `<span class="muted">${esc(where)}</span>` : ""}
      <div class="stats"><div><b>${t.gross}</b><span>Gross${t.complete ? "" : ` thru ${t.done}`}</span></div>
      <div><b>${p.guest && c.mode === "member" ? "—" : t.adjusted}</b><span>Adjusted</span></div>
      <div><b style="color:var(--green)">${t.net == null ? "—" : t.net}</b><span>${p.ch == null ? "No index" : `Net (CH ${p.ch})`}</span></div></div></div>`;
  }).join("");
}

function screenFinish(c) {
  const check = card.postable(c);
  const n = c.players.filter((p) => !p.guest).length;
  const postBtn = check.ok
    ? `<button class="btn primary" data-act="post">Post ${n} round${n === 1 ? "" : "s"} to The Scorecard</button>`
    : `<div class="banner warn">${esc(check.why)}</div>`;
  return `${top("Round finished", `${c.course.name} · ${niceDate(c.date)}`)}
    <main class="body">${banner()}<p class="muted">Check the totals before posting. Adjusted applies net double bogey on each hole, worked out for you.</p>
      ${summaries(c)}</main>
    <footer class="foot">${postBtn}<div class="row2"><button class="btn" data-act="share-card">Share the card</button><button class="btn" data-act="card">Review card</button></div>
      ${check.ok ? "" : `<button class="btn" data-act="done">Done</button>`}</footer>`;
}

function screenStatus(c) {
  const posted = c.state === "posted";
  const failed = c.state === "failed";
  const rows = c.players.filter((p) => !p.guest).map((p) => {
    const t = card.totals(c, c.players.indexOf(p));
    return `<div class="item"><span class="txt"><span class="name">${esc(p.name)} · ${t.gross}</span><span class="meta">${esc(p.groupName)}</span></span>
      <b style="color:${posted ? "var(--green)" : failed ? "var(--over)" : "#8A5A12"}">${posted ? "Posted ✓" : failed ? "Not posted" : c.sent ? "Checking" : "Waiting"}</b></div>`;
  }).join("");
  const head = posted ? "Posted to The Scorecard"
    : failed ? "Not posted"
    : c.sent ? "Sent to The Scorecard"
    : "Saved on this phone";
  const text = posted ? "The rounds are in The Scorecard now, and the handicap indexes are up to date."
    : failed ? c.postError
    : c.sent ? "The Scorecard is checking the card and posting it. This usually takes seconds, at most a few minutes. You can close the app."
    : navigator.onLine === false ? "There is no signal right now. The card is sent by itself as soon as the phone is back online. You can close the app."
    : "Sending… This takes a moment. If the signal drops, the card is sent by itself later.";
  return `${top("The Marker", "Posting")}
    <main class="body">${banner()}<h2>${esc(head)}</h2><p>${esc(text)}</p><div class="list">${rows}</div>
      <p class="muted">Each one shows "Posted" only once The Scorecard has actually saved it.</p></main>
    <footer class="foot"><button class="btn primary" data-act="done">Done</button><button class="btn" data-act="share-card">Share the card</button></footer>`;
}

/* ---------------- your cards ---------------- */

function screenHistory() {
  const cards = local.finishedCards();
  return `${top("Your cards", "Kept on this phone")}
    <main class="body">${banner()}<div class="list">${cards.map((c) => `
      <button class="item" data-act="view" data-v="${esc(c.id)}"><span class="txt"><span class="name">${esc(c.course.name)}</span>
        <span class="meta">${esc(niceDate(c.date))} · ${esc(c.players.map((p) => first(p.name)).join(", "))} · ${c.state === "posted" ? "posted" : c.state === "posting" ? (c.sent ? "being checked" : "waiting to send") : c.state === "failed" ? "not posted" : "not posted"}</span></span></button>`).join("")}</div></main>
    <footer class="foot"><button class="btn" data-act="home">← Back</button></footer>`;
}

function screenView(c) {
  return `${top(c.course.name, `${niceDate(c.date)} · ${c.tee.name}`)}
    <main class="body" style="padding:10px">${banner()}${cardGrid(c, false)}${summaries(c)}
      ${c.state === "failed" && c.postError ? `<div class="banner warn">${esc(c.postError)}</div>` : ""}</main>
    <footer class="foot"><button class="btn primary" data-act="share-view">Share the card</button><button class="btn" data-act="history">← Back</button></footer>`;
}

/* ---------------- sharing ---------------- */

function screenShare() {
  const t = S.share || "";
  const enc = encodeURIComponent(t);
  return `${top("Share the card", "WhatsApp, email, text or copy")}
    <main class="body">${banner()}
      <a class="btn primary" href="https://wa.me/?text=${enc}" target="_blank" rel="noopener">WhatsApp</a>
      <a class="btn" href="mailto:?subject=${encodeURIComponent("Golf scorecard")}&body=${enc}">Email</a>
      <a class="btn" href="sms:?&body=${enc}">Text message</a>
      <button class="btn" data-act="copy">Copy</button>
      <pre style="white-space:pre-wrap;font-size:16px;background:#fff;border:1.5px solid var(--line);border-radius:12px;padding:12px">${esc(t)}</pre></main>
    <footer class="foot"><button class="btn" data-act="share-back">← Back</button></footer>`;
}

async function share(text, back) {
  S.shareBack = back;
  if (navigator.share) {
    try { await navigator.share({ title: "Golf scorecard", text }); return; }
    catch (e) { if (e && e.name === "AbortError") return; }
  }
  S.share = text;
  go("share");
}

/* ---------------- render ---------------- */

function render() {
  const c = local.currentCard();
  let html;
  switch (S.screen) {
    case "signin": html = screenSignIn(); break;
    case "setup": html = screenSetup(); break;
    case "course": html = screenCourse(); break;
    case "players": html = screenPlayers(); break;
    case "play": html = c ? (c.entry === "all" ? screenPlayAll(c) : screenPlayOne(c)) : screenStart(); break;
    case "card": html = c ? screenCard(c) : screenStart(); break;
    case "finish": html = c ? screenFinish(c) : screenStart(); break;
    case "status": html = c ? screenStatus(c) : screenStart(); break;
    case "history": html = screenHistory(); break;
    case "view": html = S.view ? screenView(S.view) : screenHistory(); break;
    case "share": html = screenShare(); break;
    default: html = screenStart();
  }
  app.innerHTML = html;
  S.flash = "";
  if (S.screen === "play" && S.typing) { const t = document.getElementById("typed"); if (t) t.focus(); }
}

/* ---------------- actions ---------------- */

async function loadGroupsAndGames() {
  if (!member()) { S.groups = []; S.games = []; return; }
  try {
    S.groups = await db.myGroups();
    if (!S.groupTab && S.groups[0]) S.groupTab = S.groups[0].id;
  } catch (e) { S.error = e.message; }
  await loadGames();
}

async function loadGames() {
  S.games = [];
  if (!member() || !S.setup) return;
  const date = S.setup.date;
  const lists = await Promise.all(S.groups.map((g) => db.gamesOn(g, date).catch(() => [])));
  if (S.setup && S.setup.date === date) { S.games = lists.flat(); render(); }
}

async function loadGolfers(assocId) {
  if (!assocId || S.golfers[assocId]) return;
  try { S.golfers[assocId] = await db.groupGolfers(assocId); }
  catch (e) { S.golfers[assocId] = []; S.error = e.message; }
  render();
}

function updateCard(fn) {
  const c = local.currentCard();
  if (!c) return;
  try { saveCard(fn(c)); S.error = ""; }
  catch (e) { S.error = e.message; }
  render();
}

function setScoreNow(pi, value) {
  updateCard((c) => card.setScore(c, pi, c.order[c.pos], value));
}

const actions = {
  home() { go("start"); },
  "go-signin"() { go("signin"); },
  async "sign-in"() {
    const email = document.getElementById("email").value;
    const password = document.getElementById("password").value;
    if (!email || !password) { S.error = "Type your email and password."; render(); return; }
    S.busy = "signin"; render();
    try { await db.signIn(email, password); S.busy = ""; S.flash = "Signed in."; go("start"); }
    catch (e) { fail(e); }
  },
  async reset() {
    const email = (document.getElementById("email") || {}).value;
    if (!email) { S.error = "Type your email first, then tap this again."; render(); return; }
    try { await db.sendReset(email); S.flash = `If ${email} has an account, a reset email is on its way.`; S.error = ""; render(); }
    catch { S.error = "The reset email could not be sent. Check the signal and try again."; render(); }
  },
  async "sign-out"() { await db.signOut(); S.groups = []; S.golfers = {}; S.flash = "Signed out."; go("start"); },
  async "play-anon"() {
    /* Not awaited: with a poor signal the anonymous sign-in can take a while,
       and nothing on the next screens needs it except searching online. */
    db.playWithoutAccount().catch(() => {});
    S.setup = newSetup(); S.picked = []; S.games = [];
    go("setup");
  },
  async "new-round"() {
    const cur = local.currentCard();
    if (cur && cur.state === "playing" && !confirmLeave(cur)) return;
    S.setup = newSetup(); S.picked = []; S.golfers = {};
    go("setup");
    await loadGroupsAndGames();
    render();
  },
  resume() { const c = local.currentCard(); go(c.state === "finished" ? "finish" : "play"); },
  date(el) { S.setup.date = shiftDate(S.setup.date, Number(el.dataset.v)); S.setup.game = null; render(); loadGames(); },
  "go-course"() {
    S.cs.error = ""; S.cs.results = []; S.cs.withdrawn = db.withdrawnSaved(); go("course");
    db.library().then((l) => { S.cs.library = l; if (S.screen === "course" && !S.cs.manual) render(); });
    db.withdrawnCourses().then((w) => { S.cs.withdrawn = w; if (S.screen === "course" && !S.cs.manual) render(); });
  },
  "back-setup"() { S.cs.manual = null; go("setup"); },
  tee(el) {
    const t = S.setup.course.tees[Number(el.dataset.v)];
    if (!(t.holes || []).length) {
      /* The provider has no holes for this tee: take them off the club's card. */
      S.cs.manual = { name: S.setup.course.name, tee: t.name, rating: t.rating == null ? "" : String(t.rating), slope: t.slope == null ? "" : String(t.slope), pars: Array(18).fill(4), sis: Array(18).fill(""), yards: Array(18).fill(null), providerId: S.setup.course.providerId || null, where: S.setup.course.where || "" };
      S.flash = "This tee has no hole details. Copy the par and stroke index of each hole from the club's scorecard.";
      go("course");
      return;
    }
    S.setup.tee = t;
    if ((t.holes || []).length && t.holes.length < 18) { S.setup.holes = "front"; }
    S.setup.start = card.holeOrder(S.setup.holes, S.setup.start)[0];
    render();
  },
  holes(el) { S.setup.holes = el.dataset.v; S.setup.start = card.holeOrder(S.setup.holes, S.setup.start)[0]; render(); },
  start(el) {
    const choices = card.startChoices(S.setup.holes);
    const i = choices.indexOf(S.setup.start);
    S.setup.start = choices[(i + Number(el.dataset.v) + choices.length) % choices.length];
    render();
  },
  entry(el) { S.setup.entry = el.dataset.v; try { local.savePrefs({ entry: el.dataset.v }); } catch {} render(); },
  game(el) { S.setup.game = S.games.find((g) => g.id === el.dataset.v) || null; render(); },
  filter() { S.cs.query = document.getElementById("cq").value; render(); },
  async search() {
    const q = document.getElementById("cq").value.trim();
    S.cs.query = q; S.cs.error = ""; S.cs.results = [];
    if (q.length < 3) { S.cs.error = courses.explain("TOO_SHORT"); render(); return; }
    S.busy = "search"; render();
    try { S.cs.results = await db.searchCourses(q); }
    catch (e) { S.cs.error = courses.explain(e); }
    S.busy = ""; render();
  },
  async "pick-online"(el) {
    const found = S.cs.results[Number(el.dataset.v)];
    S.busy = "course"; S.cs.error = ""; S.flash = "Getting the holes…"; render();
    try {
      const full = await db.courseById(found.providerId);
      if (!full || !Array.isArray(full.tees) || !full.tees.length) throw new Error("NO_TEES");
      try { local.rememberCourse(full); } catch {}
      chooseCourse(full);
    } catch (e) {
      S.busy = ""; S.cs.error = courses.explain(e); render();
    }
  },
  async "pick-saved"(el) {
    const id = el.dataset.v;
    const all = [...S.cs.library, ...local.recentCourses()];
    const c = all.find((x) => (x.providerId || "manual:" + x.name) === id);
    if (!c) return;
    const st = courseState(c);
    if (st === "blocked") { needHandEntry(c.name); return; }
    if (st === "check") {
      /* Withdrawn in The Scorecard: ask the golf course database again, its
         details may have been corrected since. */
      S.busy = "course"; S.flash = "Looking for corrected details…"; render();
      try { chooseCourse(await db.courseById(c.providerId)); }
      catch (e) { S.busy = ""; S.cs.error = courses.explain(e); render(); }
      return;
    }
    try { local.rememberCourse(c); } catch {}
    chooseCourse(c);
  },
  manual() {
    S.cs.manual = newManual(S.cs.query || ""); S.cs.error = ""; S.cs.scan = null;
    render();
  },
  "manual-cancel"() { S.cs.manual = null; S.cs.scan = null; render(); },
  "scan-pick"(el) { applyScan(S.cs.scan.tees[Number(el.dataset.v)]); },
  "manual-save"() {
    const m = S.cs.manual;
    m.name = document.getElementById("m-name").value.trim();
    m.tee = document.getElementById("m-tee").value.trim() || "Tee";
    m.rating = document.getElementById("m-rating").value.trim();
    m.slope = document.getElementById("m-slope").value.trim();
    document.querySelectorAll("[data-hole]").forEach((s) => { m.pars[Number(s.dataset.hole)] = Number(s.value); });
    document.querySelectorAll("[data-si]").forEach((s) => { m.sis[Number(s.dataset.si)] = s.value ? Number(s.value) : ""; });
    const given = m.sis.filter((x) => x !== "");
    if (given.length && (given.length !== 18 || new Set(given).size !== 18)) {
      S.error = "Each stroke index from 1 to 18 is used once. Fill in all 18, or leave them all empty.";
      render(); return;
    }
    if (m.name.length < 2) { S.error = "Type the course name."; render(); return; }
    const rating = m.rating ? Number(m.rating) : null;
    const slope = m.slope ? Number(m.slope) : null;
    if ((m.rating && !(rating > 50 && rating < 90)) || (m.slope && !(slope >= 55 && slope <= 155))) {
      S.error = "The rating is usually between 60 and 80, and the slope between 55 and 155. Check them, or leave both empty.";
      render(); return;
    }
    const par = m.pars.reduce((a, b) => a + b, 0);
    if (rating != null && slope != null && W.teeWithdrawn(S.cs.withdrawn, m.name, { rating, slope, par })) {
      S.error = "These are the details that were withdrawn from The Scorecard, so they cannot be used. Copy the rating and slope from the club's current scorecard.";
      render(); return;
    }
    const yards = m.yards || [];
    const course = { providerId: m.providerId && !W.scorecardIdOf(m.providerId) ? m.providerId : null, name: m.name, where: m.where || "Entered by hand",
      tees: [{ name: m.tee, rating, slope, par, holes: m.pars.map((p, i) => ({ par: p, yards: yards[i] == null ? null : yards[i], si: m.sis[i] === "" ? null : m.sis[i] })) }] };
    S.cs.scan = null;
    try { local.rememberCourse(course); } catch {}
    S.cs.manual = null;
    chooseCourse(course);
  },
  async "go-players"() {
    go("players");
    if (member()) {
      if (!S.groups.length) await loadGroupsAndGames();
      await loadGolfers(S.groupTab);
    }
  },
  async tab(el) { S.groupTab = el.dataset.v; render(); await loadGolfers(S.groupTab); },
  pick(el) {
    const g = (S.golfers[S.groupTab] || []).find((x) => x.golferId === el.dataset.v);
    if (!g) return;
    const i = S.picked.findIndex((p) => p.golferId === g.golferId);
    if (i >= 0) S.picked.splice(i, 1);
    else if (S.picked.length < 4) {
      const group = S.groups.find((x) => x.id === S.groupTab);
      S.picked.push({ name: g.name, golferId: g.golferId, assocId: S.groupTab, groupName: group ? group.name : "", index: g.index });
    }
    render();
  },
  "add-guest"() {
    const name = document.getElementById("guest").value.trim().replace(/\s+/g, " ");
    if (name.length < 2) { S.error = "Type the player's name."; render(); return; }
    if (S.picked.some((p) => p.name.toLowerCase() === name.toLowerCase())) { S.error = `${name} is already on the card.`; render(); return; }
    if (S.picked.length >= 4) return;
    S.picked.push({ name, golferId: null, assocId: null, groupName: "", index: null });
    S.guestName = ""; S.error = ""; render();
  },
  unguest(el) { S.picked = S.picked.filter((p) => p.golferId || p.name !== el.dataset.v); render(); },
  "tee-off"() {
    const s = S.setup;
    const c = card.newCard({ mode: member() ? "member" : "guest", date: s.date, course: s.course, tee: s.tee, holes: s.holes, start: s.start, entry: s.entry, game: s.game, players: S.picked });
    try { saveCard(c); } catch (e) { fail(e); return; }
    S.typing = false;
    go("play");
    keepAwake();
  },
  who(el) { S.typing = false; updateCard((c) => ({ ...c, who: Number(el.dataset.v) })); },
  score(el) {
    const v = el.dataset.v === "X" ? card.PICKED_UP : Number(el.dataset.v);
    const c = local.currentCard();
    setScoreNow(Math.min(c.who || 0, c.players.length - 1), v);
  },
  type() { S.typing = true; S.typed = ""; S.typeError = ""; render(); },
  "type-cancel"() { S.typing = false; S.typeError = ""; render(); },
  "type-save"() {
    const raw = document.getElementById("typed").value.trim();
    const v = Number(raw);
    if (!/^\d{1,2}$/.test(raw) || v < 1 || v > 20) { S.typed = raw; S.typeError = "Type a whole number from 1 to 20."; render(); return; }
    S.typing = false; S.typeError = "";
    const c = local.currentCard();
    setScoreNow(Math.min(c.who || 0, c.players.length - 1), v);
  },
  plus(el) {
    const c = local.currentCard(); const n = c.order[c.pos]; const i = Number(el.dataset.v);
    const s = c.players[i].scores[n];
    const par = card.holeInfo(c, n).par;
    setScoreNow(i, !card.isEntered(s) || s === card.PICKED_UP ? par : Math.min(20, s + 1));
  },
  minus(el) {
    const c = local.currentCard(); const n = c.order[c.pos]; const i = Number(el.dataset.v);
    const s = c.players[i].scores[n];
    const par = card.holeInfo(c, n).par;
    setScoreNow(i, !card.isEntered(s) || s === card.PICKED_UP ? Math.max(1, par - 1) : Math.max(1, s - 1));
  },
  next() { S.typing = false; updateCard((c) => ({ ...c, pos: Math.min(c.order.length - 1, c.pos + 1), who: 0 })); window.scrollTo(0, 0); },
  prev() { S.typing = false; updateCard((c) => ({ ...c, pos: Math.max(0, c.pos - 1), who: 0 })); window.scrollTo(0, 0); },
  card() { go("card"); },
  "back-play"() { const c = local.currentCard(); go(c && c.state === "finished" && card.cardComplete(c) ? "finish" : "play"); },
  jump(el) { updateCard((c) => ({ ...c, pos: Number(el.dataset.v), who: 0, state: "playing" })); go("play"); },
  finish() { updateCard((c) => ({ ...c, state: "finished" })); go("finish"); },
  post() {
    const c = local.currentCard();
    try { db.queuePost(c); } catch (e) { fail(e); return; }
    go("status");
  },
  done() {
    const c = local.currentCard();
    if (c) { try { local.keepFinished(c.state === "finished" ? { ...c } : c); } catch {} }
    local.clearCurrent();
    go("start");
  },
  "share-card"() { const c = local.currentCard(); if (c) share(card.shareText(c), S.screen); },
  "share-view"() { if (S.view) share(card.shareText(S.view), "view"); },
  "share-back"() { go(S.shareBack || "start"); },
  async copy() {
    try { await navigator.clipboard.writeText(S.share || ""); S.flash = "Copied. Paste it into any message."; }
    catch { S.error = "This browser would not copy. Press and hold the text below, then choose Copy."; }
    render();
  },
  history() { go("history"); },
  view(el) { S.view = local.finishedCards().find((c) => c.id === el.dataset.v) || null; go("view"); },
};

/* A course in a list: "" usable, "check" withdrawn in The Scorecard but the
   golf course database may have corrected details, "blocked" never usable. */
function courseState(c) {
  const list = S.cs.withdrawn || [];
  const own = W.scorecardIdOf(c.providerId);
  if (own) return list.some((w) => w.id === own) ? "blocked" : "";
  if (!c.providerId) return (c.tees || []).length && c.tees.every((t) => W.teeWithdrawn(list, c.name, t)) ? "blocked" : "";
  return W.nameWithdrawn(list, c.name) ? "check" : "";
}

function newManual(name) {
  return { name, tee: "White", rating: "", slope: "", pars: Array(18).fill(4), sis: Array(18).fill(""), yards: Array(18).fill(null), providerId: null, where: "" };
}

function needHandEntry(name) {
  S.busy = "";
  S.cs.manual = newManual(name);
  go("course");
  S.error = `${name} has been withdrawn from The Scorecard because its details may be wrong, and it cannot be used. Enter the course from the club's scorecard: type it in, or read it from a photo.`;
  render();
}

function chooseCourse(c) {
  const list = S.cs.withdrawn || [];
  c = { ...c, tees: (c.tees || []).map((t) => ({ ...t, withdrawn: !!t.withdrawn || W.teeWithdrawn(list, c.name, t) })) };
  if (c.tees.length && c.tees.every((t) => t.withdrawn)) { needHandEntry(c.name); return; }
  S.busy = "";
  S.setup.course = c;
  const usable = c.tees.filter((t) => !t.withdrawn);
  S.setup.tee = usable.length === 1 ? usable[0] : null;
  if (S.setup.tee && (S.setup.tee.holes || []).length && S.setup.tee.holes.length < 18) S.setup.holes = "front";
  S.setup.start = card.holeOrder(S.setup.holes, S.setup.start)[0];
  S.cs.results = [];
  go("setup");
}

/* ---------------- a photo of the club's scorecard ---------------- */

/* The picture is made smaller on the phone first (long side 1600 pixels),
   which is plenty to read a scorecard and quick to send. */
function shrink(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(img.naturalWidth * k));
        cv.height = Math.max(1, Math.round(img.naturalHeight * k));
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL("image/jpeg", 0.85));
      } catch { reject(new Error("SCAN_BAD_PHOTO")); }
      finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("SCAN_BAD_PHOTO")); };
    img.src = url;
  });
}

async function readPhoto(file) {
  if (!file || !S.cs.manual) return;
  S.cs.error = ""; S.error = ""; S.cs.scan = null; S.busy = "scan"; render();
  try {
    const image = await shrink(file);
    const result = await db.scanCard(image);
    S.busy = "";
    S.cs.scan = { ...result, applied: false };
    if (result.course && !S.cs.manual.name) S.cs.manual.name = result.course;
    if (result.tees.length === 1) applyScan(result.tees[0]);
    else render();
  } catch (e) {
    S.busy = ""; S.cs.error = courses.explain(e); render();
  }
}

/* Fills the hand-entry screen from one tee read off the photo. Anything not
   read is left as it was (par 4, stroke index empty) and counted as missing. */
function applyScan(t) {
  const m = S.cs.manual;
  if (!m || !t) return;
  let missing = 0;
  m.miss = { rating: t.rating == null, slope: t.slope == null, par: [], si: [] };
  m.tee = t.name || m.tee;
  /* Rating and slope not read are emptied, never left from an earlier course. */
  m.rating = t.rating != null ? String(t.rating) : ""; if (t.rating == null) missing++;
  m.slope = t.slope != null ? String(t.slope) : ""; if (t.slope == null) missing++;
  t.holes.forEach((h, i) => {
    if (h.par != null) m.pars[i] = h.par; else { missing++; m.miss.par.push(i); }
    if (h.si != null) m.sis[i] = h.si; else { m.sis[i] = ""; missing++; m.miss.si.push(i); }
    m.yards[i] = h.yards == null ? null : h.yards;
  });
  S.cs.scan = { ...S.cs.scan, applied: true, missing };
  render();
}

function confirmLeave(cur) {
  return window.confirm(`You have a round in progress at ${cur.course.name}. Start a new one? The unfinished card is kept under "Your cards".`)
    && (() => { try { local.keepFinished({ ...cur, state: "finished" }); local.clearCurrent(); } catch {} return true; })();
}

/* Typing straight into a score box in "all four" mode. */
document.addEventListener("change", (e) => {
  if (e.target.id === "scanfile") { readPhoto(e.target.files && e.target.files[0]); e.target.value = ""; return; }
  const m = S.cs.manual;
  if (m && e.target.dataset.hole != null) m.pars[Number(e.target.dataset.hole)] = Number(e.target.value);
  if (m && e.target.dataset.si != null) m.sis[Number(e.target.dataset.si)] = e.target.value ? Number(e.target.value) : "";
  const el = e.target.closest("[data-score]");
  if (!el) return;
  const raw = el.value.trim().toUpperCase();
  const i = Number(el.dataset.score);
  if (raw === "") return;
  if (raw === "X") { setScoreNow(i, card.PICKED_UP); return; }
  const v = Number(raw);
  if (!/^\d{1,2}$/.test(raw) || v < 1 || v > 20) { S.error = "A score is a whole number from 1 to 20, or X for picked up."; render(); return; }
  setScoreNow(i, v);
});

document.addEventListener("input", (e) => {
  if (e.target.id === "guest") S.guestName = e.target.value;
  if (e.target.id === "typed") S.typed = e.target.value;
  if (e.target.id === "cq") S.cs.query = e.target.value;
  /* The hand-entered course is kept as it is typed, so nothing is lost if the
     screen is drawn again (for example when the course list arrives). */
  const m = S.cs.manual;
  if (m) {
    if (e.target.id === "m-name") m.name = e.target.value;
    if (e.target.id === "m-tee") m.tee = e.target.value;
    if (e.target.id === "m-rating") m.rating = e.target.value;
    if (e.target.id === "m-slope") m.slope = e.target.value;
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const id = e.target && e.target.id;
  if (id === "typed") actions["type-save"]();
  else if (id === "guest") actions["add-guest"]();
  else if (id === "cq") actions.search();
  else if (id === "password") actions["sign-in"]();
});

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  try { await fn(el); } catch (err) { fail(err); }
});

/* The screen stays awake while a round is played, where the browser allows it. */
let wake = null;
async function keepAwake() {
  try { if ("wakeLock" in navigator && !wake) { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => { wake = null; }); } } catch {}
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.screen === "play") keepAwake(); });

/* ---------------- start ---------------- */

async function boot() {
  render();
  try { await db.init(); }
  catch (e) { S.error = "No connection to The Scorecard right now. You can still play and share; posting waits for the signal."; }
  db.onChange(() => { if (["start", "status", "history"].includes(S.screen)) render(); });
  window.__markerBooted = true;
  const c = local.currentCard();
  if (c && c.state === "posting") S.screen = "status";
  render();
}
addEventListener("online", () => render());
addEventListener("offline", () => render());
boot();
