/* Core: helpers, API client (loading bar, short cache), auth, router, shell, command palette. Pages live in pages.js / audiences.js, dialogs in modals.js. */
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
// Every piece of data shown in the UI (click labels, paths, referrers...) is visitor-controlled: always esc().
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtNum = n => n == null ? "–" : Number(n).toLocaleString();
const pct = (x, d = 1) => x == null ? "–" : (x * 100).toFixed(d) + "%";
const fmtDur = s => {
  if (s == null) return "–";
  s = Math.round(s);
  return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s";
};
const ago = ts => {
  if (!ts) return "never";
  const d = Math.max(0, Date.now() / 1000 - ts);
  if (d < 60) return "just now";
  if (d < 3600) return Math.floor(d / 60) + " min ago";
  if (d < 86400) return Math.floor(d / 3600) + " h ago";
  return Math.floor(d / 86400) + " d ago";
};
const clock = ts => new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const pathOf = u => String(u || "/").split("?")[0] || "/";

const S = { user: null, sites: [], sitesAt: 0, siteId: null, tab: "overview", days: 14, behavior: "pages", timer: null, epoch: 0 };

// ---------------------------------------------------------------- API client
// * a thin loading bar at the top while anything is in flight
// * GETs can opt in to a short in-memory cache ({ cache: ms }); any write clears it, so lists never look stale after a change
// * identical GETs that are already running share one request
// * a GET that was started before the user navigated elsewhere is dropped (error "stale"), so a slow page can never paint over a newer one
let inflight = 0;
const GET_CACHE = new Map(), PENDING = new Map();
function progress(delta) {
  inflight = Math.max(0, inflight + delta);
  const bar = document.getElementById("nprog");
  if (bar) bar.className = inflight ? "on" : "done";
}
async function api(path, opts = {}) {
  const method = opts.method || "GET", isGet = method === "GET", epoch = S.epoch;
  if (isGet && opts.cache) { const hit = GET_CACHE.get(path); if (hit && Date.now() - hit.t < opts.cache) return hit.data; }
  const exec = async () => {
    progress(1);
    try {
      const init = { method, headers: {} };
      if (opts.body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
      const r = await fetch(path, init);
      if (r.status === 401 && !path.startsWith("/api/auth/")) { renderLogin(); throw new Error("Please log in"); }
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))).detail;
        throw new Error(typeof d === "string" ? d : Array.isArray(d) ? d.map(x => x.msg).join("; ") : r.statusText);
      }
      if (!isGet) { GET_CACHE.clear(); PENDING.clear(); S.sitesAt = 0; }
      return r.status === 204 ? null : await r.json();
    } finally { progress(-1); }
  };
  let p;
  if (isGet && PENDING.has(path)) p = PENDING.get(path);
  else {
    p = exec();
    if (isGet) { PENDING.set(path, p); p.then(() => PENDING.delete(path), () => PENDING.delete(path)); }
  }
  const data = await p;
  if (isGet && opts.cache) GET_CACHE.set(path, { data, t: Date.now() });
  if (isGet && !opts.keep && epoch !== S.epoch) throw new Error("stale");     // the user already moved on
  return data;
}

function toast(msg, isErr) {
  const el = document.createElement("div");
  if (isErr) el.className = "err";
  el.textContent = msg;
  $("#toast").appendChild(el);
  setTimeout(() => el.remove(), isErr ? 6000 : 3500);
}

// ---- tooltip used by charts
function showTip(html, x, y) {
  const t = $("#tip");
  t.innerHTML = html; t.style.display = "block";
  const w = t.offsetWidth;
  t.style.left = Math.min(window.innerWidth - w - 8, x + 14) + "px";
  t.style.top = (y + 14) + "px";
}
const hideTip = () => { $("#tip").style.display = "none"; };

// ---- theme
function applyTheme(t) {
  if (t) document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme");
}
try { applyTheme(localStorage.getItem("ot_theme")); } catch { /* storage blocked */ }
function toggleTheme() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark" ||
    (!document.documentElement.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
  const next = dark ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem("ot_theme", next); } catch { /* ignore */ }
}

