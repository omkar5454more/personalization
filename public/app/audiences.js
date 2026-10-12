/* Audiences (saved segments), targeting-rule builder, and Goals. Loaded after pages.js / modals.js. */
"use strict";

// ---------------------------------------------------------------- rule definitions (keep in sync with backend/rules.py and sdk.js)
const RULE_GROUPS = [
  ["Who they are", [
    ["returning", "First-time or returning (true = returning)", "true"], ["visit_no", "Visit number", "3"], ["days_since_last", "Days since last visit", "7"],
    ["days_since_first", "Days since first visit", "30"], ["customer", "Is a customer", "true"], ["device", "Device", "mobile"],
    ["os", "Operating system", "ios, android, windows, macos, linux"], ["browser", "Browser", "chrome, safari, firefox, edge"],
    ["language", "Browser language", "en, hi, fr"], ["country", "Country code", "IN, US"], ["region", "State or region", "Maharashtra, California"],
    ["city", "City", "Mumbai"]]],
  ["Where they came from", [
    ["traffic_source", "Traffic source", "direct, organic, social, email, paid, referral"], ["referrer_host", "Referrer website", "google.com"],
    ["search_keyword", "Search keyword", "running shoes"], ["utm_source", "UTM source", "google"], ["utm_medium", "UTM medium", "cpc"],
    ["utm_campaign", "UTM campaign", "spring-sale"], ["utm_term", "UTM term", "keyword"], ["utm_content", "UTM content", "banner-a"],
    ["referrer", "Full referrer URL", "facebook.com"], ["landing_page", "Landing page of this visit", "/pricing"]]],
  ["What they're doing", [
    ["url", "Page address (this page)", "/checkout"], ["pages_viewed", "Page count in this visit", "3"], ["total_pageviews", "Page views across all visits", "3"],
    ["hour", "Hour of day (0–23)", "18"], ["weekday", "Day of week (0 = Sunday)", "6"], ["did_event", "Has done an event", "purchase"],
    ["visited_page", "Has visited a page", "/pricing"]]],
];
// Fields that take a name:  attr.plan, param.coupon, cookie.tier, var.user.plan
const DYNAMIC_FIELDS = {
  attr: ["Custom attribute (OT.identify)…", "attribute name, e.g. plan", "Your data"],
  param: ["URL parameter (this page)…", "parameter name, e.g. coupon", "URL parameter"],
  cookie: ["Cookie…", "cookie name, e.g. tier", "Cookie"],
  var: ["JavaScript variable…", "window path, e.g. user.plan", "JS variable"],
};
const dynKind = f => Object.keys(DYNAMIC_FIELDS).find(k => (f || "").startsWith(k + "."));
const RULE_FIELD_LABEL = Object.fromEntries(RULE_GROUPS.flatMap(([, f]) => f.map(([k, l]) => [k, l])));
const RULE_HINT = Object.fromEntries(RULE_GROUPS.flatMap(([, f]) => f.map(([k, , h]) => [k, h])));
const BOOL_FIELDS = new Set(["returning", "customer"]);
const EXISTENCE_FIELDS = { did_event: "has done event", visited_page: "has visited a page containing" };
const RULE_OPS = [["eq", "is"], ["neq", "is not"], ["gte", "≥"], ["lte", "≤"], ["contains", "contains"], ["not_contains", "doesn't contain"], ["in", "is one of"], ["starts", "starts with"]];
const OP_LABEL = Object.fromEntries(RULE_OPS);

function fieldLabel(f) {
  const k = dynKind(f);
  return k ? `${DYNAMIC_FIELDS[k][2]}: ${f.slice(k.length + 1)}` : (RULE_FIELD_LABEL[f] || f);
}
function ruleText(r) {
  if (r.field === "__group") return "(" + (r.rules || []).map(ruleText).join(r.match === "any" ? " OR " : " AND ") + ")";
  if (EXISTENCE_FIELDS[r.field]) return `${r.op === "neq" ? "has not " + EXISTENCE_FIELDS[r.field].replace(/^has /, "") : EXISTENCE_FIELDS[r.field]} “${r.value}”`;
  return `${fieldLabel(r.field)} ${OP_LABEL[r.op] || r.op} ${r.value === "" ? "…" : "“" + r.value + "”"}`;
}
const rulesText = (rules, match) => rules.length ? rules.map(ruleText).join(match === "any" ? "  OR  " : "  AND  ") : "Everyone";

