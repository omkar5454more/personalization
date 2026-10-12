/* Optimize SDK. Vanilla JS, no dependencies.
 *
 * Boot order: fetch site config -> (consent check) -> start trackers, run experiments/campaigns.
 * Nothing is written to cookies/localStorage and nothing is sent until the site's consent
 * requirement (if enabled in the dashboard) has been met via OT.consent(true).
 */
(function () {
  "use strict";
  var script = document.currentScript || document.querySelector("script[data-site]");
  if (!script) return;
  var SITE = script.getAttribute("data-site");
  var ORIGIN = new URL(script.src).origin;
  var STORE = "_ot_v1", CONSENT = "_ot_consent";
  var SESSION_GAP_MS = 30 * 60 * 1000, IDLE_MS = 15000;

  // ---- dashboard-opened modes: the visual editor or a heatmap overlay. Load that tool and do
  // nothing else (no tracking, no experiments) so viewing never pollutes real data.
  var MODE = null, PARENT = null;
  try {
    var hh = location.hash, wn = window.name;
    if (window.opener) {
      if (hh.indexOf("ot_editor") !== -1 || wn === "ot_editor") MODE = "editor";
      else if (hh.indexOf("ot_heatmap") !== -1 || wn === "ot_heatmap") MODE = "heatmap";
    }
    // campaign preview: opened in a tab (opener) or shown in the dashboard's own iframe (parent)
    if (!MODE && (hh.indexOf("ot_preview") !== -1 || wn === "ot_preview") && (window.opener || window.parent !== window)) {
      MODE = "preview"; PARENT = window.opener || window.parent;
    }
  } catch (e) {}
  if (MODE && MODE !== "preview") {
    var h0 = document.getElementById("ot-hide");
    if (h0 && h0.parentNode) h0.parentNode.removeChild(h0);
    var es = document.createElement("script");
    es.src = ORIGIN + (MODE === "editor" ? "/editor.js" : "/heatmap.js"); es.async = true;
    es.setAttribute("data-overlay", "1");
    document.head.appendChild(es);
    return;
  }

  function reveal() {
    var h = document.getElementById("ot-hide");
    if (h && h.parentNode) h.parentNode.removeChild(h);
  }

  // ---------------------------------------------------------------- storage
  var persist = false; // flips on only once tracking is allowed
  function readCookie() {
    var m = document.cookie.match(/(?:^|; )_ot=([^;]*)/);
    return m ? m[1] : null;
  }
  function loadState() {
    var raw = null;
    try { raw = localStorage.getItem(STORE); } catch (e) {}
    if (!raw) { var c = readCookie(); if (c) { try { raw = decodeURIComponent(c); } catch (e) {} } }
    try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function saveState(s) {
    if (!persist) return;
    var raw = JSON.stringify(s);
    try { localStorage.setItem(STORE, raw); } catch (e) {}
    document.cookie = "_ot=" + encodeURIComponent(raw) + ";max-age=31536000;path=/;SameSite=Lax";
  }
  function wipeState() {
    try { localStorage.removeItem(STORE); } catch (e) {}
    document.cookie = "_ot=;max-age=0;path=/";
  }
  function rid() {
    var a = new Uint8Array(8);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  var now = Date.now();
  var st = loadState();
  var returning = !!st;
  if (!st) st = { vid: rid(), first: now, last: now, visits: 1, sid: rid(), assign: {}, goals: {} };
  else if (now - st.last > SESSION_GAP_MS) { st.sid = rid(); st.visits = (st.visits || 1) + 1; }
  st.assign = st.assign || {}; st.goals = st.goals || {}; st.utm = st.utm || {}; st.pers = st.pers || {};
  st.attrs = st.attrs || {}; st.done = st.done || {}; st.gdone = st.gdone || {};
  st.cnt = st.cnt || {}; st.lastShown = st.lastShown || {}; st.hold = st.hold || {}; st.cgoal = st.cgoal || {};
  var daysSinceLast = returning ? Math.floor((now - st.last) / 86400000) : 0;
  st.last = now;

  var visitor = {
    id: st.vid,
    isReturning: returning && st.visits > 1,
    visitNo: st.visits,
    daysSinceFirst: Math.floor((now - st.first) / 86400000),
    daysSinceLast: daysSinceLast
  };

  // ---------------------------------------------------------------- transport
  var active = false, queue = [], flushTimer = null, settings = {}, curUrl = "", pid = rid();
  function pageUrl() { return location.pathname + location.search; }
  function push(ev) {
    if (!active) return;
    ev.vid = visitor.id; ev.sid = st.sid; ev.url = ev.url || pageUrl();
    ev.visit_no = visitor.visitNo; ev.returning = visitor.isReturning;
    if (ev.type === "event" && ev.name && (st.done[ev.name] || Object.keys(st.done).length < 50)) st.done[ev.name] = (st.done[ev.name] || 0) + 1;
    queue.push(ev);
    st.last = Date.now();
    if (queue.length >= 20) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, 1500);
  }
  function flush() {
    clearTimeout(flushTimer); flushTimer = null;
    if (!queue.length) return;
    saveState(st);
    var body = JSON.stringify({ site: SITE, host: location.hostname, events: queue.splice(0, queue.length) });
    var url = ORIGIN + "/collect";
    if (navigator.sendBeacon && navigator.sendBeacon(url, body)) return;
    try { fetch(url, { method: "POST", body: body, keepalive: true }); } catch (e) {}
  }

  // ---------------------------------------------------------------- analytics bridge (site setting "Send events to Google Analytics")
  function analytics(name, data) {
    if (!settings.ga_events) return;
    try {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(Object.assign({ event: name }, data));
      if (typeof window.gtag === "function") window.gtag("event", name, data);
    } catch (e) {}
  }
  var forced = "";   // QA link: ?ot_force=<campaign id> shows that campaign regardless of rules, frequency and triggers (nothing is tracked)
  try { forced = new URLSearchParams(location.search).get("ot_force") || ""; } catch (e) {}

  // ---------------------------------------------------------------- A/B testing
  function hash(str) { // FNV-1a
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h;
  }
  function assign(exp) {
    if (st.assign[exp.id]) {
      var kept = exp.variants.filter(function (v) { return v.key === st.assign[exp.id]; })[0];
      if (kept) return kept;
    }
    if (hash(visitor.id + ":traffic:" + exp.id) % 100 >= exp.traffic) return null; // not in test
    var total = exp.variants.reduce(function (s, v) { return s + Math.max(v.weight, 0); }, 0);
    var pick = hash(visitor.id + ":" + exp.id) % total, acc = 0;
    for (var i = 0; i < exp.variants.length; i++) {
      acc += Math.max(exp.variants[i].weight, 0);
      if (pick < acc) { st.assign[exp.id] = exp.variants[i].key; saveState(st); return exp.variants[i]; }
    }
    return null;
  }
  function applyChange(c) {
    var nodes;
    try { nodes = document.querySelectorAll(c.selector); } catch (e) { return false; }
    if (!nodes.length) return false;
    Array.prototype.forEach.call(nodes, function (n) {
      if (c.action === "text") n.textContent = c.value;
      else if (c.action === "html") n.innerHTML = c.value; // value comes from the account owner's dashboard
      else if (c.action === "css") n.style.cssText += ";" + c.value;
      else if (c.action === "attr" && c.attr) n.setAttribute(c.attr, c.value);
      else if (c.action === "hide") n.style.display = "none";
    });
    return true;
  }
  function applyWithRetry(changes) {
    var pending = changes.slice();
    function run() { pending = pending.filter(function (c) { return !applyChange(c); }); }
    run();
    if (!pending.length) return;
    var obs = new MutationObserver(function () { run(); if (!pending.length) obs.disconnect(); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", run);
    setTimeout(function () { obs.disconnect(); }, 5000);
  }
  function fireGoal(exp, variantKey) {
    if (st.goals[exp.id]) return; // one conversion per visitor per test
    st.goals[exp.id] = 1; saveState(st);
    push({ type: "goal", exp: exp.id, variant: variantKey, name: exp.goal.type });
    analytics("optimize_goal", { optimize_id: exp.id, optimize_name: exp.name, optimize_variant: variantKey });
  }
  var watched = {};
  function watchGoal(exp, variantKey) {
    var wk = exp.id + ":" + variantKey, g = exp.goal;
    if (g.type === "pageview" && g.url_contains) {         // checked on every page (single-page apps change the address without reloading)
      if (location.href.indexOf(g.url_contains) !== -1) fireGoal(exp, variantKey);
      return;
    }
    if (watched[wk]) return; watched[wk] = 1;              // click / event / form listeners are added only once
    if (g.type === "click" && g.selector) {
      document.addEventListener("click", function (ev) {
        try { if (ev.target.closest && ev.target.closest(g.selector)) fireGoal(exp, variantKey); } catch (e) {}
      }, true);
    } else if (g.type === "event" && g.name) {
      window.addEventListener("ot:event:" + g.name, function () { fireGoal(exp, variantKey); });
    } else if (g.type === "form" && g.form_name) {
      document.addEventListener("submit", function (ev) {
        try { if (ev.target && ev.target.tagName === "FORM" && formId(ev.target).toLowerCase().indexOf(g.form_name.toLowerCase()) !== -1) fireGoal(exp, variantKey); } catch (e) {}
      }, true);
    }
  }
  function runExperiments(list, ctx) {
    var redirecting = false;
    (list || []).forEach(function (exp) {
      if (redirecting) return;
      if (exp.rollout) {   // finished test whose winner is kept on for everyone: apply it, record nothing
        var rv = exp.variants.filter(function (x) { return x.key === exp.rollout; })[0];
        if (!rv || !campaignMatches(exp, ctx)) return;
        if (rv.redirect_url && location.href.indexOf(rv.redirect_url) === -1) { redirecting = true; location.replace(rv.redirect_url); return; }
        if (rv.changes && rv.changes.length) applyWithRetry(rv.changes);
        return;
      }
      if (exp.url_contains && location.href.indexOf(exp.url_contains) === -1) {
        if (st.assign[exp.id]) watchGoal(exp, st.assign[exp.id]); // goal may live on another page
        return;
      }
      // Audience: only visitors who match are entered into the test; someone already in it stays in it.
      if (!st.assign[exp.id] && !campaignMatches(exp, ctx)) return;
      var v = assign(exp);
      if (!v) return;
      push({ type: "exposure", exp: exp.id, variant: v.key });
      analytics("optimize_test_exposure", { optimize_id: exp.id, optimize_name: exp.name, optimize_variant: v.key });
      watchGoal(exp, v.key);
      if (v.redirect_url && location.href.indexOf(v.redirect_url) === -1) {
        flush(); redirecting = true; location.replace(v.redirect_url); return;
      }
      if (v.changes && v.changes.length) applyWithRetry(v.changes);
    });
    return redirecting;
  }

  // ---------------------------------------------------------------- personalization
  function captureAttribution() {
    var q = new URLSearchParams(location.search);
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach(function (k) {
      if (q.get(k)) st.utm[k] = q.get(k).slice(0, 100);
    });
    // search keyword: the ad keyword (utm_term) or an on-site/search-landing query parameter
    var kw = q.get("utm_term") || q.get("q") || q.get("query") || q.get("keyword") || q.get("s");
    if (kw) st.kw = kw.slice(0, 100);
    if (!st.ref) st.ref = document.referrer.slice(0, 300);
  }
  // pages viewed in the current visit and the page the visit started on
  function countPage() {
    if (st.pvSid !== st.sid) { st.pvSid = st.sid; st.pvN = 0; st.landing = pageUrl(); st.vsrc = classifySource(); }
    st.pvN = (st.pvN || 0) + 1;
    st.tp = (st.tp || 0) + 1;                                   // page views across ALL visits (a refresh counts)
    st.paths = st.paths || [];
    var pth = location.pathname.toLowerCase().slice(0, 80);
    if (st.paths.indexOf(pth) === -1 && st.paths.length < 60) st.paths.push(pth);
  }
  // How this visit started: paid (utm_medium cpc/ppc/...), email, organic search, social, referral (another site) or direct.
  function classifySource() {
    var q = new URLSearchParams(location.search), med = (q.get("utm_medium") || "").toLowerCase(), src = (q.get("utm_source") || "").toLowerCase();
    var host = ""; try { host = new URL(document.referrer).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) {}
    if (/^(cpc|ppc|paid|paidsearch|paid_social|paidsocial|display|cpm|banner)$/.test(med)) return "paid";
    if (med === "email" || /mail/.test(src)) return "email";
    if (host && host === location.hostname.replace(/^www\./, "").toLowerCase()) host = "";   // our own site is not a source
    if (!host) return (med || src) ? "other" : "direct";
    if (/(^|\.)(google|bing|yahoo|duckduckgo|baidu|yandex|ecosia|brave|startpage|ask)\./.test(host)) return "organic";
    if (/(facebook|instagram|linkedin|twitter|^x\.com|^t\.co|youtube|youtu\.be|pinterest|reddit|whatsapp|telegram|tiktok|snapchat)/.test(host)) return "social";
    return "referral";
  }
  function refHost() { try { return new URL(st.ref || document.referrer).hostname.replace(/^www\./, ""); } catch (e) { return ""; } }
  function osName() {
    var u = navigator.userAgent || "";
    return /iPhone|iPad|iPod/i.test(u) ? "ios" : /Android/i.test(u) ? "android" : /Windows/i.test(u) ? "windows" : /Mac OS X|Macintosh/i.test(u) ? "macos" : /Linux/i.test(u) ? "linux" : "other";
  }
  function browserName() {
    var u = navigator.userAgent || "";
    return /Edg\//.test(u) ? "edge" : /Firefox|FxiOS/.test(u) ? "firefox" : /Chrome|CriOS/.test(u) ? "chrome" : /Safari/.test(u) ? "safari" : "other";
  }
  function deviceType() {
    var w = Math.min(window.innerWidth || 1024, screen.width || 1024);
    return w < 768 ? "mobile" : w < 1024 ? "tablet" : "desktop";
  }
  function context(geo) {
    geo = (geo && typeof geo === "object") ? geo : { country: geo || "" };
    var d = new Date();
    var c = {
      returning: String(visitor.isReturning), visit_no: visitor.visitNo,
      days_since_last: visitor.daysSinceLast, days_since_first: visitor.daysSinceFirst,
      utm_source: st.utm.utm_source || "", utm_medium: st.utm.utm_medium || "",
      utm_campaign: st.utm.utm_campaign || "", utm_term: st.utm.utm_term || "", utm_content: st.utm.utm_content || "",
      device: deviceType(), os: osName(), browser: browserName(), language: (navigator.language || "").slice(0, 2).toLowerCase(),
      country: (geo.country || "").toUpperCase(), region: geo.region || "", city: geo.city || "", ip: geo.ip || "", hour: d.getHours(), weekday: d.getDay(),
      traffic_source: st.vsrc || "direct", total_pageviews: st.tp || 1,
      url: location.href, referrer: st.ref || document.referrer || "", referrer_host: refHost(),
      search_keyword: st.kw || "", landing_page: st.landing || pageUrl(), pages_viewed: st.pvN || 1,
      customer: String(st.attrs.customer === true || String(st.attrs.customer).toLowerCase() === "true" || (st.done.purchase || 0) > 0)
    };
    Object.keys(st.attrs).forEach(function (k) { c["attr." + k] = String(st.attrs[k]); });
    return c;
  }
  function ipToInt(ip) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip));
    if (!m) return null;
    var n = 0;
    for (var i = 1; i <= 4; i++) { var o = +m[i]; if (o > 255) return null; n = n * 256 + o; }
    return n;
  }
  // value = comma separated: a single address, a range a.b.c.d-e.f.g.h, or a CIDR block a.b.c.d/24 (IPv4; IPv6 only as an exact address)
  function ipMatches(actual, want) {
    var a = ipToInt(actual);
    return String(want).split(",").some(function (e) {
      e = e.trim(); if (!e) return false;
      if (e.indexOf("/") !== -1) {
        var p = e.split("/"), base = ipToInt(p[0]), bits = +p[1];
        if (a === null || base === null || isNaN(bits) || bits < 0 || bits > 32) return false;
        var size = Math.pow(2, 32 - bits), start = Math.floor(base / size) * size;
        return a >= start && a < start + size;
      }
      if (e.indexOf("-") !== -1 && e.indexOf(":") === -1) {
        var q = e.split("-"), lo = ipToInt(q[0].trim()), hi = ipToInt(q[1].trim());
        return a !== null && lo !== null && hi !== null && a >= lo && a <= hi;
      }
      return String(actual).toLowerCase() === e.toLowerCase();
    });
  }
  function ruleMatches(r, ctx) {
    if (r.field === "ip") {
      if (!ctx.ip) return false;                       // address unknown: never guess
      var hit = ipMatches(ctx.ip, r.value);
      return r.op === "neq" ? !hit : hit;
    }
    if (r.field === "did_event") {   // "has the visitor ever fired this custom event (e.g. purchase)?"
      var did = (st.done[r.value] || 0) > 0;
      return r.op === "neq" ? !did : did;
    }
    if (r.field === "visited_page") {   // has the visitor ever opened a page whose address contains this text?
      var vis = (st.paths || []).some(function (p) { return p.indexOf(String(r.value).toLowerCase()) !== -1; });
      return r.op === "neq" ? !vis : vis;
    }
    var actual, want = r.value;
    if (r.field.indexOf("param.") === 0) actual = urlParam(r.field.slice(6));
    else if (r.field.indexOf("cookie.") === 0) actual = cookieValue(r.field.slice(7));
    else if (r.field.indexOf("var.") === 0) actual = windowVar(r.field.slice(4));
    else actual = ctx[r.field];
    if (actual === undefined) return false;
    var an = Number(actual), wn = Number(want), numeric = !isNaN(an) && want !== "" && !isNaN(wn);
    switch (r.op) {
      case "eq": return String(actual).toLowerCase() === String(want).toLowerCase();
      case "neq": return String(actual).toLowerCase() !== String(want).toLowerCase();
      case "gte": return numeric && an >= wn;
      case "lte": return numeric && an <= wn;
      case "contains": return String(actual).toLowerCase().indexOf(String(want).toLowerCase()) !== -1;
      case "not_contains": return String(actual).toLowerCase().indexOf(String(want).toLowerCase()) === -1;
      case "starts": return String(actual).toLowerCase().indexOf(String(want).toLowerCase()) === 0;
      case "in": return String(want).split(",").some(function (x) { return x.trim().toLowerCase() === String(actual).toLowerCase(); });
    }
    return false;
  }
  // values that are read live from the page rather than from the saved visitor facts
  function urlParam(name) { try { return new URLSearchParams(location.search).get(name) || ""; } catch (e) { return ""; } }
  function cookieValue(name) {
    var m = document.cookie.split("; ");
    for (var i = 0; i < m.length; i++) { var kv = m[i].split("="); if (kv[0] === name) { try { return decodeURIComponent(kv.slice(1).join("=")); } catch (e) { return kv.slice(1).join("="); } } }
    return "";
  }
  function windowVar(path) {   // plain property reads only (no code is evaluated); objects / functions count as empty
    var v = window, parts = path.split(".");
    try { for (var i = 0; i < parts.length; i++) { if (v === null || v === undefined) return ""; v = v[parts[i]]; } } catch (e) { return ""; }
    return (typeof v === "string" || typeof v === "number" || typeof v === "boolean") ? String(v) : "";
  }
  function evalRule(r, ctx) {
    if (r.field === "__group") {
      var t = function (x) { return ruleMatches(x, ctx); };
      return !r.rules || !r.rules.length ? true : (r.match === "any" ? r.rules.some(t) : r.rules.every(t));
    }
    return ruleMatches(r, ctx);
  }
  // Which pages it runs on: every page, address starts with, contains, or is exactly (query string and #hash ignored for starts/exactly).
  function pageMatches(c) {
    var mode = c.page_match || "contains", v = (c.url_contains || "").trim().toLowerCase();
    if (mode === "all" || !v) return true;
    var full = location.href.toLowerCase(), bare = full.split("#")[0].split("?")[0], path = location.pathname.toLowerCase();
    var strip = function (x) { return x.replace(/\/+$/, ""); };
    if (mode === "starts") return bare.indexOf(v) === 0 || path.indexOf(v) === 0;
    if (mode === "equals") return strip(bare) === strip(v) || strip(path) === strip(v);
    return full.indexOf(v) !== -1;
  }
  function campaignMatches(c, ctx) {
    if (!pageMatches(c)) return false;
    if (!c.rules || !c.rules.length) return true;
    var test = function (r) { return evalRule(r, ctx); };
    return c.match === "any" ? c.rules.some(test) : c.rules.every(test);
  }
  function frequencyAllows(c) {
    if (c.frequency === "once" && st.pers[c.id]) return false;
    if (c.frequency === "session" && st.pers[c.id] === st.sid) return false;
    if (c.max_views && (st.cnt[c.id] || 0) >= c.max_views) return false;                                    // "at most N times"
    if (c.cooldown_hours && st.lastShown[c.id] && Date.now() - st.lastShown[c.id] < c.cooldown_hours * 3600000) return false;   // "wait H hours"
    return true;
  }
  function markShown(c) {
    st.pers[c.id] = c.frequency === "session" ? st.sid : 1;
    st.cnt[c.id] = (st.cnt[c.id] || 0) + 1; st.lastShown[c.id] = Date.now();
    saveState(st);
  }
  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text) n.textContent = text; // textContent: dashboard-supplied copy is never parsed as HTML
    return n;
  }
  function safeUrl(u) { return /^(https?:\/\/|\/)/.test(u) ? u : null; }
  function ctaLink(c, a, css) {
    var href = a.cta_url && safeUrl(a.cta_url);
    if (!a.cta_text || !href) return null;
    var link = el("a", css, a.cta_text);
    link.href = href;
    link.addEventListener("click", function () { push({ type: "click", exp: c.id, variant: "cta" }); flush(); });
    return link;
  }
  // Banner look. NOTE: public/app/modals.js (bannerCss) draws the live preview in the dashboard with the same
  // formula -- keep the two in sync.
  var BANNER_PAD = { small: "6px", medium: "10px", large: "18px" };
  function bannerCss(a) {
    var pv = BANNER_PAD[a.size] || BANNER_PAD.medium, fs = a.font_size || 15, r = a.radius || 0;
    return "padding:" + pv + " " + (a.closable === false ? "16px" : "44px") + " " + pv + " 16px;text-align:" + (a.align || "center") +
      ";font:" + (a.bold ? "700 " : "") + fs + "px/1.4 system-ui,sans-serif;background:" + a.bg + ";color:" + a.fg + (r ? ";border-radius:" + r + "px" : "");
  }
  function showBanner(c, a) {
    var bottom = a.position === "bottom", r = a.radius || 0;
    var edge = r ? "left:12px;right:12px;" + (bottom ? "bottom:12px" : "top:12px") : "left:0;right:0;" + (bottom ? "bottom:0" : "top:0");
    var bar = el("div", "position:fixed;" + edge + ";z-index:2147483000;" + bannerCss(a));
    bar.setAttribute("role", "region"); bar.setAttribute("aria-label", "Announcement");
    bar.setAttribute("data-ot-ignore", "1");
    bar.appendChild(el("span", "", a.text));
    var link = ctaLink(c, a, a.cta_bg
      ? "display:inline-block;margin-left:12px;padding:4px 14px;border-radius:999px;text-decoration:none;font-weight:600;background:" + a.cta_bg + ";color:" + (a.cta_fg || "#ffffff")
      : "margin-left:12px;color:" + (a.cta_fg || a.fg) + ";font-weight:600;text-decoration:underline");
    if (link) bar.appendChild(link);
    if (a.closable !== false) {
      var x = el("button", "position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:0;color:" + a.fg + ";font-size:20px;cursor:pointer", "×");
      x.setAttribute("aria-label", "Dismiss");
      x.onclick = function () { bar.remove(); };
      bar.appendChild(x);
    }
    document.body.appendChild(bar);
  }
  function showPopup(c, a) {
    var wrap = el("div", "position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px");
    wrap.setAttribute("data-ot-ignore", "1");
    var box = el("div", "background:#fff;color:#111;max-width:420px;width:100%;border-radius:12px;padding:24px;font:15px/1.5 system-ui,sans-serif;position:relative;box-shadow:0 10px 40px rgba(0,0,0,.3)");
    box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
    if (a.title) box.appendChild(el("h2", "margin:0 0 8px;font-size:20px", a.title));
    if (a.text) box.appendChild(el("p", "margin:0 0 16px", a.text));
    var link = ctaLink(c, a, "display:inline-block;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;background:" + (a.cta_bg || a.bg) + ";color:" + (a.cta_fg || a.fg));
    if (link) box.appendChild(link);
    var x = el("button", "position:absolute;right:10px;top:6px;background:none;border:0;font-size:22px;cursor:pointer;color:#555", "×");
    x.setAttribute("aria-label", "Close");
    function close() { wrap.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    x.onclick = close;
    wrap.addEventListener("click", function (e) { if (e.target === wrap) close(); });
    document.addEventListener("keydown", onKey);
    box.appendChild(x); wrap.appendChild(box); document.body.appendChild(wrap);
    x.focus();
  }
  // ---- custom code campaigns (HTML + CSS + JS). This is the account owner's own code running on their
  // own site -- the same trust model as a tag manager. HTML scripts are re-created so they execute
  // (innerHTML never runs <script>), external ones are loaded in order, then the JS tab runs.
  var baseCss = false;
  function ensureBaseCss() {
    if (baseCss) return; baseCss = true;
    var st1 = document.createElement("style"); st1.setAttribute("data-ot", "base");
    // class selectors only, so a campaign's own "#ot-slot-..." CSS always wins
    st1.textContent =
      ".ot-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto}" +
      ".ot-card{position:relative;background:#fff;color:#111;border-radius:12px;padding:24px;max-width:520px;width:100%;font:15px/1.5 system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.3);box-sizing:border-box}" +
      ".ot-slidein{position:fixed;right:20px;bottom:20px;z-index:2147483001;width:360px;max-width:calc(100vw - 40px);max-height:calc(100vh - 40px);overflow:auto}" +
      ".ot-close{position:absolute;right:10px;top:6px;background:none;border:0;font-size:24px;line-height:1;cursor:pointer;color:#555}";
    document.head.appendChild(st1);
  }
  function whenElement(selector, cb) {
    var found = null;
    try { found = document.querySelector(selector); } catch (e) { return; }
    if (found) return cb(found);
    var obs = new MutationObserver(function () {
      var f = null; try { f = document.querySelector(selector); } catch (e) {}
      if (f) { obs.disconnect(); cb(f); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(function () { obs.disconnect(); }, 8000);
  }
  function loadScriptsInOrder(list, container, done) {
    var i = 0;
    (function next() {
      if (i >= list.length) return done();
      var def = list[i++], sc = document.createElement("script"), fired = false;
      def.attrs.forEach(function (at) { try { sc.setAttribute(at[0], at[1]); } catch (e) {} });
      if (def.src) {
        var go = function () { if (!fired) { fired = true; next(); } };
        sc.async = false; sc.onload = go; sc.onerror = go;
        setTimeout(go, 8000);              // never let one slow/blocked script stall the rest
        sc.src = def.src; container.appendChild(sc);
      } else { sc.text = def.text; container.appendChild(sc); next(); }
    })();
  }
  function renderCustom(c, a, announce) {
    ensureBaseCss();
    announce();
    var cid = "ot-slot-" + c.id;
    var box = document.createElement("div");
    box.id = cid; box.className = "ot-custom" + (a.display !== "inline" ? " ot-card" + (a.display === "slidein" ? " ot-slidein" : "") : "");
    if (a.css) {
      var st2 = document.createElement("style"); st2.setAttribute("data-ot", c.id);
      st2.textContent = a.css.replace(/\{\{\s*container\s*\}\}/g, "#" + cid);
      document.head.appendChild(st2);
    }
    // parse in an inert <template> so scripts do not run yet; pull them out to run in order later
    var tpl = document.createElement("template"); tpl.innerHTML = a.html || "";
    var scripts = [];
    Array.prototype.forEach.call(tpl.content.querySelectorAll("script"), function (sc) {
      scripts.push({ src: sc.getAttribute("src"), text: sc.text,
        attrs: Array.prototype.map.call(sc.attributes, function (x) { return [x.name, x.value]; }).filter(function (x) { return x[0] !== "src"; }) });
      sc.parentNode.removeChild(sc);
    });
    box.appendChild(tpl.content);

    var outer = box;                       // what gets removed on close
    function remove() { if (outer.parentNode) outer.parentNode.removeChild(outer); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") remove(); }
    function addClose() {
      var x = el("button", "", "×"); x.className = "ot-close"; x.setAttribute("aria-label", "Close"); x.onclick = remove; box.appendChild(x);
    }

    var interacted = false;
    function conversion(name) {
      if (st.goals[c.id]) return; st.goals[c.id] = 1; saveState(st);
      push({ type: "goal", exp: c.id, variant: "submit", name: String(name || "form_submit").slice(0, 60) });
      flush();
    }
    box.addEventListener("click", function () { if (!interacted) { interacted = true; push({ type: "click", exp: c.id, variant: "interact" }); } }, true);
    box.addEventListener("submit", function () { conversion("form_submit"); }, true);   // native <form>s
    window.addEventListener("message", function (e) {                                  // HubSpot forms (embed v2 and iframe)
      var d = e.data;
      if (d && d.type === "hsFormCallback" && d.eventName === "onFormSubmitted" && box.isConnected) conversion("hubspot_submit");
    });
    var ctx = { container: box, conversion: conversion, close: remove };

    function afterInsert() {
      loadScriptsInOrder(scripts, box, function () {
        if (!a.js) return;
        try { (new Function("container", "OT", "ctx", a.js))(box, window.OT, ctx); }
        catch (err) { try { console.error("[Optimize] error in campaign JavaScript:", err); } catch (e2) {} }
      });
    }
    if (a.display === "modal") {
      outer = el("div", ""); outer.className = "ot-overlay"; outer.appendChild(box); addClose();
      outer.addEventListener("mousedown", function (e) { if (e.target === outer) remove(); });
      document.addEventListener("keydown", onKey);
      document.body.appendChild(outer); afterInsert();
    } else if (a.display === "slidein") {
      addClose(); document.body.appendChild(box); afterInsert();
    } else {
      whenElement(a.selector, function (target) {
        var pos = a.insert;
        if (pos === "prepend") target.insertBefore(box, target.firstChild);
        else if (pos === "before") target.parentNode.insertBefore(box, target);
        else if (pos === "after") target.parentNode.insertBefore(box, target.nextSibling);
        else if (pos === "replace") { target.innerHTML = ""; target.appendChild(box); }
        else target.appendChild(box);
        afterInsert();
      });
    }
  }
  function armTrigger(a, fire) {
    var done = false;
    function once() { if (!done) { done = true; fire(); } }
    if (a.trigger === "delay") setTimeout(once, Math.max(0, a.trigger_value || 0) * 1000);
    else if (a.trigger === "scroll") {
      var chk = function () { if (scrollPct() >= (a.trigger_value || 50)) { window.removeEventListener("scroll", chk); once(); } };
      window.addEventListener("scroll", chk, { passive: true }); chk();
    } else if (a.trigger === "exit") {   // desktop only: pointer leaves through the top of the window
      var h = function (e) { if (!e.relatedTarget && e.clientY <= 0) { document.removeEventListener("mouseout", h); once(); } };
      document.addEventListener("mouseout", h);
    } else once();
  }
  // "When it shows" for a whole campaign: each page view (default) | first page of a visit | after N seconds | scroll % |
  // exit intent | a click on an element | a form submit | a custom event. Deferred triggers re-check the audience and
  // frequency at the moment they fire, and are armed once per campaign per page load.
  var lastGeo = null, trigBound = {}, overlayTaken = false;
  // one banner / popup at a time per page (site setting): the first campaign to claim it wins; campaigns are tried in priority order
  function claimOverlay(c) {
    if (c.id === forced || settings.one_overlay === false) return true;
    if (overlayTaken) return false;
    overlayTaken = true; return true;
  }
  // control group: eligible visitors who are deliberately NOT shown the campaign (stable per visitor); counted as exposed so the real effect can be measured
  function inHoldout(c) { return c.holdout_pct > 0 && hash(visitor.id + ":hold:" + c.id) % 100 < c.holdout_pct; }
  function holdOut(c) {
    if (st.hold[c.id]) return;
    st.hold[c.id] = 1; st.cgoal[c.id] = "control"; saveState(st);
    push({ type: "impression", exp: c.id, variant: "control" });
    analytics("optimize_campaign_control", { optimize_id: c.id, optimize_name: c.name });
    if (c.goal) watchGoal(c, "control");
  }
  function armCampaignTrigger(c, go) {
    var t = c.trigger_type || "load", v = String(c.trigger_value || "");
    if (t === "load") return go();
    if (t === "session_start") { if ((st.pvN || 1) <= 1) go(); return; }
    var key = c.id + ":" + t;
    if (trigBound[key]) return; trigBound[key] = 1;
    var fired = false;
    function guarded() {
      if (fired || !frequencyAllows(c) || !campaignMatches(c, context(lastGeo))) return;
      fired = true; go();
    }
    if (t === "delay") setTimeout(guarded, Math.max(0, parseInt(v, 10) || 0) * 1000);
    else if (t === "scroll") {
      var want = parseInt(v, 10) || 50;
      var chk = function () { if (scrollPct() >= want) { window.removeEventListener("scroll", chk); guarded(); } };
      window.addEventListener("scroll", chk, { passive: true }); chk();
    } else if (t === "exit") {
      var h = function (e) { if (!e.relatedTarget && e.clientY <= 0) { document.removeEventListener("mouseout", h); guarded(); } };
      document.addEventListener("mouseout", h);
    } else if (t === "click") {
      document.addEventListener("click", function (ev) { try { if (ev.target.closest && ev.target.closest(v)) guarded(); } catch (e) {} }, true);
    } else if (t === "form") {
      document.addEventListener("submit", function (ev) {
        if (ev.target && ev.target.tagName === "FORM" && formId(ev.target).toLowerCase().indexOf(v.toLowerCase()) !== -1) guarded();
      }, true);
    } else if (t === "event") window.addEventListener("ot:event:" + v, guarded);
  }
  var armedCustom = {};
  function runCampaign(c, force) {
    var announced = false;
    function announce() {  // counted (and frequency-capped) only when something is actually shown
      if (announced) return; announced = true;
      if (force) return;                      // QA preview: show it, record nothing
      markShown(c); push({ type: "impression", exp: c.id, variant: "shown" });
      analytics("optimize_campaign_shown", { optimize_id: c.id, optimize_name: c.name });
      if (c.goal) { st.cgoal[c.id] = "shown"; saveState(st); watchGoal(c, "shown"); }   // conversion on the campaign's goal, counted after it was shown
    }
    var deferred = !!c.trigger_type && c.trigger_type !== "load";
    function go() {
      c.actions.forEach(function (a, i) {
        if (a.type === "custom") {
          var key = c.id + ":" + i;
          if (armedCustom[key]) return; armedCustom[key] = 1;
          // the campaign-level trigger replaces the code action's own trigger
          onBody(function () {
            armTrigger(deferred && !force ? { trigger: "load" } : (force ? { trigger: "load" } : a), function () {
              if (a.display !== "inline" && !claimOverlay(c)) return;
              renderCustom(c, a, announce);
            });
          });
          return;
        }
        if (a.type === "redirect") {
          var abs; try { abs = new URL((a.value || "").trim(), location.href).href; } catch (e) { return; }
          var cur = location.href.split("#")[0], tgt = abs.split("#")[0];
          if (tgt.indexOf("?") === -1) cur = cur.split("?")[0];                         // a target without a query matches the page whatever its query
          if (cur === tgt) return;                                                       // already there: never loop
          if (st.rdSid !== st.sid) { st.rdSid = st.sid; st.rdN = 0; }
          if (++st.rdN > 3) return;                                                     // at most 3 redirects per visit
          announce(); saveState(st); flush(); location.replace(abs);
          return;
        }
        if ((a.type === "banner" || a.type === "popup") && !claimOverlay(c)) return;
        announce();
        if (a.type === "banner") showBanner(c, a);
        else if (a.type === "popup") showPopup(c, a);
        else if (a.type === "change") applyWithRetry([{ selector: a.selector, action: a.action, value: a.value, attr: a.attr }]);
      });
    }
    if (force) {
      var ribbon = el("div", "position:fixed;left:50%;bottom:0;transform:translateX(-50%);z-index:2147483647;background:#111827;color:#fff;padding:5px 12px;border-radius:10px 10px 0 0;font:12px/1.4 system-ui,sans-serif");
      ribbon.setAttribute("data-ot-ignore", "1"); ribbon.textContent = "Optimize QA preview: " + (c.name || c.id) + " (nothing is tracked)";
      document.body.appendChild(ribbon);
      return go();
    }
    armCampaignTrigger(c, go);
  }
  function onBody(fn) { if (document.body) fn(); else document.addEventListener("DOMContentLoaded", fn); }
  // Visitor context (the facts rules are tested against), built once per page. The country lookup is a network
  // call, so it only happens when some campaign / test actually has a country rule.
  var geoPromise = null;
  function getContext(cfg) {
    var all = ((cfg && cfg.campaigns) || []).concat((cfg && cfg.experiments) || []);
    var geoField = function (r) { return r.field === "country" || r.field === "region" || r.field === "city" || r.field === "ip" || (r.field === "__group" && (r.rules || []).some(geoField)); };
    var needsGeo = all.some(function (c) { return (c.rules || []).some(geoField); });
    if (!needsGeo) return Promise.resolve(context(lastGeo));
    if (!geoPromise) {
      geoPromise = fetch(ORIGIN + "/ctx").then(function (r) { return r.json(); }).catch(function () { return {}; });
    }
    return geoPromise.then(function (geo) { lastGeo = geo; return context(geo); });
  }
  function runCampaigns(list, ctx) {
    (list || []).slice().sort(function (a, b) { return (b.priority || 0) - (a.priority || 0); }).forEach(function (c) {
      if (c.goal && st.cgoal[c.id]) watchGoal(c, st.cgoal[c.id]);        // the goal may be reached on a different page than the campaign
      if (forced && c.id === forced) { onBody(function () { runCampaign(c, true); }); return; }
      if (forced) return;                                                  // a QA link shows only that campaign
      if (!campaignMatches(c, ctx)) return;
      if (inHoldout(c)) { holdOut(c); return; }
      if (frequencyAllows(c)) onBody(function () { runCampaign(c); });
    });
  }

  // ---------------------------------------------------------------- site-wide goals (dashboard: Goals)
  // Every saved goal is watched on every page; a hit is recorded as a `conversion` event named after the goal id.
  var goalsBound = false, goalList = [];
  function fireSiteGoal(g) {
    var n = st.gdone[g.id] || 0;
    if (g.count_mode !== "every" && n) return;
    st.gdone[g.id] = n + 1; saveState(st);
    push({ type: "conversion", name: g.id, props: { value: g.value || 0 } });
    analytics("optimize_goal", { optimize_goal_id: g.id, optimize_goal: g.name, value: g.value || 0 });
    flush();
  }
  function checkPageGoals() {
    goalList.forEach(function (g) { if (g.type === "pageview" && g.url_contains && location.href.indexOf(g.url_contains) !== -1) fireSiteGoal(g); });
  }
  function startGoals(list) {
    goalList = list || [];
    if (!goalList.length) return;
    if (!goalsBound) {
      goalsBound = true;
      document.addEventListener("click", function (ev) {
        goalList.forEach(function (g) {
          try { if (g.type === "click" && g.selector && ev.target.closest && ev.target.closest(g.selector)) fireSiteGoal(g); } catch (e) {}
        });
      }, true);
      document.addEventListener("submit", function (ev) {
        if (!ev.target || ev.target.tagName !== "FORM") return;
        var fid = formId(ev.target).toLowerCase();
        goalList.forEach(function (g) { if (g.type === "form" && g.form_name && fid.indexOf(g.form_name.toLowerCase()) !== -1) fireSiteGoal(g); });
      }, true);
      window.addEventListener("ot:any", function (ev) {
        var nm = ev.detail && ev.detail.name;
        goalList.forEach(function (g) { if (g.type === "event" && g.event_name === nm) fireSiteGoal(g); });
      });
    }
    checkPageGoals();
  }

  // ---------------------------------------------------------------- behaviour tracking
  var maxScroll = 0, scrollFired = {}, seconds = 0, lastActivity = Date.now(), lastSentSeconds = -1;
  var rageClicks = [], formsStarted = {}, cfgCache = null, started = false, trackersOn = false, routeBound = false;

  function pageviewProps(first) {
    var ref = "";
    try { var u = new URL(document.referrer); if (first && u.hostname !== location.hostname) ref = u.hostname; } catch (e) {}
    return { pid: pid, title: document.title.slice(0, 120), device: deviceType(), ref: ref, lang: (navigator.language || "").slice(0, 10),
      sw: window.innerWidth || 0, utm_source: st.utm.utm_source || "", utm_medium: st.utm.utm_medium || "", utm_campaign: st.utm.utm_campaign || "" };
  }
  function sendPageview(first) {
    curUrl = pageUrl();
    countPage();
    push({ type: "pageview", props: pageviewProps(first) });
  }

  function scrollPct() {
    var d = document.documentElement, b = document.body;
    var h = Math.max(d.scrollHeight, b ? b.scrollHeight : 0), view = window.innerHeight || d.clientHeight;
    if (h <= view + 4) return 100;
    return Math.min(100, Math.round(((window.pageYOffset || d.scrollTop) + view) / h * 100));
  }
  var scrollQueued = false;
  function checkScroll() {
    scrollQueued = false;
    if (!active || !settings.auto_scroll) return;
    var pct = scrollPct();
    if (pct > maxScroll) maxScroll = pct;
    [25, 50, 75, 100].forEach(function (t) {
      if (maxScroll >= t && !scrollFired[t]) { scrollFired[t] = 1; push({ type: "scroll", props: { pid: pid, depth: t }, url: curUrl }); }
    });
  }
  function onScroll() { lastActivity = Date.now(); if (!scrollQueued) { scrollQueued = true; requestAnimationFrame(checkScroll); } }

  function sendEngage() {
    if (!active || seconds === lastSentSeconds) return;
    lastSentSeconds = seconds;
    push({ type: "engage", props: { pid: pid, seconds: seconds, scroll: maxScroll, device: deviceType(), vh: window.innerHeight || 0 }, url: curUrl });
  }

  var INTERACTIVE = "a,button,[role=button],input[type=button],input[type=submit],input[type=reset],summary,[onclick]";
  function describe(t) {
    var el0 = t.closest ? (t.closest(INTERACTIVE) || t) : t;
    if (el0.closest && el0.closest("[data-ot-ignore]")) return null;
    var tag = el0.tagName ? el0.tagName.toLowerCase() : "";
    // never record clicks inside text fields (could contain typed content in labels/values)
    if (tag === "textarea" || tag === "select" || el0.isContentEditable) return null;
    if (tag === "input" && !/^(button|submit|reset|checkbox|radio)$/i.test(el0.type)) return null;
    var cls = Array.prototype.filter.call(el0.classList || [], function (c) { return /^[a-zA-Z][\w-]{0,30}$/.test(c) && !/\d{3,}/.test(c); }).slice(0, 2);
    var sel = tag + (el0.id && !/\d{4,}/.test(el0.id) ? "#" + el0.id : "") + cls.map(function (c) { return "." + c; }).join("");
    var text = (el0.getAttribute("aria-label") || el0.innerText || el0.value || el0.alt || "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (/\S+@\S+/.test(text) || /\d{6,}/.test(text)) text = ""; // looks like PII; keep the click, drop the label
    var out = { sel: sel, text: text, tag: tag, key: sel + "|" + text, pid: pid };
    if (tag === "a" && el0.href) {
      try {
        var u = new URL(el0.href);
        out.href = (u.hostname === location.hostname ? "" : u.hostname) + u.pathname;
        if (u.hostname !== location.hostname && /^https?:$/.test(u.protocol)) out.outbound = true;
        if (/\.(pdf|zip|docx?|xlsx?|pptx?|csv|mp4|dmg|exe)$/i.test(u.pathname)) out.download = true;
      } catch (e) {}
    }
    return out;
  }
  function onClick(ev) {
    lastActivity = Date.now();
    if (!active || !settings.auto_clicks || !(ev.target instanceof Element)) return;
    var d = describe(ev.target);
    if (!d) return;
    var de = document.documentElement, dw = Math.max(de.scrollWidth, de.clientWidth || 0);
    var dh = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0);
    if (typeof ev.pageX === "number" && dw > 0) {
      d.x = Math.round(Math.min(100, Math.max(0, ev.pageX / dw * 100)) * 10) / 10;
      d.y = Math.round(Math.max(0, ev.pageY)); d.dw = dw; d.dh = dh; d.device = deviceType();
    }
    push({ type: "autoclick", props: d, url: curUrl });
    // rage click: 3+ clicks within 1s inside a 40px box
    var t = Date.now();
    rageClicks = rageClicks.filter(function (c) { return t - c.t < 1000; });
    rageClicks.push({ t: t, x: ev.clientX, y: ev.clientY });
    if (rageClicks.length >= 3) {
      var f = rageClicks[0];
      var near = rageClicks.every(function (c) { return Math.abs(c.x - f.x) < 40 && Math.abs(c.y - f.y) < 40; });
      if (near) { push({ type: "rage", props: d, url: curUrl }); rageClicks = []; }
    }
  }
  function formId(f) { return (f.id || f.getAttribute("name") || f.getAttribute("action") || "form").slice(0, 60); }
  function onFocusIn(ev) {
    if (!active || !settings.auto_forms || !ev.target.closest) return;
    var f = ev.target.closest("form");
    if (!f || f.closest("[data-ot-ignore]")) return;
    var id = formId(f);
    if (formsStarted[id]) return;
    formsStarted[id] = 1;
    push({ type: "form", props: { pid: pid, form: id, action: "start" }, url: curUrl });
  }
  function onSubmit(ev) {
    if (!active || !settings.auto_forms || !ev.target || ev.target.tagName !== "FORM") return;
    if (ev.target.closest("[data-ot-ignore]")) return;
    push({ type: "form", props: { pid: pid, form: formId(ev.target), action: "submit" }, url: curUrl });
    flush();
  }

  function newPage(first) {
    pid = rid(); maxScroll = 0; scrollFired = {}; seconds = 0; lastSentSeconds = -1; formsStarted = {};
    sendPageview(first);
    setTimeout(checkScroll, 400);
  }
  function routeChanged() {
    if (!active || pageUrl() === curUrl) return;
    newPage(false);
    overlayTaken = false;                       // a new page of a single-page app may show its own banner / popup
    if (cfgCache) {
      getContext(cfgCache).then(function (ctx) { runCampaigns(cfgCache.campaigns, ctx); });  // experiments are evaluated on full page loads only
      checkPageGoals();
    }
  }

  function startTrackers() {
    if (trackersOn) return; trackersOn = true;
    document.addEventListener("click", onClick, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("submit", onSubmit, true);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    ["mousemove", "keydown", "touchstart"].forEach(function (t) {
      window.addEventListener(t, function () { lastActivity = Date.now(); }, { passive: true, capture: true });
    });
    var ticks = 0;
    setInterval(function () {
      if (!active) return;
      if (document.visibilityState === "visible" && Date.now() - lastActivity < IDLE_MS) seconds++;
      if (++ticks % 30 === 0) sendEngage();
    }, 1000);
    window.addEventListener("pagehide", function () { sendEngage(); flush(); });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") { sendEngage(); flush(); }
    });
    if (settings.auto_spa && !routeBound) {
      routeBound = true;
      ["pushState", "replaceState"].forEach(function (fn) {
        var orig = history[fn];
        history[fn] = function () {
          sendEngage();                       // close out the old page while curUrl is still old
          var r = orig.apply(this, arguments);
          routeChanged();
          return r;
        };
      });
      window.addEventListener("popstate", function () { sendEngage(); routeChanged(); });
      window.addEventListener("hashchange", function () { sendEngage(); routeChanged(); });
    }
  }

  // ---------------------------------------------------------------- public API + boot
  var pendingEvents = [];
  var pendingCalls = (window.OT && window.OT.q) || [];
  window.OT = {
    visitor: visitor,
    track: function (name, props) {
      var ev = { type: "event", name: String(name).slice(0, 100), props: props || {} };
      if (active) push(ev); else if (!started) pendingEvents.push(ev); // dropped if consent is denied
      try { window.dispatchEvent(new CustomEvent("ot:event:" + name)); window.dispatchEvent(new CustomEvent("ot:any", { detail: { name: String(name) } })); } catch (e) {}
    },
    /** Tell Optimize facts about the visitor, e.g. OT.identify({ plan: "pro", cart_value: 120, customer: true }).
     *  They become targeting fields named attr.plan, attr.cart_value, ... Values are kept in this browser only. */
    identify: function (attrs) {
      if (!attrs || typeof attrs !== "object") return;
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (!/^[A-Za-z][A-Za-z0-9_]{0,29}$/.test(k)) return;
        if (typeof v === "string") v = v.slice(0, 100); else if (typeof v !== "number" && typeof v !== "boolean") return;
        if (st.attrs[k] === undefined && Object.keys(st.attrs).length >= 20) return;
        st.attrs[k] = v;
      });
      saveState(st);
    },
    /** Call with true/false from your cookie banner when the site has "require consent" on. */
    consent: function (granted) {
      try { localStorage.setItem(CONSENT, granted ? "1" : "0"); } catch (e) {}
      if (granted) { if (cfgCache && !started) start(cfgCache); }
      else { active = false; queue = []; pendingEvents = []; wipeState(); persist = false; }
    }
  };

  // Calls made before this script loaded: window.OT = window.OT || { q: [] }; OT.q.push(["identify", { plan: "pro" }]);
  (function replayQueue() {
    var q = pendingCalls;
    if (!q || !q.length) return;
    q.forEach(function (c) { try { if (typeof window.OT[c[0]] === "function") window.OT[c[0]].apply(null, c.slice(1)); } catch (e) {} });
  })();

  function consentGranted() { try { return localStorage.getItem(CONSENT) === "1"; } catch (e) { return false; } }
  // An explicit "No" (OT.consent(false)) is remembered and honoured on every later page, even if the site doesn't require consent.
  function consentDenied() { try { return localStorage.getItem(CONSENT) === "0"; } catch (e) { return false; } }

  function start(cfg) {
    started = true; persist = true; active = true;
    settings = cfg.settings || {};
    captureAttribution(); saveState(st);
    sendPageview(true);
    pendingEvents.splice(0).forEach(push);
    startGoals(cfg.goals);
    var done = getContext(cfg).then(function (ctx) {
      runCampaigns(cfg.campaigns, ctx);
      return runExperiments(cfg.experiments, ctx);
    });
    startTrackers();
    setTimeout(checkScroll, 400);
    // un-hide the page only once page-change campaigns / test variants were applied, so visitors never see a flash of the original
    done.then(function (redirecting) { if (!redirecting) reveal(); }, reveal);
  }

  // ---- preview mode: render the campaign the dashboard sends, ignoring rules/frequency/triggers.
  // `active` stays false, so nothing is stored or sent while previewing.
  function startPreview() {
    reveal();
    var ribbon = el("div", "position:fixed;left:50%;top:0;transform:translateX(-50%);z-index:2147483647;background:#111827;color:#fff;padding:6px 14px;border-radius:0 0 10px 10px;font:12.5px/1.4 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3)");
    ribbon.setAttribute("data-ot-ignore", "1");
    ribbon.textContent = "Optimize preview — nothing is tracked. Rules, frequency and delays are ignored.";
    var got = false;
    window.addEventListener("message", function (e) {
      if (e.source !== PARENT || e.origin !== ORIGIN) return;   // only the dashboard that opened/framed us
      var m = e.data;
      if (!m || m.type !== "ot:preview" || !m.campaign) return;
      if (got) { location.reload(); return; }                   // refresh: reload for a clean page, handshake re-sends the latest
      got = true;
      onBody(function () {
        document.body.appendChild(ribbon);
        var c = m.campaign; c.id = c.id || "preview";
        (c.actions || []).forEach(function (a) {
          if (a.type === "banner") showBanner(c, a);
          else if (a.type === "popup") showPopup(c, a);
          else if (a.type === "change") applyWithRetry([{ selector: a.selector, action: a.action, value: a.value, attr: a.attr }]);
          else if (a.type === "custom") renderCustom(c, a, function () {});
        });
      });
    });
    var tries = 0;
    (function ready() {
      if (got || tries++ > 12) return;
      try { PARENT.postMessage({ type: "ot:pv:ready" }, ORIGIN); } catch (e) {}
      setTimeout(ready, 1000);
    })();
  }
  if (MODE === "preview") { startPreview(); return; }

  fetch(ORIGIN + "/sdk/" + SITE + ".json")
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      cfgCache = cfg;
      settings = cfg.settings || {};
      if (consentDenied()) { reveal(); return; }                                // the visitor declined: never start
      if (settings.consent_required && !consentGranted()) { reveal(); return; } // wait for OT.consent(true)
      start(cfg);
    })
    .catch(reveal);
})();
