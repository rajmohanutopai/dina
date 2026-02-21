"""did:key method — derive a W3C DID from Dina's Ed25519 public key."""

from __future__ import annotations

import base58

from dina.did_models import DIDDocument, VerificationMethod
from dina.identity import DinaIdentity

# Multicodec prefix for Ed25519 public keys: 0xed 0x01
_ED25519_MULTICODEC_PREFIX = b"\xed\x01"


def derive_did_key(identity: DinaIdentity) -> str:
    """Derive a ``did:key`` identifier from an Ed25519 public key.

    Encoding: multicodec(0xed01) + raw-32-byte-pubkey → base58-btc → ``did:key:z<encoded>``
    """
    raw_pub = identity.public_key_bytes()
    multicodec_key = _ED25519_MULTICODEC_PREFIX + raw_pub
    encoded = base58.b58encode(multicodec_key).decode("ascii")
    return f"did:key:z{encoded}"


def produce_did_document(identity: DinaIdentity) -> DIDDocument:
    """Produce a minimal W3C DID Document for the given identity."""
    did = derive_did_key(identity)
    vm_id = f"{did}#{did.split(':')[-1]}"

    raw_pub = identity.public_key_bytes()
    multicodec_key = _ED25519_MULTICODEC_PREFIX + raw_pub
    pub_multibase = "z" + base58.b58encode(multicodec_key).decode("ascii")

    vm = VerificationMethod(
        id=vm_id,
        type="Ed25519VerificationKey2020",
        controller=did,
        publicKeyMultibase=pub_multibase,
    )

    return DIDDocument(
        id=did,
        verificationMethod=[vm],
        authentication=[vm_id],
        assertionMethod=[vm_id],
    )
