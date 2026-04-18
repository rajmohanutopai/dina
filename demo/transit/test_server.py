"""Tests for the transit MCP tool.

Exercises ``demo/transit/server.py::_get_eta_impl`` directly so the
schedule-based ETA engine is tested in isolation (no FastMCP wrapper,
no OpenClaw). Uses ``TRANSIT_TIME_OVERRIDE`` to pin the clock for
deterministic assertions.

Coverage matches what the transit demo advertises to requesters:

- nearest-stop haversine selection
- schedule ETA math (minutes until next departure)
- out-of-service hours (before start, after end, crossing midnight)
- route-not-found
- stop-not-on-route (user too far from nearest stop)
- Google Maps URL shape (transit travel mode, 6-decimal coords)
- vehicle_type + route_name propagation
"""

from __future__ import annotations

import math
import os

import pytest

# demo/ is not a package; import by path.
import sys
from pathlib import Path
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent.parent))

from demo.transit.server import (  # noqa: E402
    _get_eta_impl,
    _google_maps_url,
    _haversine_m,
    _is_in_service,
    _load_routes,
    _nearest_stop,
    _next_eta_minutes,
    _now,
    _parse_time,
)


@pytest.fixture(autouse=True)
def _clock():
    """Pin the transit clock to a known in-service time for tests.

    2026-04-16T10:00:00 is a Thursday morning — all three demo routes
    are in service at this point so individual tests can exercise
    branches by overriding further.
    """
    os.environ["TRANSIT_TIME_OVERRIDE"] = "2026-04-16T10:00:00"
    yield
    os.environ.pop("TRANSIT_TIME_OVERRIDE", None)


# ---------------------------------------------------------------------------
# Unit-level helpers
# ---------------------------------------------------------------------------

def test_haversine_known_distance():
    # Embarcadero to Castro Station: straight-line great-circle ≈ 5.07 km.
    # (Road distance is longer; haversine measures bird-flight.)
    d = _haversine_m(37.7936, -122.3930, 37.7625, -122.4351)
    assert 4800 < d < 5300, f"expected ~5.1 km, got {d:.0f} m"


def test_haversine_self_distance_is_zero():
    assert _haversine_m(37.7625, -122.4351, 37.7625, -122.4351) < 0.01


def test_parse_time_midnight_wraps_to_zero():
    t = _parse_time("24:00")
    assert (t.hour, t.minute) == (0, 0)


def test_is_in_service_before_start_is_false():
    now = _now().replace(hour=4, minute=0)
    route = {"service_start": "06:00", "service_end": "23:00"}
    assert _is_in_service(route, now) is False


def test_is_in_service_within_hours_is_true():
    now = _now().replace(hour=12, minute=0)
    route = {"service_start": "06:00", "service_end": "23:00"}
    assert _is_in_service(route, now) is True


def test_is_in_service_after_end_is_false():
    now = _now().replace(hour=23, minute=30)
    route = {"service_start": "06:00", "service_end": "23:00"}
    assert _is_in_service(route, now) is False


def test_is_in_service_end_midnight_runs_late():
    # Service end = 00:00 means "runs until end of day" per the parser.
    now = _now().replace(hour=23, minute=45)
    route = {"service_start": "05:30", "service_end": "00:00"}
    assert _is_in_service(route, now) is True


def test_nearest_stop_picks_closest_of_many():
    routes = _load_routes()
    route = next(r for r in routes if r["route_id"] == "42")
    # Castro Station is in the route; a point right on it should be the nearest.
    stop, dist, idx = _nearest_stop(route, 37.7625, -122.4351)
    assert stop["name"] == "Castro Station"
    assert dist < 10  # meters
    assert route["stops"][idx]["name"] == "Castro Station"


def test_next_eta_minutes_cycles_on_frequency():
    route = {"service_start": "06:00", "frequency_minutes": 10}
    # 10:03 — service started 4h3m ago. Next departure at t=243 (4*60+3)
    # rounded up to next multiple of 10 → 250. ETA = 250-243 = 7.
    now = _now().replace(hour=10, minute=3)
    assert _next_eta_minutes(route, now) == 7


def test_next_eta_minutes_before_service_waits_until_start():
    route = {"service_start": "06:00", "frequency_minutes": 10}
    now = _now().replace(hour=5, minute=30)
    # 30 minutes until 06:00.
    assert _next_eta_minutes(route, now) == 30


