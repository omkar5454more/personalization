// End-to-end: the dashboard shell -- fast navigation, skeletons, stale-page protection, command palette, onboarding checklist.
const { JSDOM, VirtualConsole } = require("jsdom");
const BASE = process.env.BASE || "http://127.0.0.1:8011";
let cookie = "", failures = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) failures++; };
async function api(path, method = "GET", body) {
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const t = await r.text(); if (!r.ok) throw new Error(`${path} ${r.status} ${t.slice(0, 200)}`); return t ? JSON.parse(t) : null;
}

(async () => {
  await api("/api/auth/register", "POST", { email: `shell${Date.now()}@example.com`, password: "shell-test-password-1" });
  const siteA = (await api("/api/sites", "POST", { name: "Alpha shop", domain: "alpha.com" })).id;
  const siteB = (await api("/api/sites", "POST", { name: "Beta blog", domain: "beta.com" })).id;

  const requests = [];        // every URL the dashboard fetches
  let delay = {};              // path substring -> artificial latency (ms)
  const vc = new VirtualConsole(); const errors = [];
  vc.on("jsdomError", e => errors.push(String(e.message).slice(0, 200)));
  const dom = await JSDOM.fromURL(BASE + "/", {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = async (u, o = {}) => {
        const url = new URL(u, BASE).href; requests.push((o.method || "GET") + " " + url.replace(BASE, ""));
        const hit = Object.keys(delay).find(k => url.includes(k)); if (hit) await sleep(delay[hit]);
        return fetch(url, { ...o, headers: { ...(o.headers || {}), cookie } });
      };
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
    },
  });
  const w = dom.window, d = w.document;
  const view = () => d.querySelector("#view").textContent;
  const go = async (h, ms = 700) => { w.location.hash = h; await sleep(ms); };

  for (let i = 0; i < 80 && !d.querySelector("#sidebar"); i++) await sleep(100);
  check("boot needs the login check + sites in ONE request (/api/bootstrap)", requests.filter(r => r.includes("/api/bootstrap")).length === 1 && !requests.some(r => r.includes("/api/auth/me")), requests.join(", "));
  check("boot did not fetch the sites list separately", !requests.some(r => r === "GET /api/sites"), requests.join(", "));
  await sleep(500);

  // ---- sidebar: site switcher + grouped navigation
  await go(`#/site/${siteA}/overview`);
  const side = d.querySelector("#side-scroll").textContent;
  check("sidebar shows the site switcher with the current site", /Alpha shop/.test(side) && !!d.querySelector("#sw-btn"));
  check("navigation is grouped (Optimize / Insights / Setup)", ["Optimize", "Insights", "Setup"].every(g => side.includes(g)) && /Personalization/.test(side) && /Heatmaps/.test(side) && /Install & settings/.test(side));
  d.querySelector("#sw-btn").click();
  check("switcher lists every site", !d.querySelector("#sw-menu").hidden && d.querySelectorAll("#sw-menu [data-site]").length === 2);
  d.querySelector(`#sw-menu [data-site="${siteB}"]`).click(); await sleep(700);
  check("choosing another site opens it on the same page", w.location.hash === `#/site/${siteB}/overview` && /Beta blog/.test(d.querySelector("#crumbs").textContent));
  check("breadcrumb shows Sites / site / page", /Sites.*Beta blog.*Overview/.test(d.querySelector("#crumbs").textContent.replace(/\s+/g, " ")));

  // ---- moving between tabs must not re-fetch the sites list every time
  requests.length = 0;
  for (const tab of ["campaigns", "experiments", "audiences", "goals", "funnels"]) await go(`#/site/${siteB}/${tab}`, 500);
  const siteListCalls = requests.filter(r => r === "GET /api/sites").length;
  check("five tab changes cause at most one background sites refresh (it used to be five blocking ones)", siteListCalls <= 1, `${siteListCalls}: ${requests.join(", ")}`);

  // ---- skeleton shows instantly, then the real page replaces it
  delay = { "/overview": 600 };
  w.location.hash = `#/site/${siteB}/overview`; await sleep(120);
  check("a skeleton is shown immediately while the page loads", !!d.querySelector("#view .skeleton") && d.querySelector("#view").getAttribute("aria-busy") === null);
  check("the loading bar is running", d.querySelector("#nprog").className === "on");
  await sleep(900);
  check("the real page replaces the skeleton", !d.querySelector("#view .skeleton") && /Visitors/.test(view()));
  check("the loading bar finishes", d.querySelector("#nprog").className === "done");

  // ---- a slow page can never paint over a newer one
  delay = { "/overview": 900 };
  w.location.hash = `#/site/${siteB}/overview`; await sleep(150);
  w.location.hash = `#/site/${siteB}/audiences`; await sleep(1400);
  check("fast page B wins even when slow page A answers later", /Audiences/.test(view()) && !/Daily visitors/.test(view()), view().slice(0, 120));
  delay = {};

  // ---- cached lists: opening dialogs twice does not hit the server twice
  await go(`#/site/${siteB}/campaigns`);
  requests.length = 0;
  await w.openCampaignModal(w.eval("curSite()"), null, {}); await sleep(200);
  d.querySelector("#modal-root [data-close]").click();
  await w.openCampaignModal(w.eval("curSite()"), null, {}); await sleep(200);
  d.querySelector("#modal-root [data-close]").click();
  check("segments/goals are fetched once for two dialog openings", requests.filter(r => r.includes("/segments")).length <= 1 && requests.filter(r => r.includes("/goals")).length <= 1, requests.join(", "));

  // ---- onboarding checklist ticks itself off from real data
  await go(`#/site/${siteA}/overview`, 900);
  const todo = () => Array.from(d.querySelectorAll(".onboard .todo a"));
  check("a new site shows the getting-started checklist (0 of 5)", !!d.querySelector(".onboard") && todo().length === 5 && /0 of 5/.test(view()), view().slice(0, 200));
  await api(`/api/sites/${siteA}/goals`, "POST", { name: "Signup", type: "event", event_name: "signup" });
  await api(`/api/sites/${siteA}/segments`, "POST", { name: "Mobile", rules: [{ field: "device", op: "eq", value: "mobile" }] });
  w.eval("GET_CACHE.clear()");
  await w.route(); await sleep(900);
  check("creating a goal and an audience ticks two steps", /2 of 5/.test(view()) && todo().filter(a => a.classList.contains("done")).length === 2, view().slice(0, 200));
  d.querySelector("#onb-hide").click();
  check("the checklist can be dismissed", !d.querySelector(".onboard"));

  // ---- command palette
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })); await sleep(100);
  check("Ctrl+K opens the command palette", !!d.querySelector("#palette"));
  const input = d.querySelector("#pal-in"); input.value = "goals"; input.dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(50);
  check("typing filters the palette", /Goals/.test(d.querySelector("#pal-list").textContent) && d.querySelectorAll(".pal-item").length < 10);
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(700);
  check("Enter jumps to the chosen page and closes the palette", w.location.hash.endsWith("/goals") && !d.querySelector("#palette"));
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })); await sleep(50);
  const input2 = d.querySelector("#pal-in"); input2.value = "new audience"; input2.dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(50);
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(900);
  check("palette 'create' actions open the dialog", !!d.querySelector("#modal-root #sg-name"));
  d.querySelector("#modal-root [data-close]").click();
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  // ---- friendly failure
  delay = {};
  await go("#/site/site_doesnotexist/overview", 900);
  check("an unknown site address falls back to the sites list instead of a blank page", w.location.hash === "#/sites" && /All sites/.test(view()));

  check("no script errors", errors.length === 0, errors.join(" | "));
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("ERROR", e); process.exit(2); });
