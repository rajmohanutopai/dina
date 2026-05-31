"""Unit tests for the responsibility override in the staging pipeline.

Tests the _keeps_sensitive routing matrix and _apply_responsibility_override
logic without requiring a full StagingProcessor (no Core, no LLM).
"""

import pytest

from src.service.staging_processor import StagingProcessor
from src.service.subject_attributor import FactAttribution, SELF_EXPLICIT, KNOWN_CONTACT, UNRESOLVED
from src.service.sensitive_signals import SensitiveHit
from src.service.contact_matcher import MatchedContact


# --- Routing matrix tests ---

class TestKeepsSensitive:
    """Test the _keeps_sensitive static method (routing matrix)."""

    # TRACE: {"suite": "BRAIN", "case": "0540", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "01", "title": "self_health"}
    def test_self_health(self):
        assert StagingProcessor._keeps_sensitive("self", "health") is True

    # TRACE: {"suite": "BRAIN", "case": "0541", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "02", "title": "self_finance"}
    def test_self_finance(self):
        assert StagingProcessor._keeps_sensitive("self", "finance") is True

    # TRACE: {"suite": "BRAIN", "case": "0542", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "03", "title": "household_health"}
    def test_household_health(self):
        assert StagingProcessor._keeps_sensitive("household", "health") is True

    # TRACE: {"suite": "BRAIN", "case": "0543", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "04", "title": "household_finance"}
    def test_household_finance(self):
        assert StagingProcessor._keeps_sensitive("household", "finance") is True

    # TRACE: {"suite": "BRAIN", "case": "0544", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "05", "title": "care_health"}
    def test_care_health(self):
        assert StagingProcessor._keeps_sensitive("care", "health") is True

    # TRACE: {"suite": "BRAIN", "case": "0545", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "06", "title": "care_finance"}
    def test_care_finance(self):
        """care + finance → general (not sensitive)."""
        assert StagingProcessor._keeps_sensitive("care", "finance") is False

    # TRACE: {"suite": "BRAIN", "case": "0546", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "07", "title": "financial_health"}
    def test_financial_health(self):
        """financial + health → general (not sensitive)."""
        assert StagingProcessor._keeps_sensitive("financial", "health") is False

    # TRACE: {"suite": "BRAIN", "case": "0547", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "08", "title": "financial_finance"}
    def test_financial_finance(self):
        assert StagingProcessor._keeps_sensitive("financial", "finance") is True

    # TRACE: {"suite": "BRAIN", "case": "0548", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "09", "title": "external_health"}
    def test_external_health(self):
        assert StagingProcessor._keeps_sensitive("external", "health") is False

    # TRACE: {"suite": "BRAIN", "case": "0549", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "10", "title": "external_finance"}
    def test_external_finance(self):
        assert StagingProcessor._keeps_sensitive("external", "finance") is False

    # TRACE: {"suite": "BRAIN", "case": "0550", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "11", "title": "unresolved_keeps_sensitive"}
    def test_unresolved_keeps_sensitive(self):
        """Unresolved is conservative — keeps sensitive."""
        assert StagingProcessor._keeps_sensitive("unresolved", "health") is True
        assert StagingProcessor._keeps_sensitive("unresolved", "finance") is True


# --- Override logic tests ---

def _make_attr(domain="health", bucket=KNOWN_CONTACT, resp="external", contact_name="Sancho"):
    contact = MatchedContact(
        name=contact_name, did=f"did:plc:{contact_name.lower()}",
        relationship="friend", data_responsibility=resp, span=(0, len(contact_name)),
    )
    hit = SensitiveHit(span=(20, 30), domain=domain, keyword="test", strength="strong")
    return FactAttribution(hit=hit, subject_bucket=bucket, contact=contact, data_responsibility=resp)


def _make_self_attr(domain="health"):
    hit = SensitiveHit(span=(0, 10), domain=domain, keyword="test", strength="strong")
    return FactAttribution(hit=hit, subject_bucket=SELF_EXPLICIT, data_responsibility="self")


def _make_unresolved_attr(domain="health"):
    hit = SensitiveHit(span=(0, 10), domain=domain, keyword="test", strength="strong")
    return FactAttribution(hit=hit, subject_bucket=UNRESOLVED, data_responsibility="unresolved")