// ---- auth screen
function renderLogin() {
  clearInterval(S.timer);
  $("#root").innerHTML = `<div class="login-wrap"><div class="card card-pad login-card">
    <div class="brand"><span class="logo">◎</span> Optimize</div>
    <h2 style="font-size:18px;margin-bottom:4px">Welcome</h2>
    <p class="muted" style="margin:0 0 16px">Log in, or create an account in one step.</p>
    <div class="field"><label for="a-email">Email</label><input id="a-email" type="email" autocomplete="username"></div>
    <div class="field"><label for="a-pw">Password</label><input id="a-pw" type="password" autocomplete="current-password" placeholder="At least 8 characters"></div>
    <div class="row"><button class="btn primary" id="a-login">Log in</button><button class="btn" id="a-reg">Create account</button></div>
    <div id="a-err" class="bad" style="margin-top:10px"></div></div></div>`;
  const go = path => async () => {
    try {
      await api(path, { method: "POST", body: { email: $("#a-email").value, password: $("#a-pw").value } });
      boot();
    } catch (e) { $("#a-err").textContent = e.message; }
  };
  $("#a-login").onclick = go("/api/auth/login");
  $("#a-reg").onclick = go("/api/auth/register");
  $("#a-pw").addEventListener("keydown", e => { if (e.key === "Enter") go("/api/auth/login")(); });
}

// ---------------------------------------------------------------- navigation model
const NAV = [
  ["Optimize", [["overview", "◧", "Overview"], ["campaigns", "✦", "Personalization"], ["experiments", "⚗", "A/B tests"], ["audiences", "◔", "Audiences"], ["goals", "◎", "Goals"]]],
  ["Insights", [["behavior", "⌖", "Behavior"], ["heatmaps", "◍", "Heatmaps"], ["funnels", "⏷", "Funnels"], ["visitors", "☺", "Visitors"], ["live", "●", "Live feed"]]],
  ["Setup", [["settings", "⚙", "Install & settings"]]],
];
const TABS = NAV.flatMap(([, items]) => items);
const TAB_LABEL = Object.fromEntries(TABS.map(([k, , l]) => [k, l]));
const STATUS_LABEL = { live: "Live now", receiving: "Receiving data", idle: "No recent data", waiting: "Waiting for data" };
const statusPill = s => `<span class="pill ${esc(s)}"><span class="dot ${esc(s)}"></span>${esc(STATUS_LABEL[s] || s)}</span>`;
const curSite = () => S.sites.find(s => s.id === S.siteId);

// ---------------------------------------------------------------- shell
function renderShell() {
  $("#root").innerHTML = `<div id="nprog"></div><div id="app"><aside id="sidebar" aria-label="Main navigation">
    <div class="brand"><span class="logo">◎</span> Optimize</div>
    <div class="side-scroll" id="side-scroll"></div>
    <div class="side-foot"><div class="who" id="who"></div></div>
  </aside><div id="scrim"></div><div id="main"><header id="topbar">
    <button id="menu-btn" class="icon-btn" aria-label="Open menu">☰</button>
    <nav id="crumbs" aria-label="Breadcrumb"></nav><span class="grow"></span>
    <button id="search-btn" class="search-btn" aria-label="Search or jump to a page"><span>🔍︎ Jump to…</span><kbd>Ctrl K</kbd></button>
    <button id="theme-btn" class="icon-btn" title="Toggle light / dark" aria-label="Toggle theme">◐</button>
    <button id="logout-btn" class="btn sm">Log out</button>
  </header><main id="view" tabindex="-1"></main></div></div>`;
  $("#who").textContent = S.user?.email || "";
  $("#theme-btn").onclick = toggleTheme;
  $("#search-btn").onclick = openPalette;
  $("#menu-btn").onclick = () => document.body.classList.toggle("nav-open");
  $("#scrim").onclick = () => document.body.classList.remove("nav-open");
  $("#logout-btn").onclick = async () => { await api("/api/auth/logout", { method: "POST" }); S.user = null; S.sites = []; renderLogin(); };
}

