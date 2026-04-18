"""Unit tests for the requester-identity auto-fill in _query_service.

Locks down the deterministic rule that replaced procedural LLM prompt
guidance — when a provider's params schema marks a requester-identity
field as required and the LLM forgot to supply it, the tool fills
"self" before sender-side validation. Pure function, easy to test.
"""
from __future__ import annotations

from src.service.vault_context import (
    _autofill_requester_fields,
    _looks_like_requester_field,
)


class TestLooksLikeRequesterField:
    def test_patient_prefix(self) -> None:
        assert _looks_like_requester_field("patient_ref")
        assert _looks_like_requester_field("patient_id")
        assert _looks_like_requester_field("patient_name")

    def test_customer_prefix(self) -> None:
        assert _looks_like_requester_field("customer_id")
        assert _looks_like_requester_field("customer_email")

    def test_account_prefix(self) -> None:
        assert _looks_like_requester_field("account_id")
        assert _looks_like_requester_field("account_holder")

    def test_member_prefix(self) -> None:
        assert _looks_like_requester_field("member_id")

    def test_plain_id_not_a_match(self) -> None:
        # Too generic — might be a third-party ID, not the requester.
        assert not _looks_like_requester_field("id")
        assert not _looks_like_requester_field("ref")

    def test_unrelated_fields(self) -> None:
        assert not _looks_like_requester_field("date")
        assert not _looks_like_requester_field("route_id")
        assert not _looks_like_requester_field("location")
        assert not _looks_like_requester_field("destination_ref")

    def test_empty_string(self) -> None:
        assert not _looks_like_requester_field("")

    def test_case_insensitive(self) -> None:
        assert _looks_like_requester_field("Patient_Ref")
        assert _looks_like_requester_field("CUSTOMER_ID")


class TestAutofillRequesterFields:
    def test_fills_missing_required_requester_field(self) -> None:
        schema = {
            "required": ["patient_ref", "date"],
            "properties": {
                "patient_ref": {"type": "string"},
                "date": {"type": "string"},
            },
        }
        params = {"date": "2026-04-19"}
        out = _autofill_requester_fields(params, schema)
        assert out == {"patient_ref": "self", "date": "2026-04-19"}

    def test_does_not_overwrite_supplied_value(self) -> None:
        schema = {"required": ["patient_ref"], "properties": {"patient_ref": {}}}
        params = {"patient_ref": "alonso"}
        out = _autofill_requester_fields(params, schema)
        assert out == {"patient_ref": "alonso"}

    def test_does_not_fill_non_requester_fields(self) -> None:
        schema = {
            "required": ["route_id", "location"],
            "properties": {
                "route_id": {"type": "string"},
                "location": {"type": "object"},
            },
        }
        params = {}
        out = _autofill_requester_fields(params, schema)
        # Neither field matches requester-identity patterns.
        assert "route_id" not in out
        assert "location" not in out

    def test_does_not_fill_optional_fields(self) -> None:
        schema = {
            "required": [],  # patient_ref is optional
            "properties": {"patient_ref": {"type": "string"}},
        }
        params = {}
        out = _autofill_requester_fields(params, schema)
        # Only required missing fields get auto-filled.
        assert out == {}

    def test_empty_required_list_is_noop(self) -> None:
        schema = {"required": [], "properties": {}}
        params = {"unrelated": "value"}
        out = _autofill_requester_fields(params, schema)
        assert out == {"unrelated": "value"}

    def test_missing_required_key_in_schema_is_noop(self) -> None:
        schema = {"properties": {}}
        params = {"x": 1}
        out = _autofill_requester_fields(params, schema)
        assert out == {"x": 1}

    def test_does_not_mutate_input(self) -> None:
        schema = {"required": ["patient_ref"], "properties": {"patient_ref": {}}}
        params = {"date": "2026-04-19"}
        original_id = id(params)
        out = _autofill_requester_fields(params, schema)
        # Pure function — returns a new dict.
        assert id(out) != original_id
        assert params == {"date": "2026-04-19"}

    def test_empty_string_value_treated_as_missing(self) -> None:
        # LLM occasionally emits `""` for required fields. Treat as missing.
        schema = {"required": ["patient_ref"], "properties": {"patient_ref": {}}}
        params = {"patient_ref": ""}
        out = _autofill_requester_fields(params, schema)
        assert out == {"patient_ref": "self"}
