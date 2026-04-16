"""AT Protocol PDS publisher for trust records.

Publishes com.dina.trust.* records to the community PDS
(e.g., pds.dinakernel.com) via standard AT Protocol API.

Records are signed with the PDS account credentials, not the
Home Node identity key. The PDS account is created during
install.sh and credentials are stored in Core's config.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

import httpx

log = logging.getLogger(__name__)


class PDSPublisher:
    """Publishes trust records to the AT Protocol PDS."""

    def __init__(self, pds_url: str, handle: str, password: str) -> None:
        self._pds_url = pds_url.rstrip("/")
        self._handle = handle
        self._password = password
        self._access_jwt: str | None = None
        self._did: str | None = None
        self._session_expires: float = 0
        self._client = httpx.AsyncClient(timeout=15)

    async def _ensure_session(self) -> None:
        """Create or refresh PDS auth session."""
        if self._access_jwt and time.time() < self._session_expires:
            return

        resp = await self._client.post(
            f"{self._pds_url}/xrpc/com.atproto.server.createSession",
            json={"identifier": self._handle, "password": self._password},
        )
        resp.raise_for_status()
        data = resp.json()
        self._access_jwt = data["accessJwt"]
        self._did = data["did"]
        # Sessions last ~2 hours, refresh after 1 hour
        self._session_expires = time.time() + 3600
        log.info("pds_publisher.session_created", extra={"did": self._did})

    async def publish_vouch(
        self, subject_did: str, text: str, confidence: str = "high",
        relationship: str = "personal",
    ) -> dict:
        """Publish a com.dina.trust.vouch record."""
        await self._ensure_session()
        record = {
            "$type": "com.dina.trust.vouch",
            "subject": subject_did,
            "vouchType": "personal",
            "confidence": confidence,
            "relationship": relationship,
            "text": text,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        return await self._create_record("com.dina.trust.vouch", record)

    async def publish_review(
        self, subject_name: str, text: str, sentiment: str = "positive",
        category: str = "product-review",
    ) -> dict:
        """Publish a com.dina.trust.attestation record (product review)."""
        await self._ensure_session()
        record = {
            "$type": "com.dina.trust.attestation",
            "subject": {
                "type": "product",
                "name": subject_name,
            },
            "category": category,
            "sentiment": sentiment,
            "confidence": "high",
            "text": text,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        return await self._create_record("com.dina.trust.attestation", record)

    async def publish_flag(
        self, subject_did: str, text: str, severity: str = "critical",
    ) -> dict:
        """Publish a com.dina.trust.flag record."""
        await self._ensure_session()
        record = {
            "$type": "com.dina.trust.flag",
            "subject": {"type": "did", "did": subject_did},
            "flagType": "fraud",
            "severity": severity,
            "text": text,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        return await self._create_record("com.dina.trust.flag", record)

    async def _create_record(self, collection: str, record: dict) -> dict:
        """Create an AT Protocol record on the PDS."""
        resp = await self._client.post(
            f"{self._pds_url}/xrpc/com.atproto.repo.createRecord",
            headers={"Authorization": f"Bearer {self._access_jwt}"},
            json={
                "repo": self._did,
                "collection": collection,
                "record": record,
            },
        )
        resp.raise_for_status()
        result = resp.json()
        log.info(
            "pds_publisher.record_created",
            extra={"collection": collection, "uri": result.get("uri", "")},
        )
        return result

    async def put_record(
        self, collection: str, rkey: str, record: dict,
    ) -> dict:
        """Upsert an AT Protocol record on the PDS (stable rkey)."""
        await self._ensure_session()
        resp = await self._client.post(
            f"{self._pds_url}/xrpc/com.atproto.repo.putRecord",
            headers={"Authorization": f"Bearer {self._access_jwt}"},
            json={
                "repo": self._did,
                "collection": collection,
                "rkey": rkey,
                "record": record,
            },
        )
        resp.raise_for_status()
        result = resp.json()
        log.info(
            "pds_publisher.record_upserted",
            extra={"collection": collection, "rkey": rkey, "uri": result.get("uri", "")},
        )
        return result

    async def delete_record(self, collection: str, rkey: str) -> None:
        """Delete an AT Protocol record from the PDS."""
        await self._ensure_session()
        resp = await self._client.post(
            f"{self._pds_url}/xrpc/com.atproto.repo.deleteRecord",
            headers={"Authorization": f"Bearer {self._access_jwt}"},
            json={
                "repo": self._did,
                "collection": collection,
                "rkey": rkey,
            },
        )
        resp.raise_for_status()
        log.info(
            "pds_publisher.record_deleted",
            extra={"collection": collection, "rkey": rkey},
        )

    @property
    def did(self) -> str | None:
        return self._did
