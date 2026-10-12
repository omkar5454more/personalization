"""Scheduling, frequency caps, control group (holdout), IP rule, site settings and CSV exports."""
from datetime import datetime, timedelta, timezone

import pytest


def iso(delta_hours):
    return (datetime.now(timezone.utc) + timedelta(hours=delta_hours)).strftime("%Y-%m-%dT%H:%M:%SZ")


def make(client, site, **kw):
    body = {"name": "c", "frequency": "always", "actions": [{"type": "banner", "text": "hi"}], **kw}
    r = client.post(f"/api/sites/{site}/campaigns", json=body)
    return r


def run(client, cid):
    client.patch(f"/api/campaigns/{cid}/status", json={"status": "running"})


def served(client, site):
    return {c["id"]: c for c in client.get(f"/sdk/{site}.json").json()["campaigns"]}


def ev(vid, typ, **kw):
    return {"vid": vid, "sid": "s-" + vid, "type": typ, "visit_no": 1, "returning": False, **kw}


# ------------------------------------------------------------------ schedule
def test_schedule_validation(client, site):
    assert make(client, site, start_at=iso(2), end_at=iso(1)).status_code == 422          # ends before it starts
    assert make(client, site, start_at="next tuesday").status_code == 422
    assert make(client, site, start_at=iso(1), end_at=iso(5)).status_code == 200
    assert make(client, site, start_at="2026-10-20T09:30:00+05:30").status_code == 200     # offsets are fine
    assert make(client, site, start_at="", end_at="").status_code == 200


def test_schedule_window_controls_what_the_sdk_serves(client, site):
    future = make(client, site, name="future", start_at=iso(5)).json()["id"]
    past = make(client, site, name="past", end_at=iso(-5)).json()["id"]
    now = make(client, site, name="now", start_at=iso(-5), end_at=iso(5)).json()["id"]
    open_ = make(client, site, name="open").json()["id"]
    for c in (future, past, now, open_):
        run(client, c)
    got = served(client, site)
    assert now in got and open_ in got and future not in got and past not in got
    listing = {c["id"]: c for c in client.get(f"/api/sites/{site}/campaigns").json()}
    assert listing[future]["schedule_state"] == "scheduled" and listing[past]["schedule_state"] == "ended"
    assert listing[now]["schedule_state"] is None and listing[open_]["schedule_state"] is None


def test_experiments_can_be_scheduled_too(client, site):
    body = {"name": "sched", "goal": {"type": "event", "name": "x"}, "start_at": iso(5),
            "variants": [{"key": "control", "weight": 1}, {"key": "b", "weight": 1, "changes": [{"selector": "h1", "action": "text", "value": "B"}]}]}
    eid = client.post(f"/api/sites/{site}/experiments", json=body).json()["id"]
    client.patch(f"/api/experiments/{eid}/status", json={"status": "running"})
    assert not any(e["id"] == eid for e in client.get(f"/sdk/{site}.json").json()["experiments"])
    assert client.post(f"/api/sites/{site}/experiments", json={**body, "start_at": iso(3), "end_at": iso(1)}).status_code == 422


# ------------------------------------------------------------------ caps, priority, holdout validation
@pytest.mark.parametrize("field,val,ok", [("max_views", 3, True), ("max_views", 0, True), ("max_views", -1, False), ("max_views", 5000, False),
                                          ("cooldown_hours", 24, True), ("cooldown_hours", -1, False), ("priority", 100, True), ("priority", 101, False),
                                          ("holdout_pct", 0, True), ("holdout_pct", 51, False)])
def test_numeric_limits(client, site, field, val, ok):
    kw = {field: val}
    if field == "holdout_pct" and val:
        kw["goal"] = {"type": "event", "name": "x"}
    assert (make(client, site, **kw).status_code == 200) == ok


def test_holdout_needs_a_goal(client, site):
    assert make(client, site, holdout_pct=20).status_code == 422
    goal = client.post(f"/api/sites/{site}/goals", json={"name": "HG", "type": "event", "event_name": "hg"}).json()["id"]
    assert make(client, site, holdout_pct=20, goal_id=goal).status_code == 200
    assert make(client, site, holdout_pct=20, goal={"type": "event", "name": "x"}).status_code == 200


def test_ip_rule_validation(client, site):
    ok = ["203.0.113.7", "10.0.0.0/8", "192.168.1.10-192.168.1.50", "203.0.113.7, 10.0.0.0/8", "2001:db8::1", "2001:db8::/32"]
    bad = ["", "999.1.1.1", "10.0.0.0/40", "192.168.1.50-192.168.1.10", "not an ip", "1.2.3.4-"]
    for v in ok:
        assert make(client, site, rules=[{"field": "ip", "op": "in", "value": v}]).status_code == 200, v
    for v in bad:
        assert make(client, site, rules=[{"field": "ip", "op": "in", "value": v}]).status_code == 422, v
    assert make(client, site, rules=[{"field": "ip", "op": "contains", "value": "10.0.0.1"}]).status_code == 422
    assert make(client, site, rules=[{"field": "ip", "op": "neq", "value": "10.0.0.1"}]).status_code == 200


