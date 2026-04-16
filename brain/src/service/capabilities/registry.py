"""Shared capability registry for service discovery.

Central registry of supported service capabilities. Used by:
- VaultContextAssembler (TTL lookup for query_service tool)
- ServiceHandler (params validation on provider side)
- Guardian (response formatting for rich notifications)

Add new capabilities by defining a Pydantic params/result model in this
package and registering it here.
"""

from __future__ import annotations

from .eta_query import EtaQueryParams, EtaQueryResult

CAPABILITY_REGISTRY: dict[str, dict] = {
    "eta_query": {
        "params_model": EtaQueryParams,
        "result_model": EtaQueryResult,
        "description": "Query estimated time of arrival for a transit service.",
        "default_ttl_seconds": 60,
    },
}

SUPPORTED_CAPABILITIES = list(CAPABILITY_REGISTRY.keys())


def get_ttl(capability: str) -> int:
    """Return the default TTL in seconds for a capability, or 60 as fallback."""
    entry = CAPABILITY_REGISTRY.get(capability)
    if entry:
        return entry.get("default_ttl_seconds", 60)
    return 60
