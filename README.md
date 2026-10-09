# Optimize (working name)

Snippet-based website optimisation: visitor tracking, A/B testing with a visual editor,
rule-based personalization, and behaviour analytics. Paste one snippet in a site's <head>.

## Run
    .venv\Scripts\python -m uvicorn backend.main:app --port 8010
    http://127.0.0.1:8010                       dashboard (create an account on first visit)
    http://127.0.0.1:8010/demo?site=<SITE_ID>   demo store with the SDK installed

## Dashboard map (left sidebar)
- All sites        every connected site: connection status, 7-day traffic, running tests/campaigns
- Overview         visitors, sessions, pageviews, avg time, scroll depth, new vs returning, sources, devices
- A/B tests        create (visual editor), start/pause, results with significance
- Personalization  banner/popup campaigns by rule (returning, visit no., UTM, device, country, hour...)
- Behavior         pages, clicks (+rage clicks), scroll depth, forms (start vs submit)
- Heatmaps         click heatmap + scroll map per page and device; schematic in the dashboard, or painted over
                   your real page via "Open page with heatmap" (SDK opens in overlay mode, no tracking)
- Funnels          ordered multi-step funnels (page / click / event / form steps): drop-off per step,
                   median time between steps, new vs returning, biggest drop-off highlighted
- Visitors         per-visitor journey timeline
- Live feed        events as they arrive (5s refresh)
- Install & settings   snippet, connection check, tracking toggles, consent mode

## Auto-tracked by the SDK (toggle per site)
pageviews (incl. SPA route changes), clicks, rage clicks, scroll depth 25/50/75/100, active time on page,
form start/submit (names only, never values), outbound/download links, custom events `OT.track('name')`.
Elements inside `[data-ot-ignore]` are skipped. Click labels that look like emails/long numbers are dropped.

## Privacy
One first-party cookie `_ot` (1 year) mirrored in localStorage. No IP stored. With "Require consent" on,
nothing is stored/sent until `OT.consent(true)`; `OT.consent(false)` deletes the cookie.

## Known limits (before real clients)
- Auth is email+password, server-side sessions. No password reset, email verification, teams/roles.
- Serve over HTTPS in production and set the session cookie `secure=True`.
- SQLite; move events to Postgres/ClickHouse at scale; CDN in front of /sdk/*.json; /collect has no rate limit/bot filter.
- Stats are a fixed-horizon z-test (no peeking correction / SRM check).
- Country needs a geo header (Cloudflare/Vercel); null locally.
- Experiments are evaluated on full page loads; SPA route changes re-run campaigns and tracking only.
- Visual editor: needs the snippet on the target page; fails on sites with COOP same-origin or a CSP blocking the script;
  no iframe/shadow-DOM editing. Visual editing is for A/B variants (campaigns are form-based).
- Time-on-page counts only visible, recently-active time (background tabs count 0 by design).
- Heatmaps: click positions are stored as % of page width and px from top, so layouts that shift between screen
  sizes are only approximate (filter by device). Only clicks recorded after this feature shipped have coordinates.
- Funnels are computed on read from raw events (fine for MVP volumes; pre-aggregate for large sites).
- No session recordings or data export yet.
- `python seed_demo_data.py` adds 60 SYNTHETIC visitors to the local test site (`--remove` deletes them).
