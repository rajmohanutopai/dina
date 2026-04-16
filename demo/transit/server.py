"""SF Transit MCP Server — schedule-based bus ETA.

Exposes a single tool: get_eta(route_id, lat, lng)
Returns schedule-based ETA, nearest stop info, and a Google Maps URL.

This runs as a stdio MCP server inside OpenClaw (not Brain).
Dina never executes directly — OpenClaw calls this tool.

Deterministic for tests: set TRANSIT_TIME_OVERRIDE=2026-04-16T10:00:00
to fix the clock.
"""

from __future__ import annotations

import json
import math
import os
from datetime import datetime, time as dt_time
from pathlib import Path
from typing import Any

from fastmcp import FastMCP

mcp = FastMCP("transit")

# ---------------------------------------------------------------------------
# Route data (loaded once at startup)
# ---------------------------------------------------------------------------

_ROUTES_FILE = Path(__file__).parent / "routes.json"
_ROUTES: list[dict] = []


def _load_routes() -> list[dict]:
    global _ROUTES
    if not _ROUTES:
        with open(_ROUTES_FILE) as f:
            _ROUTES = json.load(f)["routes"]
    return _ROUTES


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Haversine distance in meters between two coordinates."""
    R = 6_371_000  # Earth radius in meters
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _now() -> datetime:
    """Current time, or overridden time for deterministic tests."""
    override = os.environ.get("TRANSIT_TIME_OVERRIDE", "")
    if override:
        return datetime.fromisoformat(override)
    return datetime.now()


def _parse_time(s: str) -> dt_time:
    """Parse HH:MM time string. Handles '00:00' as midnight."""
    h, m = s.split(":")
    return dt_time(int(h) % 24, int(m))


def _is_in_service(route: dict, now: datetime) -> bool:
    """Check if route is currently in service."""
    current = now.time()
    start = _parse_time(route["service_start"])
    end = _parse_time(route["service_end"])
    if end == dt_time(0, 0):
        # Midnight = end of day
        return current >= start
    return start <= current <= end


def _nearest_stop(route: dict, lat: float, lng: float) -> tuple[dict, float, int]:
    """Find nearest stop on route. Returns (stop, distance_m, stop_index)."""
    best_stop = route["stops"][0]
    best_dist = float("inf")
    best_idx = 0
    for i, stop in enumerate(route["stops"]):
        d = _haversine_m(lat, lng, stop["lat"], stop["lng"])
        if d < best_dist:
            best_dist = d
            best_stop = stop
            best_idx = i
    return best_stop, best_dist, best_idx


def _next_eta_minutes(route: dict, now: datetime) -> int:
    """Schedule-based ETA: minutes until next bus at the given stop.

    Simple model: buses depart first stop at service_start, then every
    frequency_minutes. ETA at stop N = departure + N * inter-stop-minutes.
    """
    freq = route["frequency_minutes"]
    start = _parse_time(route["service_start"])
    # Minutes since service start
    current_minutes = now.hour * 60 + now.minute
    start_minutes = start.hour * 60 + start.minute
    if current_minutes < start_minutes:
        return start_minutes - current_minutes

    elapsed = current_minutes - start_minutes
    # Next departure from first stop
    next_departure_offset = ((elapsed // freq) + 1) * freq
    return next_departure_offset - elapsed


def _estimate_bus_position(route: dict, stop_idx: int, eta_min: int) -> dict:
    """Estimate bus current position (simple: interpolate from previous stop)."""
    stops = route["stops"]
    if stop_idx == 0 or eta_min <= 0:
        return {"lat": stops[0]["lat"], "lng": stops[0]["lng"]}
    # Assume bus is between previous stop and the target stop
    prev = stops[max(0, stop_idx - 1)]
    target = stops[stop_idx]
    # Rough interpolation: bus is halfway between prev and target
    return {
        "lat": (prev["lat"] + target["lat"]) / 2,
        "lng": (prev["lng"] + target["lng"]) / 2,
    }


def _google_maps_url(bus_lat: float, bus_lng: float, stop_lat: float, stop_lng: float) -> str:
    """Build Google Maps directions URL (free, no API key)."""
    return (
        f"https://www.google.com/maps/dir/?api=1"
        f"&origin={bus_lat:.6f},{bus_lng:.6f}"
        f"&destination={stop_lat:.6f},{stop_lng:.6f}"
        f"&travelmode=transit"
    )


# ---------------------------------------------------------------------------
# MCP Tool
# ---------------------------------------------------------------------------

def _get_eta_impl(route_id: str, lat: float, lng: float) -> dict[str, Any]:
    """Get schedule-based ETA for a bus route at the user's location.

    Args:
        route_id: Bus route number (e.g., "42")
        lat: User's latitude
        lng: User's longitude

    Returns:
        Dict with eta_minutes, stop_name, map_url, status, etc.
    """
    routes = _load_routes()
    now = _now()

    # Find route
    route = None
    for r in routes:
        if r["route_id"] == route_id:
            route = r
            break

    if route is None:
        return {
            "status": "not_found",
            "message": f"Route {route_id} not found. Available routes: {', '.join(r['route_id'] for r in routes)}",
        }

    # Check service hours
    if not _is_in_service(route, now):
        return {
            "status": "out_of_service",
            "message": f"Bus {route_id} ({route['name']}) is not running at this time. "
                       f"Service hours: {route['service_start']}–{route['service_end']}.",
            "route_name": route["name"],
            "vehicle_type": route["vehicle_type"],
        }

    # Find nearest stop
    stop, distance_m, stop_idx = _nearest_stop(route, lat, lng)

    # Check if user is reasonably close to the route (2km threshold)
    if distance_m > 2000:
        return {
            "status": "not_on_route",
            "message": f"Bus {route_id} ({route['name']}) doesn't serve your area. "
                       f"Nearest stop is {stop['name']} ({distance_m:.0f}m away).",
            "route_name": route["name"],
            "vehicle_type": route["vehicle_type"],
            "stop_name": stop["name"],
            "stop_distance_m": round(distance_m, 1),
        }

    # Compute ETA
    eta = _next_eta_minutes(route, now)

    # Estimate bus position for map
    bus_pos = _estimate_bus_position(route, stop_idx, eta)
    map_url = _google_maps_url(bus_pos["lat"], bus_pos["lng"], stop["lat"], stop["lng"])

    return {
        "status": "on_route",
        "eta_minutes": eta,
        "stop_name": stop["name"],
        "stop_distance_m": round(distance_m, 1),
        "route_name": route["name"],
        "vehicle_type": route["vehicle_type"],
        "map_url": map_url,
        "message": f"Bus {route_id} ({route['name']}) — {eta} min to {stop['name']}",
    }


@mcp.tool()
def get_eta(route_id: str, lat: float, lng: float) -> dict[str, Any]:
    """Get schedule-based ETA for a bus route at the user's location.

    Args:
        route_id: Bus route number (e.g., "42")
        lat: User's latitude
        lng: User's longitude

    Returns:
        Dict with eta_minutes, stop_name, map_url, status, etc.
    """
    return _get_eta_impl(route_id, lat, lng)
