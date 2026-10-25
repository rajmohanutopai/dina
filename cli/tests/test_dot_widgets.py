"""HOSTED_DINA §6.4 — Dina's card in a ChatGPT dot: the page ChatGPT draws it
with, and the tools that carry it. Core builds the card itself
(packages/core/src/client/tender_card.ts); the CLI passes it through."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from dina_cli import dot_widgets, mcp_server


@pytest.fixture
def fake_client(monkeypatch):
    fake = MagicMock()
    monkeypatch.setattr(mcp_server, "_get_client", lambda: fake)
    return fake


def test_the_status_tool_names_the_card_and_passes_core_s_card_through(fake_client):
    card = {"version": 1, "blocks": [{"kind": "title", "text": "Ready to award"}]}
    fake_client.tender_draft_status.return_value = {"draft_id": "tdr_1", "draft_state": "opened", "card": card}
    out = mcp_server.dina_tender_status.fn(session="s1", draft_id="tdr_1")
    assert out["card"] == card
    assert mcp_server.dina_tender_status.meta["ui"]["resourceUri"] == dot_widgets.CARD_URI
    assert mcp_server.dina_tender_status.meta["openai/outputTemplate"] == dot_widgets.CARD_URI


def test_the_draft_tool_names_the_card_too():
    # The draft's answer carries a card (who Dina would ask); a tool that
    # returns a card must name the page, or ChatGPT reports the widget
    # unavailable (seen live in a dot, 2026-10-25).
    assert mcp_server.dina_tender_draft.meta["ui"]["resourceUri"] == dot_widgets.CARD_URI


def test_award_names_the_supplier_a_card_button_named(fake_client):
    fake_client.tender_award.return_value = {"awarded_to": "Fogline Bakehouse"}
    mcp_server.dina_tender_award.fn(session="s1", draft_id="tdr_1", supplier_did="did:plc:fog")
    fake_client.tender_award.assert_called_once_with(
        session="s1", draft_id="tdr_1", rank=1, supplier_did="did:plc:fog", alternative_id=""
    )


def test_the_page_draws_values_as_text_fetches_nothing_and_confirms_before_acting():
    html = dot_widgets.card_html()
    assert html.startswith("<!doctype html>")
    assert "innerHTML" not in html
    assert "fetch(" not in html and "XMLHttpRequest" not in html
    assert "ui/initialize" in html and "ui/notifications/tool-result" in html
    # A button calls only Dina's award tool, and only after a second tap.
    assert '"tender.award": "dina_tender_award"' in html
    assert '"Confirm " + label' in html
