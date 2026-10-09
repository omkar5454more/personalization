"""Optimize tool — Phase 1 MVP backend.

Serves: the SDK + per-site config to client websites, the /collect event
endpoint, a small JSON API for the dashboard, and the dashboard itself.
Storage: SQLite locally, Turso (hosted libSQL) in production -- see backend/database.py.
"""
import hashlib
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
                    "auto_spa": True, "consent_required": False, "restrict_origin": False}
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
    type: str  # click | pageview | event
    selector: str = ""
    url_contains: str = ""
    name: str = ""


class ExperimentIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    url_contains: str = ""
    traffic: int = Field(default=100, ge=1, le=100)
    variants: list[Variant]
    goal: Goal


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
    keys = [v.key for v in e.variants]
    if len(set(keys)) != len(keys):
        raise HTTPException(422, "variant keys must be unique")
    if sum(max(v.weight, 0) for v in e.variants) <= 0:
        raise HTTPException(422, "variant weights must sum to more than 0")
    for v in e.variants:
        for c in v.changes:
            if c.action not in {"text", "html", "css", "attr", "hide"}:
                raise HTTPException(422, f"unknown action {c.action}")
    if e.goal.type not in {"click", "pageview", "event"}:
        raise HTTPException(422, "goal type must be click, pageview or event")


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
    with db() as con:
        row = con.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id "
            "WHERE s.token_hash=? AND s.created>?",
            (hashlib.sha256(token.encode()).hexdigest(), time.time() - SESSION_TTL),
        ).fetchone()
    if not row:
        raise HTTPException(401, "session expired")
    return row


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
        with db() as con:
            con.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
    response.delete_cookie(SESSION_COOKIE, path="/", secure=COOKIE_SECURE, httponly=True, samesite="lax")
    return {"ok": True}


@app.get("/api/auth/me")
def me(user=Depends(current_user)):
    return {"email": user["email"]}


def owned_site(con, site_id: str, user) -> Any:
    row = con.execute("SELECT * FROM sites WHERE id=? AND user_id=?", (site_id, user["id"])).fetchone()
    if not row:  # same answer for "missing" and "someone else's" -- don't leak existence
        raise HTTPException(404, "site not found")
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
@app.get("/api/sites")
def list_sites(user=Depends(current_user)):
    now = time.time()
    out = []
    with db() as con:
        for r in con.execute("SELECT * FROM sites WHERE user_id=? ORDER BY created DESC", (user["id"],)).fetchall():
            ev = con.execute(
                "SELECT MAX(ts) last, COUNT(DISTINCT CASE WHEN type='pageview' AND ts>=? THEN visitor_id END) v7, "
                "SUM(type='pageview' AND ts>=?) pv7 FROM events WHERE site_id=?",
                (now - 7 * 86400, now - 7 * 86400, r["id"])).fetchone()
            exps = con.execute("SELECT status, COUNT(*) n FROM experiments WHERE site_id=? GROUP BY status", (r["id"],)).fetchall()
            camps = con.execute("SELECT status, COUNT(*) n FROM campaigns WHERE site_id=? GROUP BY status", (r["id"],)).fetchall()
            last = ev["last"]
            status = ("waiting" if not last else "live" if now - last < 600 else
                      "receiving" if now - last < 86400 else "idle")
            out.append({
                "id": r["id"], "name": r["name"], "domain": r["domain"] or "", "created": r["created"],
                "status": status, "last_event": last, "visitors_7d": ev["v7"] or 0, "pageviews_7d": ev["pv7"] or 0,
                "experiments": {x["status"]: x["n"] for x in exps}, "campaigns": {x["status"]: x["n"] for x in camps},
            })
    return out


@app.post("/api/sites")
def create_site(body: SiteIn, user=Depends(current_user)):
    sid = new_id("site")
    domain = clean_domain(body.domain)
    with db() as con:
        con.execute("INSERT INTO sites (id,name,domain,created,user_id,settings) VALUES (?,?,?,?,?,?)",
                    (sid, body.name, domain, time.time(), user["id"], json.dumps(DEFAULT_SETTINGS)))
    return {"id": sid, "name": body.name, "domain": domain}


