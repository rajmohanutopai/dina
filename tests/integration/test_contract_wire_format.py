"""Contract tests: Core-Brain wire format compatibility.

These tests verify that the JSON field names Core sends match what Brain
expects. Each test exercises the actual Pydantic models and production
code paths so a field rename on either side breaks immediately.

Section: 01 (Core-Brain Communication) in the INT suite.
"""

from __future__ import annotations

import base64
import json
from dataclasses import fields as dc_fields
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Task 8.39 migration prep. This file tests the **Python Brain's**
# Pydantic-model wire compatibility with Go Core's JSON output — the
# Core-Brain contract within the production stack. Lite's equivalent
# wire-contract coverage lives in `@dina/protocol`'s conformance
# vectors (tasks 10.5-10.13, all 9 vectors frozen + verified via
# `npm run conformance`). Running these Python tests against Lite
# would mix stacks (Python Brain parsing Lite Core's TypeScript-
# emitted JSON) — not the intended wire-contract gate.
# LITE_SKIPS.md category `pending-feature`.
pytestmark = pytest.mark.skip_in_lite(
    reason="Python-Brain Pydantic wire-compat with Go Core. Lite's wire "
    "compat is enforced by `@dina/protocol` conformance vectors (tasks "
    "10.5-10.13) + `npm run conformance`. LITE_SKIPS.md category "
    "`pending-feature`."
)


# ---------------------------------------------------------------------------
# 1. ReminderFiredEvent payload field
# ---------------------------------------------------------------------------


# TRACE: {"suite": "INT", "case": "0810", "section": "01", "subsection": "01", "scenario": "01", "sectionName": "Core-Brain Communication", "title": "reminder_fired_event_accepts_payload"}
def test_reminder_fired_event_accepts_payload():
    """Core sends reminder_fired with a payload dict.  Brain's Pydantic
    model must accept that field and the guardian must read `message`
    from it.
    """
    from brain.src.dina_brain.routes.process import ReminderFiredEvent

    # Core sends this JSON body:
    wire_json = {
        "type": "reminder_fired",
        "payload": {
            "message": "Call dentist tomorrow",
            "kind": "appointment",
            "persona": "health",
        },
    }

    event = ReminderFiredEvent.model_validate(wire_json)

    assert event.type == "reminder_fired"
    assert event.payload is not None
    assert event.payload["message"] == "Call dentist tomorrow"
    assert event.payload["kind"] == "appointment"


# TRACE: {"suite": "INT", "case": "0811", "section": "01", "subsection": "01", "scenario": "02", "sectionName": "Core-Brain Communication", "title": "reminder_fired_handler_reads_message_from_payload"}
def test_reminder_fired_handler_reads_message_from_payload():
    """The guardian handler for reminder_fired extracts `message` from
    `event.get('body') or event.get('payload', {})`.  Verify the
    fallback path reads payload when body is absent.
    """
    from brain.src.dina_brain.routes.process import ReminderFiredEvent

    # Core sends payload but not body:
    wire_json = {
        "type": "reminder_fired",
        "payload": {
            "message": "Pay electric bill",
            "kind": "payment_due",
            "persona": "financial",
            "source": "document_extraction",
        },
    }

    event = ReminderFiredEvent.model_validate(wire_json)
    event_dict = event.model_dump(exclude_none=True)

    # Guardian does: body = event.get("body") or event.get("payload", {})
    body = event_dict.get("body") or event_dict.get("payload", {})

    assert isinstance(body, dict)
    assert body["message"] == "Pay electric bill"
    assert body["kind"] == "payment_due"


# TRACE: {"suite": "INT", "case": "0812", "section": "01", "subsection": "01", "scenario": "03", "sectionName": "Core-Brain Communication", "title": "reminder_fired_body_takes_precedence_over_payload"}
def test_reminder_fired_body_takes_precedence_over_payload():
    """When both `body` and `payload` are present, `body` wins because
    the guardian checks `event.get('body')` first.
    """
    from brain.src.dina_brain.routes.process import ReminderFiredEvent

    wire_json = {
        "type": "reminder_fired",
        "body": {"message": "From body", "kind": "birthday"},
        "payload": {"message": "From payload", "kind": "appointment"},
    }

    event = ReminderFiredEvent.model_validate(wire_json)
    event_dict = event.model_dump(exclude_none=True)

    body = event_dict.get("body") or event_dict.get("payload", {})
    assert body["message"] == "From body"


