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
    http://127.0.0.1:8010/site-demo?site=<SITE_ID>     Aurora Coffee demo store (add &controls=1 for a test-only box that simulates the 2nd/3rd visit; visitors never see it)

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
  roughly one `/collect` call; `/sdk/<id>.json` is cached for about 20 s at the CDN (dashboard changes show on the site within ~half a minute); `sdk.js` itself for about 5 minutes. Check Vercel's and Turso's current free limits.
- Cookies are `Secure` automatically on Vercel. Geo rules (`country`) work on Vercel (it sends `x-vercel-ip-country`).
- Functions run for at most 30 s (`vercel.json`); funnels scan at most 150k events per request.

## Dashboard map (left sidebar)
- All sites        every connected site: connection status, 7-day traffic, running tests/campaigns
- Overview         visitors, sessions, pageviews, avg time, scroll depth, new vs returning, sources, devices
- A/B tests        create with the visual editor: two or more versions (A/B/C...), traffic split per version, optional audience,
                   a saved goal (plus extra goals measured alongside), split-URL redirects. Results show 95% ranges, uplift,
                   Bayesian "beats original" %, Bonferroni-corrected p-values, a sample-ratio-mismatch warning, how many visitors are
                   still needed, and a plain-language recommendation. Optional: finish automatically when there is a clear winner
                   (enough visitors and days, strong evidence, healthy split) and keep serving the winner to everyone.
- Personalization  campaigns by rule (returning, visit no., UTM, device, country, hour...). Content can be a banner,
                   a popup, or **Custom code**: an HTML / CSS / JS editor with templates (HubSpot, Typeform,
                   Google Forms, Mailchimp/pasted form, plain form), sandboxed preview, display as popup /
                   slide-in / inline at a CSS selector, and triggers (immediately, delay, scroll %, exit intent).
                   Campaigns can be edited after creation. Impressions, interactions and form conversions are counted.
- Personalization also has **Change the page**: open your real page in the visual editor, click any text / image / button
                   (replace an image URL, set a background image, edit text/links, hide things) and show those changes only to the
                   audience you choose (e.g. returning visitors). Visitors never see the editor or any visit counters.
                   **Image upload:** in the editor, ⬆ Upload sends a file (PNG/JPG/WebP/GIF, resized to max 1600 px, <= 2 MB) to the
                   dashboard, which stores it in the database and returns a public `/img/<id>` link that is applied for you.
- Audiences        save "who" once -- a set of targeting rules (returning, device, OS, browser, language, country, UTM, referrer site,
                   search keyword, landing page, pages viewed this visit, "has done event X", plus your own data via
                   `OT.identify({plan:"pro"})`) -- and reuse it in campaigns and A/B tests. Edit it once, everything follows.
- Goals            one definition of a conversion (click / page / custom event / form, optional value, once or every time). Every
                   goal is tracked site-wide; the page shows conversions, people, rate, value, a trend and what converting visitors
                   had been shown (campaigns and test versions, "shown vs not shown" lift -- a hint, not proof).
- Behavior         pages, clicks (+rage clicks), scroll depth, forms (start vs submit)
- Heatmaps         click heatmap + scroll map per page and device; schematic in the dashboard, or painted over
                   your real page via "Open page with heatmap" (SDK opens in overlay mode, no tracking)
- Funnels          ordered multi-step funnels (page / click / event / form steps): drop-off per step,
                   median time between steps, new vs returning, biggest drop-off highlighted
- Visitors         per-visitor journey timeline
- Live feed        events as they arrive (5s refresh)
- Install & settings   snippet, connection check, tracking toggles, consent mode, origin restriction

