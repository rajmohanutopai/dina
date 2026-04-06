"""Tests for contact alias support across the full Brain pipeline.

Covers:
  - ContactMatcher: alias matching, name+alias dedup, longest-first
  - SubjectAttributor: alias wins over kinship, precedence rules
  - Staging override: alias-routed responsibility applied correctly
  - Recall hints: alias hints injected only for mentioned contacts
"""

import pytest

from src.service.contact_matcher import ContactMatcher, MatchedContact
from src.service.subject_attributor import (
    HOUSEHOLD_IMPLICIT,
    KNOWN_CONTACT,
    SELF_EXPLICIT,
    UNKNOWN_THIRD_PARTY,
    UNRESOLVED,
    SubjectAttributor,
)
from src.service.staging_processor import StagingProcessor
from src.service.subject_attributor import FactAttribution
from src.service.sensitive_signals import SensitiveHit


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

CONTACTS_WITH_ALIASES = [
    {"name": "Emma", "did": "did:plc:emma", "relationship": "child",
     "data_responsibility": "household", "aliases": ["my daughter", "my kid", "Em"]},
    {"name": "Sancho", "did": "did:plc:sancho", "relationship": "friend",
     "data_responsibility": "external", "aliases": ["my buddy"]},
    {"name": "Mom", "did": "did:plc:mom", "relationship": "parent",
     "data_responsibility": "external", "aliases": ["my mother"]},
    {"name": "Sarah", "did": "did:plc:sarah", "relationship": "spouse",
     "data_responsibility": "household", "aliases": ["my wife"]},
]

CONTACTS_NO_ALIASES = [
    {"name": "Emma", "did": "did:plc:emma", "relationship": "child",
     "data_responsibility": "household", "aliases": []},
    {"name": "Sancho", "did": "did:plc:sancho", "relationship": "friend",
     "data_responsibility": "external", "aliases": []},
]


@pytest.fixture
def matcher():
    return ContactMatcher(CONTACTS_WITH_ALIASES)


@pytest.fixture
def attr():
    return SubjectAttributor(ContactMatcher(CONTACTS_WITH_ALIASES))


@pytest.fixture
def attr_no_aliases():
    return SubjectAttributor(ContactMatcher(CONTACTS_NO_ALIASES))


# =========================================================================
# ContactMatcher: alias matching
# =========================================================================

