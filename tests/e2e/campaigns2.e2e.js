// End-to-end: frequency caps, control group, priority / one overlay, QA link, analytics events, IP rule, goals on other pages -- real sdk.js in jsdom.
const { JSDOM } = require("jsdom");
const BASE = process.env.BASE || "http://127.0.0.1:8011";
let cookie = "", SITE, failures = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) failures++; };
async function api(path, method = "GET", body) {
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const t = await r.text(); if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 200)}`); return t ? JSON.parse(t) : null;
}
async function visit(o = {}) {
  const html = `<!doctype html><html><head><script src="${BASE}/sdk.js" data-site="${SITE}" async></script></head><body><h1>Hello</h1></body></html>`;
  const dom = new JSDOM(html, {
    url: BASE + (o.path || "/"), runScripts: "dangerously", resources: "usable", pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (u, init = {}) => fetch(new URL(u, w.location.href).href, init);
      if (o.gtag) { w.__gtag = []; w.gtag = (...a) => w.__gtag.push(a); }
      if (o.queue) w.OT = { q: o.queue };
    },
  });
  const w = dom.window;
  for (let i = 0; i < 60 && !(w.OT && w.OT.visitor); i++) await sleep(100);
  await sleep(600);
  if (o.fn) await o.fn(w);
  await sleep(250);
  return dom;
}
const banners = w => Array.from(w.document.body.querySelectorAll("div[role=region] span")).map(s => s.textContent);
const count = (w, t) => banners(w).filter(x => x === t).length;
const nav = async (w, p) => { w.history.pushState({}, "", p); await sleep(450); };

(async () => {
  await api("/api/auth/register", "POST", { email: `c2${Date.now()}@example.com`, password: "campaigns2-test-pass-1" });
  SITE = (await api("/api/sites", "POST", { name: "C2", domain: "localhost" })).id;
  const mk = async (name, extra = {}) => {
    const id = (await api(`/api/sites/${SITE}/campaigns`, "POST", { name, frequency: "always", actions: [{ type: "banner", text: name }], ...extra })).id;
    await api(`/api/campaigns/${id}/status`, "PATCH", { status: "running" }); return id;
  };
  const events = async () => (await api(`/api/sites/${SITE}/live`)).events;
  const R = (f, o, v) => ({ field: f, op: o, value: v });

  console.log("-- one overlay per page, priority order");
  const low = await mk("LOW-PRIO", { priority: 1, rules: [R("attr.t", "eq", "prio")] });
  const high = await mk("HIGH-PRIO", { priority: 9, rules: [R("attr.t", "eq", "prio")] });
  await api(`/api/sites/${SITE}`, "PATCH", { settings: { one_overlay: true } }); await sleep(300);
  let d = await visit({ queue: [["identify", { t: "prio" }]], fn: async w => {
    check("only the highest-priority banner is shown", banners(w).join("|") === "HIGH-PRIO", banners(w).join("|"));
  } }); d.window.close();
  await api(`/api/sites/${SITE}`, "PATCH", { settings: { one_overlay: false } }); await sleep(300);
  d = await visit({ queue: [["identify", { t: "prio" }]], fn: async w => {
    check("with 'one overlay' switched off both banners show", banners(w).length === 2, banners(w).join("|"));
  } }); d.window.close();
  await api(`/api/campaigns/${low}/status`, "PATCH", { status: "paused" }); await api(`/api/campaigns/${high}/status`, "PATCH", { status: "paused" });

  console.log("-- frequency caps");
  await mk("CAP2", { max_views: 2, rules: [R("attr.t", "eq", "cap")] });
  d = await visit({ queue: [["identify", { t: "cap" }]], fn: async w => {
    for (const p of ["/a", "/b", "/c", "/d"]) await nav(w, p);
    check("max_views=2: shown on 2 page views out of 5", count(w, "CAP2") === 2, String(count(w, "CAP2")));
  } }); d.window.close();
  await mk("COOL", { cooldown_hours: 1, rules: [R("attr.t", "eq", "cool")] });
  d = await visit({ queue: [["identify", { t: "cool" }]], fn: async w => {
    for (const p of ["/a", "/b"]) await nav(w, p);
    check("cooldown: not shown again within the hour", count(w, "COOL") === 1, String(count(w, "COOL")));
  } }); d.window.close();

  console.log("-- control group (holdout)");
  const goal = (await api(`/api/sites/${SITE}/goals`, "POST", { name: "Hold", type: "event", event_name: "holdgoal" })).id;
  const held = await mk("HELD", { holdout_pct: 50, goal_id: goal, rules: [R("attr.t", "eq", "hold")] });
  let shown = 0, control = 0;
  for (let i = 0; i < 16; i++) {
    d = await visit({ queue: [["identify", { t: "hold" }]], fn: async w => {
      const before = count(w, "HELD");
      for (const p of ["/x", "/y"]) await nav(w, p);                       // a visitor never flips group on later pages
      const after = count(w, "HELD");
      if (before) { shown++; if (after < 1) check("shown group keeps seeing it", false); } else { control++; if (after !== 0) check("control visitor never gets the campaign later", false, String(after)); }
      w.OT.track("holdgoal");
    } }); d.window.close();
  }
  check(`50% holdout splits visitors into both groups (shown ${shown}, control ${control})`, shown >= 2 && control >= 2 && shown + control === 16);
  await sleep(1800);
  const camp = (await api(`/api/sites/${SITE}/campaigns`)).find(c => c.id === held);
  const cr = camp.control_results;
  const sv = cr && cr.variants.find(v => v.variant === "shown"), cv = cr && cr.variants.find(v => v.variant === "control");
  check("results compare shown vs control on the goal", cr && sv.visitors === shown && cv.visitors === control && sv.conversions === shown && cv.conversions === control, JSON.stringify(cr && cr.variants.map(v => [v.variant, v.visitors, v.conversions])));
  await api(`/api/campaigns/${held}/status`, "PATCH", { status: "paused" });

  console.log("-- goal reached on another page");
  const thanks = (await api(`/api/sites/${SITE}/goals`, "POST", { name: "Thanks page", type: "pageview", url_contains: "/thanks" })).id;
  const other = await mk("OTHERPAGE", { page_match: "equals", url_contains: "/landing", goal_id: thanks, rules: [R("attr.t", "eq", "other")] });
  d = await visit({ path: "/landing", queue: [["identify", { t: "other" }]], fn: async w => {
    check("campaign shows on its own page", count(w, "OTHERPAGE") === 1);
    await nav(w, "/thanks"); await sleep(1700);
  } }); d.window.close();
  await sleep(500);
  const oc = (await api(`/api/sites/${SITE}/campaigns`)).find(c => c.id === other);
  check("conversion on /thanks is credited to the campaign shown on /landing", oc.impressions === 1 && oc.conversions === 1, JSON.stringify([oc.impressions, oc.conversions]));
  await api(`/api/campaigns/${other}/status`, "PATCH", { status: "paused" });

  console.log("-- QA link");
  const qa = await mk("QA-ONLY", { rules: [R("attr.t", "eq", "never-matches")] });
  const bystander = await mk("BYSTANDER", {});
  const before = (await events()).filter(e => e.exp_id === qa).length;
  d = await visit({ path: `/?ot_force=${qa}`, fn: async w => {
    check("QA link shows the campaign even though its rules don't match", banners(w).includes("QA-ONLY"), banners(w).join("|"));
    check("QA link shows only that campaign", !banners(w).includes("BYSTANDER"));
    check("QA ribbon is visible", /QA preview: QA-ONLY/.test(w.document.body.textContent));
  } }); d.window.close();
  await sleep(1800);
  check("QA preview records nothing", (await events()).filter(e => e.exp_id === qa).length === before);
  d = await visit({ path: "/", fn: async w => check("without the link the campaign stays hidden and the bystander shows", !banners(w).includes("QA-ONLY") && banners(w).includes("BYSTANDER")) }); d.window.close();
  await api(`/api/campaigns/${qa}/status`, "PATCH", { status: "paused" }); await api(`/api/campaigns/${bystander}/status`, "PATCH", { status: "paused" });

  console.log("-- IP address rule");
  const ipIn = await mk("IP-CIDR", { rules: [R("ip", "in", "127.0.0.0/8")] });
  const ipOut = await mk("IP-OTHER", { rules: [R("ip", "in", "10.0.0.0/8, 192.168.1.10-192.168.1.50")] });
  const ipRange = await mk("IP-RANGE", { rules: [R("ip", "eq", "127.0.0.1-127.0.0.5")] });
  const ipNot = await mk("IP-NOT", { rules: [R("ip", "neq", "203.0.113.0/24")] });
  const ipExact = await mk("IP-EXACT", { rules: [R("ip", "eq", "127.0.0.1")] });
  d = await visit({ fn: async w => {
    const b = banners(w).join("|");
    check("IP in a CIDR block matches", banners(w).includes("IP-CIDR"), b);
    check("IP outside the listed ranges does not match", !banners(w).includes("IP-OTHER"));
    check("IP inside an a-b range matches", banners(w).includes("IP-RANGE"));
    check("'is not' rule matches when the IP is elsewhere", banners(w).includes("IP-NOT"));
    check("exact address matches", banners(w).includes("IP-EXACT"));
  } }); d.window.close();
  for (const id of [ipIn, ipOut, ipRange, ipNot, ipExact]) await api(`/api/campaigns/${id}/status`, "PATCH", { status: "paused" });
  await api(`/api/sites/${SITE}`, "PATCH", { settings: { one_overlay: false } });

  console.log("-- analytics events (dataLayer / gtag)");
  const ga = await mk("GA-CAMPAIGN", {});
  d = await visit({ gtag: true, fn: async w => {
    check("nothing is pushed while the setting is off", !(w.dataLayer || []).some(x => /^optimize_/.test(x.event || "")));
  } }); d.window.close();
  await api(`/api/sites/${SITE}`, "PATCH", { settings: { ga_events: true } }); await sleep(300);
  d = await visit({ gtag: true, fn: async w => {
    const dl = (w.dataLayer || []).filter(x => /^optimize_/.test(x.event || ""));
    check("campaign impression reaches dataLayer", dl.some(x => x.event === "optimize_campaign_shown" && x.optimize_name === "GA-CAMPAIGN" && x.optimize_id === ga), JSON.stringify(dl));
    check("campaign impression reaches gtag", (w.__gtag || []).some(a => a[0] === "event" && a[1] === "optimize_campaign_shown"));
  } }); d.window.close();
  await api(`/api/sites/${SITE}`, "PATCH", { settings: { ga_events: false } });

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("ERROR", e); process.exit(2); });
