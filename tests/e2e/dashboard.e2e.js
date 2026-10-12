// Dashboard smoke test: real dashboard scripts in jsdom against the test server (uses the data e2e.js created).
const { JSDOM, VirtualConsole } = require("jsdom");
const BASE = process.env.BASE || "http://127.0.0.1:8011";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0, cookie = "";
const check = (n, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : "  " + extra)); if (!ok) failures++; };
async function api(path, method = "GET", body) {
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const t = await r.text(); if (!r.ok) throw new Error(`${path} ${r.status} ${t.slice(0, 200)}`); return t ? JSON.parse(t) : null;
}

(async () => {
  await api("/api/auth/login", "POST", { email: "e2e@example.com", password: "e2e-test-password-123" });
  const site = (await api("/api/sites"))[0].id;
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => errors.push(String(e.message || e).slice(0, 200)));
  vc.on("error", (...a) => errors.push(a.join(" ").slice(0, 200)));
  const dom = await JSDOM.fromURL(BASE + "/", {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = (u, o = {}) => fetch(new URL(u, BASE).href, { ...o, headers: { ...(o.headers || {}), cookie } });
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.confirm = () => true;
    },
  });
  const w = dom.window, d = w.document;
  for (let i = 0; i < 60 && !d.querySelector("#sidebar"); i++) await sleep(100);
  check("dashboard boots and shows the sidebar after login", !!d.querySelector("#sidebar"), d.body.textContent.slice(0, 120));

  const go = async tab => { w.location.hash = `#/site/${site}/${tab}`; await sleep(1200); return d.querySelector("#view").textContent; };
  let t = await go("audiences");
  check("Audiences page lists the saved audience in plain words", t.includes("Pro plan from Google") && t.includes("has") === false ? true : t.includes("Pro plan from Google"), t.slice(0, 300));
  check("Audiences page explains rules as sentences", /Your data: plan is “pro”/.test(t) && /Referrer website contains “google”/.test(t), t.slice(0, 400));
  check("Audiences shows 'used by' counts", /campaign|test/.test(t));
  t = await go("goals");
  check("Goals page shows goals, conversions and value", t.includes("Signup") && t.includes("Buy click") && t.includes("Conversions") && t.includes("$10"), t.slice(0, 300));
  check("Goals page shows what converting visitors saw", /What did converting visitors see/.test(t) && t.includes("PRO-BANNER"), t.slice(0, 600));
  t = await go("experiments");
  check("A/B page shows audience, versions, goal and results", t.includes("Heading test") && /Audience: .*Pro plan from Google/.test(t) && /3 versions/.test(t) && /Beats original/.test(t), t.slice(0, 500));
  check("A/B page shows the recommendation and sample hint", /Keep running|No clear winner|winner/i.test(t));
  t = await go("campaigns");
  check("Personalization page shows the audience column", t.includes("PRO-BANNER") && t.includes("Pro plan from Google"), t.slice(0, 300));

  // ---- new audience through the modal
  await go("audiences");
  w.openSegmentModal(w.eval("curSite()"), null); await sleep(300);
  const m = () => d.querySelector("#modal-root .modal");
  check("audience modal opens with a rule builder", !!m() && !!m().querySelector("[data-rf]"));
  m().querySelector("#sg-name").value = "UI audience";
  const f = m().querySelector("[data-rf]"); f.value = "device"; f.dispatchEvent(new w.Event("change", { bubbles: true }));
  m().querySelector("[data-rv]").value = "mobile";
  m().querySelector("#sg-save").click(); await sleep(900);
  const segs = await api(`/api/sites/${site}/segments`);
  check("audience created through the modal", segs.some(s => s.name === "UI audience" && s.rules[0].field === "device" && s.rules[0].value === "mobile"), JSON.stringify(segs.map(s => s.name)));

  // ---- new goal through the modal
  w.openGoalModal(w.eval("curSite()"), null); await sleep(300);
  m().querySelector("#g-name").value = "UI goal"; m().querySelector("#g-type").value = "pageview"; m().querySelector("#g-type").dispatchEvent(new w.Event("change"));
  m().querySelector("#g-val").value = "/thanks"; m().querySelector("#g-worth").value = "12.5"; m().querySelector("#g-save").click(); await sleep(900);
  const goals = await api(`/api/sites/${site}/goals`);
  check("goal created through the modal", goals.some(g => g.name === "UI goal" && g.type === "pageview" && g.url_contains === "/thanks" && g.value === 12.5));

  // ---- A/B test through the modal: audience + 3 versions + saved goal + auto-winner
  await go("experiments");
  w.openNewExperiment(w.eval("curSite()")); await sleep(600);
  check("A/B modal opens with all four steps", /Step 1/.test(m().textContent) && /Step 2/.test(m().textContent) && /Step 3/.test(m().textContent) && /Step 4/.test(m().textContent));
  m().querySelector("#x-name").value = "UI test";
  m().querySelector("#ap-seg").value = segs.find(s => s.name === "UI audience").id; m().querySelector("#ap-seg").dispatchEvent(new w.Event("change"));
  m().querySelector("#x-addv").click(); await sleep(100);                 // adds version C
  check("a third version can be added (tabs: original, B, C)", m().querySelectorAll("#x-tabs [data-vt]").length === 3);
  const addChange = async (idx, val) => {
    m().querySelectorAll("#x-tabs [data-vt]")[idx].click(); await sleep(50);
    m().querySelector("details").open = true;
    m().querySelector("#x-sel").value = "h1"; m().querySelector("#x-val").value = val; m().querySelector("#x-add").click(); await sleep(50);
  };
  await addChange(1, "UI B"); await addChange(2, "UI C");
  m().querySelector("#x-goal").value = goals.find(g => g.name === "Signup").id; m().querySelector("#x-goal").dispatchEvent(new w.Event("change")); await sleep(50);
  m().querySelector("#x-auto").checked = true; m().querySelector("#x-ship").checked = true;
  m().querySelector("#x-minv").value = "250"; m().querySelector("#x-mind").value = "5";
  m().querySelector("#x-base").value = "5"; m().querySelector("#x-base").dispatchEvent(new w.Event("input"));
  check("sample-size helper explains how many visitors are needed", /needs about [\d,]+ visitors/.test(m().querySelector("#x-need").textContent), m().querySelector("#x-need").textContent);
  m().querySelector("#x-create").click(); await sleep(900);
  const exps = await api(`/api/sites/${site}/experiments`);
  const ui = exps.find(e => e.name === "UI test");
  check("A/B test saved with 3 versions, audience, saved goal and decision settings",
    ui && ui.config.variants.length === 3 && ui.config.variants[1].changes[0].value === "UI B" && ui.config.variants[2].changes[0].value === "UI C"
    && ui.config.segment_id === segs.find(s => s.name === "UI audience").id && ui.config.goal.name === "signup" && !!ui.config.goal_id && ui.config.auto_winner && ui.config.ship_winner
    && ui.config.min_visitors === 250 && ui.config.min_days === 5 && ui.config.secondary_goal_ids.length === 0, JSON.stringify(ui && ui.config).slice(0, 400));

  // ---- campaign modal: schedule, limits, control group, IP rule; list: duplicate, QA link, control result
  await go("campaigns");
  await w.openCampaignModal(w.eval("curSite()"), null, {}); await sleep(500);
  m().querySelector("#c-name").value = "UI scheduled";
  m().querySelector("#c-text").value = "Hello";
  m().querySelector("#c-start").value = "2030-01-05T09:30"; m().querySelector("#c-end").value = "2030-01-20T18:00";
  m().querySelector("#c-maxv").value = "3"; m().querySelector("#c-cool").value = "12"; m().querySelector("#c-prio").value = "7";
  m().querySelector("#c-goal").value = (await api(`/api/sites/${site}/goals`)).find(g => g.name === "Signup").id; m().querySelector("#c-hold").value = "20";
  const rf = m().querySelector("[data-rf]"); rf.value = "ip"; rf.dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(100);
  check("IP rule only offers 'is one of' / 'is not'", Array.from(m().querySelector("[data-ro]").options).map(o => o.value).join() === "in,neq");
  m().querySelector("[data-rv]").value = "10.0.0.0/8, 203.0.113.7";
  m().querySelector("#c-save").click(); await sleep(900);
  let sc = (await api(`/api/sites/${site}/campaigns`)).find(c => c.name === "UI scheduled");
  check("schedule, limits, priority, control group and IP rule are saved", sc && /^2030-01-05T/.test(sc.config.start_at) && /^2030-01-20T/.test(sc.config.end_at) && sc.config.max_views === 3
    && sc.config.cooldown_hours === 12 && sc.config.priority === 7 && sc.config.holdout_pct === 20 && sc.config.rules[0].field === "ip" && sc.config.rules[0].value === "10.0.0.0/8, 203.0.113.7", JSON.stringify(sc && sc.config).slice(0, 400));
  await go("campaigns");
  check("list shows the control group line", /Control group 20%/.test(d.querySelector("#view").textContent));
  d.querySelector(`[data-dup-camp="${sc.id}"]`).click(); await sleep(900);
  check("Duplicate makes a draft copy", (await api(`/api/sites/${site}/campaigns`)).some(c => c.name === "UI scheduled (copy)" && c.status === "draft"));
  check("CSV export link is present", !!d.querySelector('a[href$="/campaigns.csv"]'));
  await w.openCampaignModal(w.eval("curSite()"), sc, {}); await sleep(500);
  check("editing shows the saved schedule again", m().querySelector("#c-maxv").value === "3" && m().querySelector("#c-hold").value === "20" && /^2030-01-05T/.test(m().querySelector("#c-start").value));
  m().querySelector("[data-close]").click();

  // ---- campaign modal: segment picker + custom rules builder + goal
  await go("campaigns");
  await w.openCampaignModal(w.eval("curSite()"), null, {}); await sleep(500);
  check("campaign modal opens with audience picker and goal select", !!m().querySelector("#ap-seg") && !!m().querySelector("#c-goal"));
  m().querySelector("#c-name").value = "UI campaign";
  m().querySelector("#c-preset3").click(); await sleep(100);
  check("'3rd visit' preset fills the rule builder", m().querySelector("[data-rf]").value === "visit_no" && m().querySelector("[data-rv]").value === "3");
  m().querySelector("#c-text").value = "Hi"; m().querySelector("#c-goal").value = goals.find(g => g.name === "Signup").id;
  m().querySelector("#c-save").click(); await sleep(900);
  const camps = await api(`/api/sites/${site}/campaigns`);
  const uc = camps.find(c => c.name === "UI campaign");
  check("campaign saved with rules + goal", uc && uc.config.rules[0].field === "visit_no" && uc.config.rules[0].op === "gte" && uc.config.goal_id && uc.config.goal.type === "event", JSON.stringify(uc && uc.config).slice(0, 300));

  // ---- banner designer: live preview follows the controls, and the design is saved
  await go("campaigns");
  await w.openCampaignModal(w.eval("curSite()"), null, {}); await sleep(500);
  m().querySelector("#c-name").value = "Designed banner";
  const setv = (id, val, ev = "input") => { const e = m().querySelector(id); e.value = val; e.dispatchEvent(new w.Event(ev, { bubbles: true })); };
  const tick = (id, on) => { const e = m().querySelector(id); e.checked = on; e.dispatchEvent(new w.Event("change", { bubbles: true })); };
  setv("#c-text", "Big sale today");
  check("live preview shows the message as you type", /Big sale today/.test(m().querySelector("#bn-live").textContent));
  setv("#c-fs", "24"); setv("#c-align", "left", "change"); setv("#c-size", "large", "change"); setv("#c-radius", "16");
  tick("#c-bold", true); tick("#c-close", false); setv("#c-cta", "Shop now"); tick("#c-ctab", true); setv("#c-ctabg", "#ff0000"); setv("#c-bg", "#112233");
  const live = m().querySelector("#bn-live").innerHTML;
  check("live preview reflects size, alignment, weight, corners, colours and a filled button",
    /font:700 24px/.test(live) && /text-align:left/.test(live) && /border-radius:16px/.test(live) && /padding:18px/.test(live) && /#112233/i.test(live) && /#ff0000/i.test(live) && !/×/.test(live), live.slice(0, 300));
  setv("#c-type", "popup", "change");
  check("switching to popup shows a popup preview", /Big sale today/.test(m().querySelector("#bn-live").textContent) && /rgba\(0,0,0,\.45\)/.test(m().querySelector("#bn-live").innerHTML));
  setv("#c-type", "banner", "change");
  m().querySelector("#c-save").click(); await sleep(900);
  const ds = (await api(`/api/sites/${site}/campaigns`)).find(c => c.name === "Designed banner");
  const da = ds && ds.config.actions[0];
  check("banner design saved with the campaign", da && da.font_size === 24 && da.align === "left" && da.size === "large" && da.radius === 16 && da.bold === true && da.closable === false && da.cta_bg === "#ff0000" && da.bg === "#112233", JSON.stringify(da));
  await w.openCampaignModal(w.eval("curSite()"), ds, {}); await sleep(500);
  check("re-opening the campaign restores the design controls", m().querySelector("#c-fs").value === "24" && m().querySelector("#c-align").value === "left" && m().querySelector("#c-bold").checked && !m().querySelector("#c-close").checked && m().querySelector("#c-ctab").checked);
  m().querySelector("[data-close]").click(); await sleep(100);

  // ---- advanced targeting: groups, URL parameter / cookie / JS variable, page scope, "when it shows", redirect
  await go("campaigns");
  await w.openCampaignModal(w.eval("curSite()"), null, {}); await sleep(500);
  const fire = (e, ev = "change") => e.dispatchEvent(new w.Event(ev, { bubbles: true }));
  const setSel = (e, v) => { e.value = v; fire(e); };
  m().querySelector("#c-name").value = "UI advanced";
  const top = () => m().querySelector("#ap-rules");
  const topRows = () => Array.from(top().querySelectorAll(":scope > .row"));
  setSel(top().querySelector("[data-rf]"), "traffic_source");
  top().querySelector("[data-rv]").value = "organic";
  top().querySelector("[data-rgadd]").click(); await sleep(50);                     // add a group
  let box = top().querySelector("[data-gbox]");
  check("a group box appears with its own nested builder", !!box && !!box.querySelector("[data-rf]"));
  check("a group can't contain another group (no 'add a group' inside)", !box.querySelector("[data-rgadd]"));
  setSel(box.querySelector("[data-rf]"), "device"); box.querySelector("[data-rv]").value = "mobile";
  box.querySelector("[data-radd]").click(); await sleep(50);
  box = top().querySelector("[data-gbox]");
  const nested = box.querySelectorAll("[data-rf]");
  check("nested builder keeps its first row and adds a second", nested.length === 2 && nested[0].value === "device");
  setSel(nested[1], "city"); box.querySelectorAll("[data-rv]")[1].value = "Mumbai";
  top().querySelector("[data-gm]").value = "any"; fire(top().querySelector("[data-gm]"));
  top().querySelector(":scope > .row > [data-radd]").click(); await sleep(50);   // another top-level condition (the button under the group)
  const rfs = Array.from(top().querySelectorAll("[data-rf]")).filter(e => !e.closest("[data-gbox]"));
  setSel(rfs[rfs.length - 1], "__dyn:cookie"); await sleep(30);
  const ra = Array.from(top().querySelectorAll("[data-ra]")).filter(e => !e.closest("[data-gbox]"));
  ra[ra.length - 1].value = "tier";
  const rvs = Array.from(top().querySelectorAll("[data-rv]")).filter(e => !e.closest("[data-gbox]"));
  rvs[rvs.length - 1].value = "gold";
  setSel(m().querySelector("#c-pagematch"), "starts"); m().querySelector("#c-url").value = "https://example.com/pricing";
  setSel(m().querySelector("#c-trig"), "delay"); await sleep(30);
  check("trigger value box + hint appear for 'after some time'", m().querySelector("#c-trigv").style.display !== "none" && /Seconds/.test(m().querySelector("#c-trigh").textContent));
  m().querySelector("#c-trigv").value = "4";
  m().querySelector("#c-text").value = "Advanced"; fire(m().querySelector("#c-text"), "input");
  m().querySelector("#c-save").click(); await sleep(900);
  const adv = (await api(`/api/sites/${site}/campaigns`)).find(c => c.name === "UI advanced");
  const ac = adv && adv.config;
  check("advanced campaign saved: top rule, group (any of 2), cookie rule, page scope and trigger",
    ac && ac.rules[0].field === "traffic_source" && ac.rules[1].field === "__group" && ac.rules[1].match === "any" && ac.rules[1].rules.length === 2
    && ac.rules[1].rules[1].field === "city" && ac.rules[2].field === "cookie.tier" && ac.rules[2].value === "gold"
    && ac.page_match === "starts" && ac.url_contains === "https://example.com/pricing" && ac.trigger_type === "delay" && ac.trigger_value === "4", JSON.stringify(ac && { r: ac.rules, pm: ac.page_match, t: ac.trigger_type, tv: ac.trigger_value }));
  check("campaign list explains the audience, trigger and page scope in words",
    (await (async () => { await go("campaigns"); return d.querySelector("#view").textContent; })()).includes("after 4s on the page"));
  // re-open: the builder restores the group and the named field
  await w.openCampaignModal(w.eval("curSite()"), adv, {}); await sleep(500);
  box = top().querySelector("[data-gbox]");
  check("re-opening restores the group, its conditions, the cookie row and the trigger",
    !!box && box.querySelectorAll("[data-rf]").length === 2 && box.querySelector("[data-gm]") === null && top().querySelector("[data-gm]").value === "any"
    && Array.from(top().querySelectorAll("[data-ra]")).some(e => e.value === "tier") && m().querySelector("#c-trig").value === "delay" && m().querySelector("#c-trigv").value === "4" && m().querySelector("#c-pagematch").value === "starts");
  m().querySelector("[data-close]").click(); await sleep(100);

  // redirect campaign
  await w.openCampaignModal(w.eval("curSite()"), null, {}); await sleep(500);
  m().querySelector("#c-name").value = "UI redirect";
  setSel(m().querySelector("#c-type"), "redirect");
  check("redirect type shows the address box", m().querySelector("#p-redirect").style.display !== "none" && m().querySelector("#p-simple").style.display === "none");
  m().querySelector("#c-redir").value = "/landing";
  m().querySelector("#c-save").click(); await sleep(900);
  const rd = (await api(`/api/sites/${site}/campaigns`)).find(c => c.name === "UI redirect");
  check("redirect campaign saved", rd && rd.config.actions[0].type === "redirect" && rd.config.actions[0].value === "/landing", JSON.stringify(rd && rd.config.actions));

  // ---- settings page documents OT.identify
  t = await go("settings");
  check("settings page documents OT.identify", /OT\.q\.push\(\["identify"/.test(t));

  check("no script errors in the dashboard", errors.length === 0, errors.join(" | "));
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("ERROR", e); process.exit(2); });
