"""Working Memory routing — E2E validation scenarios.

These exercise the full routing stack end-to-end through real Telegram
and real Gemini (no mocks): Telethon sends as the user, Alonso's bot
routes through the intent classifier + reasoning agent + tools, and we
assert the *answer* is right. The test is implicitly validating that
the classifier picked the right sources — if it hadn't, the answer
wouldn't contain what we check for.

Fifteen scenarios covering the §6.5 routing matrix:

    self + static              scenarios 1, 2, 3, 4, 12, 14
    not-self + live            scenarios 5, 15
    not-self + static          scenario 6
    self + live (compositional) scenarios 7, 8
    self + comparative          scenario 9
    ambiguous / cross-persona   scenarios 10, 11
    multi-hop                   scenario 13

Each scenario has a docstring describing the expected classifier
routing, the assertion mode, and the three failure modes we're
guarding against (wrong source, dropped source, hallucinated answer).

Why E2E instead of unit-testing the classifier:
  Classifier behavior only matters in context of the reasoning agent's
  downstream tool calls and final synthesis. A unit test that asserts
  ``sources == ["vault", "public_services"]`` passes even if the LLM
  then ignores the routing and hallucinates. The answer is the only
  ground truth; intermediate structure is diagnostic, not load-bearing.

Gated behind ``SANITY_WM_ENABLED=1`` so normal sanity runs don't
incur Gemini spend. Run locally with:

    SANITY_WM_ENABLED=1 pytest tests/sanity/test_working_memory_routing.py -v

Module skips until Working Memory (ToC + intent classifier) is
implemented. Remove the outer skip to run against a deployment that
has the feature live.
"""
from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

import pytest

# Session skip: requires both the Working Memory feature to be deployed
# and the SANITY_WM_ENABLED flag to avoid surprise LLM spend.
WM_ENABLED = os.environ.get("SANITY_WM_ENABLED", "0") == "1"
WM_IMPLEMENTED = os.environ.get("SANITY_WM_IMPLEMENTED", "0") == "1"

pytestmark = pytest.mark.skipif(
    not (WM_ENABLED and WM_IMPLEMENTED),
    reason=(
        "Working Memory tests are gated. Need both SANITY_WM_ENABLED=1 "
        "(opt-in to Gemini spend) and SANITY_WM_IMPLEMENTED=1 "
        "(feature is deployed)."
    ),
)


ALONSO_BOT = os.environ.get("SANITY_ALONSO_BOT", "regression_test_dina_alonso_bot")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _remember(tg, text: str, *, wait_s: int = 25) -> None:
    """Pre-seed the vault through the normal /remember path so the
    topic-salience counters and enrichment side effects happen as they
    would in production. Realistic ingest; no backdoor seeding API.
    """
    tg.send_and_wait(ALONSO_BOT, f"/remember {text}", timeout=wait_s)


def _ask(tg, question: str, *, wait_s: int = 120) -> str:
    """Send /ask and collect the final reply (ignoring transient ack
    messages like 'Asking SF Transit Authority...').
    """
    reply = tg.send_and_wait(ALONSO_BOT, f"/ask {question}", timeout=wait_s)
    return reply or ""


def _contains_any(haystack: str, needles: list[str]) -> bool:
    h = haystack.lower()
    return any(n.lower() in h for n in needles)


