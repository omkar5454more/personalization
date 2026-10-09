"""Storage layer: one `db()` context manager, two backends.

* Local development: a SQLite file (zero setup).
* Production on Vercel: Turso (hosted libSQL = SQLite over HTTP). Vercel functions have no
  persistent disk, so the database has to live outside them. Set TURSO_DATABASE_URL and
  TURSO_AUTH_TOKEN to switch; the SQL in the app is unchanged because libSQL speaks SQLite's dialect.

Both backends expose the same tiny interface used across the app:
    con.execute(sql, params) -> cursor with fetchone() / fetchall() / iteration / rowcount
    rows support row["col"], row[0] and dict(row)
    con.batch([(sql, params), ...]) -> run many writes (one HTTP round-trip on Turso)
    con.multi([(sql, params), ...]) -> several reads in one round-trip, returns a list of cursors
"""
import base64
import os
import re
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
def _clean_env(name):
    # tolerate quotes / stray whitespace copied from a dashboard or a shell command
    return os.getenv(name, "").strip().strip("\"'").strip()


TURSO_URL = _clean_env("TURSO_DATABASE_URL")
TURSO_TOKEN = _clean_env("TURSO_AUTH_TOKEN")
USING_TURSO = bool(TURSO_URL)
LOCAL_PATH = Path(os.getenv("DATA_DB_PATH") or ROOT / "data.db")
SCHEMA_VERSION = "4"

# Final schema. (Local databases created by older versions get the missing columns via _migrate_local.)
SCHEMA = [
    "CREATE TABLE IF NOT EXISTS sites (id TEXT PRIMARY KEY, name TEXT, domain TEXT, created REAL, user_id TEXT, settings TEXT)",
    "CREATE TABLE IF NOT EXISTS experiments (id TEXT PRIMARY KEY, site_id TEXT, name TEXT, status TEXT, config TEXT, created REAL)",
    "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id TEXT, ts REAL, visitor_id TEXT, session_id TEXT, "
    "type TEXT, name TEXT, url TEXT, exp_id TEXT, variant TEXT, visit_no INTEGER, is_returning INTEGER, props TEXT, host TEXT)",
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, salt TEXT, pw_hash TEXT, created REAL)",
    "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT, created REAL)",
    "CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, site_id TEXT, name TEXT, status TEXT, config TEXT, created REAL)",
    "CREATE TABLE IF NOT EXISTS funnels (id TEXT PRIMARY KEY, site_id TEXT, name TEXT, steps TEXT, created REAL)",
    "CREATE TABLE IF NOT EXISTS login_attempts (k TEXT, ts REAL)",
    "CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT, mime TEXT, size INTEGER, name TEXT, data BLOB, created REAL)",
    "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)",
    "CREATE INDEX IF NOT EXISTS ix_ev_site_ts ON events(site_id, ts)",
    "CREATE INDEX IF NOT EXISTS ix_ev_exp ON events(exp_id, type, variant)",
    "CREATE INDEX IF NOT EXISTS ix_ev_vis ON events(site_id, visitor_id, ts)",
    "CREATE INDEX IF NOT EXISTS ix_ev_type ON events(site_id, type, ts)",
    "CREATE INDEX IF NOT EXISTS ix_login_k ON login_attempts(k, ts)",
    "CREATE INDEX IF NOT EXISTS ix_img_site ON images(site_id)",
]


class DatabaseError(RuntimeError):
    pass


# ---------------------------------------------------------------- Turso over HTTP ("Hrana")
class Row:
    """sqlite3.Row look-alike: row["col"], row[0], dict(row), iteration over values."""
    __slots__ = ("_idx", "_vals")

    def __init__(self, idx, vals):
        self._idx, self._vals = idx, vals

    def __getitem__(self, k):
        return self._vals[k] if isinstance(k, int) else self._vals[self._idx[k]]

    def keys(self):
        return list(self._idx)

    def __iter__(self):
        return iter(self._vals)

    def __len__(self):
        return len(self._vals)


class _Cursor:
    def __init__(self, rows, rowcount=0):
        self._rows, self.rowcount = rows, rowcount

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)

    def __iter__(self):
        return iter(self._rows)


def _encode(v):
    if v is None:
        return {"type": "null"}
    if isinstance(v, bool):
        return {"type": "integer", "value": str(int(v))}
    if isinstance(v, int):
        return {"type": "integer", "value": str(v)}
    if isinstance(v, float):
        return {"type": "float", "value": v}
    if isinstance(v, (bytes, bytearray)):
        return {"type": "blob", "base64": base64.b64encode(bytes(v)).decode()}
    return {"type": "text", "value": str(v)}


def _decode(cell):
    t = cell.get("type")
    if t == "null":
        return None
    if t == "integer":
        return int(cell["value"])
    if t == "float":
        return float(cell["value"])
    if t == "blob":
        return base64.b64decode(cell.get("base64", ""))
    return cell.get("value")


_client = None
_client_lock = threading.Lock()
_HOST_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:\d+)?$")


