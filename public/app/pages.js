/* Pages. Each receives the #view element and renders into it. */
"use strict";

// ---------------------------------------------------------------- shared bits
function kpi(label, value, hint = "") {
  return `<div class="card kpi"><div class="lbl">${esc(label)}</div><div class="val">${value}</div><div class="hint">${hint}</div></div>`;
}
function barList(rows, empty = "No data yet") {
  if (!rows.length) return `<div class="muted">${esc(empty)}</div>`;
  const max = Math.max(...rows.map(r => r.visitors ?? r.count ?? 0), 1);
  return rows.map(r => {
    const v = r.visitors ?? r.count ?? 0;
    return `<div class="bar-row"><span class="name" title="${esc(r.name)}">${esc(r.name || "(none)")}</span>
      <div class="bar"><i style="width:${(v / max * 100).toFixed(1)}%"></i></div><span class="right">${fmtNum(v)}</span></div>`;
  }).join("");
}
function dayList(days) { // UTC dates, oldest -> newest, matching the server's date(ts,'unixepoch')
  const out = [], now = new Date();
  for (let i = days - 1; i >= 0; i--) out.push(new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10));
  return out;
}
function stackedChart(daily, days) {
  const byDay = Object.fromEntries(daily.map(d => [d.d, d]));
  const list = dayList(days).map(d => ({ d, n: byDay[d]?.new_v || 0, r: byDay[d]?.ret_v || 0, pv: byDay[d]?.pageviews || 0 }));
  const W = 720, H = 220, L = 38, B = 24, T = 10, R = 6, ih = H - B - T, iw = W - L - R;
  const rawMax = Math.max(...list.map(x => x.n + x.r), 1);
  const step = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const max = Math.ceil(rawMax / step * 2) / 2 * step || 1;
  const y = v => T + ih - (v / max) * ih;
  const slot = iw / list.length, bw = Math.min(30, slot * 0.64);
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = max * i / 4;
    g += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`;
  }
  let bars = "", hits = "", labels = "";
  list.forEach((x, i) => {
    const cx = L + slot * i + slot / 2, x0 = cx - bw / 2;
    const hn = (x.n / max) * ih, hr = (x.r / max) * ih;
    if (x.n) bars += `<rect x="${x0}" y="${T + ih - hn}" width="${bw}" height="${hn}" rx="3" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2"/>`;
    if (x.r) bars += `<rect x="${x0}" y="${T + ih - hn - hr}" width="${bw}" height="${hr}" rx="3" fill="var(--series-2)" stroke="var(--surface)" stroke-width="2"/>`;
    hits += `<rect class="hit" data-i="${i}" x="${L + slot * i}" y="${T}" width="${slot}" height="${ih}"/>`;
    if (i === 0 || i === list.length - 1 || i === Math.floor(list.length / 2)) labels += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${x.d.slice(5)}</text>`;
  });
  return { html: `<div class="chart"><div class="legend"><span><i style="background:var(--series-1)"></i>New visitors</span><span><i style="background:var(--series-2)"></i>Returning visitors</span></div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily visitors, new versus returning">${g}${bars}${labels}${hits}</svg></div>`, list };
}
function bindChart(root, list) {
  $$(".hit", root).forEach(h => {
    h.addEventListener("mousemove", e => {
      const x = list[+h.dataset.i];
      showTip(`<b>${esc(x.d)}</b><br>New: ${x.n}<br>Returning: ${x.r}<br>Pageviews: ${x.pv}`, e.clientX, e.clientY);
    });
    h.addEventListener("mouseleave", hideTip);
  });
}
function chartTable(list) { // accessible table view of the chart
  return `<details style="margin-top:8px"><summary class="muted" style="cursor:pointer">Show as table</summary><div class="table-wrap"><table>
    <thead><tr><th>Date</th><th class="right">New</th><th class="right">Returning</th><th class="right">Pageviews</th></tr></thead>
    <tbody>${list.map(x => `<tr><td>${esc(x.d)}</td><td class="right">${x.n}</td><td class="right">${x.r}</td><td class="right">${x.pv}</td></tr>`).join("")}</tbody></table></div></details>`;
}

