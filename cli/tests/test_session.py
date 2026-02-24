"""Tests for the PII session store."""

from __future__ import annotations

import json

from dina_cli.session import SessionStore


def test_new_id_format():
    store = SessionStore()
    sid = store.new_id()
    assert sid.startswith("sess_")
    assert len(sid) == 13  # "sess_" + 8 hex chars


def test_save_and_load(tmp_path):
    store = SessionStore(base_dir=tmp_path)
    entities = [
        {"Type": "EMAIL", "Value": "john@example.com", "Start": 5, "End": 21},
        {"Type": "PHONE", "Value": "+1-555-0100", "Start": 30, "End": 41},
        {"Type": "EMAIL", "Value": "jane@example.com", "Start": 50, "End": 66},
    ]
    store.save("sess_abc12345", entities)

    loaded = store.load("sess_abc12345")
    assert len(loaded) == 3
    assert loaded[0] == {"token": "[EMAIL_1]", "value": "john@example.com"}
    assert loaded[1] == {"token": "[PHONE_1]", "value": "+1-555-0100"}
    assert loaded[2] == {"token": "[EMAIL_2]", "value": "jane@example.com"}


def test_save_python_style_keys(tmp_path):
    """Accept lowercase keys from Brain's PII response."""
    store = SessionStore(base_dir=tmp_path)
    entities = [
        {"type": "PERSON", "value": "John Doe"},
        {"type": "ORG", "value": "Acme Corp"},
    ]
    store.save("sess_py123456", entities)

    loaded = store.load("sess_py123456")
    assert loaded[0] == {"token": "[PERSON_1]", "value": "John Doe"}
    assert loaded[1] == {"token": "[ORG_1]", "value": "Acme Corp"}


def test_rehydrate(tmp_path):
    store = SessionStore(base_dir=tmp_path)
    entities = [
        {"Type": "PERSON", "Value": "Dr. Sharma", "Start": 0, "End": 10},
        {"Type": "ORG", "Value": "Apollo Hospital", "Start": 14, "End": 29},
    ]
    store.save("sess_rehy1234", entities)

    result = store.rehydrate(
        "[PERSON_1] at [ORG_1] recommends dietary changes",
        "sess_rehy1234",
    )
    assert result == "Dr. Sharma at Apollo Hospital recommends dietary changes"


def test_load_missing_session(tmp_path):
    store = SessionStore(base_dir=tmp_path)
    try:
        store.load("sess_nonexist")
        assert False, "Should have raised FileNotFoundError"
    except FileNotFoundError:
        pass


def test_atomic_write(tmp_path):
    """Verify no .tmp file is left behind after save."""
    store = SessionStore(base_dir=tmp_path)
    store.save("sess_atomic12", [{"Type": "EMAIL", "Value": "a@b.com"}])
    files = list(tmp_path.iterdir())
    assert len(files) == 1
    assert files[0].name == "sess_atomic12.json"
