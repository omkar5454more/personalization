/* Optimize visual editor. Loaded by sdk.js only when the page was opened from the
 * dashboard (window.opener present + #ot_editor / window.name marker). Everything
 * UI-related lives in a shadow root so the host site's CSS can't leak in or out. */
(function () {
  "use strict";
  if (window.__otEditor) return;
  window.__otEditor = true;

  var ORIGIN = new URL(document.currentScript.src).origin;
  var opener = window.opener;
  var entries = []; // {change, undo}
  var selected = null, hovered = null, handshakeDone = false;

  // ---------------------------------------------------------------- selectors
  function esc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^\w-]/g, "\\$&"); }
  function stableClass(c) {
    return /^[a-zA-Z][\w-]{0,30}$/.test(c) && !/\d{3,}/.test(c) && !/^(css-|sc-|jsx-|_|ot-)/.test(c);
  }
  function count(sel) { try { return document.querySelectorAll(sel).length; } catch (e) { return 0; } }
  function part(el) {
    if (el.id && !/\d{4,}/.test(el.id) && count("#" + esc(el.id)) === 1) return { s: "#" + esc(el.id), anchored: true };
    var tag = el.tagName.toLowerCase();
    var cls = Array.prototype.filter.call(el.classList, stableClass).slice(0, 2);
    var s = tag + cls.map(function (c) { return "." + esc(c); }).join("");
    var p = el.parentElement;
    if (p) {
      var same = Array.prototype.filter.call(p.children, function (x) { return x.matches(s); });
      if (same.length > 1) {
        var typed = Array.prototype.filter.call(p.children, function (x) { return x.tagName === el.tagName; });
        s += ":nth-of-type(" + (typed.indexOf(el) + 1) + ")";
      }
    }
    return { s: s };
  }
  function selectorFor(el) {
    var parts = [], cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      var p = part(cur);
      parts.unshift(p.s);
      var full = parts.join(" > ");
      if (p.anchored || count(full) === 1) return full;
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  // ---------------------------------------------------------------- applying edits (with undo)
  function applyEdit(c) {
    var nodes;
    try { nodes = document.querySelectorAll(c.selector); } catch (e) { return function () {}; }
    var undos = [];
    Array.prototype.forEach.call(nodes, function (n) {
      var html = n.innerHTML, style = n.getAttribute("style"), attr = c.attr ? n.getAttribute(c.attr) : null;
      if (c.action === "text") n.textContent = c.value;
      else if (c.action === "html") n.innerHTML = c.value;
      else if (c.action === "css") n.style.cssText += ";" + c.value;
      else if (c.action === "attr" && c.attr) n.setAttribute(c.attr, c.value);
      else if (c.action === "hide") n.style.display = "none";
      undos.push(function () {
        n.innerHTML = html;
        if (style === null) n.removeAttribute("style"); else n.setAttribute("style", style);
        if (c.attr) { if (attr === null) n.removeAttribute(c.attr); else n.setAttribute(c.attr, attr); }
      });
    });
    return function () { undos.slice().reverse().forEach(function (u) { u(); }); };
  }
  function addChange(c) {
    entries.push({ change: c, undo: applyEdit(c) });
    sync(); renderList(); positionBoxes();
  }
  function removeEntry(i) {
    var e = entries.splice(i, 1)[0];
    if (e) e.undo();
    sync(); renderList(); positionBoxes();
  }
  function sync() {
    if (!opener || opener.closed) return;
    opener.postMessage({ type: "ot:changes", changes: entries.map(function (e) { return e.change; }) }, ORIGIN);
  }

  // ---------------------------------------------------------------- UI (shadow root)
  var host = document.createElement("div");
  host.id = "ot-editor-root";
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  var root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}*{box-sizing:border-box;font:13px/1.4 system-ui,sans-serif}' +
    '.box{position:fixed;pointer-events:none;border-radius:2px;display:none}' +
    '#hov{border:2px dashed #6366f1;background:rgba(99,102,241,.08)}' +
    '#sel{border:2px solid #f59e0b;background:rgba(245,158,11,.10)}' +
    '#bar{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);pointer-events:auto;background:#111827;color:#fff;border-radius:10px;padding:8px 12px;display:flex;gap:8px;align-items:center;box-shadow:0 6px 24px rgba(0,0,0,.35)}' +
    '#panel{position:fixed;right:12px;top:12px;width:300px;max-height:calc(100vh - 84px);overflow:auto;pointer-events:auto;background:#fff;color:#111;border:1px solid #d1d5db;border-radius:10px;padding:12px;box-shadow:0 6px 24px rgba(0,0,0,.25);display:none}' +
    'button{cursor:pointer;border:1px solid #d1d5db;background:#f3f4f6;color:#111;border-radius:6px;padding:4px 10px}' +
    'button.pri{background:#4f46e5;border-color:#4f46e5;color:#fff}#bar button{background:#374151;border-color:#4b5563;color:#fff}#bar button.pri{background:#4f46e5}' +
    'label{display:block;margin:8px 0 2px;color:#6b7280;font-size:12px}textarea,input[type=text],input[type=number]{width:100%;border:1px solid #d1d5db;border-radius:6px;padding:5px 8px}' +
    'textarea{min-height:54px;resize:vertical}code{font:12px ui-monospace,monospace;word-break:break-all;background:#f3f4f6;padding:1px 4px;border-radius:4px}' +
    '.row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.warn{color:#b45309;font-size:12px}.muted{color:#6b7280;font-size:12px}' +
    'ul{margin:6px 0 0;padding:0;list-style:none}li{display:flex;gap:6px;align-items:center;justify-content:space-between;border-top:1px solid #eee;padding:4px 0;font-size:12px}' +
    'details{margin-top:8px}hr{border:0;border-top:1px solid #e5e7eb;margin:10px 0}' +
    '</style>' +
    '<div id="hov" class="box"></div><div id="sel" class="box"></div>' +
    '<div id="panel"></div>' +
    '<div id="bar"><b>Visual editor</b><span id="hint">Click any element to edit it</span>' +
    '<button id="undo">Undo last</button><button id="done" class="pri">Done &mdash; send to dashboard</button><button id="exit">Exit</button></div>';
  document.documentElement.appendChild(host);
  var $ = function (s) { return root.querySelector(s); };

  function rectOf(el, box) {
    if (!el || !el.isConnected) { box.style.display = "none"; return; }
    var r = el.getBoundingClientRect();
    box.style.cssText = "display:block;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px";
  }
  function positionBoxes() { rectOf(hovered, $("#hov")); rectOf(selected, $("#sel")); }

  function hasElementChildren(el) { return el.children && el.children.length > 0; }

  function renderPanel() {
    var p = $("#panel");
    if (!selected) { p.style.display = "none"; return; }
    var sel = selectorFor(selected), n = count(sel);
    var cs = getComputedStyle(selected);
    var isLink = selected.tagName === "A";
    p.style.display = "block";
    p.innerHTML =
      '<div class="row"><b>&lt;' + selected.tagName.toLowerCase() + '&gt;</b>' +
      '<button id="up" title="Select parent">&uarr; Parent</button><button id="down" title="Select first child">&darr; Child</button>' +
      '<button id="close" style="margin-left:auto">&times;</button></div>' +
      '<div style="margin-top:6px"><code id="selTxt"></code></div>' +
      (n !== 1 ? '<div class="warn">This selector matches ' + n + ' elements; the change applies to all of them.</div>' : '') +
      '<hr><label>Text</label><textarea id="f-text"></textarea>' +
      (hasElementChildren(selected) ? '<div class="warn">This element has child elements; replacing its text removes them. Select a child instead, or use Parent/Child.</div>' : '') +
      '<div class="row" style="margin-top:6px"><button id="a-text" class="pri">Apply text</button></div>' +
      '<hr><div class="row"><div><label>Text colour</label><input id="f-color" type="color"></div>' +
      '<div><label>Background</label><input id="f-bg" type="color"></div>' +
      '<div style="width:80px"><label>Size (px)</label><input id="f-size" type="number" min="8" max="120"></div></div>' +
      '<div class="row" style="margin-top:6px"><button id="a-style" class="pri">Apply style</button><button id="a-hide">Hide element</button></div>' +
      (isLink ? '<hr><label>Link URL</label><input id="f-href" type="text"><div class="row" style="margin-top:6px"><button id="a-href" class="pri">Apply link</button></div>' : '') +
      '<details><summary>Edit HTML</summary><textarea id="f-html"></textarea><div class="row" style="margin-top:6px"><button id="a-html">Apply HTML</button></div></details>' +
      '<hr><b>Changes (<span id="cnt"></span>)</b><ul id="list"></ul>';
    $("#selTxt").textContent = sel;
    $("#f-text").value = selected.textContent.trim().slice(0, 2000);
    $("#f-html").value = selected.innerHTML.slice(0, 5000);
    if (isLink) $("#f-href").value = selected.getAttribute("href") || "";
    var hex = function (rgb) {
      var m = rgb.match(/\d+/g); if (!m) return "#000000";
      return "#" + m.slice(0, 3).map(function (x) { return ("0" + (+x).toString(16)).slice(-2); }).join("");
    };
    $("#f-color").value = hex(cs.color);
    $("#f-bg").value = cs.backgroundColor === "rgba(0, 0, 0, 0)" ? "#ffffff" : hex(cs.backgroundColor);
    $("#f-size").value = parseInt(cs.fontSize, 10) || "";
    var dirty = {};
    ["f-color", "f-bg", "f-size"].forEach(function (id) { $("#" + id).addEventListener("input", function () { dirty[id] = true; }); });

    $("#up").onclick = function () { if (selected.parentElement && selected.parentElement !== document.documentElement) select(selected.parentElement); };
    $("#down").onclick = function () { if (selected.children[0]) select(selected.children[0]); };
    $("#close").onclick = function () { select(null); };
    $("#a-text").onclick = function () {
      var v = $("#f-text").value;
      if (v !== selected.textContent.trim()) addChange({ selector: sel, action: "text", value: v, attr: "" });
      select(selected);
    };
    $("#a-html").onclick = function () {
      var v = $("#f-html").value;
      if (v !== selected.innerHTML) addChange({ selector: sel, action: "html", value: v, attr: "" });
      select(selected);
    };
    $("#a-style").onclick = function () {
      var css = [];
      if (dirty["f-color"]) css.push("color:" + $("#f-color").value);
      if (dirty["f-bg"]) css.push("background-color:" + $("#f-bg").value);
      if (dirty["f-size"] && +$("#f-size").value) css.push("font-size:" + (+$("#f-size").value) + "px");
      if (css.length) addChange({ selector: sel, action: "css", value: css.join(";") + ";", attr: "" });
      select(selected);
    };
    $("#a-hide").onclick = function () { addChange({ selector: sel, action: "hide", value: "", attr: "" }); select(null); };
    if (isLink) $("#a-href").onclick = function () {
      var v = $("#f-href").value.trim();
      if (v && !/^(https?:\/\/|\/|#|mailto:|tel:)/i.test(v)) { $("#hint").textContent = "Link must start with http(s)://, /, #, mailto: or tel:"; return; }
      addChange({ selector: sel, action: "attr", value: v, attr: "href" });
      select(selected);
    };
    renderList();
  }
  function renderList() {
    var ul = root.querySelector("#list"), cnt = root.querySelector("#cnt");
    if (cnt) cnt.textContent = entries.length;
    if (!ul) return;
    ul.innerHTML = "";
    entries.forEach(function (e, i) {
      var li = document.createElement("li");
      var t = document.createElement("span");
      t.textContent = e.change.action + (e.change.attr ? ":" + e.change.attr : "") + " → " + e.change.selector;
      t.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:210px";
      t.title = t.textContent;
      var b = document.createElement("button"); b.textContent = "×";
      b.onclick = function () { removeEntry(i); };
      li.appendChild(t); li.appendChild(b); ul.appendChild(li);
    });
  }
  function select(el) {
    selected = el;
    $("#hint").textContent = el ? "Editing selected element" : "Click any element to edit it";
    renderPanel(); positionBoxes();
  }

  // ---------------------------------------------------------------- page event capture
  function inEditor(e) { return e.composedPath && e.composedPath().indexOf(host) !== -1; }
  var blocked = ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "submit", "auxclick"];
  function onBlock(e) {
    if (inEditor(e)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.type === "click" && e.target instanceof Element) select(e.target);
  }
  function onMove(e) {
    if (inEditor(e) || !(e.target instanceof Element)) { hovered = null; positionBoxes(); return; }
    hovered = e.target === document.documentElement ? null : e.target;
    positionBoxes();
  }
  function onKey(e) { if (e.key === "Escape" && selected) select(null); }
  blocked.forEach(function (t) { window.addEventListener(t, onBlock, true); });
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", positionBoxes, true);
  window.addEventListener("resize", positionBoxes);

  $("#undo").onclick = function () { if (entries.length) removeEntry(entries.length - 1); };
  $("#done").onclick = function () { sync(); $("#hint").textContent = "Sent. You can close this tab and return to the dashboard."; };
  $("#exit").onclick = function () {
    blocked.forEach(function (t) { window.removeEventListener(t, onBlock, true); });
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", positionBoxes, true);
    window.removeEventListener("resize", positionBoxes);
    host.remove(); window.__otEditor = false;
  };

  // ---------------------------------------------------------------- handshake with the dashboard
  var VALID_ACTIONS = { text: 1, html: 1, css: 1, attr: 1, hide: 1 };
  window.addEventListener("message", function (e) {
    // Only trust the dashboard window that opened us, at the tool's own origin.
    if (e.source !== opener || e.origin !== ORIGIN) return;
    var m = e.data;
    if (!m || m.type !== "ot:init" || handshakeDone || !Array.isArray(m.changes)) return;
    handshakeDone = true;
    m.changes.slice(0, 200).forEach(function (c) {
      if (c && typeof c.selector === "string" && VALID_ACTIONS[c.action]) {
        entries.push({ change: { selector: c.selector, action: c.action, value: String(c.value || ""), attr: String(c.attr || "") }, undo: applyEdit(c) });
      }
    });
    renderList(); positionBoxes();
  });
  var tries = 0;
  (function ready() {
    if (handshakeDone || tries++ > 10 || !opener || opener.closed) return;
    opener.postMessage({ type: "ot:ready" }, ORIGIN);
    setTimeout(ready, 1000);
  })();
})();
