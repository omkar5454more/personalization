"""Optimize tool — Phase 1 MVP backend.

Serves: the SDK + per-site config to client websites, the /collect event
endpoint, a small JSON API for the dashboard, and the dashboard itself.
Storage: SQLite locally, Turso (hosted libSQL) in production -- see backend/database.py.
"""
import hashlib
from datetime import datetime, timezone
import hmac
import json
import math
import os
import re
import secrets
import time
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.database import ROOT, DatabaseError, db
from backend.rules import Rule, RULE_FIELDS, RULE_OPS, clean_rules, validate_rules  # noqa: F401
from backend.stats import evaluate, z_test_p
from backend.geo import location_from_headers
from backend import perf
from backend.audiences import build_router as build_audiences_router, goal_as_test_goal, goal_row

PUBLIC = ROOT / "public"      # static site: dashboard, SDK scripts, demo (served by Vercel's CDN in production)

app = FastAPI(title="Optimize")
# The SDK runs on arbitrary customer origins, so CORS must be open for the public endpoints
# (/collect, /sdk/<id>.json). The dashboard API is same-origin and cookie-authenticated.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class VercelPathFix:
    """On Vercel, vercel.json rewrites send every API call to the single function at /api/index and put the
    path the visitor actually requested in `?__p=`. Restore it so FastAPI routes normally. Only active on Vercel,
    and only when the marker is present."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and os.getenv("VERCEL"):
            from urllib.parse import parse_qsl, urlencode
            pairs = parse_qsl(scope.get("query_string", b"").decode(), keep_blank_values=True)
            real = next((v for k, v in pairs if k == "__p"), None)
            if real and real.startswith("/") and not real.startswith("//"):
                scope = dict(scope)
                scope["path"] = real
                scope["raw_path"] = real.encode()
                scope["query_string"] = urlencode([(k, v) for k, v in pairs if k != "__p"]).encode()
        await self.app(scope, receive, send)


app.add_middleware(VercelPathFix)   # added last => outermost, runs before routing and CORS


@app.exception_handler(DatabaseError)
async def database_error(request: Request, exc: DatabaseError):
    return JSONResponse({"detail": f"Database problem: {exc}"}, status_code=503)


# ---------------------------------------------------------------- models
DEFAULT_SETTINGS = {"auto_clicks": True, "auto_scroll": True, "auto_forms": True,
                    "auto_spa": True, "consent_required": False, "restrict_origin": False,
                    "one_overlay": False,      # when on: at most one banner/popup per page, the highest-priority campaign wins
                    "ga_events": False}        # push campaign / test / conversion events to dataLayer (and gtag)
HOST_RE = re.compile(r"^(localhost|([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})(:\d{1,5})?$")


def clean_domain(raw: str) -> str:
    """'https://WWW.Example.com/path' -> 'www.example.com'. Empty allowed (set later)."""
    d = (raw or "").strip().lower()
    d = re.sub(r"^[a-z]+://", "", d).split("/")[0].split("?")[0]
    if d and not HOST_RE.match(d):
        raise HTTPException(422, "enter a domain like example.com")
    return d


def site_settings(row) -> dict:
    try:
        stored = json.loads(row["settings"] or "{}")
    except ValueError:
        stored = {}
    return {**DEFAULT_SETTINGS, **{k: v for k, v in stored.items() if k in DEFAULT_SETTINGS}}


class SiteIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    domain: str = Field(default="", max_length=200)


class SitePatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    domain: Optional[str] = Field(default=None, max_length=200)
    settings: Optional[dict[str, bool]] = None


class Change(BaseModel):
    selector: str
    action: str  # text | html | css | attr | hide
    value: str = ""
    attr: str = ""


class Variant(BaseModel):
    key: str
    weight: int = 50
    changes: list[Change] = []
    redirect_url: str = ""


class Goal(BaseModel):
    type: str  # click | pageview | event | form
    selector: str = ""
    url_contains: str = ""
    name: str = ""          # event goals: the OT.track() name
    form_name: str = ""     # form goals: the form's id / name / action


class ExperimentIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    url_contains: str = ""
    traffic: int = Field(default=100, ge=1, le=100)
    variants: list[Variant]
    goal: Optional[Goal] = None          # filled from `goal_id` when a saved goal is chosen
    goal_id: str = ""
    secondary_goal_ids: list[str] = []   # extra saved goals reported alongside the main one
    # audience: only visitors who match are entered into the test (a saved segment, or rules written inline)
    segment_id: str = ""
    match: str = "all"
    rules: list[Rule] = []
    start_at: str = Field(default="", max_length=40)
    end_at: str = Field(default="", max_length=40)
    # decision helpers
    auto_winner: bool = False            # complete the test by itself once the evidence rule in stats.evaluate is met
    ship_winner: bool = False            # after completion keep serving the winning version to everyone
    min_days: int = Field(default=7, ge=0, le=90)
    min_visitors: int = Field(default=100, ge=0, le=1_000_000)   # per variant, before a winner can be declared
    winner: str = ""                     # set by the server when the test is completed


class StatusIn(BaseModel):
    status: str  # draft | running | paused | completed


# ---------------------------------------------------------------- helpers
def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(5)}"


def get_site(con, site_id: str):
    row = con.execute("SELECT * FROM sites WHERE id=?", (site_id,)).fetchone()
    if not row:
        raise HTTPException(404, "site not found")
    return row


def validate_experiment(e: ExperimentIn):
    if len(e.variants) < 2:
        raise HTTPException(422, "need at least a control and one variant")
    if len(e.variants) > 6:
        raise HTTPException(422, "up to 6 versions per test")
    validate_schedule(e.start_at, e.end_at)
    validate_rules(e.rules, e.match)
    keys = [v.key for v in e.variants]
    if len(set(keys)) != len(keys):
        raise HTTPException(422, "variant keys must be unique")
    if sum(max(v.weight, 0) for v in e.variants) <= 0:
        raise HTTPException(422, "variant weights must sum to more than 0")
    for v in e.variants:
        for c in v.changes:
            if c.action not in {"text", "html", "css", "attr", "hide"}:
                raise HTTPException(422, f"unknown action {c.action}")
    if e.goal is None:
        raise HTTPException(422, "choose what counts as a win (a saved goal or a custom one)")
    if e.goal.type not in {"click", "pageview", "event", "form"}:
        raise HTTPException(422, "goal type must be click, pageview, event or form")
    if len(set(e.secondary_goal_ids)) != len(e.secondary_goal_ids) or len(e.secondary_goal_ids) > 5:
        raise HTTPException(422, "up to 5 different secondary goals")
    if e.ship_winner and not e.variants:
        raise HTTPException(422, "nothing to ship")


def resolve_refs(con, site_id: str, body) -> None:
    """Checks that the segment / saved goals a test or campaign points at belong to this site, and copies the saved
    goal's definition into the test, so later edits to the goal never change a test that is already collecting data."""
    if body.segment_id:
        if not con.execute("SELECT 1 FROM segments WHERE id=? AND site_id=?", (body.segment_id, site_id)).fetchone():
            raise HTTPException(422, "that audience segment no longer exists")
    if body.goal_id:
        g = con.execute("SELECT * FROM goals WHERE id=? AND site_id=? AND archived=0", (body.goal_id, site_id)).fetchone()
        if not g:
            raise HTTPException(422, "that goal no longer exists")
        body.goal = Goal(**goal_as_test_goal(goal_row(g)))
    if getattr(body, "holdout_pct", 0) and not body.goal:
        raise HTTPException(422, "choose a conversion goal to measure the control group against")
    for gid in getattr(body, "secondary_goal_ids", []):
        if not con.execute("SELECT 1 FROM goals WHERE id=? AND site_id=?", (gid, site_id)).fetchone():
            raise HTTPException(422, "a secondary goal no longer exists")


