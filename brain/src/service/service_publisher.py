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

log = logging.getLogger(__name__)


class ServicePublisher:
    """Publishes the local service profile to PDS for discovery."""

    def __init__(self, core_client: Any, pds_publisher: Any) -> None:
        self._core = core_client
        self._pds = pds_publisher

    async def publish(self) -> None:
        """Read service config from Core and publish to PDS.

        If the config is missing or ``is_public`` is False, unpublishes
        instead (idempotent delete).
        """
        config = await self._core.get_service_config()
        if not config or not config.get("is_public"):
            await self.unpublish()
            return

        capabilities = config.get("capabilities", {})
        record = {
            "$type": "com.dina.service.profile",
            "name": config.get("name", ""),
            "description": config.get("description", ""),
            "capabilities": list(capabilities.keys()),
            "serviceArea": config.get("service_area"),
            "responsePolicy": {
                k: v.get("response_policy", "auto")
                for k, v in capabilities.items()
            },
            "isPublic": True,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }

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
                extra={"name": record["name"], "capabilities": record["capabilities"]},
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