@app.get("/api/sites/{site_id}")
def get_site_detail(site_id: str, user=Depends(current_user)):
    with db() as con:
        r = owned_site(con, site_id, user)
        return {"id": r["id"], "name": r["name"], "domain": r["domain"] or "", "settings": site_settings(r)}


@app.patch("/api/sites/{site_id}")
def patch_site(site_id: str, body: SitePatch, user=Depends(current_user)):
    with db() as con:
        r = owned_site(con, site_id, user)
        name = body.name if body.name is not None else r["name"]
        domain = clean_domain(body.domain) if body.domain is not None else (r["domain"] or "")
        settings = site_settings(r)
        if body.settings:
            settings.update({k: v for k, v in body.settings.items() if k in DEFAULT_SETTINGS})
        con.execute("UPDATE sites SET name=?, domain=?, settings=? WHERE id=?",
                    (name, domain, json.dumps(settings), site_id))
    return {"id": site_id, "name": name, "domain": domain, "settings": settings}


@app.get("/api/sites/{site_id}/experiments")
def list_experiments(site_id: str, user=Depends(current_user)):
    with db() as con:
        owned_site(con, site_id, user)
        rows = con.execute(
            "SELECT * FROM experiments WHERE site_id=? ORDER BY created DESC", (site_id,)
        ).fetchall()
    return [
        {"id": r["id"], "name": r["name"], "status": r["status"], "config": json.loads(r["config"])}
        for r in rows
    ]


@app.post("/api/sites/{site_id}/experiments")
def create_experiment(site_id: str, body: ExperimentIn, user=Depends(current_user)):
    validate_experiment(body)
    eid = new_id("exp")
    with db() as con:
        owned_site(con, site_id, user)
        con.execute(
            "INSERT INTO experiments VALUES (?,?,?,?,?,?)",
            (eid, site_id, body.name, "draft", body.model_dump_json(), time.time()),
        )
    return {"id": eid, "status": "draft"}


@app.patch("/api/experiments/{exp_id}/status")
def set_status(exp_id: str, body: StatusIn, user=Depends(current_user)):
    if body.status not in {"draft", "running", "paused", "completed"}:
        raise HTTPException(422, "bad status")
    with db() as con:
        owned_experiment(con, exp_id, user)
        con.execute("UPDATE experiments SET status=? WHERE id=?", (body.status, exp_id))
    return {"id": exp_id, "status": body.status}


def _z_test(n_a: int, c_a: int, n_b: int, c_b: int) -> Optional[float]:
    """Two-sided p-value for a difference in conversion rates (pooled z-test)."""
    if n_a < 1 or n_b < 1:
        return None
    p_pool = (c_a + c_b) / (n_a + n_b)
    se = math.sqrt(p_pool * (1 - p_pool) * (1 / n_a + 1 / n_b))
    if se == 0:
        return None
    z = (c_b / n_b - c_a / n_a) / se
    return 2 * (1 - 0.5 * (1 + math.erf(abs(z) / math.sqrt(2))))


