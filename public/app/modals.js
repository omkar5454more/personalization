/* Dialogs: add site, new A/B test (with visual-editor bridge), new campaign, visitor journey. */
"use strict";

function openModal(title, bodyHtml, { footer = "", wide = false, drawer = false } = {}) {
  const root = $("#modal-root");
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="modal ${wide ? "wide" : ""} ${drawer ? "drawer" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="btn sm" data-close aria-label="Close">✕</button></div>
    <div class="modal-body">${bodyHtml}</div>${footer ? `<div class="modal-foot">${footer}</div>` : ""}</div>`;
  const handle = { el: ov, close: null, onClose: null };
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); if (handle.onClose) handle.onClose(); };
  const onKey = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $$("[data-close]", ov).forEach(b => b.onclick = close);
  root.appendChild(ov);
  const first = $("input,select,textarea", ov); if (first) first.focus();
  handle.close = close;
  return handle;
}

// ---------------------------------------------------------------- add site
function openAddSite() {
  const m = openModal("Add a site", `
    <div class="field"><label for="n-name">Site name</label><input id="n-name" type="text" placeholder="My store"></div>
    <div class="field"><label for="n-domain">Domain</label><input id="n-domain" type="text" placeholder="example.com">
      <span class="help">The website you want to track and optimise. You can change it later.</span></div>
    <div id="n-err" class="bad"></div>`,
    { footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="n-save">Add site</button>` });
  $("#n-save", m.el).onclick = async () => {
    try {
      const r = await api("/api/sites", { method: "POST", body: { name: $("#n-name").value.trim(), domain: $("#n-domain").value.trim() } });
      m.close(); toast("Site added — now install the snippet");
      location.hash = `#/site/${r.id}/settings`;
    } catch (e) { $("#n-err", m.el).textContent = e.message; }
  };
}

// ---------------------------------------------------------------- visual editor bridge
const EDITOR = { win: null, changes: [], onChange: null, siteId: null };
const EDIT_ACTIONS = ["text", "html", "css", "attr", "hide"];
const validChange = c => c && typeof c.selector === "string" && c.selector.length <= 500 && EDIT_ACTIONS.includes(c.action)
  && typeof c.value === "string" && c.value.length <= 5000;
const cleanChange = c => ({ selector: c.selector, action: c.action, value: c.value, attr: typeof c.attr === "string" ? c.attr.slice(0, 50) : "" });

window.addEventListener("message", e => {
  // Only the editor window we opened may talk to us; reply to whatever origin it is actually at
  // (the page may have redirected, e.g. to www.) and send nothing but the change list.
  if (!EDITOR.win || e.source !== EDITOR.win) return;
  const m = e.data || {};
  if (m.type === "ot:ready") { try { EDITOR.win.postMessage({ type: "ot:init", changes: EDITOR.changes }, e.origin); } catch { /* opaque origin */ } }
  else if (m.type === "ot:changes" && Array.isArray(m.changes)) {
    EDITOR.changes = m.changes.filter(validChange).slice(0, 200).map(cleanChange);
    if (EDITOR.onChange) EDITOR.onChange();
  }
  else if (m.type === "ot:upload") handleEditorUpload(e, m);
});

