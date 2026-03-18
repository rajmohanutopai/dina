"""User Story 02: The Sancho Moment — context-aware nudge from D2D message.

SEQUENTIAL TEST — tests MUST run in order (00 → 06).
Each test builds on state from the previous one.

Story
-----
Two weeks ago, Sancho visited Alonso. During their conversation, Sancho
mentioned his mother had a bad fall and was recovering at home. Alonso
told his Dina: "Remember this — Sancho's mother is unwell." Dina also
noticed (from three previous visits) that Sancho always asks for strong
cardamom tea.

Today, Sancho is leaving home to visit Alonso again. Sancho's Dina
sends a presence update ("dina/social/arrival") to Alonso's Dina via
encrypted Dina-to-Dina messaging.

Alonso's Dina:
  1. Receives the encrypted D2D message from Sancho's Dina
  2. Decrypts it (NaCl sealed box, Ed25519 signature verification)
  3. Queries the vault: "What do I know about Sancho?"
  4. Finds: "Sancho's mother was unwell" (from 2 weeks ago)
  5. Finds: "Sancho likes strong cardamom tea" (from preferences)
  6. Assembles a nudge for Alonso: "Sancho is on his way. His mother
     was unwell last time — you might want to ask. He likes strong
     cardamom tea."

This tests the full D2D → ingress → nudge pipeline:
  Sancho's Core → NaCl encrypt → HTTP POST /msg → Alonso's Core
  → decrypt → verify signature → trust filter → inbox
  → Brain process → vault query → nudge assembly

No other system does this. Your phone shows "Sancho is calling" — just
the name. Dina shows "Sancho is on his way — his mother was unwell, he
likes cardamom tea." That's the difference between notification and
preparation.

Architecture
------------
::

  Sancho's Dina (Core:19301)
    → POST /v1/msg/send {"to":"did:plc:alonso", "type":"dina/social/arrival"}
    → Sign with Sancho's Ed25519 key
    → Resolve Alonso's DID → get public key
    → NaCl sealed box encrypt
    → HTTP POST to Alonso's Core (http://core-alonso:8100/msg)
                                    ↓
  Alonso's Core (Core:19300)
    → Ingress Router: IP rate limit → vault state check
    → Fast path: decrypt with Alonso's X25519 key
    → Verify Sancho's Ed25519 signature
    → Trust filter: EvaluateIngress(did:plc:sancho)
    → Store in inbox
                                    ↓
  Alonso's Brain (Brain:19400)
    → POST /api/v1/process (DIDComm event)
    → GuardianLoop._handle_didcomm()
    → NudgeAssembler.assemble_nudge(from=did:plc:sancho)
    → Vault query: search for items with ContactDID=Sancho
    → Finds: mother unwell, cardamom tea preference
    → Assembles nudge text with sources
"""

from __future__ import annotations

import base64
import json
import os
import time

import httpx
import pytest

# ---------------------------------------------------------------------------
# Shared state across ordered tests
# ---------------------------------------------------------------------------

_state: dict = {}


# ---------------------------------------------------------------------------
# Test class — sequential user journey
# ---------------------------------------------------------------------------


