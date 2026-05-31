"""Tests for person identity linking: extraction, resolution, and recall.

Covers:
  - PersonLinkExtractor: LLM-based extraction + confidence mapping
  - PersonResolver: surface matching, synonym expansion, dedup
  - Staging post-publish hook
  - Recall integration (person hints in vault_context)
"""

from __future__ import annotations

import json

import pytest
from unittest.mock import AsyncMock, MagicMock

from src.service.person_link_extractor import PersonLinkExtractor, EXTRACTOR_VERSION
from src.service.person_resolver import PersonResolver, ResolvedPerson


# ---------------------------------------------------------------------------
# PersonLinkExtractor tests
# ---------------------------------------------------------------------------

class TestPersonLinkExtractor:

    @pytest.fixture
    def mock_llm(self):
        return AsyncMock()

    @pytest.fixture
    def mock_core(self):
        core = AsyncMock()
        resp = MagicMock()
        resp.json.return_value = {"created": 1, "updated": 0, "conflicts": [], "skipped": False}
        core._request = AsyncMock(return_value=resp)
        return core

    @pytest.fixture
    def extractor(self, mock_llm, mock_core):
        return PersonLinkExtractor(llm=mock_llm, core=mock_core)

    def _llm_response(self, links: list[dict]) -> dict:
        return {"content": json.dumps({"identity_links": links})}

    # TRACE: {"suite": "BRAIN", "case": "0589", "section": "27", "sectionName": "Person Identity Linking", "subsection": "01", "scenario": "01", "title": "extract_high_confidence_naming"}
    @pytest.mark.asyncio
    async def test_extract_high_confidence_naming(self, extractor, mock_llm, mock_core):
        """'My daughter's name is Emma' → confirmed person with name + role_phrase."""
        mock_llm.route.return_value = self._llm_response([{
            "name": "Emma",
            "role_phrase": "my daughter",
            "relationship": "child",
            "confidence": "high",
            "evidence": "My daughter's name is Emma",
        }])
        result = await extractor.extract("My daughter's name is Emma", "item-1")
        assert result is not None
        assert result.get("created") == 1

        # Verify the Core API was called with correct structure.
        call_args = mock_core._request.call_args
        body = call_args.kwargs.get("json") or call_args[1].get("json")
        assert body["source_item_id"] == "item-1"
        assert body["extractor_version"] == EXTRACTOR_VERSION
        assert len(body["results"]) == 1
        link = body["results"][0]
        assert link["canonical_name"] == "Emma"
        assert link["relationship_hint"] == "child"
        surfaces = {s["surface"] for s in link["surfaces"]}
        assert "Emma" in surfaces
        assert "my daughter" in surfaces

    # TRACE: {"suite": "BRAIN", "case": "0590", "section": "27", "sectionName": "Person Identity Linking", "subsection": "01", "scenario": "02", "title": "extract_medium_confidence"}
    @pytest.mark.asyncio
    async def test_extract_medium_confidence(self, extractor, mock_llm, mock_core):
        """Medium confidence → surfaces marked medium."""
        mock_llm.route.return_value = self._llm_response([{
            "name": "Emma",
            "role_phrase": "our daughter",
            "relationship": "child",
            "confidence": "medium",
            "evidence": "Our daughter Emma went to school",
        }])
        result = await extractor.extract("Our daughter Emma went to school", "item-2")
        assert result is not None
        call_body = mock_core._request.call_args.kwargs.get("json") or mock_core._request.call_args[1].get("json")
        for s in call_body["results"][0]["surfaces"]:
            assert s["confidence"] == "medium"

    # TRACE: {"suite": "BRAIN", "case": "0591", "section": "27", "sectionName": "Person Identity Linking", "subsection": "01", "scenario": "03", "title": "extract_no_links"}
    @pytest.mark.asyncio
    async def test_extract_no_links(self, extractor, mock_llm, mock_core):
        """No identity links → nothing applied."""
        mock_llm.route.return_value = self._llm_response([])
        result = await extractor.extract("The weather is nice today", "item-3")
        assert result is None
        mock_core._request.assert_not_called()

    # TRACE: {"suite": "BRAIN", "case": "0592", "section": "27", "sectionName": "Person Identity Linking", "subsection": "01", "scenario": "04", "title": "extract_llm_failure"}
    @pytest.mark.asyncio
    async def test_extract_llm_failure(self, extractor, mock_llm, mock_core):
        """LLM failure → nothing learned, no error raised."""
        mock_llm.route.side_effect = Exception("LLM unavailable")
        result = await extractor.extract("My daughter's name is Emma", "item-4")
        assert result is None
        mock_core._request.assert_not_called()

    # TRACE: {"suite": "BRAIN", "case": "0593", "section": "27", "sectionName": "Person Identity Linking", "subsection": "01", "scenario": "05", "title": "extract_invalid_json"}
    @pytest.mark.asyncio
    async def test_extract_invalid_json(self, extractor, mock_llm, mock_core):
        """Invalid JSON from LLM → nothing learned."""
        mock_llm.route.return_value = {"content": "not json at all"}
        result = await extractor.extract("My daughter's name is Emma", "item-5")
        assert result is None

    # TRACE: {"suite": "BRAIN", "case": "0594", "section": "27", "sectionName": "Person Identity Linking", "subsection": "01", "scenario": "06", "title": "extract_social_reference_excluded"}
    @pytest.mark.asyncio
    async def test_extract_social_reference_excluded(self, extractor, mock_llm, mock_core):
        """LLM correctly excludes social references → no links."""
        mock_llm.route.return_value = self._llm_response([])
        result = await extractor.extract("Emma met my daughter at the park", "item-6")
        assert result is None

    # TRACE: {"suite": "BRAIN", "case": "0595", "section": "27", "sectionName": "Person Identity Linking", "subsection": "01", "scenario": "07", "title": "extract_empty_text"}
    @pytest.mark.asyncio
    async def test_extract_empty_text(self, extractor, mock_llm, mock_core):
        """Empty text → nothing extracted."""
        result = await extractor.extract("", "item-7")
        assert result is None
        mock_llm.route.assert_not_called()

    # TRACE: {"suite": "BRAIN", "case": "0596", "section": "27", "sectionName": "Person Identity Linking", "subsection": "01", "scenario": "08", "title": "extract_multiple_links"}
    @pytest.mark.asyncio
    async def test_extract_multiple_links(self, extractor, mock_llm, mock_core):
        """Multiple identity links in one note."""
        mock_llm.route.return_value = self._llm_response([
            {"name": "Emma", "role_phrase": "my daughter", "relationship": "child",
             "confidence": "high", "evidence": "My daughter Emma"},
            {"name": "Sarah", "role_phrase": "my wife", "relationship": "spouse",
             "confidence": "high", "evidence": "My wife Sarah"},
        ])
        result = await extractor.extract("My daughter Emma and my wife Sarah went shopping", "item-8")
        assert result is not None
        call_body = mock_core._request.call_args.kwargs.get("json") or mock_core._request.call_args[1].get("json")
        assert len(call_body["results"]) == 2

    # TRACE: {"suite": "BRAIN", "case": "0597", "section": "27", "sectionName": "Person Identity Linking", "subsection": "01", "scenario": "09", "title": "extract_name_only_no_role"}
    @pytest.mark.asyncio
    async def test_extract_name_only_no_role(self, extractor, mock_llm, mock_core):
        """Name without role phrase → still creates surface."""
        mock_llm.route.return_value = self._llm_response([{
            "name": "Sancho",
            "role_phrase": "",
            "relationship": "friend",
            "confidence": "high",
            "evidence": "Sancho is my friend",
        }])
        result = await extractor.extract("Sancho is my friend", "item-9")
        assert result is not None
        call_body = mock_core._request.call_args.kwargs.get("json") or mock_core._request.call_args[1].get("json")
        surfaces = call_body["results"][0]["surfaces"]
        assert len(surfaces) == 1
        assert surfaces[0]["surface"] == "Sancho"


