"""Devices management routes for the admin UI.

CRUD operations for devices — all proxied to core using CLIENT_TOKEN.
Brain never stores device data locally; it is a pass-through to core.

Maps to Brain TEST_PLAN SS8.3 (Device Management).

No imports from dina_brain — module boundary enforced.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

router = APIRouter(prefix="/devices")


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class PairCompleteRequest(BaseModel):
    """Payload for completing device pairing.

    ``code`` is the 6-digit pairing code from the initiate step.
    ``device_name`` is a human-readable label for the device.
    ``public_key_multibase`` is the optional Ed25519 public key in
    multibase format (e.g. z6MkhaXg...) for key-based auth.
    """

    code: str = Field(..., max_length=64)
    device_name: str = Field(..., max_length=128)
    public_key_multibase: str | None = Field(None, max_length=256)
    role: str | None = Field(None, pattern=r"^(user|agent)$")


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
async def list_devices() -> list[dict]:
    """List all registered devices.

    Proxies to core's ``/v1/devices`` API.  Returns a list of device
    dicts with name, auth type, DID, created/last-seen timestamps,
    and status.
    """
    if _core_client is None:
        raise HTTPException(status_code=503, detail="Core client not configured")

    try:
        devices = await _core_client.list_devices()
        return devices
    except Exception as exc:
        log.error(
            "devices.list_error",
            extra={"error": type(exc).__name__},
        )
        raise HTTPException(
            status_code=502,
            detail="Failed to fetch devices from core",
        ) from exc


@router.post("/pair/initiate")
async def initiate_pairing() -> dict:
    """Generate a pairing code for a new device.

    Proxies to core's ``/v1/pair/initiate`` API.  Returns a dict
    with ``code`` (6-digit string) and ``expires_in`` (seconds).
    """
    if _core_client is None:
        raise HTTPException(status_code=503, detail="Core client not configured")

    try:
        result = await _core_client.initiate_pairing()
        log.info("devices.pairing_initiated")
        return result
    except Exception as exc:
        log.error(
            "devices.initiate_pairing_error",
            extra={"error": type(exc).__name__},
        )
        raise HTTPException(
            status_code=502,
            detail="Failed to initiate pairing with core",
        ) from exc


@router.post("/pair/complete")
async def complete_pairing(req: PairCompleteRequest) -> dict:
    """Complete device pairing with a code and device details.

    Proxies to core's ``/v1/pair/complete`` API.  Returns the
    newly registered device dict.
    """
    if _core_client is None:
        raise HTTPException(status_code=503, detail="Core client not configured")

    try:
        result = await _core_client.complete_pairing(
            req.code, req.device_name, req.public_key_multibase,
            role=req.role,
        )
        log.info(
            "devices.pairing_completed",
            extra={"device_name": req.device_name},
        )
        return result
    except Exception as exc:
        log.error(
            "devices.complete_pairing_error",
            extra={
                "device_name": req.device_name,
                "error": type(exc).__name__,
            },
        )
        raise HTTPException(
            status_code=502,
            detail="Failed to complete pairing with core",
        ) from exc


@router.delete("/{token_id}")
async def revoke_device(token_id: str) -> Response:
    """Revoke a registered device.

    Proxies to core's ``DELETE /v1/devices/{id}`` API.
    Returns HTTP 204 on success.
    """
    if _core_client is None:
        raise HTTPException(status_code=503, detail="Core client not configured")

    try:
        await _core_client.revoke_device(token_id)
        log.info("devices.revoked", extra={"token_id": token_id})
        return Response(status_code=204)
    except Exception as exc:
        log.error(
            "devices.revoke_error",
            extra={"token_id": token_id, "error": type(exc).__name__},
        )
        raise HTTPException(
            status_code=502,
            detail="Failed to revoke device in core",
        ) from exc
