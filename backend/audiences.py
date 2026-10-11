"""Audience segments and site-wide goals.

* Segment  = a named, reusable set of targeting rules ("Returning mobile visitors from Google"). Campaigns and
             A/B tests point at a segment instead of repeating the rules; the SDK config inlines the rules.
* Goal     = one definition of a conversion (click / page visit / custom event / form submit, optional value).
             The SDK reports every goal site-wide as a `conversion` event; the report shows conversions, revenue
             and which campaigns / tests the converting visitors had seen.
"""
import json
import time
from collections import defaultdict
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.rules import Rule, clean_rules, validate_rules

GOAL_TYPES = {"click", "pageview", "event", "form"}
MAX_SEGMENTS = 100
MAX_GOALS = 50


class SegmentIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=300)
    match: str = "all"
    rules: list[Rule] = []


class GoalIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    type: str                                         # click | pageview | event | form
    selector: str = Field(default="", max_length=300)  # click: CSS selector
    url_contains: str = Field(default="", max_length=300)  # pageview
    event_name: str = Field(default="", max_length=100)    # event: the name passed to OT.track()
    form_name: str = Field(default="", max_length=100)     # form: the form's id / name / action
    value: float = Field(default=0, ge=0, le=10_000_000)   # value of one conversion (revenue, lead worth...)
    count_mode: str = "once"                               # once per visitor | every conversion


def validate_goal(g: GoalIn) -> None:
    if g.type not in GOAL_TYPES:
        raise HTTPException(422, "goal type must be click, pageview, event or form")
    need = {"click": g.selector, "pageview": g.url_contains, "event": g.event_name, "form": g.form_name}[g.type]
    if not need.strip():
        raise HTTPException(422, {"click": "a click goal needs a CSS selector", "pageview": "a page goal needs part of the URL",
                                  "event": "an event goal needs the event name", "form": "a form goal needs the form's name"}[g.type])
    if g.count_mode not in {"once", "every"}:
        raise HTTPException(422, "count_mode must be once or every")


def goal_row(r) -> dict:
    return {"id": r["id"], "name": r["name"], "type": r["type"], "selector": r["selector"] or "",
            "url_contains": r["url_contains"] or "", "event_name": r["event_name"] or "", "form_name": r["form_name"] or "",
            "value": r["value"] or 0, "count_mode": r["count_mode"] or "once", "archived": bool(r["archived"])}


def segment_row(r) -> dict:
    return {"id": r["id"], "name": r["name"], "description": r["description"] or "", "match": r["match"] or "all",
            "rules": json.loads(r["rules"] or "[]"), "created": r["created"]}


def goal_as_test_goal(g: dict) -> dict:
    """The shape an experiment/campaign `goal` uses (see main.Goal) built from a central goal."""
    return {"type": g["type"], "selector": g["selector"], "url_contains": g["url_contains"],
            "name": g["event_name"], "form_name": g["form_name"]}


