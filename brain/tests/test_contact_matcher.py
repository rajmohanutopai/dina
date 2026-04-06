"""Unit tests for ContactMatcher — name-only mention detection."""

import pytest

from src.service.contact_matcher import ContactMatcher


@pytest.fixture
def contacts():
    return [
        {"name": "Emma", "did": "did:plc:emma", "relationship": "child", "data_responsibility": "household"},
        {"name": "Sancho", "did": "did:plc:sancho", "relationship": "friend", "data_responsibility": "external"},
        {"name": "Mary Jane", "did": "did:plc:mj", "relationship": "friend", "data_responsibility": "external"},
        {"name": "Jo", "did": "did:plc:jo", "relationship": "friend", "data_responsibility": "external"},
        {"name": "John", "did": "did:plc:john", "relationship": "colleague", "data_responsibility": "external"},
    ]


@pytest.fixture
def matcher(contacts):
    return ContactMatcher(contacts)


# TRACE: {"suite": "BRAIN", "case": "0512", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "01", "scenario": "01", "title": "basic_match"}
def test_basic_match(matcher):
    mentions = matcher.find_mentions("Sancho has allergies")
    assert len(mentions) == 1
    assert mentions[0].name == "Sancho"
    assert mentions[0].data_responsibility == "external"


# TRACE: {"suite": "BRAIN", "case": "0513", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "01", "scenario": "02", "title": "case_insensitive"}
def test_case_insensitive(matcher):
    mentions = matcher.find_mentions("sancho likes coffee")
    assert len(mentions) == 1
    assert mentions[0].name == "Sancho"


# TRACE: {"suite": "BRAIN", "case": "0514", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "01", "scenario": "03", "title": "no_match"}
def test_no_match(matcher):
    mentions = matcher.find_mentions("Dave likes pizza")
    assert len(mentions) == 0


# TRACE: {"suite": "BRAIN", "case": "0515", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "01", "scenario": "04", "title": "multi_contact"}
def test_multi_contact(matcher):
    mentions = matcher.find_mentions("Emma and Sancho have allergies")
    assert len(mentions) == 2
    names = {m.name for m in mentions}
    assert names == {"Emma", "Sancho"}


# TRACE: {"suite": "BRAIN", "case": "0516", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "01", "scenario": "05", "title": "longest_first"}
def test_longest_first(matcher):
    """'Mary Jane' should match before 'Jo' would partially match inside it."""
    mentions = matcher.find_mentions("Mary Jane has allergies")
    assert len(mentions) == 1
    assert mentions[0].name == "Mary Jane"


# TRACE: {"suite": "BRAIN", "case": "0517", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "01", "scenario": "06", "title": "word_boundary"}
def test_word_boundary(matcher):
    """'Jo' should NOT match inside 'John'."""
    mentions = matcher.find_mentions("John has migraines")
    assert len(mentions) == 1
    assert mentions[0].name == "John"


# TRACE: {"suite": "BRAIN", "case": "0518", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "01", "scenario": "07", "title": "dedup_same_contact_twice"}
def test_dedup_same_contact_twice(matcher):
    """Same contact mentioned twice → two separate mentions."""
    mentions = matcher.find_mentions("Emma likes dinosaurs and Emma has allergies")
    assert len(mentions) == 2
    assert all(m.name == "Emma" for m in mentions)


# TRACE: {"suite": "BRAIN", "case": "0519", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "01", "scenario": "08", "title": "span_positions"}
def test_span_positions(matcher):
    text = "Sancho has allergies"
    mentions = matcher.find_mentions(text)
    assert mentions[0].span == (0, 6)
    assert text[mentions[0].span[0]:mentions[0].span[1]] == "Sancho"


# TRACE: {"suite": "BRAIN", "case": "0520", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "01", "scenario": "09", "title": "min_name_length"}
def test_min_name_length():
    """Names shorter than 2 chars should be ignored."""
    matcher = ContactMatcher([
        {"name": "A", "did": "did:plc:a", "relationship": "friend", "data_responsibility": "external"},
    ])
    assert matcher.find_mentions("A has problems") == []


# TRACE: {"suite": "BRAIN", "case": "0521", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "01", "scenario": "10", "title": "empty_contacts"}
def test_empty_contacts():
    matcher = ContactMatcher([])
    assert matcher.find_mentions("Hello world") == []


# TRACE: {"suite": "BRAIN", "case": "0522", "section": "25", "sectionName": "Contact Relationship & Responsibility-Aware Routing", "subsection": "01", "scenario": "11", "title": "empty_text"}
def test_empty_text(matcher):
    assert matcher.find_mentions("") == []