// ---------------------------------------------------------------- rule builder (rows of field / operator / value, plus groups)
function ruleBuilder(host, initial = [], { max = 10, nested = false } = {}) {
  let rows = (initial || []).map(r => ({ ...r, rules: r.rules ? r.rules.map(x => ({ ...x })) : undefined }));
  if (!rows.length) rows = [{ field: "", op: "eq", value: "" }];
  let kids = {};
  // only this builder's own controls -- a group's nested builder lives inside a [data-gbox] and handles its own
  const own = sel => $$(sel, host).filter(e => { const g = e.closest("[data-gbox]"); return !g || g === host; });
  const blank = () => ({ field: "", op: "eq", value: "" });
  const render = () => {
    kids = {};
    host.innerHTML = rows.map((r, i) => {
      if (r.field === "__group") {
        return `<div style="border:1px solid var(--border-strong);border-radius:10px;padding:10px;margin-bottom:8px;background:var(--surface-2)">
          <div class="row" style="margin-bottom:6px"><span class="lbl2">Group</span>
            <select data-gm="${i}" style="width:120px"><option value="all" ${r.match !== "any" ? "selected" : ""}>all of</option><option value="any" ${r.match === "any" ? "selected" : ""}>any of</option></select>
            <span class="muted">these conditions</span><button class="btn sm" type="button" data-rx="${i}">Remove group</button></div>
          <div data-gbox="${i}"></div></div>`;
      }
      const dk = dynKind(r.field), attrName = dk ? r.field.slice(dk.length + 1) : "";
      const exist = EXISTENCE_FIELDS[r.field];
      const opts = exist ? [["eq", "has"], ["neq", "has not"]] : RULE_OPS;
      const valueEl = BOOL_FIELDS.has(r.field)
        ? `<select data-rv="${i}" style="width:130px"><option value="true" ${r.value !== "false" ? "selected" : ""}>true</option><option value="false" ${r.value === "false" ? "selected" : ""}>false</option></select>`
        : `<input data-rv="${i}" type="text" class="grow" placeholder="${esc(dk ? "value, e.g. pro or 100" : (RULE_HINT[r.field] || "value"))}" value="${esc(r.value)}">`;
      return `<div class="row" style="margin-bottom:8px">
        <select data-rf="${i}" style="width:250px"><option value="">${i ? "(choose a field)" : "Choose who…"}</option>
          ${RULE_GROUPS.map(([g, fs]) => `<optgroup label="${esc(g)}">${fs.map(([k, l]) => `<option value="${k}" ${r.field === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</optgroup>`).join("")}
          <optgroup label="Read from the page / your data">${Object.entries(DYNAMIC_FIELDS).map(([k, [l]]) => `<option value="__dyn:${k}" ${dk === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</optgroup></select>
        ${dk ? `<input data-ra="${i}" type="text" style="width:190px" placeholder="${esc(DYNAMIC_FIELDS[dk][1])}" value="${esc(attrName)}">` : ""}
        <select data-ro="${i}" style="width:130px">${opts.map(([k, l]) => `<option value="${k}" ${r.op === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
        ${valueEl}<button class="btn sm" type="button" data-rx="${i}" aria-label="Remove rule" ${rows.length === 1 && !r.field ? "disabled" : ""}>✕</button></div>`;
    }).join("") + (rows.length < max ? `<div class="row"><button class="btn sm" type="button" data-radd>＋ Add a condition</button>${nested ? "" : `<button class="btn sm" type="button" data-rgadd>＋ Add a group</button>`}</div>` : "");
    rows.forEach((r, i) => { if (r.field === "__group") { const box = $(`[data-gbox="${i}"]`, host); kids[i] = ruleBuilder(box, r.rules || [], { max: 10, nested: true }); } });
    own("[data-rf]").forEach(s => s.onchange = () => {
      const i = +s.dataset.rf; sync();
      if (s.value.startsWith("__dyn:")) rows[i].field = s.value.slice(6) + ".";
      else {
        rows[i].field = s.value;
        if (EXISTENCE_FIELDS[s.value] && !["eq", "neq"].includes(rows[i].op)) rows[i].op = "eq";
        if (BOOL_FIELDS.has(s.value)) rows[i].value = "true";
      }
      render();
    });
    own("[data-rx]").forEach(b => b.onclick = () => { sync(); rows.splice(+b.dataset.rx, 1); if (!rows.length) rows = [blank()]; render(); });
    const add = own("[data-radd]")[0]; if (add) add.onclick = () => { sync(); rows.push(blank()); render(); };
    const addg = own("[data-rgadd]")[0]; if (addg) addg.onclick = () => { sync(); rows.push({ field: "__group", op: "eq", value: "", match: "any", rules: [blank()] }); render(); };
  };
  const sync = () => {
    own("[data-rf]").forEach(s => { const i = +s.dataset.rf; if (!s.value.startsWith("__dyn:") && s.value) rows[i].field = s.value; });
    own("[data-ra]").forEach(inp => {
      const i = +inp.dataset.ra, k = dynKind(rows[i].field);
      const clean = k === "var" ? inp.value.trim().replace(/[^A-Za-z0-9_$.]/g, "") : k === "cookie" ? inp.value.trim().replace(/[^A-Za-z0-9_\-]/g, "") : inp.value.trim().replace(/[^A-Za-z0-9_.\-\[\]]/g, "");
      rows[i].field = k + "." + clean.slice(0, 60);
    });
    own("[data-ro]").forEach(s => { rows[+s.dataset.ro].op = s.value; });
    own("[data-rv]").forEach(inp => { rows[+inp.dataset.rv].value = inp.value.trim(); });
    own("[data-gm]").forEach(s => { rows[+s.dataset.gm].match = s.value; });
    Object.keys(kids).forEach(i => { rows[+i].rules = kids[i].get(); });
  };
  render();
  return {
    get() {
      sync();
      return rows.map(r => {
        if (r.field === "__group") return (r.rules && r.rules.length) ? { field: "__group", op: "eq", value: "", match: r.match === "any" ? "any" : "all", rules: r.rules } : null;
        return r.field && !r.field.endsWith(".") ? { field: r.field, op: r.op, value: r.value } : null;
      }).filter(Boolean);
    },
    set(list) { rows = (list || []).map(r => ({ ...r, rules: r.rules ? r.rules.map(x => ({ ...x })) : undefined })); if (!rows.length) rows = [blank()]; render(); },
  };
}

// ---------------------------------------------------------------- audience picker (saved segment or inline rules) shared by campaigns and A/B tests
function audiencePicker(host, site, segments, initial = {}) {
  const curSeg = initial.segment_id && segments.find(s => s.id === initial.segment_id) ? initial.segment_id : "";
  host.innerHTML = `<div class="row" style="margin-bottom:8px">
      <select id="ap-seg" style="max-width:360px"><option value="">Custom rules (build below)</option>
        ${segments.map(s => `<option value="${esc(s.id)}" ${s.id === curSeg ? "selected" : ""}>Saved audience: ${esc(s.name)}</option>`).join("")}</select>
      <select id="ap-match" style="width:190px"><option value="all" ${initial.match !== "any" ? "selected" : ""}>All rules must match</option><option value="any" ${initial.match === "any" ? "selected" : ""}>Any rule can match</option></select>
      <a href="#/site/${esc(site.id)}/audiences" target="_blank" rel="noopener" class="muted" style="font-size:12.5px">Manage audiences ↗</a></div>
    <div id="ap-summary" class="callout" style="display:none;margin-bottom:8px"></div>
    <div id="ap-rules"></div>
    <div id="ap-save" class="row" style="margin-top:6px"><input id="ap-name" type="text" style="width:220px" placeholder="Name to save these rules as an audience">
      <button class="btn sm" type="button" id="ap-save-btn">Save as audience</button><span class="muted" style="font-size:12.5px">Reuse the same people in other campaigns and tests.</span></div>
    <div class="muted" style="font-size:12.5px;margin-top:8px">Leave the rules empty to show it to everyone. Use a <b>group</b> for “this AND (that OR that)”. A <b>visit</b> is a new session — 30 minutes after the previous page view.</div>`;
  const builder = ruleBuilder($("#ap-rules", host), curSeg ? [] : (initial.rules || []));
  const apply = () => {
    const id = $("#ap-seg", host).value, seg = segments.find(s => s.id === id);
    $("#ap-rules", host).style.display = seg ? "none" : "";
    $("#ap-save", host).style.display = seg ? "none" : "";
    $("#ap-match", host).style.display = seg ? "none" : "";
    const sum = $("#ap-summary", host);
    sum.style.display = seg ? "" : "none";
    if (seg) sum.innerHTML = `<b>${esc(seg.name)}</b> — ${esc(rulesText(seg.rules, seg.match))}<div class="muted" style="font-size:12px;margin-top:2px">Editing this audience later updates every campaign and test that uses it.</div>`;
  };
  $("#ap-seg", host).onchange = apply; apply();
  $("#ap-save-btn", host).onclick = async () => {
    const name = $("#ap-name", host).value.trim(), rules = builder.get();
    if (!name) { toast("Name the audience first", true); return; }
    if (!rules.length) { toast("Add at least one rule first", true); return; }
    try {
      const r = await api(`/api/sites/${site.id}/segments`, { method: "POST", body: { name, match: $("#ap-match", host).value, rules } });
      segments.push({ id: r.id, name, match: $("#ap-match", host).value, rules });
      const o = document.createElement("option"); o.value = r.id; o.textContent = "Saved audience: " + name;
      $("#ap-seg", host).appendChild(o); $("#ap-seg", host).value = r.id; apply(); toast("Audience saved");
    } catch (e) { toast(e.message, true); }
  };
  return {
    get() {
      const segment_id = $("#ap-seg", host).value;
      return segment_id ? { segment_id, rules: [], match: "all" } : { segment_id: "", rules: builder.get(), match: $("#ap-match", host).value };
    },
    setRules(rules, match) { $("#ap-seg", host).value = ""; apply(); $("#ap-match", host).value = match || "all"; builder.set(rules); },
  };
}

// ---------------------------------------------------------------- Audiences page
const STARTER_AUDIENCES = [
  ["Returning visitors", "People who have been here before.", "all", [{ field: "returning", op: "eq", value: "true" }]],
  ["New visitors", "First-time visitors.", "all", [{ field: "returning", op: "eq", value: "false" }]],
  ["Mobile visitors", "Phones only.", "all", [{ field: "device", op: "eq", value: "mobile" }]],
  ["Came from Google", "Arrived from a Google search or ad.", "all", [{ field: "referrer_host", op: "contains", value: "google" }]],
  ["Engaged (3+ pages)", "Viewed three or more pages this visit.", "all", [{ field: "pages_viewed", op: "gte", value: "3" }]],
  ["Customers", "Bought before or flagged as a customer.", "all", [{ field: "customer", op: "eq", value: "true" }]],
  ["Organic search visitors", "Arrived from a search engine.", "all", [{ field: "traffic_source", op: "eq", value: "organic" }]],
  ["Mumbai visitors", "Located in Mumbai (needs the host's location headers).", "all", [{ field: "city", op: "eq", value: "Mumbai" }]],
];

async function pageAudiences(view) {
  const s = curSite();
  const segs = await api(`/api/sites/${s.id}/segments`);
  view.innerHTML = siteHead("Audiences", "Save who you want to reach once, then reuse it in campaigns and A/B tests. Change an audience and everything using it follows.",
    `<button class="btn primary" id="new-seg">＋ New audience</button>`) +
    `<div class="card">${segs.length ? `<div class="table-wrap"><table><thead><tr><th>Audience</th><th>Who is in it</th><th class="right">Used by</th><th></th></tr></thead><tbody>
      ${segs.map(x => `<tr><td><b>${esc(x.name)}</b>${x.description ? `<div class="muted">${esc(x.description)}</div>` : ""}</td>
        <td>${esc(rulesText(x.rules, x.match))}</td><td class="right">${x.used_by ? `${x.used_by} campaign${x.used_by > 1 ? "s" : ""}/test${x.used_by > 1 ? "s" : ""}` : '<span class="muted">not used yet</span>'}</td>
        <td class="right nowrap"><button class="btn sm" data-edit-seg="${esc(x.id)}">Edit</button> <button class="btn sm danger" data-del-seg="${esc(x.id)}">Delete</button></td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty"><b>No audiences yet</b>Start from a ready-made one below, or build your own.</div>`}</div>
    <div class="card card-pad" style="margin-top:16px"><h3>Quick start</h3><div class="row">${STARTER_AUDIENCES.map(([n], i) =>
      `<button class="btn sm" data-starter="${i}" ${segs.some(x => x.name.toLowerCase() === n.toLowerCase()) ? "disabled" : ""}>＋ ${esc(n)}</button>`).join("")}</div>
      <div class="muted" style="font-size:12.5px;margin-top:10px">Rules run in your visitor's browser, so they react instantly and no personal data leaves it. Add your own facts with
      <code>OT.identify({ plan: "pro", cart_value: 120 })</code> and target them as “Custom attribute”.</div></div>`;
  $("#new-seg", view).onclick = () => openSegmentModal(s, null);
  $$("[data-edit-seg]", view).forEach(b => b.onclick = () => openSegmentModal(s, segs.find(x => x.id === b.dataset.editSeg)));
  $$("[data-del-seg]", view).forEach(b => b.onclick = async () => {
    const x = segs.find(y => y.id === b.dataset.delSeg);
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = x.used_by ? `Used by ${x.used_by} — click again` : "Click again to delete"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "Delete"; }, 4000); return; }
    try { await api(`/api/sites/${s.id}/segments/${x.id}`, { method: "DELETE" }); toast("Audience deleted"); pageAudiences(view); } catch (e) { toast(e.message, true); }
  });
  $$("[data-starter]", view).forEach(b => b.onclick = async () => {
    const [name, description, match, rules] = STARTER_AUDIENCES[+b.dataset.starter];
    try { await api(`/api/sites/${s.id}/segments`, { method: "POST", body: { name, description, match, rules } }); toast("Audience added"); pageAudiences(view); } catch (e) { toast(e.message, true); }
  });
}

function openSegmentModal(site, existing) {
  const m = openModal(existing ? "Edit audience" : "New audience", `
    <div class="field"><label for="sg-name">Name</label><input id="sg-name" type="text" placeholder="Returning mobile visitors from Google" value="${esc(existing ? existing.name : "")}"></div>
    <div class="field"><label for="sg-desc">Description (optional)</label><input id="sg-desc" type="text" value="${esc(existing ? existing.description : "")}"></div>
    <div class="row" style="justify-content:space-between"><div class="lbl2" style="margin:0 0 6px">Who is in it?</div>
      <select id="sg-match" style="width:190px"><option value="all" ${!existing || existing.match === "all" ? "selected" : ""}>All rules must match</option><option value="any" ${existing && existing.match === "any" ? "selected" : ""}>Any rule can match</option></select></div>
    <div id="sg-rules"></div>
    <div id="sg-live" class="callout" style="margin-top:8px"></div><div id="sg-err" class="bad" style="margin-top:10px"></div>`,
    { wide: true, footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="sg-save">${existing ? "Save changes" : "Create audience"}</button>` });
  const el = m.el, b = ruleBuilder($("#sg-rules", el), existing ? existing.rules : []);
  const live = () => { $("#sg-live", el).innerHTML = `<b>In plain words:</b> ${esc(rulesText(b.get(), $("#sg-match", el).value))}`; };
  el.addEventListener("input", live); el.addEventListener("change", live); live();
  $("#sg-save", el).onclick = async () => {
    const body = { name: $("#sg-name", el).value.trim(), description: $("#sg-desc", el).value.trim(), match: $("#sg-match", el).value, rules: b.get() };
    if (!body.name) { $("#sg-err", el).textContent = "Give the audience a name."; return; }
    if (!body.rules.length) { $("#sg-err", el).textContent = "Add at least one rule."; return; }
    try {
      if (existing) await api(`/api/sites/${site.id}/segments/${existing.id}`, { method: "PUT", body });
      else await api(`/api/sites/${site.id}/segments`, { method: "POST", body });
      m.close(); toast(existing ? "Audience updated — live within a minute" : "Audience created"); route();
    } catch (e) { $("#sg-err", el).textContent = e.message; }
  };
}

// ---------------------------------------------------------------- Goals page
const GOAL_TYPE_LABEL = { click: "Click on an element", pageview: "Visit a page", event: "Custom event", form: "Form submitted" };
function goalDetail(g) {
  return g.type === "click" ? `<code>${esc(g.selector)}</code>` : g.type === "pageview" ? `URL contains <code>${esc(g.url_contains)}</code>` :
    g.type === "event" ? `OT.track(<code>${esc(g.event_name)}</code>)` : `form <code>${esc(g.form_name)}</code>`;
}
function spark(daily, days) {
  const by = Object.fromEntries(daily.map(d => [d.d, d.conversions]));
  const list = dayList(Math.min(days, 30)).map(d => by[d] || 0), max = Math.max(...list, 1), w = 4, gap = 1, h = 26;
  return `<svg width="${list.length * (w + gap)}" height="${h}" role="img" aria-label="Daily conversions">${list.map((v, i) =>
    `<rect x="${i * (w + gap)}" y="${h - Math.max(v ? 2 : 0, v / max * h)}" width="${w}" height="${Math.max(v ? 2 : 0, v / max * h)}" rx="1" fill="var(--series-1)"/>`).join("")}</svg>`;
}
const money = v => v ? "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "–";

async function pageGoals(view) {
  const s = curSite();
  const rep = await api(`/api/sites/${s.id}/goals/report?days=${Math.min(S.days, 90)}`);
  const active = rep.goals.filter(g => !g.archived), archived = rep.goals.filter(g => g.archived && g.conversions);
  const totalConv = active.reduce((a, g) => a + g.conversions, 0), totalVal = active.reduce((a, g) => a + g.value, 0);
  view.innerHTML = siteHead("Goals", "Define what counts as a conversion once — a purchase, a signup, a click — then use it in A/B tests and campaigns and see what drives it.",
    `${rangeSeg()}<button class="btn primary" id="new-goal">＋ New goal</button>`) + `
    <div class="grid g4" style="margin-bottom:16px">${kpi("Goals tracked", fmtNum(active.length))}${kpi("Visitors", fmtNum(rep.visitors), "in this period")}${kpi("Conversions", fmtNum(totalConv))}${kpi("Value", money(totalVal), "sum of goal values")}</div>
    ${active.length ? active.map(g => goalCard(g, rep.days)).join("") : `<div class="card empty"><b>No goals yet</b>Create your first goal — for example “Signup” (event <code>signup</code>) or “Clicked Buy” (selector <code>#buy-button</code>).<br><br><button class="btn primary" id="new-goal-2">＋ Create a goal</button></div>`}
    ${archived.length ? `<details style="margin-top:8px"><summary class="muted" style="cursor:pointer">Archived goals with data (${archived.length})</summary>${archived.map(g => goalCard(g, rep.days, true)).join("")}</details>` : ""}
    <div class="muted" style="font-size:12px;margin-top:12px">${esc(rep.note)}</div>`;
  bindRange(() => pageGoals(view));
  ["#new-goal", "#new-goal-2"].forEach(id => { const b = $(id, view); if (b) b.onclick = () => openGoalModal(s, null); });
  $$("[data-edit-goal]", view).forEach(b => b.onclick = () => openGoalModal(s, rep.goals.find(g => g.id === b.dataset.editGoal)));
  $$("[data-arch-goal]", view).forEach(b => b.onclick = async () => {
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Click again to archive"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "Archive"; }, 4000); return; }
    try { await api(`/api/sites/${s.id}/goals/${b.dataset.archGoal}`, { method: "DELETE" }); toast("Goal archived — past data is kept"); pageGoals(view); } catch (e) { toast(e.message, true); }
  });
}
function goalCard(g, days, archived = false) {
  return `<div class="card card-pad" style="margin-bottom:16px"><div class="row" style="justify-content:space-between;align-items:flex-start">
    <div><b style="font-size:15px">${esc(g.name)}</b> ${archived ? '<span class="pill">archived</span>' : ""}
      <div class="muted">${esc(GOAL_TYPE_LABEL[g.type])} · ${goalDetail(g)} · ${g.count_mode === "every" ? "every time" : "once per visitor"}${g.value ? " · worth " + money(g.value) + " each" : ""}</div></div>
    ${archived ? "" : `<div class="row"><button class="btn sm" data-edit-goal="${esc(g.id)}">Edit</button><button class="btn sm danger" data-arch-goal="${esc(g.id)}">Archive</button></div>`}</div>
    <div class="grid g4" style="margin:12px 0">
      <div><div class="lbl2">Conversions</div><div style="font-size:22px;font-weight:600">${fmtNum(g.conversions)}</div></div>
      <div><div class="lbl2">People who converted</div><div style="font-size:22px;font-weight:600">${fmtNum(g.converters)}</div></div>
      <div><div class="lbl2">Conversion rate</div><div style="font-size:22px;font-weight:600">${pct(g.rate, 2)}</div></div>
      <div><div class="lbl2">Value</div><div style="font-size:22px;font-weight:600">${money(g.value)}</div><div style="margin-top:4px">${spark(g.daily, days)}</div></div></div>
    ${g.influenced_by.length ? `<details><summary class="muted" style="cursor:pointer">What did converting visitors see? (${g.influenced_by.length})</summary><div class="table-wrap"><table><thead><tr><th>Campaign / test</th><th class="right">Shown to</th><th class="right">Converted after</th><th class="right">Rate</th><th class="right">Rate if not shown</th><th class="right">Lift</th></tr></thead><tbody>
      ${g.influenced_by.map(a => `<tr><td>${a.kind === "test" ? "⚗" : "✦"} ${esc(a.name)} ${a.kind === "test" ? `<span class="muted">(${esc(a.variant)})</span>` : ""}</td><td class="right">${fmtNum(a.exposed)}</td><td class="right">${fmtNum(a.converted)}</td>
        <td class="right">${pct(a.rate, 1)}</td><td class="right">${a.rate_not_shown == null ? "–" : pct(a.rate_not_shown, 1)}</td>
        <td class="right ${a.lift > 0 ? "good" : a.lift < 0 ? "bad" : ""}">${a.lift == null ? "–" : (a.lift > 0 ? "+" : "") + (a.lift * 100).toFixed(0) + "%"}</td></tr>`).join("")}</tbody></table></div></details>`
      : `<div class="muted" style="font-size:12.5px">${g.conversions ? "No campaign or test has been shown to enough of these visitors yet." : "No conversions in this period."}</div>`}</div>`;
}

function openGoalModal(site, existing) {
  const g0 = existing || { name: "", type: "event", selector: "", url_contains: "", event_name: "", form_name: "", value: 0, count_mode: "once" };
  const m = openModal(existing ? "Edit goal" : "New goal", `
    <div class="field"><label for="g-name">Goal name</label><input id="g-name" type="text" placeholder="Signup" value="${esc(g0.name)}"></div>
    <div class="grid g2"><div class="field"><label for="g-type">It counts when a visitor…</label>
      <select id="g-type">${Object.entries(GOAL_TYPE_LABEL).map(([k, l]) => `<option value="${k}" ${g0.type === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
      <div class="field"><label for="g-val" id="g-val-label">Value</label><input id="g-val" type="text"><span class="help" id="g-help"></span></div></div>
    <div class="grid g2"><div class="field"><label for="g-count">How often</label><select id="g-count"><option value="once" ${g0.count_mode !== "every" ? "selected" : ""}>Once per visitor</option><option value="every" ${g0.count_mode === "every" ? "selected" : ""}>Every time it happens (e.g. purchases)</option></select></div>
      <div class="field"><label for="g-worth">Worth (optional, per conversion)</label><input id="g-worth" type="number" min="0" step="any" value="${esc(g0.value || "")}" placeholder="e.g. 49 for a $49 order"><span class="help">Adds up into “Value” on the Goals page.</span></div></div>
    <div id="g-err" class="bad" style="margin-top:6px"></div>`,
    { footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="g-save">${existing ? "Save changes" : "Create goal"}</button>` });
  const el = m.el, key = { click: "selector", pageview: "url_contains", event: "event_name", form: "form_name" };
  const info = { click: ["CSS selector", "#buy-button", "The button or link to click."], pageview: ["Part of the URL", "/thank-you", "A visit to a URL containing this text."],
    event: ["Event name", "signup", "The name you pass to OT.track('name') on your site."], form: ["Form name", "contact", "The form's id, name or action. Only the name is recorded, never what people type."] };
  const sync = () => { const t = $("#g-type", el).value, [l, ph, h] = info[t]; $("#g-val-label", el).textContent = l; $("#g-val", el).placeholder = ph; $("#g-help", el).textContent = h; };
  $("#g-type", el).onchange = () => { sync(); }; sync(); $("#g-val", el).value = g0[key[g0.type]] || "";
  $("#g-save", el).onclick = async () => {
    const type = $("#g-type", el).value, v = $("#g-val", el).value.trim();
    const body = { name: $("#g-name", el).value.trim(), type, selector: "", url_contains: "", event_name: "", form_name: "", value: parseFloat($("#g-worth", el).value) || 0, count_mode: $("#g-count", el).value };
    body[key[type]] = v;
    if (!body.name) { $("#g-err", el).textContent = "Give the goal a name."; return; }
    try {
      if (existing) await api(`/api/sites/${site.id}/goals/${existing.id}`, { method: "PUT", body });
      else await api(`/api/sites/${site.id}/goals`, { method: "POST", body });
      m.close(); toast(existing ? "Goal updated — live within a minute" : "Goal created — it starts counting within a minute"); route();
    } catch (e) { $("#g-err", el).textContent = e.message; }
  };
}
