"""Contacts management routes for the admin UI.

CRUD operations for contacts — all proxied to core using CLIENT_TOKEN.
Brain never stores contact data locally; it is a pass-through to core.

Maps to Brain TEST_PLAN SS8.2 (Contact Management).

No imports from dina_brain — module boundary enforced.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

log = logging.getLogger(__name__)

router = APIRouter(prefix="/contacts")


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class ContactCreate(BaseModel):
    """Payload for creating or updating a contact.

    ``did`` is the contact's decentralized identifier.
    ``trust_level`` follows the Trust Ring model:
        unverified -> verified -> verified_actioned.
    ``sharing_tier`` controls what data the contact can see:
        open | restricted | locked.
    """

    did: str
    name: str
    trust_level: str = "unverified"
    sharing_tier: str = "open"


# ---------------------------------------------------------------------------
# State holder — injected by create_admin_app
# ---------------------------------------------------------------------------

_core_client: Any = None


def _parse_sharing_tier(raw: str) -> str:
    """Convert core's SharingPolicy JSON to a display label."""
    if not raw or raw == "{}" or raw == "{}":
        return "open"
    return raw


def set_core_client(core_client: Any) -> None:
    """Set the core client.  Called once during app creation."""
    global _core_client
    _core_client = core_client


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/")
async def list_contacts() -> list[dict]:
    """List all contacts.

    Proxies to core's ``/v1/contacts`` API.  Returns a list of contact
    dicts with DID, name, trust level, and sharing tier.
    """
    if _core_client is None:
        raise HTTPException(status_code=503, detail="Core client not configured")

    try:
        contacts = await _core_client.list_contacts()
        # Normalise core's PascalCase keys to snake_case for the frontend.
        return [
            {
                "did": c.get("DID", c.get("did", "")),
                "name": c.get("Name", c.get("name", "")),
                "trust_level": c.get("TrustLevel", c.get("trust_level", "unknown")),
                "sharing_tier": _parse_sharing_tier(
                    c.get("SharingPolicy", c.get("sharing_tier", "open")),
                ),
            }
            for c in contacts
        ]
    except Exception as exc:
        log.error(
            "contacts.list_error",
            extra={"error": type(exc).__name__},
        )
        raise HTTPException(
            status_code=502,
            detail="Failed to fetch contacts from core",
        ) from exc


@router.post("/")
async def add_contact(contact: ContactCreate) -> dict:
    """Add a new contact.

    Creates the contact in core's contact directory via ``/v1/contacts``.
    Returns the created contact dict.
    """
    if _core_client is None:
        raise HTTPException(status_code=503, detail="Core client not configured")

    # Map admin UI trust levels to core's values (blocked/unknown/trusted)
    trust_map = {
        "unverified": "unknown",
        "verified": "trusted",
        "verified_actioned": "trusted",
    }
    core_trust = trust_map.get(contact.trust_level, contact.trust_level)

    try:
        await _core_client.add_contact(
            contact.did, contact.name, core_trust,
        )
        log.info("contacts.added", extra={"did": contact.did})
        return contact.model_dump()
    except Exception as exc:
        log.error(
            "contacts.add_error",
            extra={"did": contact.did, "error": type(exc).__name__},
        )
        raise HTTPException(
            status_code=502,
            detail="Failed to add contact in core",
        ) from exc


@router.put("/{did}")
async def update_contact(did: str, contact: ContactCreate) -> dict:
    """Update contact details via core's contact directory API."""
    if _core_client is None:
        raise HTTPException(status_code=503, detail="Core client not configured")

    try:
        result = await _core_client.update_contact(
            did,
            name=contact.name,
            trust_level=contact.trust_level,
        )
        log.info("contacts.updated", extra={"did": did})
        return result
    except Exception as exc:
        log.error(
            "contacts.update_error",
            extra={"did": did, "error": type(exc).__name__},
        )
        raise HTTPException(
            status_code=502,
            detail="Failed to update contact in core",
        ) from exc


@router.delete("/{did}")
async def remove_contact(did: str) -> dict:
    """Remove a contact via core's contact directory API."""
    if _core_client is None:
        raise HTTPException(status_code=503, detail="Core client not configured")

    try:
        result = await _core_client.delete_contact(did)
        log.info("contacts.removed", extra={"did": did})
        return result
    except Exception as exc:
        log.error(
            "contacts.remove_error",
            extra={"did": did, "error": type(exc).__name__},
        )
        raise HTTPException(
            status_code=502,
            detail="Failed to remove contact from core",
        ) from exc
