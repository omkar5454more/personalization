/* Core: helpers, API client, auth, router, sidebar. Pages live in pages.js, dialogs in modals.js. */
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

const S = { user: null, sites: [], siteId: null, tab: "overview", days: 14, behavior: "pages", timer: null };

async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", headers: {} };
  if (opts.body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  const r = await fetch(path, init);
  if (r.status === 401 && !path.startsWith("/api/auth/")) { renderLogin(); throw new Error("Please log in"); }
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))).detail;
    throw new Error(typeof d === "string" ? d : Array.isArray(d) ? d.map(x => x.msg).join("; ") : r.statusText);
  }
  return r.status === 204 ? null : r.json();
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

// ---- shell + sidebar
const TABS = [
  ["overview", "◧", "Overview"], ["experiments", "⚗", "A/B tests"], ["campaigns", "✦", "Personalization"],
  ["behavior", "⌖", "Behavior"], ["heatmaps", "◍", "Heatmaps"], ["funnels", "⏷", "Funnels"], ["visitors", "☺", "Visitors"], ["live", "●", "Live feed"], ["settings", "⚙", "Install & settings"],
];
const STATUS_LABEL = { live: "Live now", receiving: "Receiving data", idle: "No recent data", waiting: "Waiting for data" };
const statusPill = s => `<span class="pill ${esc(s)}"><span class="dot ${esc(s)}"></span>${esc(STATUS_LABEL[s] || s)}</span>`;

function renderShell() {
  $("#root").innerHTML = `<div id="app"><aside id="sidebar">
    <div class="brand"><span class="logo">◎</span> Optimize</div>
    <div class="side-scroll" id="side-scroll"></div>
    <div class="side-foot"><div class="who" id="who"></div>
      <div class="row"><button id="theme-btn" title="Toggle light/dark">◐ Theme</button><button id="logout-btn">Log out</button></div></div>
  </aside><main id="view" tabindex="-1"></main></div>`;
  $("#who").textContent = S.user?.email || "";
  $("#theme-btn").onclick = toggleTheme;
  $("#logout-btn").onclick = async () => { await api("/api/auth/logout", { method: "POST" }); S.user = null; renderLogin(); };
}

function renderSidebar() {
  const box = $("#side-scroll"); if (!box) return;
  const onHome = !S.siteId;
  box.innerHTML = `
    <button class="side-link ${onHome ? "active" : ""}" data-go="#/sites"><span class="ico">▦</span> All sites</button>
    <div class="side-label"><span>Your sites (${S.sites.length})</span></div>
    ${S.sites.map(s => `<div class="site-block">
      <button class="side-link side-site ${S.siteId === s.id && S.tab === "overview" ? "active" : ""}" data-go="#/site/${esc(s.id)}/overview" title="${esc(s.domain || s.name)}">
        <span class="dot ${esc(s.status)}"></span>
        <span style="min-width:0"><div class="nm">${esc(s.name)}</div><div class="dm">${esc(s.domain || "no domain set")}</div></span></button>
      ${S.siteId === s.id ? `<div class="sub">${TABS.map(([k, ic, lb]) => `<button class="side-link ${S.tab === k ? "active" : ""}" data-go="#/site/${esc(s.id)}/${k}"><span class="ico">${ic}</span>${lb}</button>`).join("")}</div>` : ""}
    </div>`).join("")}
    <button class="side-link" id="side-add" style="margin-top:8px;border:1px dashed var(--side-border)"><span class="ico">＋</span> Add site</button>`;
  $$("[data-go]", box).forEach(b => b.onclick = () => { location.hash = b.dataset.go; });
  $("#side-add").onclick = () => openAddSite();
}

async function loadSites() {
  S.sites = await api("/api/sites");
  renderSidebar();
}

// ---- router
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
  S.siteId = r.siteId; S.tab = r.tab;
  if (!$("#view")) renderShell();
  try { await loadSites(); } catch { return; }
  if (S.siteId && !S.sites.find(s => s.id === S.siteId)) { location.hash = "#/sites"; return; }
  renderSidebar();
  const view = $("#view");
  view.innerHTML = `<div class="muted">Loading…</div>`;
  const pages = { sites: pageSites, overview: pageOverview, experiments: pageExperiments, campaigns: pageCampaigns,
    behavior: pageBehavior, heatmaps: pageHeatmaps, funnels: pageFunnels, visitors: pageVisitors, live: pageLive, settings: pageSettings };
  try { await (pages[r.tab] || pageSites)(view); }
  catch (e) { if (e.message !== "Please log in") view.innerHTML = `<div class="callout warn">Could not load this page: ${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

const curSite = () => S.sites.find(s => s.id === S.siteId);
function siteHead(title, sub, actionsHtml = "") {
  const s = curSite();
  return `<div class="page-head"><div><div class="crumbs">${esc(s.name)}${s.domain ? " · " + esc(s.domain) : ""}</div>
    <h1>${esc(title)}</h1><div class="sub">${sub}</div></div><div class="row">${actionsHtml}</div></div>`;
}
const rangeSeg = () => `<div class="seg" role="group" aria-label="Date range">${[7, 14, 30, 90].map(d => `<button data-days="${d}" class="${S.days === d ? "on" : ""}">${d}d</button>`).join("")}</div>`;
function bindRange(reload) {
  $$("[data-days]").forEach(b => b.onclick = () => { S.days = +b.dataset.days; reload(); });
}

async function boot() {
  try { S.user = await api("/api/auth/me"); } catch { return renderLogin(); }
  renderShell();
  if (!location.hash) location.hash = "#/sites";
  route();
}
window.addEventListener("DOMContentLoaded", boot);