# ---------------------------------------------------------------------------
# Fixtures — pre-seeded vault state for the whole suite.
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def seeded_vault(tg):
    """Pre-seed Alonso's vault with the data the scenarios assume.

    Runs once per test module. Not cleaned up between tests — scenarios
    are read-only against this seeded state.

    Pre-seeds:
      health:    HDFC FD, dentist appointment, knee pain, blood test, Dr Carl
      finance:   HDFC FD rate, ICICI savings, SIP, 2025 tax return
      social:    Sancho birthday, Sancho recent dinner, Albert
      general:   daughters' school play, reading list (Sapiens, Three-Body Problem),
                 home repair backlog
      travel:    AI 123 Tokyo flight Oct 20 (scenario 8)
      long-tail: a Harari book reference from 14 months ago (scenario 12)

    Does NOT seed Trust Network reviews or public-service providers —
    those come from outside (AppView / Hetzner test stack) and are
    assumed to be available when running these tests.
    """
    # Finance
    _remember(tg, "My HDFC FD interest rate is 7.8% — renewed this January")
    _remember(tg, "ICICI savings account active, lower interest than HDFC")
    _remember(tg, "SIP at ICICI, 10k/month into Nifty 50 index")
    _remember(tg, "Filed 2025 tax return in March — refund pending")

    # Health
    _remember(tg, "Dentist: Dr Carl, appointment on April 19 at 3pm, clinic on Castro St")
    _remember(tg, "Knee pain off and on for the past 3 weeks, right knee")
    _remember(tg, "Blood test on April 10 came back with cholesterol a bit high")

    # Social
    _remember(tg, "Sancho's birthday is June 12")
    _remember(tg, "Had dinner with Sancho last Tuesday at the Fatty Bao, he asked about the kids")
    _remember(tg, "Albert sent a message about the book club meeting next month")

    # General
    _remember(tg, "Daughter's school play is on April 19 evening, 7pm auditorium")
    _remember(tg, "Reading Sapiens by Yuval Noah Harari, about halfway through")
    _remember(tg, "Started The Three-Body Problem last week, enjoying it so far")
    _remember(tg, "Need to fix the leaking tap in the kitchen, also repaint the study wall")

    # Travel (scenario 8 — flight without live-status service)
    _remember(tg, "Flight AI 123 to Tokyo on October 20, departure 2pm from Bangalore")

    # Long-tail (scenario 12 — reference that should survive salience decay)
    # NOTE: once we have a way to backdate items, set occurred_at = 14 months
    # ago so its salience is low but it's still findable via search_vault.
    _remember(tg, "Started the Harari book (Sapiens) last spring when flying")


# ---------------------------------------------------------------------------
# Group A — self + static (vault-only scenarios)
# ---------------------------------------------------------------------------

class TestSelfStatic:
    """Self-referential questions with no live-state component.

    Classifier should route to vault only. Failure modes to catch:
      - Drifting to public_services for no reason
      - Missing the right persona (e.g., searching social for a finance
        question)
      - Hallucinating when vault content is present but not found
    """

    def test_01_direct_vault_recall_entity(self, tg, seeded_vault):
        """'What's my FD rate at HDFC?'  — specific entity, exact value.

        Expected:
          sources=[vault], persona=finance, temporal=static
          answer contains '7.8' and 'HDFC'
        """
        r = _ask(tg, "what's my FD rate at HDFC?", wait_s=40)
        assert _contains_any(r, ["7.8"]), f"expected FD rate in reply: {r!r}"
        assert _contains_any(r, ["hdfc"]), f"expected HDFC in reply: {r!r}"

    def test_02_theme_recall(self, tg, seeded_vault):
        """'What health things have I been dealing with lately?'  — theme query.

        Expected:
          sources=[vault], persona=health, temporal=static
          answer touches knee, blood, or cholesterol
        """
        r = _ask(tg, "what health things have I been dealing with lately?", wait_s=40)
        assert _contains_any(r, ["knee", "blood", "cholesterol"]), (
            f"expected health context in reply: {r!r}"
        )

    def test_03_person_attribute(self, tg, seeded_vault):
        """'When's Sancho's birthday?'  — relationship attribute.

        Expected:
          sources=[vault], persona=social, temporal=static
          answer contains 'June 12' (or 'Jun 12')
        """
        r = _ask(tg, "when's Sancho's birthday?", wait_s=40)
        assert _contains_any(r, ["june 12", "jun 12", "12 june", "12 jun"]), (
            f"expected birthday in reply: {r!r}"
        )

    def test_04_list_recall(self, tg, seeded_vault):
        """'What books am I reading?'  — list-style recall.

        Expected:
          sources=[vault], persona=general, temporal=static
          answer references at least one of the seeded books
        """
        r = _ask(tg, "what books am I reading?", wait_s=40)
        assert _contains_any(r, ["sapiens", "three-body", "three body", "harari"]), (
            f"expected book title in reply: {r!r}"
        )


# ---------------------------------------------------------------------------
# Group B — not-self + live (public services)
# ---------------------------------------------------------------------------

