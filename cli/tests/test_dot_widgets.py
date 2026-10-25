"""HOSTED_DINA §6.4 — Dina's card in a ChatGPT dot: the CardSpec built from a
tender's status, and the page ChatGPT draws it with."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from dina_cli import dot_widgets, mcp_server
from dina_cli.dot_widgets import money, tender_card


@pytest.fixture
def fake_client(monkeypatch):
    fake = MagicMock()
    monkeypatch.setattr(mcp_server, "_get_client", lambda: fake)
    return fake

USD = lambda units: {"currency": "USD", "minor_units": units}  # noqa: E731


def kinds(card):
    return [b["kind"] for b in card["blocks"]]


def test_money_reads_minor_units():
    assert money(USD("70000")) == "$700.00"
    assert money({"currency": "INR", "minor_units": "4550"}) == "₹45.50"
    assert money({"currency": "CHF", "minor_units": "1234567"}) == "CHF 12,345.67"
    assert money({"currency": "USD", "minor_units": "-1"}) == ""
    assert money(None) == ""


def test_a_draft_lists_who_dina_would_ask():
    card = tender_card({
        "draft_state": "pending",
        "suppliers": [
            {"name": "Fogline Bakehouse", "source": "network", "selected": True,
             "trust": {"score": 0.24, "reviews": 2}},
            {"name": "Morning Crumb Bakery", "source": "network", "selected": False,
             "trust": {"score": None, "reviews": 0}},
        ],
    })
    assert card["version"] == 1
    rows = next(b for b in card["blocks"] if b["kind"] == "list")["rows"]
    assert rows[0] == {
        "text": "Fogline Bakehouse",
        "sub": "Found on the network · Trust 0.24 · 2 reviews",
        "trailing": "Will ask",
        "tone": "positive",
    }
    assert rows[1]["trailing"] == "Not ticked"
    assert rows[1]["sub"].endswith("No reviews yet")


def test_quotes_rank_best_first_with_the_best_total_up_top():
    card = tender_card({
        "draft_state": "opened",
        "tender": {
            "state": "ready",
            "ranked": [
                {"rank": 1, "name": "Fogline Bakehouse", "total": USD("70000"),
                 "valid_until": "2026-10-26T14:30:00.000Z"},
                {"rank": 2, "name": "Morning Crumb Bakery", "total": USD("75000"),
                 "valid_until": "2026-10-26T14:30:00.000Z"},
            ],
            "excluded": 0,
        },
    })
    stat = next(b for b in card["blocks"] if b["kind"] == "stat")
    assert stat["value"] == "$700.00"
    assert stat["caption"] == "Best: Fogline Bakehouse"
    rows = next(b for b in card["blocks"] if b["kind"] == "list")["rows"]
    assert [r["trailing"] for r in rows] == ["$700.00", "$750.00"]
    assert rows[0]["sub"] == "Holds until 26 Oct, 14:30 UTC"


def test_an_award_shows_the_order_on_a_timeline():
    card = tender_card({
        "draft_state": "opened",
        "tender": {"state": "awarded", "awarded_to": "Fogline Bakehouse",
                   "held_order": "sent", "supplier_answer": "accepted", "ranked": []},
    })
    assert card["blocks"][0] == {"kind": "title", "text": "Order accepted", "tone": "positive"}
    steps = next(b for b in card["blocks"] if b["kind"] == "timeline")["steps"]
    assert [s["state"] for s in steps] == ["done", "done", "done", "done"]


def test_the_status_tool_names_the_card_and_carries_it(fake_client):
    fake_client.tender_draft_status.return_value = {"draft_id": "tdr_1", "draft_state": "pending",
                                                    "suppliers": []}
    out = mcp_server.dina_tender_status.fn(session="s1", draft_id="tdr_1")
    assert out["draft_state"] == "pending"
    assert out["card"]["version"] == 1
    assert mcp_server.dina_tender_status.meta["ui"]["resourceUri"] == dot_widgets.CARD_URI
    assert mcp_server.dina_tender_status.meta["openai/outputTemplate"] == dot_widgets.CARD_URI


def test_an_error_gets_no_card(fake_client):
    fake_client.tender_draft_status.return_value = {"error": "no_such_draft"}
    assert mcp_server.dina_tender_status.fn(session="s1", draft_id="x") == {"error": "no_such_draft"}


def test_the_page_draws_values_as_text_and_fetches_nothing():
    html = dot_widgets.card_html()
    assert html.startswith("<!doctype html>")
    assert "innerHTML" not in html
    assert "fetch(" not in html and "XMLHttpRequest" not in html
    assert "ui/initialize" in html and "ui/notifications/tool-result" in html