# ---------------------------------------------------------------- auth
SESSION_COOKIE = "ot_session"
SESSION_TTL = 30 * 86400
COOKIE_SECURE = bool(os.getenv("VERCEL")) or os.getenv("COOKIE_SECURE") == "1"   # Vercel is HTTPS-only


def client_ip(request: Request) -> str:
    # behind Vercel/Cloudflare the real client is in a forwarded header
    fwd = request.headers.get("x-forwarded-for") or request.headers.get("x-real-ip") or ""
    return (fwd.split(",")[0].strip() or (request.client.host if request.client else "?"))[:64]


def _hash_pw(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200_000).hex()


def _throttle(key: str, limit: int = 8, window: int = 300):
    now = time.time()
    with db() as con:
        n = con.execute("SELECT COUNT(*) c FROM login_attempts WHERE k=? AND ts>?", (key, now - window)).fetchone()["c"]
        if n >= limit:
            raise HTTPException(429, "too many attempts, try again in a few minutes")
        con.execute("INSERT INTO login_attempts (k, ts) VALUES (?, ?)", (key, now))
        if secrets.randbelow(25) == 0:   # opportunistic cleanup
            con.execute("DELETE FROM login_attempts WHERE ts<?", (now - 3600,))


class Creds(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=8, max_length=200)


def _start_session(con, user_id: str, response: Response):
    token = secrets.token_urlsafe(32)
    # Only a hash of the token is stored, so a leaked DB can't be replayed as sessions.
    con.execute("INSERT INTO sessions VALUES (?,?,?)",
                (hashlib.sha256(token.encode()).hexdigest(), user_id, time.time()))
    response.set_cookie(SESSION_COOKIE, token, max_age=SESSION_TTL, httponly=True, samesite="lax", path="/", secure=COOKIE_SECURE)


def current_user(request: Request) -> Any:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(401, "not logged in")
    th = hashlib.sha256(token.encode()).hexdigest()
    hit = perf.sessions.get(th)          # saves a database round trip on every dashboard call (cached ~15 s per warm instance)
    if hit is not None:
        return hit
    with db() as con:
        row = con.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id "
            "WHERE s.token_hash=? AND s.created>?",
            (th, time.time() - SESSION_TTL),
        ).fetchone()
    if not row:
        raise HTTPException(401, "session expired")
    return perf.sessions.set(th, row)


@app.post("/api/auth/register")
def register(body: Creds, request: Request, response: Response):
    _throttle("reg:" + client_ip(request))
    email = body.email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise HTTPException(422, "invalid email")
    uid, salt = new_id("usr"), secrets.token_hex(16)
    with db() as con:
        if con.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
            raise HTTPException(409, "email already registered")
        first_user = con.execute("SELECT COUNT(*) c FROM users").fetchone()["c"] == 0
        # On a public deployment set ALLOW_SIGNUPS=0 after creating your own account, so strangers can't register.
        if not first_user and os.getenv("ALLOW_SIGNUPS", "1") == "0":
            raise HTTPException(403, "sign-ups are closed on this server")
        con.execute("INSERT INTO users VALUES (?,?,?,?,?)", (uid, email, salt, _hash_pw(body.password, salt), time.time()))
        if first_user:  # sites created before auth existed go to the first account
            con.execute("UPDATE sites SET user_id=? WHERE user_id IS NULL", (uid,))
        _start_session(con, uid, response)
    return {"email": email}


@app.post("/api/auth/login")
def login(body: Creds, request: Request, response: Response):
    email = body.email.strip().lower()
    _throttle("login:" + client_ip(request) + email)
    with db() as con:
        u = con.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        ok = u and hmac.compare_digest(_hash_pw(body.password, u["salt"]), u["pw_hash"])
        if not ok:
            raise HTTPException(401, "wrong email or password")
        _start_session(con, u["id"], response)
    return {"email": email}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        perf.sessions.pop(hashlib.sha256(token.encode()).hexdigest())
        with db() as con:
            con.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
    response.delete_cookie(SESSION_COOKIE, path="/", secure=COOKIE_SECURE, httponly=True, samesite="lax")
    return {"ok": True}


@app.get("/api/auth/me")
def me(user=Depends(current_user)):
    return {"email": user["email"]}


def owned_site(con, site_id: str, user, fresh: bool = False) -> Any:
    """404 unless the signed-in user owns the site. A positive answer is remembered for ~20 s per warm instance (one database
    round trip saved per call); `fresh=True` always reads the row (use it when you need the row's fields)."""
    key = (user["id"], site_id)
    if not fresh and perf.access.get(key):
        return {"id": site_id}
    row = con.execute("SELECT * FROM sites WHERE id=? AND user_id=?", (site_id, user["id"])).fetchone()
    if not row:  # same answer for "missing" and "someone else's" -- don't leak existence
        raise HTTPException(404, "site not found")
    perf.access.set(key, "owner")
    return row


def owned_experiment(con, exp_id: str, user) -> Any:
    row = con.execute(
        "SELECT e.* FROM experiments e JOIN sites s ON s.id=e.site_id WHERE e.id=? AND s.user_id=?",
        (exp_id, user["id"])).fetchone()
    if not row:
        raise HTTPException(404, "experiment not found")
    return row


def owned_campaign(con, cid: str, user) -> Any:
    row = con.execute(
        "SELECT c.* FROM campaigns c JOIN sites s ON s.id=c.site_id WHERE c.id=? AND s.user_id=?",
        (cid, user["id"])).fetchone()
    if not row:
        raise HTTPException(404, "campaign not found")
    return row


