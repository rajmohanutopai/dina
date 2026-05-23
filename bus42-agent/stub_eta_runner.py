"""Stub ETA runner — returns canned bus ETA data for service_query_execution tasks.

Used by the bus42-agent test setup to provide the `eta_query` capability
backend for iOS Dina (paired). When iOS Dina hands the agent a
`service_query_execution` task for `eta_query`, this runner returns a
canned `{eta_minutes, stop_name, route_id, …}` payload that satisfies
the `eta_query` result schema (params/result schemas in
`packages/protocol/src/types/capability.ts` and AppView).

This is a deterministic test stub — no MCP, no network, no LLM. The
flow it validates is the dina-agent claim → execute → reply chain, not
the accuracy of the data.
"""

from __future__ import annotations

import json
import os
import time
import urllib.parse
import urllib.request
from typing import Any

from dina_cli.agent_runner import AgentRunner, RunnerResult

# Demo pacing: hold the canned response for a few seconds so the
# requester's mobile UI has time to play its "asked the directory →
# found the provider → sent to their Dina → awaiting reply" stepper
# before the ETA card lands. Override with STUB_ETA_DELAY_SECONDS=0
# for fast tests.
_RESPONSE_DELAY_SECONDS = float(os.environ.get("STUB_ETA_DELAY_SECONDS", "7"))

# Stop-name resolution. The eta_query params schema is cross-stack and
# hash-pinned (route_id + location only) — the stop *name* the user asked
# about is forward-geocoded to lat/lng by the requester's Dina and dropped
# on the wire. A real transit provider snaps that location to its nearest
# stop; we mirror that by reverse-geocoding the coordinates so the result
# names a real nearby place instead of a canned default. Disable with
# STUB_ETA_REVERSE_GEOCODE=0 (offline / deterministic tests).
_REVERSE_GEOCODE_ENABLED = os.environ.get("STUB_ETA_REVERSE_GEOCODE", "1") != "0"
_REVERSE_GEOCODE_URL = os.environ.get(
    "STUB_ETA_REVERSE_GEOCODE_URL", "https://nominatim.openstreetmap.org/reverse"
)
_REVERSE_GEOCODE_TIMEOUT_S = float(os.environ.get("STUB_ETA_REVERSE_GEOCODE_TIMEOUT", "4"))


def _reverse_geocode(lat: float, lng: float) -> str | None:
    """Reverse-geocode coordinates to a concise place name (street, or
    street + neighbourhood) via OSM Nominatim. Returns None on any failure
    so the caller falls back gracefully. Network call — demo only."""
    query = urllib.parse.urlencode(
        {
            "lat": f"{lat:.6f}",
            "lon": f"{lng:.6f}",
            "format": "jsonv2",
            "zoom": "17",
            "addressdetails": "1",
        }
    )
    req = urllib.request.Request(
        f"{_REVERSE_GEOCODE_URL}?{query}",
        headers={"User-Agent": "dina-bus42-stub/1.0 (demo)", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=_REVERSE_GEOCODE_TIMEOUT_S) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # network / timeout / parse — fall back quietly
        print(f"[stub_eta] reverse-geocode failed ({exc}); using fallback", flush=True)
        return None

    addr = data.get("address") if isinstance(data, dict) else None
    if isinstance(addr, dict):
        road = addr.get("road") or addr.get("pedestrian") or addr.get("footway")
        area = addr.get("neighbourhood") or addr.get("suburb") or addr.get("quarter")
        if road and area:
            return f"{road} ({area})"
        if road:
            return road
        if area:
            return area
    name = data.get("display_name") if isinstance(data, dict) else None
    if isinstance(name, str) and name.strip():
        return name.split(",")[0].strip()
    return None


class StubEtaRunner:
    """AgentRunner that returns canned ETA for service_query_execution tasks."""

    runner_name = "stub_eta"
    supports_reconciliation = False

    def __init__(self, config: object = None):
        self.config = config

    def validate_config(self) -> None:
        return None

    def health(self) -> dict[str, Any]:
        return {"status": "ok", "runner": self.runner_name}

    def execute(self, task: dict, prompt: str, session_name: str) -> RunnerResult:
        # Parse the task payload to confirm it's a service_query_execution
        # for the eta_query capability. If not, fail gracefully so we can
        # see what was claimed.
        payload_type = task.get("payload_type", "")
        payload_raw = task.get("payload", "")
        try:
            payload = json.loads(payload_raw) if isinstance(payload_raw, str) else (payload_raw or {})
        except json.JSONDecodeError:
            payload = {}

        capability = payload.get("capability", "")
        params = payload.get("params", {}) if isinstance(payload.get("params"), dict) else {}

        # Echo what we saw so we can debug from the logs if needed.
        print(
            f"[stub_eta] claimed task {task.get('id','?')} "
            f"payload_type={payload_type} capability={capability} params={params}",
            flush=True,
        )

        if capability != "eta_query":
            return RunnerResult(
                state="failed",
                error=f"stub_eta runner only handles eta_query; got '{capability}'",
            )

        # Demo pacing — let the requester's handoff stepper play before
        # the answer arrives. Fast path (=0) for tests.
        if _RESPONSE_DELAY_SECONDS > 0:
            print(f"[stub_eta] holding response {_RESPONSE_DELAY_SECONDS}s (demo pacing)", flush=True)
            time.sleep(_RESPONSE_DELAY_SECONDS)

        # Canned result matching the eta_query result schema. Lexicon
        # requires `status` (one of on_route/not_on_route/out_of_service/
        # not_found); other fields optional.
        location = params.get("location") if isinstance(params.get("location"), dict) else {}
        lat, lng = location.get("lat"), location.get("lng")
        has_coords = isinstance(lat, (int, float)) and isinstance(lng, (int, float))

        # Name the stop. Reverse-geocode the requester's coordinates to a
        # real nearby place (a transit provider resolves location → stop);
        # fall back when disabled / offline / coordinate-less.
        stop_name = None
        if has_coords and _REVERSE_GEOCODE_ENABLED:
            stop_name = _reverse_geocode(float(lat), float(lng))
        if stop_name is None:
            stop_name = params.get("stop_name") or "your stop"

        # Build a maps deep link so the result card shows an "Open in
        # Maps" CTA. Prefer exact coords; fall back to a text search.
        if has_coords:
            map_url = f"https://www.google.com/maps/search/?api=1&query={lat},{lng}"
        else:
            map_url = (
                "https://www.google.com/maps/search/?api=1&query="
                f"{urllib.parse.quote_plus(str(stop_name))}"
            )
        result_payload = {
            "status": "on_route",
            "eta_minutes": 6,
            "vehicle_type": "bus",
            "route_name": f"Route {params.get('route_id', '14')}",
            "stop_name": stop_name,
            "map_url": map_url,
            "message": "stub_eta_runner (canned test data)",
        }

        # Pass back as compact JSON in `summary` — daemon._apply_result
        # will call client.task_complete with this string and Core will
        # use it as the service response payload on the D2D reply.
        return RunnerResult(
            state="completed",
            summary=json.dumps(result_payload),
            metadata={"capability": capability},
        )

    def reconcile(self, task: dict) -> RunnerResult | None:
        return None

    def cancel(self, task: dict) -> None:
        return None