class TestContactMatcherAliases:

    # TRACE: {"suite": "BRAIN", "case": "0562", "section": "26", "sectionName": "Contact Alias Support", "subsection": "01", "scenario": "01", "title": "alias_match_returns_contact_did"}
    def test_alias_match_returns_contact_did(self, matcher):
        """'my daughter' alias resolves to Emma's DID."""
        mentions = matcher.find_mentions("my daughter has allergies")
        assert len(mentions) == 1
        assert mentions[0].did == "did:plc:emma"
        assert mentions[0].name == "Emma"

    # TRACE: {"suite": "BRAIN", "case": "0563", "section": "26", "sectionName": "Contact Alias Support", "subsection": "01", "scenario": "02", "title": "multiple_aliases_same_contact"}
    def test_multiple_aliases_same_contact(self, matcher):
        """Both 'my daughter' and 'my kid' resolve to Emma."""
        m1 = matcher.find_mentions("my daughter likes books")
        m2 = matcher.find_mentions("my kid likes books")
        assert m1[0].did == m2[0].did == "did:plc:emma"

    # TRACE: {"suite": "BRAIN", "case": "0564", "section": "26", "sectionName": "Contact Alias Support", "subsection": "01", "scenario": "03", "title": "name_and_alias_in_same_text"}
    def test_name_and_alias_in_same_text(self, matcher):
        """'Emma' and 'my daughter' in same text → two mentions, same DID."""
        mentions = matcher.find_mentions("Emma is my daughter")
        assert len(mentions) == 2
        assert all(m.did == "did:plc:emma" for m in mentions)

    # TRACE: {"suite": "BRAIN", "case": "0565", "section": "26", "sectionName": "Contact Alias Support", "subsection": "01", "scenario": "04", "title": "alias_longest_match_first"}
    def test_alias_longest_match_first(self, matcher):
        """'my mother' should match Mom's alias, not partial 'my'."""
        mentions = matcher.find_mentions("my mother has high blood pressure")
        mom_mentions = [m for m in mentions if m.did == "did:plc:mom"]
        assert len(mom_mentions) == 1
        assert mom_mentions[0].name == "Mom"

    # TRACE: {"suite": "BRAIN", "case": "0566", "section": "26", "sectionName": "Contact Alias Support", "subsection": "01", "scenario": "05", "title": "alias_carries_responsibility"}
    def test_alias_carries_responsibility(self, matcher):
        """Alias match carries the contact's data_responsibility."""
        mentions = matcher.find_mentions("my daughter has allergies")
        assert mentions[0].data_responsibility == "household"

        mentions2 = matcher.find_mentions("my buddy has allergies")
        assert mentions2[0].data_responsibility == "external"

    # TRACE: {"suite": "BRAIN", "case": "0567", "section": "26", "sectionName": "Contact Alias Support", "subsection": "01", "scenario": "06", "title": "short_alias_word_boundary"}
    def test_short_alias_word_boundary(self, matcher):
        """Short alias 'Em' should not match inside 'Emergency'."""
        mentions = matcher.find_mentions("Emergency room visit")
        emma_mentions = [m for m in mentions if m.did == "did:plc:emma"]
        assert len(emma_mentions) == 0

    # TRACE: {"suite": "BRAIN", "case": "0568", "section": "26", "sectionName": "Contact Alias Support", "subsection": "01", "scenario": "07", "title": "short_alias_standalone"}
    def test_short_alias_standalone(self, matcher):
        """Short alias 'Em' should match when standalone."""
        mentions = matcher.find_mentions("Em has a cold")
        assert len(mentions) >= 1
        assert any(m.did == "did:plc:emma" for m in mentions)

    # TRACE: {"suite": "BRAIN", "case": "0569", "section": "26", "sectionName": "Contact Alias Support", "subsection": "01", "scenario": "08", "title": "alias_case_insensitive"}
    def test_alias_case_insensitive(self, matcher):
        """Alias matching is case-insensitive."""
        mentions = matcher.find_mentions("MY DAUGHTER has allergies")
        assert len(mentions) == 1
        assert mentions[0].did == "did:plc:emma"

    # TRACE: {"suite": "BRAIN", "case": "0570", "section": "26", "sectionName": "Contact Alias Support", "subsection": "01", "scenario": "09", "title": "contact_without_aliases"}
    def test_contact_without_aliases(self):
        """Contacts with empty aliases list → only name matches."""
        matcher = ContactMatcher(CONTACTS_NO_ALIASES)
        mentions = matcher.find_mentions("my daughter has allergies")
        # No alias registered → no match on "my daughter"
        emma_mentions = [m for m in mentions if m.did == "did:plc:emma"]
        assert len(emma_mentions) == 0

    # TRACE: {"suite": "BRAIN", "case": "0571", "section": "26", "sectionName": "Contact Alias Support", "subsection": "01", "scenario": "10", "title": "overlapping_alias_and_name_dedup"}
    def test_overlapping_alias_and_name_dedup(self, matcher):
        """If alias span overlaps with name, longer match wins."""
        # "my wife" is Sarah's alias. "Sarah" is her name.
        mentions = matcher.find_mentions("my wife Sarah said hello")
        dids = [m.did for m in mentions]
        # Both should match but as separate spans (non-overlapping).
        assert dids.count("did:plc:sarah") == 2


# =========================================================================
# SubjectAttributor: alias precedence over kinship
# =========================================================================

