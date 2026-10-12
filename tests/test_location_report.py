"""State / city breakdown on the Overview, built from the host's geo headers (no IP is stored)."""


def hit(client, site, vid, country="IN", region="MH", city="Mumbai"):
    h = {"x-vercel-ip-country": country}
    if region:
        h["x-vercel-ip-country-region"] = region
    if city:
        h["x-vercel-ip-city"] = city
    r = client.post("/collect", headers=h, json={"site": site, "events": [{"vid": vid, "sid": "s" + vid, "type": "pageview", "url": "/", "visit_no": 1}]})
    assert r.status_code == 204


def test_regions_and_cities_are_reported(client, site):
    for i in range(3):
        hit(client, site, f"m{i}")
    hit(client, site, "p1", city="Pune")
    hit(client, site, "b1", region="KA", city="Bengaluru")
    hit(client, site, "u1", country="US", region="CA", city="San%20Jose")
    ov = client.get(f"/api/sites/{site}/overview?days=14").json()
    regs = {x["name"]: x["visitors"] for x in ov["regions"]}
    cities = {x["name"]: x["visitors"] for x in ov["cities"]}
    assert regs == {"Maharashtra, IN": 4, "Karnataka, IN": 1, "California, US": 1}
    assert cities["Mumbai, Maharashtra"] == 3 and cities["Pune, Maharashtra"] == 1 and cities["San Jose, California"] == 1
    assert ov["countries"][0] == {"name": "IN", "visitors": 5}


def test_missing_location_is_skipped_and_ip_not_stored(client, site):
    from backend import perf
    def total():
        perf.analytics.clear()
        return sum(x["visitors"] for x in client.get(f"/api/sites/{site}/overview?days=14").json()["cities"])
    before = total()
    hit(client, site, "x1", region=None, city=None)      # country only: no city to report
    hit(client, site, "x2", city="Nashik")
    assert total() == before + 1
    from backend.main import db
    with db() as con:
        rows = con.execute("SELECT props FROM events WHERE site_id=? AND visitor_id IN ('x1','x2')", (site,)).fetchall()
    assert rows and all('"ip"' not in r["props"] for r in rows)
