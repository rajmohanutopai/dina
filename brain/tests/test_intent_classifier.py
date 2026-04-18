"""Unit tests for intent_classifier pure helpers.

Covers the parse/coerce/render paths — the logic that normalises raw
LLM output into a typed IntentClassification and the ToC renderer that
feeds the classifier prompt. The `classify()` coroutine itself is
covered by sanity tests (real LLM) and is mocked elsewhere.
"""
from __future__ import annotations

from src.service.intent_classifier import (
    IntentClassification,
    _coerce,
    _parse_json,
    _render_toc_for_prompt,
)


class TestParseJson:
    def test_plain_json(self) -> None:
        assert _parse_json('{"sources": ["vault"]}') == {"sources": ["vault"]}

    def test_strips_code_fence(self) -> None:
        raw = '```json\n{"sources": ["vault"]}\n```'
        assert _parse_json(raw) == {"sources": ["vault"]}

    def test_empty_returns_empty_dict(self) -> None:
        assert _parse_json("") == {}

    def test_invalid_json_returns_empty(self) -> None:
        assert _parse_json("not json") == {}

    def test_non_object_returns_empty(self) -> None:
        # Classifier must return an object, not a bare list.
        assert _parse_json('["a", "b"]') == {}


class TestCoerce:
    def test_filters_unknown_sources(self) -> None:
        data = {"sources": ["vault", "fake_source", "trust_network"]}
        result = _coerce(data)
        assert result.sources == ["vault", "trust_network"]

    def test_all_unknown_sources_fallback_to_vault(self) -> None:
        # When LLM emits nothing we recognise, conservative default.
        data = {"sources": ["nonsense"]}
        result = _coerce(data)
        assert result.sources == ["vault"]

    def test_missing_sources_fallback_to_vault(self) -> None:
        result = _coerce({})
        assert result.sources == ["vault"]

    def test_accepts_provider_services(self) -> None:
        result = _coerce({"sources": ["provider_services"]})
        assert result.sources == ["provider_services"]

    def test_filters_unknown_temporal(self) -> None:
        data = {"sources": ["vault"], "temporal": "eternal"}
        result = _coerce(data)
        assert result.temporal == ""

    def test_accepts_live_state(self) -> None:
        result = _coerce({"sources": ["vault"], "temporal": "live_state"})
        assert result.temporal == "live_state"

    def test_non_dict_toc_evidence_becomes_empty(self) -> None:
        data = {"sources": ["vault"], "toc_evidence": "not a dict"}
        result = _coerce(data)
        assert result.toc_evidence == {}

    def test_preserves_toc_evidence_structure(self) -> None:
        ev = {
            "entity_matches": ["Dr Carl"],
            "live_capabilities_available": [
                {"provider": "did:plc:x", "capability": "appointment_status"},
            ],
        }
        result = _coerce({"sources": ["vault"], "toc_evidence": ev})
        assert result.toc_evidence == ev

    def test_non_string_reasoning_hint_becomes_empty(self) -> None:
        result = _coerce({"sources": ["vault"], "reasoning_hint": 42})
        assert result.reasoning_hint == ""

    def test_returns_intent_classification(self) -> None:
        result = _coerce({"sources": ["vault"]})
        assert isinstance(result, IntentClassification)


class TestDefault:
    def test_default_is_conservative(self) -> None:
        d = IntentClassification.default()
        # Defaults to vault — the safest single source to point at when
        # the classifier can't produce a result (user's own data first).
        assert d.sources == ["vault"]
        assert d.relevant_personas == []
        assert d.toc_evidence == {}
        assert d.temporal == ""
        assert "reasoning agent" in d.reasoning_hint.lower()

    def test_to_dict_roundtrip(self) -> None:
        c = IntentClassification(
            sources=["vault", "provider_services"],
            relevant_personas=["health"],
            toc_evidence={"entity_matches": ["Dr Carl"]},
            temporal="live_state",
            reasoning_hint="test hint",
        )
        d = c.to_dict()
        assert d["sources"] == ["vault", "provider_services"]
        assert d["relevant_personas"] == ["health"]
        assert d["toc_evidence"] == {"entity_matches": ["Dr Carl"]}
        assert d["temporal"] == "live_state"
        assert d["reasoning_hint"] == "test hint"


class TestRenderToc:
    def test_empty_message(self) -> None:
        out = _render_toc_for_prompt([])
        assert "empty" in out.lower()

    def test_groups_by_persona(self) -> None:
        entries = [
            {"persona": "health", "topic": "dentist appointment"},
            {"persona": "work", "topic": "Acme deal"},
            {"persona": "health", "topic": "Dr Carl"},
        ]
        out = _render_toc_for_prompt(entries)
        assert "health:" in out
        assert "work:" in out
        assert "dentist appointment" in out
        assert "Dr Carl" in out
        assert "Acme deal" in out

    def test_inlines_live_capability_annotation(self) -> None:
        entries = [
            {
                "persona": "health",
                "topic": "Dr Carl",
                "live_capability": "appointment_status",
                "live_provider_did": "did:plc:abc",
            },
        ]
        out = _render_toc_for_prompt(entries)
        assert "Dr Carl" in out
        assert "live: appointment_status" in out
        assert "did:plc:abc" in out

    def test_skips_annotation_when_cap_missing(self) -> None:
        entries = [
            {
                "persona": "health",
                "topic": "Dr Carl",
                "live_capability": "",
                "live_provider_did": "",
            },
        ]
        out = _render_toc_for_prompt(entries)
        assert "Dr Carl" in out
        assert "live:" not in out

    def test_missing_persona_defaults_to_general(self) -> None:
        entries = [{"topic": "orphan"}]
        out = _render_toc_for_prompt(entries)
        assert "general:" in out
        assert "orphan" in out