class TestSubjectAttributorAliasPrecedence:

    # TRACE: {"suite": "BRAIN", "case": "0572", "section": "26", "sectionName": "Contact Alias Support", "subsection": "02", "scenario": "01", "title": "alias_wins_over_kinship"}
    def test_alias_wins_over_kinship(self, attr):
        """'my daughter has allergy' → known_contact (Emma) not household_implicit."""
        attrs = attr.attribute("my daughter has a peanut allergy")
        assert len(attrs) == 1
        assert attrs[0].subject_bucket == KNOWN_CONTACT
        assert attrs[0].contact is not None
        assert attrs[0].contact.name == "Emma"
        assert attrs[0].data_responsibility == "household"

    # TRACE: {"suite": "BRAIN", "case": "0573", "section": "26", "sectionName": "Contact Alias Support", "subsection": "02", "scenario": "02", "title": "alias_wins_over_kinship_kid"}
    def test_alias_wins_over_kinship_kid(self, attr):
        """'my kid has allergy' → known_contact (Emma)."""
        attrs = attr.attribute("my kid has a peanut allergy")
        assert len(attrs) == 1
        assert attrs[0].subject_bucket == KNOWN_CONTACT
        assert attrs[0].contact.name == "Emma"

    # TRACE: {"suite": "BRAIN", "case": "0574", "section": "26", "sectionName": "Contact Alias Support", "subsection": "02", "scenario": "03", "title": "mother_alias_wins_over_role"}
    def test_mother_alias_wins_over_role_pattern(self, attr):
        """'my mother has high blood pressure' → known_contact (Mom, external)."""
        attrs = attr.attribute("my mother has high blood pressure")
        assert len(attrs) == 1
        assert attrs[0].subject_bucket == KNOWN_CONTACT
        assert attrs[0].contact.name == "Mom"
        assert attrs[0].data_responsibility == "external"

    # TRACE: {"suite": "BRAIN", "case": "0575", "section": "26", "sectionName": "Contact Alias Support", "subsection": "02", "scenario": "04", "title": "wife_alias_wins_over_kinship"}
    def test_wife_alias_wins_over_kinship(self, attr):
        """'my wife has allergies' → known_contact (Sarah, household)."""
        attrs = attr.attribute("my wife has allergies")
        assert len(attrs) == 1
        assert attrs[0].subject_bucket == KNOWN_CONTACT
        assert attrs[0].contact.name == "Sarah"
        assert attrs[0].data_responsibility == "household"

    # TRACE: {"suite": "BRAIN", "case": "0576", "section": "26", "sectionName": "Contact Alias Support", "subsection": "02", "scenario": "05", "title": "kinship_fallback_no_alias"}
    def test_kinship_fallback_when_no_alias(self, attr_no_aliases):
        """Without aliases, 'my daughter' → household_implicit (fallback)."""
        attrs = attr_no_aliases.attribute("my daughter has a peanut allergy")
        assert len(attrs) == 1
        assert attrs[0].subject_bucket == HOUSEHOLD_IMPLICIT

    # TRACE: {"suite": "BRAIN", "case": "0577", "section": "26", "sectionName": "Contact Alias Support", "subsection": "02", "scenario": "06", "title": "unmatched_role_stays_third_party"}
    def test_unmatched_role_stays_third_party(self, attr):
        """'my colleague has migraines' → unknown_third_party (no alias for colleague)."""
        attrs = attr.attribute("my colleague has migraines")
        assert len(attrs) == 1
        assert attrs[0].subject_bucket == UNKNOWN_THIRD_PARTY

    # TRACE: {"suite": "BRAIN", "case": "0578", "section": "26", "sectionName": "Contact Alias Support", "subsection": "02", "scenario": "07", "title": "mixed_alias_and_name"}
    def test_mixed_alias_and_name(self, attr):
        """'Emma and my buddy have allergies' → Emma(household) + Sancho(external)."""
        attrs = attr.attribute("Emma and my buddy have allergies")
        assert len(attrs) == 2
        emma = [a for a in attrs if a.contact and a.contact.name == "Emma"]
        sancho = [a for a in attrs if a.contact and a.contact.name == "Sancho"]
        assert len(emma) == 1
        assert emma[0].data_responsibility == "household"
        assert len(sancho) == 1
        assert sancho[0].data_responsibility == "external"


# =========================================================================
# Staging override: alias-routed responsibility
# =========================================================================

