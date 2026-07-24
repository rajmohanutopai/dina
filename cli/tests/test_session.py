"""Tests for the PII session store."""

from __future__ import annotations

import os
import time

import pytest

from dina_cli import config as config_mod
from dina_cli.session import SessionStore


# TST-CLI-047
# TRACE: {"suite": "CLI", "case": "0047", "section": "05", "sectionName": "Session", "subsection": "01", "scenario": "01", "title": "new_id_format"}
def test_new_id_format():
    store = SessionStore()
    sid = store.new_id()
    assert sid.startswith("pii_")
    assert len(sid) == 36  # "pii_" + 32 hex chars


def test_default_store_follows_active_cli_config(monkeypatch, tmp_path):
    monkeypatch.setattr(config_mod, "CONFIG_DIR", tmp_path / "instance-b")
    store = SessionStore()
    store.save("pii_deadbeef", [{"type": "EMAIL", "value": "a@b.com"}])

    assert (tmp_path / "instance-b" / "sessions" / "pii_deadbeef.json").is_file()


# TST-CLI-048
# TRACE: {"suite": "CLI", "case": "0048", "section": "05", "sectionName": "Session", "subsection": "01", "scenario": "02", "title": "save_and_load"}
def test_save_and_load(tmp_path):
    store = SessionStore(base_dir=tmp_path)
    entities = [
        {"type": "EMAIL", "value": "john@example.com", "start": 5, "end": 21},
        {"type": "PHONE", "value": "+1-555-0100", "start": 30, "end": 41},
        {"type": "EMAIL", "value": "jane@example.com", "start": 50, "end": 66},
    ]
    store.save("sess_abc12345", entities)

    loaded = store.load("sess_abc12345")
    assert len(loaded) == 3
    assert loaded[0] == {"token": "[EMAIL_1]", "value": "john@example.com"}
    assert loaded[1] == {"token": "[PHONE_1]", "value": "+1-555-0100"}
    assert loaded[2] == {"token": "[EMAIL_2]", "value": "jane@example.com"}


# TST-CLI-049
# TRACE: {"suite": "CLI", "case": "0049", "section": "05", "sectionName": "Session", "subsection": "01", "scenario": "03", "title": "save_python_style_keys"}
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


# TST-CLI-050
# TRACE: {"suite": "CLI", "case": "0050", "section": "05", "sectionName": "Session", "subsection": "01", "scenario": "04", "title": "rehydrate"}
def test_rehydrate(tmp_path):
    store = SessionStore(base_dir=tmp_path)
    entities = [
        {"type": "PERSON", "value": "Dr. Sharma", "start": 0, "end": 10},
        {"type": "ORG", "value": "Apollo Hospital", "start": 14, "end": 29},
    ]
    store.save("sess_rehy1234", entities)

    result = store.rehydrate(
        "[PERSON_1] at [ORG_1] recommends dietary changes",
        "sess_rehy1234",
    )
    assert result == "Dr. Sharma at Apollo Hospital recommends dietary changes"


def test_rehydrate_can_consume_sensitive_mapping(tmp_path):
    store = SessionStore(base_dir=tmp_path)
    store.save("pii_deadbeef", [{"type": "EMAIL", "value": "a@b.com"}])

    assert store.rehydrate("[EMAIL_1]", "pii_deadbeef", consume=True) == "a@b.com"
    with pytest.raises(FileNotFoundError):
        store.load("pii_deadbeef")


def test_expired_mapping_is_deleted(tmp_path):
    store = SessionStore(base_dir=tmp_path, ttl_seconds=1)
    store.save("pii_deadbeef", [{"type": "EMAIL", "value": "a@b.com"}])
    path = tmp_path / "pii_deadbeef.json"
    old = time.time() - 2
    os.utime(path, (old, old))

    with pytest.raises(FileNotFoundError, match="expired"):
        store.load("pii_deadbeef")
    assert not path.exists()


@pytest.mark.parametrize("session_id", ["../config", "a/b", "", " "])
def test_session_id_cannot_escape_store(tmp_path, session_id):
    store = SessionStore(base_dir=tmp_path)
    with pytest.raises(ValueError, match="invalid PII session id"):
        store.load(session_id)


# TST-CLI-051
# TRACE: {"suite": "CLI", "case": "0051", "section": "05", "sectionName": "Session", "subsection": "01", "scenario": "05", "title": "load_missing_session"}
def test_load_missing_session(tmp_path):
    store = SessionStore(base_dir=tmp_path)
    try:
        store.load("sess_nonexist")
        assert False, "Should have raised FileNotFoundError"
    except FileNotFoundError:
        pass


# TST-CLI-052
# TRACE: {"suite": "CLI", "case": "0052", "section": "05", "sectionName": "Session", "subsection": "01", "scenario": "06", "title": "atomic_write"}
def test_atomic_write(tmp_path):
    """Verify no .tmp file is left behind after save."""
    store = SessionStore(base_dir=tmp_path)
    store.save("sess_atomic12", [{"Type": "EMAIL", "Value": "a@b.com"}])
    files = list(tmp_path.iterdir())
    assert len(files) == 1
    assert files[0].name == "sess_atomic12.json"
    assert files[0].stat().st_mode & 0o777 == 0o600
