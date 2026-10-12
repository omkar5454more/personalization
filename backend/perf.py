"""Small in-process caches.

On Vercel every function instance keeps its memory between requests for a while ("warm"), so a few seconds of caching removes
most repeated database round trips (on Turso each one is an HTTP request). Everything cached here is either harmless to be a few
seconds stale (analytics, session lookups) or explicitly invalidated by the code that changes it. A cold instance simply starts empty.
"""
import time
from typing import Any, Callable, Hashable, Optional

_MAX_ENTRIES = 2000


class TTLCache:
    def __init__(self, ttl: float):
        self.ttl, self._d = ttl, {}

    def get(self, key: Hashable) -> Optional[Any]:
        hit = self._d.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        self._d.pop(key, None)
        return None

    def set(self, key: Hashable, value: Any) -> Any:
        if len(self._d) >= _MAX_ENTRIES:                       # cheap bound: drop the oldest half
            for k in sorted(self._d, key=lambda k: self._d[k][0])[: _MAX_ENTRIES // 2]:
                self._d.pop(k, None)
        self._d[key] = (time.monotonic() + self.ttl, value)
        return value

    def pop(self, key: Hashable) -> None:
        self._d.pop(key, None)

    def drop_where(self, pred: Callable[[Hashable], bool]) -> None:
        for k in [k for k in self._d if pred(k)]:
            self._d.pop(k, None)

    def clear(self) -> None:
        self._d.clear()


sessions = TTLCache(15)       # token hash -> user row
access = TTLCache(20)         # (user id, site id) -> role   (positives only)
site_cfg = TTLCache(60)       # site id -> (domain, settings) for /collect
sites_summary = TTLCache(10)   # user id -> sidebar summary of all their sites
analytics = TTLCache(30)      # (user, site, endpoint, args) -> JSON-able result


def cached(cache: TTLCache, key: Hashable, compute: Callable[[], Any]) -> Any:
    hit = cache.get(key)
    if hit is not None:
        return hit
    return cache.set(key, compute())
