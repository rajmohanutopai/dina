"""Setup-code parser — the Python half of the cross-language contract.

PINNED_VECTOR is byte-identical in
apps/mobile/__tests__/services/agent_setup_code.test.ts; if the payload
shape or encoding changes, BOTH pins must move together (and the `dina1:`
prefix bumps on incompatible change).
"""

import base64
import json

import pytest

from dina_cli.setup_code import (
    SetupCodeError,
    looks_like_setup_code,
    parse_setup_code,
)

PINNED_VECTOR = (
    "dina1:eyJ2IjoxLCJtc2dib3hfdXJsIjoid3NzOi8vdGVzdC1tYWlsYm94LmRpbmFrZXJuZWwuY29tL3dzIiwi"
    "aG9tZW5vZGVfZGlkIjoiZGlkOnBsYzpzNm1icDdycWc2ZGluYXRlc3R3aWU1dSIsInRyYW5zcG9ydCI6Im1zZ2Jv"
    "eCIsImRldmljZV9uYW1lIjoib3BlbmNsYXctYWdlbnQiLCJjb2RlIjoiQUJDRDJFRkcifQ"
)


def _encode(payload: dict) -> str:
    compact = json.dumps(payload, separators=(",", ":"))
    return "dina1:" + base64.urlsafe_b64encode(compact.encode()).decode().rstrip("=")


def test_parses_the_pinned_cross_language_vector():
    parsed = parse_setup_code(PINNED_VECTOR)
    assert parsed.msgbox_url == "wss://test-mailbox.dinakernel.com/ws"
    assert parsed.homenode_did == "did:plc:s6mbp7rqg6dinatestwie5u"
    assert parsed.transport == "msgbox"
    assert parsed.device_name == "openclaw-agent"
    assert parsed.code == "ABCD2EFG"


def test_tolerates_surrounding_whitespace():
    parsed = parse_setup_code(f"  {PINNED_VECTOR}\n")
    assert parsed.code == "ABCD2EFG"


def test_defaults_transport_and_device_name_when_absent():
    parsed = parse_setup_code(
        _encode(
            {
                "v": 1,
                "msgbox_url": "wss://relay.example/ws",
                "homenode_did": "did:plc:abc",
                "code": "ZZZZZZZZ",
            }
        )
    )
    assert parsed.transport == "msgbox"
    assert parsed.device_name == ""


def test_rejects_wrong_prefix():
    with pytest.raises(SetupCodeError, match="dina1:"):
        parse_setup_code("dina2:abcdef")


def test_rejects_future_version_with_upgrade_hint():
    with pytest.raises(SetupCodeError, match="update dina-agent"):
        parse_setup_code(
            _encode(
                {
                    "v": 2,
                    "msgbox_url": "wss://r/ws",
                    "homenode_did": "did:plc:abc",
                    "code": "X",
                }
            )
        )


def test_rejects_garbage_base64_and_non_json():
    with pytest.raises(SetupCodeError, match="base64url"):
        parse_setup_code("dina1:!!!not-base64!!!")
    raw = "dina1:" + base64.urlsafe_b64encode(b"not json").decode().rstrip("=")
    with pytest.raises(SetupCodeError, match="JSON"):
        parse_setup_code(raw)


@pytest.mark.parametrize(
    "mutation,match",
    [
        ({"msgbox_url": ""}, "msgbox_url"),
        ({"msgbox_url": "https://not-ws.example"}, "ws://"),
        ({"homenode_did": "plc:missing-scheme"}, "DID"),
        ({"code": ""}, "code"),
        ({"transport": "carrier-pigeon"}, "transport"),
    ],
)
def test_rejects_invalid_fields(mutation, match):
    payload = {
        "v": 1,
        "msgbox_url": "wss://relay.example/ws",
        "homenode_did": "did:plc:abc",
        "device_name": "a",
        "code": "ABCD2EFG",
    }
    payload.update(mutation)
    with pytest.raises(SetupCodeError, match=match):
        parse_setup_code(_encode(payload))


def test_looks_like_setup_code_sniff():
    assert looks_like_setup_code(f"  {PINNED_VECTOR}")
    assert not looks_like_setup_code("ABCD2EFG")
    assert not looks_like_setup_code("")
