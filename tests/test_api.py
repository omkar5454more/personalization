"""API-level tests: segments, goals, targeting rules, A/B tests (multi-variant, audiences, auto-winner) and the goals report."""
import time

import pytest

from backend.database import db


def collect(client, site, events):
    r = client.post("/collect", json={"site": site, "host": "example.com", "events": events})
    assert r.status_code == 204, r.text


def ev(vid, typ, **kw):
    return {"vid": vid, "sid": "s-" + vid, "type": typ, "visit_no": 1, "returning": False, **kw}


# ------------------------------------------------------------------ rules
def test_rules_accept_new_fields_and_ops_and_reject_bad_ones(client, site):
    ok = {"name": "ok", "rules": [{"field": "referrer_host", "op": "in", "value": "google.com, bing.com"},
                                  {"field": "attr.plan", "op": "eq", "value": "pro"},
                                  {"field": "pages_viewed", "op": "gte", "value": "3"},
                                  {"field": "did_event", "op": "eq", "value": "purchase"}],
          "actions": [{"type": "banner", "text": "hi"}]}
    assert client.post(f"/api/sites/{site}/campaigns", json=ok).status_code == 200
    bad_cases = [
        {"field": "nonsense", "op": "eq", "value": "x"},
        {"field": "attr.bad name", "op": "eq", "value": "x"},
        {"field": "device", "op": "regex", "value": "x"},
        {"field": "visit_no", "op": "gte", "value": "three"},
        {"field": "referrer_host", "op": "in", "value": " , "},
        {"field": "did_event", "op": "eq", "value": ""},
    ]
    for rule in bad_cases:
        r = client.post(f"/api/sites/{site}/campaigns", json={**ok, "rules": [rule]})
        assert r.status_code == 422, (rule, r.text)
    too_many = [{"field": "device", "op": "eq", "value": "mobile"}] * 11
    assert client.post(f"/api/sites/{site}/campaigns", json={**ok, "rules": too_many}).status_code == 422


# ------------------------------------------------------------------ segments
def test_segment_crud_and_validation(client, site):
    body = {"name": "Mobile from Google", "description": "x", "match": "all",
            "rules": [{"field": "device", "op": "eq", "value": "mobile"}, {"field": "referrer_host", "op": "contains", "value": "google"}]}
    sid = client.post(f"/api/sites/{site}/segments", json=body).json()["id"]
    assert client.post(f"/api/sites/{site}/segments", json=body).status_code == 409           # duplicate name
    assert client.post(f"/api/sites/{site}/segments", json={**body, "name": "empty", "rules": []}).status_code == 422
    assert client.post(f"/api/sites/{site}/segments", json={**body, "name": "bad", "match": "most"}).status_code == 422
    seg = next(x for x in client.get(f"/api/sites/{site}/segments").json() if x["id"] == sid)
    assert len(seg["rules"]) == 2 and seg["used_by"] == 0
    assert client.put(f"/api/sites/{site}/segments/{sid}", json={**body, "match": "any"}).status_code == 200
    assert client.delete(f"/api/sites/{site}/segments/nope").status_code == 404
    assert client.delete(f"/api/sites/{site}/segments/{sid}").status_code == 200


def test_campaign_segment_is_inlined_into_sdk_config_and_follows_edits(client, site):
    seg = client.post(f"/api/sites/{site}/segments", json={"name": "Returning", "rules": [{"field": "returning", "op": "eq", "value": "true"}]}).json()["id"]
    cid = client.post(f"/api/sites/{site}/campaigns", json={"name": "Seg campaign", "segment_id": seg, "frequency": "always",
                                                          "rules": [{"field": "device", "op": "eq", "value": "desktop"}],
                                                          "actions": [{"type": "banner", "text": "hi"}]}).json()["id"]
    client.patch(f"/api/campaigns/{cid}/status", json={"status": "running"})
    cfg = client.get(f"/sdk/{site}.json").json()
    camp = next(c for c in cfg["campaigns"] if c["id"] == cid)
    assert camp["rules"] == [{"field": "returning", "op": "eq", "value": "true"}]              # segment rules win
    client.put(f"/api/sites/{site}/segments/{seg}", json={"name": "Returning", "rules": [{"field": "visit_no", "op": "gte", "value": "2"}]})
    camp = next(c for c in client.get(f"/sdk/{site}.json").json()["campaigns"] if c["id"] == cid)
    assert camp["rules"][0]["field"] == "visit_no"                                              # edits propagate
    assert next(x for x in client.get(f"/api/sites/{site}/segments").json() if x["id"] == seg)["used_by"] == 1
    client.delete(f"/api/sites/{site}/segments/{seg}")                                          # deleted: falls back to saved rules
    camp = next(c for c in client.get(f"/sdk/{site}.json").json()["campaigns"] if c["id"] == cid)
    assert camp["rules"][0]["field"] == "device"
    assert client.post(f"/api/sites/{site}/campaigns", json={"name": "x", "segment_id": "seg_missing",
                                                            "actions": [{"type": "banner", "text": "hi"}]}).status_code == 422