function renderSidebar() {
  const box = $("#side-scroll"); if (!box) return;
  const cur = curSite();
  box.innerHTML = `
    <button class="side-link ${!S.siteId ? "active" : ""}" data-go="#/sites"><span class="ico">▦</span> All sites</button>
    ${S.sites.length ? `<div class="switcher"><div class="side-label"><span>Site</span></div>
      <button class="sw-btn" id="sw-btn" aria-haspopup="listbox" aria-expanded="false">
        ${cur ? `<span class="dot ${esc(cur.status)}"></span><span class="sw-txt"><b>${esc(cur.name)}</b><small>${esc(cur.domain || "no domain set")}</small></span>` : `<span class="sw-txt"><b>Choose a site</b><small>${S.sites.length} connected</small></span>`}
        <span class="caret">▾</span></button>
      <div class="sw-menu" id="sw-menu" role="listbox" hidden>
        ${S.sites.map(s => `<button class="sw-item ${s.id === S.siteId ? "on" : ""}" role="option" data-site="${esc(s.id)}"><span class="dot ${esc(s.status)}"></span><span class="sw-txt"><b>${esc(s.name)}</b><small>${esc(s.domain || "no domain set")}</small></span></button>`).join("")}
        <button class="sw-item add" id="sw-add"><span class="ico">＋</span> Add a site</button></div></div>` : ""}
    ${cur ? NAV.map(([g, items]) => `<div class="side-label"><span>${g}</span></div>` + items.map(([k, ic, lb]) =>
      `<button class="side-link ${S.tab === k ? "active" : ""}" data-go="#/site/${esc(cur.id)}/${k}"><span class="ico">${ic}</span>${lb}</button>`).join("")).join("")
      : `<div class="side-hint">${S.sites.length ? "Pick a site above to open its tools." : "Add your first site to get started."}</div>`}
    ${S.sites.length ? "" : `<button class="side-link side-add" id="side-add"><span class="ico">＋</span> Add site</button>`}`;
  $$("[data-go]", box).forEach(b => b.onclick = () => { document.body.classList.remove("nav-open"); location.hash = b.dataset.go; });
  const sw = $("#sw-btn", box), menu = $("#sw-menu", box);
  if (sw) {
    sw.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; sw.setAttribute("aria-expanded", String(!menu.hidden)); };
    $$("[data-site]", menu).forEach(b => b.onclick = () => { menu.hidden = true; location.hash = `#/site/${b.dataset.site}/${S.siteId ? S.tab : "overview"}`; });
    $("#sw-add", menu).onclick = () => { menu.hidden = true; openAddSite(); };
  }
  const add = $("#side-add", box); if (add) add.onclick = () => openAddSite();
}
document.addEventListener("click", () => { const m = $("#sw-menu"); if (m && !m.hidden) { m.hidden = true; const b = $("#sw-btn"); if (b) b.setAttribute("aria-expanded", "false"); } });

function renderCrumbs() {
  const c = $("#crumbs"); if (!c) return;
  const s = curSite();
  c.innerHTML = s ? `<a href="#/sites">Sites</a><span>/</span><a href="#/site/${esc(s.id)}/overview">${esc(s.name)}</a><span>/</span><b>${esc(TAB_LABEL[S.tab] || "")}</b>` : `<b>All sites</b>`;
}

// ---- sites list: loaded once at start (bootstrap), then refreshed quietly in the background -- never on the way to a page
async function refreshSites(force) {
  if (!force && Date.now() - S.sitesAt < 30000) return;
  S.sitesAt = Date.now();
  try { S.sites = await api("/api/sites", { keep: true }); } catch { return; }
  renderSidebar(); renderCrumbs();
}
const loadSites = () => refreshSites(true);
setInterval(() => { if (S.user) refreshSites(false); }, 60000);