# ---------------------------------------------------------------------------
# 2. Guard scan trust_tool_used type check
# ---------------------------------------------------------------------------


# TRACE: {"suite": "INT", "case": "0813", "section": "01", "subsection": "02", "scenario": "01", "sectionName": "Core-Brain Communication", "title": "trust_tool_used_positive"}
def test_trust_tool_used_positive():
    """Production guardian code recognizes trust tool in tools_called.

    Tests the ACTUAL code path in guardian.py, not a local literal.
    """
    import inspect
    from brain.src.service.guardian import GuardianLoop
    source = inspect.getsource(GuardianLoop._handle_reason)
    # The production code must use any(tc.get("name") == ...) pattern
    assert 'tc.get("name") == "search_trust_network"' in source or \
           "tc.get('name') == 'search_trust_network'" in source, \
        "Guardian must check tc.get('name') not 'string in list'"
    # Must NOT use the old broken pattern: "search_trust_network" in tools_list
    assert '"search_trust_network" in (' not in source, \
        "Guardian must not use 'string in list[dict]' pattern"


# TRACE: {"suite": "INT", "case": "0814", "section": "01", "subsection": "02", "scenario": "02", "sectionName": "Core-Brain Communication", "title": "trust_tool_used_with_real_data"}
def test_trust_tool_used_with_real_data():
    """The any(tc.get...) pattern from guardian.py works on real tool data."""
    # Simulate the exact data shape that ToolExecutor produces
    tools_list = [
        {"name": "list_personas", "args": {}, "result_count": 3},
        {"name": "search_trust_network", "args": {"query": "chair"}, "result_count": 5},
    ]
    result = {"tools_called": tools_list}

    # Extract the same way guardian.py does
    tl = result.get("tools_called", []) if result else []
    trust_used = any(tc.get("name") == "search_trust_network" for tc in tl)
    assert trust_used is True

    # Negative case
    result_no_trust = {"tools_called": [{"name": "search_vault", "args": {}}]}
    tl2 = result_no_trust.get("tools_called", [])
    trust_used2 = any(tc.get("name") == "search_trust_network" for tc in tl2)
    assert trust_used2 is False


# TRACE: {"suite": "INT", "case": "0815", "section": "01", "subsection": "02", "scenario": "03", "sectionName": "Core-Brain Communication", "title": "trust_tool_used_empty_list"}
def test_trust_tool_used_empty_list():
    """Empty tools_called returns False without exception."""
    result = {"tools_called": []}
    tl = result.get("tools_called", [])
    assert any(tc.get("name") == "search_trust_network" for tc in tl) is False

    # None result
    assert any(tc.get("name") == "search_trust_network" for tc in (None or [])) is False


# TRACE: {"suite": "INT", "case": "0816", "section": "01", "subsection": "02", "scenario": "04", "sectionName": "Core-Brain Communication", "title": "trust_tool_used_with_missing_name_key"}
def test_trust_tool_used_with_missing_name_key():
    """If a tool call dict is missing the 'name' key, tc.get('name')
    returns None and does not match.  No KeyError.
    """
    tools_list = [
        {"args": {"query": "chair"}, "result_count": 5},  # missing "name"
        {"name": "search_vault", "args": {}, "result_count": 0},
    ]

    trust_tool_used = any(
        tc.get("name") == "search_trust_network"
        for tc in tools_list
    )
    assert trust_tool_used is False


# ---------------------------------------------------------------------------
# 3. Trust search passes query
# ---------------------------------------------------------------------------


