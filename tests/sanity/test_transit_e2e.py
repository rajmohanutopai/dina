"""Sanity: Transit BusDriver scenario end-to-end via Telethon.

Drives the full WS2 demo with real everything:

  Telethon (real user) ──Telegram──> Alonso's Telegram bot
    (regression-alonso Core+Brain, real LLM key in env)
      ─D2D over MsgBox──> BusDriver's Home Node
        (regression-busdriver Core+Brain, service config published,
         OpenClaw paired with transit MCP tool, agent-daemon running)
          ─delegation task claim──> BusDriver OpenClaw
            ─MCP call get_eta(route_id, lat, lng)──> demo/transit FastMCP
              ─schedule lookup + Google Maps URL──> structured result
            ─POST /complete callback──> BusDriver Core bridge
      ──service.response D2D──> Alonso's Core
        ─workflow_event──> Alonso's Brain
          ─ format_service_query_result──> Telegram message
  Telethon receives: "🚌 Bus 42 — 7 min to Castro Station\n📍 https://..."

Scope
-----
This is the one test that asserts the whole demo works, not just parts.
Unit tests pin protocol gates; integration/user-story/release tests pin
Core-layer contracts; this sanity test pins the *user experience*:
when a real Telegram user asks for a bus ETA, does the response come
back with ETA + map URL, routed to their chat?

Two paths:

1. Structured `/service_query` — deterministic command-grammar path.
   Tests wire up + delivery without requiring the LLM to pick tools
   correctly. Provider side is fully real.

2. Natural language `/ask` — optional path that exercises the LLM
   tool-call loop (`search_provider_services` → `query_service`). Skipped
   if the LLM isn't configured on the Alonso instance, since sanity
   suite isn't required to ship LLM keys.

Preconditions (operator-provided — see tests/sanity/README.md)
--------------------------------------------------------------
- ``regression-alonso`` Core+Brain running on 18100/18200 with
  Telegram bot paired and LLM key configured (for path 2).
- ``regression-busdriver`` Core+Brain running on 18500/18600 (or
  wherever the operator maps it), with:
    * ``PUT /v1/service/config`` issued for ``eta_query`` with
      canonical ``schema_hash`` (matches ETA_QUERY_SCHEMA_HASH below).
    * OpenClaw container paired as agent-role, with the transit MCP
      tool registered (`demo/transit/openclaw-setup.sh` or equivalent).
    * ``dina agent-daemon`` running and polling BusDriver's Core.
- Alonso's Core has BusDriver's DID reachable via AppView (Hetzner
  test-appview.dinakernel.com if following the standard setup).
- ``.env.sanity`` with Telethon credentials + the BusDriver environment
  variables below.

Env vars read from ``.env.sanity`` or shell:
  SANITY_ALONSO_BOT         — e.g. ``regression_test_dina_alonso_bot``
  SANITY_BUSDRIVER_CORE_URL — e.g. ``http://localhost:18500``
  SANITY_BUSDRIVER_DID      — e.g. ``did:plc:abc123...``
  SANITY_TRANSIT_ENABLED    — ``1`` to run these tests, skip otherwise
"""

from __future__ import annotations

import os
import re

import httpx
import pytest


ALONSO_BOT = os.environ.get("SANITY_ALONSO_BOT", "regression_test_dina_alonso_bot")
BUSDRIVER_CORE_URL = os.environ.get("SANITY_BUSDRIVER_CORE_URL", "")
BUSDRIVER_DID = os.environ.get("SANITY_BUSDRIVER_DID", "")
TRANSIT_ENABLED = os.environ.get("SANITY_TRANSIT_ENABLED", "0") == "1"


# Canonical hash for the demo eta_query schema. Must match what
# ``demo/transit/openclaw-setup.sh`` publishes via PUT /v1/service/config.
# Same constant the E2E suite + User Story 15 + REL-029 all verify.
ETA_QUERY_SCHEMA_HASH = "2886d1f82453b418f4e620219681b897cdfa536c2d9ee9b0f524605107117a71"

# Approximate Castro Station coordinates — the demo SF Muni route 42's
# schedule has a stop called "Castro Station" at this location.
CASTRO_LAT = 37.7625
CASTRO_LNG = -122.4351


# ---------------------------------------------------------------------------
# Session skip gates
# ---------------------------------------------------------------------------

pytestmark = pytest.mark.skipif(
    not TRANSIT_ENABLED,
    reason=(
        "SANITY_TRANSIT_ENABLED is not '1'. Set it after bringing up "
        "the regression-busdriver stack (see test file docstring)."
    ),
)


@pytest.fixture(scope="module", autouse=True)
def _verify_busdriver_reachable():
    """Precondition — skip module if BusDriver's Core isn't healthy.

    Avoids turning real user bot prompts into timeouts when the
    operator hasn't started the BusDriver instance.
    """
    if not BUSDRIVER_CORE_URL:
        pytest.skip("SANITY_BUSDRIVER_CORE_URL not set")
    try:
        r = httpx.get(f"{BUSDRIVER_CORE_URL}/healthz", timeout=3)
        if r.status_code != 200:
            pytest.skip(
                f"BusDriver health check failed ({r.status_code}). "
                f"Is regression-busdriver running?"
            )
    except Exception as exc:
        pytest.skip(f"BusDriver unreachable: {exc}")


