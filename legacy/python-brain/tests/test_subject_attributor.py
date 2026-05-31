"""Unit tests for SubjectAttributor — per-fact 5-bucket ownership detection."""

import pytest

from src.service.contact_matcher import ContactMatcher
from src.service.subject_attributor import (
    HOUSEHOLD_IMPLICIT,
    KNOWN_CONTACT,
    SELF_EXPLICIT,
    UNKNOWN_THIRD_PARTY,
    UNRESOLVED,
    SubjectAttributor,
)


@pytest.fixture
def contacts():
    return [
        {"name": "Emma", "did": "did:plc:emma", "relationship": "child", "data_responsibility": "household"},
        {"name": "Sancho", "did": "did:plc:sancho", "relationship": "friend", "data_responsibility": "external"},
        {"name": "Mom", "did": "did:plc:mom", "relationship": "parent", "data_responsibility": "external"},
    ]


@pytest.fixture
def attr(contacts):
    return SubjectAttributor(ContactMatcher(contacts))


# --- Single-subject cases ---

# TRACE: {"suite": "BRAIN", "case": "0523", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "02", "scenario": "01", "title": "self_explicit"}
def test_self_explicit(attr):
    """'My blood pressure is high' → self_explicit/health."""
    attrs = attr.attribute("My blood pressure is high")
    assert len(attrs) == 1
    assert attrs[0].subject_bucket == SELF_EXPLICIT
    assert attrs[0].hit.domain == "health"
    assert attrs[0].data_responsibility == "self"


# TRACE: {"suite": "BRAIN", "case": "0524", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "02", "scenario": "02", "title": "known_contact_external"}
def test_known_contact_external(attr):
    """'Sancho has a peanut allergy' → known_contact/external."""
    attrs = attr.attribute("Sancho has a peanut allergy")
    assert len(attrs) == 1
    assert attrs[0].subject_bucket == KNOWN_CONTACT
    assert attrs[0].contact.name == "Sancho"
    assert attrs[0].data_responsibility == "external"


# TRACE: {"suite": "BRAIN", "case": "0525", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "02", "scenario": "03", "title": "known_contact_household"}
def test_known_contact_household(attr):
    """'Emma has a peanut allergy' → known_contact/household."""
    attrs = attr.attribute("Emma has a peanut allergy")
    assert len(attrs) == 1
    assert attrs[0].subject_bucket == KNOWN_CONTACT
    assert attrs[0].contact.name == "Emma"
    assert attrs[0].data_responsibility == "household"


# TRACE: {"suite": "BRAIN", "case": "0526", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "02", "scenario": "04", "title": "household_implicit"}
def test_household_implicit(attr):
    """'My daughter has a peanut allergy' → household_implicit."""
    attrs = attr.attribute("My daughter has a peanut allergy")
    assert len(attrs) == 1
    assert attrs[0].subject_bucket == HOUSEHOLD_IMPLICIT
    assert attrs[0].data_responsibility == "household"


# TRACE: {"suite": "BRAIN", "case": "0527", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "02", "scenario": "05", "title": "unknown_third_party"}
def test_unknown_third_party(attr):
    """'My colleague has migraines' → unknown_third_party."""
    attrs = attr.attribute("My colleague has migraines")
    assert len(attrs) == 1
    assert attrs[0].subject_bucket == UNKNOWN_THIRD_PARTY
    assert attrs[0].data_responsibility == "external"


# TRACE: {"suite": "BRAIN", "case": "0528", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "02", "scenario": "06", "title": "unresolved_pronoun"}
def test_unresolved_pronoun(attr):
    """'He has allergies' → unresolved."""
    attrs = attr.attribute("He has allergies")
    assert len(attrs) == 1
    assert attrs[0].subject_bucket == UNRESOLVED
    assert attrs[0].data_responsibility == "unresolved"


# --- Non-sensitive cases ---

# TRACE: {"suite": "BRAIN", "case": "0529", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "02", "scenario": "07", "title": "no_sensitive_signal"}
def test_no_sensitive_signal(attr):
    """'Sancho likes cold brew coffee' → no hits."""
    attrs = attr.attribute("Sancho likes cold brew coffee")
    assert len(attrs) == 0


# TRACE: {"suite": "BRAIN", "case": "0530", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "02", "scenario": "08", "title": "empty_text"}
def test_empty_text(attr):
    assert attr.attribute("") == []


# --- Multi-fact cases ---

