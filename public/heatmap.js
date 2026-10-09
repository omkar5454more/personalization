/* Heatmap renderer + live-page overlay.
 *
 * Two uses:
 *  - the dashboard loads this as a normal script and calls OTHeat.draw / OTHeat.drawScroll to paint
 *    a schematic map on its own canvas;
 *  - sdk.js injects it with data-overlay="1" when a page is opened from the dashboard's
 *    "Overlay on live page" button, and it paints the same data over the real page.
 */
(function () {
  "use strict";

  // blue -> cyan -> green -> yellow -> red
  var STOPS = [[0, 0, 255], [0, 255, 255], [0, 255, 0], [255, 255, 0], [255, 0, 0]];
  function color(t) {
    t = Math.max(0, Math.min(1, t)) * (STOPS.length - 1);
    var i = Math.min(STOPS.length - 2, Math.floor(t)), f = t - i, a = STOPS[i], b = STOPS[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  var PAL = []; (function () { for (var i = 0; i < 256; i++) PAL.push(color(i / 255)); })();

  /** bins: [[bx, by, n], ...]; o: {binX (% per bin), binY (px per bin), srcH (recorded page height px), W, H (canvas css px)} */
  function draw(canvas, bins, o) {
    var W = Math.round(o.W), H = Math.round(o.H);
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    if (!bins || !bins.length) return;
    var maxN = 1;
    bins.forEach(function (b) { if (b[2] > maxN) maxN = b[2]; });
    var r = Math.max(14, W * 0.022);
    // 1) accumulate intensity in the alpha channel
    bins.forEach(function (b) {
      var x = (b[0] + 0.5) * o.binX / 100 * W, y = (b[1] + 0.5) * o.binY / o.srcH * H;
      var a = Math.max(0.12, Math.min(1, b[2] / maxN));
      var g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(0,0,0," + a + ")"); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    });
    // 2) colourise by that intensity
    var img = ctx.getImageData(0, 0, W, H), d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      var a2 = d[i + 3];
      if (!a2) continue;
      var c = PAL[a2];
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = Math.min(235, a2 * 1.25);
    }
    ctx.putImageData(img, 0, 0);
  }

  /** curve: [{depth, share}] share = fraction of visitors who scrolled at least that far (0..1) */
  function drawScroll(canvas, curve, o) {
    var W = Math.round(o.W), H = Math.round(o.H);
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    if (!curve || !curve.length) return;
    var shareAt = function (pct) {
      for (var i = 0; i < curve.length - 1; i++) {
        if (pct <= curve[i + 1].depth) {
          var a = curve[i], b = curve[i + 1], f = (pct - a.depth) / ((b.depth - a.depth) || 1);
          return a.share + (b.share - a.share) * f;
        }
      }
      return curve[curve.length - 1].share;
    };
    // adjacent strips must not overlap, or the semi-transparent fill double-darkens into visible bands
    var step = 2;
    for (var y = 0; y < H; y += step) {
      var c = PAL[Math.round(shareAt(y / H * 100) * 255)];
      ctx.fillStyle = "rgba(" + Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]) + ",0.45)";
      ctx.fillRect(0, y, W, Math.min(step, H - y));
    }
  }
  window.OTHeat = { draw: draw, drawScroll: drawScroll };

  // ------------------------------------------------------------------ live-page overlay
  var me = document.currentScript;
  if (!me || me.getAttribute("data-overlay") !== "1" || !window.opener) return;
  var ORIGIN = new URL(me.src).origin, opener = window.opener;
  var data = null, mode = "click", layer = null, canvas = null, resizeT = null;

  var host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  var root = host.attachShadow({ mode: "open" });
  root.innerHTML = '<style>*{box-sizing:border-box;font:13px/1.4 system-ui,sans-serif}' +
    '#bar{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);pointer-events:auto;background:#111827;color:#fff;border-radius:10px;padding:8px 12px;display:flex;gap:8px;align-items:center;box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:96vw;flex-wrap:wrap}' +
    'button{cursor:pointer;border:1px solid #4b5563;background:#374151;color:#fff;border-radius:6px;padding:4px 10px}button.on{background:#4f46e5;border-color:#4f46e5}.m{color:#9ca3af}</style>' +
    '<div id="bar"><b>Heatmap</b><span class="m" id="info">Waiting for data from the dashboard…</span>' +
    '<button id="m-click" class="on">Click map</button><button id="m-scroll">Scroll map</button><button id="m-off">Hide</button><button id="m-exit">Exit</button></div>';
  document.documentElement.appendChild(host);
  var $ = function (s) { return root.querySelector(s); };

  function docSize() {
    var de = document.documentElement, b = document.body;
    // clientWidth excludes the vertical scrollbar; innerWidth would make the overlay wider than the page
    return { w: Math.max(de.scrollWidth, de.clientWidth), h: Math.max(de.scrollHeight, b ? b.scrollHeight : 0) };
  }
  function render() {
    if (layer) { layer.remove(); layer = null; }
    if (!data || mode === "off") return;
    var s = docSize();
    layer = document.createElement("div");
    layer.style.cssText = "position:absolute;left:0;top:0;width:" + s.w + "px;height:" + s.h + "px;pointer-events:none;z-index:2147483000";
    canvas = document.createElement("canvas");
    canvas.style.cssText = "width:100%;height:100%;display:block";
    layer.appendChild(canvas);
    document.documentElement.appendChild(layer);
    // cap backing-store size so very long pages stay responsive
    var k = Math.min(1, 6e6 / (s.w * s.h));
    var o = { W: s.w * k, H: s.h * k, binX: data.bin_x, binY: data.bin_y, srcH: data.dh };
    if (mode === "click") draw(canvas, data.bins, o); else drawScroll(canvas, data.scroll, o);
    $("#info").textContent = (mode === "click" ? data.clicks + " clicks" : "Scroll reach") + " · " + data.pageviews + " views · " + (data.device || "all devices") + " · positions are approximate if your window size differs";
  }
  function setMode(m) {
    mode = m;
    ["click", "scroll", "off"].forEach(function (k) { $("#m-" + k).className = k === m ? "on" : ""; });
    render();
  }
  $("#m-click").onclick = function () { setMode("click"); };
  $("#m-scroll").onclick = function () { setMode("scroll"); };
  $("#m-off").onclick = function () { setMode("off"); };
  $("#m-exit").onclick = function () { if (layer) layer.remove(); host.remove(); };
  window.addEventListener("resize", function () { clearTimeout(resizeT); resizeT = setTimeout(render, 250); });

  window.addEventListener("message", function (e) {
    if (e.source !== opener || e.origin !== ORIGIN) return; // only the dashboard that opened us
    var m = e.data;
    if (!m || m.type !== "ot:hm" || !m.data || !Array.isArray(m.data.bins)) return;
    data = m.data; render();
  });
  var tries = 0;
  (function ready() {
    if (data || tries++ > 10 || opener.closed) return;
    opener.postMessage({ type: "ot:hm:ready" }, ORIGIN);
    setTimeout(ready, 1000);
  })();
})();
