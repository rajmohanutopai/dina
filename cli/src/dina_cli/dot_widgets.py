"""Dina's cards in a ChatGPT dot (HOSTED_DINA §6.4).

ChatGPT draws a tool's UI from an MCP Apps resource: the tool names a
``ui://`` page in ``_meta.ui.resourceUri`` and puts its data in the result's
structured content. Dina has one page, ``card-v1.html``, which draws a
CardSpec — the same fixed block vocabulary the phone app draws
(``packages/protocol/src/services/card-spec.ts``) — so a dot and the phone
show a tender the same way. The text answer stays beside it, for the model
and for Slack or Teams, where nothing is drawn.

The URI carries its version: hosts cache by URI, so a breaking change to
the page ships as ``card-v2.html``.
"""

from __future__ import annotations

from datetime import datetime
from importlib import resources
from typing import Any

CARD_URI = "ui://dina/card-v1.html"
MCP_APP_MIME = "text/html;profile=mcp-app"

#: Tool metadata naming the card: the MCP Apps field, and ChatGPT's alias.
CARD_TOOL_META: dict[str, Any] = {
    "ui": {"resourceUri": CARD_URI},
    "openai/outputTemplate": CARD_URI,
}

_SYMBOLS = {"USD": "$", "EUR": "€", "GBP": "£", "INR": "₹"}


def card_html() -> str:
    """The page, shipped inside the package."""
    return resources.files("dina_cli").joinpath("widgets/card-v1.html").read_text("utf-8")


def money(total: Any) -> str:
    """``{"currency": "USD", "minor_units": "70000"}`` → ``$700.00``."""
    if not isinstance(total, dict):
        return ""
    currency = str(total.get("currency") or "")
    units = str(total.get("minor_units") or "")
    if not units.isdigit():
        return ""
    whole, cents = divmod(int(units), 100)
    amount = f"{whole:,}.{cents:02d}"
    symbol = _SYMBOLS.get(currency)
    return f"{symbol}{amount}" if symbol else f"{currency} {amount}".strip()


def _when(iso: Any) -> str:
    if not isinstance(iso, str) or not iso:
        return ""
    try:
        moment = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return ""
    return moment.strftime("%d %b, %H:%M UTC").lstrip("0")


def _trust(trust: Any) -> str:
    if not isinstance(trust, dict):
        return ""
    reviews = trust.get("reviews") or 0
    score = trust.get("score")
    if not isinstance(score, (int, float)) or reviews == 0:
        return "No reviews yet"
    return f"Trust {score:.2f} · {reviews} review{'s' if reviews != 1 else ''}"


def tender_card(status: dict[str, Any]) -> dict[str, Any]:
    """A CardSpec for one tender's progress, from ``dina_tender_status``."""
    state = status.get("draft_state")
    tender = status.get("tender") if isinstance(status.get("tender"), dict) else {}
    blocks: list[dict[str, Any]] = []

    if state == "pending":
        blocks.append({"kind": "title", "text": "Tender draft · not sent yet"})
        blocks.append({"kind": "section", "label": "Who Dina would ask"})
        rows = []
        for supplier in status.get("suppliers") or []:
            if not isinstance(supplier, dict):
                continue
            source = "Found on the network" if supplier.get("source") == "network" else "Your supplier"
            asked = supplier.get("selected", True) is not False
            rows.append({
                "text": str(supplier.get("name") or "Unnamed supplier"),
                "sub": f"{source} · {_trust(supplier.get('trust'))}",
                "trailing": "Will ask" if asked else "Not ticked",
                "tone": "positive" if asked else "neutral",
            })
        if rows:
            blocks.append({"kind": "list", "rows": rows})
        blocks.append({"kind": "body", "text": "Give a target and the most you will pay, and Dina sends it."})
    elif state == "opened" and tender.get("state") == "awarded":
        answer = tender.get("supplier_answer")
        held = tender.get("held_order")
        winner = str(tender.get("awarded_to") or "the supplier")
        blocks.append({
            "kind": "title",
            "text": "Order accepted" if answer == "accepted" else "Order placed",
            "tone": "positive" if answer == "accepted" else "neutral",
        })
        blocks.append({"kind": "keyValue", "label": "Supplier", "value": winner})
        blocks.append({"kind": "timeline", "steps": [
            {"label": "Quotes compared", "state": "done"},
            {"label": f"Awarded to {winner}", "state": "done"},
            {"label": "Order sent", "state": "done" if held == "sent" else "active"},
            {
                "label": "Supplier accepted" if answer == "accepted" else f"Supplier's answer: {answer or 'waiting'}",
                "state": "done" if answer == "accepted" else "active" if held == "sent" else "upcoming",
            },
        ]})
    elif state == "opened":
        ranked = [r for r in tender.get("ranked") or [] if isinstance(r, dict)]
        if not ranked:
            blocks.append({"kind": "title", "text": "Tender sent · waiting for quotes"})
            names = [str(s.get("name") or "") for s in status.get("suppliers") or [] if isinstance(s, dict)]
            if names:
                blocks.append({"kind": "chips", "items": [{"text": n} for n in names if n]})
        else:
            best = ranked[0]
            blocks.append({"kind": "title", "text": "Quotes in"})
            blocks.append({
                "kind": "stat",
                "value": money(best.get("total")) or f"#{best.get('rank', 1)}",
                "caption": f"Best: {best.get('name') or 'unnamed supplier'}",
                "tone": "positive",
            })
            blocks.append({"kind": "section", "label": "Ranked"})
            rows = []
            for quote in ranked:
                bits = []
                if _when(quote.get("valid_until")):
                    bits.append(f"Holds until {_when(quote.get('valid_until'))}")
                if _when(quote.get("estimated_delivery_at")):
                    bits.append(f"Arrives {_when(quote.get('estimated_delivery_at'))}")
                rows.append({
                    "text": f"{quote.get('rank', '')}. {quote.get('name') or 'Unnamed supplier'}",
                    **({"sub": " · ".join(bits)} if bits else {}),
                    "trailing": money(quote.get("total")),
                    "tone": "positive" if quote is best else "neutral",
                })
            blocks.append({"kind": "list", "rows": rows})
            if tender.get("excluded"):
                blocks.append({"kind": "body", "text": f"{tender['excluded']} more left out by your rules."})
    elif state == "lapsed":
        blocks.append({"kind": "title", "text": "Draft lapsed", "tone": "caution"})
    elif state == "dismissed":
        blocks.append({"kind": "title", "text": "Draft dismissed", "tone": "caution"})
    else:
        blocks.append({"kind": "title", "text": "Tender"})

    return {"version": 1, "blocks": blocks, "sourceLabel": "Dina · quotes are signed by each supplier"}
