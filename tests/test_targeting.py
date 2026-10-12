"""Targeting rules (new fields, groups), campaign triggers, page scope, redirect and geo labels."""
import pytest

from backend import geo


def camp(client, site, **kw):
    body = {"name": "t", "actions": [{"type": "banner", "text": "hi"}], **kw}
    return client.post(f"/api/sites/{site}/campaigns", json=body)


# ------------------------------------------------------------------ rules
@pytest.mark.parametrize("rule", [
    {"field": "region", "op": "eq", "value": "Maharashtra"}, {"field": "city", "op": "in", "value": "Mumbai, Pune"},
    {"field": "traffic_source", "op": "eq", "value": "organic"}, {"field": "total_pageviews", "op": "gte", "value": "3"},
    {"field": "visited_page", "op": "eq", "value": "/pricing"}, {"field": "visited_page", "op": "neq", "value": "/pricing"},
    {"field": "param.coupon", "op": "eq", "value": "SAVE10"}, {"field": "cookie.tier", "op": "eq", "value": "gold"},
    {"field": "var.user.plan", "op": "eq", "value": "vip"}, {"field": "var.dataLayer", "op": "contains", "value": "x"},
])
def test_new_rule_fields_are_accepted(client, site, rule):
    assert camp(client, site, rules=[rule]).status_code == 200


@pytest.mark.parametrize("rule", [
    {"field": "param.", "op": "eq", "value": "x"}, {"field": "param.a b", "op": "eq", "value": "x"},
    {"field": "cookie.bad name", "op": "eq", "value": "x"}, {"field": "var.1abc", "op": "eq", "value": "x"},
    {"field": "var.a.b.c.d.e.f.g", "op": "eq", "value": "x"}, {"field": "var.window()", "op": "eq", "value": "x"},
    {"field": "visited_page", "op": "gte", "value": "3"}, {"field": "visited_page", "op": "eq", "value": ""},
    {"field": "total_pageviews", "op": "gte", "value": "many"}, {"field": "country2", "op": "eq", "value": "x"},
])
def test_bad_rule_fields_are_rejected(client, site, rule):
    assert camp(client, site, rules=[rule]).status_code == 422


def test_groups_validate_and_round_trip(client, site):
    group = {"field": "__group", "match": "any", "rules": [{"field": "device", "op": "eq", "value": "mobile"},
                                                           {"field": "traffic_source", "op": "eq", "value": "organic"}]}
    plain = {"field": "attr.plan", "op": "eq", "value": "pro"}
    r = camp(client, site, name="Grouped", rules=[plain, group], frequency="always")
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    client.patch(f"/api/campaigns/{cid}/status", json={"status": "running"})
    c = next(x for x in client.get(f"/sdk/{site}.json").json()["campaigns"] if x["id"] == cid)
    assert c["rules"][0] == plain                                           # plain rules keep their original 3-key shape
    assert c["rules"][1]["field"] == "__group" and c["rules"][1]["match"] == "any" and len(c["rules"][1]["rules"]) == 2
    # invalid groups
    assert camp(client, site, rules=[{"field": "__group", "match": "any", "rules": []}]).status_code == 422
    nested = {"field": "__group", "rules": [{"field": "__group", "rules": [{"field": "device", "op": "eq", "value": "mobile"}]}]}
    assert camp(client, site, rules=[nested]).status_code == 422
    assert camp(client, site, rules=[{"field": "__group", "match": "most", "rules": [plain]}]).status_code == 422
    bad_inside = {"field": "__group", "rules": [{"field": "nonsense", "op": "eq", "value": "x"}]}
    assert camp(client, site, rules=[bad_inside]).status_code == 422


def test_segments_can_contain_groups(client, site):
    body = {"name": "Grouped segment", "rules": [{"field": "device", "op": "eq", "value": "mobile"},
            {"field": "__group", "match": "any", "rules": [{"field": "city", "op": "eq", "value": "Mumbai"}, {"field": "city", "op": "eq", "value": "Pune"}]}]}
    sid = client.post(f"/api/sites/{site}/segments", json=body).json()["id"]
    seg = next(s for s in client.get(f"/api/sites/{site}/segments").json() if s["id"] == sid)
    assert seg["rules"][1]["field"] == "__group" and len(seg["rules"][1]["rules"]) == 2 and "match" not in seg["rules"][0]