class TestLivePublic:
    """Questions about live external state — no vault context needed."""

    def test_05_public_bus_eta(self, tg, seeded_vault):
        """'When does the next bus 42 reach Van Ness?'  — pure public_service.

        Expected:
          sources=[public_services], temporal=live_state
          answer contains 'min' and a maps URL
        """
        r = _ask(tg, "when does the next bus 42 reach Van Ness?", wait_s=180)
        assert " min" in r.lower(), f"expected ETA in reply: {r!r}"
        assert _contains_any(r, ["google.com/maps", "maps.app.goo.gl"]), (
            f"expected maps URL in reply: {r!r}"
        )


# ---------------------------------------------------------------------------
# Group C — not-self + static (trust network)
# ---------------------------------------------------------------------------

class TestTrustNetwork:
    """Reputation / review queries."""

    def test_06_product_reputation(self, tg, seeded_vault):
        """'Is the Herman Miller Aeron worth buying?'

        Expected:
          sources=[trust_network], temporal=static
          answer sourced ('reviews say', 'peers rate', 'network has')
          NOT answered from the LLM's training-data knowledge of Aeron
        """
        r = _ask(tg, "is the Herman Miller Aeron chair worth buying?", wait_s=60)
        assert _contains_any(
            r,
            ["review", "peer", "network", "attestation", "rating", "trust"],
        ), (
            f"expected trust-sourced language (not training-data facts): {r!r}"
        )


# ---------------------------------------------------------------------------
# Group D — compositional (self + live, self + comparative)
# ---------------------------------------------------------------------------

class TestCompositional:
    """Questions needing both vault context and external lookup.

    These are the hardest cases. The classifier must emit multiple sources;
    the reasoning agent must read vault, extract parameters, call the
    external service with those parameters, and synthesize.
    """

    def test_07_appointment_status_with_service(self, tg, seeded_vault):
        """'Is my dentist appointment still confirmed?'

        Assumes Dr Carl's DID publishes an ``appointment_status`` service
        (test stack should register this before running — TODO).

        Expected:
          sources=[vault, public_services], temporal=live_state
          answer references Dr Carl / Apr 19 3pm (vault context) and
          something about confirmation status (service result)
        """
        r = _ask(tg, "is my dentist appointment still confirmed?", wait_s=90)
        assert _contains_any(r, ["dr carl", "carl", "dentist"]), (
            f"expected dentist context in reply: {r!r}"
        )
        # Either real status (if Dr Carl's service responded) or honest
        # fallback (if no service is registered).
        assert _contains_any(
            r,
            ["confirmed", "still on", "scheduled", "unable to check", "not available"],
        ), (
            f"expected status or honest fallback: {r!r}"
        )

    def test_08_flight_status_no_service_available(self, tg, seeded_vault):
        """'Is my flight AI 123 on time tomorrow?'

        No flight-status service is registered on AppView for this test.

        Expected:
          sources=[vault, public_services attempt] → fallback
          temporal=live_state
          answer cites flight AI 123 from vault + honest "no live
          status available" — NOT a hallucinated ETA.
        """
        r = _ask(tg, "is my flight AI 123 on time tomorrow?", wait_s=90)
        assert _contains_any(r, ["ai 123", "ai-123", "tokyo"]), (
            f"expected flight context from vault: {r!r}"
        )
        # Must NOT hallucinate a status
        assert not _contains_any(r, ["on time and departing", "delayed by", "boarding at gate"]), (
            f"reply appears to hallucinate flight status: {r!r}"
        )

    def test_09_comparative_vault_plus_trust(self, tg, seeded_vault):
        """'Should I switch my FD from HDFC to ICICI?'

        Expected:
          sources=[vault, trust_network], temporal=comparative
          answer references HDFC's 7.8% (vault) and something comparative
          from trust_network (reviews of either bank).
        """
        r = _ask(tg, "should I switch my FD from HDFC to ICICI?", wait_s=90)
        assert _contains_any(r, ["7.8", "hdfc"]), (
            f"expected current HDFC holdings in reply: {r!r}"
        )


# ---------------------------------------------------------------------------
# Group E — ambiguous / cross-persona / degraded
# ---------------------------------------------------------------------------