# ------------------------------------------------------------------ goals
def test_goal_validation_and_archive(client, site):
    assert client.post(f"/api/sites/{site}/goals", json={"name": "g", "type": "click"}).status_code == 422
    assert client.post(f"/api/sites/{site}/goals", json={"name": "g", "type": "scroll"}).status_code == 422
    assert client.post(f"/api/sites/{site}/goals", json={"name": "g", "type": "event", "event_name": "x", "count_mode": "sometimes"}).status_code == 422
    gid = client.post(f"/api/sites/{site}/goals", json={"name": "Buy", "type": "event", "event_name": "purchase", "value": 49.5, "count_mode": "every"}).json()["id"]
    g = next(x for x in client.get(f"/api/sites/{site}/goals").json() if x["id"] == gid)
    assert g["value"] == 49.5 and g["count_mode"] == "every" and g["archived"] is False
    assert any(x["id"] == gid for x in client.get(f"/sdk/{site}.json").json()["goals"])
    client.delete(f"/api/sites/{site}/goals/{gid}")
    assert not any(x["id"] == gid for x in client.get(f"/sdk/{site}.json").json()["goals"])     # archived goals leave the SDK
    assert next(x for x in client.get(f"/api/sites/{site}/goals").json() if x["id"] == gid)["archived"] is True


def test_goals_report_counts_value_and_attributes_to_campaigns(client, site):
    gid = client.post(f"/api/sites/{site}/goals", json={"name": "Signup", "type": "event", "event_name": "signup", "value": 10}).json()["id"]
    cid = client.post(f"/api/sites/{site}/campaigns", json={"name": "Attributed", "actions": [{"type": "banner", "text": "hi"}]}).json()["id"]
    # 10 visitors saw the campaign; 4 of them converted afterwards. 10 others never saw it; 1 of them converted.
    for i in range(10):
        v = f"seen{i}"
        collect(client, site, [ev(v, "pageview"), ev(v, "impression", exp=cid, variant="shown")])
        time.sleep(0.002)
        if i < 4:
            collect(client, site, [ev(v, "conversion", name=gid, props={"value": 10})])
    for i in range(10):
        v = f"other{i}"
        collect(client, site, [ev(v, "pageview")])
        if i == 0:
            collect(client, site, [ev(v, "conversion", name=gid, props={"value": 10})])
    rep = client.get(f"/api/sites/{site}/goals/report?days=30").json()
    g = next(x for x in rep["goals"] if x["id"] == gid)
    assert g["conversions"] == 5 and g["converters"] == 5 and g["value"] == 50
    assert g["rate"] == pytest.approx(5 / rep["visitors"])
    a = next(x for x in g["influenced_by"] if x["id"] == cid)
    assert a["exposed"] == 10 and a["converted"] == 4 and a["kind"] == "campaign"
    assert a["lift"] is not None and a["lift"] > 1            # 40% vs ~5% among those not shown
    assert len(g["daily"]) >= 1


def test_conversion_before_exposure_is_not_credited(client, site):
    gid = client.post(f"/api/sites/{site}/goals", json={"name": "Early", "type": "event", "event_name": "early"}).json()["id"]
    cid = client.post(f"/api/sites/{site}/campaigns", json={"name": "Late", "actions": [{"type": "banner", "text": "hi"}]}).json()["id"]
    for i in range(6):
        v = f"early{i}"
        collect(client, site, [ev(v, "pageview"), ev(v, "conversion", name=gid, props={"value": 0})])
        time.sleep(0.002)
        collect(client, site, [ev(v, "impression", exp=cid, variant="shown")])
    g = next(x for x in client.get(f"/api/sites/{site}/goals/report?days=30").json()["goals"] if x["id"] == gid)
    a = next(x for x in g["influenced_by"] if x["id"] == cid)
    assert a["exposed"] == 6 and a["converted"] == 0