class TestStagingOverrideWithAliases:

    @pytest.fixture
    def proc(self):
        return StagingProcessor(core=None, enrichment=None)

    def _make_attr(self, resp, domain="health", name="test"):
        contact = MatchedContact(
            name=name, did=f"did:plc:{name.lower()}",
            relationship="friend", data_responsibility=resp, span=(0, len(name)),
        )
        hit = SensitiveHit(span=(20, 30), domain=domain, keyword="test", strength="strong")
        return FactAttribution(hit=hit, subject_bucket=KNOWN_CONTACT, contact=contact, data_responsibility=resp)

    # TRACE: {"suite": "BRAIN", "case": "0579", "section": "26", "sectionName": "Contact Alias Support", "subsection": "03", "scenario": "01", "title": "alias_household_keeps_health"}
    def test_alias_household_keeps_health(self, proc):
        """Alias-matched household contact → health stays."""
        attrs = [self._make_attr("household", name="Emma")]
        primary, _ = proc._apply_responsibility_override("health", attrs, "")
        assert primary == "health"

    # TRACE: {"suite": "BRAIN", "case": "0580", "section": "26", "sectionName": "Contact Alias Support", "subsection": "03", "scenario": "02", "title": "alias_external_overrides"}
    def test_alias_external_overrides_to_general(self, proc):
        """Alias-matched external contact → health overridden to general."""
        attrs = [self._make_attr("external", name="Sancho")]
        primary, _ = proc._apply_responsibility_override("health", attrs, "")
        assert primary == "general"

    # TRACE: {"suite": "BRAIN", "case": "0581", "section": "26", "sectionName": "Contact Alias Support", "subsection": "03", "scenario": "03", "title": "alias_mother_external"}
    def test_alias_mother_external_overrides(self, proc):
        """Mom matched via alias, external responsibility → general."""
        attrs = [self._make_attr("external", name="Mom")]
        primary, _ = proc._apply_responsibility_override("health", attrs, "")
        assert primary == "general"

    # TRACE: {"suite": "BRAIN", "case": "0582", "section": "26", "sectionName": "Contact Alias Support", "subsection": "03", "scenario": "04", "title": "alias_wife_household_keeps"}
    def test_alias_wife_household_keeps(self, proc):
        """Sarah matched via alias 'my wife', household → health stays."""
        attrs = [self._make_attr("household", name="Sarah")]
        primary, _ = proc._apply_responsibility_override("health", attrs, "")
        assert primary == "health"

    # TRACE: {"suite": "BRAIN", "case": "0583", "section": "26", "sectionName": "Contact Alias Support", "subsection": "03", "scenario": "05", "title": "mixed_alias_household_external"}
    def test_mixed_alias_household_and_external(self, proc):
        """Emma(household) + Sancho(external) → household keeps, overall stays health."""
        attrs = [
            self._make_attr("household", name="Emma"),
            self._make_attr("external", name="Sancho"),
        ]
        primary, _ = proc._apply_responsibility_override("health", attrs, "")
        assert primary == "health"


# =========================================================================
# Recall hints: end-to-end via VaultContextAssembler
# =========================================================================

class TestAliasRecallHints:
    """Tested in test_vault_context.py — cross-referenced here for completeness.

    See:
      test_reason_injects_alias_hints_for_mentioned_contact
      test_reason_no_alias_leak_for_unmentioned_contacts
    """

    # TRACE: {"suite": "BRAIN", "case": "0584", "section": "26", "sectionName": "Contact Alias Support", "subsection": "04", "scenario": "01", "title": "build_hints_from_contacts"}
    def test_build_hints_from_contacts(self):
        """ContactMatcher-based hint building returns only mentioned contacts."""
        matcher = ContactMatcher(CONTACTS_WITH_ALIASES)
        mentions = matcher.find_mentions("What does Emma like?")
        mentioned_dids = {m.did for m in mentions}

        hints = []
        for c in CONTACTS_WITH_ALIASES:
            if c.get("did") in mentioned_dids and c.get("aliases"):
                hints.append({"name": c["name"], "aliases": c["aliases"]})

        assert len(hints) == 1
        assert hints[0]["name"] == "Emma"
        assert "my daughter" in hints[0]["aliases"]

    # TRACE: {"suite": "BRAIN", "case": "0585", "section": "26", "sectionName": "Contact Alias Support", "subsection": "04", "scenario": "02", "title": "alias_mention_triggers_hints"}
    def test_alias_mention_triggers_hints(self):
        """Mentioning an alias triggers hints for the parent contact."""
        matcher = ContactMatcher(CONTACTS_WITH_ALIASES)
        mentions = matcher.find_mentions("What does my daughter like?")
        mentioned_dids = {m.did for m in mentions}
        assert "did:plc:emma" in mentioned_dids

    # TRACE: {"suite": "BRAIN", "case": "0586", "section": "26", "sectionName": "Contact Alias Support", "subsection": "04", "scenario": "03", "title": "no_hints_for_unmentioned"}
    def test_no_hints_for_unmentioned(self):
        """No contact mentioned → empty hints."""
        matcher = ContactMatcher(CONTACTS_WITH_ALIASES)
        mentions = matcher.find_mentions("What is the weather?")
        assert len(mentions) == 0
