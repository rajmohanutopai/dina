"""Tests for Admin UI.

Maps to Brain TEST_PLAN SS8.

SS8.1 Dashboard (4 scenarios)
SS8.2 Contact Management (4 scenarios)
SS8.3 Device Management (3 scenarios)
SS8.4 Persona Management (4 scenarios)
SS8.5 Admin UI Security (4 scenarios)
"""

from __future__ import annotations

import pytest

from .factories import (
    make_contact,
    make_device,
    make_persona,
    make_system_status,
    make_activity_entry,
)


# ---------------------------------------------------------------------------
# SS8.1 Dashboard (4 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-270
@pytest.mark.asyncio
async def test_admin_8_1_1_dashboard_loads(mock_admin_client) -> None:
    """SS8.1.1: Dashboard loads — GET /admin/ returns 200 with system status."""
    status = await mock_admin_client.get_system_status()
    assert status["core"] == "healthy"
    assert status["llm"] == "available"

    pytest.skip("Admin UI dashboard not yet implemented")
    # Full test: GET /admin/ -> 200, HTML contains system status section


# TST-BRAIN-271
@pytest.mark.asyncio
async def test_admin_8_1_2_system_status(mock_admin_client) -> None:
    """SS8.1.2: System status display — all services healthy shows green."""
    status = make_system_status(core="healthy", llm="available")
    assert status["core"] == "healthy"
    assert status["llm"] == "available"
    assert status["memory"] == "ok"

    pytest.skip("Admin UI system status display not yet implemented")
    # Full test: All service indicators green when healthy


# TST-BRAIN-272
@pytest.mark.asyncio
async def test_admin_8_1_3_degraded_status(mock_admin_client) -> None:
    """SS8.1.3: Degraded status — LLM unreachable shows yellow indicator."""
    status = make_system_status(core="healthy", llm="unreachable")
    assert status["core"] == "healthy"
    assert status["llm"] == "unreachable"

    pytest.skip("Admin UI degraded status display not yet implemented")
    # Full test: LLM indicator yellow, others green


# TST-BRAIN-273
@pytest.mark.asyncio
async def test_admin_8_1_4_recent_activity(mock_admin_client) -> None:
    """SS8.1.4: Recent activity — last 10 events in reverse chronological order."""
    activity = await mock_admin_client.get_recent_activity()
    assert len(activity) == 10

    pytest.skip("Admin UI recent activity not yet implemented")
    # Full test: Activity list displayed, reverse chronological order


# ---------------------------------------------------------------------------
# SS8.2 Contact Management (4 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-274
@pytest.mark.asyncio
async def test_admin_8_2_1_list_contacts(mock_admin_client) -> None:
    """SS8.2.1: List contacts — table with DIDs and trust levels."""
    contacts = await mock_admin_client.list_contacts()
    assert len(contacts) >= 1
    assert "did" in contacts[0]
    assert "trust_level" in contacts[0]

    pytest.skip("Admin UI contact listing not yet implemented")
    # Full test: GET /admin/contacts -> table with DID, name, trust level columns


# TST-BRAIN-275
@pytest.mark.asyncio
async def test_admin_8_2_2_add_contact(mock_admin_client) -> None:
    """SS8.2.2: Add contact — form submission creates contact via core API."""
    new_contact = make_contact(did="did:key:z6MkNewFriend", name="Bob")
    assert new_contact["did"] == "did:key:z6MkNewFriend"
    assert new_contact["name"] == "Bob"

    pytest.skip("Admin UI add contact not yet implemented")
    # Full test: POST form -> contact added via core API, redirect to list


# TST-BRAIN-276
@pytest.mark.asyncio
async def test_admin_8_2_3_edit_sharing_policy(mock_admin_client) -> None:
    """SS8.2.3: Edit sharing policy — change contact's sharing tier."""
    contact = make_contact(sharing_tier="open")
    assert contact["sharing_tier"] == "open"

    updated = await mock_admin_client.update_contact()
    assert updated["sharing_tier"] == "locked"

    pytest.skip("Admin UI edit sharing policy not yet implemented")
    # Full test: Change tier -> reflected in egress gatekeeper


# TST-BRAIN-277
@pytest.mark.asyncio
async def test_admin_8_2_4_remove_contact(mock_admin_client) -> None:
    """SS8.2.4: Remove contact — delete action removes via core API."""
    result = await mock_admin_client.remove_contact()
    assert result is None

    pytest.skip("Admin UI remove contact not yet implemented")
    # Full test: Delete action -> contact removed via core API


# ---------------------------------------------------------------------------
# SS8.3 Device Management (3 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-278
@pytest.mark.asyncio
async def test_admin_8_3_1_list_devices(mock_admin_client) -> None:
    """SS8.3.1: List devices — table with paired devices and last-seen."""
    devices = await mock_admin_client.list_devices()
    assert len(devices) >= 1
    assert "device_id" in devices[0]
    assert "last_seen" in devices[0]

    pytest.skip("Admin UI device listing not yet implemented")
    # Full test: GET /admin/devices -> table with device name, last-seen columns


