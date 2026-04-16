"""Pydantic models for the eta_query capability.

Used for reference/documentation. In the revised WS2 architecture,
param validation uses provider-published JSON Schema (not Pydantic).
These models stay for backward compatibility and type hints.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class Location(BaseModel):
    lat: float
    lng: float


class EtaQueryParams(BaseModel):
    location: Location
    route_id: str = ""  # optional: specific route number


class EtaQueryResult(BaseModel):
    eta_minutes: int
    vehicle_type: str
    route_name: str
    current_location: Optional[Location] = None
    # WS2 additions (all optional — backward compatible):
    stop_name: str = ""
    stop_distance_m: float = 0
    map_url: str = ""
    status: str = "on_route"  # on_route | not_on_route | out_of_service | not_found
    message: str = ""
