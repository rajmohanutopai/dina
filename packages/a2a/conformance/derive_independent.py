"""The Lane 3 golden vectors' positive values, derived by code that is not Dina's.

`generate.ts` writes conformance/vectors/directory_envelope.json from Dina's
own functions. So that the file cannot just echo them, every value it writes
is first checked against the literal this script printed, derived here from
the rules alone (design §8.2):

  - RFC 8785 by the official a2a-sdk's canonicalizer (`a2a.utils._jcs`),
  - SHA-256 by Python's hashlib,
  - Ed25519 (RFC 8032, deterministic) by the `cryptography` package.

The inputs below restate generate.ts's inputs. Run it under the reference
agent's venv, which holds all three, and paste the output into `INDEPENDENT`
in generate.ts when an input changes:

  apps/home-node-lite/core-server/__tests__/a2a/reference/.venv/bin/python \\
    packages/a2a/conformance/derive_independent.py
"""

import base64
import hashlib
import json

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from a2a.utils._jcs import canonicalize

SECRET_KEY_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
INSTANCE = '3f2b8c1e-7a4d-4b9e-9c1f-2d6e8a0b5c47'
CARD_COLLECTION = 'com.dinakernel.a2a.card'
SELF_RKEY = 'self'
ENVELOPE_DOMAIN = 'dina:a2a:directory-envelope:v1'
FENCE_DOMAIN = 'dina:a2a:fence:v1'

CARD = {
    'name': 'Bus 42 Desk',
    'description': 'Next-bus times for route 42.',
    'supportedInterfaces': [
        {'url': 'https://a2a.example.org/rpc', 'protocolBinding': 'JSONRPC', 'protocolVersion': '1.0'}
    ],
    'version': '1',
    'capabilities': {'streaming': False, 'pushNotifications': False, 'extendedAgentCard': False},
    'defaultInputModes': ['application/json'],
    'defaultOutputModes': ['application/json'],
    'skills': [{'id': 'eta_query@self', 'name': 'ETA', 'description': 'Arrival time.', 'tags': ['transit']}],
}
# Escapes, not literal characters: U+2028 and its kin do not survive a copy by eye.
UNICODE_CARD = {
    'name': 'B\u00fas 42 \u2014 \U0001F68C',
    'description': 'L\u00ednea 42\u2028horarios',
    'supportedInterfaces': [
        {'url': 'https://a2a.example.org/rpc', 'protocolBinding': 'JSONRPC', 'protocolVersion': '1.0'}
    ],
    'version': '1',
    'capabilities': {},
    'defaultInputModes': ['application/json'],
    'defaultOutputModes': ['application/json'],
    'skills': [{'id': 'eta_query@self', 'name': 'ETA', 'description': 'Hora.', 'tags': ['\uff5e', '\U0001F600']}],
    '\uff5e': 'fullwidth tilde',
    '\U0001F600': 'grinning face',
}

key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(SECRET_KEY_HEX))


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def signed(unsigned: dict) -> dict:
    """Ed25519 over RFC 8785 of every member but `sig`; `sig` is padded base64."""
    return {**unsigned, 'sig': base64.b64encode(key.sign(canonicalize(unsigned).encode('utf-8'))).decode('ascii')}


card_text = canonicalize(CARD)
card_hash = sha256_hex(card_text)
envelope_unsigned = {
    'v': 1,
    'domain': ENVELOPE_DOMAIN,
    'did': DID,
    'collection': CARD_COLLECTION,
    'rkey': SELF_RKEY,
    'card_hash': card_hash,
    'freshness_epoch': 3,
    'publisher_epoch': 2,
    'publisher_instance': INSTANCE,
}
envelope = signed(envelope_unsigned)
fence_unsigned = {'v': 1, 'domain': FENCE_DOMAIN, 'did': DID, 'publisher_epoch': 2, 'publisher_instance': INSTANCE}
fence = signed(fence_unsigned)
record = {
    '$type': CARD_COLLECTION,
    'card': card_text,
    'directory_envelope': envelope,
    'endpoint': 'https://a2a.example.org/rpc',
    'protocol_version': '1.0',
    'skills': ['eta_query@self'],
}
unicode_text = canonicalize(UNICODE_CARD)

print(
    json.dumps(
        {
            'public_key_hex': key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex(),
            'card_text': card_text,
            'card_hash': card_hash,
            'envelope_signing_text': canonicalize(envelope_unsigned),
            'envelope_sig': envelope['sig'],
            'fence_signing_text': canonicalize(fence_unsigned),
            'fence_sig': fence['sig'],
            'record_digest': sha256_hex(canonicalize(record)),
            'envelope_only_change_digest': sha256_hex(
                canonicalize({**record, 'directory_envelope': signed({**envelope_unsigned, 'freshness_epoch': 4})})
            ),
            'sibling_change_digest': sha256_hex(canonicalize({**record, 'protocol_version': '1.1'})),
            'unicode_card_text': unicode_text,
            'unicode_card_text_utf8_hex': unicode_text.encode('utf-8').hex(),
            'unicode_card_hash': sha256_hex(unicode_text),
            'unicode_record_digest': sha256_hex(canonicalize({**record, 'card': unicode_text})),
            'signing_text_sha256': sha256_hex(canonicalize(envelope_unsigned)),
        },
        indent=2,
        ensure_ascii=False,
    )
)
