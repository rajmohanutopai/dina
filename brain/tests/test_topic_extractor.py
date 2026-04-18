"""Unit tests for topic_extractor helpers.

The class-level `TopicExtractor.extract` method makes an LLM call — tested
via mocked LLM elsewhere. Here we lock down the pure helpers (`_parse_json_response`,
`_sanitise_list`) that normalise whatever an LLM hands back.
"""
from __future__ import annotations

from src.service.topic_extractor import _parse_json_response, _sanitise_list


class TestParseJsonResponse:
    def test_plain_json(self) -> None:
        assert _parse_json_response('{"entities": ["a"]}') == {"entities": ["a"]}

    def test_stripped_code_fence(self) -> None:
        raw = '```json\n{"themes": ["work"]}\n```'
        assert _parse_json_response(raw) == {"themes": ["work"]}

    def test_code_fence_without_language(self) -> None:
        raw = "```\n{\"entities\": []}\n```"
        assert _parse_json_response(raw) == {"entities": []}

    def test_leading_whitespace(self) -> None:
        assert _parse_json_response("   {\"x\": 1}  ") == {"x": 1}

    def test_empty_string_returns_empty(self) -> None:
        assert _parse_json_response("") == {}

    def test_invalid_json_returns_empty(self) -> None:
        assert _parse_json_response("not json") == {}

    def test_non_object_returns_empty(self) -> None:
        # LLM returns a bare list — we only accept objects.
        assert _parse_json_response('["a", "b"]') == {}

    def test_null_returns_empty(self) -> None:
        assert _parse_json_response("null") == {}


class TestSanitiseList:
    def test_basic_trim_and_cap(self) -> None:
        raw = ["  Dr Carl ", "Appointment"]
        assert _sanitise_list(raw, limit=5) == ["Dr Carl", "Appointment"]

    def test_dedupes_case_insensitively(self) -> None:
        raw = ["Dr Carl", "dr carl", "DR CARL"]
        # First occurrence wins — preserves original casing.
        assert _sanitise_list(raw, limit=5) == ["Dr Carl"]

    def test_drops_empties(self) -> None:
        assert _sanitise_list(["", "  ", "real"], limit=5) == ["real"]

    def test_drops_overlong_strings(self) -> None:
        long_junk = "x" * 81
        assert _sanitise_list([long_junk, "ok"], limit=5) == ["ok"]

    def test_drops_non_strings(self) -> None:
        assert _sanitise_list(["ok", 42, None, {"x": 1}], limit=5) == ["ok"]

    def test_respects_limit(self) -> None:
        assert _sanitise_list(["a", "b", "c", "d"], limit=2) == ["a", "b"]

    def test_non_list_input_returns_empty(self) -> None:
        assert _sanitise_list("not a list", limit=5) == []
        assert _sanitise_list(None, limit=5) == []
        assert _sanitise_list({"a": 1}, limit=5) == []