# ---------------------------------------------------------------- dashboard API
def sites_summary(user) -> list:
    """Every site of the user with its connection status, 7-day traffic and running tests/campaigns -- in ONE database round trip."""
    hit = perf.sites_summary.get(user["id"])
    if hit is not None:
        return hit
    now, uid = time.time(), user["id"]
    week = now - 7 * 86400
    with db() as con:
        sites_c, ev_c, ex_c, cm_c = con.multi([
            ("SELECT * FROM sites WHERE user_id=? ORDER BY created DESC", (uid,)),
            ("SELECT s.id site_id, (SELECT MAX(e.ts) FROM events e WHERE e.site_id=s.id) last, "
             "(SELECT COUNT(DISTINCT e.visitor_id) FROM events e WHERE e.site_id=s.id AND e.type='pageview' AND e.ts>=?) v7, "
             "(SELECT COUNT(*) FROM events e WHERE e.site_id=s.id AND e.type='pageview' AND e.ts>=?) pv7 "
             "FROM sites s WHERE s.user_id=?", (week, week, uid)),
            ("SELECT site_id, status, COUNT(*) n FROM experiments WHERE site_id IN (SELECT id FROM sites WHERE user_id=?) GROUP BY site_id, status", (uid,)),
            ("SELECT site_id, status, COUNT(*) n FROM campaigns WHERE site_id IN (SELECT id FROM sites WHERE user_id=?) GROUP BY site_id, status", (uid,)),
        ])
        rows, ev = sites_c.fetchall(), {r["site_id"]: r for r in ev_c.fetchall()}
        exps, camps = {}, {}
        for r in ex_c.fetchall():
            exps.setdefault(r["site_id"], {})[r["status"]] = r["n"]
        for r in cm_c.fetchall():
            camps.setdefault(r["site_id"], {})[r["status"]] = r["n"]
    out = []
    for r in rows:
        e = ev.get(r["id"])
        last = e["last"] if e else None
        status = ("waiting" if not last else "live" if now - last < 600 else "receiving" if now - last < 86400 else "idle")
        out.append({
            "id": r["id"], "name": r["name"], "domain": r["domain"] or "", "created": r["created"],
            "status": status, "last_event": last, "visitors_7d": (e["v7"] if e else 0) or 0, "pageviews_7d": (e["pv7"] if e else 0) or 0,
            "experiments": exps.get(r["id"], {}), "campaigns": camps.get(r["id"], {}),
        })
    return perf.sites_summary.set(uid, out)


@app.get("/api/sites")
def list_sites(user=Depends(current_user)):
    return sites_summary(user)


@app.get("/api/bootstrap")
def bootstrap(user=Depends(current_user)):
    """Everything the dashboard needs to paint its first screen, in one request."""
    return {"user": {"email": user["email"]}, "sites": sites_summary(user)}


@app.post("/api/sites")
def create_site(body: SiteIn, user=Depends(current_user)):
    sid = new_id("site")
    domain = clean_domain(body.domain)
    with db() as con:
        con.execute("INSERT INTO sites (id,name,domain,created,user_id,settings) VALUES (?,?,?,?,?,?)",
                    (sid, body.name, domain, time.time(), user["id"], json.dumps(DEFAULT_SETTINGS)))
    perf.sites_summary.pop(user["id"])
    return {"id": sid, "name": body.name, "domain": domain}


# ---------------------------------------------------------------- image uploads (for the page editor)
# Images live in the database (BLOB) and are served publicly, immutably cached by the CDN, at /img/<id>.<ext>.
# Only PNG/JPEG/WebP/GIF are accepted (never SVG: it can carry scripts), the bytes must match the declared type,
# and the response is served with nosniff + a sandboxing CSP so it can never run as a page.
IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}
MAX_IMAGE_BYTES = 2_000_000
MAX_IMAGES_PER_SITE = 200


def image_bytes_match(mime: str, data: bytes) -> bool:
    if mime == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if mime == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if mime == "image/gif":
        return data.startswith((b"GIF87a", b"GIF89a"))
    if mime == "image/webp":
        return data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    return False


@app.post("/api/sites/{site_id}/images")
async def upload_image(site_id: str, request: Request, user=Depends(current_user)):
    """Raw image bytes in the body (Content-Type: image/png|jpeg|webp|gif). Returns a relative URL."""
    mime = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if mime not in IMAGE_TYPES:
        raise HTTPException(415, "Use a PNG, JPG, WebP or GIF image")
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        declared = 0
    if declared > MAX_IMAGE_BYTES + 2048:
        raise HTTPException(413, f"Image is too large (max {MAX_IMAGE_BYTES // 1_000_000} MB)")
    data = await request.body()
    if not data:
        raise HTTPException(422, "empty file")
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(413, f"Image is too large (max {MAX_IMAGE_BYTES // 1_000_000} MB)")
    if not image_bytes_match(mime, data):
        raise HTTPException(422, "the file's contents don't match its image type")
    from urllib.parse import unquote
    name = re.sub(r"[^\w.\- ]", "", unquote(request.headers.get("x-filename") or "image"))[:80] or "image"
    iid = secrets.token_urlsafe(12)
    with db() as con:
        owned_site(con, site_id, user)
        if con.execute("SELECT COUNT(*) c FROM images WHERE site_id=?", (site_id,)).fetchone()["c"] >= MAX_IMAGES_PER_SITE:
            raise HTTPException(429, "This site has reached its limit of 200 uploaded images")
        con.execute("INSERT INTO images (id,site_id,user_id,mime,size,name,data,created) VALUES (?,?,?,?,?,?,?,?)",
                    (iid, site_id, user["id"], mime, len(data), name, data, time.time()))
    return {"id": iid, "url": f"/img/{iid}.{IMAGE_TYPES[mime]}", "size": len(data)}


@app.get("/img/{name}")
def serve_image(name: str):
    iid = name.rsplit(".", 1)[0]
    with db() as con:
        row = con.execute("SELECT mime, data FROM images WHERE id=?", (iid,)).fetchone()
    if not row:
        raise HTTPException(404, "image not found")
    return Response(content=bytes(row["data"]), media_type=row["mime"], headers={
        "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "cross-origin",
    })


# ---------------------------------------------------------------- one-click demo site
DEMO_NAME = "Aurora Coffee (demo)"
DEMO_FORM_HTML = """<h3 style="margin:0 0 6px">Join the coffee club</h3>
<p style="margin:0 0 12px;color:#555">Welcome back! Get 10% off your first order.</p>
<form id="club-form">
  <input type="email" name="email" placeholder="you@example.com" required>
  <button type="submit">Get my 10% off</button>
</form>
<p class="thanks" hidden>Thanks! Check your inbox for the code.</p>
"""
DEMO_FORM_CSS = """{{container}} input { width: 100%; padding: 11px; margin-bottom: 10px; border: 1px solid #cfc6bb; border-radius: 8px; font-size: 15px; box-sizing: border-box; }
{{container}} button[type=submit] { width: 100%; padding: 12px; border: 0; border-radius: 999px; background: #b05a3c; color: #fff; font-weight: 600; font-size: 15px; cursor: pointer; }
{{container}} .thanks { color: #2f4a3a; font-weight: 600; }
"""
DEMO_FORM_JS = """var form = container.querySelector("form");
form.addEventListener("submit", function (e) {
  e.preventDefault();
  form.hidden = true;
  container.querySelector(".thanks").hidden = false;
  OT.track("club_signup");
});
"""


