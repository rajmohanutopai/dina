"""Publish/unpublish this node's service profile on the AT Protocol PDS.

Reads the local service config from Core and publishes a
``com.dina.service.profile`` record to the community PDS so that
other Dinas can discover this node via AppView search.

Uses a stable rkey ``"self"`` so repeated publishes are upserts, not
duplicates.

No imports from adapter/ -- uses CoreClient and PDSPublisher via
constructor injection.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from .capabilities.registry import compute_schema_hash

log = logging.getLogger(__name__)


class ServicePublisher:
    """Publishes the local service profile to PDS for discovery."""

    def __init__(self, core_client: Any, pds_publisher: Any) -> None:
        self._core = core_client
        self._pds = pds_publisher

    async def publish(self) -> None:
        """Read service config from Core and publish to PDS.

        If the config is missing or ``is_discoverable`` is False, unpublishes
        instead (idempotent delete).
        """
        config = await self._core.get_service_config()
        if not config or not config.get("is_discoverable"):
            await self.unpublish()
            return

        capabilities = config.get("capabilities", {})
        capability_schemas_raw = config.get("capability_schemas") or {}

        # Build per-capability published schemas. Each entry is the canonical
        # schema object plus a schema_hash. If the config didn't supply a hash,
        # compute it here from the canonical (description, params, result).
        # default_ttl_seconds is a provider hint to requesters — it travels
        # alongside the schema but is NOT part of the canonical form (so it
        # can change without invalidating the schema_hash).
        capability_schemas: dict[str, dict] = {}
        for cap_name in capabilities.keys():
            raw = capability_schemas_raw.get(cap_name)
            if not raw:
                continue
            canonical = {
                "description": raw.get("description", ""),
                "params": raw.get("params", {}),
                "result": raw.get("result", {}),
            }
            schema_hash = raw.get("schema_hash") or compute_schema_hash(canonical)
            entry: dict = {**canonical, "schema_hash": schema_hash}
            ttl = raw.get("default_ttl_seconds")
            if isinstance(ttl, int) and ttl > 0:
                entry["default_ttl_seconds"] = ttl
            capability_schemas[cap_name] = entry

        # AT Protocol records are CBOR-encoded and the lexicon forbids floats
        # (PDS rejects putRecord with "Bad record" when a number has a
        # fractional part). Scale lat/lng by 1e7 into integers at the wire
        # boundary; the ingester divides back when writing to Postgres.
        # radius_km stays integer-coercible (already 0..500).
        svc_area = config.get("service_area") or {}
        service_area_record: dict[str, int] | None = None
        if svc_area and "lat" in svc_area and "lng" in svc_area:
            service_area_record = {
                "latE7": round(float(svc_area["lat"]) * 1e7),
                "lngE7": round(float(svc_area["lng"]) * 1e7),
                "radiusKm": int(svc_area.get("radius_km", 0)),
            }

        record: dict[str, Any] = {
            "$type": "com.dina.service.profile",
            "name": config.get("name", ""),
            "description": config.get("description", ""),
            "capabilities": list(capabilities.keys()),
            "responsePolicy": {
                k: v.get("response_policy", "auto")
                for k, v in capabilities.items()
            },
            "isDiscoverable": True,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }
        if service_area_record is not None:
            record["serviceArea"] = service_area_record
        if capability_schemas:
            record["capabilitySchemas"] = capability_schemas

        # Verify PDS session DID matches the Home Node identity.
        # The PDS publisher's session DID is set after authentication.
        # The Core's DID is fetched from the Core API to cross-check.
        session_did = self._pds.did
        try:
            did_doc = await self._core.get_did()
            core_did = did_doc.get("id") if did_doc else None
        except Exception:
            core_did = None
        if session_did and core_did and session_did != core_did:
            log.error(
                "service_publisher: PDS session DID %s != Core DID %s — refusing to publish under wrong identity",
                session_did,
                core_did,
            )
            return

        try:
            await self._pds.put_record(
                collection="com.dina.service.profile",
                rkey="self",
                record=record,
            )
            log.info(
                "service_publisher.published",
                extra={
                    "service_name": record["name"],
                    "capabilities": record["capabilities"],
                },
            )
        except Exception as exc:
            log.warning(
                "service_publisher.publish_failed",
                extra={"error": str(exc)},
            )

    async def unpublish(self) -> None:
        """Delete the service profile from PDS (idempotent)."""
        try:
            await self._pds.delete_record(
                collection="com.dina.service.profile",
                rkey="self",
            )
            log.info("service_publisher.unpublished")
        except Exception:
            pass  # record may not exist -- safe to ignore