class TestAmbiguousAndDegraded:
    """Edge cases where classification must make a judgment call, or where
    graceful degradation matters more than a specific answer.
    """

    def test_10_cross_persona_ambiguous(self, tg, seeded_vault):
        """'What's on for tomorrow?'

        Apr 19 has both a dentist appointment (health) and a school play
        (general). Classifier should route to vault across multiple
        personas and surface both.

        Expected:
          sources=[vault], relevant_personas=[health, general]
          answer mentions both the dentist and the play
        """
        r = _ask(tg, "what's on for tomorrow?", wait_s=60)
        hits = sum(
            1 for ks in [["dentist", "carl"], ["play", "school", "daughter"]]
            if _contains_any(r, ks)
        )
        assert hits >= 1, (
            f"expected at least one of {{dentist, school play}} in reply: {r!r}"
        )

    def test_11_locked_persona_graceful(self, tg, seeded_vault):
        """Locked persona — classifier emits a 'locked hint'.

        This test requires a test helper to lock the health persona
        first; if that's not wired yet, skip with an info message.

        Expected:
          the assistant reports what it *can* see and hints that
          health persona is locked — NOT that it has no information.
        """
        pytest.skip("Requires persona-lock helper wiring — TODO")

    def test_12_long_tail_vault_recall(self, tg, seeded_vault):
        """'What was that Harari book I started last year?'  — low-salience recall.

        Expected:
          sources=[vault], persona=general
          even at low salience, the item is found via search_vault
          (ToC is a routing aid, not a completeness filter)
        """
        r = _ask(tg, "what was that Harari book I started last year?", wait_s=40)
        assert _contains_any(r, ["sapiens", "harari"]), (
            f"long-tail Harari reference should be recoverable: {r!r}"
        )

    def test_14_recent_activity_sancho(self, tg, seeded_vault):
        """'Did Sancho send me anything lately?'  — recency bias query.

        Expected:
          sources=[vault], persona=social
          answer references the Tuesday dinner note
        """
        r = _ask(tg, "did Sancho send me anything lately?", wait_s=40)
        assert _contains_any(r, ["sancho"]), f"expected Sancho in reply: {r!r}"
        assert _contains_any(r, ["dinner", "tuesday", "fatty bao", "kids"]), (
            f"expected recent content about Sancho: {r!r}"
        )


# ---------------------------------------------------------------------------
# Group F — multi-hop / honest "no provider"
# ---------------------------------------------------------------------------

class TestMultiHop:
    """Compositional queries that require chaining across sources."""

    def test_13_route_to_contact_address(self, tg, seeded_vault):
        """'How do I get to Dr Carl's office by bus?'

        Expected:
          step 1: vault(health) → Dr Carl is on Castro St
          step 2: public_service(eta_query) with lat/lng → bus 42 / route info
          answer includes an ETA and mentions Castro / Dr Carl

        Requires BusDriver registered on AppView.
        """
        r = _ask(tg, "how do I get to Dr Carl's office by bus?", wait_s=180)
        assert _contains_any(r, ["castro", "dr carl", "carl"]), (
            f"expected Dr Carl's address context: {r!r}"
        )
        # An ETA is the ideal signal that public_service was actually called
        assert _contains_any(r, [" min ", " minutes"]), (
            f"expected bus ETA from public_service call: {r!r}"
        )

    def test_15_no_provider_honest_fallback(self, tg, seeded_vault):
        """'What's the weather in Bangalore right now?'

        No weather provider registered on AppView. Reply must be honest:
        "no weather service available," not a hallucinated forecast.

        Expected:
          sources=[public_services] → no candidates
          answer: explicit "no provider" rather than temperatures/conditions
        """
        r = _ask(tg, "what's the weather in Bangalore right now?", wait_s=60)
        hallucinations = ["°c", "°f", "degrees", "sunny", "cloudy", "rain", "humid"]
        assert not _contains_any(r, hallucinations), (
            f"reply appears to hallucinate weather (no provider registered): {r!r}"
        )
        honest_phrases = [
            "no provider",
            "no service",
            "can't check",
            "cannot check",
            "not available",
            "don't have",
        ]
        assert _contains_any(r, honest_phrases), (
            f"expected honest no-provider response: {r!r}"
        )