# TST-BRAIN-279
@pytest.mark.asyncio
async def test_admin_8_3_2_initiate_pairing(mock_admin_client) -> None:
    """SS8.3.2: Initiate pairing — pairing code displayed."""
    result = await mock_admin_client.initiate_pairing()
    assert "pairing_code" in result
    assert len(result["pairing_code"]) > 0

    pytest.skip("Admin UI device pairing not yet implemented")
    # Full test: Click "Pair New Device" -> pairing code displayed


# TST-BRAIN-280
@pytest.mark.asyncio
async def test_admin_8_3_3_revoke_device(mock_admin_client) -> None:
    """SS8.3.3: Revoke device — device removed, CLIENT_TOKEN invalidated."""
    device = make_device(device_id="dev-revoke")
    assert device["device_id"] == "dev-revoke"

    result = await mock_admin_client.revoke_device()
    assert result is None

    pytest.skip("Admin UI device revocation not yet implemented")
    # Full test: Click "Revoke" -> device removed, CLIENT_TOKEN invalidated


# ---------------------------------------------------------------------------
# SS8.4 Persona Management (4 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-281
@pytest.mark.asyncio
async def test_admin_8_4_1_list_personas(mock_admin_client) -> None:
    """SS8.4.1: List personas — table with tier and item count."""
    personas = await mock_admin_client.list_personas()
    assert len(personas) >= 1
    assert "tier" in personas[0]
    assert "item_count" in personas[0]

    pytest.skip("Admin UI persona listing not yet implemented")
    # Full test: GET /admin/personas -> table with persona name, tier, item count


# TST-BRAIN-282
@pytest.mark.asyncio
async def test_admin_8_4_2_create_persona(mock_admin_client) -> None:
    """SS8.4.2: Create persona — form with name and tier."""
    persona = make_persona(persona_id="work", tier="locked")
    assert persona["persona_id"] == "work"
    assert persona["tier"] == "locked"

    pytest.skip("Admin UI create persona not yet implemented")
    # Full test: POST form with name + tier -> persona created via core API


# TST-BRAIN-283
@pytest.mark.asyncio
async def test_admin_8_4_3_change_persona_tier(mock_admin_client) -> None:
    """SS8.4.3: Change persona tier — Open to Locked, DEK behavior changes."""
    persona = make_persona(tier="open")
    assert persona["tier"] == "open"

    updated = await mock_admin_client.update_persona_tier()
    assert updated["tier"] == "locked"

    pytest.skip("Admin UI change persona tier not yet implemented")
    # Full test: Modify tier Open -> Locked, DEK behavior changes


# TST-BRAIN-284
@pytest.mark.asyncio
async def test_admin_8_4_4_delete_persona(mock_admin_client) -> None:
    """SS8.4.4: Delete persona — vault wiped, keys removed."""
    result = await mock_admin_client.delete_persona()
    assert result is None

    pytest.skip("Admin UI delete persona not yet implemented")
    # Full test: Delete with confirmation -> vault wiped, keys removed


# ---------------------------------------------------------------------------
# SS8.5 Admin UI Security (4 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-285
@pytest.mark.asyncio
async def test_admin_8_5_1_xss_contact_name(mock_admin_client) -> None:
    """SS8.5.1: XSS in contact name — HTML-escaped in template output."""
    malicious_contact = make_contact(name="<script>alert(1)</script>")
    assert "<script>" in malicious_contact["name"]

    pytest.skip("Admin UI XSS protection not yet implemented")
    # Full test: Contact name with <script> tag is HTML-escaped in rendered output


# TST-BRAIN-286
@pytest.mark.asyncio
async def test_admin_8_5_2_csrf_protection(mock_admin_client) -> None:
    """SS8.5.2: CSRF on forms — submit without CSRF token returns 403."""
    pytest.skip("Admin UI CSRF protection not yet implemented")
    # Full test: POST form without CSRF token -> 403 Forbidden


# TST-BRAIN-287
@pytest.mark.asyncio
async def test_admin_8_5_3_sql_injection_search(mock_admin_client) -> None:
    """SS8.5.3: SQL injection via search — safely parameterized."""
    malicious_query = "'; DROP TABLE contacts--"
    assert "DROP TABLE" in malicious_query

    pytest.skip("Admin UI SQL injection protection not yet implemented")
    # Full test: Search field with SQL injection payload -> safely parameterized, no injection


# TST-BRAIN-288
@pytest.mark.asyncio
async def test_admin_8_5_4_template_injection(mock_admin_client) -> None:
    """SS8.5.4: Template injection — user input auto-escaped by Jinja2."""
    malicious_input = "{{ 7*7 }}"
    assert "{{" in malicious_input

    pytest.skip("Admin UI template injection protection not yet implemented")
    # Full test: User input in Jinja2 template is auto-escaped, {{ 7*7 }} rendered as text
