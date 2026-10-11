from __future__ import annotations

import time
from collections import OrderedDict
from dataclasses import dataclass
from threading import RLock
from typing import Callable, Final

DEFAULT_MAX_ENTRIES: Final = 256
DEFAULT_MAX_BYTES: Final = 16 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class CachedBytes:
    status: int
    body: bytes
    expires_at: float


class TtlByteCache:
    def __init__(
        self,
        ttl_seconds: float,
        now: Callable[[], float] = time.monotonic,
        *,
        max_entries: int = DEFAULT_MAX_ENTRIES,
        max_bytes: int = DEFAULT_MAX_BYTES,
    ) -> None:
        self._ttl_seconds = ttl_seconds
        self._now = now
        self._max_entries = max(1, max_entries)
        self._max_bytes = max(1, max_bytes)
        self._items: OrderedDict[str, CachedBytes] = OrderedDict()
        self._total_bytes = 0
        self._lock = RLock()

    def _remove(self, key: str) -> None:
        cached = self._items.pop(key, None)
        if cached is not None:
            self._total_bytes -= len(cached.body)

    def _prune_expired(self, now: float) -> None:
        for key, cached in tuple(self._items.items()):
            if cached.expires_at <= now:
                self._remove(key)

    def get(self, key: str) -> tuple[int, bytes] | None:
        with self._lock:
            now = self._now()
            self._prune_expired(now)
            cached = self._items.get(key)
            if cached is None:
                return None
            self._items.move_to_end(key)
            return cached.status, cached.body

    def set(self, key: str, status: int, body: bytes) -> None:
        with self._lock:
            now = self._now()
            self._prune_expired(now)
            self._remove(key)
            if len(body) > self._max_bytes:
                return
            while self._items and (
                len(self._items) >= self._max_entries
                or self._total_bytes + len(body) > self._max_bytes
            ):
                oldest_key = next(iter(self._items))
                self._remove(oldest_key)
            self._items[key] = CachedBytes(
                status=status,
                body=body,
                expires_at=now + self._ttl_seconds,
            )
            self._total_bytes += len(body)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()
            self._total_bytes = 0
