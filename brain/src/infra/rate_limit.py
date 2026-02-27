"""Token-bucket rate limiter for expensive endpoints."""

from __future__ import annotations

import time
from collections import OrderedDict


class TokenBucketLimiter:
    """Per-key token bucket rate limiter."""

    def __init__(self, rate: float, burst: int, max_keys: int = 10_000):
        self._rate = rate
        self._burst = burst
        self._max_keys = max_keys
        self._buckets: OrderedDict[str, tuple[float, float]] = OrderedDict()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        if key in self._buckets:
            tokens, last = self._buckets.pop(key)
            tokens = min(self._burst, tokens + (now - last) * self._rate)
        else:
            tokens = float(self._burst)
        if len(self._buckets) >= self._max_keys:
            self._buckets.popitem(last=False)
        if tokens >= 1.0:
            self._buckets[key] = (tokens - 1.0, now)
            return True
        self._buckets[key] = (tokens, now)
        return False
