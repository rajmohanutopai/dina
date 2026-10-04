"""Agent Card signatures as the official a2a-sdk (pinned in requirements.txt) makes and checks them.

Dina canonicalizes a card two ways (packages/a2a/src/card.ts): the form of
A2A spec §8.4.1, and the form this SDK signs. These modes let Dina's tests ask
the SDK itself, never a copy of its code:

  python card_forms.py payload   stdin: a JSON list of cards
                                 stdout: the payload the SDK's signer covers for each, as a JSON list
  python card_forms.py sign      stdin: {"card", "jwk" (a private JWK), "kid", "jku"}
                                 stdout: the card signed by the SDK, as the SDK's server serves it
  python card_forms.py verify    stdin: {"card", "jwks"}
                                 stdout: "verified", or the class name of the SDK's refusal
  python card_forms.py vectors DINA_CARD.json
                                 stdout: the frozen vectors packages/a2a's tests read
                                 (packages/a2a/__tests__/fixtures/a2a_sdk_card_forms.json);
                                 DINA_CARD.json is the card Dina projects, printed by
                                 packages/a2a/__tests__/fixtures/dina_card.ts (its header has the command)
"""

import copy
import json
import sys

from google.protobuf.json_format import ParseDict
from jwt.api_jwk import PyJWK

from a2a.client.card_resolver import parse_agent_card
from a2a.server.request_handlers.response_helpers import agent_card_to_dict
from a2a.types import AgentCard
from a2a.utils.signing import (
    SignatureVerificationError,
    _canonicalize_agent_card,
    create_agent_card_signer,
    create_signature_verifier,
)


def signer_payload(card: dict) -> str:
    """The bytes the SDK's signer covers: the card as its proto holds it."""
    return _canonicalize_agent_card(ParseDict(copy.deepcopy(card), AgentCard(), ignore_unknown_fields=True))


def sign(card: dict, jwk: dict, kid: str, jku: str) -> dict:
    proto = ParseDict(copy.deepcopy(card), AgentCard(), ignore_unknown_fields=True)
    signer = create_agent_card_signer(PyJWK(jwk), {'alg': 'ES256', 'typ': 'JOSE', 'kid': kid, 'jku': jku})
    return agent_card_to_dict(signer(proto))


def verify(card: dict, jwks: dict) -> str:
    keys = {k['kid']: k for k in jwks['keys']}

    def key_provider(kid, _jku):
        return PyJWK(keys[kid])

    try:
        create_signature_verifier(key_provider, ['ES256', 'EdDSA'])(parse_agent_card(copy.deepcopy(card)))
    except SignatureVerificationError as e:
        return type(e).__name__
    return 'verified'


# A fixed P-256 test key (RFC 7517 JWK). Test material only.
TEST_JWK = {
    'kty': 'EC',
    'crv': 'P-256',
    'kid': 'sdk-test-key',
    'x': 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
    'y': 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
    'd': 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
}
TEST_JKU = 'https://agent.example/jwks.json'


def interface(version: str) -> dict:
    return {'url': 'https://agent.example/a2a', 'protocolBinding': 'JSONRPC', 'protocolVersion': version}


def base_card(**extra) -> dict:
    card = {
        'name': 'Transit agent',
        'description': 'Answers when the next bus comes.',
        'supportedInterfaces': [interface('1.0')],
        'version': '1.2.0',
        'capabilities': {'streaming': True},
        'defaultInputModes': ['application/json'],
        'defaultOutputModes': ['application/json'],
        'skills': [{'id': 'eta_query', 'name': 'ETA', 'description': 'When the bus comes.', 'tags': ['transit']}],
    }
    card.update(extra)
    return card


BEARER = {
    'securitySchemes': {'bearer': {'httpAuthSecurityScheme': {'scheme': 'Bearer'}}},
    'securityRequirements': [{'schemes': {'bearer': {'list': []}}}],
}

# Cards whose two forms differ, and one whose forms coincide.
CARDS = {
    # Every bearer card: the SDK form drops the scope-less requirement whole.
    'bearer_requirement': base_card(**BEARER),
    # Empty values everywhere: REQUIRED fields at their default, an optional bool set false,
    # Struct members empty or null, an OAuth scope with an empty description.
    'empties': base_card(
        version='',
        documentationUrl='',
        capabilities={
            'streaming': False,
            'extensions': [{'uri': 'urn:x', 'required': False, 'params': {'a': '', 'b': [], 'c': {}, 'd': None, 'e': 0, 'f': False, 'g': {'h': ''}}}],
        },
        securitySchemes={
            'oauth': {
                'oauth2SecurityScheme': {
                    'flows': {'clientCredentials': {'tokenUrl': 'https://agent.example/token', 'scopes': {'read': '', 'write': 'Write'}}}
                }
            }
        },
        securityRequirements=[{'schemes': {'oauth': {'list': ['read']}}}],
        skills=[{'id': 's', 'name': 'S', 'description': '', 'tags': [], 'examples': []}],
    ),
    # Members the proto does not know, at the top and nested.
    'unknown_members': base_card(
        url='https://agent.example/a2a',
        preferredTransport='JSONRPC',
        protocolVersion='0.3.0',
        x_vendor={'k': 'v'},
        provider={'url': 'https://agent.example', 'organization': 'Agent Co', 'x_extra': 'kept by 8.4.1'},
    ),
    # Nothing empty, nothing unknown: one form.
    'plain': base_card(),
}


def vectors(dina_card_path: str) -> dict:
    # The card as Dina's projection builds it, not a copy written here: its shape is the one checked.
    with open(dina_card_path, encoding='utf-8') as f:
        cards = {'dina_projected': json.load(f), **CARDS}
    jwks = {'keys': [{k: v for k, v in TEST_JWK.items() if k != 'd'}]}
    signed = {
        # A v1.0 card the SDK signed, with the bearer requirement every bearer card has.
        'bearer_requirement': sign(CARDS['bearer_requirement'], TEST_JWK, TEST_JWK['kid'], TEST_JKU),
        # A dual-version card: its server adds v0.3 members the signature never covered.
        'dual_version': sign(
            base_card(**BEARER, supportedInterfaces=[interface('1.0'), interface('0.3')]),
            TEST_JWK,
            TEST_JWK['kid'],
            TEST_JKU,
        ),
    }
    for name, card in signed.items():
        assert verify(card, jwks) == 'verified', name
    return {
        'generator': 'apps/home-node-lite/core-server/__tests__/a2a/reference/card_forms.py vectors',
        'sdk': 'a2a-sdk 1.2.1',
        'cards': [{'name': n, 'card': c, 'sdk_payload': signer_payload(c)} for n, c in cards.items()],
        'signed': {'jwks': jwks, 'cards': signed},
    }


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    if mode == 'vectors':
        print(json.dumps(vectors(sys.argv[2]), indent=1, ensure_ascii=False))
        return
    data = json.load(sys.stdin)
    if mode == 'payload':
        print(json.dumps([signer_payload(c) for c in data], ensure_ascii=False))
    elif mode == 'sign':
        print(json.dumps(sign(data['card'], data['jwk'], data['kid'], data['jku']), ensure_ascii=False))
    elif mode == 'verify':
        print(verify(data['card'], data['jwks']))
    else:
        sys.exit(f'unknown mode {mode!r}')


if __name__ == '__main__':
    main()
