#!/usr/bin/env python3
"""Task 11.6 — end-to-end `/api/v1/ask` latency vs Go baseline.

Samples request latency against both Lite and Go Core URLs for the
same logical request shape, computes p50/p95/p99 + ratio. Passes iff
Lite latency is within a configurable multiple of Go (default: 2×) —
the M4 acceptance criterion per `docs/lite-release-signoff.md`.

Unlike the throughput probe (task 11.3 — sustained load), this probe
is a **side-by-side comparison**: same requests, both stacks, small
number of samples, focus on per-request latency.

Usage:
    python3 probe-ask-latency-vs-go.py \\
        --go-url http://127.0.0.1:8100/healthz \\
        --lite-url http://127.0.0.1:28100/healthz \\
        --samples 100

    # Or via env:
    DINA_GO_URL=http://127.0.0.1:8200/api/v1/ask \\
    DINA_LITE_URL=http://127.0.0.1:28200/api/v1/ask \\
    DINA_ASK_BODY='{"query":"when does bus 42 reach Castro?"}' \\
    python3 probe-ask-latency-vs-go.py

Exit codes:
    0 — Lite within the ratio bound
    1 — Lite exceeds the bound (regression or uncovered perf gap)
    2 — config error or either side unreachable

Runtime dependency: Python 3.11+ with `httpx`. Single script, no
external tooling — runs on any operator's dev machine.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from typing import Any

try:
    import httpx
except ImportError:
    print("error: httpx required — pip install httpx", file=sys.stderr)
    sys.exit(2)


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    return s[min(len(s) - 1, int(p * len(s)))]


async def sample_one(
    client: httpx.AsyncClient, url: str, method: str, body: str | None
) -> tuple[float | None, str | None]:
    """Returns (latency_ms, None) on success, or (None, error_label) on fail."""
    t0 = time.perf_counter()
    try:
        kwargs: dict[str, Any] = {}
        if body is not None:
            kwargs["content"] = body
            kwargs["headers"] = {"Content-Type": "application/json"}
        r = await client.request(method, url, **kwargs)
        latency_ms = (time.perf_counter() - t0) * 1000.0
        if r.status_code >= 400:
            return None, f"HTTP {r.status_code}"
        return latency_ms, None
    except Exception as e:
        return None, type(e).__name__


async def sample_stack(
    name: str, url: str, method: str, body: str | None, samples: int, warmup: int
) -> dict[str, Any]:
    """Sequential sampling — latency, not throughput. No concurrency."""
    timeout = httpx.Timeout(connect=5.0, read=30.0, write=5.0, pool=10.0)
    latencies: list[float] = []
    errors: list[str] = []
    async with httpx.AsyncClient(timeout=timeout) as client:
        # Warmup — discard first N.
        for _ in range(warmup):
            await sample_one(client, url, method, body)

        for _ in range(samples):
            lat, err = await sample_one(client, url, method, body)
            if lat is not None:
                latencies.append(lat)
            if err is not None:
                errors.append(err)

    return {
        "name": name,
        "samples_requested": samples,
        "samples_ok": len(latencies),
        "errors": len(errors),
        "error_samples": errors[:5],
        "p50_ms": percentile(latencies, 0.50),
        "p95_ms": percentile(latencies, 0.95),
        "p99_ms": percentile(latencies, 0.99),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Lite vs Go ask-latency probe (task 11.6)")
    ap.add_argument("--go-url", default=os.environ.get("DINA_GO_URL"))
    ap.add_argument("--lite-url", default=os.environ.get("DINA_LITE_URL"))
    ap.add_argument("--samples", type=int, default=int(os.environ.get("DINA_ASK_SAMPLES", "100")))
    ap.add_argument("--warmup", type=int, default=10, help="discard first N samples each side")
    ap.add_argument("--method", default=os.environ.get("DINA_ASK_METHOD", "GET"))
    ap.add_argument("--body", default=os.environ.get("DINA_ASK_BODY"))
    ap.add_argument(
        "--ratio-ceiling",
        type=float,
        default=float(os.environ.get("DINA_ASK_RATIO_CEILING", "2.0")),
        help="max Lite.p95 / Go.p95 ratio (default: 2.0 = 2× Go)",
    )
    args = ap.parse_args()

    if not args.go_url or not args.lite_url:
        print("error: --go-url AND --lite-url required", file=sys.stderr)
        return 2

    print(
        f"Go:   {args.method} {args.go_url}",
        f"Lite: {args.method} {args.lite_url}",
        f"samples: {args.samples} (+{args.warmup} warmup each)",
        f"ratio ceiling: Lite.p95 ≤ {args.ratio_ceiling}× Go.p95",
        sep="\n",
        file=sys.stderr,
    )

    # Run both concurrently so a slow DNS + cold-cache on one side
    # doesn't bias the other's measurement. Each side uses its own
    # httpx client + connection pool; they don't share state.
    async def run_both() -> tuple[dict[str, Any], dict[str, Any]]:
        go_task = asyncio.create_task(
            sample_stack("Go", args.go_url, args.method, args.body, args.samples, args.warmup)
        )
        lite_task = asyncio.create_task(
            sample_stack("Lite", args.lite_url, args.method, args.body, args.samples, args.warmup)
        )
        return await go_task, await lite_task

    go_report, lite_report = asyncio.run(run_both())

    print()
    for r in (go_report, lite_report):
        print(
            f"{r['name']:5}  ok={r['samples_ok']}/{r['samples_requested']}  "
            f"errors={r['errors']}  "
            f"p50={r['p50_ms']:.2f}ms  p95={r['p95_ms']:.2f}ms  p99={r['p99_ms']:.2f}ms"
        )

    if go_report["samples_ok"] == 0 or lite_report["samples_ok"] == 0:
        print(
            "\nFAIL: one side produced no successful samples — check URL / stack health",
            file=sys.stderr,
        )
        return 2

    go_p95 = go_report["p95_ms"]
    lite_p95 = lite_report["p95_ms"]
    ratio = lite_p95 / go_p95 if go_p95 > 0 else float("inf")
    print(f"\nratio Lite.p95 / Go.p95 = {ratio:.3f}")

    if ratio > args.ratio_ceiling:
        print(
            f"FAIL: ratio {ratio:.3f} > ceiling {args.ratio_ceiling} "
            f"(Lite {lite_p95:.2f}ms vs Go {go_p95:.2f}ms)",
            file=sys.stderr,
        )
        return 1
    print(f"PASS: ratio {ratio:.3f} ≤ ceiling {args.ratio_ceiling}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
