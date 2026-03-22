"""Tests for PersonaRegistry and PersonaSelector."""

from __future__ import annotations

import asyncio
import json

import pytest

from src.service.persona_registry import PersonaRegistry, PersonaInfo
from src.service.persona_selector import PersonaSelector, SelectionResult


# ---------------------------------------------------------------------------
# Mock Core client
# ---------------------------------------------------------------------------

class MockCore:
    def __init__(self, personas: list[dict] | None = None):
        self._personas = personas or []

    async def list_personas_detailed(self) -> list[dict]:
        return list(self._personas)


class FailingCore:
    async def list_personas_detailed(self) -> list[dict]:
        raise ConnectionError("Core unreachable")


# ---------------------------------------------------------------------------
# Mock LLM
# ---------------------------------------------------------------------------

class MockLLM:
    def __init__(self, response: dict | None = None):
        self._response = response or {}

    async def complete(self, messages, **kwargs):
        return {"content": json.dumps(self._response)}


# ---------------------------------------------------------------------------
# PersonaRegistry tests
# ---------------------------------------------------------------------------

class TestPersonaRegistry:

    def test_normalize_strips_prefix(self):
        r = PersonaRegistry()
        assert r.normalize("persona-general") == "general"
        assert r.normalize("general") == "general"

    @pytest.mark.asyncio
    async def test_load_from_core(self):
        core = MockCore(personas=[
            {"id": "persona-general", "name": "general", "tier": "default", "locked": False},
            {"id": "persona-health", "name": "health", "tier": "sensitive", "locked": True},
        ])
        r = PersonaRegistry()
        await r.load(core)

        assert r.is_loaded()
        assert r.exists("general")
        assert r.exists("health")
        assert not r.exists("work")
        assert r.tier("general") == "default"
        assert r.tier("health") == "sensitive"
        assert r.locked("general") is False
        assert r.locked("health") is True

    @pytest.mark.asyncio
    async def test_fallback_on_core_unreachable(self):
        r = PersonaRegistry()
        await r.load(FailingCore())

        assert not r.is_loaded()
        assert r.exists("general")
        assert r.exists("work")
        assert r.exists("health")
        assert r.exists("finance")

    @pytest.mark.asyncio
    async def test_refresh_failure_keeps_cache(self):
        """Transient Core failure must NOT overwrite a valid cache."""
        core = MockCore(personas=[
            {"id": "persona-general", "name": "general", "tier": "default", "locked": False},
            {"id": "persona-travel", "name": "travel", "tier": "standard", "locked": False},
        ])
        r = PersonaRegistry()
        await r.load(core)
        assert r.exists("travel")

        await r.refresh(FailingCore())
        assert r.exists("travel"), "Cache must survive transient refresh failure"
        assert r.exists("general")

    def test_all_names(self):
        r = PersonaRegistry()
        r._ingest([
            {"id": "persona-general", "name": "general", "tier": "default", "locked": False},
            {"id": "persona-work", "name": "work", "tier": "standard", "locked": False},
        ])
        names = r.all_names()
        assert sorted(names) == ["general", "work"]

    def test_update_locked(self):
        r = PersonaRegistry()
        r._ingest([
            {"id": "persona-health", "name": "health", "tier": "sensitive", "locked": True},
        ])
        assert r.locked("health") is True
        r.update_locked("health", False)
        assert r.locked("health") is False

    @pytest.mark.asyncio
    async def test_refresh(self):
        core = MockCore(personas=[
            {"id": "persona-general", "name": "general", "tier": "default", "locked": False},
        ])
        r = PersonaRegistry()
        await r.load(core)
        assert len(r.all_names()) == 1

        core._personas.append(
            {"id": "persona-travel", "name": "travel", "tier": "standard", "locked": False}
        )
        await r.refresh(core)
        assert r.exists("travel")


# ---------------------------------------------------------------------------
# PersonaSelector tests
# ---------------------------------------------------------------------------

class TestPersonaSelector:

    def _make_registry(self) -> PersonaRegistry:
        r = PersonaRegistry()
        r._ingest([
            {"id": "persona-general", "name": "general", "tier": "default", "locked": False},
            {"id": "persona-financial_me", "name": "financial_me", "tier": "sensitive", "locked": True},
            {"id": "persona-financial_family", "name": "financial_family", "tier": "sensitive", "locked": True},
            {"id": "persona-health", "name": "health", "tier": "sensitive", "locked": True},
        ])
        return r

    @pytest.mark.asyncio
    async def test_explicit_hint_used(self):
        s = PersonaSelector(registry=self._make_registry())
        result = await s.select({"body": "anything"}, persona_hint="health")
        assert result.primary == "health"
        assert result.confidence == 1.0

    @pytest.mark.asyncio
    async def test_invalid_hint_returns_none(self):
        s = PersonaSelector(registry=self._make_registry())
        result = await s.select({"body": "anything"}, persona_hint="nonexistent")
        assert result is None  # caller uses deterministic fallback

    @pytest.mark.asyncio
    async def test_llm_selects_from_installed(self):
        llm = MockLLM(response={
            "primary": "financial_family",
            "secondary": [],
            "confidence": 0.91,
            "reason": "School fee context",
        })
        s = PersonaSelector(registry=self._make_registry(), llm=llm)
        result = await s.select({
            "type": "note",
            "source": "school",
            "body": "Your child's tuition payment is due",
        })
        assert result.primary == "financial_family"
        assert result.confidence == 0.91

    @pytest.mark.asyncio
    async def test_llm_invalid_persona_rejected(self):
        llm = MockLLM(response={
            "primary": "invented_persona",
            "secondary": [],
            "confidence": 0.95,
            "reason": "LLM hallucinated",
        })
        s = PersonaSelector(registry=self._make_registry(), llm=llm)
        result = await s.select({"body": "test"})
        # Invalid primary should cause selector to return None
        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_when_no_llm(self):
        s = PersonaSelector(registry=self._make_registry())
        result = await s.select({"body": "test"})
        assert result is None  # caller uses deterministic fallback

    @pytest.mark.asyncio
    async def test_secondary_validated(self):
        llm = MockLLM(response={
            "primary": "health",
            "secondary": ["financial_me", "nonexistent"],
            "confidence": 0.88,
            "reason": "Medical bill",
        })
        s = PersonaSelector(registry=self._make_registry(), llm=llm)
        result = await s.select({"body": "Medical bill $500"})
        assert result.primary == "health"
        assert "financial_me" in result.secondary
        assert "nonexistent" not in result.secondary

    @pytest.mark.asyncio
    async def test_llm_failure_returns_none(self):
        class FailingLLM:
            async def complete(self, *args, **kwargs):
                raise RuntimeError("LLM down")

        s = PersonaSelector(registry=self._make_registry(), llm=FailingLLM())
        result = await s.select({"body": "test"})
        assert result is None  # caller uses deterministic fallback