## Targeting facts and visitor data
Rules run in the visitor's browser (`public/sdk.js` `context()`), so no personal data leaves it. Built-in facts: returning, visit number,
days since first/last visit, customer, device, OS, browser, language, country (needs the host's geo header), UTM source/medium/campaign/
term/content, referrer site and URL, search keyword (`utm_term` or `?q=`), landing page of the visit, current URL, pages viewed this visit,
hour, weekday and "has done event X". Add your own with `OT.identify({...})` (up to 20 keys; string/number/boolean) and target them as
`attr.<name>`. Code can call it before the SDK has loaded: `window.OT = window.OT || {q: []}; OT.q.push(["identify", {plan: "pro"}])`.
`OT.track("purchase")` also marks the visitor as a customer for the "customer" and "has done event" rules.

## More targeting, triggers and redirects
- **More conditions:** state/region and city (from the host's geo headers on Vercel/Cloudflare -- no IP is read or stored; states of India and
  the US are mapped to names), traffic source (direct / organic / social / email / paid / referral / other, decided per visit), URL parameter
  of the current page, a cookie, a JavaScript variable on the page (`var.user.plan`, plain property reads only), "has visited a page", page count
  of this visit, and page views across all visits (a refresh counts).
- **Groups:** a condition can be a group with its own all/any, e.g. `plan = pro AND (device = mobile OR source = organic)` (one level deep).
- **Where it runs:** all pages, address starts with, contains, or this page only (query string and #hash ignored for starts / exactly).
- **When it shows** (any campaign type): on each page view, first page of a visit, after N seconds, on scroll %, exit intent (desktop), click on
  an element, form submit, or a custom event (`OT.track("name")`). Deferred triggers re-check the audience and frequency when they fire.
- **Redirect action:** send matching visitors to another address (never in a loop, at most 3 per visit; only `https://…` or a single-slash path).
- Not built (on purpose or not yet): matching by company / IP range (we never store IPs), pushing campaign names to Google Analytics, teams and roles.

## Schedules, limits, control groups and more (campaign form → "Schedule, limits & control group")
- **Schedule**: run from / until (UTC under the hood). Outside the window the SDK is not even sent the campaign. Tests can be scheduled via the API too (`start_at` / `end_at`).
- **Limits**: "show at most N times per visitor" and "wait H hours between showings", on top of once / per visit / always.
- **Priority + one overlay at a time**: turn on *Install & settings → One banner / popup at a time*; the highest priority wins per page.
- **Control group**: keep 1-50% of matching visitors *unexposed*. They are recorded as `impression` with variant `control`; conversions on the campaign goal are compared (lift, significance, Bayesian probability) in the campaigns list. Requires a goal.
- **QA link**: the **QA link** button copies `?ot_force=<campaign id>` for your page. It shows only that campaign, ignoring rules/frequency, and records nothing.
- **IP address rule**: single IP, `a.b.c.d-e.f.g.h` range or `a.b.c.d/24` CIDR (IPv4; IPv6 exact). The visitor's own IP is returned by `/ctx` to their browser only; it is never stored.
- **Google Analytics / Tag Manager**: *Send events to Google Analytics* pushes `optimize_campaign_shown`, `optimize_test_exposure`, `optimize_goal`, `optimize_campaign_control` to `dataLayer` (and `gtag` when present).
- **Duplicate** a campaign, and **CSV exports**: campaigns list, goals report (`/goals/report.csv`) and A/B results (`/api/experiments/<id>/results.csv`). Cells starting with `= + - @` are neutralised against spreadsheet formula injection.

## Tests
    python -m pytest tests          # stats + API (uses a throw-away database)
    tests/e2e                       # the real SDK and dashboard scripts in jsdom -- see tests/e2e/README.md

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
- Stats are a fixed-horizon z-test with a Bonferroni correction for several versions, a Bayesian probability and an SRM check; auto-finish is evaluated when the A/B tests page (or results) is loaded, not by a background job. Decide your sample size first.
- Experiments are evaluated on full page loads; SPA route changes re-run campaigns and tracking only.
- Visual editor / heatmap overlay / page preview: need the snippet on the target page; fail on sites with COOP same-origin
  or a CSP blocking the script; no iframe/shadow-DOM editing.
- Time-on-page counts only visible, recently-active time (background tabs count 0 by design).
- Heatmap click positions are stored as % of page width and px from the top, so layouts that shift between screen sizes are
  approximate (filter by device).
- Funnels are computed on read from raw events (fine for MVP volumes; pre-aggregate for large sites). The dashboard makes
  several database round-trips per page; with a hosted database expect ~100-400 ms page loads.
- Uploaded images live in the database (BLOB, 2 MB each, 200 per site) and are served through the function/CDN with
  immutable caching; for heavy image use move them to object storage (e.g. Vercel Blob / S3). SVG uploads are refused on purpose.
  A site CSP with `img-src` must allow this tool's domain.
- No session recordings or data export yet.
- `python seed_demo_data.py` adds 60 SYNTHETIC visitors to the local test site (`--remove` deletes them).