# ------------------------------------------------------------------ control group results
def test_holdout_results_compare_shown_with_control(client, site):
    goal = client.post(f"/api/sites/{site}/goals", json={"name": "HoldGoal", "type": "event", "event_name": "hold"}).json()["id"]
    cid = make(client, site, name="held", holdout_pct=30, goal_id=goal).json()["id"]
    run(client, cid)
    batch = []
    for i in range(700):                           # shown group: 20% convert
        v = f"sh{i}"
        batch += [ev(v, "impression", exp=cid, variant="shown")]
        if i < 140:
            batch += [ev(v, "goal", exp=cid, variant="shown", name="event")]
        if len(batch) > 40:
            assert client.post("/collect", json={"site": site, "events": batch}).status_code == 204; batch = []
    for i in range(300):                           # control group: 10% convert
        v = f"ct{i}"
        batch += [ev(v, "impression", exp=cid, variant="control")]
        if i < 30:
            batch += [ev(v, "goal", exp=cid, variant="control", name="event")]
        if len(batch) > 40:
            assert client.post("/collect", json={"site": site, "events": batch}).status_code == 204; batch = []
    client.post("/collect", json={"site": site, "events": batch})
    c = next(x for x in client.get(f"/api/sites/{site}/campaigns").json() if x["id"] == cid)
    r = c["control_results"]
    assert r["holdout_pct"] == 30 and not r["srm"]["flag"]
    shown = next(v for v in r["variants"] if v["variant"] == "shown")
    ctrl = next(v for v in r["variants"] if v["variant"] == "control")
    assert (ctrl["visitors"], ctrl["conversions"], shown["visitors"], shown["conversions"]) == (300, 30, 700, 140)
    assert shown["uplift"] == pytest.approx(1.0, abs=0.01) and r["significant"] and r["prob_beat_control"] > 0.99
    # the campaign headline numbers still count everything
    assert c["impressions"] == 1000 and c["conversions"] == 170


def test_campaigns_without_a_holdout_have_no_control_results(client, site):
    cid = make(client, site, name="plain").json()["id"]
    c = next(x for x in client.get(f"/api/sites/{site}/campaigns").json() if x["id"] == cid)
    assert c["control_results"] is None


# ------------------------------------------------------------------ settings
def test_new_site_settings_default_and_toggle(client, site):
    s = client.get(f"/sdk/{site}.json").json()["settings"]
    assert s["one_overlay"] is False and s["ga_events"] is False
    r = client.patch(f"/api/sites/{site}", json={"settings": {"ga_events": True, "one_overlay": True}})
    assert r.status_code == 200
    s = client.get(f"/sdk/{site}.json").json()["settings"]
    assert s["one_overlay"] is True and s["ga_events"] is True
    client.patch(f"/api/sites/{site}", json={"settings": {"ga_events": False, "one_overlay": False}})


def test_goal_names_are_in_the_sdk_config(client, site):
    gid = client.post(f"/api/sites/{site}/goals", json={"name": "Named goal", "type": "event", "event_name": "named"}).json()["id"]
    g = next(x for x in client.get(f"/sdk/{site}.json").json()["goals"] if x["id"] == gid)
    assert g["name"] == "Named goal"


# ------------------------------------------------------------------ CSV
def test_csv_exports(client, site):
    client.post(f"/api/sites/{site}/goals", json={"name": "=HYPERLINK(\"http://evil\")", "type": "event", "event_name": "evil"})
    r = client.get(f"/api/sites/{site}/goals/report.csv?days=30")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv") and "attachment" in r.headers["content-disposition"]
    lines = r.text.strip().splitlines()
    assert lines[0].startswith("goal,type,conversions,people,rate,value")
    assert any(l.startswith("\"'=HYPERLINK") or l.startswith("'=HYPERLINK") for l in lines), lines    # formula neutralised
    assert not any(l.startswith("=") for l in lines)

    make(client, site, name="+SUM(1)")
    r = client.get(f"/api/sites/{site}/campaigns.csv")
    assert r.status_code == 200 and r.text.splitlines()[0].startswith("campaign,status,shown_to")
    assert any(l.startswith("'+SUM(1)") for l in r.text.splitlines()) and not any(l.startswith("+SUM") for l in r.text.splitlines())

    exp = client.post(f"/api/sites/{site}/experiments", json={"name": "csv", "goal": {"type": "event", "name": "x"},
                      "variants": [{"key": "control", "weight": 1}, {"key": "b", "weight": 1, "changes": [{"selector": "h1", "action": "text", "value": "B"}]}]}).json()["id"]
    r = client.get(f"/api/experiments/{exp}/results.csv")
    assert r.status_code == 200 and r.text.splitlines()[0].startswith("version,visitors,conversions,rate")
    assert len(r.text.strip().splitlines()) == 3


def test_csv_requires_ownership(client, site):
    from fastapi.testclient import TestClient
    from backend.main import app
    with TestClient(app) as other:
        other.post("/api/auth/register", json={"email": "csv-intruder@example.com", "password": "csv intruder pass 1"})
        assert other.get(f"/api/sites/{site}/campaigns.csv").status_code == 404
        assert other.get(f"/api/sites/{site}/goals/report.csv").status_code == 404
