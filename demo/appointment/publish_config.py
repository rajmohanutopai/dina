"""Publish Dr Carl's service config to his Core.

Sample provider-config publisher for the appointment demo. Pushes the
service-level config (capabilities, capability_schemas, service_area)
to the provider's Core via `PUT /v1/service/config`. Core persists it
and the service_publisher propagates to AT Protocol / AppView.

Run inside the provider's Brain container so `ServiceIdentity` picks up
the Brain's Ed25519 key from `$DINA_SERVICE_KEY_DIR`:

    docker cp demo/appointment/publish_config.py \\
        dina-test-drcarl-brain-1:/tmp/publish_config.py
    docker exec dina-test-drcarl-brain-1 \\
        python3 /tmp/publish_config.py

`schema_hash` is computed here from the canonical (description, params,
result) and included in the PUT payload. Never hardcode the hash: the
canonical computation is the source of truth, and service_publisher
republishes the same value to AppView.
"""
import asyncio
import os
from pathlib import Path

from src.adapter.core_http import CoreHTTPClient
from src.adapter.signing import ServiceIdentity
from src.service.capabilities.registry import compute_schema_hash


CONFIG = {
    "is_discoverable": True,
    "name": "Dr Carl — Castro Family Dentistry",
    "description": "Dentist — check live appointment confirmation status.",
    "capabilities": {
        "appointment_status": {"response_policy": "auto"},
    },
    "capability_schemas": {
        "appointment_status": {
            "description": "Check live confirmation status for a patient's appointment.",
            "mcp_tool": "appointment__check_appointment",
            "params": {
                "type": "object",
                "required": ["patient_ref"],
                "properties": {
                    "patient_ref": {"type": "string"},
                    "date": {"type": "string"},
                    "time": {"type": "string"},
                },
            },
            "result": {
                "type": "object",
                "required": ["status"],
                "properties": {
                    "status": {
                        "type": "string",
                        "enum": ["confirmed", "rescheduled", "cancelled", "not_found"],
                    },
                    "patient_ref": {"type": "string"},
                    "date": {"type": "string"},
                    "time": {"type": "string"},
                    "note": {"type": "string"},
                },
            },
            "default_ttl_seconds": 180,
        },
    },
    "service_area": {"lat": 37.76, "lng": -122.43, "radius_km": 10},
}


def _with_computed_hashes(cfg: dict) -> dict:
    """Return a copy of cfg with schema_hash computed canonically for
    every entry in capability_schemas. The hash is over (description,
    params, result) — same canonical form the Brain's service_publisher
    uses. mcp_tool and default_ttl_seconds are NOT part of the hash.
    """
    out = {**cfg}
    cap_schemas_in = cfg.get("capability_schemas") or {}
    cap_schemas_out: dict[str, dict] = {}
    for name, raw in cap_schemas_in.items():
        canonical = {
            "description": raw.get("description", ""),
            "params": raw.get("params", {}),
            "result": raw.get("result", {}),
        }
        cap_schemas_out[name] = {**raw, "schema_hash": compute_schema_hash(canonical)}
    out["capability_schemas"] = cap_schemas_out
    return out


async def main() -> None:
    core_url = os.environ.get("DINA_CORE_URL", "http://drcarl-core:8100")
    sid = ServiceIdentity(
        Path(os.environ["DINA_SERVICE_KEY_DIR"]), service_name="brain",
    )
    sid.ensure_key()
    core = CoreHTTPClient(base_url=core_url, service_identity=sid)
    payload = _with_computed_hashes(CONFIG)
    resp = await core._request("PUT", "/v1/service/config", json=payload)
    print(f"PUT /v1/service/config → {resp.status_code} {resp.text[:200]}")


if __name__ == "__main__":
    asyncio.run(main())