@app.get("/api/experiments/{exp_id}/results")
def results(exp_id: str, user=Depends(current_user)):
    with db() as con:
        row = owned_experiment(con, exp_id, user)
        cfg = json.loads(row["config"])
        exposed = {
            r["variant"]: r["n"]
            for r in con.execute(
                "SELECT variant, COUNT(DISTINCT visitor_id) n FROM events "
                "WHERE exp_id=? AND type='exposure' GROUP BY variant",
                (exp_id,),
            )
        }
        # A conversion only counts for visitors who were exposed to the test.
        converted = {
            r["variant"]: r["n"]
            for r in con.execute(
                "SELECT g.variant variant, COUNT(DISTINCT g.visitor_id) n FROM events g "
                "WHERE g.exp_id=? AND g.type='goal' AND EXISTS ("
                "  SELECT 1 FROM events x WHERE x.exp_id=g.exp_id AND x.type='exposure' "
                "  AND x.visitor_id=g.visitor_id AND x.variant=g.variant) "
                "GROUP BY g.variant",
                (exp_id,),
            )
        }
    keys = [v["key"] for v in cfg["variants"]]
    control = keys[0]
    n_c, c_c = exposed.get(control, 0), converted.get(control, 0)
    out = []
    for k in keys:
        n, c = exposed.get(k, 0), converted.get(k, 0)
        rate = c / n if n else 0.0
        item = {"variant": k, "visitors": n, "conversions": c, "rate": rate,
                "is_control": k == control, "uplift": None, "p_value": None, "significant": False}
        if k != control and n_c and n:
            base = c_c / n_c
            item["uplift"] = ((rate - base) / base) if base else None
            p = _z_test(n_c, c_c, n, c)
            item["p_value"] = p
            item["significant"] = p is not None and p < 0.05
        out.append(item)
    return {"id": exp_id, "name": row["name"], "status": row["status"], "variants": out,
            "note": "Significance is a naive fixed-horizon z-test; don't stop at the first "
                    "significant reading — pre-plan the sample size."}


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
RULE_FIELDS = {"returning", "visit_no", "days_since_last", "days_since_first", "utm_source",
               "utm_medium", "utm_campaign", "device", "country", "hour", "weekday", "url", "referrer"}
RULE_OPS = {"eq", "neq", "gte", "lte", "contains"}


class Rule(BaseModel):
    field: str
    op: str = "eq"
    value: str = ""


class Action(BaseModel):
    type: str  # banner | popup | change
    text: str = ""          # banner text / popup body
    title: str = ""         # popup title
    cta_text: str = ""
    cta_url: str = ""
    position: str = "top"   # banner: top | bottom
    bg: str = "#4f46e5"
    fg: str = "#ffffff"
    selector: str = ""      # change, or the target element for custom/inline
    action: str = "text"    # change: text | html | css | attr | hide
    value: str = ""
    attr: str = ""
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
    actions: list[Action]


def validate_campaign(c: CampaignIn):
    if not c.actions:
        raise HTTPException(422, "add at least one action")
    if c.match not in {"all", "any"} or c.frequency not in {"once", "session", "always"}:
        raise HTTPException(422, "bad match/frequency")
    for r in c.rules:
        if r.field not in RULE_FIELDS or r.op not in RULE_OPS:
            raise HTTPException(422, f"bad rule {r.field} {r.op}")
    for a in c.actions:
        if a.type not in {"banner", "popup", "change", "custom"}:
            raise HTTPException(422, f"unknown action type {a.type}")
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
        if a.cta_url and not re.match(r"^(https?://|/)", a.cta_url):
            raise HTTPException(422, "cta_url must start with http(s):// or /")
        if a.type in {"banner", "popup"} and not (a.text or a.title):
            raise HTTPException(422, "banner/popup needs text")
        for col in (a.bg, a.fg):
            if not re.fullmatch(r"#[0-9a-fA-F]{3,8}", col):
                raise HTTPException(422, "colours must be hex like #4f46e5")


@app.get("/api/sites/{site_id}/campaigns")
def list_campaigns(site_id: str, user=Depends(current_user)):
    with db() as con:
        owned_site(con, site_id, user)
        rows = con.execute("SELECT * FROM campaigns WHERE site_id=? ORDER BY created DESC", (site_id,)).fetchall()
        out = []
        for r in rows:
            imp = con.execute("SELECT COUNT(DISTINCT visitor_id) n FROM events WHERE exp_id=? AND type='impression'", (r["id"],)).fetchone()["n"]
            clk = con.execute("SELECT COUNT(DISTINCT visitor_id) n FROM events WHERE exp_id=? AND type='click'", (r["id"],)).fetchone()["n"]
            conv = con.execute("SELECT COUNT(DISTINCT visitor_id) n FROM events WHERE exp_id=? AND type='goal'", (r["id"],)).fetchone()["n"]
            out.append({"id": r["id"], "name": r["name"], "status": r["status"], "config": json.loads(r["config"]),
                        "impressions": imp, "clicks": clk, "conversions": conv})
    return out