// ---------------------------------------------------------------- All sites
async function pageSites(view) {
  const sites = S.sites;
  const sum = k => sites.reduce((a, s) => a + (s.experiments[k] || 0) * (k === "running" ? 1 : 0), 0);
  const runningCamps = sites.reduce((a, s) => a + (s.campaigns.running || 0), 0);
  const connected = sites.filter(s => s.status === "live" || s.status === "receiving").length;
  view.innerHTML = `<div class="page-head"><div><h1>All sites</h1>
    <div class="sub">Every website connected to Optimize. Pick a site to see its visitors, run A/B tests and personalization campaigns.</div></div>
    <div class="row"><button class="btn" id="add-demo">✦ Create demo site</button><button class="btn primary" id="add-site">＋ Add site</button></div></div>
    <div class="grid g4" style="margin-bottom:16px">
      ${kpi("Sites", fmtNum(sites.length))}
      ${kpi("Receiving data", fmtNum(connected), "last 24 hours")}
      ${kpi("Running A/B tests", fmtNum(sum("running")))}
      ${kpi("Running campaigns", fmtNum(runningCamps))}
    </div>
    <div class="card">${sites.length ? `<div class="table-wrap"><table><thead><tr>
      <th>Site</th><th>Connection</th><th class="right">Visitors (7d)</th><th class="right">Pageviews (7d)</th>
      <th>A/B tests</th><th>Campaigns</th><th>Last event</th><th></th></tr></thead><tbody>
      ${sites.map(s => `<tr class="click" data-open="${esc(s.id)}"><td><b>${esc(s.name)}</b><div class="muted">${esc(s.domain || "no domain set")}</div></td>
        <td>${statusPill(s.status)}</td><td class="right">${fmtNum(s.visitors_7d)}</td><td class="right">${fmtNum(s.pageviews_7d)}</td>
        <td>${counts(s.experiments)}</td><td>${counts(s.campaigns)}</td><td class="muted nowrap">${ago(s.last_event)}</td>
        <td class="right"><span class="btn sm">Open →</span></td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty"><b>No sites yet</b>Add your website to get a tracking snippet, then paste it into the page &lt;head&gt;.<br><br>
         <button class="btn primary" id="add-demo-2">✦ Create the demo site (one click)</button> <button class="btn" id="add-site-2">＋ Add your own site</button>
         <div class="muted" style="margin-top:10px;font-size:12.5px">The demo is a fake coffee store with a ready-made “3rd visit” signup form, a banner and a funnel — the quickest way to see everything work.</div></div>`}</div>
    ${sites.length ? `<div class="callout" style="margin-top:16px"><b>Where do I do what?</b>
      Open a site, then use its menu on the left: <b>Overview</b> (traffic) · <b>A/B tests</b> (compare versions, with a point-and-click editor) ·
      <b>Personalization</b> (banners/popups by visitor type) · <b>Behavior</b> (pages, clicks, scroll depth, forms) ·
      <b>Visitors</b> (what each person did) · <b>Install &amp; settings</b> (snippet, tracking, consent).</div>` : ""}`;
  $$("[data-open]", view).forEach(r => r.onclick = () => { location.hash = `#/site/${r.dataset.open}/overview`; });
  ["#add-site", "#add-site-2"].forEach(id => { const b = $(id, view); if (b) b.onclick = openAddSite; });
  ["#add-demo", "#add-demo-2"].forEach(id => { const b = $(id, view); if (b) b.onclick = () => createDemoSite(b); });
}
function counts(o) {
  const run = o.running || 0, total = Object.values(o).reduce((a, b) => a + b, 0);
  if (!total) return `<span class="muted">none</span>`;
  return `<span class="pill ${run ? "running" : ""}">${run} running</span> <span class="muted">/ ${total}</span>`;
}

// ---------------------------------------------------------------- Overview
// "Getting started" checklist: each step ticks itself off from real data; can be dismissed per site.
function onboardingCard(s, { exps, camps, goals, segs }) {
  try { if (localStorage.getItem("ot_onb_" + s.id) === "1") return ""; } catch { /* ignore */ }
  const steps = [
    ["Connect your site", s.status !== "waiting", "Paste the snippet in your site's <head>.", `#/site/${s.id}/settings`],
    ["Define a goal", goals.some(g => !g.archived), "What counts as a conversion: a signup, a purchase, a click.", `#/site/${s.id}/goals`],
    ["Save an audience", segs.length > 0, "Who you want to reach, written once and reused.", `#/site/${s.id}/audiences`],
    ["Launch a personalization", camps.some(c => c.status === "running"), "A banner, popup or page change for the right visitors.", `#/site/${s.id}/campaigns`],
    ["Run an A/B test", exps.some(e => e.status === "running" || e.status === "completed"), "Compare versions and see which converts better.", `#/site/${s.id}/experiments`],
  ];
  const done = steps.filter(x => x[1]).length;
  if (done === steps.length) return "";
  return `<div class="card onboard" data-testid="onboarding"><div class="row" style="justify-content:space-between"><div><h2>Get started with ${esc(s.name)}</h2>
    <div class="muted">${done} of ${steps.length} done — a few minutes to your first personalised experience.</div></div>
    <button class="btn sm" id="onb-hide">Hide</button></div><div class="meter"><i style="width:${done / steps.length * 100}%"></i></div>
    <div class="todo">${steps.map(([t, ok, d, href]) => `<a href="${esc(href)}" class="${ok ? "done" : ""}"><span class="chk">${ok ? "✓" : ""}</span><span><b>${esc(t)}</b><small>${d}</small></span></a>`).join("")}</div></div>`;
}
async function pageOverview(view) {
  const s = curSite();
  const [ov, exps, camps, goals, segs] = await Promise.all([
    api(`/api/sites/${s.id}/overview?days=${S.days}`), api(`/api/sites/${s.id}/experiments`), api(`/api/sites/${s.id}/campaigns`),
    api(`/api/sites/${s.id}/goals`, { cache: 20000 }).catch(() => []), api(`/api/sites/${s.id}/segments`, { cache: 20000 }).catch(() => [])]);
  const runExp = exps.filter(e => e.status === "running"), runCamp = camps.filter(c => c.status === "running");
  const retShare = ov.visitors ? ov.returning_visitors / ov.visitors : null;
  const ch = stackedChart(ov.daily, S.days);
  const first = s.status === "waiting";
  view.innerHTML = siteHead("Overview", "How many people visit, where they come from, and how engaged they are.",
    `${statusPill(s.status)}${rangeSeg()}`) + `
    ${onboardingCard(s, { exps, camps, goals, segs })}
    <div class="grid g6" style="margin-bottom:16px">
      ${kpi("Visitors", fmtNum(ov.visitors))}${kpi("Sessions", fmtNum(ov.sessions))}${kpi("Pageviews", fmtNum(ov.pageviews))}
      ${kpi("Avg time on page", fmtDur(ov.avg_seconds), "active time")}${kpi("Avg scroll depth", ov.avg_scroll == null ? "–" : Math.round(ov.avg_scroll) + "%")}
      ${kpi("Returning", pct(retShare, 0), fmtNum(ov.returning_visitors) + " visitors")}
    </div>
    <div class="card card-pad" id="chart-card"><h2>Daily visitors</h2>${ch.html}${chartTable(ch.list)}</div>
    <div class="grid g3" style="margin-top:16px">
      <div class="card card-pad"><h3>Top sources</h3>${barList(ov.sources)}</div>
      <div class="card card-pad"><h3>Devices</h3>${barList(ov.devices)}</div>
      <div class="card card-pad"><h3>Countries</h3>${barList(ov.countries, "Needs a geo header (Cloudflare/Vercel) — not available locally")}</div>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card card-pad"><h3>States / regions</h3>${barList(ov.regions, "Shows up for new visits once the site is live on a host that sends location (Vercel, Cloudflare)")}</div>
      <div class="card card-pad"><h3>Cities</h3>${barList(ov.cities, "Shows up for new visits once the site is live on a host that sends location (Vercel, Cloudflare)")}</div>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card card-pad"><h3>Running now</h3>
        ${runExp.length || runCamp.length ? `<table><tbody>
          ${runExp.map(e => `<tr><td>⚗ ${esc(e.name)}</td><td class="muted">A/B test</td><td class="right"><a href="#/site/${esc(s.id)}/experiments">Results</a></td></tr>`).join("")}
          ${runCamp.map(c => `<tr><td>✦ ${esc(c.name)}</td><td class="muted">Campaign</td><td class="right">${fmtNum(c.impressions)} shown</td></tr>`).join("")}
        </tbody></table>` : `<div class="muted">Nothing running. Start an <a href="#/site/${esc(s.id)}/experiments">A/B test</a> or <a href="#/site/${esc(s.id)}/campaigns">campaign</a>.</div>`}</div>
      <div class="card card-pad"><h3>Custom events</h3>${barList(ov.custom_events.map(e => ({ name: e.name, count: e.count })), "None yet — call OT.track('name') on your site")}</div>
    </div>`;
  bindRange(() => route());
  bindChart(view, ch.list);
  const hide = $("#onb-hide", view);
  if (hide) hide.onclick = () => { try { localStorage.setItem("ot_onb_" + s.id, "1"); } catch { /* ignore */ } $(".onboard", view).remove(); };
}

// ---------------------------------------------------------------- A/B tests
function goalText(g) {
  if (!g) return "–";
  return g.type === "click" ? `Click on <code>${esc(g.selector)}</code>` : g.type === "pageview" ? `Visit a URL containing <code>${esc(g.url_contains)}</code>`
    : g.type === "form" ? `Submit form <code>${esc(g.form_name)}</code>` : `Event <code>${esc(g.name)}</code>`;
}
function audienceText(cfg, segs) {
  const seg = cfg.segment_id && segs.find(x => x.id === cfg.segment_id);
  if (seg) return `Audience: <b>${esc(seg.name)}</b>`;
  return cfg.rules && cfg.rules.length ? `Audience: ${esc(rulesText(cfg.rules, cfg.match))}` : "All visitors";
}
function resultsTable(r, exp) {
  const ctrl = r.variants.find(v => v.is_control), multi = r.variants.length > 2;
  const star = v => (r.winner === v.variant ? ' <span class="pill running" title="Winner">★ winner</span>' : "");
  const ci = v => `${pct(v.rate, 2)} <span class="muted" style="font-size:11px">(${pct(v.ci_low, 1)}–${pct(v.ci_high, 1)})</span>`;
  const smallest = Math.min(...r.variants.map(v => v.visitors));
  const tone = r.srm.flag ? "warn" : r.winner && r.winner !== (ctrl && ctrl.variant) ? "good" : "";
  const done = r.status === "completed";
  return `${r.srm.flag ? `<div class="callout warn" style="margin-bottom:10px"><b>Traffic split looks wrong (sample ratio mismatch).</b> The number of visitors per version doesn't match the split you set (p=${r.srm.p_value.toFixed(5)}). Don't trust these results until you find out why — for example a redirect, a page that blocks the script, or targeting that treats versions differently.</div>` : ""}
    <div class="table-wrap"><table><thead><tr><th>Version</th><th class="right">Visitors</th><th class="right">Conversions</th><th class="right">Rate (95% range)</th><th class="right">Uplift</th><th class="right" title="Bayesian probability that this version really converts better than the original">Beats original</th><th class="right" title="${multi ? "Corrected for comparing several versions (Bonferroni)" : "Two-sided z-test"}">p-value${multi ? " (adj.)" : ""}</th></tr></thead><tbody>
    ${r.variants.map(v => `<tr><td>${esc(v.variant)} ${v.is_control ? '<span class="muted">(control)</span>' : ""}${star(v)}</td><td class="right">${fmtNum(v.visitors)}</td>
      <td class="right">${fmtNum(v.conversions)}</td><td class="right">${ci(v)}</td>
      <td class="right ${v.uplift > 0 ? "good" : v.uplift < 0 ? "bad" : ""}">${v.uplift == null ? "–" : (v.uplift > 0 ? "+" : "") + (v.uplift * 100).toFixed(1) + "%"}</td>
      <td class="right">${v.prob_beat_control == null ? "–" : Math.round(v.prob_beat_control * 100) + "%"}</td>
      <td class="right">${v.p_value == null ? "–" : (multi ? v.p_adjusted : v.p_value).toFixed(3)}${v.significant ? ' <b class="good">significant</b>' : ""}</td></tr>`).join("")}</tbody></table></div>
    <div class="callout ${tone}" style="margin-top:10px">${esc(r.recommendation)}</div>
    ${r.needed_per_variant ? `<div class="muted" style="margin-top:8px;font-size:12.5px">Sample: smallest version has <b>${fmtNum(smallest)}</b> visitors; about <b>${fmtNum(r.needed_per_variant)}</b> per version are needed to detect a 10% lift at today's conversion rate
      <div class="bar" style="margin-top:4px;max-width:340px"><i style="width:${Math.min(100, smallest / r.needed_per_variant * 100).toFixed(0)}%"></i></div></div>` : ""}
    ${r.secondary && r.secondary.length ? r.secondary.map(sg => `<details style="margin-top:10px"><summary class="muted" style="cursor:pointer">Also measured: ${esc(sg.name)}</summary><div class="table-wrap"><table><thead><tr><th>Version</th><th class="right">Visitors</th><th class="right">Converted</th><th class="right">Rate</th></tr></thead><tbody>
      ${sg.variants.map(v => `<tr><td>${esc(v.variant)}</td><td class="right">${fmtNum(v.visitors)}</td><td class="right">${fmtNum(v.converters)}</td><td class="right">${pct(v.rate, 2)}</td></tr>`).join("")}</tbody></table></div></details>`).join("") : ""}
    ${done ? `<div class="muted" style="margin-top:8px;font-size:12.5px">Completed${r.completed_reason === "auto" ? " automatically" : r.completed_reason === "manual" ? " by you" : ""}${r.winner ? " — winner: <b>" + esc(r.winner) + "</b>" : ""}.</div>`
      : `<div class="row" style="margin-top:10px"><span class="muted" style="font-size:12.5px">End the test and pick a winner:</span>${r.variants.map(v => `<button class="btn sm" data-win="${esc(exp.id)}:${esc(v.variant)}">${v.is_control ? "Keep original" : "Use " + esc(v.variant)}</button>`).join("")}</div>`}
    <div class="muted" style="margin-top:8px;font-size:12px">${esc(r.note)}</div>`;
}
const statusButtons = (kind, id, status) => ["running", "paused", "completed"].filter(x => x !== status).map(x =>
  `<button class="btn sm" data-st="${kind}:${esc(id)}:${x}">${x === "running" ? (status === "paused" ? "Resume" : "Start") : x === "paused" ? "Pause" : "Complete"}</button>`).join("");
function bindStatus(view) {
  $$("[data-st]", view).forEach(b => b.onclick = async () => {
    const [kind, id, st] = b.dataset.st.split(":");
    try { await api(`/api/${kind}/${id}/status`, { method: "PATCH", body: { status: st } }); toast("Updated"); route(); }
    catch (e) { toast(e.message, true); }
  });
}
async function pageExperiments(view) {
  const s = curSite();
  const [exps, segs] = await Promise.all([api(`/api/sites/${s.id}/experiments?with_results=1`), api(`/api/sites/${s.id}/segments`, { cache: 20000 }).catch(() => [])]);
  const results = exps.map(e => e.results || null);
  view.innerHTML = siteHead("A/B tests", "Show different versions of a page to different visitors and measure which converts better. Build changes with the point-and-click editor; test two versions or several.",
    `<button class="btn primary" id="new-exp">＋ New A/B test</button>`) +
    (exps.length ? exps.map((e, i) => {
      const r = results[i], c = e.config, status = r ? r.status : e.status;
      return `<div class="card card-pad" style="margin-bottom:16px">
      <div class="row" style="justify-content:space-between"><div><b style="font-size:15px">${esc(e.name)}</b> <span class="pill ${esc(status)}">${esc(status)}</span>
        <div class="muted" style="margin-top:2px">${c.url_contains ? "Runs on URLs containing <code>" + esc(c.url_contains) + "</code>" : "Runs on all pages"} · ${c.traffic}% of traffic · ${c.variants.length} versions · ${audienceText(c, segs)}</div>
        <div class="muted">Goal: ${goalText(c.goal)}${c.auto_winner ? " · auto-finish on" : ""}${c.ship_winner ? " · keeps the winner on" : ""}</div></div>
        <div class="row">${status === "completed" ? "" : statusButtons("experiments", e.id, status)}</div></div>
      <div style="margin-top:12px">${r && r.variants.some(v => v.visitors) ? resultsTable(r, e) : `<div class="muted">No visitors have seen this test yet${status === "draft" ? " — press Start to begin" : ""}.</div>`}</div>
      <details style="margin-top:10px"><summary class="muted" style="cursor:pointer">What each version changes</summary>
        ${c.variants.slice(1).map(v => `<div style="margin-top:8px"><b>${esc(v.key)}</b> <span class="muted">· ${esc(v.weight)} weight${v.redirect_url ? " · sends visitors to " + esc(v.redirect_url) : ""}</span>
        <div class="table-wrap"><table><tbody>${(v.changes || []).map(ch => `<tr><td><code>${esc(ch.action + (ch.attr ? ":" + ch.attr : ""))}</code></td><td><code>${esc(ch.selector)}</code></td><td>${esc((ch.value || "").slice(0, 80))}</td></tr>`).join("") || '<tr><td class="muted">No element changes</td></tr>'}</tbody></table></div></div>`).join("")}</details></div>`;
    }).join("")
    : `<div class="card empty"><b>No A/B tests yet</b>Create one, change something on your page with the visual editor, and see which version wins.<br><br><button class="btn primary" id="new-exp-2">＋ Create your first test</button></div>`);
  bindStatus(view);
  $$("[data-win]", view).forEach(b => b.onclick = async () => {
    const [id, variant] = b.dataset.win.split(":");
    if (!confirm(`End this test and declare “${variant}” the winner?`)) return;
    try { await api(`/api/experiments/${id}/winner`, { method: "POST", body: { variant } }); toast("Test completed"); route(); }
    catch (e) { toast(e.message, true); }
  });
  ["#new-exp", "#new-exp-2"].forEach(id => { const b = $(id, view); if (b) b.onclick = () => openNewExperiment(s); });
}

// ---------------------------------------------------------------- Personalization
const TRIGGER_TEXT = { load: "on each page view", session_start: "at the start of a visit", delay: "after {v}s on the page", scroll: "after scrolling {v}%", exit: "when about to leave",
  click: "on clicking {v}", form: "on submitting form {v}", event: "on event {v}" };
function triggerText(cfg) {
  const t = (TRIGGER_TEXT[cfg.trigger_type || "load"] || "").replace("{v}", cfg.trigger_value || "");
  const pm = cfg.url_contains ? ({ starts: "pages starting with", equals: "only", contains: "pages containing", all: "" }[cfg.page_match || "contains"] + " " + cfg.url_contains).trim() : "all pages";
  return `${t} · ${pm}`;
}
function controlLine(c) {
  const r = c.control_results;
  if (!r) return c.config.holdout_pct ? `<div class="muted" style="font-size:12px">${c.config.holdout_pct}% control group — collecting data</div>` : "";
  const shown = r.variants.find(v => v.variant === "shown"), ctl = r.variants.find(v => v.variant === "control");
  const up = r.uplift == null ? "not enough data yet" : `${r.uplift >= 0 ? "+" : ""}${(r.uplift * 100).toFixed(1)}% vs control${r.significant ? " ✓ significant" : ""}`;
  return `<div style="font-size:12px;margin-top:3px" title="Control group: ${fmtNum(ctl.visitors)} visitors, ${fmtNum(ctl.conversions)} converted. Shown: ${fmtNum(shown.visitors)} visitors, ${fmtNum(shown.conversions)} converted.">Control group ${r.holdout_pct}% · <b>${esc(up)}</b></div>`;
}
function actionSummary(actions) {
  const n = {};
  actions.forEach(a => { n[a.type] = (n[a.type] || 0) + 1; });
  const names = { change: k => `${k} page edit${k > 1 ? "s" : ""}`, banner: () => "banner", popup: () => "popup", custom: () => "custom code / form", redirect: () => "redirect" };
  return Object.entries(n).map(([t, k]) => (names[t] ? names[t](k) : t)).join(" + ");
}
async function pageCampaigns(view) {
  const s = curSite();
  const [camps, segs] = await Promise.all([api(`/api/sites/${s.id}/campaigns`), api(`/api/sites/${s.id}/segments`, { cache: 20000 }).catch(() => [])]);
  view.innerHTML = siteHead("Personalization", "Show banners and popups only to the visitors you choose — for example returning visitors, a third visit, a traffic source or mobile users.",
    `<a class="btn" href="/api/sites/${esc(s.id)}/campaigns.csv" download>⬇ Export CSV</a><button class="btn" id="new-visual">✎ Edit page visually</button><button class="btn primary" id="new-camp">＋ New campaign</button>`) + `
    <div class="card">${camps.length ? `<div class="table-wrap"><table><thead><tr><th>Campaign</th><th>Status</th><th>Who sees it</th><th>Shown</th><th class="right">Seen by</th><th class="right">Clicked</th><th class="right">Converted</th><th></th></tr></thead><tbody>
      ${camps.map(c => `<tr><td><b>${esc(c.name)}</b><div class="muted">${esc(actionSummary(c.config.actions))}</div>${controlLine(c)}</td><td><span class="pill ${esc(c.status)}">${esc(c.status)}</span>${c.schedule_state ? `<div class="muted" style="font-size:12px">${c.schedule_state === "scheduled" ? "starts " + esc(new Date(c.config.start_at).toLocaleString()) : "ended " + esc(new Date(c.config.end_at).toLocaleString())}</div>` : (c.status === "running" && c.config.end_at ? `<div class="muted" style="font-size:12px">until ${esc(new Date(c.config.end_at).toLocaleString())}</div>` : "")}</td>
        <td class="muted">${(() => { const sg = c.config.segment_id && segs.find(x => x.id === c.config.segment_id); return sg ? `<b>${esc(sg.name)}</b><div>${esc(rulesText(sg.rules, sg.match))}</div>` : esc(rulesText(c.config.rules, c.config.match)); })()}</td>
        <td class="muted">${esc({ once: "Once per visitor", session: "Once per visit", always: "Every page load" }[c.config.frequency])}<div>${esc(triggerText(c.config))}</div></td>
        <td class="right">${fmtNum(c.impressions)}</td><td class="right">${fmtNum(c.clicks)}</td><td class="right">${fmtNum(c.conversions)}</td>
        <td class="right nowrap"><button class="btn sm" data-edit-camp="${esc(c.id)}">Edit</button> <button class="btn sm" data-dup-camp="${esc(c.id)}" title="Make a copy">Duplicate</button> <button class="btn sm" data-qa-camp="${esc(c.id)}" title="Copy a link that shows this campaign on your site, whatever the rules">QA link</button> ${statusButtons("campaigns", c.id, c.status)}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty"><b>No campaigns yet</b>Try: “Returning visitor → welcome-back banner”, or “3rd visit → show a signup form” (HubSpot, Typeform, Google Forms or your own HTML/CSS/JS).<br><br><button class="btn primary" id="new-visual-2">✎ Edit your page visually</button> <button class="btn" id="new-camp-2">＋ Banner / popup / form</button></div>`}</div>`;
  bindStatus(view);
  $$("[data-edit-camp]", view).forEach(b => b.onclick = () => openCampaignModal(s, camps.find(c => c.id === b.dataset.editCamp)));
  $$("[data-dup-camp]", view).forEach(b => b.onclick = async () => {
    const c = camps.find(x => x.id === b.dataset.dupCamp); b.disabled = true;
    try { const copy = { ...c.config, name: (c.name + " (copy)").slice(0, 120) }; delete copy.id; await api(`/api/sites/${s.id}/campaigns`, { method: "POST", body: copy }); toast("Copied — the copy is a draft, start it when ready"); route(); }
    catch (e) { toast(e.message, true); b.disabled = false; }
  });
  $$("[data-qa-camp]", view).forEach(b => b.onclick = async () => {
    const c = camps.find(x => x.id === b.dataset.qaCamp);
    const base = prompt("Which page of your site should the link open? (full address)", localStorage.getItem("ot_last_url_" + s.id) || ("https://" + (s.domain || "example.com") + "/"));
    if (!base) return;
    try { const u = new URL(base); u.searchParams.set("ot_force", c.id); await navigator.clipboard.writeText(u.href); toast("Link copied. Open it to see this campaign on the site (nothing is tracked). The snippet must be installed and the campaign running."); }
    catch { toast("Enter a full address like https://yoursite.com/", true); }
  });
  ["#new-camp", "#new-camp-2"].forEach(id => { const b = $(id, view); if (b) b.onclick = () => openNewCampaign(s); });
  ["#new-visual", "#new-visual-2"].forEach(id => { const b = $(id, view); if (b) b.onclick = () => openNewCampaign(s, { visual: true }); });
}

// ---------------------------------------------------------------- Behavior
async function pageBehavior(view) {
  const s = curSite();
  const tabs = [["pages", "Pages"], ["clicks", "Clicks"], ["scroll", "Scroll depth"], ["forms", "Forms"]];
  view.innerHTML = siteHead("Behavior", "What people actually do on your pages: where they spend time, what they click, how far they scroll and which forms they abandon.", rangeSeg()) +
    `<div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-bt="${k}" class="${S.behavior === k ? "on" : ""}">${l}</button>`).join("")}</div><div id="bh"></div>`;
  bindRange(() => pageBehavior(view));
  $$("[data-bt]", view).forEach(b => b.onclick = () => { S.behavior = b.dataset.bt; pageBehavior(view); });
  const box = $("#bh", view);
  const d = `?days=${S.days}`;
  if (S.behavior === "pages") {
    const rows = await api(`/api/sites/${s.id}/pages${d}`);
    box.innerHTML = `<div class="card">${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Page</th><th class="right">Views</th><th class="right">Visitors</th><th class="right">Avg time</th><th class="right">Avg scroll</th><th class="right">Clicks</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td class="mono">${esc(r.path)}</td><td class="right">${fmtNum(r.views)}</td><td class="right">${fmtNum(r.visitors)}</td><td class="right">${fmtDur(r.avg_seconds)}</td>
        <td class="right">${r.avg_scroll == null ? "–" : Math.round(r.avg_scroll) + "%"}</td><td class="right">${fmtNum(r.clicks)}</td></tr>`).join("")}</tbody></table></div>` : noData()}</div>`;
  } else if (S.behavior === "clicks") {
    const pages = await api(`/api/sites/${s.id}/pages${d}`);
    const path = S.clickPath || "";
    const data = await api(`/api/sites/${s.id}/clicks${d}${path ? "&path=" + encodeURIComponent(path) : ""}`);
    const max = Math.max(...data.clicks.map(c => c.n), 1);
    const kind = c => c.download ? "download" : c.outbound ? "outbound link" : c.tag === "a" ? "link" : c.tag === "button" || c.tag === "input" ? "button" : c.tag;
    box.innerHTML = `<div class="row" style="margin-bottom:12px"><label class="lbl2" for="cp">Page</label>
      <select id="cp" style="max-width:320px"><option value="">All pages</option>${pages.map(p => `<option value="${esc(p.path)}" ${p.path === path ? "selected" : ""}>${esc(p.path)}</option>`).join("")}</select></div>
      <div class="card" style="margin-bottom:16px">${data.clicks.length ? `<div class="table-wrap"><table><thead><tr><th>Element clicked</th><th>Type</th><th>Goes to</th><th style="width:22%">Clicks</th><th class="right">People</th></tr></thead><tbody>
      ${data.clicks.map(c => `<tr><td><b>${esc(c.text || "(no text)")}</b><div class="muted mono">${esc(c.sel)}</div></td><td class="muted">${esc(kind(c))}</td><td class="mono muted">${esc(c.href || "")}</td>
        <td><div class="bar"><i style="width:${c.n / max * 100}%"></i></div> <span class="muted">${fmtNum(c.n)}</span></td><td class="right">${fmtNum(c.v)}</td></tr>`).join("")}</tbody></table></div>` : noData()}</div>
      <div class="card card-pad"><h3>Rage clicks <span class="muted" style="font-weight:400">— visitors clicking the same spot repeatedly, often a sign something is broken</span></h3>
      ${data.rage.length ? `<table><tbody>${data.rage.map(c => `<tr><td><b>${esc(c.text || "(no text)")}</b> <span class="muted mono">${esc(c.sel)}</span></td><td class="right bad">${fmtNum(c.n)} bursts</td><td class="right">${fmtNum(c.v)} people</td></tr>`).join("")}</tbody></table>` : `<div class="muted">None detected.</div>`}</div>`;
    $("#cp", view).onchange = e => { S.clickPath = e.target.value; pageBehavior(view); };
  } else if (S.behavior === "scroll") {
    const rows = await api(`/api/sites/${s.id}/scroll${d}`);
    box.innerHTML = `<div class="card">${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Page</th><th class="right">Views</th><th>Share of visitors who scrolled to…</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td class="mono">${esc(r.path)}</td><td class="right">${fmtNum(r.pageviews)}</td><td><div class="funnel">
        ${[25, 50, 75, 100].map(k => `<div class="f"><i style="width:${(r.reach[k] * 100).toFixed(0)}%"></i><span><b>${k}%</b><span>${pct(r.reach[k], 0)}</span></span></div>`).join("")}</div></td></tr>`).join("")}</tbody></table></div>` : noData()}</div>`;
  } else {
    const rows = await api(`/api/sites/${s.id}/forms${d}`);
    box.innerHTML = `<div class="card">${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Form</th><th>Page</th><th class="right">Started</th><th class="right">Submitted</th><th class="right">Abandoned</th><th class="right">Completion</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td><b>${esc(r.form)}</b></td><td class="mono">${esc(r.path)}</td><td class="right">${fmtNum(r.starts)}</td><td class="right">${fmtNum(r.submits)}</td>
        <td class="right ${r.abandon ? "bad" : ""}">${fmtNum(r.abandon)}</td><td class="right">${r.starts ? pct(Math.min(1, r.submits / r.starts), 0) : "–"}</td></tr>`).join("")}</tbody></table></div>` : noData()}
      <div class="muted" style="padding:0 16px 14px;font-size:12px">Only form names and whether people started/submitted are recorded — never what they typed.</div></div>`;
  }
}
const noData = () => `<div class="empty"><b>No data in this period</b>Events appear here a few seconds after visitors use your site. Check <a href="#/site/${esc(S.siteId)}/settings">Install &amp; settings</a> if nothing shows up.</div>`;

