"""Pydantic models for the eta_query capability.

Used by both the requester side (ServiceQueryOrchestrator) and the
provider side (ServiceHandler) to validate params and results for
real-time ETA queries (e.g. "when does bus 42 arrive?").
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class Location(BaseModel):
    lat: float
    lng: float


class EtaQueryParams(BaseModel):
    location: Location


class EtaQueryResult(BaseModel):
    eta_minutes: int
    vehicle_type: str
    route_name: str
    current_location: Optional[Location] = None
