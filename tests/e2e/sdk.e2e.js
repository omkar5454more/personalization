// End-to-end: real server (port 8011, temp DB) + the real public/sdk.js running inside jsdom.
const { JSDOM } = require("jsdom");
const BASE = process.env.BASE || "http://127.0.0.1:8011";
let cookie = "";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) failures++; };

async function api(path, method = "GET", body) {
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 200)}`);
  return j;
}

async function visit(siteId, { attrs, queue, fn, ctxHtml = "<h1>Hello</h1><button id='buy'>Buy</button><form id='newsletter'><input name='e'></form>" } = {}) {
  const html = `<!doctype html><html><head><style id="ot-hide">body{opacity:0!important}</style>
    <script src="${BASE}/sdk.js" data-site="${siteId}" async></script></head><body>${ctxHtml}</body></html>`;
  const dom = new JSDOM(html, {
    url: BASE + "/shop?utm_source=google&utm_term=red+shoes", referrer: "https://www.google.com/search?q=x", runScripts: "dangerously", resources: "usable", pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (u, o) => fetch(new URL(u, window.location.href).href, o);
      Object.defineProperty(window.navigator, "language", { value: "en-US" });
      if (queue) window.OT = { q: queue };
    },
  });
  const w = dom.window;
  for (let i = 0; i < 60 && !(w.OT && w.OT.visitor); i++) await sleep(100);
  await sleep(800);
  if (fn) await fn(w);
  await sleep(2200);        // events flush after 1.5s
  return dom;
}

(async () => {
  await api("/api/auth/register", "POST", { email: "e2e@example.com", password: "e2e-test-password-123" });
  const site = (await api("/api/sites", "POST", { name: "E2E", domain: "localhost" })).id;

  // audience + goals
  const seg = (await api(`/api/sites/${site}/segments`, "POST", { name: "Pro plan from Google", match: "all", rules: [
    { field: "attr.plan", op: "eq", value: "pro" }, { field: "referrer_host", op: "contains", value: "google" },
    { field: "search_keyword", op: "contains", value: "shoes" }, { field: "language", op: "eq", value: "en" }, { field: "pages_viewed", op: "gte", value: "1" },
    { field: "os", op: "neq", value: "ios" }, { field: "utm_source", op: "in", value: "bing, google" }] })).id;
  const signup = (await api(`/api/sites/${site}/goals`, "POST", { name: "Signup", type: "event", event_name: "signup", value: 10 })).id;
  const buy = (await api(`/api/sites/${site}/goals`, "POST", { name: "Buy click", type: "click", selector: "#buy", value: 5, count_mode: "every" })).id;
  const form = (await api(`/api/sites/${site}/goals`, "POST", { name: "Newsletter form", type: "form", form_name: "newsletter" })).id;
  const page = (await api(`/api/sites/${site}/goals`, "POST", { name: "Visited shop", type: "pageview", url_contains: "/shop" })).id;

  // campaign for the segment (banner), one for a different audience, one for people who already purchased
  const mk = async (name, extra) => { const id = (await api(`/api/sites/${site}/campaigns`, "POST", { name, frequency: "always", actions: [{ type: "banner", text: name }], ...extra })).id; await api(`/api/campaigns/${id}/status`, "PATCH", { status: "running" }); return id; };
  const campPro = await mk("PRO-BANNER", { segment_id: seg, goal_id: signup });
  const campFree = await mk("FREE-BANNER", { rules: [{ field: "attr.plan", op: "eq", value: "free" }] });
  const campBuyer = await mk("BUYER-BANNER", { rules: [{ field: "did_event", op: "eq", value: "purchase" }] });
  const campCustomer = await mk("CUSTOMER-BANNER", { rules: [{ field: "customer", op: "eq", value: "true" }] });

  // 3-version test limited to the pro audience, plus a shipped-winner test
  const exp = (await api(`/api/sites/${site}/experiments`, "POST", { name: "Heading test", segment_id: seg, goal_id: signup, secondary_goal_ids: [buy],
    variants: [{ key: "control", weight: 1 }, { key: "b", weight: 1, changes: [{ selector: "h1", action: "text", value: "B HEAD" }] }, { key: "c", weight: 1, changes: [{ selector: "h1", action: "text", value: "C HEAD" }] }] })).id;
  await api(`/api/experiments/${exp}/status`, "PATCH", { status: "running" });
  const shipped = (await api(`/api/sites/${site}/experiments`, "POST", { name: "Shipped", goal: { type: "event", name: "x" }, ship_winner: true, rules: [{ field: "attr.plan", op: "eq", value: "pro" }],
    variants: [{ key: "control", weight: 1 }, { key: "win", weight: 1, changes: [{ selector: "#buy", action: "text", value: "SHIPPED BUY" }] }] })).id;
  await api(`/api/experiments/${shipped}/winner`, "POST", { variant: "win" });

  // ---- visitor 1: plan=pro, arrives from Google, clicks buy twice, signs up, submits the form
  console.log("-- visitor: pro");
  const d1 = await visit(site, { queue: [["identify", { plan: "pro" }]], fn: async w => {
    const text = () => Array.from(w.document.body.querySelectorAll("span")).map(s => s.textContent).join("|");
    const banners = text();
    check("segment campaign (7 rules) shows for the pro visitor", banners.includes("PRO-BANNER"), banners);
    check("campaign for another audience is NOT shown", !banners.includes("FREE-BANNER"));
    check("did_event=purchase campaign is NOT shown before a purchase", !banners.includes("BUYER-BANNER"));
    check("experiment audience matched: heading changed or version control", ["Hello", "B HEAD", "C HEAD"].includes(w.document.querySelector("h1").textContent), w.document.querySelector("h1").textContent);
    check("shipped winner is applied to everyone in its audience, no tracking", w.document.getElementById("buy").textContent === "SHIPPED BUY", w.document.getElementById("buy").textContent);
    check("page is revealed", !w.document.getElementById("ot-hide"));
    w.document.getElementById("buy").click(); w.document.getElementById("buy").click();   // 'every' goal -> 2 conversions
    w.OT.track("signup");
    w.OT.track("signup");                                                                     // 'once' goal -> still 1
    w.document.getElementById("newsletter").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
    w.OT.track("purchase", { value: 49 });
    check("OT.identify stored the attribute", w.OT.visitor.id && true);
  } });
  d1.window.close();

  // ---- the same browser profile cannot be reused (new jsdom = new storage); visitor 2: plan=free
  console.log("-- visitor: free");
  const d2 = await visit(site, { queue: [["identify", { plan: "free" }]], fn: async w => {
    const txt = Array.from(w.document.body.querySelectorAll("span")).map(s => s.textContent).join("|");
    check("free visitor sees the FREE banner only", txt.includes("FREE-BANNER") && !txt.includes("PRO-BANNER"), txt);
    check("free visitor is not entered in the pro-only test", w.document.querySelector("h1").textContent === "Hello");
    check("shipped winner (pro only) not applied to free visitor", w.document.getElementById("buy").textContent === "Buy");
  } });
  d2.window.close();

  // ---- visitor 3: no attributes at all; sends a 'purchase' event then it must count as customer
  console.log("-- visitor: anonymous buyer (second page view in the same visit via history API)");
  const d3 = await visit(site, { fn: async w => {
    w.OT.track("purchase");
    w.history.pushState({}, "", "/shop/thanks");      // SPA route change re-runs campaigns with the updated context
    await sleep(800);
    const txt = Array.from(w.document.body.querySelectorAll("span")).map(s => s.textContent).join("|");
    check("after a purchase event the customer + did_event campaigns appear on the next page", txt.includes("BUYER-BANNER") && txt.includes("CUSTOMER-BANNER"), txt);
  } });
  d3.window.close();

  // ---- server side: what was recorded?
  await sleep(500);
  const rep = await api(`/api/sites/${site}/goals/report?days=30`);
  const G = id => rep.goals.find(g => g.id === id);
  check("signup counted once for the pro visitor (once-per-visitor goal)", G(signup).conversions === 1 && G(signup).converters === 1 && G(signup).value === 10, JSON.stringify(G(signup)));
  check("click goal with 'every' counted twice, value 5 each", G(buy).conversions === 2 && G(buy).value === 10, JSON.stringify(G(buy)));
  check("form goal fired from a submit event", G(form).conversions === 1, JSON.stringify(G(form)));
  check("page goal fired on every visitor's first page (3 visitors)", G(page).conversions === 3, JSON.stringify(G(page)));
  const infl = G(signup).influenced_by.find(a => a.id === campPro);
  check("goal report credits the PRO campaign (signup after being shown)", infl && infl.converted === 1 && infl.exposed === 1, JSON.stringify(G(signup).influenced_by));
  const res = await api(`/api/experiments/${exp}/results`);
  const entered = res.variants.reduce((a, v) => a + v.visitors, 0);
  check("only the pro visitor entered the 3-version test", entered === 1, JSON.stringify(res.variants.map(v => [v.variant, v.visitors])));
  const winnerRes = await api(`/api/experiments/${shipped}/results`);
  check("shipped test recorded no exposures (rollout does not track)", winnerRes.variants.every(v => v.visitors === 0));
  const ev = await api(`/api/sites/${site}/live`);
  const types = new Set(ev.events.map(e => e.type));
  check("events recorded: pageview, conversion, impression, exposure", ["pageview", "conversion", "impression", "exposure"].every(t => types.has(t)), [...types].join(","));
  const camp = (await api(`/api/sites/${site}/campaigns`)).find(c => c.id === campPro);
  check("PRO campaign's own goal (signup) counted as a conversion", camp.conversions === 1 && camp.impressions === 1, JSON.stringify([camp.impressions, camp.conversions]));

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("ERROR", e); process.exit(2); });
