# Optimize (working name)

Snippet-based website optimisation: visitor tracking, A/B testing with a visual editor, rule-based
personalization (banners, popups, custom HTML/CSS/JS forms), heatmaps, funnels and behaviour analytics.
Paste one snippet in a site's `<head>`.

## Project layout
```
public/        static site, served by Vercel's CDN (and by FastAPI locally)
  index.html + app/*        dashboard (vanilla JS)
  sdk.js editor.js heatmap.js   the script customers install, visual editor, heatmap overlay
  site-demo.html demo.html demo-assets/   "Aurora Coffee" demo store + minimal test page
backend/       FastAPI app (main.py, analytics.py) and the storage layer (database.py)
api/index.py   Vercel serverless entry point
vercel.json    routing: static files first, API paths -> the function
scripts/check_db.py   verifies your Turso credentials before deploying
```

## Run locally (SQLite file, zero setup)
    python -m venv .venv
    .venv\Scripts\pip install -r requirements-dev.txt
    .venv\Scripts\python -m uvicorn backend.main:app --port 8010
    http://127.0.0.1:8010                              dashboard (create an account on first visit)
    http://127.0.0.1:8010/site-demo?site=<SITE_ID>     Aurora Coffee demo store (demo controls simulate the 2nd/3rd visit)

## Deploy to Vercel (Hobby works for personal/testing use)
Vercel functions have no persistent disk, so production uses **Turso** (hosted SQLite/libSQL). The SQL is unchanged.

1. **Turso**: sign up at turso.tech -> Create database (pick the region closest to your Vercel region) ->
   copy the database URL (`libsql://...`) and generate an auth token.
   (CLI: `turso db create optimize`, `turso db show optimize --url`, `turso db tokens create optimize`.)
2. *(optional)* test the credentials from your machine:
   `$env:TURSO_DATABASE_URL="libsql://..."; $env:TURSO_AUTH_TOKEN="..."; .venv\Scripts\python scripts\check_db.py`
3. **Vercel**: Add New -> Project -> import this GitHub repo. Framework preset **Other**; leave build command and
   output directory empty. Add environment variables:
   - `TURSO_DATABASE_URL`  - `TURSO_AUTH_TOKEN`
   Deploy. Tables are created automatically on the first request.
4. Open the deployed URL, **create your account**, then set `ALLOW_SIGNUPS=0` in Vercel (Settings -> Environment
   Variables) and redeploy, so strangers cannot register on your public URL.
5. Add a site, open *Install & settings*, copy the snippet (it uses your Vercel URL) into your website's `<head>`.
   Turn on *Only accept events from my domain* once the site's domain is set.

Notes
- Vercel **Hobby is for personal, non-commercial use**; client work or a company product needs Pro.
- Static files (dashboard, `sdk.js`, ...) come from the CDN and don't count as function calls. Each visitor page view costs
  roughly one `/collect` call; `/sdk/<id>.json` is cached for 60 s at the CDN. Check Vercel's and Turso's current free limits.
- Cookies are `Secure` automatically on Vercel. Geo rules (`country`) work on Vercel (it sends `x-vercel-ip-country`).
- Functions run for at most 30 s (`vercel.json`); funnels scan at most 150k events per request.

## Dashboard map (left sidebar)
- All sites        every connected site: connection status, 7-day traffic, running tests/campaigns
- Overview         visitors, sessions, pageviews, avg time, scroll depth, new vs returning, sources, devices
- A/B tests        create (visual editor), start/pause, results with significance
- Personalization  campaigns by rule (returning, visit no., UTM, device, country, hour...). Content can be a banner,
                   a popup, or **Custom code**: an HTML / CSS / JS editor with templates (HubSpot, Typeform,
                   Google Forms, Mailchimp/pasted form, plain form), sandboxed preview, display as popup /
                   slide-in / inline at a CSS selector, and triggers (immediately, delay, scroll %, exit intent).
                   Campaigns can be edited after creation. Impressions, interactions and form conversions are counted.
- Behavior         pages, clicks (+rage clicks), scroll depth, forms (start vs submit)
- Heatmaps         click heatmap + scroll map per page and device; schematic in the dashboard, or painted over
                   your real page via "Open page with heatmap" (SDK opens in overlay mode, no tracking)
- Funnels          ordered multi-step funnels (page / click / event / form steps): drop-off per step,
                   median time between steps, new vs returning, biggest drop-off highlighted
- Visitors         per-visitor journey timeline
- Live feed        events as they arrive (5s refresh)
- Install & settings   snippet, connection check, tracking toggles, consent mode, origin restriction

## Custom-code campaigns (forms)
- HTML: markup plus `<script>` tags (external scripts load in order, then run). CSS: use `{{container}}` for the box.
  JS: runs after the HTML scripts; gets `container`, `OT` (`OT.track`) and `ctx` (`ctx.conversion()`, `ctx.close()`).
- Conversions: native `<form>` submits and HubSpot's `onFormSubmitted` message are counted automatically; for others call
  `ctx.conversion()` (templates show how for Typeform and Google Forms).
- "3rd visit": rule `Visit number >= 3` + `Show once per visitor` (the editor has a preset). A visit = a new session
  (30 min after the last page view).
- Preview on the real page: in the campaign dialog (section 3) press "Show here" (embedded, Desktop/Mobile) or
  "Open in new tab". The page's SDK enters preview mode (`#ot_preview`), renders the unsaved campaign ignoring rules,
  frequency and delays, tracks nothing, and "Refresh preview" re-renders after edits. Sites that block framing need
  "Open in new tab".
- Trust model: this code runs on your visitors' pages, like a tag manager; only paste code you trust. A strict site CSP must
  allow the form provider's domain. Exit-intent is desktop-only.

## Auto-tracked by the SDK (toggle per site)
pageviews (incl. SPA route changes), clicks, rage clicks, scroll depth 25/50/75/100, active time on page,
form start/submit (names only, never values), outbound/download links, custom events `OT.track('name')`.
Elements inside `[data-ot-ignore]` are skipped. Click labels that look like emails/long numbers are dropped.

## Privacy
One first-party cookie `_ot` (1 year) mirrored in localStorage. No IP stored. With "Require consent" on,
nothing is stored/sent until `OT.consent(true)`; `OT.consent(false)` deletes the cookie.

## Known limits (before real clients)
- Auth is email+password with server-side sessions (PBKDF2, httpOnly cookie, DB-backed login throttling). No password
  reset, email verification, teams/roles.
- `/collect` is public by design (it receives browser events). Protections: 200 KB body cap, optional Origin check
  (best-effort: a non-browser client can forge the header). No bot filtering or per-site rate limit yet.
- Stats are a fixed-horizon z-test (no peeking correction / SRM check).
- Experiments are evaluated on full page loads; SPA route changes re-run campaigns and tracking only.
- Visual editor / heatmap overlay / page preview: need the snippet on the target page; fail on sites with COOP same-origin
  or a CSP blocking the script; no iframe/shadow-DOM editing.
- Time-on-page counts only visible, recently-active time (background tabs count 0 by design).
- Heatmap click positions are stored as % of page width and px from the top, so layouts that shift between screen sizes are
  approximate (filter by device).
- Funnels are computed on read from raw events (fine for MVP volumes; pre-aggregate for large sites). The dashboard makes
  several database round-trips per page; with a hosted database expect ~100-400 ms page loads.
- No session recordings or data export yet.
- `python seed_demo_data.py` adds 60 SYNTHETIC visitors to the local test site (`--remove` deletes them).