// ---------------------------------------------------------------- Visitors
function describeEvent(e) {
  const p = e.props || {}, path = pathOf(e.url);
  switch (e.type) {
    case "pageview": return ["◉", `Viewed <b>${esc(path)}</b>${p.title ? ` <span class="muted">— ${esc(p.title)}</span>` : ""}${p.ref ? ` <span class="muted">(from ${esc(p.ref)})</span>` : ""}`];
    case "autoclick": return ["⌖", `Clicked <b>${esc(p.text || p.sel || "element")}</b>${p.href ? ` <span class="muted">→ ${esc(p.href)}</span>` : ""} <span class="muted">on ${esc(path)}</span>`];
    case "rage": return ["⚠", `Rage-clicked <b>${esc(p.text || p.sel || "element")}</b> <span class="muted">on ${esc(path)}</span>`];
    case "scroll": return ["↧", `Scrolled to <b>${esc(p.depth)}%</b> <span class="muted">on ${esc(path)}</span>`];
    case "engage": return ["⏱", `Spent <b>${fmtDur(p.seconds)}</b> on <b>${esc(path)}</b> <span class="muted">(scrolled ${esc(p.scroll)}%)</span>`];
    case "form": return ["▤", `${p.action === "submit" ? "Submitted" : "Started"} form <b>${esc(p.form)}</b>`];
    case "event": return ["⚡", `Custom event <b>${esc(e.name)}</b>`];
    case "exposure": return ["⚗", `Entered A/B test as <b>${esc(e.variant)}</b>`];
    case "goal": return ["✔", `Converted on a test goal (<b>${esc(e.variant)}</b>)`];
    case "impression": return ["✦", `Was shown a personalization campaign`];
    case "click": return ["✦", `Clicked a campaign button`];
    default: return ["•", esc(e.type)];
  }
}
async function pageVisitors(view) {
  const s = curSite();
  const rows = await api(`/api/sites/${s.id}/visitor-list?days=${S.days}`);
  view.innerHTML = siteHead("Visitors", "Individual people (identified by a cookie, not by name) and everything each one did. Click a row to see their journey.", rangeSeg()) +
    `<div class="card">${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Visitor</th><th>Type</th><th>Device</th><th class="right">Visits</th><th class="right">Pageviews</th><th class="right">Clicks</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>
      ${rows.map(v => `<tr class="click" data-v="${esc(v.visitor_id)}"><td class="mono">${esc(v.visitor_id.slice(0, 8))}</td><td>${v.is_ret ? '<span class="pill receiving">returning</span>' : '<span class="pill">new</span>'}</td>
        <td class="muted">${esc(v.device || "–")}</td><td class="right">${fmtNum(v.visits)}</td><td class="right">${fmtNum(v.pageviews)}</td><td class="right">${fmtNum(v.clicks)}</td>
        <td class="muted nowrap">${clock(v.first_seen)}</td><td class="muted nowrap">${ago(v.last_seen)}</td></tr>`).join("")}</tbody></table></div>` : noData()}</div>`;
  bindRange(() => pageVisitors(view));
  $$("[data-v]", view).forEach(r => r.onclick = () => openVisitor(s, r.dataset.v));
}

// ---------------------------------------------------------------- Live feed
async function pageLive(view) {
  const s = curSite();
  view.innerHTML = siteHead("Live feed", "Events as they arrive. Refreshes every 5 seconds. Handy for checking that your snippet works.", `<span class="pill live"><span class="dot live"></span> auto-refresh</span>`) +
    `<div class="grid g3" style="margin-bottom:16px" id="live-kpi"></div><div class="card card-pad"><ul class="timeline" id="live-list"></ul></div>`;
  const tick = async () => {
    try {
      const d = await api(`/api/sites/${s.id}/live`);
      $("#live-kpi").innerHTML = kpi("Active in the last 5 min", fmtNum(d.active_now)) + kpi("Latest event", d.events[0] ? ago(d.events[0].ts) : "–") + kpi("Events shown", fmtNum(d.events.length), "most recent 80");
      $("#live-list").innerHTML = d.events.length ? d.events.map(e => {
        const [ic, txt] = describeEvent(e);
        return `<li><span class="ic">${ic}</span><span>${txt} <span class="muted mono">· ${esc(e.visitor_id.slice(0, 6))}</span></span><span class="tm">${ago(e.ts)}</span></li>`;
      }).join("") : `<li class="muted">Nothing yet. Open your site in another tab and it will show up here.</li>`;
    } catch { /* keep polling */ }
  };
  await tick();
  S.timer = setInterval(tick, 5000);
}

// ---------------------------------------------------------------- Install & settings
function snippetFor(id) {
  const o = location.origin;
  return `<!-- Optimize: paste as high in <head> as possible -->