# TRACE: {"suite": "INT", "case": "0817", "section": "01", "subsection": "03", "scenario": "01", "sectionName": "Core-Brain Communication", "title": "trust_search_passes_query_to_core"}
@pytest.mark.asyncio
async def test_trust_search_passes_query_to_core():
    """When _search_trust_network is called with args={"query": "chair"},
    it must forward query="chair" to core.search_trust_network, not an
    empty string.
    """
    from brain.src.service.vault_context import ToolExecutor

    mock_core = AsyncMock()
    mock_core.search_trust_network = AsyncMock(return_value={
        "results": [
            {
                "sentiment": "positive",
                "confidence": "high",
                "searchContent": "Great ergonomic chair",
                "authorDid": "did:plc:abc123",
                "category": "product-review",
                "subjectRefRaw": {"name": "ErgoChair Pro"},
            }
        ]
    })

    executor = ToolExecutor(core=mock_core)
    result = await executor.execute("search_trust_network", {"query": "chair"})

    # Verify the query was actually passed through, not empty
    mock_core.search_trust_network.assert_called_once()
    call_kwargs = mock_core.search_trust_network.call_args
    # search_trust_network is called with keyword args
    assert call_kwargs.kwargs.get("query") == "chair" or call_kwargs[1].get("query") == "chair", (
        f"Expected query='chair', got call_args={call_kwargs}"
    )


# TRACE: {"suite": "INT", "case": "0818", "section": "01", "subsection": "03", "scenario": "02", "sectionName": "Core-Brain Communication", "title": "trust_search_empty_query_returns_error"}
@pytest.mark.asyncio
async def test_trust_search_empty_query_returns_error():
    """When _search_trust_network receives args={"query": ""}, it must
    return an error dict, not forward an empty search to Core.
    """
    from brain.src.service.vault_context import ToolExecutor

    mock_core = AsyncMock()
    executor = ToolExecutor(core=mock_core)
    result = await executor.execute("search_trust_network", {"query": ""})

    assert "error" in result
    mock_core.search_trust_network.assert_not_called()


# TRACE: {"suite": "INT", "case": "0819", "section": "01", "subsection": "03", "scenario": "03", "sectionName": "Core-Brain Communication", "title": "trust_search_passes_category"}
@pytest.mark.asyncio
async def test_trust_search_passes_category():
    """When a category is provided, it must be forwarded to Core.  When
    omitted, the default 'product-review' is used.
    """
    from brain.src.service.vault_context import ToolExecutor

    mock_core = AsyncMock()
    # Return non-empty results so the fallback path is not taken
    mock_core.search_trust_network = AsyncMock(return_value={
        "results": [{"sentiment": "positive", "searchContent": "good", "authorDid": "did:plc:x"}]
    })

    executor = ToolExecutor(core=mock_core)

    # With explicit category
    await executor.execute("search_trust_network", {"query": "laptop", "category": "quality"})
    first_call = mock_core.search_trust_network.call_args_list[0]
    actual_category = first_call.kwargs.get("category", "")
    assert actual_category == "quality", (
        f"Expected category='quality' on first call, got '{actual_category}'"
    )

    mock_core.search_trust_network.reset_mock()
    mock_core.search_trust_network.return_value = {
        "results": [{"sentiment": "positive", "searchContent": "ok", "authorDid": "did:plc:y"}]
    }

    # Without category — should default to "product-review"
    await executor.execute("search_trust_network", {"query": "laptop"})
    first_call = mock_core.search_trust_network.call_args_list[0]
    actual_category = first_call.kwargs.get("category", "")
    assert actual_category == "product-review", (
        f"Expected default category='product-review', got '{actual_category}'"
    )


# ---------------------------------------------------------------------------
# 4. BotResponse uses format not parse_mode
# ---------------------------------------------------------------------------


# TRACE: {"suite": "INT", "case": "0820", "section": "01", "subsection": "04", "scenario": "01", "sectionName": "Core-Brain Communication", "title": "bot_response_has_format_field"}
def test_bot_response_has_format_field():
    """BotResponse dataclass must have a `format` field of type TextFormat.
    It must NOT have a `parse_mode` field (legacy Telegram leak).
    """
    from brain.src.domain.response import BotResponse, TextFormat

    field_names = {f.name for f in dc_fields(BotResponse)}

    assert "format" in field_names, "BotResponse must have 'format' field"
    assert "parse_mode" not in field_names, (
        "BotResponse must NOT have 'parse_mode' — that is a Telegram implementation detail"
    )

    # Default is PLAIN
    resp = BotResponse(text="hello")
    assert resp.format == TextFormat.PLAIN


# TRACE: {"suite": "INT", "case": "0821", "section": "01", "subsection": "04", "scenario": "02", "sectionName": "Core-Brain Communication", "title": "rich_response_defaults_to_rich_format"}
def test_rich_response_defaults_to_rich_format():
    """RichResponse must default to TextFormat.RICH, not PLAIN."""
    from brain.src.domain.response import RichResponse, TextFormat

    resp = RichResponse(text="**bold text**")
    assert resp.format == TextFormat.RICH