# ---------------------------------------------------------------------------
# PersonResolver tests
# ---------------------------------------------------------------------------

class TestPersonResolver:

    def _make_person(self, pid, name, surfaces, contact_did="", relationship=""):
        return {
            "person_id": pid,
            "canonical_name": name,
            "contact_did": contact_did,
            "relationship_hint": relationship,
            "status": "confirmed",
            "surfaces": [
                {"surface": s, "normalized_surface": s.lower(), "surface_type": "name",
                 "status": "confirmed", "confidence": "high"}
                for s in surfaces
            ],
        }

    @pytest.fixture
    def resolver_with_people(self):
        """PersonResolver pre-loaded with test data (no async refresh needed)."""
        import re

        resolver = PersonResolver(core=None)
        people = [
            self._make_person("p1", "Emma", ["Emma", "my daughter"], relationship="child"),
            self._make_person("p2", "Sancho", ["Sancho", "my buddy"], relationship="friend"),
            self._make_person("p3", "Sarah", ["Sarah"], relationship="spouse"),
        ]

        for p in people:
            resolver._people[p["person_id"]] = p
            for s in p["surfaces"]:
                normalized = s["normalized_surface"]
                resolver._cache.setdefault(normalized, []).append(s)

        # Build patterns (longest-first).
        entries = []
        for p in people:
            for s in p["surfaces"]:
                entries.append((s["surface"], s["normalized_surface"], p["person_id"]))
        entries.sort(key=lambda e: len(e[0]), reverse=True)
        for surface, normalized, pid in entries:
            pattern = re.compile(r"\b" + re.escape(surface) + r"\b", re.IGNORECASE)
            resolver._patterns.append((pattern, normalized, pid))

        return resolver

    # TRACE: {"suite": "BRAIN", "case": "0598", "section": "27", "sectionName": "Person Identity Linking", "subsection": "02", "scenario": "01", "title": "resolve_by_name"}
    def test_resolve_by_name(self, resolver_with_people):
        """'Emma' resolves to person with all surfaces."""
        resolved = resolver_with_people.resolve("What does Emma like?")
        assert len(resolved) == 1
        assert resolved[0].canonical_name == "Emma"
        assert "my daughter" in resolved[0].surfaces

    # TRACE: {"suite": "BRAIN", "case": "0599", "section": "27", "sectionName": "Person Identity Linking", "subsection": "02", "scenario": "02", "title": "resolve_by_surface"}
    def test_resolve_by_surface(self, resolver_with_people):
        """'my daughter' resolves to Emma."""
        resolved = resolver_with_people.resolve("What does my daughter like?")
        assert len(resolved) == 1
        assert resolved[0].canonical_name == "Emma"

    # TRACE: {"suite": "BRAIN", "case": "0600", "section": "27", "sectionName": "Person Identity Linking", "subsection": "02", "scenario": "03", "title": "resolve_multiple"}
    def test_resolve_multiple(self, resolver_with_people):
        """Multiple persons mentioned → multiple resolved."""
        resolved = resolver_with_people.resolve("Tell me about Emma and Sancho")
        names = {r.canonical_name for r in resolved}
        assert names == {"Emma", "Sancho"}

    # TRACE: {"suite": "BRAIN", "case": "0601", "section": "27", "sectionName": "Person Identity Linking", "subsection": "02", "scenario": "04", "title": "resolve_dedup"}
    def test_resolve_dedup(self, resolver_with_people):
        """Same person mentioned twice → one resolved entry."""
        resolved = resolver_with_people.resolve("Emma and my daughter are the same")
        emma_resolved = [r for r in resolved if r.canonical_name == "Emma"]
        assert len(emma_resolved) == 1

    # TRACE: {"suite": "BRAIN", "case": "0602", "section": "27", "sectionName": "Person Identity Linking", "subsection": "02", "scenario": "05", "title": "resolve_no_match"}
    def test_resolve_no_match(self, resolver_with_people):
        """Unknown name → no resolution."""
        resolved = resolver_with_people.resolve("What does Dave like?")
        assert len(resolved) == 0

    # TRACE: {"suite": "BRAIN", "case": "0603", "section": "27", "sectionName": "Person Identity Linking", "subsection": "02", "scenario": "06", "title": "expand_search_terms"}
    def test_expand_search_terms(self, resolver_with_people):
        """Search expansion adds synonym surfaces not in the query."""
        terms = resolver_with_people.expand_search_terms("What does Emma like?")
        assert "my daughter" in terms
        # "Emma" should NOT be in expansion — it's already in the query.
        assert "Emma" not in terms

    # TRACE: {"suite": "BRAIN", "case": "0604", "section": "27", "sectionName": "Person Identity Linking", "subsection": "02", "scenario": "07", "title": "expand_via_surface"}
    def test_expand_via_surface(self, resolver_with_people):
        """Search expansion via surface phrase."""
        terms = resolver_with_people.expand_search_terms("What does my daughter like?")
        assert "Emma" in terms

    # TRACE: {"suite": "BRAIN", "case": "0605", "section": "27", "sectionName": "Person Identity Linking", "subsection": "02", "scenario": "08", "title": "resolve_empty_text"}
    def test_resolve_empty_text(self, resolver_with_people):
        assert resolver_with_people.resolve("") == []

    # TRACE: {"suite": "BRAIN", "case": "0606", "section": "27", "sectionName": "Person Identity Linking", "subsection": "02", "scenario": "09", "title": "expand_no_match"}
    def test_expand_no_match(self, resolver_with_people):
        """No match → no expansion."""
        terms = resolver_with_people.expand_search_terms("What is the weather?")
        assert terms == []


