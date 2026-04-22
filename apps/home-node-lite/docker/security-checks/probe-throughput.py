#!/usr/bin/env python3
"""Task 11.3 — throughput 50 req/s sustained 5 min.

Generates sustained HTTP load at a target RPS against a Lite (or Go
production) endpoint, measures delivered RPS, p50/p95/p99 latency,
and error rate. Fails if delivered RPS falls below the configured
floor (default: 95% of target) or error rate exceeds the ceiling
(default: 1%).

The load pattern is **open-loop** — requests are scheduled by a
deterministic tick (1/RPS seconds apart), not driven by previous-
response arrival. Closed-loop load generators under-report
throughput when the server is slow because subsequent requests wait
on responses; open-loop surfaces the real backlog (matches the
production soak pattern where request rate is user-driven, not
response-driven).

Usage:
    python3 probe-throughput.py \\
        --url http://127.0.0.1:28100/healthz \\
        --rps 50 \\
        --duration 300

    # Env-var defaults for the Phase 11c soak harness
    DINA_THROUGHPUT_URL=http://127.0.0.1:28200/api/v1/ask \\
    DINA_THROUGHPUT_RPS=50 \\
    DINA_THROUGHPUT_DURATION=300 \\
    python3 probe-throughput.py

Exit codes:
    0 — passed both RPS floor and error-rate ceiling
    1 — failed one or both
    2 — config error (target not reachable, invalid args)

Runtime dependency: Python 3.11+ with `httpx` (already a test-harness
dep in the repo's requirements-dev.txt). No external load-gen tool
(wrk / hey / k6) so the script runs on every operator's dev machine
without additional install.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import statistics
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
    sorted_values = sorted(values)
    idx = min(len(sorted_values) - 1, int(p * len(sorted_values)))
    return sorted_values[idx]


async def fire_request(
    client: httpx.AsyncClient,
    url: str,
    method: str,
    body: str | None,
    latencies: list[float],
    errors: list[str],
) -> None:
    t0 = time.perf_counter()
    try:
        kwargs: dict[str, Any] = {}
        if body is not None:
            kwargs["content"] = body
            kwargs["headers"] = {"Content-Type": "application/json"}
        resp = await client.request(method, url, **kwargs)
        latencies.append((time.perf_counter() - t0) * 1000.0)  # ms
        if resp.status_code >= 400:
            errors.append(f"HTTP {resp.status_code}")
    except Exception as e:
        errors.append(type(e).__name__)


async def run_load(
    url: str,
    rps: int,
    duration_sec: int,
    method: str,
    body: str | None,
    warmup_sec: int,
) -> dict[str, Any]:
    interval = 1.0 / rps
    latencies: list[float] = []
    errors: list[str] = []
    tasks: list[asyncio.Task] = []

    timeout = httpx.Timeout(connect=2.0, read=10.0, write=2.0, pool=5.0)
    limits = httpx.Limits(max_connections=max(50, rps * 2), max_keepalive_connections=rps)

    async with httpx.AsyncClient(timeout=timeout, limits=limits) as client:
        # Warm-up — discarded from measurement so connection-pool + DNS +
        # JIT settle before we start counting.
        if warmup_sec > 0:
            print(f"warmup: {warmup_sec}s @ {rps} rps against {url}", file=sys.stderr)
            warmup_end = time.perf_counter() + warmup_sec
            next_fire = time.perf_counter()
            while time.perf_counter() < warmup_end:
                asyncio.create_task(
                    fire_request(client, url, method, body, [], [])
                )
                next_fire += interval
                sleep_for = max(0.0, next_fire - time.perf_counter())
                await asyncio.sleep(sleep_for)

        print(f"measurement: {duration_sec}s @ {rps} rps", file=sys.stderr)
        start = time.perf_counter()
        deadline = start + duration_sec
        next_fire = start
        scheduled = 0

        while time.perf_counter() < deadline:
            tasks.append(
                asyncio.create_task(
                    fire_request(client, url, method, body, latencies, errors)
                )
            )
            scheduled += 1
            next_fire += interval
            sleep_for = max(0.0, next_fire - time.perf_counter())
            await asyncio.sleep(sleep_for)

        # Let in-flight responses drain before computing stats.
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        elapsed = time.perf_counter() - start

    return {
        "scheduled": scheduled,
        "completed": len(latencies),
        "errors": len(errors),
        "elapsed_sec": elapsed,
        "delivered_rps": len(latencies) / elapsed if elapsed > 0 else 0.0,
        "p50_ms": percentile(latencies, 0.50),
        "p95_ms": percentile(latencies, 0.95),
        "p99_ms": percentile(latencies, 0.99),
        "error_samples": errors[:10],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Dina Lite throughput probe (task 11.3)")
    ap.add_argument("--url", default=os.environ.get("DINA_THROUGHPUT_URL"))
    ap.add_argument("--rps", type=int, default=int(os.environ.get("DINA_THROUGHPUT_RPS", "50")))
    ap.add_argument(
        "--duration",
        type=int,
        default=int(os.environ.get("DINA_THROUGHPUT_DURATION", "300")),
        help="seconds of measured load (default: 300 = 5 min per task 11.3)",
    )
    ap.add_argument("--warmup", type=int, default=10, help="seconds of discard load first")
    ap.add_argument("--method", default="GET")
    ap.add_argument("--body", default=None, help="request body (sent with Content-Type: application/json)")
    ap.add_argument(
        "--rps-floor",
        type=float,
        default=0.95,
        help="minimum delivered_rps / target_rps ratio (default: 0.95)",
    )
    ap.add_argument(
        "--error-ceiling",
        type=float,
        default=0.01,
        help="max error-rate ratio (default: 0.01 = 1%%)",
    )
    args = ap.parse_args()

    if not args.url:
        print("error: --url required (or DINA_THROUGHPUT_URL)", file=sys.stderr)
        return 2

    print(
        f"target: {args.method} {args.url}  rps={args.rps}  "
        f"duration={args.duration}s  warmup={args.warmup}s",
        file=sys.stderr,
    )

    report = asyncio.run(
        run_load(args.url, args.rps, args.duration, args.method, args.body, args.warmup)
    )

    # Human summary.
    print()
    print(f"scheduled:     {report['scheduled']}")
    print(f"completed:     {report['completed']}")
    print(f"errors:        {report['errors']}")
    print(f"elapsed:       {report['elapsed_sec']:.2f}s")
    print(f"delivered rps: {report['delivered_rps']:.2f} (target: {args.rps})")
    print(f"p50 latency:   {report['p50_ms']:.2f}ms")
    print(f"p95 latency:   {report['p95_ms']:.2f}ms")
    print(f"p99 latency:   {report['p99_ms']:.2f}ms")
    if report["error_samples"]:
        print(f"error samples: {', '.join(report['error_samples'])}")

    # Gates.
    failed = False
    delivered_ratio = report["delivered_rps"] / max(args.rps, 1)
    error_ratio = report["errors"] / max(report["scheduled"], 1)
    print()
    if delivered_ratio < args.rps_floor:
        print(
            f"FAIL: delivered_rps/target={delivered_ratio:.3f} < floor={args.rps_floor}",
            file=sys.stderr,
        )
        failed = True
    else:
        print(f"PASS: delivered_rps/target={delivered_ratio:.3f} ≥ floor={args.rps_floor}")
    if error_ratio > args.error_ceiling:
        print(
            f"FAIL: error_rate={error_ratio:.3f} > ceiling={args.error_ceiling}",
            file=sys.stderr,
        )
        failed = True
    else:
        print(f"PASS: error_rate={error_ratio:.3f} ≤ ceiling={args.error_ceiling}")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