<style id="ot-hide">body{opacity:0!important}</style>
<script>setTimeout(function(){var h=document.getElementById("ot-hide");h&&h.remove()},1500)</script>
<script src="${o}/sdk.js" data-site="${id}" async></script>`;
}
async function pageSettings(view) {
  const s = curSite();
  const d = await api(`/api/sites/${s.id}`);
  const st = d.settings;
  const sw = (k, t, desc) => `<label class="switch"><input type="checkbox" data-set="${k}" ${st[k] ? "checked" : ""}><span><div class="t">${t}</div><div class="d">${desc}</div></span></label>`;
  const conn = s.status === "waiting"
    ? `<div class="callout warn"><b>Not connected yet.</b> No events have been received. Paste the snippet below into your site’s &lt;head&gt;, open the site, then press <b>Check again</b>.</div>`
    : `<div class="callout good"><b>Connected.</b> Last event ${ago(s.last_event)} · ${fmtNum(s.pageviews_7d)} pageviews in the last 7 days.</div>`;
  view.innerHTML = siteHead("Install & settings", "Connect your website, choose what gets tracked, and set the privacy mode.") + `
    <div class="card card-pad" style="margin-bottom:16px"><h2>1 · Connection</h2><div class="row" style="margin-bottom:12px">${statusPill(s.status)}<button class="btn sm" id="recheck">Check again</button></div>${conn}</div>
    <div class="card card-pad" style="margin-bottom:16px"><h2>2 · Install the snippet</h2>
      <p class="muted" style="margin-top:0">Paste this as high in the &lt;head&gt; of every page. It uses this dashboard’s address (<code>${esc(location.origin)}</code>); once you deploy the tool, copy the snippet again from the live dashboard.
      With Google Tag Manager: add a <b>Custom HTML</b> tag containing it, fired on All Pages.</p>
      <div class="snippet"><button class="btn sm" id="copy">Copy</button><pre id="snip"></pre></div>
      <p style="margin-bottom:0"><a href="/site-demo?site=${esc(s.id)}&controls=1" target="_blank" rel="noopener">Open the Aurora Coffee demo store with test controls →</a> <span class="muted">(a fake store to try campaigns, tests and heatmaps; visitors never see the controls)</span></p></div>
    <div class="card card-pad" style="margin-bottom:16px"><h2>3 · Site details</h2><div class="grid g2">
      <div class="field"><label for="s-name">Name</label><input id="s-name" type="text" value="${esc(d.name)}"></div>
      <div class="field"><label for="s-domain">Domain</label><input id="s-domain" type="text" value="${esc(d.domain)}" placeholder="example.com"><span class="help">Used to label this site; paste a full URL if you like.</span></div></div>
      <button class="btn primary" id="save-site">Save</button></div>
    <div class="card card-pad" style="margin-bottom:16px"><h2>4 · What to track automatically</h2>
      ${sw("auto_clicks", "Clicks &amp; rage clicks", "Which buttons and links people click, including downloads and outbound links. Text typed in fields is never read.")}
      ${sw("auto_scroll", "Scroll depth &amp; time on page", "How far people scroll (25/50/75/100%) and how long they are actively engaged.")}
      ${sw("auto_forms", "Form starts &amp; submits", "Which forms people start and finish. Only the form name is recorded, never the values.")}
      ${sw("auto_spa", "Single-page-app navigation", "Count route changes (React, Next.js, Vue…) as page views.")}</div>
    <div class="card card-pad" style="margin-bottom:16px"><h2>5 · Tell Optimize about your visitors <span class="muted" style="font-weight:400">(optional)</span></h2>
      <p class="muted" style="margin-top:0">Pass facts you already know — a plan, a customer flag, the cart value — and target them in <b>Audiences</b> as “Custom attribute”. They stay in the visitor's browser; nothing personal is sent to Optimize.</p>
      <div class="snippet"><pre>// after the snippet (works even before sdk.js has finished loading)