@app.post("/api/demo-site")
def create_demo_site(request: Request, user=Depends(current_user)):
    """Creates (once per account) the Aurora Coffee demo site with a 3rd-visit form, a welcome-back banner and a funnel,
    all running, so the whole tool can be tried in one click. Returns the demo store URL."""
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(":")[0]
    try:
        domain = clean_domain(host)
    except HTTPException:
        domain = "localhost" if host.startswith("127.") else ""
    with db() as con:
        row = con.execute("SELECT id FROM sites WHERE user_id=? AND name=?", (user["id"], DEMO_NAME)).fetchone()
        if row:
            return {"id": row["id"], "created": False, "demo_url": f"/site-demo?site={row['id']}"}
        sid, now = new_id("site"), time.time()
        third = CampaignIn(
            name="3rd-visit signup form", frequency="once", match="all",
            rules=[Rule(field="visit_no", op="gte", value="3")],
            actions=[Action(type="custom", html=DEMO_FORM_HTML, css=DEMO_FORM_CSS, js=DEMO_FORM_JS,
                            display="modal", trigger="delay", trigger_value=2)])
        banner = CampaignIn(
            name="Welcome-back banner", frequency="session", match="all",
            rules=[Rule(field="returning", op="eq", value="true")],
            actions=[Action(type="banner", text="Welcome back! Free shipping on orders over $30.", position="top",
                            bg="#2f4a3a", fg="#ffffff", cta_text="Shop now", cta_url="/site-demo")])
        for c in (third, banner):
            validate_campaign(c)
        funnel_steps = [{"type": "page", "value": "site-demo", "match": "contains", "label": ""},
                        {"type": "event", "value": "add_to_cart", "match": "contains", "label": "Added to cart"},
                        {"type": "event", "value": "club_signup", "match": "contains", "label": "Joined the club"}]
        stmts = [
            ("INSERT INTO sites (id,name,domain,created,user_id,settings) VALUES (?,?,?,?,?,?)",
             (sid, DEMO_NAME, domain, now, user["id"], json.dumps(DEFAULT_SETTINGS))),
            ("INSERT INTO funnels VALUES (?,?,?,?,?)", (new_id("fun"), sid, "Visit -> cart -> club", json.dumps(funnel_steps), now)),
        ]
        for c in (third, banner):
            stmts.append(("INSERT INTO campaigns VALUES (?,?,?,?,?,?)", (new_id("cmp"), sid, c.name, "running", c.model_dump_json(), now)))
        # ready-made goals and an audience, so Goals / Audiences are not empty on the demo
        for gname, ev_name in (("Added to cart", "add_to_cart"), ("Joined the club", "club_signup")):
            stmts.append(("INSERT INTO goals (id,site_id,name,type,selector,url_contains,event_name,form_name,value,count_mode,archived,created) "
                          "VALUES (?,?,?,?,?,?,?,?,?,?,0,?)", (new_id("goal"), sid, gname, "event", "", "", ev_name, "", 0, "once", now)))
        stmts.append(("INSERT INTO segments VALUES (?,?,?,?,?,?,?)",
                      (new_id("seg"), sid, "Returning visitors on mobile", "People who have been here before, on a phone.", "all",
                       json.dumps([{"field": "returning", "op": "eq", "value": "true"}, {"field": "device", "op": "eq", "value": "mobile"}]), now)))
        con.batch(stmts)
    perf.sites_summary.pop(user["id"])
    return {"id": sid, "created": True, "demo_url": f"/site-demo?site={sid}"}


@app.get("/api/sites/{site_id}")
def get_site_detail(site_id: str, user=Depends(current_user)):
    with db() as con:
        r = owned_site(con, site_id, user, fresh=True)
        return {"id": r["id"], "name": r["name"], "domain": r["domain"] or "", "settings": site_settings(r)}


@app.patch("/api/sites/{site_id}")
def patch_site(site_id: str, body: SitePatch, user=Depends(current_user)):
    with db() as con:
        r = owned_site(con, site_id, user, fresh=True)
        name = body.name if body.name is not None else r["name"]
        domain = clean_domain(body.domain) if body.domain is not None else (r["domain"] or "")
        settings = site_settings(r)
        if body.settings:
            settings.update({k: v for k, v in body.settings.items() if k in DEFAULT_SETTINGS})
        con.execute("UPDATE sites SET name=?, domain=?, settings=? WHERE id=?",
                    (name, domain, json.dumps(settings), site_id))
    perf.site_cfg.pop(site_id)
    perf.sites_summary.pop(user["id"])
    return {"id": site_id, "name": name, "domain": domain, "settings": settings}


@app.get("/api/sites/{site_id}/experiments")
def list_experiments(site_id: str, with_results: bool = False, user=Depends(current_user)):
    with db() as con:
        owned_site(con, site_id, user)
        rows = con.execute(
            "SELECT * FROM experiments WHERE site_id=? ORDER BY created DESC", (site_id,)
        ).fetchall()
        results_by_id = compute_experiment_results(con, rows) if with_results else {}
    out = []
    for r in rows:
        item = {"id": r["id"], "name": r["name"], "status": r["status"], "config": json.loads(r["config"])}
        if with_results:
            item["results"] = results_by_id.get(r["id"])
            item["status"] = item["results"]["status"] if item["results"] else item["status"]
        out.append(item)
    return out


@app.post("/api/sites/{site_id}/experiments")
def create_experiment(site_id: str, body: ExperimentIn, user=Depends(current_user)):
    eid = new_id("exp")
    with db() as con:
        owned_site(con, site_id, user)
        resolve_refs(con, site_id, body)
        validate_experiment(body)
        body.winner = ""
        con.execute(
            "INSERT INTO experiments VALUES (?,?,?,?,?,?)",
            (eid, site_id, body.name, "draft", body.model_dump_json(), time.time()),
        )
    return {"id": eid, "status": "draft"}


class WinnerIn(BaseModel):
    variant: str


@app.post("/api/experiments/{exp_id}/winner")
def declare_winner(exp_id: str, body: WinnerIn, user=Depends(current_user)):
    """Manually end a test and name the winning version (the control = keep the original)."""
    with db() as con:
        row = owned_experiment(con, exp_id, user)
        cfg = json.loads(row["config"])
        if body.variant not in [v["key"] for v in cfg["variants"]]:
            raise HTTPException(422, "unknown version")
        cfg["winner"] = body.variant
        cfg["completed_reason"] = "manual"
        cfg["completed_at"] = time.time()
        con.execute("UPDATE experiments SET status='completed', config=? WHERE id=?", (json.dumps(cfg), exp_id))
    return {"id": exp_id, "status": "completed", "winner": body.variant}


@app.patch("/api/experiments/{exp_id}/status")
def set_status(exp_id: str, body: StatusIn, user=Depends(current_user)):
    if body.status not in {"draft", "running", "paused", "completed"}:
        raise HTTPException(422, "bad status")
    with db() as con:
        owned_experiment(con, exp_id, user)
        con.execute("UPDATE experiments SET status=? WHERE id=?", (body.status, exp_id))
    perf.sites_summary.pop(user["id"])
    return {"id": exp_id, "status": body.status}


def _z_test(n_a: int, c_a: int, n_b: int, c_b: int) -> Optional[float]:   # kept for callers/tests of the old name
    return z_test_p(n_a, c_a, n_b, c_b)


