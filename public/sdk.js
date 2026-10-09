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
  }
  function watchGoal(exp, variantKey) {
    var g = exp.goal;
    if (g.type === "click" && g.selector) {
      document.addEventListener("click", function (ev) {
        try { if (ev.target.closest && ev.target.closest(g.selector)) fireGoal(exp, variantKey); } catch (e) {}
      }, true);
    } else if (g.type === "pageview" && g.url_contains) {
      if (location.href.indexOf(g.url_contains) !== -1) fireGoal(exp, variantKey);
    } else if (g.type === "event" && g.name) {
      window.addEventListener("ot:event:" + g.name, function () { fireGoal(exp, variantKey); });
    }
  }
  function runExperiments(list) {
    var redirecting = false;
    (list || []).forEach(function (exp) {
      if (redirecting) return;
      if (exp.url_contains && location.href.indexOf(exp.url_contains) === -1) {
        if (st.assign[exp.id]) watchGoal(exp, st.assign[exp.id]); // goal may live on another page
        return;
      }
      var v = assign(exp);
      if (!v) return;
      push({ type: "exposure", exp: exp.id, variant: v.key });
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
    ["utm_source", "utm_medium", "utm_campaign"].forEach(function (k) {
      if (q.get(k)) st.utm[k] = q.get(k).slice(0, 100);
    });
    if (!st.ref) st.ref = document.referrer.slice(0, 300);
  }
  function deviceType() {
    var w = Math.min(window.innerWidth || 1024, screen.width || 1024);
    return w < 768 ? "mobile" : w < 1024 ? "tablet" : "desktop";
  }
  function context(country) {
    var d = new Date();
    return {
      returning: String(visitor.isReturning), visit_no: visitor.visitNo,
      days_since_last: visitor.daysSinceLast, days_since_first: visitor.daysSinceFirst,
      utm_source: st.utm.utm_source || "", utm_medium: st.utm.utm_medium || "",
      utm_campaign: st.utm.utm_campaign || "", device: deviceType(),
      country: (country || "").toUpperCase(), hour: d.getHours(), weekday: d.getDay(),
      url: location.href, referrer: st.ref || document.referrer || ""
    };
  }
  function ruleMatches(r, ctx) {
    var actual = ctx[r.field], want = r.value;
    if (actual === undefined) return false;
    var an = Number(actual), wn = Number(want), numeric = !isNaN(an) && want !== "" && !isNaN(wn);
    switch (r.op) {
      case "eq": return String(actual).toLowerCase() === String(want).toLowerCase();
      case "neq": return String(actual).toLowerCase() !== String(want).toLowerCase();
      case "gte": return numeric && an >= wn;
      case "lte": return numeric && an <= wn;
      case "contains": return String(actual).toLowerCase().indexOf(String(want).toLowerCase()) !== -1;
    }
    return false;
  }
  function campaignMatches(c, ctx) {
    if (c.url_contains && location.href.indexOf(c.url_contains) === -1) return false;
    if (!c.rules || !c.rules.length) return true;
    var test = function (r) { return ruleMatches(r, ctx); };
    return c.match === "any" ? c.rules.some(test) : c.rules.every(test);
  }
  function frequencyAllows(c) {
    if (c.frequency === "once") return !st.pers[c.id];
    if (c.frequency === "session") return st.pers[c.id] !== st.sid;
    return true;
  }
  function markShown(c) {
    st.pers[c.id] = c.frequency === "session" ? st.sid : 1;
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
  function showBanner(c, a) {
    var bar = el("div", "position:fixed;left:0;right:0;" + (a.position === "bottom" ? "bottom:0" : "top:0") +
      ";z-index:2147483000;padding:10px 44px 10px 16px;text-align:center;font:15px/1.4 system-ui,sans-serif;background:" +
      a.bg + ";color:" + a.fg);
    bar.setAttribute("role", "region"); bar.setAttribute("aria-label", "Announcement");
    bar.setAttribute("data-ot-ignore", "1");
    bar.appendChild(el("span", "", a.text));
    var link = ctaLink(c, a, "margin-left:12px;color:" + a.fg + ";font-weight:600;text-decoration:underline");
    if (link) bar.appendChild(link);
    var x = el("button", "position:absolute;right:10px;top:6px;background:none;border:0;color:" + a.fg + ";font-size:20px;cursor:pointer", "×");
    x.setAttribute("aria-label", "Dismiss");
    x.onclick = function () { bar.remove(); };
    bar.appendChild(x);
    document.body.appendChild(bar);
  }
  function showPopup(c, a) {
    var wrap = el("div", "position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px");
    wrap.setAttribute("data-ot-ignore", "1");
    var box = el("div", "background:#fff;color:#111;max-width:420px;width:100%;border-radius:12px;padding:24px;font:15px/1.5 system-ui,sans-serif;position:relative;box-shadow:0 10px 40px rgba(0,0,0,.3)");
    box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
    if (a.title) box.appendChild(el("h2", "margin:0 0 8px;font-size:20px", a.title));
    if (a.text) box.appendChild(el("p", "margin:0 0 16px", a.text));
    var link = ctaLink(c, a, "display:inline-block;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;background:" + a.bg + ";color:" + a.fg);
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
  var armedCustom = {};
  function runCampaign(c) {
    var announced = false;
    function announce() {  // counted (and frequency-capped) only when something is actually shown
      if (announced) return; announced = true;
      markShown(c); push({ type: "impression", exp: c.id, variant: "shown" });
    }
    c.actions.forEach(function (a, i) {
      if (a.type === "custom") {
        var key = c.id + ":" + i;
        if (armedCustom[key]) return; armedCustom[key] = 1;
        onBody(function () { armTrigger(a, function () { renderCustom(c, a, announce); }); });
        return;
      }
      announce();
      if (a.type === "banner") showBanner(c, a);
      else if (a.type === "popup") showPopup(c, a);
      else if (a.type === "change") applyWithRetry([{ selector: a.selector, action: a.action, value: a.value, attr: a.attr }]);
    });
  }
  function onBody(fn) { if (document.body) fn(); else document.addEventListener("DOMContentLoaded", fn); }
  function runCampaigns(list) {
    if (!list || !list.length) return;
    var needsGeo = list.some(function (c) { return (c.rules || []).some(function (r) { return r.field === "country"; }); });
    var geo = needsGeo
      ? fetch(ORIGIN + "/ctx").then(function (r) { return r.json(); }).then(function (j) { return j.country; }).catch(function () { return ""; })
      : Promise.resolve("");
    geo.then(function (country) {
      var ctx = context(country);
      list.forEach(function (c) {
        if (campaignMatches(c, ctx) && frequencyAllows(c)) onBody(function () { runCampaign(c); });
      });
    });
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
    if (cfgCache) runCampaigns(cfgCache.campaigns); // experiments are evaluated on full page loads only
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
  window.OT = {
    visitor: visitor,
    track: function (name, props) {
      var ev = { type: "event", name: String(name).slice(0, 100), props: props || {} };
      if (active) push(ev); else if (!started) pendingEvents.push(ev); // dropped if consent is denied
      try { window.dispatchEvent(new CustomEvent("ot:event:" + name)); } catch (e) {}
    },
    /** Call with true/false from your cookie banner when the site has "require consent" on. */
    consent: function (granted) {
      try { localStorage.setItem(CONSENT, granted ? "1" : "0"); } catch (e) {}
      if (granted) { if (cfgCache && !started) start(cfgCache); }
      else { active = false; queue = []; pendingEvents = []; wipeState(); persist = false; }
    }
  };

  function consentGranted() { try { return localStorage.getItem(CONSENT) === "1"; } catch (e) { return false; } }

  function start(cfg) {
    started = true; persist = true; active = true;
    settings = cfg.settings || {};
    captureAttribution(); saveState(st);
    sendPageview(true);
    pendingEvents.splice(0).forEach(push);
    runCampaigns(cfg.campaigns);
    var redirecting = runExperiments(cfg.experiments);
    startTrackers();
    setTimeout(checkScroll, 400);
    if (!redirecting) reveal();
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
      if (settings.consent_required && !consentGranted()) { reveal(); return; } // wait for OT.consent(true)
      start(cfg);
    })
    .catch(reveal);
})();