def turso_base_url():
    """libsql://db-org.turso.io -> https://db-org.turso.io, or a clear error if the value is not a real address."""
    url = TURSO_URL
    for prefix in ("libsql://", "wss://", "ws://"):
        if url.startswith(prefix):
            url = ("https://" if prefix != "ws://" else "http://") + url[len(prefix):]
            break
    if not url.startswith(("https://", "http://")):
        url = "https://" + url
    host = url.split("://", 1)[1].split("/", 1)[0]
    if not host or "..." in host or not _HOST_RE.match(host):
        raise DatabaseError(
            f"TURSO_DATABASE_URL looks wrong (got host '{host}'). It should look like "
            "libsql://your-database-your-org.turso.io -- copy the real URL from the Turso dashboard, "
            "not the '...' placeholder.")
    if not TURSO_TOKEN or "..." in TURSO_TOKEN:
        raise DatabaseError("TURSO_AUTH_TOKEN is missing or still a placeholder. Generate a token in the Turso dashboard.")
    return url.rstrip("/")


def _http():
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                import httpx  # imported lazily: not needed for local SQLite development
                _client = httpx.Client(base_url=turso_base_url(), timeout=25.0,
                                       headers={"Authorization": f"Bearer {TURSO_TOKEN}", "Content-Type": "application/json"})
    return _client


class TursoConn:
    """Stateless: every call is one HTTP request (autocommit). Fine for this app's short units of work."""

    def _pipeline(self, stmts):
        reqs = [{"type": "execute", "stmt": {"sql": sql, "args": [_encode(a) for a in (params or ())]}} for sql, params in stmts]
        reqs.append({"type": "close"})
        client = _http()                            # raises DatabaseError with a clear message if misconfigured
        try:
            r = client.post("/v2/pipeline", json={"baton": None, "requests": reqs})
        except Exception as e:  # network / TLS / timeout
            raise DatabaseError(f"could not reach the database: {e}") from e
        if r.status_code != 200:
            raise DatabaseError(f"database HTTP {r.status_code}: {r.text[:300]}")
        results = r.json().get("results", [])
        out = []
        for res in results[:len(stmts)]:
            if res.get("type") == "error":
                raise DatabaseError(res["error"].get("message", "database error"))
            out.append(res["response"]["result"])
        return out

    @staticmethod
    def _cursor(res):
        idx = {c.get("name"): i for i, c in enumerate(res.get("cols", []))}
        rows = [Row(idx, [_decode(c) for c in r]) for r in res.get("rows", [])]
        return _Cursor(rows, res.get("affected_row_count", 0) or 0)

    def execute(self, sql, params=()):
        return self._cursor(self._pipeline([(sql, params)])[0])

    def multi(self, stmts):
        """Several independent reads in ONE round-trip -> list of cursors."""
        return [self._cursor(r) for r in self._pipeline(list(stmts))]

    def batch(self, stmts):
        if stmts:
            self._pipeline(list(stmts))

    def commit(self):  # autocommit
        pass

    def close(self):
        pass


# ---------------------------------------------------------------- local SQLite
class LocalConn(sqlite3.Connection):
    def batch(self, stmts):
        for sql, params in stmts:
            self.execute(sql, params or ())

    def multi(self, stmts):
        return [self.execute(sql, params or ()) for sql, params in stmts]


def _local():
    con = sqlite3.connect(LOCAL_PATH, factory=LocalConn)
    con.row_factory = sqlite3.Row
    return con


def _migrate_local(con):
    """Older local databases predate some columns; add them."""
    def cols(t):
        return [r["name"] for r in con.execute(f"PRAGMA table_info({t})")]
    for table, col in (("sites", "user_id"), ("sites", "settings"), ("events", "host")):
        if col not in cols(table):
            con.execute(f"ALTER TABLE {table} ADD COLUMN {col} TEXT")


# ---------------------------------------------------------------- schema bootstrap + public API
_ready = False
_ready_lock = threading.Lock()


def ensure_ready():
    """Create/upgrade tables once per process. On Turso this is a single cheap SELECT when already current."""
    global _ready
    if _ready:
        return
    with _ready_lock:
        if _ready:
            return
        if os.getenv("VERCEL") and not USING_TURSO:
            raise DatabaseError("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN are not set. Vercel functions have no "
                                "persistent disk, so a hosted database is required (see README).")
        if USING_TURSO:
            con = TursoConn()
            try:
                row = con.execute("SELECT v FROM meta WHERE k='schema'").fetchone()
                current = row["v"] if row else None
            except DatabaseError as e:
                if "no such table" not in str(e).lower():
                    raise                           # bad URL / token / network: say so instead of hiding it
                current = None                      # meta table does not exist yet: first run
            if current != SCHEMA_VERSION:
                con.batch([(sql, ()) for sql in SCHEMA])
                con.execute("INSERT INTO meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (SCHEMA_VERSION,))
        else:
            con = _local()
            try:
                for sql in SCHEMA:
                    if sql.startswith("CREATE INDEX"):
                        continue                    # indexes after migrations (they reference migrated columns)
                    con.execute(sql)
                _migrate_local(con)
                for sql in SCHEMA:
                    if sql.startswith("CREATE INDEX"):
                        con.execute(sql)
                con.commit()
            finally:
                con.close()
        _ready = True


@contextmanager
def db():
    ensure_ready()
    if USING_TURSO:
        yield TursoConn()
        return
    con = _local()
    try:
        yield con
        con.commit()
    finally:
        con.close()