# TRACE: {"suite": "BRAIN", "case": "0531", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "02", "scenario": "09", "title": "multi_fact_different_subjects"}
def test_multi_fact_different_subjects(attr):
    """'Emma has allergies and Sancho owes taxes' → two attributions."""
    attrs = attr.attribute("Emma has allergies and Sancho owes taxes")
    assert len(attrs) == 2
    domains = {a.hit.domain for a in attrs}
    assert "health" in domains
    assert "finance" in domains

    emma_attr = [a for a in attrs if a.contact and a.contact.name == "Emma"]
    sancho_attr = [a for a in attrs if a.contact and a.contact.name == "Sancho"]
    assert len(emma_attr) == 1
    assert emma_attr[0].data_responsibility == "household"
    assert len(sancho_attr) == 1
    assert sancho_attr[0].data_responsibility == "external"


# TRACE: {"suite": "BRAIN", "case": "0532", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "02", "scenario": "10", "title": "self_and_external_same_sentence"}
def test_self_and_external_in_same_sentence(attr):
    """'My blood pressure is high and Sancho has allergies' → self + external."""
    attrs = attr.attribute("My blood pressure is high and Sancho has allergies")
    assert len(attrs) == 2
    buckets = {a.subject_bucket for a in attrs}
    assert SELF_EXPLICIT in buckets
    assert KNOWN_CONTACT in buckets


# TRACE: {"suite": "BRAIN", "case": "0533", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "02", "scenario": "11", "title": "coordinated_subjects_single_hit"}
def test_coordinated_subjects_single_hit(attr):
    """'Emma and Sancho have allergies' → two attributions for one hit."""
    attrs = attr.attribute("Emma and Sancho have allergies")
    assert len(attrs) == 2
    names = {a.contact.name for a in attrs if a.contact}
    assert names == {"Emma", "Sancho"}


# TRACE: {"suite": "BRAIN", "case": "0534", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "02", "scenario": "12", "title": "coordinated_later_fact_not_leaked"}
def test_coordinated_subjects_later_fact_not_leaked(attr):
    """'Emma and Sancho have allergies, but Sancho owes taxes'
    → taxes should only be attributed to Sancho, NOT Emma."""
    attrs = attr.attribute("Emma and Sancho have allergies, but Sancho owes taxes")
    finance_attrs = [a for a in attrs if a.hit.domain == "finance"]
    assert len(finance_attrs) == 1
    assert finance_attrs[0].contact.name == "Sancho"
    assert finance_attrs[0].data_responsibility == "external"


# --- Pronoun carry-forward ---

# TRACE: {"suite": "BRAIN", "case": "0535", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "02", "scenario": "13", "title": "pronoun_carry_forward"}
def test_pronoun_carry_forward(attr):
    """'Mom blood pressure is high and her insurance premium is due'
    → both facts attributed to Mom (external)."""
    attrs = attr.attribute("Mom blood pressure is high and her insurance premium is due")
    assert len(attrs) >= 2
    for a in attrs:
        if a.contact:
            assert a.contact.name == "Mom"
            assert a.data_responsibility == "external"


# --- No-subject rule ---

# TRACE: {"suite": "BRAIN", "case": "0536", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "02", "scenario": "14", "title": "no_subject_personal_state"}
def test_no_subject_with_personal_state(attr):
    """'Blood pressure is 130/85' → self_explicit (personal state pattern)."""
    attrs = attr.attribute("Blood pressure is 130/85")
    assert len(attrs) == 1
    assert attrs[0].subject_bucket == SELF_EXPLICIT


# TRACE: {"suite": "BRAIN", "case": "0537", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "02", "scenario": "15", "title": "no_subject_topical"}
def test_no_subject_topical(attr):
    """'Hospital changed visitor policy' → unresolved (topical)."""
    attrs = attr.attribute("Hospital changed visitor policy")
    assert len(attrs) == 1
    assert attrs[0].subject_bucket == UNRESOLVED


# TRACE: {"suite": "BRAIN", "case": "0538", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "02", "scenario": "16", "title": "unknown_proper_name"}
def test_unknown_proper_name(attr):
    """'John has diabetes' → unresolved (unknown name, deterministic)."""
    attrs = attr.attribute("John has diabetes")
    assert len(attrs) == 1
    assert attrs[0].subject_bucket == UNRESOLVED


# --- Parent default ---

# TRACE: {"suite": "BRAIN", "case": "0539", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "02", "scenario": "17", "title": "parent_role_phrase"}
def test_parent_role_phrase(attr):
    """'My mother blood pressure is high' → unknown_third_party."""
    attrs = attr.attribute("My mother blood pressure is high")
    assert len(attrs) == 1
    assert attrs[0].subject_bucket == UNKNOWN_THIRD_PARTY
    assert attrs[0].data_responsibility == "external"