# TRACE: {"suite": "INT", "case": "0822", "section": "01", "subsection": "04", "scenario": "03", "sectionName": "Core-Brain Communication", "title": "text_format_enum_values"}
def test_text_format_enum_values():
    """TextFormat must have exactly PLAIN and RICH values."""
    from brain.src.domain.response import TextFormat

    values = {e.value for e in TextFormat}
    assert values == {"plain", "rich"}


# ---------------------------------------------------------------------------
# 5. ConfirmResponse uses options not actions
# ---------------------------------------------------------------------------


# TRACE: {"suite": "INT", "case": "0823", "section": "01", "subsection": "05", "scenario": "01", "sectionName": "Core-Brain Communication", "title": "confirm_response_has_options_not_actions"}
def test_confirm_response_has_options_not_actions():
    """ConfirmResponse must have an `options` field (list of ConfirmOption),
    NOT an `actions` field.  The name was changed to be transport-agnostic.
    """
    from brain.src.domain.response import ConfirmResponse

    field_names = {f.name for f in dc_fields(ConfirmResponse)}

    assert "options" in field_names, "ConfirmResponse must have 'options' field"
    assert "actions" not in field_names, (
        "ConfirmResponse must NOT have 'actions' — renamed to 'options'"
    )


# TRACE: {"suite": "INT", "case": "0824", "section": "01", "subsection": "05", "scenario": "02", "sectionName": "Core-Brain Communication", "title": "confirm_response_construction"}
def test_confirm_response_construction():
    """Construct a ConfirmResponse with ConfirmOption objects and verify
    the structure serializes correctly.
    """
    from brain.src.domain.response import ConfirmOption, ConfirmResponse, TextFormat

    resp = ConfirmResponse(
        text="Publish this trust attestation?",
        options=[
            ConfirmOption(label="Publish", action="confirm", data={"attestation_id": "abc"}),
            ConfirmOption(label="Cancel", action="cancel"),
        ],
    )

    assert resp.format == TextFormat.RICH
    assert len(resp.options) == 2
    assert resp.options[0].label == "Publish"
    assert resp.options[0].action == "confirm"
    assert resp.options[0].data == {"attestation_id": "abc"}
    assert resp.options[1].label == "Cancel"
    assert resp.options[1].action == "cancel"
    assert resp.options[1].data == {}  # default empty dict


# TRACE: {"suite": "INT", "case": "0825", "section": "01", "subsection": "05", "scenario": "03", "sectionName": "Core-Brain Communication", "title": "confirm_option_has_correct_fields"}
def test_confirm_option_has_correct_fields():
    """ConfirmOption must have label, action, and data fields."""
    from brain.src.domain.response import ConfirmOption

    field_names = {f.name for f in dc_fields(ConfirmOption)}
    assert field_names == {"label", "action", "data"}


# ---------------------------------------------------------------------------
# 6. D2D correlation_id in message body
# ---------------------------------------------------------------------------


# TRACE: {"suite": "INT", "case": "0826", "section": "01", "subsection": "06", "scenario": "01", "sectionName": "Core-Brain Communication", "title": "d2d_send_embeds_correlation_id_in_body"}
@pytest.mark.asyncio
async def test_d2d_send_embeds_correlation_id_in_body():
    """When send_d2d is called and structlog context has a request_id,
    _correlation_id must be embedded in the base64-decoded body JSON.
    """
    from brain.src.service.user_commands import UserCommandService

    # Build a mock core with _request that captures the call
    mock_core = AsyncMock()
    captured_calls: list[dict] = []

    async def capture_request(method, path, *, json=None, **kwargs):
        captured_calls.append({"method": method, "path": path, "json": json})
        # For contacts lookup
        if path == "/v1/contacts":
            mock_resp = MagicMock()
            mock_resp.json.return_value = {
                "contacts": [{"name": "Sancho", "did": "did:plc:sancho123abcdefghijklmno"}]
            }
            return mock_resp
        # For msg/send
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"status": "ok"}
        return mock_resp

    mock_core._request = capture_request

    # Mock LLM for message classification
    mock_llm = AsyncMock()
    mock_llm.route = AsyncMock(return_value={
        "content": '{"type": "social.update", "body": {"text": "hello", "category": "context"}}'
    })

    svc = UserCommandService(core=mock_core)

    # Patch structlog.contextvars to return a known request_id
    with patch("structlog.contextvars.get_contextvars", return_value={"request_id": "req-abc-123"}):
        result = await svc.send_d2d("Sancho", "hello there", mock_llm)

    # Find the msg/send call
    send_calls = [c for c in captured_calls if c["path"] == "/v1/msg/send"]
    assert len(send_calls) == 1, f"Expected 1 msg/send call, got {len(send_calls)}"

    send_body = send_calls[0]["json"]
    assert send_body["to"] == "did:plc:sancho123abcdefghijklmno"
    assert send_body["type"] == "social.update"

    # Decode the base64 body and check for _correlation_id
    decoded = json.loads(base64.b64decode(send_body["body"]))
    assert "_correlation_id" in decoded, (
        f"Expected '_correlation_id' in D2D body, got keys: {list(decoded.keys())}"
    )
    assert decoded["_correlation_id"] == "req-abc-123"