# ------------------------------------------------------------------ A/B tests
def test_experiment_with_saved_goal_audience_and_multiple_variants(client, site):
    goal = client.post(f"/api/sites/{site}/goals", json={"name": "Click buy", "type": "click", "selector": "#buy"}).json()["id"]
    seg = client.post(f"/api/sites/{site}/segments", json={"name": "Mobile", "rules": [{"field": "device", "op": "eq", "value": "mobile"}]}).json()["id"]
    body = {"name": "Three-way", "traffic": 100, "goal_id": goal, "segment_id": seg,
            "variants": [{"key": "control", "weight": 40}, {"key": "b", "weight": 30, "changes": [{"selector": "h1", "action": "text", "value": "B"}]},
                         {"key": "c", "weight": 30, "changes": [{"selector": "h1", "action": "text", "value": "C"}]}]}
    r = client.post(f"/api/sites/{site}/experiments", json=body)
    assert r.status_code == 200, r.text
    eid = r.json()["id"]
    exp = next(e for e in client.get(f"/api/sites/{site}/experiments").json() if e["id"] == eid)
    assert exp["config"]["goal"] == {"type": "click", "selector": "#buy", "url_contains": "", "name": "", "form_name": ""}  # copied from the saved goal
    client.patch(f"/api/experiments/{eid}/status", json={"status": "running"})
    cfg = next(e for e in client.get(f"/sdk/{site}.json").json()["experiments"] if e["id"] == eid)
    assert cfg["rules"] == [{"field": "device", "op": "eq", "value": "mobile"}] and len(cfg["variants"]) == 3
    # validation
    assert client.post(f"/api/sites/{site}/experiments", json={**body, "goal_id": "goal_missing"}).status_code == 422
    assert client.post(f"/api/sites/{site}/experiments", json={k: v for k, v in body.items() if k not in ("goal_id",)}).status_code == 422  # no goal at all
    seven = [{"key": f"v{i}", "weight": 10} for i in range(7)]
    assert client.post(f"/api/sites/{site}/experiments", json={**body, "variants": seven}).status_code == 422
    # editing the saved goal later must NOT change a test already collecting data
    client.put(f"/api/sites/{site}/goals/{goal}", json={"name": "Click buy", "type": "click", "selector": "#changed"})
    exp = next(e for e in client.get(f"/api/sites/{site}/experiments").json() if e["id"] == eid)
    assert exp["config"]["goal"]["selector"] == "#buy"


def make_test(client, site, **extra):
    body = {"name": "T", "goal": {"type": "event", "name": "win"},
            "variants": [{"key": "control", "weight": 50}, {"key": "b", "weight": 50, "changes": [{"selector": "h1", "action": "text", "value": "B"}]}], **extra}
    r = client.post(f"/api/sites/{site}/experiments", json=body)
    assert r.status_code == 200, r.text
    eid = r.json()["id"]
    client.patch(f"/api/experiments/{eid}/status", json={"status": "running"})
    return eid


def feed(client, site, eid, variant, visitors, converters, prefix):
    batch = []
    for i in range(visitors):
        v = f"{prefix}{variant}{i}"
        batch.append(ev(v, "exposure", exp=eid, variant=variant))
        if i < converters:
            batch.append(ev(v, "goal", exp=eid, variant=variant, name="event"))
        if len(batch) >= 40:
            collect(client, site, batch); batch = []
    if batch:
        collect(client, site, batch)


def test_results_include_ci_prob_and_recommendation(client, site):
    eid = make_test(client, site, min_visitors=50, min_days=0)
    feed(client, site, eid, "control", 400, 40, "r1")
    feed(client, site, eid, "b", 400, 80, "r1")
    res = client.get(f"/api/experiments/{eid}/results").json()
    b = next(v for v in res["variants"] if v["variant"] == "b")
    assert b["significant"] and b["prob_beat_control"] > 0.99 and b["ci_low"] < b["rate"] < b["ci_high"]
    assert res["srm"]["flag"] is False and res["winner"] == "b" and "winner" in res["recommendation"].lower()
    assert res["status"] == "running"                          # auto-winner was not requested
    assert res["needed_per_variant"] and res["baseline_rate"] == pytest.approx(0.1)


def test_results_flag_sample_ratio_mismatch(client, site):
    eid = make_test(client, site, min_visitors=10, min_days=0)
    feed(client, site, eid, "control", 600, 60, "srm")
    feed(client, site, eid, "b", 380, 40, "srm")                   # 61/39 instead of 50/50
    res = client.get(f"/api/experiments/{eid}/results").json()
    assert res["srm"]["flag"] is True and res["winner"] is None and "mismatch" in res["recommendation"].lower()