# ---------------------------------------------------------------------------
# Extraction prompt quality tests (no real LLM — testing parsing)
# ---------------------------------------------------------------------------

class TestExtractionParsing:

    @pytest.fixture
    def extractor(self):
        return PersonLinkExtractor(llm=AsyncMock(), core=AsyncMock())

    # TRACE: {"suite": "BRAIN", "case": "0607", "section": "27", "sectionName": "Person Identity Linking", "subsection": "03", "scenario": "01", "title": "parse_valid_json"}
    def test_parse_valid_json(self, extractor):
        content = json.dumps({"identity_links": [
            {"name": "Emma", "role_phrase": "my daughter", "relationship": "child",
             "confidence": "high", "evidence": "test"}
        ]})
        links = extractor._parse_response(content)
        assert len(links) == 1
        assert links[0]["name"] == "Emma"

    # TRACE: {"suite": "BRAIN", "case": "0608", "section": "27", "sectionName": "Person Identity Linking", "subsection": "03", "scenario": "02", "title": "parse_markdown_fenced"}
    def test_parse_markdown_fenced(self, extractor):
        content = '```json\n{"identity_links": [{"name": "X", "role_phrase": "my friend", "relationship": "friend", "confidence": "low", "evidence": "t"}]}\n```'
        links = extractor._parse_response(content)
        assert len(links) == 1

    # TRACE: {"suite": "BRAIN", "case": "0609", "section": "27", "sectionName": "Person Identity Linking", "subsection": "03", "scenario": "03", "title": "parse_empty_links"}
    def test_parse_empty_links(self, extractor):
        links = extractor._parse_response('{"identity_links": []}')
        assert links == []

    # TRACE: {"suite": "BRAIN", "case": "0610", "section": "27", "sectionName": "Person Identity Linking", "subsection": "03", "scenario": "04", "title": "parse_invalid_json"}
    def test_parse_invalid_json(self, extractor):
        links = extractor._parse_response("not json")
        assert links == []

    # TRACE: {"suite": "BRAIN", "case": "0611", "section": "27", "sectionName": "Person Identity Linking", "subsection": "03", "scenario": "05", "title": "parse_missing_key"}
    def test_parse_missing_key(self, extractor):
        links = extractor._parse_response('{"other": "data"}')
        assert links == []