window.OT = window.OT || { q: [] };
OT.q.push(["identify", { plan: "pro", customer: true, cart_value: 120 }]);
// later, e.g. when someone buys (also counts for the "customer" and "has done an event" rules):
OT.track("purchase", { value: 49 });</pre></div></div>
    <div class="card card-pad"><h2>6 · Privacy &amp; cookies</h2>
      ${sw("one_overlay", "One banner / popup at a time", "When several campaigns match, only the one with the highest priority is shown on a page, so visitors never get a pile of overlays.")}
      ${sw("ga_events", "Send events to Google Analytics", "Pushes campaign shown / test exposure / goal events to <code>dataLayer</code> (and gtag) so you can report on them in GA4 or Tag Manager.")}
      ${sw("consent_required", "Require consent before tracking", "When on, nothing is stored or sent until your cookie banner calls <code>OT.consent(true)</code>. Recommended for EU/UK visitors.")}
      ${sw("restrict_origin", "Only accept events from my domain", "Ignores events sent from other websites. Best-effort protection against someone copying your snippet; needs the Domain above to be set (subdomains such as www. are allowed).")}
      <p class="muted" style="margin-bottom:6px">Optimize sets one first-party cookie (<code>_ot</code>, 1 year) and mirrors it in localStorage to recognise returning visitors. No IP address is stored.</p>
      <div class="snippet"><pre>// from your cookie banner
