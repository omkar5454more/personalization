import os
import sys
import tempfile
from pathlib import Path

# A throw-away database: set before backend.database is imported (it reads the path at import time).
_tmp = tempfile.mkdtemp(prefix="optimize-test-")
os.environ["DATA_DB_PATH"] = str(Path(_tmp) / "test.db")
os.environ.pop("TURSO_DATABASE_URL", None)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        r = c.post("/api/auth/register", json={"email": "owner@example.com", "password": "correct horse battery"})
        assert r.status_code == 200, r.text
        yield c


@pytest.fixture(scope="session")
def site(client):
    r = client.post("/api/sites", json={"name": "Test shop", "domain": "example.com"})
    assert r.status_code == 200, r.text
    return r.json()["id"]
