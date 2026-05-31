"""Stub price_check runner — canned `price_check` backend for the
"Corner Market" demo provider (the THIRD service capability, commerce).

Mirror of stub_eta_runner / stub_appointment_runner, but for the
`price_check` capability. Returns a result shaped for the deterministic
CardSpec mapper (Card-2) so the requester renders a rich commerce card:

    status:        "in_stock" | "low_stock" | "out_of_stock"
    product_name:  the item
    price:         numeric (headline stat)
    currency:      e.g. "USD"
    store_name:    the seller
    product_url:   an https product page (renders as a safe `link` — host shown)
    note:          provider free-text

The mapper turns that into: title(price icon) + toned Status keyValue +
price stat + keyValues + a safe link. No provider trust badges (Dina-owned).

Deterministic test stub — no MCP, no network, no LLM. Validates the
dina-agent claim -> execute -> reply chain for a 3rd capability.

Run (paired to the price provider node):
  source venv/bin/activate
  DINA_CONFIG_DIR=$PWD/price-agent/.dina/cli python run_daemon_price.py
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

from dina_cli.agent_runner import RunnerResult

# Demo pacing so the requester's handoff stepper plays before the answer.
_RESPONSE_DELAY_SECONDS = float(os.environ.get("STUB_PRICE_DELAY_SECONDS", "7"))

# Canned product (overridable via env so the demo can be re-pointed).
_PRICE_STATUS = os.environ.get("STUB_PRICE_STATUS", "in_stock")
_PRODUCT_NAME = os.environ.get("STUB_PRODUCT_NAME", "Organic Bananas (1 lb)")
_PRICE = float(os.environ.get("STUB_PRICE", "0.79"))
_CURRENCY = os.environ.get("STUB_CURRENCY", "USD")
_STORE_NAME = os.environ.get("STUB_STORE_NAME", "Corner Market")
_PRODUCT_URL = os.environ.get(
    "STUB_PRODUCT_URL", "https://store.example.com/p/organic-bananas"
)
_NOTE = os.environ.get("STUB_PRICE_NOTE", "Fresh stock daily. Loyalty members save 10%.")

_ACCEPTED = {"price_check", "price_lookup", "stock_price", "product_price", "availability_check"}


class StubPriceRunner:
    """AgentRunner returning a canned price_check reply for
    service_query_execution tasks."""

    runner_name = "stub_price"
    supports_reconciliation = False

    def __init__(self, config: object = None):
        self.config = config

    def validate_config(self) -> None:
        return None

    def health(self) -> dict[str, Any]:
        return {"status": "ok", "runner": self.runner_name}

    def execute(self, task: dict, prompt: str, session_name: str) -> RunnerResult:
        payload_raw = task.get("payload", "")
        try:
            payload = (
                json.loads(payload_raw)
                if isinstance(payload_raw, str)
                else (payload_raw or {})
            )
        except json.JSONDecodeError:
            payload = {}

        capability = payload.get("capability", "")
        params = payload.get("params", {}) if isinstance(payload.get("params"), dict) else {}

        print(
            f"[stub_price] claimed task {task.get('id','?')} "
            f"capability={capability} params={params}",
            flush=True,
        )

        if capability not in _ACCEPTED:
            return RunnerResult(
                state="failed",
                error=f"stub_price runner only handles price_check; got '{capability}'",
            )

        if _RESPONSE_DELAY_SECONDS > 0:
            print(
                f"[stub_price] holding response {_RESPONSE_DELAY_SECONDS}s (demo pacing)",
                flush=True,
            )
            time.sleep(_RESPONSE_DELAY_SECONDS)

        # Echo a requested product name if supplied; else the canned one.
        product = (
            params.get("product_name")
            if isinstance(params.get("product_name"), str) and params.get("product_name")
            else (params.get("query") if isinstance(params.get("query"), str) and params.get("query") else _PRODUCT_NAME)
        )

        result_payload = {
            "status": _PRICE_STATUS,
            "product_name": product,
            "price": _PRICE,
            "currency": _CURRENCY,
            "store_name": _STORE_NAME,
            "product_url": _PRODUCT_URL,
            "note": _NOTE,
            "message": "stub_price_runner (canned test data)",
        }

        return RunnerResult(
            state="completed",
            summary=json.dumps(result_payload),
            metadata={"capability": "price_check"},
        )

    def reconcile(self, task: dict) -> RunnerResult | None:
        return None

    def cancel(self, task: dict) -> None:
        return None