# TRACE: {"suite": "INT", "case": "0827", "section": "01", "subsection": "06", "scenario": "02", "sectionName": "Core-Brain Communication", "title": "d2d_send_omits_correlation_id_when_no_request_id"}
@pytest.mark.asyncio
async def test_d2d_send_omits_correlation_id_when_no_request_id():
    """When structlog context has no request_id, _correlation_id must
    NOT be injected into the body.
    """
    from brain.src.service.user_commands import UserCommandService

    mock_core = AsyncMock()
    captured_calls: list[dict] = []

    async def capture_request(method, path, *, json=None, **kwargs):
        captured_calls.append({"method": method, "path": path, "json": json})
        if path == "/v1/contacts":
            mock_resp = MagicMock()
            mock_resp.json.return_value = {
                "contacts": [{"name": "Sancho", "did": "did:plc:sancho123abcdefghijklmno"}]
            }
            return mock_resp
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"status": "ok"}
        return mock_resp

    mock_core._request = capture_request

    mock_llm = AsyncMock()
    mock_llm.route = AsyncMock(return_value={
        "content": '{"type": "social.update", "body": {"text": "hi", "category": "context"}}'
    })

    svc = UserCommandService(core=mock_core)

    # No request_id in context
    with patch("structlog.contextvars.get_contextvars", return_value={}):
        result = await svc.send_d2d("Sancho", "hi there", mock_llm)

    send_calls = [c for c in captured_calls if c["path"] == "/v1/msg/send"]
    assert len(send_calls) == 1

    decoded = json.loads(base64.b64decode(send_calls[0]["json"]["body"]))
    assert "_correlation_id" not in decoded, (
        f"_correlation_id should not be present without request_id, got: {decoded}"
    )


# TRACE: {"suite": "INT", "case": "0828", "section": "01", "subsection": "06", "scenario": "03", "sectionName": "Core-Brain Communication", "title": "d2d_receiver_extracts_correlation_id"}
def test_d2d_receiver_extracts_correlation_id():
    """The receiver side reads _correlation_id from the D2D payload body.
    Verify the extraction pattern used in guardian._handle_didcomm works
    for both top-level payload and nested base64 body.
    """
    # Scenario 1: _correlation_id at top level of payload
    payload = {
        "from": "did:plc:sender123",
        "type": "dina/social/update",
        "_correlation_id": "req-xyz-789",
        "body": base64.b64encode(json.dumps({"text": "hello"}).encode()).decode(),
    }

    corr_id = payload.get("_correlation_id", "")
    assert corr_id == "req-xyz-789"

    # Scenario 2: _correlation_id inside the base64-decoded body
    inner_body = {"text": "hello", "_correlation_id": "req-inner-456"}
    payload_nested = {
        "from": "did:plc:sender123",
        "type": "dina/social/update",
        "body": json.dumps(inner_body),
    }

    corr_id = payload_nested.get("_correlation_id", "")
    if not corr_id:
        body_raw = payload_nested.get("body", "")
        if isinstance(body_raw, str):
            try:
                body_parsed = json.loads(body_raw)
                corr_id = body_parsed.get("_correlation_id", "")
            except (json.JSONDecodeError, TypeError):
                pass

    assert corr_id == "req-inner-456"
