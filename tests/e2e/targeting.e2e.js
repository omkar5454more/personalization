// End-to-end: new targeting facts, groups, "when it shows" triggers, page scope and redirect -- the real sdk.js in jsdom.
const { JSDOM, VirtualConsole } = require("jsdom");
const BASE = process.env.BASE || "http://127.0.0.1:8011";
let cookie = "", failures = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) failures++; };

async function api(path, method = "GET", body) {
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const t = await r.text(); if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

let SITE;
// one visit in a fresh browser; `o` = { path, referrer, cookies, vars, geo, queue, fn }
async function visit(o = {}) {
  const html = `<!doctype html><html><head><script src="${BASE}/sdk.js" data-site="${SITE}" async></script></head>
    <body><h1>Hello</h1><button id="buy">Buy</button><form id="newsletter"><input name="e"></form></body></html>`;
  const navigations = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => { if (/navigation/i.test(String(e.message))) navigations.push(String(e.detail || e.message)); });
  const dom = new JSDOM(html, {
    url: BASE + (o.path || "/"), ...(o.referrer ? { referrer: o.referrer } : {}), runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = (u, init = {}) => {
        const abs = new URL(u, w.location.href).href;
        const headers = { ...(init.headers || {}), ...(abs.endsWith("/ctx") && o.geo ? o.geo : {}) };
        return fetch(abs, { ...init, headers });
      };
      Object.defineProperty(w.navigator, "language", { value: "en-US" });
      (o.cookies || []).forEach(c => { w.document.cookie = c; });
      Object.assign(w, o.vars || {});
      if (o.queue) w.OT = { q: o.queue };
    },
  });
  const w = dom.window;
  for (let i = 0; i < 60 && !(w.OT && w.OT.visitor); i++) await sleep(100);
  await sleep(700);
  w.__nav = navigations;
  if (o.fn) await o.fn(w);
  await sleep(300);
  return dom;
}
const shown = w => Array.from(w.document.body.querySelectorAll("div[role=region] span")).map(s => s.textContent);
const has = (w, t) => shown(w).includes(t);

