"""Run this once before deploying to confirm your Turso credentials work:

    set TURSO_DATABASE_URL=libsql://your-db-your-org.turso.io      (PowerShell: $env:TURSO_DATABASE_URL="...")
    set TURSO_AUTH_TOKEN=eyJ...
    python scripts/check_db.py

It creates the tables (if missing) and does a write/read/delete round-trip. Never prints the token.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import database  # noqa: E402

if not database.USING_TURSO:
    sys.exit("TURSO_DATABASE_URL is not set -- this would test the local SQLite file instead.")
print("Connecting to", database.TURSO_URL.split("//")[-1])
t0 = time.time()
with database.db() as con:
    con.execute("INSERT INTO meta (k, v) VALUES ('check', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (str(time.time()),))
    v = con.execute("SELECT v FROM meta WHERE k='check'").fetchone()["v"]
    tables = [r["name"] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    con.execute("DELETE FROM meta WHERE k='check'")
print("OK: write/read/delete worked (%.0f ms). Tables: %s" % ((time.time() - t0) * 1000, ", ".join(tables)))