OT.consent(true);   // accepted: start tracking
OT.consent(false);  // declined/revoked: stop and delete the cookie</pre></div></div>`;
  $("#snip", view).textContent = snippetFor(s.id);
  $("#copy", view).onclick = async () => { try { await navigator.clipboard.writeText(snippetFor(s.id)); toast("Snippet copied"); } catch { toast("Select the text and copy manually", true); } };
  $("#recheck", view).onclick = async () => { await loadSites(); pageSettings(view); toast("Checked"); };
  $("#save-site", view).onclick = async () => {
    try { await api(`/api/sites/${s.id}`, { method: "PATCH", body: { name: $("#s-name").value, domain: $("#s-domain").value } }); toast("Saved"); route(); }
    catch (e) { toast(e.message, true); }
  };
  $$("[data-set]", view).forEach(cb => cb.onchange = async () => {
    try { await api(`/api/sites/${s.id}`, { method: "PATCH", body: { settings: { [cb.dataset.set]: cb.checked } } }); toast("Setting saved — live within a minute"); }
    catch (e) { cb.checked = !cb.checked; toast(e.message, true); }
  });
}


// ---------------------------------------------------------------- Heatmaps
const HM = { path: "", device: "", mode: "click", win: null, current: null };
async function pageHeatmaps(view) {
  const s = curSite();
  const pages = (await api(`/api/sites/${s.id}/pages?days=${S.days}`)).filter(p => p.clicks > 0 || p.views > 0);
  view.innerHTML = siteHead("Heatmaps", "See where visitors click and how far they scroll on a page. Red means lots of activity, blue means little.", rangeSeg());
  if (!pages.length) { view.insertAdjacentHTML("beforeend", `<div class="card">${noData()}</div>`); bindRange(() => pageHeatmaps(view)); return; }
  if (!pages.some(p => p.path === HM.path)) HM.path = (pages.slice().sort((a, b) => b.clicks - a.clicks)[0]).path;
  const d = await api(`/api/sites/${s.id}/heatmap?path=${encodeURIComponent(HM.path)}&days=${S.days}${HM.device ? "&device=" + HM.device : ""}`);
  HM.current = d;
  const topClicks = await api(`/api/sites/${s.id}/clicks?days=${S.days}&path=${encodeURIComponent(HM.path)}`);
  let lastUrl = "";
  try { lastUrl = localStorage.getItem("ot_last_url_" + s.id) || ""; } catch { /* ignore */ }
  let guess = "";
  try { guess = lastUrl ? new URL(lastUrl).origin + HM.path : (s.domain ? "https://" + s.domain + HM.path : ""); } catch { /* ignore */ }
  const seg = (key, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button data-${key}="${v}" class="${(key === "dev" ? HM.device : HM.mode) === v ? "on" : ""}">${l}</button>`).join("")}</div>`;
  view.insertAdjacentHTML("beforeend", `
    <div class="card card-pad" style="margin-bottom:16px"><div class="row">
      <div class="grow" style="max-width:340px"><label class="lbl2" for="hm-page">Page</label>
        <select id="hm-page">${pages.map(p => `<option value="${esc(p.path)}" ${p.path === HM.path ? "selected" : ""}>${esc(p.path)} — ${fmtNum(p.clicks)} clicks</option>`).join("")}</select></div>
      <div><div class="lbl2">Device</div>${seg("dev", [["", "All"], ["desktop", "Desktop"], ["tablet", "Tablet"], ["mobile", "Mobile"]])}</div>
      <div><div class="lbl2">Map</div>${seg("mode", [["click", "Clicks"], ["scroll", "Scroll depth"]])}</div></div></div>
    <div class="grid" style="grid-template-columns:minmax(0,1fr) 300px;align-items:start">
      <div class="card card-pad"><div class="row" style="justify-content:space-between;margin-bottom:8px">
        <div><b class="mono">${esc(HM.path)}</b> <span class="muted">· ${fmtNum(d.clicks)} clicks · ${fmtNum(d.pageviews)} views${d.scroll_samples ? " · " + fmtNum(d.scroll_samples) + " scroll samples" : ""}</span></div>
        <div class="legend" style="margin:0"><span class="muted">low</span><span style="width:110px;height:10px;border-radius:5px;background:linear-gradient(90deg,#00f,#0ff,#0f0,#ff0,#f00);display:inline-block;margin:0 6px"></span><span class="muted">high</span></div></div>
        <div id="hm-wrap" style="position:relative;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;overflow:hidden">
          <canvas id="hm-canvas" style="display:block;width:100%"></canvas><div id="hm-marks"></div></div>
        ${d.clicks || d.scroll_samples ? "" : `<div class="muted" style="margin-top:8px">No ${HM.mode === "click" ? "click coordinates" : "scroll data"} yet for this selection. New visits record them automatically.</div>`}
        <div class="muted" style="font-size:12px;margin-top:8px">Phones, tablets and desktops lay a page out differently, so filter by device for accurate positions. This is a schematic of the page (${fmtNum(d.dw)}×${fmtNum(d.dh)} px). To see the heat on top of your real page, use the overlay on the right.</div></div>
      <div class="grid" style="gap:16px">
        <div class="card card-pad"><h3>Overlay on your live page</h3>
          <div class="field"><input id="hm-url" type="text" placeholder="https://yoursite.com${esc(HM.path)}" value="${esc(guess)}"></div>
          <button class="btn primary" id="hm-open">Open page with heatmap</button>
          <div class="muted" id="hm-msg" style="font-size:12.5px;margin-top:8px">Opens your page in a new tab with the heat painted over it. The snippet must be installed there.</div></div>
        <div class="card card-pad"><h3>Most clicked on this page</h3>
          ${topClicks.clicks.length ? topClicks.clicks.slice(0, 8).map(c => `<div class="bar-row" style="grid-template-columns:1fr 40px"><span class="name" title="${esc(c.sel)}">${esc(c.text || c.sel)}</span><span class="right">${fmtNum(c.n)}</span></div>`).join("") : '<div class="muted">No clicks yet.</div>'}</div></div></div>`);
  bindRange(() => pageHeatmaps(view));
  $("#hm-page", view).onchange = e => { HM.path = e.target.value; pageHeatmaps(view); };
  $$("[data-dev]", view).forEach(b => b.onclick = () => { HM.device = b.dataset.dev; pageHeatmaps(view); });
  $$("[data-mode]", view).forEach(b => b.onclick = () => { HM.mode = b.dataset.mode; pageHeatmaps(view); });
  $("#hm-open", view).onclick = () => {
    let u;
    try { u = new URL($("#hm-url", view).value.trim()); if (!/^https?:$/.test(u.protocol)) throw 0; }
    catch { $("#hm-msg", view).textContent = "Enter the full page address, starting with http:// or https://"; return; }
    try { localStorage.setItem("ot_last_url_" + s.id, u.href); } catch { /* ignore */ }
    u.hash = "ot_heatmap";
    HM.win = window.open(u.href, "ot_heatmap");
    $("#hm-msg", view).textContent = HM.win ? "Opened in a new tab. If you see no toolbar there, the snippet isn't installed on that page." : "Your browser blocked the popup — allow popups and try again.";
  };
  // paint the schematic
  const canvas = $("#hm-canvas", view), W = 860, H = Math.min(3200, Math.max(300, W * d.dh / d.dw));
  if (HM.mode === "click") OTHeat.draw(canvas, d.bins, { W, H, binX: d.bin_x, binY: d.bin_y, srcH: d.dh });
  else OTHeat.drawScroll(canvas, d.scroll, { W, H });
  const marks = [];
  for (let y = 1000; y < d.dh; y += 1000) marks.push(`<div style="position:absolute;left:0;right:0;top:${(y / d.dh * 100).toFixed(2)}%;border-top:1px dashed var(--border-strong);pointer-events:none"><span class="muted" style="font-size:11px;background:var(--surface-2);padding:0 4px">${y}px</span></div>`);
  if (d.vh && d.vh < d.dh) marks.push(`<div style="position:absolute;left:0;right:0;top:${(d.vh / d.dh * 100).toFixed(2)}%;border-top:2px solid var(--text);opacity:.55;pointer-events:none"><span style="font-size:11px;background:var(--text);color:var(--surface);padding:0 6px;border-radius:0 0 4px 0">average fold</span></div>`);
  $("#hm-marks", view).innerHTML = marks.join("");
}

// ---------------------------------------------------------------- Funnels
const stepIcon = { page: "◉", click: "⌖", event: "⚡", form: "▤" };
async function pageFunnels(view) {
  const s = curSite();
  const funnels = await api(`/api/sites/${s.id}/funnels`);
  const results = await Promise.all(funnels.map(f => api(`/api/sites/${s.id}/funnels/${f.id}/results?days=${S.days}`)));
  view.innerHTML = siteHead("Funnels", "Follow visitors through a series of steps — for example product page → add to cart → checkout → purchase — and see exactly where people drop off.",
    `${rangeSeg()}<button class="btn primary" id="new-fun">＋ New funnel</button>`) +
    (funnels.length ? funnels.map((f, i) => funnelCard(f, results[i])).join("") :
      `<div class="card empty"><b>No funnels yet</b>Pick the steps a visitor takes toward a goal and we’ll show how many make it through each one.<br><br><button class="btn primary" id="new-fun-2">＋ Create your first funnel</button></div>`);
  bindRange(() => pageFunnels(view));
  ["#new-fun", "#new-fun-2"].forEach(id => { const b = $(id, view); if (b) b.onclick = () => openNewFunnel(s); });
  $$("[data-del-fun]", view).forEach(b => b.onclick = async () => {
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Click again to delete"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "Delete"; }, 4000); return; }
    try { await api(`/api/sites/${s.id}/funnels/${b.dataset.delFun}`, { method: "DELETE" }); toast("Funnel deleted"); pageFunnels(view); } catch (e) { toast(e.message, true); }
  });
}
function funnelCard(f, r) {
  const worst = r.biggest_drop_step;
  return `<div class="card card-pad" style="margin-bottom:16px"><div class="row" style="justify-content:space-between;margin-bottom:12px">
    <div><b style="font-size:15px">${esc(f.name)}</b><div class="muted">${fmtNum(r.entered)} visitors entered · <b class="${r.overall > 0 ? "good" : ""}">${pct(r.overall)}</b> completed all ${r.steps.length} steps</div></div>
    <button class="btn sm danger" data-del-fun="${esc(f.id)}">Delete</button></div>
    ${r.steps.map((st, i) => `<div style="margin:10px 0">
      <div class="row" style="justify-content:space-between;margin-bottom:3px"><span><span class="muted">${i + 1}.</span> ${stepIcon[st.type] || "•"} <b>${esc(st.label)}</b></span>
        <span><b>${fmtNum(st.count)}</b> <span class="muted">${i ? pct(st.pct_of_prev, 0) + " of previous" : "entered"}</span></span></div>
      <div class="bar" style="height:22px;border-radius:6px"><i style="width:${(st.pct_of_first * 100).toFixed(1)}%;border-radius:0 6px 6px 0;opacity:${1 - i * 0.08}"></i></div>
      ${i ? `<div class="muted" style="font-size:12px;margin-top:2px">${st.lost ? `<span class="${i === worst ? "bad" : ""}">−${fmtNum(st.lost)} dropped off</span>` : "no drop-off"}${st.median_seconds != null ? ` · typically ${fmtDur(st.median_seconds)} after the previous step` : ""}${r.steps[0].count ? ` · new ${fmtNum(st.new)} / returning ${fmtNum(st.returning)}` : ""}</div>` : ""}</div>`).join("")}
    ${worst ? `<div class="callout warn" style="margin-top:12px"><b>Biggest drop-off:</b> step ${worst} → ${worst + 1} (“${esc(r.steps[worst].label)}”) loses ${pct(1 - r.steps[worst].pct_of_prev, 0)} of visitors. Look at that page in <a href="#/site/${esc(S.siteId)}/heatmaps">Heatmaps</a> or <a href="#/site/${esc(S.siteId)}/behavior">Behavior</a>.</div>` : ""}</div>`;
}