@app.post("/api/sites/{site_id}/campaigns")
def create_campaign(site_id: str, body: CampaignIn, user=Depends(current_user)):
    validate_campaign(body)
    cid = new_id("cmp")
    with db() as con:
        owned_site(con, site_id, user)
        con.execute("INSERT INTO campaigns VALUES (?,?,?,?,?,?)",
                    (cid, site_id, body.name, "draft", body.model_dump_json(), time.time()))
    return {"id": cid, "status": "draft"}


@app.put("/api/campaigns/{cid}")
def update_campaign(cid: str, body: CampaignIn, user=Depends(current_user)):
    validate_campaign(body)
    with db() as con:
        owned_campaign(con, cid, user)
        con.execute("UPDATE campaigns SET name=?, config=? WHERE id=?", (body.name, body.model_dump_json(), cid))
    return {"id": cid}


@app.patch("/api/campaigns/{cid}/status")
def set_campaign_status(cid: str, body: StatusIn, user=Depends(current_user)):
    if body.status not in {"draft", "running", "paused", "completed"}:
        raise HTTPException(422, "bad status")
    with db() as con:
        owned_campaign(con, cid, user)
        con.execute("UPDATE campaigns SET status=? WHERE id=?", (body.status, cid))
    return {"id": cid, "status": body.status}


@app.get("/ctx")
def visitor_context(request: Request):
    """Per-request context the cached config can't carry. Country comes from the
    CDN/host's geo header (Cloudflare, Vercel); it is null when running locally."""
    h = request.headers
    country = h.get("cf-ipcountry") or h.get("x-vercel-ip-country") or None
    if country in {"XX", "T1"}:
        country = None
    return JSONResponse({"country": country}, headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------- public (SDK-facing)
@app.get("/sdk/{site_id}.json")
def sdk_config(site_id: str):
    with db() as con:
        site_c, exp_c, camp_c = con.multi([
            ("SELECT * FROM sites WHERE id=?", (site_id,)),
            ("SELECT id, config FROM experiments WHERE site_id=? AND status='running'", (site_id,)),
            ("SELECT id, config FROM campaigns WHERE site_id=? AND status='running'", (site_id,)),
        ])
        site_row = site_c.fetchone()
        if not site_row:
            raise HTTPException(404, "site not found")
        rows, crows = exp_c.fetchall(), camp_c.fetchall()
    exps = []
    for r in rows:
        cfg = json.loads(r["config"])
        cfg["id"] = r["id"]
        exps.append(cfg)
    camps = []
    for r in crows:
        cfg = json.loads(r["config"])
        cfg["id"] = r["id"]
        camps.append(cfg)
    # Cached 60s at the CDN (s-maxage) so a busy site doesn't hit the function/database on every pageview.
    return JSONResponse({"site": site_id, "settings": site_settings(site_row), "experiments": exps, "campaigns": camps},
                        headers={"Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300"})


MAX_BATCH = 50


EVENT_TYPES = {"pageview", "event", "exposure", "goal", "impression", "click",
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
    with db() as con:
        site = con.execute("SELECT domain, settings FROM sites WHERE id=?", (site_id,)).fetchone()
        if not site:
            raise HTTPException(404, "unknown site")
        # Optional, best-effort abuse guard: drop events whose browser Origin isn't the site's domain.
        # (Anyone can forge the header outside a browser, so this stops casual copy-paste misuse, not attackers.)
        origin = request.headers.get("origin") or ""
        if origin and site["domain"] and site_settings(site).get("restrict_origin") and not origin_allowed(origin, site["domain"]):
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
# must be last: a catch-all mount, so every API route above wins.
# On Vercel public/ is served by the CDN and is NOT bundled into this function, so only mount it when present.
if PUBLIC.is_dir():
    app.mount("/", StaticFiles(directory=PUBLIC, html=True), name="public")
