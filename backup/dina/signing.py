"""Verdict signing — Ed25519 signatures over canonical verdict JSON."""

from __future__ import annotations

import json

from dina.did_key import derive_did_key
from dina.identity import DinaIdentity
from dina.models import ProductVerdict


def canonicalize_verdict(verdict: ProductVerdict) -> str:
    """Produce a deterministic canonical JSON string for signing.

    Excludes ``signature_hex`` and ``signer_did`` to avoid circularity.
    """
    data = verdict.model_dump(exclude={"signature_hex", "signer_did", "stream_id"})
    return json.dumps(data, sort_keys=True, separators=(",", ":"))


def sign_verdict(
    verdict: ProductVerdict, identity: DinaIdentity
) -> tuple[str, str]:
    """Sign a verdict and return ``(signature_hex, signer_did)``."""
    canonical = canonicalize_verdict(verdict)
    signature = identity.sign(canonical.encode("utf-8"))
    did = derive_did_key(identity)
    return signature.hex(), did


def verify_verdict_signature(
    canonical_json: str, signature_hex: str, identity: DinaIdentity
) -> bool:
    """Verify an Ed25519 signature over canonical verdict JSON."""
    signature = bytes.fromhex(signature_hex)
    return identity.verify(signature, canonical_json.encode("utf-8"))