class TestSanchoMoment:
    """The Sancho Moment: D2D presence → vault recall → contextual nudge."""

    # -----------------------------------------------------------------
    # 00 — Previous conversation: Alonso tells Dina to remember context
    # -----------------------------------------------------------------

    # TST-USR-014
    def test_00_previous_conversation_stored_in_vault(
        self, alonso_core, admin_headers
    ):
        """Simulate a previous conversation where Dina stored context.

        Two weeks ago, Sancho visited. During the conversation:
          - Sancho mentioned his mother had a bad fall
          - Alonso told Dina: "Remember — Sancho's mother is unwell"
          - Dina also observed: Sancho always asks for cardamom tea

        Dina stored these as relationship notes in Alonso's vault,
        tagged with Sancho's DID so they can be recalled later.

        In a full system, this would happen via:
          1. D2D conversation messages arrive
          2. Brain processes them, extracts key facts
          3. Brain stores summaries in vault via POST /v1/vault/store

        Here we simulate step 3 directly — the vault items represent
        what Dina would have stored from observing the conversation.
        """
        # Use the configured DIDs (from DINA_OWN_DID in docker-compose).
        # These are the DIDs used for D2D routing — the DINA_KNOWN_PEERS
        # resolver maps these DIDs to endpoints and public keys.
        # The generated DIDs from /v1/did (e.g. did:plc:XhqSZnjK7ca6XukzgeEjYr)
        # are derived from the keypair but NOT registered in the peer resolver.
        sancho_did = "did:plc:sancho"
        alonso_did = "did:plc:alonso"
        _state["sancho_did"] = sancho_did
        _state["alonso_did"] = alonso_did
        print(f"\n  [sancho] Sancho's DID: {sancho_did}")
        print(f"  [sancho] Alonso's DID: {alonso_did}")

        # Store relationship note: Sancho's mother was unwell
        # This simulates: Alonso said "Dina, remember — Sancho's mother
        # had a fall and is recovering." Dina stored it in the vault.
        r1 = httpx.post(
            f"{alonso_core}/v1/vault/store",
            json={
                "persona": "general",
                "item": {
                    "Type": "relationship_note",
                    "Source": "conversation",
                    "ContactDID": sancho_did,
                    "Summary": (
                        "Sancho's mother had a bad fall — recovering at home"
                    ),
                    "BodyText": (
                        f"During Sancho's visit ({sancho_did}), he mentioned "
                        "his mother had a bad fall last week and was in hospital "
                        "for two days. She is now recovering at home but still "
                        "needs help with daily activities. Sancho sounded worried "
                        "and mentioned he's been visiting her every other day. "
                        "Alonso asked Dina to remember this."
                    ),
                    "Metadata": json.dumps({
                        "contact_did": sancho_did,
                        "context_type": "family_health",
                        "stored_by": "user_instruction",
                    }),
                },
            },
            headers=admin_headers,
            timeout=10,
        )
        assert r1.status_code == 201, (
            f"Failed to store mother note: {r1.status_code} {r1.text}"
        )
        _state["mother_note_id"] = r1.json().get("id", "")
        print(f"  [sancho] Stored: mother unwell (id={_state['mother_note_id'][:8]}...)")

        # Store preference: Sancho likes strong cardamom tea
        # This simulates: Dina observed across 3 visits that Sancho
        # always asks for cardamom tea. Pattern detected and stored.
        r2 = httpx.post(
            f"{alonso_core}/v1/vault/store",
            json={
                "persona": "general",
                "item": {
                    "Type": "note",
                    "Source": "observation",
                    "ContactDID": sancho_did,
                    "Summary": (
                        "Sancho prefers strong cardamom tea — always asks "
                        "for it when visiting"
                    ),
                    "BodyText": (
                        f"Observed across 3 visits from Sancho ({sancho_did}): "
                        "he always asks for cardamom tea. Prefers it strong "
                        "with less sugar. Last three visits he specifically "
                        "requested cardamom tea over regular chai. Alonso "
                        "usually has cardamom pods in the kitchen."
                    ),
                    "Metadata": json.dumps({
                        "contact_did": sancho_did,
                        "context_type": "preference",
                        "preference_type": "beverage",
                        "confidence": "high",
                        "observations": 3,
                    }),
                },
            },
            headers=admin_headers,
            timeout=10,
        )
        assert r2.status_code == 201, (
            f"Failed to store tea note: {r2.status_code} {r2.text}"
        )
        _state["tea_note_id"] = r2.json().get("id", "")
        print(f"  [sancho] Stored: cardamom tea (id={_state['tea_note_id'][:8]}...)")

        # Verify: query vault for items about Sancho
        r3 = httpx.post(
            f"{alonso_core}/v1/vault/query",
            json={
                "persona": "general",
                "query": sancho_did,
                "mode": "fts5",
            },
            headers=admin_headers,
            timeout=10,
        )
        assert r3.status_code == 200
        items = r3.json().get("items", [])
        assert len(items) >= 2, (
            f"Expected >= 2 vault items about Sancho, got {len(items)}"
        )
        print(f"  [sancho] Vault query for Sancho: {len(items)} items found")

    # -----------------------------------------------------------------
    # 01 — Sancho's Dina sends D2D arrival message
    # -----------------------------------------------------------------

    # TST-USR-015
    def test_01_sancho_sends_d2d_arrival_message(
        self, sancho_core, admin_headers
    ):
        """Sancho's Dina sends a presence update to Alonso's Dina.

        The message type is "dina/social/arrival" — a DIDComm-compatible
        presence notification. Sancho's Core encrypts it with NaCl sealed
        box, signs with Ed25519, and delivers to Alonso's Core.

        The body is simple: {"status": "leaving_home"}.
        Dina doesn't need verbose payloads — the value comes from what
        YOUR Dina already knows about the sender.
        """
        alonso_did = _state["alonso_did"]

        body_payload = json.dumps({
            "status": "leaving_home",
            "message": "On my way to your place",
        })

        r = httpx.post(
            f"{sancho_core}/v1/msg/send",
            json={
                "to": alonso_did,
                "body": base64.b64encode(body_payload.encode()).decode(),
                "type": "dina/social/arrival",
            },
            headers=admin_headers,
            timeout=15,
        )
        assert r.status_code == 202, (
            f"D2D send failed: {r.status_code} {r.text}"
        )
        print(f"\n  [sancho] Sent dina/social/arrival to {alonso_did[:30]}...")

    # -----------------------------------------------------------------
    # 02 — Alonso's Core receives and decrypts the message
    # -----------------------------------------------------------------

    # TST-USR-016
    def test_02_alonso_receives_decrypted_d2d_message(
        self, alonso_core, admin_headers
    ):
        """Verify Alonso's Core received and decrypted Sancho's message.

        The ingress pipeline:
          1. NaCl sealed box → decrypt with Alonso's X25519 key
          2. Ed25519 signature → verify against Sancho's public key
          3. Trust filter → EvaluateIngress(Sancho's DID)
          4. Store in inbox

        We poll the inbox with a 30-second timeout to account for
        encryption, key resolution, and background sweeper delays.
        """
        sancho_did = _state["sancho_did"]

        deadline = time.time() + 30
        found = False
        msg_data = None

        while time.time() < deadline:
            r = httpx.get(
                f"{alonso_core}/v1/msg/inbox",
                headers=admin_headers,
                timeout=10,
            )
            assert r.status_code == 200

            messages = r.json().get("messages", [])
            for msg in messages:
                msg_from = msg.get("From", "")
                msg_type = msg.get("Type", "")
                if (
                    msg_type == "dina/social/arrival"
                    and msg_from == sancho_did
                ):
                    found = True
                    msg_data = msg
                    break

            if found:
                break
            time.sleep(1)

        assert found, (
            f"D2D message not received in Alonso's inbox after 30s. "
            f"Expected From={sancho_did}, Type=dina/social/arrival"
        )
        _state["d2d_message"] = msg_data
        print(
            f"\n  [sancho] Received D2D: Type={msg_data.get('Type')}, "
            f"From={msg_data.get('From', '')[:30]}..."
        )

    # -----------------------------------------------------------------
    # 03 — Brain processes the DIDComm event
    # -----------------------------------------------------------------

    # TST-USR-017
    def test_03_brain_processes_didcomm_arrival(
        self, alonso_brain, brain_signer
    ):
        """Send the arrival event to Alonso's Brain for processing.

        Brain's GuardianLoop._handle_didcomm() routes dina/social/*
        messages through the nudge assembly pipeline:
          1. Extract sender DID from the "from" field
          2. Call NudgeAssembler.assemble_nudge(event, from_did)
          3. Nudge assembler queries vault for items about the sender
          4. If context found, assemble nudge text with sources
        """
        sancho_did = _state["sancho_did"]
        msg = _state["d2d_message"]

        # Decode the body if it's base64
        body = msg.get("Body", "")
        if body:
            try:
                body = base64.b64decode(body).decode()
            except Exception:
                body = str(body)

        r = brain_signer.post(
            f"{alonso_brain}/api/v1/process",
            json={
                "type": "dina/social/arrival",
                "body": body,
                "from": sancho_did,
                "persona_id": "general",
                "source": "d2d",
                "contact_did": sancho_did,
            },
            timeout=15,
        )
        assert r.status_code == 200, (
            f"Brain process failed: {r.status_code} {r.text}"
        )
        _state["process_result"] = r.json()
        print(
            f"\n  [sancho] Brain processed: action={r.json().get('action')}"
        )

    # -----------------------------------------------------------------
    # 04 — Verify nudge was assembled
    # -----------------------------------------------------------------

    # TST-USR-018
    def test_04_nudge_was_assembled(self):
        """Verify Brain assembled a nudge (not silence).

        The guardian routes dina/social/* to _handle_didcomm(), which
        calls the nudge assembler. If vault context exists for the
        sender, a nudge should be assembled.
        """
        result = _state["process_result"]
        action = result.get("action")

        assert action == "nudge_assembled", (
            f"Expected action='nudge_assembled', got '{action}'. "
            f"Full result: {result}"
        )

        nudge = result.get("nudge")
        assert nudge is not None, (
            "Nudge is None — vault context about Sancho was not found. "
            "The nudge assembler should have queried vault by Sancho's DID "
            "and found the relationship note and tea preference."
        )
        _state["nudge"] = nudge
        print(f"\n  [sancho] Nudge assembled: {nudge.get('text', '')[:100]}...")

    # -----------------------------------------------------------------
    # 05 — Verify nudge contains vault context
    # -----------------------------------------------------------------

    # TST-USR-019
    def test_05_nudge_contains_vault_context(self):
        """Verify the nudge references both vault items.

        The nudge should mention:
          1. Sancho's mother being unwell (from the relationship note)
          2. Sancho's cardamom tea preference (from the observation)

        This is what makes Dina different from a phone notification.
        Your phone says "Sancho is calling." Dina says "Sancho is on
        his way — his mother was unwell, he likes cardamom tea."
        """
        nudge = _state["nudge"]
        nudge_text = nudge.get("text", "").lower()

        print(f"\n  [sancho] Full nudge text: {nudge.get('text', '')}")

        # Check for mother/health context
        mother_signals = ["mother", "mum", "mom", "fall", "unwell", "hospital"]
        has_mother = any(s in nudge_text for s in mother_signals)
        assert has_mother, (
            f"Nudge missing mother/health context. "
            f"Expected one of {mother_signals}. Got: {nudge_text}"
        )

        # Check for tea preference
        tea_signals = ["cardamom", "tea", "chai", "beverage"]
        has_tea = any(s in nudge_text for s in tea_signals)
        assert has_tea, (
            f"Nudge missing tea preference context. "
            f"Expected one of {tea_signals}. Got: {nudge_text}"
        )

        # Check sources are provided (for Deep Link default)
        sources = nudge.get("sources", [])
        assert len(sources) >= 1, (
            f"Nudge should reference source items. Got: {sources}"
        )

        print("  [sancho] Nudge verification:")
        print(f"    Mother/health context:  YES")
        print(f"    Tea preference:         YES")
        print(f"    Sources referenced:     {len(sources)}")

    # -----------------------------------------------------------------
    # 06 — LLM generates human-quality nudge (optional)
    # -----------------------------------------------------------------

    # TST-USR-020
    @pytest.mark.skipif(
        not os.environ.get("GOOGLE_API_KEY"),
        reason="GOOGLE_API_KEY not set — skipping real LLM test",
    )
    def test_06_llm_generates_human_quality_nudge(
        self, alonso_brain, brain_signer
    ):
        """LLM generates a natural, warm nudge from vault context.

        This test sends the vault context + arrival event to the LLM
        and verifies the response is a natural 1-3 sentence nudge
        that a human would actually want to receive.

        The nudge should:
          - Mention Sancho is on his way
          - Gently suggest asking about his mother
          - Mention the cardamom tea preference
          - Be brief and natural (not a bullet-point report)
        """
        nudge = _state.get("nudge", {})
        nudge_text = nudge.get("text", "")

        prompt = (
            "You are Dina, a personal AI assistant. Your user Alonso "
            "just received a presence notification: Sancho is leaving "
            "home and heading to Alonso's place.\n"
            "\n"
            "From your vault, you know:\n"
            "1. About 2 weeks ago, Sancho mentioned his mother had a "
            "bad fall and was in hospital. She is recovering at home "
            "but still needs help. Sancho was worried.\n"
            "2. Sancho always asks for strong cardamom tea when visiting "
            "(observed across 3 visits). He prefers it with less sugar.\n"
            "\n"
            "Generate a brief, warm nudge for Alonso (1-3 sentences). "
            "Mention that Sancho is on his way, gently suggest asking "
            "about his mother, and mention the tea. Natural tone — "
            "this is a helpful whisper, not a briefing document."
        )

        r = brain_signer.post(
            f"{alonso_brain}/api/v1/reason",
            json={
                "prompt": prompt,
                "persona_tier": "default",
                "skip_vault_enrichment": True,
            },
            timeout=60,
        )
        assert r.status_code == 200, (
            f"LLM nudge failed: {r.status_code} {r.text}"
        )

        content = r.json().get("content", "")
        content_lower = content.lower()
        model = r.json().get("model", "")

        # Must mention all three elements
        assert "sancho" in content_lower, (
            f"LLM nudge doesn't mention Sancho. Response: {content[:300]}"
        )

        mother_words = ["mother", "mum", "mom"]
        assert any(w in content_lower for w in mother_words), (
            f"LLM nudge doesn't mention Sancho's mother. "
            f"Response: {content[:300]}"
        )

        tea_words = ["tea", "cardamom", "chai"]
        assert any(w in content_lower for w in tea_words), (
            f"LLM nudge doesn't mention tea. Response: {content[:300]}"
        )

        # Should be concise (1-3 sentences, not a wall of text)
        assert len(content) < 1000, (
            f"Nudge is too long ({len(content)} chars). "
            f"Expected 1-3 sentences, not a briefing document."
        )

        print("\n")
        print("  " + "=" * 62)
        print("  DINA'S NUDGE: \"Sancho is on his way.\"")
        print("  " + "=" * 62)
        print(f"  Model: {model}")
        print("  " + "-" * 62)
        for line in content.split("\n"):
            print(f"  {line}")
        print("  " + "-" * 62)
        print("  This is what your phone DOESN'T tell you.")
        print("  " + "=" * 62)