(async () => {
  await api("/api/auth/register", "POST", { email: `targeting${Date.now()}@example.com`, password: "targeting-test-pass-1" });
  SITE = (await api("/api/sites", "POST", { name: "Targeting", domain: "localhost" })).id;
  const mk = async (text, extra) => {
    const id = (await api(`/api/sites/${SITE}/campaigns`, "POST", { name: text, frequency: "always", actions: [{ type: "banner", text }], ...extra })).id;
    await api(`/api/campaigns/${id}/status`, "PATCH", { status: "running" }); return id;
  };
  const R = (field, op, value) => ({ field, op, value });

  await mk("T-GROUP", { rules: [R("attr.plan", "eq", "pro"), { field: "__group", match: "any", rules: [R("device", "eq", "mobile"), R("traffic_source", "eq", "organic")] }] });
  await mk("T-PARAM", { rules: [R("param.coupon", "eq", "SAVE10")] });
  await mk("T-COOKIE", { rules: [R("cookie.tier", "eq", "gold")] });
  await mk("T-VAR", { rules: [R("var.user.plan", "eq", "vip")] });
  await mk("T-GEO", { rules: [R("region", "eq", "Maharashtra"), R("city", "eq", "Mumbai")] });
  await mk("T-VISITED", { rules: [R("visited_page", "eq", "/pricing")] });
  await mk("T-TOTAL3", { rules: [R("total_pageviews", "gte", "3")] });
  await mk("T-SOCIAL", { rules: [R("traffic_source", "eq", "social")] });
  await mk("T-PAID", { rules: [R("traffic_source", "eq", "paid")] });
  await mk("T-DIRECT", { rules: [R("traffic_source", "eq", "direct")] });
  await mk("T-STARTS", { page_match: "starts", url_contains: "/shop/special" });
  await mk("T-EQUALS", { page_match: "equals", url_contains: "/exact" });
  await mk("T-DELAY", { trigger_type: "delay", trigger_value: "1", rules: [R("attr.t", "eq", "delay")] });
  await mk("T-CLICK", { trigger_type: "click", trigger_value: "#buy", rules: [R("attr.t", "eq", "click")] });
  await mk("T-EVENT", { trigger_type: "event", trigger_value: "promo", rules: [R("attr.t", "eq", "event")] });
  await mk("T-FORM", { trigger_type: "form", trigger_value: "newsletter", rules: [R("attr.t", "eq", "form")] });
  await mk("T-EXIT", { trigger_type: "exit", rules: [R("attr.t", "eq", "exit")] });
  await mk("T-SCROLL", { trigger_type: "scroll", trigger_value: "50", rules: [R("attr.t", "eq", "scroll")] });
  await mk("T-SESSION", { trigger_type: "session_start", rules: [R("attr.t", "eq", "session")] });
  const redirectId = (await api(`/api/sites/${SITE}/campaigns`, "POST", { name: "T-REDIRECT", frequency: "always", rules: [R("param.go", "eq", "1")],
    actions: [{ type: "redirect", value: "/landing" }] })).id;
  await api(`/api/campaigns/${redirectId}/status`, "PATCH", { status: "running" });

  console.log("-- groups and traffic source");
  let d = await visit({ queue: [["identify", { plan: "pro" }]], referrer: "https://www.google.com/search?q=x", fn: async w => {
    check("group: pro AND (mobile OR organic) shows for pro + organic search", has(w, "T-GROUP"), shown(w).join("|"));
    check("traffic source 'organic' is not 'social' / 'paid'", !has(w, "T-SOCIAL") && !has(w, "T-PAID"));
    check("organic visitor is not 'direct'", !has(w, "T-DIRECT"));
  } }); d.window.close();
  d = await visit({ queue: [["identify", { plan: "pro" }]], fn: async w => {
    check("group: pro on desktop with no referrer does NOT match the group", !has(w, "T-GROUP"));
    check("no referrer -> direct", has(w, "T-DIRECT"));
  } }); d.window.close();
  d = await visit({ queue: [["identify", { plan: "free" }]], referrer: "https://www.google.com/", fn: async w => {
    check("group: AND part fails (free plan) even though the OR group matches", !has(w, "T-GROUP"));
  } }); d.window.close();
  d = await visit({ referrer: "https://www.facebook.com/", fn: async w => check("facebook referrer -> social", has(w, "T-SOCIAL")) }); d.window.close();
  d = await visit({ path: "/?utm_medium=cpc&utm_source=google", fn: async w => check("utm_medium=cpc -> paid", has(w, "T-PAID")) }); d.window.close();

  console.log("-- page-level facts");
  d = await visit({ path: "/?coupon=SAVE10", fn: async w => check("URL parameter rule matches", has(w, "T-PARAM")) }); d.window.close();
  d = await visit({ path: "/?coupon=other", fn: async w => check("URL parameter rule rejects another value", !has(w, "T-PARAM")) }); d.window.close();
  d = await visit({ cookies: ["tier=gold"], fn: async w => check("cookie rule matches", has(w, "T-COOKIE")) }); d.window.close();
  d = await visit({ cookies: ["tier=silver"], fn: async w => check("cookie rule rejects another value", !has(w, "T-COOKIE")) }); d.window.close();
  d = await visit({ vars: { user: { plan: "vip" } }, fn: async w => check("JavaScript variable rule matches (user.plan)", has(w, "T-VAR")) }); d.window.close();
  d = await visit({ vars: { user: { plan: "free" } }, fn: async w => check("JavaScript variable rule rejects another value", !has(w, "T-VAR")) }); d.window.close();
  d = await visit({ fn: async w => check("missing JavaScript variable simply doesn't match", !has(w, "T-VAR")) }); d.window.close();

  console.log("-- location (state / city) from the host's geo headers");
  d = await visit({ geo: { "x-vercel-ip-country": "IN", "x-vercel-ip-country-region": "MH", "x-vercel-ip-city": "Mumbai" }, fn: async w => check("region + city rule matches (MH -> Maharashtra, Mumbai)", has(w, "T-GEO"), shown(w).join("|")) }); d.window.close();
  d = await visit({ geo: { "x-vercel-ip-country": "IN", "x-vercel-ip-country-region": "KA", "x-vercel-ip-city": "Bengaluru" }, fn: async w => check("other state/city does not match", !has(w, "T-GEO")) }); d.window.close();
  d = await visit({ fn: async w => check("no geo headers (local) -> geo rules don't match", !has(w, "T-GEO")) }); d.window.close();

  console.log("-- pages visited and page counts (single-page-app navigation)");
  d = await visit({ fn: async w => {
    check("'visited /pricing' is false before the visitor opens it", !has(w, "T-VISITED") && !has(w, "T-TOTAL3"));
    w.history.pushState({}, "", "/pricing"); await sleep(700);
    check("'visited /pricing' becomes true after opening it", has(w, "T-VISITED"));
    check("total page views = 2 so far, rule needs 3", !has(w, "T-TOTAL3"));
    w.history.pushState({}, "", "/about"); await sleep(700);
    check("total page views >= 3 across the visit", has(w, "T-TOTAL3"));
  } }); d.window.close();

  console.log("-- page scope");
  d = await visit({ path: "/shop/special/shoes?x=1", fn: async w => check("'starts with' matches (query ignored)", has(w, "T-STARTS") && !has(w, "T-EQUALS")) }); d.window.close();
  d = await visit({ path: "/shop/other", fn: async w => check("'starts with' rejects other pages", !has(w, "T-STARTS")) }); d.window.close();
  d = await visit({ path: "/exact/?utm=1", fn: async w => check("'this page only' matches ignoring query and trailing slash", has(w, "T-EQUALS")) }); d.window.close();
  d = await visit({ path: "/exact/more", fn: async w => check("'this page only' rejects a longer address", !has(w, "T-EQUALS")) }); d.window.close();

  console.log("-- when it shows");
  d = await visit({ queue: [["identify", { t: "delay" }]], fn: async w => {
    check("delay: not shown immediately", !has(w, "T-DELAY"));
    await sleep(1300);
    check("delay: shown after the delay", has(w, "T-DELAY"));
  } }); d.window.close();
  d = await visit({ queue: [["identify", { t: "click" }]], fn: async w => {
    check("click trigger: hidden until the element is clicked", !has(w, "T-CLICK"));
    w.document.getElementById("buy").click(); await sleep(200);
    check("click trigger: shown after clicking #buy", has(w, "T-CLICK"));
  } }); d.window.close();
  d = await visit({ queue: [["identify", { t: "event" }]], fn: async w => {
    check("event trigger: hidden before the event", !has(w, "T-EVENT"));
    w.OT.track("promo"); await sleep(200);
    check("event trigger: shown after OT.track('promo')", has(w, "T-EVENT"));
  } }); d.window.close();
  d = await visit({ queue: [["identify", { t: "form" }]], fn: async w => {
    check("form trigger: hidden before the submit", !has(w, "T-FORM"));
    w.document.getElementById("newsletter").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); await sleep(200);
    check("form trigger: shown after submitting the newsletter form", has(w, "T-FORM"));
  } }); d.window.close();
  d = await visit({ queue: [["identify", { t: "exit" }]], fn: async w => {
    check("exit trigger: hidden at first", !has(w, "T-EXIT"));
    const ev = new w.MouseEvent("mouseout", { bubbles: true, clientY: -5, relatedTarget: null }); w.document.dispatchEvent(ev); await sleep(200);
    check("exit trigger: shown when the mouse leaves through the top", has(w, "T-EXIT"));
  } }); d.window.close();
  d = await visit({ queue: [["identify", { t: "scroll" }]], fn: async w => check("scroll trigger fires once the page is scrolled far enough (a short page counts as fully scrolled)", has(w, "T-SCROLL")) }); d.window.close();
  d = await visit({ queue: [["identify", { t: "session" }]], fn: async w => {
    check("session-start trigger: shown on the first page of the visit", has(w, "T-SESSION"));
    const before = shown(w).filter(x => x === "T-SESSION").length;
    w.history.pushState({}, "", "/next"); await sleep(700);
    check("session-start trigger: not repeated on later pages of the same visit", shown(w).filter(x => x === "T-SESSION").length === before);
  } }); d.window.close();

  console.log("-- redirect");
  d = await visit({ path: "/?go=1", fn: async w => check("redirect action sends the visitor to /landing", w.__nav.length >= 1, JSON.stringify(w.__nav)) }); d.window.close();
  d = await visit({ path: "/landing?go=1", fn: async w => check("redirect never loops: already on the target page -> no navigation", w.__nav.length === 0, JSON.stringify(w.__nav)) }); d.window.close();
  d = await visit({ path: "/", fn: async w => check("redirect only for matching visitors", w.__nav.length === 0) }); d.window.close();

  await sleep(1500);
  const ev = await api(`/api/sites/${SITE}/live`);
  check("redirect and banners were recorded as impressions", ev.events.some(e => e.type === "impression"));

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("ERROR", e); process.exit(2); });
