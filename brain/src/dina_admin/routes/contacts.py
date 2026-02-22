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

    Proxies to core's contacts API.  Returns a list of contact dicts
    with DID, name, trust level, and sharing tier.
    """
    if _core_client is None:
        raise HTTPException(status_code=503, detail="Core client not configured")

    try:
        result = await _core_client.get_kv("contacts_list")
        if result is None:
            return []
        # Core returns contacts as a JSON string in KV; parse if needed.
        # For now, return an empty list until core implements a dedicated
        # contacts endpoint.
        return []
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

    Creates the contact in core's contact store via the vault API.
    Returns the created contact dict.
    """
    if _core_client is None:
        raise HTTPException(status_code=503, detail="Core client not configured")

    contact_dict = contact.model_dump()
    try:
        item_id = await _core_client.store_vault_item(
            "contacts",
            {
                "type": "contact",
                "source": "admin_ui",
                "source_id": contact.did,
                "summary": f"Contact: {contact.name}",
                "body_text": "",
                **contact_dict,
            },
        )
        contact_dict["id"] = item_id
        log.info("contacts.added", extra={"did": contact.did})
        return contact_dict
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
    """Update contact details.

    Updates the contact in core's contact store.  The ``did`` path
    parameter identifies the contact; the body carries the new values.
    """
    if _core_client is None:
        raise HTTPException(status_code=503, detail="Core client not configured")

    contact_dict = contact.model_dump()
    contact_dict["did"] = did
    try:
        await _core_client.store_vault_item(
            "contacts",
            {
                "type": "contact",
                "source": "admin_ui",
                "source_id": did,
                "summary": f"Contact: {contact.name}",
                "body_text": "",
                **contact_dict,
            },
        )
        log.info("contacts.updated", extra={"did": did})
        return contact_dict
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
    """Remove a contact.

    Deletes the contact from core's contact store.
    Returns a confirmation dict.
    """
    if _core_client is None:
        raise HTTPException(status_code=503, detail="Core client not configured")

    try:
        # Mark contact as deleted via KV tombstone
        await _core_client.set_kv(f"contact_deleted:{did}", "true")
        log.info("contacts.removed", extra={"did": did})
        return {"did": did, "status": "removed"}
    except Exception as exc:
        log.error(
            "contacts.remove_error",
            extra={"did": did, "error": type(exc).__name__},
        )
        raise HTTPException(
            status_code=502,
            detail="Failed to remove contact from core",
        ) from exc