def test_auto_winner_completes_the_test_and_can_ship_the_winner(client, site):
    eid = make_test(client, site, auto_winner=True, ship_winner=True, min_visitors=100, min_days=0)
    feed(client, site, eid, "control", 500, 50, "auto")
    feed(client, site, eid, "b", 500, 110, "auto")
    res = client.get(f"/api/experiments/{eid}/results").json()
    assert res["status"] == "completed" and res["winner"] == "b" and res["completed_reason"] == "auto"
    exp = next(e for e in client.get(f"/api/sites/{site}/experiments").json() if e["id"] == eid)
    assert exp["status"] == "completed" and exp["config"]["winner"] == "b"
    cfg = next(e for e in client.get(f"/sdk/{site}.json").json()["experiments"] if e["id"] == eid)
    assert cfg["rollout"] == "b"                                    # still served, now to everyone


def test_completed_test_is_not_shipped_unless_asked(client, site):
    eid = make_test(client, site)
    r = client.post(f"/api/experiments/{eid}/winner", json={"variant": "b"})
    assert r.status_code == 200 and r.json()["winner"] == "b"
    assert not any(e["id"] == eid for e in client.get(f"/sdk/{site}.json").json()["experiments"])
    assert client.post(f"/api/experiments/{eid}/winner", json={"variant": "zzz"}).status_code == 422


def test_secondary_goal_results(client, site):
    sec = client.post(f"/api/sites/{site}/goals", json={"name": "Newsletter", "type": "event", "event_name": "nl"}).json()["id"]
    eid = make_test(client, site, secondary_goal_ids=[sec], min_visitors=1, min_days=0)
    feed(client, site, eid, "control", 50, 0, "sg")
    feed(client, site, eid, "b", 50, 0, "sg")
    for i in range(10):
        collect(client, site, [ev(f"sgb{i}", "conversion", name=sec, props={"value": 0})])
    for i in range(3):
        collect(client, site, [ev(f"sgcontrol{i}", "conversion", name=sec, props={"value": 0})])
    res = client.get(f"/api/experiments/{eid}/results").json()
    s = res["secondary"][0]
    by = {v["variant"]: v for v in s["variants"]}
    assert s["name"] == "Newsletter" and by["b"]["converters"] == 10 and by["control"]["converters"] == 3
    assert by["b"]["rate"] == pytest.approx(0.2)


# ------------------------------------------------------------------ isolation
def test_other_users_cannot_touch_segments_or_goals(client, site):
    from fastapi.testclient import TestClient
    from backend.main import app
    with TestClient(app) as other:
        assert other.post("/api/auth/register", json={"email": "intruder@example.com", "password": "another long pass"}).status_code == 200
        assert other.get(f"/api/sites/{site}/segments").status_code == 404
        assert other.post(f"/api/sites/{site}/goals", json={"name": "x", "type": "event", "event_name": "x"}).status_code == 404
        assert other.get(f"/api/sites/{site}/goals/report").status_code == 404


# ------------------------------------------------------------------ banner design
def test_banner_design_fields_are_saved_and_validated(client, site):
    design = {"type": "banner", "text": "Sale", "bg": "#112233", "fg": "#ffffff", "font_size": 20, "align": "left", "size": "large",
              "radius": 12, "bold": True, "closable": False, "cta_text": "Go", "cta_url": "/offer", "cta_bg": "#ff0000", "cta_fg": "#ffffff"}
    cid = client.post(f"/api/sites/{site}/campaigns", json={"name": "Designed", "actions": [design]}).json()["id"]
    client.patch(f"/api/campaigns/{cid}/status", json={"status": "running"})
    a = next(c for c in client.get(f"/sdk/{site}.json").json()["campaigns"] if c["id"] == cid)["actions"][0]
    assert (a["font_size"], a["align"], a["size"], a["radius"], a["bold"], a["closable"], a["cta_bg"]) == (20, "left", "large", 12, True, False, "#ff0000")
    for bad in ({"align": "justify"}, {"size": "huge"}, {"font_size": 99}, {"radius": -1}, {"cta_bg": "red"}, {"cta_fg": "#12"}):
        r = client.post(f"/api/sites/{site}/campaigns", json={"name": "bad", "actions": [{**design, **bad}]})
        assert r.status_code == 422, (bad, r.status_code)
    # old campaigns (saved before these fields existed) still load with the original look
    old = client.post(f"/api/sites/{site}/campaigns", json={"name": "Old", "actions": [{"type": "banner", "text": "hi"}]}).json()["id"]
    a = next(c for c in client.get(f"/api/sites/{site}/campaigns").json() if c["id"] == old)["config"]["actions"][0]
    assert (a["font_size"], a["align"], a["size"], a["radius"], a["closable"], a["cta_bg"]) == (15, "center", "medium", 0, True, "")


def test_sdk_config_cache_is_short(client, site):
    cc = client.get(f"/sdk/{site}.json").headers["cache-control"]
    assert "s-maxage=20" in cc