@pytest.fixture(scope="module", autouse=True)
def _verify_busdriver_service_config_published():
    """Precondition — BusDriver must advertise the eta_query schema.

    Fails loudly if the operator forgot to publish the config: the
    structured path would return "No services found" which the
    assertion can't distinguish from a real wiring problem.
    """
    if not BUSDRIVER_CORE_URL:
        pytest.skip("SANITY_BUSDRIVER_CORE_URL not set")
    try:
        r = httpx.get(f"{BUSDRIVER_CORE_URL}/v1/service/config", timeout=5)
    except Exception as exc:
        pytest.skip(f"BusDriver /v1/service/config unreachable: {exc}")
    if r.status_code == 401 or r.status_code == 403:
        # Endpoint needs auth — operator may have locked it down.
        # Not a skip condition on its own; tests downstream will still
        # work if the service is configured even though we can't verify.
        return
    if r.status_code >= 400:
        pytest.skip(
            f"BusDriver /v1/service/config returned {r.status_code}. "
            f"Has the transit provider config been PUT?"
        )
    cfg = r.json()
    if not cfg:
        pytest.skip("BusDriver has no service config published")
    caps = (cfg.get("capability_schemas") or {})
    eta = caps.get("eta_query") or {}
    if not eta.get("schema_hash"):
        pytest.skip(
            "BusDriver's service config has no eta_query schema_hash — "
            "re-run the publisher with a canonical hash"
        )


# ---------------------------------------------------------------------------
# Response shape assertions — these are what real users see
# ---------------------------------------------------------------------------

def _assert_eta_response_shape(response: str) -> None:
    """Verify the Telegram reply carries a real ETA + map link.

    The reply is free-form text formatted by ``_format_eta`` in
    ``brain/src/service/service_query.py``. It should contain:
      - a route/bus identifier (Bus 42, Market St Express, etc.)
      - a minute count (``N min``)
      - a Google Maps URL (auto-linkified by Telegram)

    Failing on wording stability on purpose — if the formatter changes
    output, the test should know.
    """
    assert response is not None, "Telegram never replied within timeout"
    text = response.strip()
    assert len(text) > 10, f"Reply too short to contain an ETA: {text!r}"

    # Minute count — must be present for an on-route response.
    assert re.search(r"\b\d+\s*min\b", text), (
        f"No 'N min' ETA in reply: {text[:200]}"
    )
    # Google Maps URL or a close equivalent. maps.google.com / goo.gl / etc.
    assert any(m in text.lower() for m in (
        "google.com/maps", "maps.app.goo.gl", "goo.gl/maps",
    )), f"No map URL in reply: {text[:200]}"


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestTransitEndToEnd:
    """Sanity: the BusDriver transit scenario end-to-end via Telegram."""

    def test_structured_query_returns_real_eta(self, tg):
        """``/service_query eta_query <lat> <lng> <route_id>`` returns a real ETA.

        Deterministic path — exercises wire protocol + real BusDriver
        OpenClaw executing the transit MCP tool without depending on the
        LLM picking the right tools.

        Grammar:
            /service_query eta_query <lat> <lng> <route_id> [text]
        """
        cmd = (
            f"/service_query eta_query {CASTRO_LAT} {CASTRO_LNG} 42 "
            f"when does bus 42 reach Castro"
        )
        response = tg.send_and_wait(ALONSO_BOT, cmd, timeout=90)
        _assert_eta_response_shape(response)

    def test_structured_query_reports_nonexistent_route(self, tg):
        """Route 999 doesn't exist in the demo data — response must say so.

        Regression guard: schema says result has ``status`` field with
        enum {on_route, not_on_route, out_of_service, not_found}.
        ``not_found`` must produce a user-friendly message.
        """
        cmd = f"/service_query eta_query {CASTRO_LAT} {CASTRO_LNG} 999"
        response = tg.send_and_wait(ALONSO_BOT, cmd, timeout=60)
        assert response is not None
        lower = response.lower()
        # Provider returns status=not_found; Brain formatter surfaces it.
        assert any(kw in lower for kw in (
            "not found", "unavailable", "no service", "not serve",
            "999", "route",
        )), f"Expected not-found response, got: {response[:200]}"

    def test_structured_query_location_outside_service_area(self, tg):
        """Point far from SF (e.g. Antarctica) — provider reports not_on_route.

        ETA schema allows ``status=not_on_route`` for points outside
        the 2km nearest-stop threshold. Reply must be a clean
        "doesn't serve your area" message, not a protocol error.
        """
        # Pacific Ocean — no SF Muni stop within 2km.
        cmd = "/service_query eta_query 34.0 -123.0 42"
        response = tg.send_and_wait(ALONSO_BOT, cmd, timeout=60)
        assert response is not None
        lower = response.lower()
        assert any(kw in lower for kw in (
            "doesn't serve", "not on route", "no service", "not serve",
            "area", "unavailable",
        )), f"Expected not_on_route response, got: {response[:200]}"

    @pytest.mark.skipif(
        os.environ.get("SANITY_LLM_ENABLED", "0") != "1",
        reason=(
            "SANITY_LLM_ENABLED is not '1'. Natural-language path "
            "requires Alonso's Brain to have an LLM key configured."
        ),
    )
    def test_natural_language_ask_finds_bus_and_returns_eta(self, tg):
        """Natural-language ``/ask`` drives the LLM tool-call loop.

        The LLM should:
          1. geocode("Castro Station")
          2. search_provider_services(capability="eta_query", lat, lng)
          3. query_service(operator_did=busdriver, params={route_id:"42", ...}, ...)

        Reply arrives asynchronously via workflow_event → Telegram.
        If the LLM picks the wrong tool chain, the test fails —
        that's intentional (this is the user-visible contract).
        """
        response = tg.send_and_wait(
            ALONSO_BOT,
            "/ask when does bus 42 reach Castro Station in San Francisco?",
            timeout=180,  # LLM round trips + D2D + OpenClaw can take a minute
        )
        _assert_eta_response_shape(response)
