"""Shared capability registry for service discovery.

Central registry of supported service capabilities. Used by:
- VaultContextAssembler (TTL lookup for query_service tool)
- ServiceHandler (params validation on provider side)
- Guardian (response formatting for rich notifications)

Add new capabilities by defining a Pydantic params/result model in this
package and registering it here.
"""

from __future__ import annotations

import hashlib
import json

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


def compute_schema_hash(schema_obj: dict) -> str:
    """Compute SHA-256 hash of a capability schema object.

    Hashes the full capability schema (params + result + description),
    canonically serialized (sorted keys, no whitespace).
    Used for schema version matching between requester and provider.
    """
    canonical = json.dumps(schema_obj, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()