def compute_experiment_results(con, rows) -> dict:
    """Results for several tests of ONE site in a handful of grouped queries (was ~5 per test). Returns {exp_id: result}.
    As a side effect, a running test with auto_winner whose evidence rule is met is completed (see stats.evaluate)."""
    rows = list(rows)
    if not rows:
        return {}
    ids = [r["id"] for r in rows]
    ph = ",".join("?" * len(ids))
    site_id = rows[0]["site_id"]
    cfgs = {r["id"]: json.loads(r["config"]) for r in rows}
    sec_ids = sorted({g for c in cfgs.values() for g in c.get("secondary_goal_ids", [])})
    stmts = [
        (f"SELECT exp_id, variant, COUNT(DISTINCT visitor_id) n FROM events WHERE exp_id IN ({ph}) AND type='exposure' GROUP BY exp_id, variant", ids),
        # A conversion only counts for visitors who were exposed to the test.
        (f"SELECT g.exp_id, g.variant, COUNT(DISTINCT g.visitor_id) n FROM events g WHERE g.exp_id IN ({ph}) AND g.type='goal' AND EXISTS ("
         "SELECT 1 FROM events x WHERE x.exp_id=g.exp_id AND x.type='exposure' AND x.visitor_id=g.visitor_id AND x.variant=g.variant) "
         "GROUP BY g.exp_id, g.variant", ids),
        (f"SELECT exp_id, MIN(ts) t FROM events WHERE exp_id IN ({ph}) AND type='exposure' GROUP BY exp_id", ids),
    ]
    if sec_ids:
        gph = ",".join("?" * len(sec_ids))
        stmts.append((f"SELECT id, name FROM goals WHERE id IN ({gph})", sec_ids))
        # Secondary goals: site-wide `conversion` events from visitors AFTER they entered the test.
        stmts.append((f"SELECT x.exp_id, x.variant, c.name gid, COUNT(DISTINCT x.visitor_id) n FROM "
                      f"(SELECT exp_id, visitor_id, variant, MIN(ts) t FROM events WHERE exp_id IN ({ph}) AND type='exposure' GROUP BY exp_id, visitor_id, variant) x "
                      f"JOIN events c ON c.site_id=? AND c.type='conversion' AND c.name IN ({gph}) AND c.visitor_id=x.visitor_id AND c.ts>=x.t "
                      "GROUP BY x.exp_id, x.variant, c.name", ids + [site_id] + sec_ids))
    res = con.multi(stmts)
    exposed, converted, first = {}, {}, {r["exp_id"]: r["t"] for r in res[2].fetchall()}
    for r in res[0].fetchall():
        exposed.setdefault(r["exp_id"], {})[r["variant"]] = r["n"]
    for r in res[1].fetchall():
        converted.setdefault(r["exp_id"], {})[r["variant"]] = r["n"]
    gnames = {r["id"]: r["name"] for r in res[3].fetchall()} if sec_ids else {}
    sconv = {}
    if sec_ids:
        for r in res[4].fetchall():
            sconv.setdefault((r["exp_id"], r["gid"]), {})[r["variant"]] = r["n"]

    out = {}
    for row in rows:
        eid, cfg = row["id"], cfgs[row["id"]]
        ex, cv = exposed.get(eid, {}), converted.get(eid, {})
        keys = [v["key"] for v in cfg["variants"]]
        control = keys[0]
        weights = {v["key"]: max(v.get("weight", 0), 0) for v in cfg["variants"]}
        runtime_days = ((time.time() - first[eid]) / 86400) if first.get(eid) else 0.0
        ev = evaluate([{"variant": k, "visitors": ex.get(k, 0), "conversions": cv.get(k, 0)} for k in keys],
                      weights, control, min_visitors=cfg.get("min_visitors", 0), runtime_days=runtime_days,
                      min_days=cfg.get("min_days", 0), auto=cfg.get("auto_winner", False))
        status = row["status"]
        if status == "running" and ev["auto_ready"]:
            # The evidence rule is met: end the test and remember the winner (applied lazily, when someone looks at results).
            cfg["winner"] = ev["winner"]; cfg["completed_reason"] = "auto"; cfg["completed_at"] = time.time()
            con.execute("UPDATE experiments SET status='completed', config=? WHERE id=?", (json.dumps(cfg), eid))
            status = "completed"
            perf.sites_summary.clear()
        sec = []
        for gid in cfg.get("secondary_goal_ids", []):
            conv = sconv.get((eid, gid), {})
            sec.append({"goal_id": gid, "name": gnames.get(gid, gid), "variants": [
                {"variant": k, "visitors": ex.get(k, 0), "converters": conv.get(k, 0), "rate": (conv.get(k, 0) / ex[k]) if ex.get(k) else 0.0} for k in keys]})
        out[eid] = {"id": eid, "name": row["name"], "status": status, "variants": ev["variants"], "srm": ev["srm"],
                    "alpha": ev["alpha"], "needed_per_variant": ev["needed_per_variant"], "baseline_rate": ev["baseline_rate"],
                    "enough_data": ev["enough_data"], "winner": cfg.get("winner") or ev["winner"],
                    "winner_declared": bool(cfg.get("winner")), "completed_reason": cfg.get("completed_reason"),
                    "recommendation": ev["recommendation"], "runtime_days": runtime_days, "secondary": sec,
                    "note": "Significance uses a fixed-horizon z-test with a Bonferroni correction when there are several versions; "
                            "the probability-to-beat-control is Bayesian. Decide your sample size first and avoid stopping at the "
                            "first lucky reading."}
    return out


@app.get("/api/experiments/{exp_id}/results")
def results(exp_id: str, user=Depends(current_user)):
    with db() as con:
        row = owned_experiment(con, exp_id, user)
        return compute_experiment_results(con, [row])[exp_id]


