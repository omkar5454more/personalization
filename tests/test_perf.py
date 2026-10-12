"""Round-trip budgets. On Turso every database round trip is an HTTP request (~50-300 ms), so the number of round trips a
dashboard call makes IS its latency. These tests fail if someone makes a hot endpoint chatty again (N+1 queries etc.)."""
import pytest

from backend import database, perf


@pytest.fixture()
def counter(monkeypatch):
    calls = []
    ex, mu, ba = database.LocalConn.execute, database.LocalConn.multi, database.LocalConn.batch
    monkeypatch.setattr(database.LocalConn, "execute", lambda self, sql, params=(): (calls.append(sql), ex(self, sql, params))[1])
    monkeypatch.setattr(database.LocalConn, "multi", lambda self, stmts: (calls.append("multi"), [ex(self, q, p or ()) for q, p in stmts])[1])
    monkeypatch.setattr(database.LocalConn, "batch", lambda self, stmts: (calls.append("batch"), [ex(self, q, p or ()) for q, p in stmts])[1] and None)
    return calls


def cold():
    for c in (perf.sessions, perf.access, perf.site_cfg, perf.sites_summary, perf.analytics):
        c.clear()


@pytest.fixture(scope="module")
def rich_site(client, site):
    """A site with several tests / campaigns / funnels, so N+1 patterns would show up."""
    for i in range(4):
        r = client.post(f"/api/sites/{site}/experiments", json={"name": f"E{i}", "goal": {"type": "event", "name": "x"},
                        "variants": [{"key": "control", "weight": 50}, {"key": "b", "weight": 50, "changes": [{"selector": "h1", "action": "text", "value": "B"}]}]})
        client.patch(f"/api/experiments/{r.json()['id']}/status", json={"status": "running"})
    for i in range(5):
        client.post(f"/api/sites/{site}/campaigns", json={"name": f"C{i}", "actions": [{"type": "banner", "text": "hi"}]})
    for i in range(2):
        client.post(f"/api/sites/{site}/funnels", json={"name": f"F{i}", "steps": [{"type": "page", "value": "/"}, {"type": "event", "value": "x"}]})
    for i in range(3):
        client.post(f"/api/sites/{site}/segments", json={"name": f"Seg{i}", "rules": [{"field": "device", "op": "eq", "value": "mobile"}]})
        client.post(f"/api/sites/{site}/goals", json={"name": f"G{i}", "type": "event", "event_name": f"g{i}"})
    for i in range(3):   # a few more sites, to catch per-site queries in the sidebar list
        client.post("/api/sites", json={"name": f"Extra{i}", "domain": f"extra{i}.com"})
    client.post("/collect", json={"site": site, "events": [{"vid": f"v{i}", "sid": "s", "type": "pageview", "visit_no": 1, "url": "/"} for i in range(20)]})
    return site


@pytest.mark.parametrize("label,path,budget", [
    ("bootstrap (first paint)", "/api/bootstrap", 2),
    ("sites list", "/api/sites", 2),
    ("overview", "/api/sites/{s}/overview?days=14", 3),
    ("pages", "/api/sites/{s}/pages?days=14", 3),
    ("clicks", "/api/sites/{s}/clicks?days=14", 3),
    ("scroll", "/api/sites/{s}/scroll?days=14", 3),
    ("campaigns list", "/api/sites/{s}/campaigns", 3),
    ("experiments with results", "/api/sites/{s}/experiments?with_results=1", 4),
    ("segments", "/api/sites/{s}/segments", 3),
    ("goals report", "/api/sites/{s}/goals/report?days=30", 3),
    ("live feed", "/api/sites/{s}/live", 3),
])
def test_cold_request_round_trip_budget(client, rich_site, counter, label, path, budget):
    cold()
    counter.clear()
    r = client.get(path.format(s=rich_site))
    assert r.status_code == 200, (label, r.text)
    assert len(counter) <= budget, f"{label}: {len(counter)} round trips (budget {budget}): {counter}"


def test_warm_requests_are_cheaper_still(client, rich_site, counter):
    cold()
    client.get(f"/api/sites/{rich_site}/overview?days=14")
    counter.clear()
    client.get("/api/sites")
    client.get(f"/api/sites/{rich_site}/overview?days=14")           # memoised
    client.get(f"/api/sites/{rich_site}/campaigns")
    assert len(counter) <= 2, counter                                   # sites summary (cached after the first) + campaigns


def test_collect_costs_one_round_trip(client, rich_site, counter):
    client.post("/collect", json={"site": rich_site, "events": [{"vid": "warm", "sid": "s", "type": "pageview", "visit_no": 1}]})
    counter.clear()
    r = client.post("/collect", json={"site": rich_site, "events": [{"vid": "z", "sid": "s", "type": "pageview", "visit_no": 1}]})
    assert r.status_code == 204 and len(counter) == 1, counter


def test_with_results_returns_everything_for_the_ab_page(client, rich_site):
    items = client.get(f"/api/sites/{rich_site}/experiments?with_results=1").json()
    assert len(items) >= 4 and all(i["results"] and i["results"]["variants"] for i in items)
    plain = client.get(f"/api/sites/{rich_site}/experiments").json()
    assert "results" not in plain[0]                                    # the old shape is unchanged


def test_session_cache_does_not_outlive_logout(client):
    from fastapi.testclient import TestClient
    from backend.main import app
    with TestClient(app) as other:
        other.post("/api/auth/register", json={"email": "logout-test@example.com", "password": "logout test pass 1"})
        assert other.get("/api/auth/me").status_code == 200
        other.post("/api/auth/logout")
        assert other.get("/api/auth/me").status_code == 401