def build_router(db, current_user, owned_site, new_id) -> APIRouter:
    r = APIRouter(prefix="/api/sites/{site_id}")

    # ------------------------------------------------------------ segments
    @r.get("/segments")
    def list_segments(site_id: str, user=Depends(current_user)):
        with db() as con:
            owned_site(con, site_id, user)
            rows = con.execute("SELECT * FROM segments WHERE site_id=? ORDER BY created", (site_id,)).fetchall()
            # how many campaigns / tests use each segment, so deleting one is an informed decision
            use = defaultdict(int)
            for tbl in ("campaigns", "experiments"):
                for c in con.execute(f"SELECT config FROM {tbl} WHERE site_id=?", (site_id,)).fetchall():
                    sid = (json.loads(c["config"]) or {}).get("segment_id")
                    if sid:
                        use[sid] += 1
        return [{**segment_row(x), "used_by": use.get(x["id"], 0)} for x in rows]

    @r.post("/segments")
    def create_segment(site_id: str, body: SegmentIn, user=Depends(current_user)):
        validate_rules(body.rules, body.match)
        if not body.rules:
            raise HTTPException(422, "add at least one rule — a segment with no rules would be everyone")
        sid = new_id("seg")
        with db() as con:
            owned_site(con, site_id, user)
            if con.execute("SELECT COUNT(*) c FROM segments WHERE site_id=?", (site_id,)).fetchone()["c"] >= MAX_SEGMENTS:
                raise HTTPException(429, f"limit of {MAX_SEGMENTS} segments per site")
            if con.execute("SELECT 1 FROM segments WHERE site_id=? AND lower(name)=lower(?)", (site_id, body.name.strip())).fetchone():
                raise HTTPException(409, "a segment with this name already exists")
            con.execute("INSERT INTO segments VALUES (?,?,?,?,?,?,?)",
                        (sid, site_id, body.name.strip(), body.description.strip(), body.match,
                         json.dumps([x.model_dump() for x in clean_rules(body.rules)]), time.time()))
        return {"id": sid}

    @r.put("/segments/{seg_id}")
    def update_segment(site_id: str, seg_id: str, body: SegmentIn, user=Depends(current_user)):
        validate_rules(body.rules, body.match)
        if not body.rules:
            raise HTTPException(422, "add at least one rule")
        with db() as con:
            owned_site(con, site_id, user)
            dup = con.execute("SELECT id FROM segments WHERE site_id=? AND lower(name)=lower(?)", (site_id, body.name.strip())).fetchone()
            if dup and dup["id"] != seg_id:
                raise HTTPException(409, "a segment with this name already exists")
            cur = con.execute("UPDATE segments SET name=?, description=?, match=?, rules=? WHERE id=? AND site_id=?",
                              (body.name.strip(), body.description.strip(), body.match,
                               json.dumps([x.model_dump() for x in clean_rules(body.rules)]), seg_id, site_id))
            if cur.rowcount == 0:
                raise HTTPException(404, "segment not found")
        return {"id": seg_id}

    @r.delete("/segments/{seg_id}")
    def delete_segment(site_id: str, seg_id: str, user=Depends(current_user)):
        with db() as con:
            owned_site(con, site_id, user)
            # campaigns/tests that point at it keep working: they fall back to the rules they were saved with
            cur = con.execute("DELETE FROM segments WHERE id=? AND site_id=?", (seg_id, site_id))
            if cur.rowcount == 0:
                raise HTTPException(404, "segment not found")
        return {"ok": True}

    # ------------------------------------------------------------ goals
    @r.get("/goals")
    def list_goals(site_id: str, user=Depends(current_user)):
        with db() as con:
            owned_site(con, site_id, user)
            rows = con.execute("SELECT * FROM goals WHERE site_id=? ORDER BY created", (site_id,)).fetchall()
        return [goal_row(x) for x in rows]

    @r.post("/goals")
    def create_goal(site_id: str, body: GoalIn, user=Depends(current_user)):
        validate_goal(body)
        gid = new_id("goal")
        with db() as con:
            owned_site(con, site_id, user)
            if con.execute("SELECT COUNT(*) c FROM goals WHERE site_id=? AND archived=0", (site_id,)).fetchone()["c"] >= MAX_GOALS:
                raise HTTPException(429, f"limit of {MAX_GOALS} goals per site")
            con.execute("INSERT INTO goals (id,site_id,name,type,selector,url_contains,event_name,form_name,value,count_mode,archived,created) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,0,?)",
                        (gid, site_id, body.name.strip(), body.type, body.selector.strip(), body.url_contains.strip(),
                         body.event_name.strip(), body.form_name.strip(), body.value, body.count_mode, time.time()))
        return {"id": gid}

    @r.put("/goals/{goal_id}")
    def update_goal(site_id: str, goal_id: str, body: GoalIn, user=Depends(current_user)):
        validate_goal(body)
        with db() as con:
            owned_site(con, site_id, user)
            cur = con.execute("UPDATE goals SET name=?, type=?, selector=?, url_contains=?, event_name=?, form_name=?, value=?, count_mode=? "
                              "WHERE id=? AND site_id=?",
                              (body.name.strip(), body.type, body.selector.strip(), body.url_contains.strip(), body.event_name.strip(),
                               body.form_name.strip(), body.value, body.count_mode, goal_id, site_id))
            if cur.rowcount == 0:
                raise HTTPException(404, "goal not found")
        return {"id": goal_id}

    @r.delete("/goals/{goal_id}")
    def archive_goal(site_id: str, goal_id: str, user=Depends(current_user)):
        """Archive, never delete: past conversions stay in the reports and tests that were created from the goal keep running."""
        with db() as con:
            owned_site(con, site_id, user)
            cur = con.execute("UPDATE goals SET archived=1 WHERE id=? AND site_id=?", (goal_id, site_id))
            if cur.rowcount == 0:
                raise HTTPException(404, "goal not found")
        return {"ok": True}

    @r.get("/goals/report")
    def goals_report(site_id: str, days: int = 30, user=Depends(current_user)):
        """Per goal: conversions, converting visitors, rate, value, daily trend and what the converters had been shown."""
        days = max(1, min(int(days), 90))
        since = time.time() - days * 86400
        with db() as con:
            owned_site(con, site_id, user)
            goals = [goal_row(x) for x in con.execute("SELECT * FROM goals WHERE site_id=? ORDER BY created", (site_id,)).fetchall()]
            visitors = con.execute("SELECT COUNT(DISTINCT visitor_id) n FROM events WHERE site_id=? AND type='pageview' AND ts>=?",
                                   (site_id, since)).fetchone()["n"] or 0
            conv_rows = con.execute(
                "SELECT name gid, visitor_id v, COUNT(*) n, MIN(ts) first_ts, SUM(COALESCE(json_extract(props,'$.value'),0)) val "
                "FROM events WHERE site_id=? AND type='conversion' AND ts>=? GROUP BY name, visitor_id", (site_id, since)).fetchall()
            daily_rows = con.execute(
                "SELECT name gid, date(ts,'unixepoch') d, COUNT(*) n, COUNT(DISTINCT visitor_id) v, SUM(COALESCE(json_extract(props,'$.value'),0)) val "
                "FROM events WHERE site_id=? AND type='conversion' AND ts>=? GROUP BY name, d ORDER BY d", (site_id, since)).fetchall()
            expo_rows = con.execute(
                "SELECT exp_id, variant, visitor_id v, MIN(ts) first_ts FROM events "
                "WHERE site_id=? AND type IN ('impression','exposure') AND exp_id IS NOT NULL AND ts>=? "
                "GROUP BY exp_id, variant, visitor_id LIMIT 200000", (site_id, since)).fetchall()
            names = {}
            for tbl in ("campaigns", "experiments"):
                for c in con.execute(f"SELECT id, name FROM {tbl} WHERE site_id=?", (site_id,)).fetchall():
                    names[c["id"]] = (c["name"], "campaign" if tbl == "campaigns" else "test")

        conv_by_goal = defaultdict(dict)
        for x in conv_rows:
            conv_by_goal[x["gid"]][x["v"]] = {"n": x["n"], "first": x["first_ts"], "val": x["val"] or 0}
        daily_by_goal = defaultdict(list)
        for x in daily_rows:
            daily_by_goal[x["gid"]].append({"d": x["d"], "conversions": x["n"], "visitors": x["v"], "value": x["val"] or 0})
        exposed = defaultdict(dict)                        # (exp_id, variant) -> {visitor: first exposure ts}
        for x in expo_rows:
            exposed[(x["exp_id"], x["variant"])][x["v"]] = x["first_ts"]

        out = []
        for g in goals:
            conv = conv_by_goal.get(g["id"], {})
            converters = len(conv)
            total = sum(c["n"] for c in conv.values())
            value = sum(c["val"] for c in conv.values())
            assists = []
            for (eid, variant), seen in exposed.items():
                if eid not in names or not seen:
                    continue
                n_exp = len(seen)
                # only conversions that happened AFTER the visitor was shown it can be credited to it
                conv_after = sum(1 for vid, t0 in seen.items() if vid in conv and conv[vid]["first"] >= t0)
                rest_n = max(visitors - n_exp, 0)
                rest_conv = sum(1 for vid in conv if vid not in seen)
                rate_exp = conv_after / n_exp if n_exp else 0.0
                rate_rest = rest_conv / rest_n if rest_n else None
                if n_exp < 5 and not conv_after:
                    continue
                assists.append({"id": eid, "name": names[eid][0], "kind": names[eid][1], "variant": variant,
                                "exposed": n_exp, "converted": conv_after, "rate": rate_exp,
                                "rate_not_shown": rate_rest,
                                "lift": (rate_exp / rate_rest - 1) if rate_rest else None})
            assists.sort(key=lambda a: (a["converted"], a["exposed"]), reverse=True)
            out.append({**g, "conversions": total, "converters": converters,
                        "rate": (converters / visitors) if visitors else 0.0, "value": value,
                        "daily": daily_by_goal.get(g["id"], []), "influenced_by": assists[:8]})
        return {"days": days, "visitors": visitors, "goals": out,
                "note": "“Shown vs not shown” compares visitors who saw a campaign with those who didn't; they are not randomly "
                        "chosen, so treat it as a hint. Only an A/B test (randomised) proves cause."}

    return r