class TestApplyResponsibilityOverride:
    """Test _apply_responsibility_override on a minimal StagingProcessor."""

    @pytest.fixture
    def proc(self):
        return StagingProcessor(core=None, enrichment=None)

    # TRACE: {"suite": "BRAIN", "case": "0551", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "12", "title": "external_overrides_to_general"}
    def test_external_overrides_to_general(self, proc):
        attrs = [_make_attr(resp="external")]
        primary, meta = proc._apply_responsibility_override("health", attrs)
        assert primary == "general"

    # TRACE: {"suite": "BRAIN", "case": "0552", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "13", "title": "self_keeps_sensitive"}
    def test_self_keeps_sensitive(self, proc):
        attrs = [_make_self_attr()]
        primary, meta = proc._apply_responsibility_override("health", attrs)
        assert primary == "health"

    # TRACE: {"suite": "BRAIN", "case": "0553", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "14", "title": "household_keeps_sensitive"}
    def test_household_keeps_sensitive(self, proc):
        attrs = [_make_attr(resp="household", contact_name="Emma")]
        primary, meta = proc._apply_responsibility_override("health", attrs)
        assert primary == "health"

    # TRACE: {"suite": "BRAIN", "case": "0554", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "15", "title": "care_keeps_health"}
    def test_care_keeps_health(self, proc):
        attrs = [_make_attr(domain="health", resp="care", contact_name="Mom")]
        primary, meta = proc._apply_responsibility_override("health", attrs)
        assert primary == "health"

    # TRACE: {"suite": "BRAIN", "case": "0555", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "16", "title": "care_overrides_finance"}
    def test_care_overrides_finance(self, proc):
        """care + finance fact → override to general."""
        attrs = [_make_attr(domain="finance", resp="care", contact_name="Mom")]
        primary, meta = proc._apply_responsibility_override("finance", attrs)
        assert primary == "general"

    # TRACE: {"suite": "BRAIN", "case": "0556", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "17", "title": "financial_overrides_health"}
    def test_financial_overrides_health(self, proc):
        """financial + health fact → override to general."""
        attrs = [_make_attr(domain="health", resp="financial", contact_name="Ward")]
        primary, meta = proc._apply_responsibility_override("health", attrs)
        assert primary == "general"

    # TRACE: {"suite": "BRAIN", "case": "0557", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "18", "title": "financial_keeps_finance"}
    def test_financial_keeps_finance(self, proc):
        attrs = [_make_attr(domain="finance", resp="financial", contact_name="Ward")]
        primary, meta = proc._apply_responsibility_override("finance", attrs)
        assert primary == "finance"

    # TRACE: {"suite": "BRAIN", "case": "0558", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "19", "title": "mixed_self_and_external"}
    def test_mixed_self_and_external(self, proc):
        """Self + external → self keeps sensitive."""
        attrs = [_make_self_attr(), _make_attr(resp="external")]
        primary, meta = proc._apply_responsibility_override("health", attrs)
        assert primary == "health"

    # TRACE: {"suite": "BRAIN", "case": "0559", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "20", "title": "unresolved_keeps_with_review_meta"}
    def test_unresolved_keeps_with_review_meta(self, proc):
        """Unresolved → keeps sensitive + routing_meta."""
        attrs = [_make_unresolved_attr()]
        primary, meta = proc._apply_responsibility_override("health", attrs)
        assert primary == "health"
        assert meta is not None
        assert meta["kind"] == "unresolved_subject_ownership"

    # TRACE: {"suite": "BRAIN", "case": "0560", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "21", "title": "non_sensitive_primary_unchanged"}
    def test_non_sensitive_primary_unchanged(self, proc):
        """General/work primary is never overridden."""
        attrs = [_make_attr(resp="external")]
        primary, meta = proc._apply_responsibility_override("general", attrs)
        assert primary == "general"

    # TRACE: {"suite": "BRAIN", "case": "0561", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "03", "scenario": "22", "title": "no_attributions"}
    def test_no_attributions(self, proc):
        primary, meta = proc._apply_responsibility_override("health", [])
        assert primary == "health"
        assert meta is None