// ---------------------------------------------------------------- skeletons (shown instantly, replaced when data arrives)
function skeleton(tab) {
  const block = (h, w = "100%") => `<div class="sk" style="height:${h}px;width:${w}"></div>`;
  const head = `<div class="page-head"><div style="flex:1">${block(12, "120px")}<div style="height:10px"></div>${block(26, "260px")}<div style="height:8px"></div>${block(12, "55%")}</div></div>`;
  const kpis = `<div class="grid g4" style="margin-bottom:16px">${[1, 2, 3, 4].map(() => `<div class="card kpi">${block(12, "60%")}<div style="height:10px"></div>${block(26, "40%")}</div>`).join("")}</div>`;
  const rows = n => Array.from({ length: n }, () => `<div style="padding:12px 0;border-bottom:1px solid var(--border)">${block(14, "70%")}</div>`).join("");
  const body = ["overview", "sites"].includes(tab) ? kpis + `<div class="card card-pad">${block(200)}</div>` : `<div class="card card-pad">${rows(5)}</div>`;
  return `<div class="skeleton" aria-busy="true" aria-label="Loading">${head}${body}</div>`;
}

// ---------------------------------------------------------------- router
function parseRoute() {
  const m = location.hash.match(/^#\/site\/([^/]+)\/([a-z]+)/);
  if (m) return { siteId: decodeURIComponent(m[1]), tab: m[2] };
  return { siteId: null, tab: "sites" };
}
async function route() {
  if (!S.user) return;
  clearInterval(S.timer);
  hideTip();
  const r = parseRoute();
  S.epoch++;                                              // any request still in flight for the previous page is now stale
  S.siteId = r.siteId; S.tab = r.tab;
  if (!$("#view")) renderShell();
  if (S.siteId && !S.sites.find(s => s.id === S.siteId)) {   // maybe a site created a moment ago: look once more
    await refreshSites(true);
    if (!S.sites.find(s => s.id === S.siteId)) { location.hash = "#/sites"; return; }
  }
  renderSidebar(); renderCrumbs();
  const view = $("#view");
  view.innerHTML = skeleton(r.tab);                       // instant feedback: the shape of the page, no blank screen
  const pages = { sites: pageSites, overview: pageOverview, experiments: pageExperiments, campaigns: pageCampaigns, audiences: pageAudiences, goals: pageGoals,
    behavior: pageBehavior, heatmaps: pageHeatmaps, funnels: pageFunnels, visitors: pageVisitors, live: pageLive, settings: pageSettings };
  const mine = S.epoch;
  try { await (pages[r.tab] || pageSites)(view); }
  catch (e) {
    if (e.message === "stale" || e.message === "Please log in" || mine !== S.epoch) return;
    view.innerHTML = `<div class="callout warn">Could not load this page: ${esc(e.message)} <button class="btn sm" id="retry-page" style="margin-left:8px">Try again</button></div>`;
    $("#retry-page").onclick = route;
  }
  if (mine !== S.epoch) return;
  view.classList.remove("fade-in"); void view.offsetWidth; view.classList.add("fade-in");
  window.scrollTo(0, 0);
  refreshSites(false);                                    // keeps the sidebar dots fresh without ever blocking a page
}
window.addEventListener("hashchange", route);

function siteHead(title, sub, actionsHtml = "") {
  const s = curSite();
  return `<div class="page-head"><div><h1>${esc(title)}</h1><div class="sub">${sub}</div></div><div class="row">${actionsHtml}</div></div>`;
}
const rangeSeg = () => `<div class="seg" role="group" aria-label="Date range">${[7, 14, 30, 90].map(d => `<button data-days="${d}" class="${S.days === d ? "on" : ""}">${d}d</button>`).join("")}</div>`;
function bindRange(reload) {
  $$("[data-days]").forEach(b => b.onclick = () => { S.days = +b.dataset.days; reload(); });
}

// ---------------------------------------------------------------- command palette (Ctrl/Cmd + K, or "/")
function paletteItems() {
  const s = curSite(), items = [];
  const go = h => () => { location.hash = h; };
  const then = (tab, fn) => () => { if (S.tab !== tab || !S.siteId) location.hash = `#/site/${s.id}/${tab}`; setTimeout(fn, 120); };
  if (s) {
    TABS.forEach(([k, ic, lb]) => items.push({ label: lb, hint: `Go to · ${s.name}`, icon: ic, run: go(`#/site/${s.id}/${k}`) }));
    items.push({ label: "New personalization campaign", hint: "Create", icon: "＋", run: then("campaigns", () => openNewCampaign(s)) });
    items.push({ label: "New A/B test", hint: "Create", icon: "＋", run: then("experiments", () => openNewExperiment(s)) });
    items.push({ label: "New goal", hint: "Create", icon: "＋", run: then("goals", () => openGoalModal(s, null)) });
    items.push({ label: "New audience", hint: "Create", icon: "＋", run: then("audiences", () => openSegmentModal(s, null)) });
    items.push({ label: "New funnel", hint: "Create", icon: "＋", run: then("funnels", () => openNewFunnel(s)) });
  }
  S.sites.forEach(x => items.push({ label: `Switch to ${x.name}`, hint: x.domain || "site", icon: "⇄", run: go(`#/site/${x.id}/${s ? S.tab : "overview"}`) }));
  items.push({ label: "All sites", hint: "Go to", icon: "▦", run: go("#/sites") });
  items.push({ label: "Add a site", hint: "Create", icon: "＋", run: () => openAddSite() });
  items.push({ label: "Toggle light / dark theme", hint: "Appearance", icon: "◐", run: toggleTheme });
  return items;
}
function openPalette() {
  if ($("#palette")) return;
  const all = paletteItems();
  const ov = document.createElement("div");
  ov.id = "palette"; ov.className = "overlay pal";
  ov.innerHTML = `<div class="pal-box" role="dialog" aria-modal="true" aria-label="Search"><input id="pal-in" type="text" placeholder="Jump to a page, switch site, or create something…" autocomplete="off" aria-label="Search"><div id="pal-list" role="listbox"></div></div>`;
  document.body.appendChild(ov);
  let sel = 0, shown = all;
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey, true); };
  const paint = () => {
    $("#pal-list", ov).innerHTML = shown.length ? shown.slice(0, 14).map((it, i) =>
      `<button class="pal-item ${i === sel ? "on" : ""}" role="option" data-i="${i}"><span class="ico">${esc(it.icon)}</span><span class="grow">${esc(it.label)}</span><small>${esc(it.hint)}</small></button>`).join("")
      : `<div class="pal-empty">Nothing matches “${esc($("#pal-in", ov).value)}”</div>`;
    $$(".pal-item", ov).forEach(b => { b.onclick = () => { const it = shown[+b.dataset.i]; close(); it.run(); }; b.onmousemove = () => { sel = +b.dataset.i; $$(".pal-item", ov).forEach(x => x.classList.toggle("on", x === b)); }; });
  };
  const filter = () => {
    const q = $("#pal-in", ov).value.trim().toLowerCase();
    shown = q ? all.filter(it => (it.label + " " + it.hint).toLowerCase().includes(q)) : all; sel = 0; paint();
  };
  const onKey = e => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, Math.min(shown.length, 14) - 1); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
    else if (e.key === "Enter") { e.preventDefault(); const it = shown[sel]; if (it) { close(); it.run(); } }
  };
  document.addEventListener("keydown", onKey, true);
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $("#pal-in", ov).addEventListener("input", filter);
  paint(); $("#pal-in", ov).focus();
}
document.addEventListener("keydown", e => {
  if (!S.user || !$("#view")) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName) || (document.activeElement || {}).isContentEditable;
  if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !typing && !$("#modal-root .overlay"))) { e.preventDefault(); openPalette(); }
});

// ---------------------------------------------------------------- start
async function boot() {
  try {
    const b = await api("/api/bootstrap", { keep: true });      // user + all sites in ONE request
    S.user = b.user; S.sites = b.sites; S.sitesAt = Date.now();
  } catch { return renderLogin(); }
  renderShell();
  if (!location.hash) location.hash = "#/sites";
  route();
}
window.addEventListener("DOMContentLoaded", boot);