// The editor runs on the customer's site (no login there), so it hands image files to us and we upload them with the
// user's session. The reply goes only to the window that asked, at its own origin, and carries just a public URL.
async function handleEditorUpload(e, m) {
  const reply = r => { try { e.source.postMessage({ type: "ot:upload:result", id: m.id, ...r }, e.origin); } catch { /* window gone */ } };
  if (!(m.blob instanceof Blob) || !EDITOR.siteId) return reply({ ok: false, error: "Upload isn't available here." });
  try {
    const r = await fetch(`/api/sites/${EDITOR.siteId}/images`, {
      method: "POST", body: m.blob,
      headers: { "Content-Type": m.blob.type, "X-Filename": encodeURIComponent(String(m.name || "image").slice(0, 80)) },
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return reply({ ok: false, error: typeof d.detail === "string" ? d.detail : `Upload failed (${r.status})` });
    reply({ ok: true, url: location.origin + d.url });     // absolute, so it works on the customer's domain
  } catch (err) { reply({ ok: false, error: "Upload failed: " + err.message }); }
}

// ---------------------------------------------------------------- new A/B test
function openNewExperiment(site) {
  EDITOR.changes = []; EDITOR.siteId = site.id;
  let lastUrl = "";
  try { lastUrl = localStorage.getItem("ot_last_url_" + site.id) || ""; } catch { /* ignore */ }
  if (!lastUrl && site.domain) lastUrl = "https://" + site.domain + "/";
  const m = openModal("New A/B test", `
    <div class="field"><label for="x-name">Test name</label><input id="x-name" type="text" placeholder="Homepage headline test"></div>
    <div class="grid g2">
      <div class="field"><label for="x-url">Run only on URLs containing</label><input id="x-url" type="text" placeholder="/pricing  (blank = every page)"></div>
      <div class="field"><label for="x-traffic">Traffic included (%)</label><input id="x-traffic" type="number" value="100" min="1" max="100"></div></div>
    <hr style="border:0;border-top:1px solid var(--border);margin:6px 0 14px">
    <div class="lbl2" style="margin-bottom:6px">Step 1 · Build the variant (version B)</div>
    <div class="row"><input id="x-page" type="text" class="grow" placeholder="https://yoursite.com/page-to-edit" value="${esc(lastUrl)}">
      <button class="btn primary" id="x-open">Open visual editor</button></div>
    <div class="muted" id="x-msg" style="margin:6px 0 10px;font-size:12.5px">Your page opens in a new tab. Click any element, change text, colour, size or link, or hide it, then press “Done”. The snippet must already be on that page.</div>
    <div class="lbl2">Changes in version B <span class="muted" id="x-count"></span></div><div id="x-list" style="margin-bottom:10px"></div>
    <details><summary class="muted" style="cursor:pointer">Add a change by CSS selector instead</summary>
      <div class="row" style="margin-top:8px"><input id="x-sel" type="text" class="grow" placeholder="CSS selector e.g. h1">
        <select id="x-act" style="width:110px"><option>text</option><option>html</option><option>css</option><option>hide</option></select>
        <input id="x-val" type="text" class="grow" placeholder="New value"><button class="btn sm" id="x-add">Add</button></div></details>
    <hr style="border:0;border-top:1px solid var(--border);margin:14px 0">
    <div class="lbl2" style="margin-bottom:6px">Step 2 · What counts as a win?</div>
    <div class="row"><select id="x-gt" style="width:210px"><option value="click">Click on an element</option><option value="pageview">Visit a page</option><option value="event">Custom event</option></select>
      <input id="x-gv" type="text" class="grow" placeholder="#buy-button"></div>
    <div class="muted" id="x-gh" style="font-size:12.5px;margin-top:4px">CSS selector of the button/link visitors should click.</div>
    <div id="x-err" class="bad" style="margin-top:10px"></div>`,
    { wide: true, footer: `<span class="muted" style="margin-right:auto">Saved as a draft — you start it from the A/B tests page.</span><button class="btn" data-close>Cancel</button><button class="btn primary" id="x-create">Create test</button>` });
  const el = m.el;
  const render = () => {
    $("#x-count", el).textContent = `(${EDITOR.changes.length})`;
    $("#x-list", el).innerHTML = EDITOR.changes.length ? `<div class="table-wrap"><table><tbody>${EDITOR.changes.map((c, i) => `<tr><td><code>${esc(c.action + (c.attr ? ":" + c.attr : ""))}</code></td>
      <td class="mono" style="word-break:break-all">${esc(c.selector)}</td><td style="word-break:break-all">${esc(c.value.slice(0, 60))}</td><td class="right"><button class="btn sm" data-rm="${i}">✕</button></td></tr>`).join("")}</tbody></table></div>`
      : `<div class="muted">No changes yet — version B would look identical to the original.</div>`;
    $$("[data-rm]", el).forEach(b => b.onclick = () => { EDITOR.changes.splice(+b.dataset.rm, 1); render(); });
  };
  EDITOR.onChange = render; render();
  const hints = { click: ["#buy-button", "CSS selector of the button/link visitors should click."], pageview: ["/thank-you", "A visit to a URL containing this text counts as a conversion."], event: ["purchase", "Name used in OT.track('name') on your site."] };
  $("#x-gt", el).onchange = e => { const h = hints[e.target.value]; $("#x-gv", el).placeholder = h[0]; $("#x-gh", el).textContent = h[1]; };
  $("#x-add", el).onclick = () => {
    const c = { selector: $("#x-sel", el).value.trim(), action: $("#x-act", el).value, value: $("#x-val", el).value, attr: "" };
    if (!c.selector) return;
    EDITOR.changes.push(c); $("#x-sel", el).value = ""; $("#x-val", el).value = ""; render();
  };
  $("#x-open", el).onclick = () => {
    let u;
    try { u = new URL($("#x-page", el).value.trim()); if (!/^https?:$/.test(u.protocol)) throw 0; }
    catch { $("#x-msg", el).textContent = "Enter the full page address, starting with http:// or https://"; return; }
    try { localStorage.setItem("ot_last_url_" + site.id, u.href); } catch { /* ignore */ }
    u.hash = "ot_editor";
    EDITOR.win = window.open(u.href, "ot_editor");
    $("#x-msg", el).textContent = EDITOR.win ? "Editor opened in a new tab. If no toolbar appears there, the snippet isn't installed on that page (or the site blocks scripts)."
      : "Your browser blocked the popup — allow popups for this page and try again.";
  };
  $("#x-create", el).onclick = async () => {
    const g = id => $(id, el).value.trim(), gt = g("#x-gt"), gv = g("#x-gv");
    const body = {
      name: g("#x-name"), url_contains: g("#x-url"), traffic: +g("#x-traffic") || 100,
      variants: [{ key: "control", weight: 50 }, { key: "variant_b", weight: 50, changes: EDITOR.changes }],
      goal: { type: gt, selector: gt === "click" ? gv : "", url_contains: gt === "pageview" ? gv : "", name: gt === "event" ? gv : "" },
    };
    if (!body.name) { $("#x-err", el).textContent = "Give the test a name."; return; }
    if (!gv) { $("#x-err", el).textContent = "Tell us what counts as a win (step 2)."; return; }
    try { await api(`/api/sites/${site.id}/experiments`, { method: "POST", body }); EDITOR.onChange = null; m.close(); toast("Test created as a draft — press Start when ready"); route(); }
    catch (e) { $("#x-err", el).textContent = e.message; }
  };
}

// ---------------------------------------------------------------- campaign editor (create + edit)
const CUSTOM_TEMPLATES = {
  hubspot: {
    label: "HubSpot form",
    html: `<h3 style="margin:0 0 12px">Get 10% off your first order</h3>
<div id="hs-form"></div>
<!-- HubSpot's loader. Scripts here run in order, before the JavaScript tab. -->
<script src="https://js.hsforms.net/forms/embed/v2.js"></script>`,
    css: `{{container}} { max-width: 480px; }`,
    js: `// Replace the three values with yours: HubSpot > Marketing > Forms > Share > Embed code.
hbspt.forms.create({
  region: "na1",
  portalId: "YOUR_PORTAL_ID",
  formId: "YOUR_FORM_ID",
  target: "#hs-form"
});
// HubSpot submissions are counted as conversions automatically.`,
  },
  typeform: {
    label: "Typeform",
    html: `<div data-tf-live="YOUR_FORM_ID" data-tf-on-submit="otTypeformDone" style="height:440px"></div>
<script src="//embed.typeform.com/next/embed.js"></script>`,
    css: `{{container}} { max-width: 560px; padding: 8px; }`,
    js: `// Typeform calls this function after a response is submitted.
window.otTypeformDone = function () { ctx.conversion("typeform_submit"); };`,
  },
  google: {
    label: "Google Form",
    html: `<iframe src="https://docs.google.com/forms/d/e/YOUR_FORM_ID/viewform?embedded=true"
        width="100%" height="520" frameborder="0" marginheight="0" marginwidth="0">Loading…</iframe>`,
    css: `{{container}} { max-width: 640px; }`,
    js: `// Google Forms can't tell the page about submissions, but the iframe loads a second
// time (the "thank you" page) once someone submits, so we count that.
var frame = container.querySelector("iframe"), loads = 0;
frame.addEventListener("load", function () { if (++loads > 1) ctx.conversion("google_form_submit"); });`,
  },
  mailchimp: {
    label: "Mailchimp / any pasted form",
    html: `<!-- Paste your Mailchimp "Embedded form" (or any provider's HTML form) here. -->
<form action="https://YOUR-ACCOUNT.usX.list-manage.com/subscribe/post?u=YOUR_U&id=YOUR_ID" method="post" target="_blank">
  <h3 style="margin:0 0 10px">Join our newsletter</h3>
  <input type="email" name="EMAIL" placeholder="you@example.com" required>
  <button type="submit">Subscribe</button>
</form>`,
    css: `{{container}} input { width: 100%; padding: 10px; margin: 6px 0; border: 1px solid #ccc; border-radius: 8px; box-sizing: border-box; }
{{container}} button { padding: 10px 18px; border: 0; border-radius: 8px; background: #2a78d6; color: #fff; cursor: pointer; }`,
    js: `// Native <form> submits are counted as conversions automatically.`,
  },
  plain: {
    label: "Plain HTML form",
    html: `<h3 style="margin:0 0 6px">Join the coffee club</h3>
<p style="margin:0 0 12px;color:#555">Get 10% off your first order.</p>
<form id="club-form">
  <input type="email" name="email" placeholder="you@example.com" required>
  <button type="submit">Get my 10% off</button>
</form>
<p class="thanks" hidden>Thanks! Check your inbox for the code.</p>`,
    css: `{{container}} input { width: 100%; padding: 11px; margin-bottom: 10px; border: 1px solid #cfc6bb; border-radius: 8px; font-size: 15px; box-sizing: border-box; }
{{container}} button[type=submit] { width: 100%; padding: 12px; border: 0; border-radius: 999px; background: #b05a3c; color: #fff; font-weight: 600; font-size: 15px; cursor: pointer; }
{{container}} .thanks { color: #2f4a3a; font-weight: 600; }`,
    js: `var form = container.querySelector("form");
form.addEventListener("submit", function (e) {
  e.preventDefault();
  // To collect the emails, send them to your own endpoint, for example:
  // fetch("https://your-api.example.com/subscribe", {
  //   method: "POST", headers: { "Content-Type": "application/json" },
  //   body: JSON.stringify({ email: form.email.value })
  // });
  form.hidden = true;
  container.querySelector(".thanks").hidden = false;
  OT.track("club_signup");   // shows up under Custom events in Overview
});`,
  },
};

function previewDoc(html, css, js) {
  const cid = "ot-preview";
  const scoped = css.replace(/\{\{\s*container\s*\}\}/g, "#" + cid);
  const safeJs = js.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:20px;font:15px/1.5 system-ui,sans-serif;background:#eef0f4}
#${cid}{background:#fff;color:#111;border-radius:12px;padding:24px;max-width:520px;margin:0 auto;box-shadow:0 4px 18px rgba(0,0,0,.15);box-sizing:border-box}${scoped}</style></head>
<body><div id="${cid}" class="ot-custom">${html}</div>
<script>(function(container,OT,ctx){try{
${safeJs}
}catch(e){document.body.insertAdjacentHTML("beforeend","<pre style='color:#b42318;white-space:pre-wrap'>JavaScript error: "+String(e.message).replace(/</g,"&lt;")+"</pre>")}})(document.getElementById("${cid}"),{track:function(){},visitor:{}},{conversion:function(){},close:function(){},container:null});<\/script></body></html>`;
}

function openNewCampaign(site, opts) { openCampaignModal(site, null, opts || {}); }

function openCampaignModal(site, existing, opts = {}) {
  const cfg = existing ? existing.config : null;
  const act = cfg ? cfg.actions[0] : null;
  const fields = [["returning", "Returning visitor (true/false)"], ["visit_no", "Visit number"], ["days_since_last", "Days since last visit"], ["days_since_first", "Days since first visit"],
    ["utm_source", "UTM source"], ["utm_medium", "UTM medium"], ["utm_campaign", "UTM campaign"], ["device", "Device (mobile/tablet/desktop)"], ["country", "Country code (e.g. IN)"],
    ["hour", "Hour of day (0–23)"], ["weekday", "Weekday (0=Sun)"], ["url", "Page URL"], ["referrer", "Referrer"]];
  const ops = [["eq", "is"], ["neq", "is not"], ["gte", "≥"], ["lte", "≤"], ["contains", "contains"]];
  const rule = i => (cfg && cfg.rules[i]) || { field: "", op: "eq", value: "" };
  const sel = (id, opts, cur, extra = "") => `<select id="${id}" ${extra}>${opts.map(([k, l]) => `<option value="${k}" ${String(cur) === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const ruleRow = i => `<div class="row" style="margin-bottom:8px">
    <select id="c-f${i}" style="width:230px"><option value="">${i ? "(optional) another rule" : "(everyone)"}</option>${fields.map(([k, l]) => `<option value="${k}" ${rule(i).field === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
    ${sel("c-o" + i, ops, rule(i).op, 'style="width:100px"')}<input id="c-v${i}" type="text" class="grow" placeholder="value e.g. true, 3, google, mobile" value="${esc(rule(i).value)}"></div>`;
  const v = (k, d = "") => (act && act[k] != null && act[k] !== "" ? act[k] : d);
  const type0 = act ? (act.type === "change" ? "visual" : act.type) : (opts.visual ? "visual" : "banner");

  const m = openModal(existing ? "Edit campaign" : "New personalization campaign", `
    <div class="field"><label for="c-name">Campaign name</label><input id="c-name" type="text" placeholder="3rd-visit signup form" value="${esc(cfg ? cfg.name : "")}"></div>

    <div class="row" style="justify-content:space-between"><div class="lbl2" style="margin:0 0 6px">1 · Who should see it?</div>
      <button class="btn sm" id="c-preset3" type="button">Preset: show on the 3rd visit</button></div>
    ${ruleRow(0)}${ruleRow(1)}
    <div class="row" style="margin-bottom:6px">
      ${sel("c-match", [["all", "All rules must match"], ["any", "Any rule can match"]], cfg ? cfg.match : "all", 'style="width:190px"')}
      ${sel("c-freq", [["once", "Show once per visitor"], ["session", "Once per visit"], ["always", "Every page load"]], cfg ? cfg.frequency : "once", 'style="width:190px"')}
      <input id="c-url" type="text" class="grow" placeholder="Only on URLs containing… (blank = all)" value="${esc(cfg ? cfg.url_contains : "")}"></div>
    <div class="muted" style="font-size:12.5px;margin-bottom:14px">A <b>visit</b> is a new session — 30 minutes after the previous page view. “Visit number ≥ 3” + “once per visitor” shows the content the first time someone arrives for the 3rd time.</div>

    <div class="lbl2" style="margin-bottom:6px">2 · What should they see?</div>
    <div class="row" style="margin-bottom:10px">${sel("c-type", [["visual", "Change the page — edit text, images, buttons on your real page"], ["banner", "Banner"], ["popup", "Popup"], ["custom", "Custom code (HTML / CSS / JS) — forms, embeds, anything"]], type0, 'style="max-width:420px"')}</div>

    <div id="p-simple" style="display:none">
      <div class="row" style="margin-bottom:8px">${sel("c-pos", [["top", "Banner at top"], ["bottom", "Banner at bottom"]], v("position", "top"), 'style="width:160px"')}
        <label class="muted">Colour</label><input id="c-bg" type="color" value="${esc(v("bg", "#2a78d6"))}" aria-label="Background colour"><input id="c-fg" type="color" value="${esc(v("fg", "#ffffff"))}" aria-label="Text colour"></div>
      <div class="field"><label for="c-title">Title (popup only)</label><input id="c-title" type="text" value="${esc(v("title"))}"></div>
      <div class="field"><label for="c-text">Message</label><input id="c-text" type="text" placeholder="Welcome back! Here's 10% off today." value="${esc(v("text"))}"></div>
      <div class="row"><input id="c-cta" type="text" style="width:170px" placeholder="Button text" value="${esc(v("cta_text"))}"><input id="c-cta-url" type="text" class="grow" placeholder="/offer or https://…" value="${esc(v("cta_url"))}"></div>
    </div>

    <div id="p-custom" style="display:none">
      <div class="grid g3" style="margin-bottom:10px">
        <div class="field" style="margin:0"><label for="c-display">Show it as</label>${sel("c-display", [["modal", "Popup (centered)"], ["slidein", "Slide-in (bottom-right)"], ["inline", "Inline inside the page"]], v("display", "modal"))}</div>
        <div class="field" style="margin:0"><label for="c-trigger">When</label>${sel("c-trigger", [["load", "Immediately on page load"], ["delay", "After a delay"], ["scroll", "After scrolling"], ["exit", "On exit intent (desktop)"]], v("trigger", "load"))}</div>
        <div class="field" style="margin:0" id="c-tv-wrap"><label for="c-tv" id="c-tv-label">Seconds</label><input id="c-tv" type="number" min="0" value="${esc(v("trigger_value", "5"))}"></div></div>
      <div class="row" id="c-inline-row" style="margin-bottom:10px;display:none"><input id="c-sel" type="text" class="grow" placeholder="CSS selector of where to put it, e.g. #newsletter-slot" value="${esc(v("selector"))}">
        ${sel("c-ins", [["replace", "Replace its contents"], ["append", "Add inside (end)"], ["prepend", "Add inside (start)"], ["before", "Insert before it"], ["after", "Insert after it"]], v("insert", "replace"), 'style="width:200px"')}</div>

      <div class="row" style="margin-bottom:6px"><span class="lbl2">Start from a template:</span>
        ${Object.entries(CUSTOM_TEMPLATES).map(([k, t]) => `<button class="btn sm" type="button" data-tpl="${k}">${esc(t.label)}</button>`).join("")}</div>
      <div class="tabs" role="tablist" style="margin-bottom:0"><button type="button" role="tab" data-ed="html" class="on">HTML</button><button type="button" role="tab" data-ed="css">CSS</button><button type="button" role="tab" data-ed="js">JavaScript</button>
        <span style="flex:1"></span><button type="button" class="btn sm" id="c-prev" style="align-self:center">▶ Preview form only</button></div>
      <textarea id="ed-html" class="code" spellcheck="false" rows="12" placeholder="<h3>Hello</h3>&#10;<form>…</form>&#10;<script src=&quot;https://…&quot;></script>">${esc(v("html"))}</textarea>
      <textarea id="ed-css" class="code" spellcheck="false" rows="12" style="display:none" placeholder="{{container}} { max-width: 480px; }">${esc(v("css"))}</textarea>
      <textarea id="ed-js" class="code" spellcheck="false" rows="12" style="display:none" placeholder="// runs after the HTML scripts have loaded">${esc(v("js"))}</textarea>
      <div class="muted" style="font-size:12.5px;margin-top:6px" id="ed-help"></div>
      <div id="c-preview-wrap" style="display:none;margin-top:10px"><div class="lbl2" style="margin-bottom:4px">Preview <span class="muted">(sandboxed; tracking, “show once” and your page's own CSS are not applied)</span></div>
        <iframe id="c-preview" sandbox="allow-scripts allow-forms allow-popups allow-modals" style="width:100%;height:360px;border:1px solid var(--border);border-radius:8px;background:#fff" title="Campaign preview"></iframe></div>
      <div class="callout warn" style="margin-top:10px;font-size:12.5px"><b>This code runs on your visitors' pages</b>, the same as a tag manager. Only paste code you trust. If your site sets a strict Content-Security-Policy, allow the form provider's domain (e.g. js.hsforms.net).</div>
    </div>
    <div id="p-visual" style="display:none">
      <div class="row"><input id="vz-url" type="text" class="grow" placeholder="https://yoursite.com/page" value="${esc(suggestPageUrl(site))}">
        <button class="btn primary" type="button" id="vz-open">✎ Open page in editor</button></div>
      <div class="muted" id="vz-msg" style="font-size:12.5px;margin:6px 0 10px">Your page opens with an editing toolbar. Click any text, image or button to change it (use <b>↑ Parent</b> to pick a whole banner), then press <b>Done</b>.
        Visitors never see the editor, only the changed page — and only if they match “Who should see it?” above.</div>
      <div class="lbl2">Changes <span class="muted" id="vz-count"></span></div><div id="vz-list"></div>
    </div>
    <div class="lbl2" style="margin:16px 0 6px">3 · Preview it on your page</div>
    <div class="row"><input id="pv-url" type="text" class="grow" placeholder="https://yoursite.com/page" value="${esc(suggestPageUrl(site))}">
      <button class="btn primary" type="button" id="pv-here">Show here</button><button class="btn" type="button" id="pv-new">Open in new tab</button>
      <div class="seg" role="group" aria-label="Preview size"><button type="button" data-pvw="desktop" class="on">Desktop</button><button type="button" data-pvw="mobile">Mobile</button></div></div>
    <div class="muted" style="font-size:12.5px;margin:6px 0">Shows your real page with this campaign on it, exactly as visitors will see it — ignoring the rules, “show once” and delays. Nothing is tracked. The snippet must be on that page. After editing, press <b>Refresh preview</b>.</div>
    <div id="pv-wrap" style="display:none"><div class="row" style="margin-bottom:6px"><button class="btn sm" type="button" id="pv-refresh">↻ Refresh preview</button>
        <span class="muted" style="font-size:12.5px">If the page stays blank, that site blocks being embedded — use “Open in new tab”.</span></div>
      <div id="pv-box" style="border:1px solid var(--border);border-radius:8px;overflow:hidden;background:#fff;margin:0 auto"><iframe id="pv-frame" name="ot_preview" title="Page preview" style="border:0;display:block;background:#fff"></iframe></div></div>
    <div id="c-err" class="bad" style="margin-top:10px"></div>`,
    { wide: true, footer: `<span class="muted" style="margin-right:auto">${existing ? "Changes go live within a minute for running campaigns." : "Saved as a draft — start it from the Personalization page."}</span><button class="btn" data-close>Cancel</button><button class="btn primary" id="c-save">${existing ? "Save changes" : "Create campaign"}</button>` });
  const el = m.el, g = id => $(id, el).value.trim();

  const HELP = {
    html: "Your markup. <b>&lt;script&gt;</b> tags (including external ones like HubSpot's loader) are executed, in order.",
    css: "Use <code>{{container}}</code> to target the box the campaign renders in, e.g. <code>{{container}} input { … }</code>.",
    js: "Runs after the HTML scripts load. Available: <code>container</code> (the box), <code>OT</code> (<code>OT.track('name')</code>), and <code>ctx.conversion()</code> / <code>ctx.close()</code>.",
  };
  const showEd = k => {
    ["html", "css", "js"].forEach(x => { $("#ed-" + x, el).style.display = x === k ? "" : "none"; });
    $$("[data-ed]", el).forEach(b => b.className = b.dataset.ed === k ? "on" : "");
    $("#ed-help", el).innerHTML = HELP[k];
  };
  const syncType = () => {
    const t = $("#c-type", el).value;
    $("#p-simple", el).style.display = t === "custom" || t === "visual" ? "none" : "";
    $("#p-custom", el).style.display = t === "custom" ? "" : "none";
    $("#p-visual", el).style.display = t === "visual" ? "" : "none";
    $("#c-pos", el).style.display = t === "banner" ? "" : "none";
    $("#c-title", el).closest(".field").style.display = t === "popup" ? "" : "none";
  };
  const syncCustom = () => {
    $("#c-inline-row", el).style.display = $("#c-display", el).value === "inline" ? "flex" : "none";
    const tr = $("#c-trigger", el).value;
    $("#c-tv-wrap", el).style.visibility = tr === "delay" || tr === "scroll" ? "visible" : "hidden";
    $("#c-tv-label", el).textContent = tr === "scroll" ? "Scroll depth (%)" : "Seconds";
  };
  $("#c-type", el).onchange = syncType; $("#c-display", el).onchange = syncCustom; $("#c-trigger", el).onchange = syncCustom;
  syncType(); syncCustom(); showEd("html");
  $$("[data-ed]", el).forEach(b => b.onclick = () => showEd(b.dataset.ed));
  $$("textarea.code", el).forEach(ta => {
    let escaped = false;   // Esc then Tab leaves the editor, so keyboard users are never trapped
    ta.addEventListener("keydown", e => {
      if (e.key === "Escape") { escaped = true; return; }
      if (e.key === "Tab" && !e.shiftKey && !escaped) {
        e.preventDefault();
        const s0 = ta.selectionStart, e0 = ta.selectionEnd;
        ta.value = ta.value.slice(0, s0) + "  " + ta.value.slice(e0);
        ta.selectionStart = ta.selectionEnd = s0 + 2;
      }
      if (e.key !== "Escape") escaped = false;
    });
  });
  $$("[data-tpl]", el).forEach(b => b.onclick = () => {
    const t = CUSTOM_TEMPLATES[b.dataset.tpl];
    if ((g("#ed-html") || g("#ed-css") || g("#ed-js")) && !confirmReplace()) return;
    $("#ed-html", el).value = t.html; $("#ed-css", el).value = t.css; $("#ed-js", el).value = t.js;
    if (!g("#c-name")) $("#c-name", el).value = t.label + " campaign";
    $("#c-preview-wrap", el).style.display = "none";
  });
  function confirmReplace() { return window.confirm("Replace the code in all three tabs with this template?"); }
  $("#c-preset3", el).onclick = () => {
    $("#c-f0", el).value = "visit_no"; $("#c-o0", el).value = "gte"; $("#c-v0", el).value = "3";
    $("#c-f1", el).value = ""; $("#c-v1", el).value = "";
    $("#c-freq", el).value = "once"; $("#c-match", el).value = "all";
    toast("Rule set: visit number ≥ 3, once per visitor");
  };
  $("#c-prev", el).onclick = () => {
    $("#c-preview-wrap", el).style.display = "";
    $("#c-preview", el).srcdoc = previewDoc($("#ed-html", el).value, $("#ed-css", el).value, $("#ed-js", el).value);
  };

  // ---- "Change the page": the real-page editor feeds EDITOR.changes; saved as one `change` action per edit
  EDITOR.siteId = site.id;
  EDITOR.changes = (existing && cfg.actions.every(a => a.type === "change"))
    ? cfg.actions.map(a => ({ selector: a.selector, action: a.action, value: a.value || "", attr: a.attr || "" })) : [];
  const describeChange = c => c.action === "attr" && c.attr === "src" ? "Replace image" : c.action === "attr" ? `Set ${c.attr}` : c.action === "css" && /background-image/.test(c.value) ? "Background image"
    : { text: "Change text", html: "Change HTML", css: "Change style", hide: "Hide element" }[c.action] || c.action;
  const renderVisual = () => {
    const list = $("#vz-list", el); if (!list) return;
    $("#vz-count", el).textContent = `(${EDITOR.changes.length})`;
    list.innerHTML = EDITOR.changes.length ? `<div class="table-wrap"><table><tbody>${EDITOR.changes.map((c, i) => `<tr><td class="nowrap"><b>${esc(describeChange(c))}</b></td>
      <td class="mono" style="word-break:break-all">${esc(c.selector)}</td><td style="word-break:break-all" class="muted">${esc((c.value || "").slice(0, 70))}</td>
      <td class="right"><button class="btn sm" type="button" data-vzrm="${i}">✕</button></td></tr>`).join("")}</tbody></table></div>`
      : `<div class="muted">No changes yet. Press “Open page in editor” and click something on your page.</div>`;
    $$("[data-vzrm]", el).forEach(b => b.onclick = () => { EDITOR.changes.splice(+b.dataset.vzrm, 1); renderVisual(); });
  };
  EDITOR.onChange = renderVisual; renderVisual();
  $("#vz-open", el).onclick = () => {
    let u;
    try { u = new URL($("#vz-url", el).value.trim()); if (!/^https?:$/.test(u.protocol)) throw 0; }
    catch { $("#vz-msg", el).textContent = "Enter the full page address, starting with http:// or https://"; return; }
    try { localStorage.setItem("ot_last_url_" + site.id, u.href); } catch { /* ignore */ }
    u.hash = "ot_editor";
    EDITOR.win = window.open(u.href, "ot_editor");
    $("#vz-msg", el).textContent = EDITOR.win ? "Editor opened in a new tab. Make your changes there and press “Done”; they appear below. If no toolbar shows, the Optimize snippet isn't installed on that page."
      : "Your browser blocked the popup — allow popups for this page and try again.";
  };

  const buildBody = () => {
    const rules = [0, 1].map(i => ({ field: g("#c-f" + i), op: g("#c-o" + i), value: g("#c-v" + i) })).filter(r => r.field);
    const type = g("#c-type");
    if (type === "visual") {
      return { name: g("#c-name"), url_contains: g("#c-url"), match: g("#c-match"), frequency: g("#c-freq"), rules,
        actions: EDITOR.changes.map(c => ({ type: "change", selector: c.selector, action: c.action, value: c.value, attr: c.attr || "" })) };
    }
    const action = type === "custom" ? {
      type, html: $("#ed-html", el).value, css: $("#ed-css", el).value, js: $("#ed-js", el).value,
      display: g("#c-display"), trigger: g("#c-trigger"), trigger_value: Math.max(0, parseInt($("#c-tv", el).value, 10) || 0),
      selector: g("#c-sel"), insert: g("#c-ins"),
    } : { type, text: g("#c-text"), title: g("#c-title"), cta_text: g("#c-cta"), cta_url: g("#c-cta-url"), position: g("#c-pos"), bg: $("#c-bg", el).value, fg: $("#c-fg", el).value };
    return { name: g("#c-name"), url_contains: g("#c-url"), match: g("#c-match"), frequency: g("#c-freq"), rules, actions: [action] };
  };

  // ---- preview on the real page (popup tab or embedded frame); the page asks for the config via postMessage
  const pvUrl = () => {
    try {
      const u = new URL($("#pv-url", el).value.trim());
      if (!/^https?:$/.test(u.protocol)) throw 0;
      try { localStorage.setItem("ot_last_url_" + site.id, u.href); } catch { /* ignore */ }
      u.hash = "ot_preview";
      return u.href;
    } catch { $("#c-err", el).textContent = "Enter the full page address to preview, starting with http:// or https://"; return null; }
  };
  const pvConfig = () => {
    const body = buildBody();
    if (existing) body.id = existing.id;
    if (!body.actions.length) { $("#c-err", el).textContent = "Make at least one change in the editor first."; return null; }
    if (body.actions[0].type === "custom" && !body.actions[0].html.trim() && !body.actions[0].js.trim()) { $("#c-err", el).textContent = "Add some HTML or JavaScript to preview."; return null; }
    if (!["custom", "change"].includes(body.actions[0].type) && !(body.actions[0].text || body.actions[0].title)) { $("#c-err", el).textContent = "Add a message to preview."; return null; }
    $("#c-err", el).textContent = "";
    return body;
  };
  PV.getConfig = pvConfig;
  const layoutPv = () => {
    const wrap = $("#pv-wrap", el), box = $("#pv-box", el), fr = $("#pv-frame", el);
    const mobile = $("[data-pvw].on", el).dataset.pvw === "mobile", avail = wrap.clientWidth || 700;
    if (mobile) { box.style.width = "390px"; box.style.height = "560px"; fr.style.width = "390px"; fr.style.height = "560px"; fr.style.transform = "none"; }
    else { const sc = Math.min(1, avail / 1280); box.style.width = "100%"; box.style.height = Math.round(560) + "px"; fr.style.width = "1280px"; fr.style.height = Math.round(560 / sc) + "px"; fr.style.transform = `scale(${sc})`; fr.style.transformOrigin = "0 0"; }
  };
  $$("[data-pvw]", el).forEach(b => b.onclick = () => { $$("[data-pvw]", el).forEach(x => x.className = ""); b.className = "on"; if ($("#pv-wrap", el).style.display !== "none") { layoutPv(); } });
  $("#pv-here", el).onclick = () => {
    const url = pvUrl(); if (!url || !pvConfig()) return;
    $("#pv-wrap", el).style.display = ""; layoutPv();
    PV.win = null; PV.frame = $("#pv-frame", el); PV.origin = new URL(url).origin;
    PV.frame.src = url;
    PV.frame.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  $("#pv-new", el).onclick = () => {
    const url = pvUrl(); if (!url || !pvConfig()) return;
    PV.frame = null; PV.win = window.open(url, "ot_preview");
    if (!PV.win) $("#c-err", el).textContent = "Your browser blocked the popup — allow popups and try again.";
  };
  $("#pv-refresh", el).onclick = () => {
    const cfg = pvConfig(); if (!cfg) return;
    const target = PV.frame && PV.frame.contentWindow;
    if (!target) return;
    // the page reloads itself and re-requests the latest config, so edits to HTML/CSS/JS always show
    try { target.postMessage({ type: "ot:preview", campaign: cfg }, PV.origin); } catch { /* ignore */ }
  };
  m.onClose = () => { if (PV.getConfig === pvConfig) { PV.getConfig = null; PV.frame = null; } if (EDITOR.onChange === renderVisual) EDITOR.onChange = null; };

  $("#c-save", el).onclick = async () => {
    const body = buildBody();
    if (!body.name) { $("#c-err", el).textContent = "Give the campaign a name."; return; }
    if (!body.actions.length) { $("#c-err", el).textContent = "Make at least one change in the editor first (Open page in editor)."; return; }
    try {
      if (existing) await api(`/api/campaigns/${existing.id}`, { method: "PUT", body });
      else await api(`/api/sites/${site.id}/campaigns`, { method: "POST", body });
      m.close(); toast(existing ? "Campaign updated" : "Campaign created as a draft — press Start when ready"); route();
    } catch (e) { $("#c-err", el).textContent = e.message; }
  };
}

// ---- page-preview bridge: state + the one listener that answers the page's "ready" ping
const PV = { win: null, frame: null, origin: "", getConfig: null };
window.addEventListener("message", e => {
  if (!PV.getConfig || !e.data || e.data.type !== "ot:pv:ready") return;
  const fromFrame = PV.frame && PV.frame.contentWindow && e.source === PV.frame.contentWindow;
  const fromWin = PV.win && e.source === PV.win;
  if (!fromFrame && !fromWin) return;                       // only the preview we started
  const cfg = PV.getConfig(); if (!cfg) return;
  try { e.source.postMessage({ type: "ot:preview", campaign: cfg }, e.origin); } catch { /* opaque origin */ }
});
function suggestPageUrl(site) {
  let last = "";
  try { last = localStorage.getItem("ot_last_url_" + site.id) || ""; } catch { /* ignore */ }
  if (site.domain === "localhost" || site.domain === location.hostname) return location.origin + "/site-demo?site=" + site.id;   // the bundled demo store
  return last || (site.domain ? "https://" + site.domain + "/" : "");
}

// ---------------------------------------------------------------- visitor journey drawer
async function openVisitor(site, vid) {
  const m = openModal("Visitor " + vid.slice(0, 8), `<div class="muted">Loading journey…</div>`, { drawer: true });
  try {
    const ev = await api(`/api/sites/${site.id}/visitors/${encodeURIComponent(vid)}/timeline`);
    const pv = ev.filter(e => e.type === "pageview").length, sessions = new Set(ev.map(e => e.session_id)).size;
    $(".modal-body", m.el).innerHTML = `<div class="grid g3" style="margin-bottom:14px">${kpi("Events", fmtNum(ev.length))}${kpi("Pageviews", fmtNum(pv))}${kpi("Visits", fmtNum(sessions))}</div>
      <ul class="timeline">${ev.map(e => { const [ic, txt] = describeEvent(e); return `<li><span class="ic">${ic}</span><span>${txt}</span><span class="tm">${clock(e.ts)}</span></li>`; }).join("")}</ul>
      ${ev.length >= 500 ? '<div class="muted">Showing the most recent 500 events.</div>' : ""}`;
  } catch (e) { $(".modal-body", m.el).innerHTML = `<div class="callout warn">${esc(e.message)}</div>`; }
}


// ---------------------------------------------------------------- heatmap overlay bridge
window.addEventListener("message", e => {
  if (!HM.win || e.source !== HM.win || !e.data || e.data.type !== "ot:hm:ready" || !HM.current) return;
  // reply to the origin the page is actually at; the payload is aggregate click/scroll counts only
  try { HM.win.postMessage({ type: "ot:hm", data: HM.current }, e.origin); } catch { /* opaque origin */ }
});

// ---------------------------------------------------------------- new funnel
async function openNewFunnel(site) {
  let paths = [];
  try { paths = (await api(`/api/sites/${site.id}/pages?days=90`)).map(p => p.path); } catch { /* optional */ }
  const types = [["page", "Visited a page"], ["click", "Clicked something"], ["event", "Custom event"], ["form", "Submitted a form"]];
  const hints = { page: "/pricing", click: "Add to cart", event: "purchase", form: "contact" };
  let steps = [{ type: "page", value: "", match: "contains" }, { type: "page", value: "", match: "contains" }];
  const m = openModal("New funnel", `
    <div class="field"><label for="f-name">Funnel name</label><input id="f-name" type="text" placeholder="Visit → signup"></div>
    <div class="lbl2" style="margin-bottom:6px">Steps (in order — visitors must do them in this sequence)</div>
    <div id="f-steps"></div>
    <div class="row" style="margin-top:8px"><button class="btn sm" id="f-add">＋ Add step</button>
      <button class="btn sm" id="f-ex">Use an example</button></div>
    <datalist id="f-paths">${paths.map(p => `<option value="${esc(p)}">`).join("")}</datalist>
    <div class="muted" style="font-size:12.5px;margin-top:10px">A “page” step matches the URL path (choose <i>is exactly</i> for the home page “/”). A “click” step matches the button or link text, e.g. “Add to cart”. An “event” is something you send with <code>OT.track('name')</code>.</div>
    <div id="f-err" class="bad" style="margin-top:10px"></div>`,
    { wide: true, footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="f-create">Create funnel</button>` });
  const el = m.el;
  const sync = () => $$("#f-steps .row", el).forEach((row, i) => {
    steps[i].type = $("[data-t]", row).value; steps[i].value = $("[data-v]", row).value.trim();
    const mt = $("[data-m]", row); if (mt) steps[i].match = mt.value;
  });
  const render = () => {
    $("#f-steps", el).innerHTML = steps.map((st, i) => `<div class="row" style="margin-bottom:8px"><span class="muted" style="width:18px">${i + 1}.</span>
      <select data-t style="width:170px">${types.map(([k, l]) => `<option value="${k}" ${st.type === k ? "selected" : ""}>${l}</option>`).join("")}</select>
      ${st.type === "page" ? `<select data-m style="width:120px"><option value="contains" ${st.match === "contains" ? "selected" : ""}>contains</option><option value="equals" ${st.match === "equals" ? "selected" : ""}>is exactly</option></select>` : ""}
      <input data-v type="text" class="grow" ${st.type === "page" ? 'list="f-paths"' : ""} placeholder="${esc(hints[st.type])}" value="${esc(st.value)}">
      <button class="btn sm" data-up="${i}" ${i ? "" : "disabled"} aria-label="Move up">↑</button><button class="btn sm" data-rm="${i}" ${steps.length > 2 ? "" : "disabled"} aria-label="Remove">✕</button></div>`).join("");
    $$("[data-t]", el).forEach(sel => sel.onchange = () => { sync(); render(); });
    $$("[data-up]", el).forEach(b => b.onclick = () => { sync(); const i = +b.dataset.up; [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; render(); });
    $$("[data-rm]", el).forEach(b => b.onclick = () => { sync(); steps.splice(+b.dataset.rm, 1); render(); });
  };
  render();
  $("#f-add", el).onclick = () => { sync(); if (steps.length < 8) { steps.push({ type: "page", value: "", match: "contains" }); render(); } };
  $("#f-ex", el).onclick = () => {
    $("#f-name", el).value = "Visit → pricing → purchase";
    steps = [{ type: "page", value: "/", match: "equals" }, { type: "page", value: "/pricing", match: "contains" }, { type: "event", value: "purchase", match: "contains" }];
    render();
  };
  $("#f-create", el).onclick = async () => {
    sync();
    const body = { name: $("#f-name", el).value.trim(), steps: steps.map(s => ({ type: s.type, value: s.value, match: s.match || "contains" })) };
    if (!body.name) { $("#f-err", el).textContent = "Give the funnel a name."; return; }
    if (body.steps.some(s => !s.value)) { $("#f-err", el).textContent = "Fill in every step."; return; }
    try { await api(`/api/sites/${site.id}/funnels`, { method: "POST", body }); m.close(); toast("Funnel created"); route(); }
    catch (e) { $("#f-err", el).textContent = e.message; }
  };
}


// ---------------------------------------------------------------- one-click demo site
async function createDemoSite(btn) {
  const label = btn.textContent; btn.disabled = true; btn.textContent = "Creating…";
  try {
    const d = await api("/api/demo-site", { method: "POST" });
    await loadSites();
    const url = location.origin + d.demo_url;
    const m = openModal(d.created ? "Demo site created" : "Your demo site", `
      <p style="margin-top:0">${d.created ? "Aurora Coffee (demo) is ready, with these already running:" : "You already have the demo site. It has:"}</p>
      <ul style="margin:0 0 14px;padding-left:20px"><li><b>3rd-visit signup form</b> — a popup form shown on a visitor's 3rd visit</li>
        <li><b>Welcome-back banner</b> — for returning visitors</li><li><b>Funnel</b> — visit → add to cart → join the club</li></ul>
      <div class="callout"><b>Visitors never see any counters or controls.</b> To <i>test</i> the 3rd-visit form yourself, open the store <b>with test controls</b>:
        a small “Demo controls” box appears (only because of <code>&amp;controls=1</code> in the link). Press <b>Simulate next visit</b> twice; on visit #3 the form pops up after ~2 seconds.</div>
      <div class="row" style="margin-top:14px"><a class="btn primary" href="${esc(url)}&controls=1" target="_blank" rel="noopener">Open demo store with test controls ↗</a>
        <a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open as a normal visitor ↗</a>
        <button class="btn" id="demo-go">Go to the dashboard</button></div>`);
    $("#demo-go", m.el).onclick = () => { m.close(); location.hash = `#/site/${d.id}/overview`; };
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.textContent = label; }
}
