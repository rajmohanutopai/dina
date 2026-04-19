"""Unit tests for PreferenceExtractor.

Traces to TEST_PLAN §29.8 (Preference Extraction at Ingest).
Regex-based extractor surfaces "my <role> <Name>"-style user
assertions from stored text so the staging processor can auto-update
the matched contact's preferred_for list. No LLM, no I/O — pure
function-under-test.
"""
from __future__ import annotations

from src.service.preference_extractor import PreferenceExtractor


class TestDirectPattern:
    # TST-BRAIN-890 — direct form: "my <role> <Name>"
    def test_direct_form(self) -> None:
        ext = PreferenceExtractor()
        out = ext.extract("My dentist Dr Carl is on April 19")
        assert len(out) == 1
        assert out[0].role == "dentist"
        assert out[0].name == "Dr Carl"
        assert out[0].categories == ("dental",)

    def test_direct_title_dot(self) -> None:
        ext = PreferenceExtractor()
        out = ext.extract("My dentist Dr. Carl Jones has an opening")
        assert out[0].name == "Dr. Carl Jones"

    def test_direct_firstname_only(self) -> None:
        ext = PreferenceExtractor()
        out = ext.extract("My accountant Linda handles everything")
        assert out[0].name == "Linda"
        assert out[0].categories == ("tax", "accounting")

    def test_stops_before_lowercase_verb(self) -> None:
        """Regex must anchor on capitalised name tokens so it doesn't
        greedily grab trailing lowercase words (classic IGNORECASE trap).
        """
        ext = PreferenceExtractor()
        out = ext.extract("My dentist Dr Carl is on April 19 at 3pm")
        # Name should be "Dr Carl", not "Dr Carl is on April 19 at 3pm".
        assert out[0].name == "Dr Carl"


class TestIsPattern:
    # TST-BRAIN-891 — "my <role> is <Name>"
    def test_is_form(self) -> None:
        ext = PreferenceExtractor()
        out = ext.extract("My dentist is Dr Carl")
        # Direct + is pattern both match; the name must be the same, so
        # dedup collapses them into a single candidate.
        assert len(out) == 1
        assert out[0].role == "dentist"
        assert out[0].name == "Dr Carl"

    def test_is_form_firstname(self) -> None:
        ext = PreferenceExtractor()
        out = ext.extract("my accountant is Linda Smith")
        # Dedup keeps one entry whose name is "Linda Smith" (the longer,
        # more informative match from the `is` pattern).
        assert len(out) == 1
        assert out[0].name == "Linda Smith"


class TestRoleCoverage:
    # TST-BRAIN-892 — multiple roles + case-insensitivity
    def test_various_professions(self) -> None:
        ext = PreferenceExtractor()
        roles = {
            "My mechanic Pete took the car": ("mechanic", "Pete", ("automotive",)),
            "my lawyer Kate Jones": ("lawyer", "Kate Jones", ("legal",)),
            "My physio Dr Patel works miracles": ("physio", "Dr Patel", ("physiotherapy",)),
            "my trainer Aaron says so": ("trainer", "Aaron", ("fitness",)),
        }
        for text, (role, name, cats) in roles.items():
            out = ext.extract(text)
            assert out, f"no match for: {text!r}"
            assert out[0].role == role
            assert out[0].name == name
            assert out[0].categories == cats

    def test_case_insensitive_role(self) -> None:
        ext = PreferenceExtractor()
        out = ext.extract("My THERAPIST is Jane Smith")
        assert out[0].role == "therapist"
        assert out[0].categories == ("mental_health",)

    def test_two_word_word_before_role_does_not_match(self) -> None:
        """'dentistry' must not fire for role=dentist."""
        ext = PreferenceExtractor()
        out = ext.extract("Just some dentistry stuff, nothing to see here")
        assert out == []


class TestDedup:
    # TST-BRAIN-893 — same (role, name) appearing twice only counted once
    def test_deduplicates_same_binding(self) -> None:
        ext = PreferenceExtractor()
        out = ext.extract("My dentist Dr Carl. I also saw my dentist Dr Carl yesterday.")
        assert len(out) == 1
        assert out[0].name == "Dr Carl"

    def test_different_bindings_preserved(self) -> None:
        ext = PreferenceExtractor()
        out = ext.extract("My dentist Dr Carl and my lawyer Kate Jones both rock.")
        names = sorted(c.name for c in out)
        assert names == ["Dr Carl", "Kate Jones"]


class TestNoMatch:
    def test_empty_text(self) -> None:
        assert PreferenceExtractor().extract("") == []

    def test_none_text(self) -> None:
        assert PreferenceExtractor().extract(None) == []  # type: ignore[arg-type]

    def test_unknown_role(self) -> None:
        ext = PreferenceExtractor()
        # "florist" IS a known role, but "gazillionaire" is not.
        out = ext.extract("My gazillionaire friend Bob")
        assert out == []

    def test_no_name_after_role(self) -> None:
        ext = PreferenceExtractor()
        # No capitalised word follows the role.
        out = ext.extract("my dentist is brilliant")
        assert out == []


class TestDiagnostics:
    def test_known_roles_sorted(self) -> None:
        ext = PreferenceExtractor()
        roles = ext.known_roles
        assert "dentist" in roles
        assert "lawyer" in roles
        # Sorted, so tests can lock-in the set without ordering drift.
        assert list(roles) == sorted(roles)

    def test_categories_for_role(self) -> None:
        ext = PreferenceExtractor()
        assert ext.categories_for_role("dentist") == ("dental",)
        assert ext.categories_for_role("DENTIST") == ("dental",)  # case-insensitive
        assert ext.categories_for_role("accountant") == ("tax", "accounting")
        assert ext.categories_for_role("nonsense") == ()
