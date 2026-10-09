"""Behaviour analytics endpoints (read-only) built on the raw `events` table.

Event types written by the SDK: pageview, autoclick, rage, scroll, engage, form,
event (custom), plus exposure/goal (A/B) and impression/click (campaigns).
`props` is JSON; the paths used here: $.pid (page-view id), $.seconds, $.scroll,
$.depth, $.sel, $.text, $.tag, $.href, $.device, $.ref, $.utm_source, $.form, $.action.
"""
import json
import secrets
import statistics
import time
from collections import defaultdict
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

# URL without its query string, so /pricing?a=1 and /pricing?b=2 are one page.
PATH = "(CASE WHEN instr(url,'?')>0 THEN substr(url,1,instr(url,'?')-1) ELSE url END)"


def _since(days: int) -> float:
    days = max(1, min(int(days), 90))
    return time.time() - days * 86400



STEP_TYPES = {"page", "click", "event", "form"}


class Step(BaseModel):
    type: str                      # page | click | event | form
    value: str = Field(min_length=1, max_length=200)
    match: str = "contains"        # page steps only: contains | equals
    label: str = Field(default="", max_length=80)


class FunnelIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    steps: list[Step]


def _step_matches(step: dict, typ: str, name: str, url: str, props: dict) -> bool:
    v = step["value"].lower()
    t = step["type"]
    if t == "page":
        if typ != "pageview":
            return False
        path = (url or "/").split("?")[0].lower()
        return path == v if step.get("match") == "equals" else v in path
    if t == "click":
        return typ == "autoclick" and (v in str(props.get("text", "")).lower() or v in str(props.get("sel", "")).lower())
    if t == "event":
        return typ == "event" and (name or "").lower() == v
    if t == "form":
        return typ == "form" and props.get("action") == "submit" and v in str(props.get("form", "")).lower()
    return False


def _default_label(st: dict) -> str:
    verb = {"page": "Visited", "click": "Clicked", "event": "Event", "form": "Submitted form"}[st["type"]]
    return st.get("label") or f"{verb} {st['value']}"