# ------------------------------------------------------------------ triggers / page scope / redirect
@pytest.mark.parametrize("trig,val,ok", [
    ("load", "", True), ("session_start", "", True), ("exit", "", True), ("delay", "5", True), ("delay", "0", True), ("scroll", "50", True),
    ("click", "#buy", True), ("form", "contact", True), ("event", "add_to_cart", True),
    ("delay", "five", False), ("delay", "-1", False), ("delay", "99999", False), ("scroll", "0", False), ("scroll", "101", False),
    ("click", "", False), ("form", " ", False), ("event", "", False), ("hover", "", False),
])
def test_trigger_validation(client, site, trig, val, ok):
    r = camp(client, site, trigger_type=trig, trigger_value=val)
    assert (r.status_code == 200) == ok, (trig, val, r.text)


def test_trigger_and_page_scope_are_served_to_the_sdk(client, site):
    r = camp(client, site, name="Scoped", trigger_type="delay", trigger_value="3", page_match="starts", url_contains="https://x.com/pricing", frequency="always")
    cid = r.json()["id"]
    client.patch(f"/api/campaigns/{cid}/status", json={"status": "running"})
    c = next(x for x in client.get(f"/sdk/{site}.json").json()["campaigns"] if x["id"] == cid)
    assert (c["trigger_type"], c["trigger_value"], c["page_match"], c["url_contains"]) == ("delay", "3", "starts", "https://x.com/pricing")
    assert camp(client, site, page_match="regex").status_code == 422
    assert camp(client, site, page_match="starts", url_contains="  ").status_code == 422
    assert camp(client, site, page_match="equals", url_contains="").status_code == 422
    assert camp(client, site, page_match="all", url_contains="").status_code == 200
    # old campaigns keep working: defaults are "contains" + "load"
    old = camp(client, site, name="Old").json()["id"]
    cfg = next(x for x in client.get(f"/api/sites/{site}/campaigns").json() if x["id"] == old)["config"]
    assert (cfg["page_match"], cfg["trigger_type"], cfg["trigger_value"]) == ("contains", "load", "")


@pytest.mark.parametrize("value,ok", [("https://example.com/new", True), ("/landing", True), ("/", True), ("", False), ("javascript:alert(1)", False),
                                      ("ftp://x.com", False), ("//evil.com", False), ("https://", False), ("hello", False)])
def test_redirect_action_validation(client, site, value, ok):
    r = camp(client, site, actions=[{"type": "redirect", "value": value}])
    assert (r.status_code == 200) == ok, (value, r.text)


# ------------------------------------------------------------------ geo
def test_region_names_and_header_parsing():
    assert geo.region_name("IN", "MH") == "Maharashtra" and geo.region_name("in", "tn") == "Tamil Nadu"
    assert geo.region_name("US", "CA") == "California"
    assert geo.region_name("CA", "ON") == "ON"          # unmapped country: raw code
    assert geo.region_name("IN", None) is None
    h = {"x-vercel-ip-country": "IN", "x-vercel-ip-country-region": "MH", "x-vercel-ip-city": "Navi%20Mumbai"}
    assert geo.location_from_headers(h) == {"country": "IN", "region": "Maharashtra", "region_code": "MH", "city": "Navi Mumbai"}
    assert geo.location_from_headers({"cf-ipcountry": "XX"})["country"] is None
    assert geo.location_from_headers({}) == {"country": None, "region": None, "region_code": None, "city": None}


def test_ctx_endpoint_reads_host_geo_headers(client):
    r = client.get("/ctx", headers={"x-vercel-ip-country": "IN", "x-vercel-ip-country-region": "KA", "x-vercel-ip-city": "Bengaluru"})
    j = r.json()
    assert {k: j[k] for k in ("country", "region", "region_code", "city")} == {"country": "IN", "region": "Karnataka", "region_code": "KA", "city": "Bengaluru"}
    assert "ip" in j                                       # the visitor's own address, for IP-range rules (never stored)
    assert r.headers["cache-control"] == "no-store"
    assert client.get("/ctx").json()["city"] is None
