"""Minimal fake PLC Directory for local development.

Implements the subset of the did:plc directory API that the Bluesky PDS
needs for account creation and DID resolution. All data is in-memory
and ephemeral (resets on container restart).

Endpoints:
  GET  /healthz          Docker healthcheck
  GET  /_health           PLC-style health (returns version)
  POST /{did}             Accept signed PLC operation
  GET  /{did}             Resolve DID → W3C DID Document
  GET  /{did}/data        Compact DID data (operation fields + did)
  GET  /{did}/log         Full operation log
  GET  /{did}/log/audit   Audit log with CIDs and timestamps
  GET  /{did}/log/last    Last operation
"""

from __future__ import annotations

import datetime
import hashlib
import json
import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("plc")

app = FastAPI(title="Dina Fake PLC Directory", version="0.1.0")

# ---------------------------------------------------------------------------
# In-memory storage: did -> {operations: [...], timestamps: [...]}
# ---------------------------------------------------------------------------
_registry: dict[str, dict[str, Any]] = {}

DID_CONTEXT = [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1",
    "https://w3id.org/security/suites/secp256k1-2019/v1",
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fake_cid(data: bytes) -> str:
    """Generate a deterministic fake CID from data bytes."""
    h = hashlib.sha256(data).hexdigest()
    return f"bafyrei{h[:46]}"


def _op_to_did_document(did: str, op: dict[str, Any]) -> dict[str, Any]:
    """Convert a PLC operation to a W3C DID Document."""
    doc: dict[str, Any] = {
        "@context": DID_CONTEXT,
        "id": did,
        "alsoKnownAs": op.get("alsoKnownAs", []),
        "verificationMethod": [],
        "service": [],
    }

    # Convert verificationMethods map to W3C array format.
    for key_id, pub_key in op.get("verificationMethods", {}).items():
        doc["verificationMethod"].append({
            "id": f"{did}#{key_id}",
            "type": "Multikey",
            "controller": did,
            "publicKeyMultibase": pub_key.removeprefix("did:key:"),
        })

    # Convert services map to W3C array format.
    for svc_id, svc_data in op.get("services", {}).items():
        if isinstance(svc_data, dict):
            doc["service"].append({
                "id": f"#{svc_id}",
                "type": svc_data.get("type", ""),
                "serviceEndpoint": svc_data.get("endpoint", ""),
            })
        else:
            doc["service"].append({
                "id": f"#{svc_id}",
                "type": "AtprotoPersonalDataServer",
                "serviceEndpoint": str(svc_data),
            })

    return doc


def _op_to_data(did: str, op: dict[str, Any]) -> dict[str, Any]:
    """Convert a PLC operation to compact data format (GET /{did}/data)."""
    return {
        "did": did,
        "verificationMethods": op.get("verificationMethods", {}),
        "rotationKeys": op.get("rotationKeys", []),
        "alsoKnownAs": op.get("alsoKnownAs", []),
        "services": op.get("services", {}),
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/_health")
async def health() -> dict[str, str]:
    return {"version": "0.1.0"}


@app.post("/{did}")
async def create_or_update(did: str, request: Request) -> JSONResponse:
    """Accept a signed PLC operation for a DID."""
    body = await request.body()
    try:
        op = json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return JSONResponse(
            {"error": "InvalidRequest", "message": "Body must be valid JSON"},
            status_code=400,
        )

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()

    if did not in _registry:
        _registry[did] = {"operations": [], "timestamps": []}

    _registry[did]["operations"].append(op)
    _registry[did]["timestamps"].append(now)

    logger.info("Stored operation for %s (total: %d)", did, len(_registry[did]["operations"]))
    return JSONResponse(content=None, status_code=200)


@app.get("/{did}")
async def resolve_did(did: str) -> JSONResponse:
    """Resolve a DID to its W3C DID Document."""
    entry = _registry.get(did)
    if not entry or not entry["operations"]:
        return JSONResponse(
            {"error": "NotFound", "message": f"DID not found: {did}"},
            status_code=404,
        )

    last_op = entry["operations"][-1]
    doc = _op_to_did_document(did, last_op)
    return JSONResponse(
        content=doc,
        media_type="application/did+ld+json",
    )


@app.get("/{did}/data")
async def did_data(did: str) -> JSONResponse:
    """Return compact DID data from the latest operation."""
    entry = _registry.get(did)
    if not entry or not entry["operations"]:
        return JSONResponse(
            {"error": "NotFound", "message": f"DID not found: {did}"},
            status_code=404,
        )

    last_op = entry["operations"][-1]
    return JSONResponse(content=_op_to_data(did, last_op))


@app.get("/{did}/log")
async def did_log(did: str) -> JSONResponse:
    """Return the full operation log for a DID."""
    entry = _registry.get(did)
    if not entry or not entry["operations"]:
        return JSONResponse(
            {"error": "NotFound", "message": f"DID not found: {did}"},
            status_code=404,
        )
    return JSONResponse(content=entry["operations"])


@app.get("/{did}/log/audit")
async def did_log_audit(did: str) -> JSONResponse:
    """Return an audit log with CIDs and timestamps."""
    entry = _registry.get(did)
    if not entry or not entry["operations"]:
        return JSONResponse(
            {"error": "NotFound", "message": f"DID not found: {did}"},
            status_code=404,
        )

    audit = []
    for op, ts in zip(entry["operations"], entry["timestamps"]):
        cid = _fake_cid(json.dumps(op, sort_keys=True).encode())
        audit.append({"cid": cid, "createdAt": ts, "nullified": False})
    return JSONResponse(content=audit)


@app.get("/{did}/log/last")
async def did_log_last(did: str) -> JSONResponse:
    """Return the last operation for a DID."""
    entry = _registry.get(did)
    if not entry or not entry["operations"]:
        return JSONResponse(
            {"error": "NotFound", "message": f"DID not found: {did}"},
            status_code=404,
        )
    return JSONResponse(content=entry["operations"][-1])