def test_google_maps_url_shape():
    url = _google_maps_url(37.764800, -122.432200, 37.762500, -122.435100)
    assert url.startswith("https://www.google.com/maps/dir/?api=1")
    assert "travelmode=transit" in url
    assert "origin=37.764800,-122.432200" in url
    assert "destination=37.762500,-122.435100" in url


# ---------------------------------------------------------------------------
# get_eta tool (end-to-end through _get_eta_impl)
# ---------------------------------------------------------------------------

def test_get_eta_happy_path_returns_on_route_result():
    # Alonso's rough location near Castro Station.
    result = _get_eta_impl("42", 37.7648, -122.4322)

    assert result["status"] == "on_route"
    assert isinstance(result["eta_minutes"], int)
    assert 0 <= result["eta_minutes"] <= 12  # frequency is 12 min
    assert result["stop_name"] == "Castro Station"
    assert result["route_name"] == "Market St Express"
    assert result["vehicle_type"] == "Bus"
    assert result["map_url"].startswith("https://www.google.com/maps/dir/?api=1")
    # stop_distance_m is non-negative and reasonable.
    assert result["stop_distance_m"] >= 0
    assert result["stop_distance_m"] < 2000  # within on-route threshold


def test_get_eta_route_not_found():
    result = _get_eta_impl("999", 37.77, -122.43)
    assert result["status"] == "not_found"
    assert "999" in result["message"]


def test_get_eta_out_of_service_before_hours():
    os.environ["TRANSIT_TIME_OVERRIDE"] = "2026-04-16T04:30:00"
    try:
        result = _get_eta_impl("42", 37.7648, -122.4322)
    finally:
        os.environ["TRANSIT_TIME_OVERRIDE"] = "2026-04-16T10:00:00"
    assert result["status"] == "out_of_service"
    assert result["route_name"] == "Market St Express"
    assert "06:00" in result["message"]


def test_get_eta_out_of_service_after_hours():
    os.environ["TRANSIT_TIME_OVERRIDE"] = "2026-04-16T23:45:00"
    try:
        result = _get_eta_impl("42", 37.7648, -122.4322)
    finally:
        os.environ["TRANSIT_TIME_OVERRIDE"] = "2026-04-16T10:00:00"
    # Route 42 runs 06:00–23:00 so 23:45 is out.
    assert result["status"] == "out_of_service"


def test_get_eta_not_on_route_user_too_far():
    # Point in the Pacific Ocean — no SF Muni stop is within 2 km.
    result = _get_eta_impl("42", 34.0, -123.0)
    assert result["status"] == "not_on_route"
    assert result["route_name"] == "Market St Express"
    # Surfaces the nearest stop even though the user isn't on route.
    assert "stop_name" in result
    assert result["stop_distance_m"] > 2000


def test_get_eta_picks_nearest_stop_over_multiple():
    # Ask for ETA near Montgomery St — the tool should prefer that over
    # any farther stop like West Portal.
    result = _get_eta_impl("42", 37.7894, -122.4013)
    assert result["status"] == "on_route"
    assert result["stop_name"] == "Montgomery St"


def test_get_eta_respects_time_override_for_determinism():
    # Two calls at the same override time must return the same ETA.
    a = _get_eta_impl("42", 37.7648, -122.4322)
    b = _get_eta_impl("42", 37.7648, -122.4322)
    assert a["eta_minutes"] == b["eta_minutes"]
    assert a["map_url"] == b["map_url"]


def test_get_eta_map_url_coords_are_six_decimal():
    result = _get_eta_impl("42", 37.7648, -122.4322)
    url = result["map_url"]
    # Parse origin/destination and verify the format.
    import re
    origin = re.search(r"origin=(-?\d+\.\d+),(-?\d+\.\d+)", url)
    dest = re.search(r"destination=(-?\d+\.\d+),(-?\d+\.\d+)", url)
    assert origin and dest, f"URL missing coords: {url}"
    # 6 decimals = ~11 cm precision; assert format is consistent.
    for group in (origin.group(1), origin.group(2), dest.group(1), dest.group(2)):
        assert len(group.split(".")[1]) == 6