def build_router(db, current_user, owned_site) -> APIRouter:
    r = APIRouter(prefix="/api/sites/{site_id}")

    @r.get("/overview")
    def overview(site_id: str, days: int = 14, user=Depends(current_user)):
        since = _since(days)
        with db() as con:
            owned_site(con, site_id, user)
            q = lambda sql, *a: con.execute(sql, a).fetchall()
            tot = q(
                "SELECT COUNT(DISTINCT visitor_id) v, COUNT(DISTINCT session_id) s, COUNT(*) pv, "
                "COUNT(DISTINCT CASE WHEN is_returning=0 THEN visitor_id END) new_v, "
                "COUNT(DISTINCT CASE WHEN is_returning=1 THEN visitor_id END) ret_v "
                "FROM events WHERE site_id=? AND type='pageview' AND ts>=?", site_id, since)[0]
            eng = q(
                "SELECT AVG(s) avg_s, AVG(sc) avg_sc FROM ("
                " SELECT MAX(json_extract(props,'$.seconds')) s, MAX(json_extract(props,'$.scroll')) sc "
                " FROM events WHERE site_id=? AND type='engage' AND ts>=? GROUP BY json_extract(props,'$.pid'))",
                site_id, since)[0]
            daily = q(
                "SELECT date(ts,'unixepoch') d, "
                "COUNT(DISTINCT CASE WHEN is_returning=0 THEN visitor_id END) new_v, "
                "COUNT(DISTINCT CASE WHEN is_returning=1 THEN visitor_id END) ret_v, COUNT(*) pageviews "
                "FROM events WHERE site_id=? AND type='pageview' AND ts>=? GROUP BY d ORDER BY d", site_id, since)
            sources = q(
                "SELECT COALESCE(NULLIF(json_extract(props,'$.utm_source'),''), NULLIF(json_extract(props,'$.ref'),''), 'direct') src, "
                "COUNT(DISTINCT visitor_id) v FROM events WHERE site_id=? AND type='pageview' AND ts>=? "
                "GROUP BY src ORDER BY v DESC LIMIT 8", site_id, since)
            devices = q(
                "SELECT COALESCE(json_extract(props,'$.device'),'unknown') d, COUNT(DISTINCT visitor_id) v "
                "FROM events WHERE site_id=? AND type='pageview' AND ts>=? GROUP BY d ORDER BY v DESC", site_id, since)
            countries = q(
                "SELECT json_extract(props,'$.country') c, COUNT(DISTINCT visitor_id) v FROM events "
                "WHERE site_id=? AND type='pageview' AND ts>=? AND json_extract(props,'$.country') IS NOT NULL "
                "GROUP BY c ORDER BY v DESC LIMIT 8", site_id, since)
            top_events = q(
                "SELECT name, COUNT(*) n, COUNT(DISTINCT visitor_id) v FROM events "
                "WHERE site_id=? AND type='event' AND ts>=? GROUP BY name ORDER BY n DESC LIMIT 8", site_id, since)
        return {
            "days": days,
            "visitors": tot["v"], "sessions": tot["s"], "pageviews": tot["pv"],
            "new_visitors": tot["new_v"], "returning_visitors": tot["ret_v"],
            "avg_seconds": eng["avg_s"], "avg_scroll": eng["avg_sc"],
            "daily": [dict(x) for x in daily],
            "sources": [{"name": x["src"], "visitors": x["v"]} for x in sources],
            "devices": [{"name": x["d"], "visitors": x["v"]} for x in devices],
            "countries": [{"name": x["c"], "visitors": x["v"]} for x in countries],
            "custom_events": [{"name": x["name"], "count": x["n"], "visitors": x["v"]} for x in top_events],
        }

    @r.get("/pages")
    def pages(site_id: str, days: int = 14, user=Depends(current_user)):
        since = _since(days)
        with db() as con:
            owned_site(con, site_id, user)
            views = con.execute(
                f"SELECT {PATH} p, COUNT(*) views, COUNT(DISTINCT visitor_id) visitors FROM events "
                "WHERE site_id=? AND type='pageview' AND ts>=? GROUP BY p ORDER BY views DESC LIMIT 100",
                (site_id, since)).fetchall()
            eng = {x["p"]: x for x in con.execute(
                f"SELECT {PATH} p, AVG(s) avg_s, AVG(sc) avg_sc FROM ("
                " SELECT url, MAX(json_extract(props,'$.seconds')) s, MAX(json_extract(props,'$.scroll')) sc "
                " FROM events WHERE site_id=? AND type='engage' AND ts>=? GROUP BY json_extract(props,'$.pid')) GROUP BY p",
                (site_id, since))}
            clicks = {x["p"]: x["n"] for x in con.execute(
                f"SELECT {PATH} p, COUNT(*) n FROM events WHERE site_id=? AND type='autoclick' AND ts>=? GROUP BY p",
                (site_id, since))}
        return [{"path": v["p"], "views": v["views"], "visitors": v["visitors"],
                 "avg_seconds": eng[v["p"]]["avg_s"] if v["p"] in eng else None,
                 "avg_scroll": eng[v["p"]]["avg_sc"] if v["p"] in eng else None,
                 "clicks": clicks.get(v["p"], 0)} for v in views]

    @r.get("/clicks")
    def clicks(site_id: str, days: int = 14, path: str = "", user=Depends(current_user)):
        since = _since(days)
        extra, args = (f" AND {PATH}=?", [path]) if path else ("", [])
        with db() as con:
            owned_site(con, site_id, user)
            rows = con.execute(
                "SELECT MAX(json_extract(props,'$.sel')) sel, MAX(json_extract(props,'$.text')) text, "
                "MAX(json_extract(props,'$.tag')) tag, MAX(json_extract(props,'$.href')) href, "
                "MAX(json_extract(props,'$.outbound')) outbound, MAX(json_extract(props,'$.download')) download, "
                "COUNT(*) n, COUNT(DISTINCT visitor_id) v FROM events "
                f"WHERE site_id=? AND type='autoclick' AND ts>=?{extra} "
                "GROUP BY json_extract(props,'$.key') ORDER BY n DESC LIMIT 50",
                [site_id, since] + args).fetchall()
            rage = con.execute(
                "SELECT MAX(json_extract(props,'$.sel')) sel, MAX(json_extract(props,'$.text')) text, COUNT(*) n, "
                "COUNT(DISTINCT visitor_id) v FROM events "
                f"WHERE site_id=? AND type='rage' AND ts>=?{extra} "
                "GROUP BY json_extract(props,'$.key') ORDER BY n DESC LIMIT 20",
                [site_id, since] + args).fetchall()
        return {"clicks": [dict(x) for x in rows], "rage": [dict(x) for x in rage]}

    @r.get("/scroll")
    def scroll(site_id: str, days: int = 14, user=Depends(current_user)):
        since = _since(days)
        with db() as con:
            owned_site(con, site_id, user)
            totals = {x["p"]: x["n"] for x in con.execute(
                f"SELECT {PATH} p, COUNT(DISTINCT json_extract(props,'$.pid')) n FROM events "
                "WHERE site_id=? AND type='pageview' AND ts>=? GROUP BY p", (site_id, since))}
            reach = con.execute(
                f"SELECT {PATH} p, json_extract(props,'$.depth') d, COUNT(DISTINCT json_extract(props,'$.pid')) n FROM events "
                "WHERE site_id=? AND type='scroll' AND ts>=? GROUP BY p, d", (site_id, since)).fetchall()
        out = {}
        for x in reach:
            out.setdefault(x["p"], {})[int(x["d"])] = x["n"]
        res = []
        for p, total in sorted(totals.items(), key=lambda kv: -kv[1])[:30]:
            if total <= 0:
                continue
            d = out.get(p, {})
            res.append({"path": p, "pageviews": total,
                        "reach": {str(k): min(1.0, d.get(k, 0) / total) for k in (25, 50, 75, 100)}})
        return res

    @r.get("/forms")
    def forms(site_id: str, days: int = 14, user=Depends(current_user)):
        since = _since(days)
        with db() as con:
            owned_site(con, site_id, user)
            rows = con.execute(
                f"SELECT json_extract(props,'$.form') f, {PATH} p, "
                "COUNT(DISTINCT CASE WHEN json_extract(props,'$.action')='start' THEN json_extract(props,'$.pid') END) starts, "
                "COUNT(DISTINCT CASE WHEN json_extract(props,'$.action')='submit' THEN json_extract(props,'$.pid') END) submits "
                "FROM events WHERE site_id=? AND type='form' AND ts>=? GROUP BY f, p ORDER BY starts DESC LIMIT 30",
                (site_id, since)).fetchall()
        return [{"form": x["f"], "path": x["p"], "starts": x["starts"], "submits": x["submits"],
                 "abandon": max(0, x["starts"] - x["submits"])} for x in rows]

    @r.get("/visitor-list")
    def visitor_list(site_id: str, days: int = 14, user=Depends(current_user)):
        since = _since(days)
        with db() as con:
            owned_site(con, site_id, user)
            rows = con.execute(
                "SELECT visitor_id, MIN(ts) first_seen, MAX(ts) last_seen, "
                "SUM(type='pageview') pageviews, COUNT(DISTINCT session_id) sessions, COUNT(*) events, "
                "MAX(is_returning) is_ret, MAX(visit_no) visits, "
                "SUM(type='autoclick') clicks, "
                "(SELECT json_extract(e2.props,'$.device') FROM events e2 WHERE e2.visitor_id=e.visitor_id "
                "  AND e2.site_id=e.site_id AND e2.type='pageview' ORDER BY e2.ts DESC LIMIT 1) device "
                "FROM events e WHERE site_id=? AND ts>=? GROUP BY visitor_id ORDER BY last_seen DESC LIMIT 100",
                (site_id, since)).fetchall()
        return [dict(x) for x in rows]

    @r.get("/visitors/{visitor_id}/timeline")
    def timeline(site_id: str, visitor_id: str, user=Depends(current_user)):
        with db() as con:
            owned_site(con, site_id, user)
            rows = con.execute(
                "SELECT ts, type, name, url, exp_id, variant, session_id, props FROM events "
                "WHERE site_id=? AND visitor_id=? ORDER BY ts DESC LIMIT 500", (site_id, visitor_id)).fetchall()
        return [{**{k: x[k] for k in ("ts", "type", "name", "url", "exp_id", "variant", "session_id")},
                 "props": json.loads(x["props"] or "{}")} for x in rows][::-1]

    @r.get("/live")
    def live(site_id: str, user=Depends(current_user)):
        with db() as con:
            owned_site(con, site_id, user)
            rows = con.execute(
                "SELECT ts, visitor_id, type, name, url, exp_id, variant, props FROM events "
                "WHERE site_id=? ORDER BY id DESC LIMIT 80", (site_id,)).fetchall()
            active = con.execute(
                "SELECT COUNT(DISTINCT visitor_id) n FROM events WHERE site_id=? AND ts>=?",
                (site_id, time.time() - 300)).fetchone()["n"]
        return {"active_now": active,
                "events": [{**{k: x[k] for k in ("ts", "visitor_id", "type", "name", "url", "exp_id", "variant")},
                            "props": json.loads(x["props"] or "{}")} for x in rows]}

    # ------------------------------------------------------------------ heatmaps
    with db() as _c:
        _c.execute("CREATE TABLE IF NOT EXISTS funnels (id TEXT PRIMARY KEY, site_id TEXT, name TEXT, steps TEXT, created REAL)")

    @r.get("/heatmap")
    def heatmap(site_id: str, path: str, days: int = 14, device: str = "", user=Depends(current_user)):
        """Click density bins + scroll-reach curve for one page. Bins are 2% of page width x 25px tall."""
        since = _since(days)
        dev_sql, dev_args = (" AND json_extract(props,'$.device')=?", [device]) if device in {"desktop", "tablet", "mobile"} else ("", [])
        with db() as con:
            owned_site(con, site_id, user)
            base = [site_id, since, path] + dev_args
            bins = con.execute(
                "SELECT CAST(json_extract(props,'$.x')/2 AS INTEGER) bx, CAST(json_extract(props,'$.y')/25 AS INTEGER) by_, COUNT(*) n "
                f"FROM events WHERE site_id=? AND type='autoclick' AND ts>=? AND {PATH}=? AND json_extract(props,'$.x') IS NOT NULL{dev_sql} "
                "GROUP BY bx, by_ ORDER BY n DESC LIMIT 4000", base).fetchall()
            dims = con.execute(
                "SELECT AVG(json_extract(props,'$.dw')) dw, AVG(json_extract(props,'$.dh')) dh, MAX(json_extract(props,'$.y')) maxy, COUNT(*) n "
                f"FROM events WHERE site_id=? AND type='autoclick' AND ts>=? AND {PATH}=? AND json_extract(props,'$.x') IS NOT NULL{dev_sql}", base).fetchone()
            pvs = con.execute(
                f"SELECT COUNT(*) n FROM events WHERE site_id=? AND type='pageview' AND ts>=? AND {PATH}=?{dev_sql}", base).fetchone()["n"]
            eng = con.execute(
                "SELECT MAX(json_extract(props,'$.scroll')) sc, MAX(json_extract(props,'$.vh')) vh FROM events "
                f"WHERE site_id=? AND type='engage' AND ts>=? AND {PATH}=?{dev_sql} GROUP BY json_extract(props,'$.pid')", base).fetchall()
        scrolls = [x["sc"] for x in eng if x["sc"] is not None]
        vhs = [x["vh"] for x in eng if x["vh"]]
        curve = [{"depth": d, "share": (sum(1 for v in scrolls if v >= d) / len(scrolls)) if scrolls else 0.0} for d in range(0, 101, 5)]
        dh = max(dims["dh"] or 0, (dims["maxy"] or 0) + 50, 600)
        return {
            "path": path, "device": device or None, "days": days, "pageviews": pvs, "clicks": dims["n"] or 0,
            "bin_x": 2, "bin_y": 25, "dw": round(dims["dw"] or 1280), "dh": round(min(dh, 30000)),
            "vh": round(statistics.median(vhs)) if vhs else None,
            "bins": [[x["bx"], x["by_"], x["n"]] for x in bins],
            "scroll": curve, "scroll_samples": len(scrolls),
        }

    # ------------------------------------------------------------------ funnels
    @r.get("/funnels")
    def list_funnels(site_id: str, user=Depends(current_user)):
        with db() as con:
            owned_site(con, site_id, user)
            rows = con.execute("SELECT * FROM funnels WHERE site_id=? ORDER BY created DESC", (site_id,)).fetchall()
        return [{"id": x["id"], "name": x["name"], "steps": json.loads(x["steps"])} for x in rows]

    @r.post("/funnels")
    def create_funnel(site_id: str, body: FunnelIn, user=Depends(current_user)):
        if not 2 <= len(body.steps) <= 8:
            raise HTTPException(422, "a funnel needs 2 to 8 steps")
        for st in body.steps:
            if st.type not in STEP_TYPES or st.match not in {"contains", "equals"}:
                raise HTTPException(422, f"bad step: {st.type}/{st.match}")
        fid = "fun_" + secrets.token_hex(5)
        with db() as con:
            owned_site(con, site_id, user)
            con.execute("INSERT INTO funnels VALUES (?,?,?,?,?)",
                        (fid, site_id, body.name, json.dumps([x.model_dump() for x in body.steps]), time.time()))
        return {"id": fid}

    @r.delete("/funnels/{fid}")
    def delete_funnel(site_id: str, fid: str, user=Depends(current_user)):
        with db() as con:
            owned_site(con, site_id, user)
            cur = con.execute("DELETE FROM funnels WHERE id=? AND site_id=?", (fid, site_id))
            if cur.rowcount == 0:
                raise HTTPException(404, "funnel not found")
        return {"ok": True}

    @r.get("/funnels/{fid}/results")
    def funnel_results(site_id: str, fid: str, days: int = 14, user=Depends(current_user)):
        """Ordered funnel: a visitor counts at step N only after completing steps 1..N-1 in order."""
        since = _since(days)
        with db() as con:
            owned_site(con, site_id, user)
            f = con.execute("SELECT * FROM funnels WHERE id=? AND site_id=?", (fid, site_id)).fetchone()
            if not f:
                raise HTTPException(404, "funnel not found")
            steps = json.loads(f["steps"])
            rows = con.execute(
                "SELECT visitor_id, ts, type, name, url, is_returning, props FROM events "
                "WHERE site_id=? AND ts>=? AND type IN ('pageview','autoclick','event','form') "
                "ORDER BY visitor_id, ts LIMIT 400000", (site_id, since))
            n = len(steps)
            reached = [0] * n
            by_seg = {"new": [0] * n, "returning": [0] * n}
            gaps = [[] for _ in range(n)]       # seconds between step i-1 and step i, per visitor
            cur_vis, ptr, last_ts, first_ret = None, 0, 0.0, 0

            for row in rows:
                if row["visitor_id"] != cur_vis:
                    cur_vis, ptr, last_ts = row["visitor_id"], 0, 0.0
                if ptr >= n:
                    continue
                props = json.loads(row["props"]) if row["type"] in ("autoclick", "form") and row["props"] else {}
                if _step_matches(steps[ptr], row["type"], row["name"], row["url"], props):
                    if ptr == 0:
                        first_ret = row["is_returning"]
                    reached[ptr] += 1
                    by_seg["returning" if first_ret else "new"][ptr] += 1
                    if ptr > 0:
                        gaps[ptr].append(row["ts"] - last_ts)
                    last_ts = row["ts"]
                    ptr += 1
        out = []
        for i, st in enumerate(steps):
            prev = reached[i - 1] if i else reached[0]
            out.append({
                "label": _default_label(st), "type": st["type"], "value": st["value"],
                "count": reached[i],
                "pct_of_first": (reached[i] / reached[0]) if reached[0] else 0.0,
                "pct_of_prev": (reached[i] / prev) if prev else 0.0,
                "lost": (prev - reached[i]) if i else 0,
                "median_seconds": statistics.median(gaps[i]) if gaps[i] else None,
                "new": by_seg["new"][i], "returning": by_seg["returning"][i],
            })
        worst = None
        for i in range(1, n):
            if out[i - 1]["count"] and (worst is None or out[i]["pct_of_prev"] < out[worst]["pct_of_prev"]):
                worst = i
        return {"id": fid, "name": f["name"], "days": days, "steps": out,
                "overall": (reached[-1] / reached[0]) if reached[0] else 0.0,
                "entered": reached[0], "completed": reached[-1], "biggest_drop_step": worst}

    return r