def csv_response(filename: str, header: list, rows: list) -> Response:
    """CSV download. Cells that start with = + - @ get a leading quote so a spreadsheet never runs them as formulas."""
    import csv
    import io
    buf = io.StringIO()
    w = csv.writer(buf)
    safe = lambda v: ("'" + v) if isinstance(v, str) and v[:1] in ("=", "+", "-", "@") else v
    w.writerow(header)
    for r in rows:
        w.writerow([safe(c) for c in r])
    return Response(content=buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"})


@app.get("/api/experiments/{exp_id}/results.csv")
def results_csv(exp_id: str, user=Depends(current_user)):
    with db() as con:
        row = owned_experiment(con, exp_id, user)
        res = compute_experiment_results(con, [row])[exp_id]
    return csv_response(f"test-{exp_id}.csv", ["version", "visitors", "conversions", "rate", "range_low", "range_high", "uplift", "p_value", "p_adjusted", "prob_beats_control", "significant"],
                        [[v["variant"], v["visitors"], v["conversions"], round(v["rate"], 6), round(v["ci_low"], 6), round(v["ci_high"], 6),
                          "" if v["uplift"] is None else round(v["uplift"], 6), "" if v["p_value"] is None else round(v["p_value"], 6),
                          "" if v["p_adjusted"] is None else round(v["p_adjusted"], 6),
                          "" if v["prob_beat_control"] is None else round(v["prob_beat_control"], 4), v["significant"]] for v in res["variants"]])


@app.get("/api/sites/{site_id}/campaigns.csv")
def campaigns_csv(site_id: str, user=Depends(current_user)):
    rows = list_campaigns(site_id, user)
    return csv_response(f"campaigns-{site_id}.csv", ["campaign", "status", "shown_to", "clicked", "converted", "control_lift"],
                        [[c["name"], c["status"], c["impressions"], c["clicks"], c["conversions"],
                          "" if not c["control_results"] or c["control_results"]["uplift"] is None else round(c["control_results"]["uplift"], 4)] for c in rows])


@app.get("/api/sites/{site_id}/visitors")
def visitor_stats(site_id: str, days: int = 14, user=Depends(current_user)):
    """New vs returning visitors per day (UTC) — the base for personalization rules."""
    since = time.time() - days * 86400
    with db() as con:
        owned_site(con, site_id, user)
        rows = con.execute(
            "SELECT date(ts,'unixepoch') d, "
            "COUNT(DISTINCT CASE WHEN is_returning=0 THEN visitor_id END) new_v, "
            "COUNT(DISTINCT CASE WHEN is_returning=1 THEN visitor_id END) ret_v, "
            "COUNT(*) pageviews "
            "FROM events WHERE site_id=? AND type='pageview' AND ts>=? GROUP BY d ORDER BY d",
            (site_id, since),
        ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- personalization
# (targeting rules live in backend/rules.py: Rule, RULE_FIELDS, RULE_OPS, validate_rules)


class Action(BaseModel):
    type: str  # banner | popup | change
    text: str = ""          # banner text / popup body
    title: str = ""         # popup title
    cta_text: str = ""
    cta_url: str = ""
    position: str = "top"   # banner: top | bottom
    bg: str = "#4f46e5"
    fg: str = "#ffffff"
    # banner / popup look (all optional; the defaults reproduce the original design)
    font_size: int = Field(default=15, ge=11, le=32)
    align: str = "center"       # left | center | right
    size: str = "medium"        # small | medium | large  (inner spacing)
    radius: int = Field(default=0, ge=0, le=32)
    bold: bool = False
    closable: bool = True       # show the × button
    cta_bg: str = ""            # button colours; empty = plain underlined link (banner) / accent button (popup)
    cta_fg: str = ""
    selector: str = ""      # change, or the target element for custom/inline
    action: str = "text"    # change: text | html | css | attr | hide
    value: str = Field(default="", max_length=20000)
    attr: str = Field(default="", max_length=50)
    # custom code (type == "custom"): runs on the visitor's page, like a tag manager
    html: str = Field(default="", max_length=50000)
    css: str = Field(default="", max_length=50000)
    js: str = Field(default="", max_length=50000)
    display: str = "modal"      # modal | slidein | inline
    insert: str = "append"      # inline only: append | prepend | before | after | replace
    trigger: str = "load"       # load | delay | scroll | exit
    trigger_value: int = Field(default=0, ge=0, le=100000)  # seconds for delay, percent for scroll


class CampaignIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    url_contains: str = ""
    match: str = "all"          # all | any
    frequency: str = "once"     # once | session | always
    rules: list[Rule] = []
    # where it runs: all pages | address starts with | contains | is exactly   (`url_contains` holds the text)
    page_match: str = "contains"
    # when it shows: load (each page view) | session_start | delay | scroll | exit | click | form | event
    trigger_type: str = "load"
    trigger_value: str = Field(default="", max_length=300)   # seconds / % / CSS selector / form name / event name
    segment_id: str = ""        # a saved audience; when set, the segment's rules replace `rules` in the SDK config
    goal_id: str = ""           # optional saved goal: conversions after seeing this campaign are counted for it
    goal: Optional[Goal] = None
    # schedule (UTC, ISO 8601; empty = no limit) and frequency limits
    start_at: str = Field(default="", max_length=40)
    end_at: str = Field(default="", max_length=40)
    max_views: int = Field(default=0, ge=0, le=1000)                 # at most N showings per visitor (0 = no limit)
    cooldown_hours: int = Field(default=0, ge=0, le=24 * 365)        # wait this long between showings (0 = none)
    holdout_pct: int = Field(default=0, ge=0, le=50)                 # % of matching visitors kept as an untouched control group
    priority: int = Field(default=0, ge=0, le=100)                   # higher wins when several overlays compete for a page
    actions: list[Action]


def parse_when(v: str):
    """ISO 8601 ('2026-10-20T09:30:00Z' or with an offset) -> aware UTC datetime; '' -> None; raises 422 on junk."""
    v = (v or "").strip()
    if not v:
        return None
    try:
        d = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(422, "dates must look like 2026-10-20T09:30:00Z")
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def validate_schedule(start_at: str, end_at: str) -> None:
    a, b = parse_when(start_at), parse_when(end_at)
    if a and b and b <= a:
        raise HTTPException(422, "the end must be after the start")


TRIGGERS = {"load", "session_start", "delay", "scroll", "exit", "click", "form", "event"}


def validate_trigger(kind: str, value: str) -> None:
    if kind not in TRIGGERS:
        raise HTTPException(422, "unknown trigger")
    v = (value or "").strip()
    if kind == "delay":
        if not v.isdigit() or not 0 <= int(v) <= 3600:
            raise HTTPException(422, "delay needs a number of seconds (0-3600)")
    elif kind == "scroll":
        if not v.isdigit() or not 1 <= int(v) <= 100:
            raise HTTPException(422, "scroll needs a percentage between 1 and 100")
    elif kind in {"click", "form", "event"} and not v:
        raise HTTPException(422, {"click": "enter the CSS selector of the element", "form": "enter the form's name",
                                  "event": "enter the event name"}[kind])


def validate_campaign(c: CampaignIn):
    if not c.actions:
        raise HTTPException(422, "add at least one action")
    if len(c.actions) > 100:
        raise HTTPException(422, "too many actions (max 100)")
    if c.frequency not in {"once", "session", "always"}:
        raise HTTPException(422, "bad frequency")
    validate_rules(c.rules, c.match)
    if c.page_match not in {"all", "starts", "contains", "equals"}:
        raise HTTPException(422, "page_match must be all, starts, contains or equals")
    if c.page_match in {"starts", "equals"} and not c.url_contains.strip():
        raise HTTPException(422, "enter the page address")
    validate_trigger(c.trigger_type, c.trigger_value)
    validate_schedule(c.start_at, c.end_at)
    for a in c.actions:
        if a.type not in {"banner", "popup", "change", "custom", "redirect"}:
            raise HTTPException(422, f"unknown action type {a.type}")
        if a.type == "redirect":
            if not re.match(r"^(https?://[^\s/]\S*|/(?![/\\])\S*)$", a.value.strip()):   # full address, or a single-slash path (no //host)
                raise HTTPException(422, "redirect needs a full address (https://…) or a path starting with /")
            continue
        if a.type == "custom":
            if not (a.html.strip() or a.js.strip()):
                raise HTTPException(422, "custom code needs some HTML or JavaScript")
            if a.display not in {"modal", "slidein", "inline"}:
                raise HTTPException(422, "display must be modal, slidein or inline")
            if a.display == "inline" and (not a.selector.strip() or a.insert not in {"append", "prepend", "before", "after", "replace"}):
                raise HTTPException(422, "inline placement needs a CSS selector and a valid position")
            if a.trigger not in {"load", "delay", "scroll", "exit"}:
                raise HTTPException(422, "trigger must be load, delay, scroll or exit")
            if a.trigger == "scroll" and not 1 <= a.trigger_value <= 100:
                raise HTTPException(422, "scroll trigger needs a percentage between 1 and 100")
            continue
        if a.type == "change" and (not a.selector or a.action not in {"text", "html", "css", "attr", "hide"}):
            raise HTTPException(422, "change action needs selector and a valid action")
        if a.type == "change" and a.action == "attr" and not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9:_-]{0,49}", a.attr or ""):
            raise HTTPException(422, "attribute changes need a valid attribute name")
        if a.cta_url and not re.match(r"^(https?://|/)", a.cta_url):
            raise HTTPException(422, "cta_url must start with http(s):// or /")
        if a.type in {"banner", "popup"} and not (a.text or a.title):
            raise HTTPException(422, "banner/popup needs text")
        for col in (a.bg, a.fg):
            if not re.fullmatch(r"#[0-9a-fA-F]{3,8}", col):
                raise HTTPException(422, "colours must be hex like #4f46e5")
        for col in (a.cta_bg, a.cta_fg):
            if col and not re.fullmatch(r"#[0-9a-fA-F]{3,8}", col):
                raise HTTPException(422, "button colours must be hex like #4f46e5")
        if a.align not in {"left", "center", "right"} or a.size not in {"small", "medium", "large"}:
            raise HTTPException(422, "align must be left/center/right and size small/medium/large")


def schedule_state(cfg: dict, now: datetime) -> Optional[str]:
    """None while inside the schedule window, else 'scheduled' (not started yet) or 'ended'."""
    a, b = parse_when(cfg.get("start_at", "")), parse_when(cfg.get("end_at", ""))
    if a and now < a:
        return "scheduled"
    if b and now > b:
        return "ended"
    return None


def compute_campaign_results(rows, imp_rows, conv_rows, first_rows) -> dict:
    """Control-group (holdout) results: visitors who were eligible but deliberately NOT shown the campaign vs visitors who were shown it,
    compared on the campaign's conversion goal. Returns {campaign_id: result} for campaigns that have a holdout and a goal."""
    imp, conv, first = {}, {}, {x["exp_id"]: x["t"] for x in first_rows}
    for x in imp_rows:
        imp.setdefault(x["exp_id"], {})[x["variant"]] = x["n"]
    for x in conv_rows:
        conv.setdefault(x["exp_id"], {})[x["variant"]] = x["n"]
    out = {}
    for r in rows:
        cfg = json.loads(r["config"])
        h = cfg.get("holdout_pct") or 0
        if h <= 0 or not cfg.get("goal"):
            continue
        ev = evaluate([{"variant": "control", "visitors": imp.get(r["id"], {}).get("control", 0), "conversions": conv.get(r["id"], {}).get("control", 0)},
                       {"variant": "shown", "visitors": imp.get(r["id"], {}).get("shown", 0), "conversions": conv.get(r["id"], {}).get("shown", 0)}],
                      {"control": h, "shown": 100 - h}, "control", min_visitors=30,
                      runtime_days=((time.time() - first[r["id"]]) / 86400) if first.get(r["id"]) else 0.0, min_days=0)
        shown = next(v for v in ev["variants"] if v["variant"] == "shown")
        out[r["id"]] = {"holdout_pct": h, "variants": ev["variants"], "srm": ev["srm"], "recommendation": ev["recommendation"],
                        "uplift": shown["uplift"], "significant": shown["significant"], "prob_beat_control": shown["prob_beat_control"],
                        "needed_per_variant": ev["needed_per_variant"]}
    return out


@app.get("/api/sites/{site_id}/campaigns")
def list_campaigns(site_id: str, user=Depends(current_user)):
    with db() as con:
        owned_site(con, site_id, user)
        mine = "exp_id IN (SELECT id FROM campaigns WHERE site_id=?)"
        camp_c, cnt_c, imp_c, conv_c, first_c = con.multi([
            ("SELECT * FROM campaigns WHERE site_id=? ORDER BY created DESC", (site_id,)),
            (f"SELECT exp_id, type, COUNT(DISTINCT visitor_id) n FROM events WHERE site_id=? AND type IN ('impression','click','goal') AND {mine} GROUP BY exp_id, type", (site_id, site_id)),
            (f"SELECT exp_id, variant, COUNT(DISTINCT visitor_id) n FROM events WHERE site_id=? AND type='impression' AND variant IN ('shown','control') AND {mine} GROUP BY exp_id, variant", (site_id, site_id)),
            (f"SELECT g.exp_id, g.variant, COUNT(DISTINCT g.visitor_id) n FROM events g WHERE g.site_id=? AND g.type='goal' AND g.variant IN ('shown','control') AND g.{mine} AND EXISTS ("
             "SELECT 1 FROM events x WHERE x.exp_id=g.exp_id AND x.type='impression' AND x.visitor_id=g.visitor_id AND x.variant=g.variant) GROUP BY g.exp_id, g.variant", (site_id, site_id)),
            (f"SELECT exp_id, MIN(ts) t FROM events WHERE site_id=? AND type='impression' AND {mine} GROUP BY exp_id", (site_id, site_id)),
        ])
        rows = camp_c.fetchall()
        counts = {(r["exp_id"], r["type"]): r["n"] for r in cnt_c.fetchall()}
        results = compute_campaign_results(rows, imp_c.fetchall(), conv_c.fetchall(), first_c.fetchall())
    now = datetime.now(timezone.utc)
    out = []
    for r in rows:
        cfg = json.loads(r["config"])
        out.append({"id": r["id"], "name": r["name"], "status": r["status"], "config": cfg,
                    "schedule_state": schedule_state(cfg, now) if r["status"] == "running" else None,
                    "impressions": counts.get((r["id"], "impression"), 0), "clicks": counts.get((r["id"], "click"), 0),
                    "conversions": counts.get((r["id"], "goal"), 0), "control_results": results.get(r["id"])})
    return out


@app.post("/api/sites/{site_id}/campaigns")
def create_campaign(site_id: str, body: CampaignIn, user=Depends(current_user)):
    validate_campaign(body)
    cid = new_id("cmp")
    with db() as con:
        owned_site(con, site_id, user)
        resolve_refs(con, site_id, body)
        con.execute("INSERT INTO campaigns VALUES (?,?,?,?,?,?)",
                    (cid, site_id, body.name, "draft", body.model_dump_json(), time.time()))
    return {"id": cid, "status": "draft"}


@app.put("/api/campaigns/{cid}")
def update_campaign(cid: str, body: CampaignIn, user=Depends(current_user)):
    validate_campaign(body)
    with db() as con:
        row = owned_campaign(con, cid, user)
        resolve_refs(con, row["site_id"], body)
        con.execute("UPDATE campaigns SET name=?, config=? WHERE id=?", (body.name, body.model_dump_json(), cid))
    return {"id": cid}


@app.patch("/api/campaigns/{cid}/status")
def set_campaign_status(cid: str, body: StatusIn, user=Depends(current_user)):
    if body.status not in {"draft", "running", "paused", "completed"}:
        raise HTTPException(422, "bad status")
    with db() as con:
        owned_campaign(con, cid, user)
        con.execute("UPDATE campaigns SET status=? WHERE id=?", (body.status, cid))
    perf.sites_summary.pop(user["id"])
    return {"id": cid, "status": body.status}


@app.get("/ctx")
def visitor_context(request: Request):
    """Per-request context the cached config can't carry: country / state / city from the host's geo headers
    (Vercel, Cloudflare). Null values when running locally or when the host doesn't send them. No IP is read or stored."""
    return JSONResponse({**location_from_headers(request.headers), "ip": client_ip(request)}, headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------- public (SDK-facing)
@app.get("/sdk/{site_id}.json")
def sdk_config(site_id: str):
    with db() as con:
        site_c, exp_c, camp_c, seg_c, goal_c = con.multi([
            ("SELECT * FROM sites WHERE id=?", (site_id,)),
            ("SELECT id, status, config FROM experiments WHERE site_id=? AND status IN ('running','completed')", (site_id,)),
            ("SELECT id, config FROM campaigns WHERE site_id=? AND status='running'", (site_id,)),
            ("SELECT id, match, rules FROM segments WHERE site_id=?", (site_id,)),
            ("SELECT * FROM goals WHERE site_id=? AND archived=0", (site_id,)),
        ])
        site_row = site_c.fetchone()
        if not site_row:
            raise HTTPException(404, "site not found")
        rows, crows, srows, grows = exp_c.fetchall(), camp_c.fetchall(), seg_c.fetchall(), goal_c.fetchall()
    segs = {x["id"]: {"match": x["match"] or "all", "rules": json.loads(x["rules"] or "[]")} for x in srows}

    def with_audience(cfg):
        seg = segs.get(cfg.get("segment_id") or "")
        if seg:                                  # a deleted segment falls back to the rules saved with the item
            cfg["rules"], cfg["match"] = seg["rules"], seg["match"]
        return cfg

    now_utc = datetime.now(timezone.utc)
    exps = []
    for r in rows:
        cfg = json.loads(r["config"])
        cfg["id"] = r["id"]
        if r["status"] == "running" and schedule_state(cfg, now_utc):
            continue                             # outside its start / end window
        if r["status"] == "completed":
            # a finished test keeps serving its winning version to everyone, but only if the owner asked for that
            win = cfg.get("winner")
            v = next((x for x in cfg["variants"] if x["key"] == win), None)
            if not (cfg.get("ship_winner") and v and (v.get("changes") or v.get("redirect_url"))):
                continue
            cfg["rollout"] = win
        exps.append(with_audience(cfg))
    camps = []
    for r in crows:
        cfg = json.loads(r["config"])
        cfg["id"] = r["id"]
        if schedule_state(cfg, now_utc):
            continue
        camps.append(with_audience(cfg))
    goals = [{k: g[k] for k in ("id", "name", "type", "selector", "url_contains", "event_name", "form_name", "value", "count_mode")} for g in grows]
    # Cached ~20s at the CDN (s-maxage) so a busy site doesn't hit the function/database on every pageview,
    # yet dashboard changes show up on the site within about half a minute.
    return JSONResponse({"site": site_id, "settings": site_settings(site_row), "experiments": exps, "campaigns": camps, "goals": goals},
                        headers={"Cache-Control": "public, max-age=15, s-maxage=20, stale-while-revalidate=60"})


MAX_BATCH = 50


EVENT_TYPES = {"pageview", "event", "exposure", "goal", "conversion", "impression", "click",
               "autoclick", "scroll", "engage", "form", "rage"}


def clean_props(raw) -> str:
    """Scalars only, bounded sizes -- so stored JSON is always valid and json_extract-safe."""
    out = {}
    if isinstance(raw, dict):
        for k, v in list(raw.items())[:25]:
            if isinstance(v, bool) or v is None or isinstance(v, (int, float)):
                out[str(k)[:40]] = v
            elif isinstance(v, str):
                out[str(k)[:40]] = v[:300]
    return json.dumps(out)


MAX_BODY = 200_000


def origin_allowed(origin: str, domain: str) -> bool:
    """True if the request's Origin host is the site's domain or a subdomain of it (www., app., ...)."""
    host = (urlparse(origin).hostname or "").lower()
    d = domain.lower().split(":")[0]
    return bool(host) and (host == d or host.endswith("." + d))


@app.post("/collect")
async def collect(request: Request):
    # sendBeacon posts text/plain, so parse the raw body rather than rely on content-type.
    raw = await request.body()
    if len(raw) > MAX_BODY:
        raise HTTPException(413, "payload too large")
    try:
        payload = json.loads(raw)
    except ValueError:
        raise HTTPException(400, "bad json")
    if not isinstance(payload, dict):
        raise HTTPException(400, "bad payload")
    site_id = payload.get("site")
    events = payload.get("events") or []
    if not isinstance(events, list) or not site_id:
        raise HTTPException(400, "bad payload")
    host = str(payload.get("host") or "")[:100]
    country = request.headers.get("cf-ipcountry") or request.headers.get("x-vercel-ip-country")
    cfg = perf.site_cfg.get(site_id)       # (domain, settings): cached ~60 s, saves one database round trip per page view
    if cfg is None:
        with db() as con:
            site = con.execute("SELECT domain, settings FROM sites WHERE id=?", (site_id,)).fetchone()
        if not site:
            raise HTTPException(404, "unknown site")
        cfg = perf.site_cfg.set(site_id, (site["domain"], site_settings(site)))
    domain, settings = cfg
    with db() as con:
        # Optional, best-effort abuse guard: drop events whose browser Origin isn't the site's domain.
        # (Anyone can forge the header outside a browser, so this stops casual copy-paste misuse, not attackers.)
        origin = request.headers.get("origin") or ""
        if origin and domain and settings.get("restrict_origin") and not origin_allowed(origin, domain):
            return Response(status_code=204)
        now = time.time()
        stmts = []
        for e in events[:MAX_BATCH]:
            if not isinstance(e, dict) or not e.get("vid") or e.get("type") not in EVENT_TYPES:
                continue
            props = e.get("props") if isinstance(e.get("props"), dict) else {}
            if e["type"] == "pageview" and country and country not in {"XX", "T1"}:
                props = {**props, "country": country}
            try:
                visit_no = int(e.get("visit_no") or 1)
            except (TypeError, ValueError):
                visit_no = 1
            stmts.append((
                "INSERT INTO events (site_id,ts,visitor_id,session_id,type,name,url,exp_id,"
                "variant,visit_no,is_returning,props,host) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (site_id, now, str(e["vid"])[:64], str(e.get("sid", ""))[:64],
                 e["type"], str(e.get("name", ""))[:100], str(e.get("url", ""))[:500],
                 str(e["exp"])[:40] if e.get("exp") else None, str(e["variant"])[:40] if e.get("variant") else None,
                 visit_no, 1 if e.get("returning") else 0, clean_props(props), host)))
        con.batch(stmts)
    return Response(status_code=204)


# ---------------------------------------------------------------- static (local dev)
# In production Vercel serves public/ from its CDN before requests ever reach this function
# (see vercel.json). These routes make `uvicorn backend.main:app` behave the same locally.
@app.get("/site-demo")
@app.get("/site-demo/{rest:path}")
def site_demo(rest: str = ""):
    return FileResponse(PUBLIC / "site-demo.html")


@app.get("/demo")
@app.get("/demo/{rest:path}")
def demo(rest: str = ""):
    return FileResponse(PUBLIC / "demo.html")


from backend.analytics import build_router  # noqa: E402  (needs db/current_user/owned_site defined above)

app.include_router(build_router(db, current_user, owned_site))
app.include_router(build_audiences_router(db, current_user, owned_site, new_id))
# must be last: a catch-all mount, so every API route above wins.
# On Vercel public/ is served by the CDN and is NOT bundled into this function, so only mount it when present.
if PUBLIC.is_dir():
    app.mount("/", StaticFiles(directory=PUBLIC, html=True), name="public")
