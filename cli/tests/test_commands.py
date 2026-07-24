"""Tests for CLI commands using click.testing.CliRunner."""

from __future__ import annotations

import json
import os
from unittest.mock import MagicMock, patch

import httpx
from click.testing import CliRunner

from dina_cli.client import DinaClientError
from dina_cli.main import _try_unpair, cli


def _test_config():
    """Return a Config suitable for tests (no real keypair needed)."""
    from dina_cli.config import Config
    return Config(
        core_url="http://localhost:8100",
        timeout=5.0,
        device_name="test-device",
    )


def _invoke(args, mock_client=None, env=None):
    """Helper: invoke CLI with mocked client and config."""
    runner = CliRunner()
    with patch("dina_cli.main.DinaClient") as MockCls, \
         patch("dina_cli.main.load_config", return_value=_test_config()):
        if mock_client:
            MockCls.return_value = mock_client
        result = runner.invoke(cli, args, env=env or {})
    return result


# ── status ────────────────────────────────────────────────────────────────


# TRACE: {"suite": "CLI", "case": "0001", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "01", "title": "status_paired_json"}
def test_status_paired_json(tmp_path):
    """Status shows paired when keypair exists and auth succeeds."""
    mc = MagicMock()
    mc.did_get.return_value = {"did": "did:key:z6MkTest"}
    identity_dir = tmp_path / "identity"
    identity_dir.mkdir()
    (identity_dir / "ed25519_private.pem").touch()

    runner = CliRunner()
    with patch("dina_cli.main.DinaClient") as MockCls, \
         patch("dina_cli.main.load_config", return_value=_test_config()), \
         patch("dina_cli.main.httpx") as mock_httpx, \
         patch("dina_cli.config.IDENTITY_DIR", identity_dir):
        MockCls.return_value = mc
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_httpx.get.return_value = mock_resp
        # Mock the signing identity
        with patch("dina_cli.main.CLIIdentity") as MockIdent:
            mock_ident = MagicMock()
            mock_ident.did.return_value = "did:key:z6MkTestDevice"
            MockIdent.return_value = mock_ident
            result = runner.invoke(cli, ["--json", "status"])
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["paired"] is True
    assert data["did"] == "did:key:z6MkTestDevice"
    assert data["core_reachable"] is True


# TRACE: {"suite": "CLI", "case": "0002", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "02", "title": "status_not_paired"}
def test_status_not_paired(tmp_path):
    """Status shows not paired when no keypair exists."""
    identity_dir = tmp_path / "identity"
    identity_dir.mkdir()
    # No keypair file

    runner = CliRunner()
    with patch("dina_cli.main.load_config", side_effect=Exception("no keypair")), \
         patch("dina_cli.config.IDENTITY_DIR", identity_dir), \
         patch("dina_cli.main.httpx") as mock_httpx:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_httpx.get.return_value = mock_resp
        result = runner.invoke(cli, ["status"])
    assert result.exit_code == 0
    assert "no" in result.output.lower()


# TRACE: {"suite": "CLI", "case": "0003", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "03", "title": "status_unreachable"}
def test_status_unreachable(tmp_path):
    """Status shows unreachable when Core is down."""
    identity_dir = tmp_path / "identity"
    identity_dir.mkdir()
    (identity_dir / "ed25519_private.pem").touch()

    runner = CliRunner()
    with patch("dina_cli.main.DinaClient") as MockCls, \
         patch("dina_cli.main.load_config", return_value=_test_config()), \
         patch("dina_cli.main.httpx") as mock_httpx, \
         patch("dina_cli.config.IDENTITY_DIR", identity_dir):
        mock_httpx.get.side_effect = Exception("connection refused")
        with patch("dina_cli.main.CLIIdentity") as MockIdent:
            mock_ident = MagicMock()
            mock_ident.did.return_value = "did:key:z6MkTestDevice"
            MockIdent.return_value = mock_ident
            # Force direct transport so the test is env-independent.
            # Without this, DINA_TRANSPORT=msgbox in the developer's
            # environment would take the msgbox branch and never hit the
            # mocked httpx.get that drives the "unreachable" assertion.
            result = runner.invoke(cli, ["--json", "status"],
                                   env={"DINA_TRANSPORT": "direct"})
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["core_reachable"] is False
    assert data["paired"] is False
    assert data["transport"] == "direct"


def test_status_public_health_does_not_count_as_paired(tmp_path):
    """A reachable public /healthz must not authenticate an unpaired key."""
    identity_dir = tmp_path / "identity"
    identity_dir.mkdir()
    (identity_dir / "ed25519_private.pem").touch()
    mc = MagicMock()
    mc.session_list.side_effect = DinaClientError("HTTP 403")

    runner = CliRunner()
    with patch("dina_cli.main.DinaClient", return_value=mc), \
         patch("dina_cli.main.load_config", return_value=_test_config()), \
         patch("dina_cli.main.httpx") as mock_httpx, \
         patch("dina_cli.config.IDENTITY_DIR", identity_dir), \
         patch("dina_cli.main.CLIIdentity") as MockIdent:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_httpx.get.return_value = mock_resp
        MockIdent.return_value.did.return_value = "did:key:z6MkUnpaired"
        result = runner.invoke(
            cli,
            ["--json", "status"],
            env={"DINA_TRANSPORT": "direct"},
        )

    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["core_reachable"] is True
    assert data["authenticated"] is False
    assert data["paired"] is False


# ── remember ──────────────────────────────────────────────────────────────


# TST-CLI-028
# TRACE: {"suite": "CLI", "case": "0028", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "04", "title": "remember_json"}
def test_remember_json():
    mc = MagicMock()
    mc.remember.return_value = {"id": "abc12345deadbeef", "status": "processing"}
    result = _invoke(["--json", "remember", "--session", "ses_test", "Buy milk"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "processing"
    mc.remember.assert_called_once()
    assert mc.remember.call_args.kwargs.get("session") == "ses_test"


# TST-CLI-029
# TRACE: {"suite": "CLI", "case": "0029", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "05", "title": "remember_human"}
def test_remember_human():
    mc = MagicMock()
    mc.remember.return_value = {"id": "abc12345", "status": "processing"}
    result = _invoke(["remember", "--session", "ses_test", "Buy milk"], mock_client=mc)
    assert result.exit_code == 0
    mc.remember.assert_called_once()
    assert mc.remember.call_args.kwargs.get("session") == "ses_test"


# TST-CLI-030
# TRACE: {"suite": "CLI", "case": "0030", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "06", "title": "remember_with_category"}
def test_remember_with_category():
    mc = MagicMock()
    mc.remember.return_value = {"id": "x", "status": "processing"}
    result = _invoke(["--json", "remember", "--session", "ses_test", "Alice bday March 15", "--category", "relationship"], mock_client=mc)
    assert result.exit_code == 0
    mc.remember.assert_called_once()


# ── ask ────────────────────────────────────────────────────────────────


# TST-CLI-031
# TRACE: {"suite": "CLI", "case": "0031", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "07", "title": "ask_json"}
def test_ask_json():
    mc = MagicMock()
    mc.ask.return_value = {"content": "Buy milk is in your vault."}
    result = _invoke(["--json", "ask", "--session", "ses_test", "milk"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert "content" in data


# TST-CLI-032
# TRACE: {"suite": "CLI", "case": "0032", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "08", "title": "ask_no_results"}
def test_ask_no_results():
    mc = MagicMock()
    mc.ask.return_value = {"content": ""}
    result = _invoke(["ask", "--session", "ses_test", "nonexistent"], mock_client=mc)
    assert result.exit_code == 0
    assert "don't have any information" in result.output


# TRACE: {"suite": "CLI", "case": "0004", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "09", "title": "ask_llm_not_configured"}
def test_ask_llm_not_configured():
    mc = MagicMock()
    mc.ask.return_value = {"error_code": "llm_not_configured", "message": "No LLM provider configured.", "content": ""}
    result = _invoke(["ask", "--session", "ses_test", "hello"], mock_client=mc)
    assert result.exit_code != 0
    assert "LLM" in result.output or "llm" in result.output


# TRACE: {"suite": "CLI", "case": "0005", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "10", "title": "ask_llm_not_configured_json"}
def test_ask_llm_not_configured_json():
    mc = MagicMock()
    mc.ask.return_value = {"error_code": "llm_not_configured", "message": "No LLM.", "content": ""}
    result = _invoke(["--json", "ask", "--session", "ses_test", "hello"], mock_client=mc)
    assert result.exit_code != 0
    data = json.loads(result.output)
    assert data["error_code"] == "llm_not_configured"


# TRACE: {"suite": "CLI", "case": "0006", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "11", "title": "ask_llm_unreachable"}
def test_ask_llm_unreachable():
    mc = MagicMock()
    mc.ask.return_value = {"error_code": "llm_unreachable", "message": "LLM provider unreachable.", "content": ""}
    result = _invoke(["ask", "--session", "ses_test", "hello"], mock_client=mc)
    assert result.exit_code != 0
    assert "unreachable" in result.output.lower()


# ── ask: async approval-wait-resume ────────────────────────────────────


# TRACE: {"suite": "CLI", "case": "0007", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "12", "title": "ask_202_polls_until_complete"}
def test_ask_202_polls_until_complete():
    """ask command polls on 202 and prints the answer when complete."""
    mc = MagicMock()
    mc.ask.return_value = {
        "status": "pending_approval",
        "request_id": "reason-abc123",
        "approval_id": "apr-xyz",
        "persona": "health",
    }
    # First poll: still pending. Second: complete.
    mc.ask_status.side_effect = [
        {"status": "pending_approval", "request_id": "reason-abc123"},
        {"status": "complete", "request_id": "reason-abc123",
         "content": "Your B12 is low at 180 pg/mL."},
    ]

    with patch("time.sleep"):  # skip real sleep
        result = _invoke(["ask", "--session", "ses_test", "vitamin levels"], mock_client=mc)

    assert result.exit_code == 0
    assert "B12" in result.output
    assert mc.ask_status.call_count == 2


# F-2 follow-up: an ask that starts as `in_flight` (LLM still reasoning
# inside the fast-path window, no approval yet) but later transitions to
# `pending_approval` (the agentic loop bailed on the persona_guard) used
# to keep showing "Still reasoning..." for the rest of the poll. The
# follow-up adds mid-poll state-transition detection — we re-banner to
# "Awaiting approval..." and switch the timeout-end messaging to match
# what we were actually waiting on.
def test_ask_polls_transition_in_flight_to_pending_approval_rebanner():
    """Mid-poll transition in_flight → pending_approval re-banners + finishes correctly."""
    mc = MagicMock()
    # Initial response: in_flight (LLM started, fast-path window expired
    # before the agentic loop bailed).
    mc.ask.return_value = {
        "status": "in_flight",
        "request_id": "trans-abc",
    }
    # Poll 1: still in_flight.
    # Poll 2: transitions to pending_approval (guard bailed).
    # Poll 3: still pending_approval (human hasn't tapped yet).
    # Poll 4: transitions back to in_flight (resume after approve).
    # Poll 5: complete.
    mc.ask_status.side_effect = [
        {"status": "in_flight", "request_id": "trans-abc"},
        {"status": "pending_approval", "request_id": "trans-abc", "approval_id": "apr-bp"},
        {"status": "pending_approval", "request_id": "trans-abc", "approval_id": "apr-bp"},
        {"status": "in_flight", "request_id": "trans-abc"},
        {"status": "complete", "request_id": "trans-abc",
         "answer": {"text": "your blood pressure is 138/88"}},
    ]

    with patch("time.sleep"):
        result = _invoke(["ask", "--session", "ses_test", "blood pressure"], mock_client=mc)

    assert result.exit_code == 0
    # The answer text is printed at completion.
    assert "138/88" in result.output
    # The transition banners surface in the stderr stream (Click merges
    # err/out into `output` here because no separate stderr capture is
    # wired in `_invoke`). The exact phrasing pins the UX contract:
    #   - "Still reasoning..." printed once at start (initial in_flight).
    #   - "Awaiting approval..." printed on the in_flight → pending_approval transition.
    #   - "Approved — reasoning..." printed on the pending_approval → in_flight transition.
    assert "Still reasoning" in result.output
    assert "Awaiting approval" in result.output
    assert "Approved" in result.output
    # All 5 polls happened.
    assert mc.ask_status.call_count == 5


def test_ask_timeout_reports_last_state_not_initial():
    """Timeout message should say 'awaiting approval' if that's where we ended up."""
    mc = MagicMock()
    # Initial: in_flight. All polls thereafter: pending_approval (operator never taps).
    mc.ask.return_value = {
        "status": "in_flight",
        "request_id": "timeout-abc",
    }
    # Return pending_approval for every poll — the timeout will eventually trip.
    mc.ask_status.return_value = {
        "status": "pending_approval",
        "request_id": "timeout-abc",
        "approval_id": "apr-timeout",
    }

    with patch("time.sleep"):
        # --timeout 30 = clamp-min, ~6 polls at the 5s slow interval after transition.
        result = _invoke(
            ["ask", "--session", "ses_test", "--timeout", "30", "anything"],
            mock_client=mc,
        )

    # CLI exits 1 on timeout (existing convention) and prints a
    # `Check later: dina ask-status <id>` hint so the operator can
    # recover via the standalone status command.
    assert result.exit_code == 1
    # The exit message must reflect the LAST-seen state, not the initial.
    assert "Timed out waiting for approval" in result.output
    # The misleading "reasoning" wording must NOT appear in the timeout line.
    assert "Timed out waiting for reasoning" not in result.output


# TRACE: {"suite": "CLI", "case": "0008", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "13", "title": "ask_202_denied"}
def test_ask_202_denied():
    """ask command prints denied when approval is rejected."""
    mc = MagicMock()
    mc.ask.return_value = {
        "status": "pending_approval",
        "request_id": "reason-deny-test",
        "approval_id": "apr-deny",
        "persona": "health",
    }
    mc.ask_status.return_value = {
        "status": "denied",
        "request_id": "reason-deny-test",
    }

    with patch("time.sleep"):
        result = _invoke(["ask", "--session", "ses_test", "health data"], mock_client=mc)

    assert result.exit_code == 1
    assert "denied" in result.output.lower()


# TRACE: {"suite": "CLI", "case": "0009", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "14", "title": "ask_202_json_mode_returns_immediately"}
def test_ask_202_json_mode_returns_immediately():
    """In JSON mode, ask returns 202 data immediately without polling."""
    mc = MagicMock()
    mc.ask.return_value = {
        "status": "pending_approval",
        "request_id": "reason-json-test",
        "approval_id": "apr-json",
        "persona": "health",
    }

    result = _invoke(["--json", "ask", "--session", "ses_test", "health"], mock_client=mc)

    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "pending_approval"
    assert data["request_id"] == "reason-json-test"
    mc.ask_status.assert_not_called()


# TRACE: {"suite": "CLI", "case": "0010", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "15", "title": "ask_status_command"}
def test_ask_status_command():
    """ask-status command shows current state."""
    mc = MagicMock()
    mc.ask_status.return_value = {
        "status": "complete",
        "request_id": "ask-status-test",
        "content": "Here is your answer.",
    }

    result = _invoke(
        ["ask-status", "ask-status-test", "--session", "ses_test"],
        mock_client=mc,
    )

    assert result.exit_code == 0
    assert "Here is your answer" in result.output
    mc.ask_status.assert_called_once_with("ask-status-test", session="ses_test")


# TRACE: {"suite": "CLI", "case": "0011", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "16", "title": "ask_status_denied"}
def test_ask_status_denied():
    """ask-status shows denied message."""
    mc = MagicMock()
    mc.ask_status.return_value = {
        "status": "denied",
        "request_id": "ask-denied",
    }

    result = _invoke(
        ["ask-status", "ask-denied", "--session", "ses_test"],
        mock_client=mc,
    )

    assert result.exit_code == 0
    assert "denied" in result.output.lower()


# ── validate ──────────────────────────────────────────────────────────────


# TST-CLI-033
# TRACE: {"suite": "CLI", "case": "0033", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "17", "title": "validate_approved"}
def test_validate_approved():
    mc = MagicMock()
    mc.process_event.return_value = {"approved": True, "requires_approval": False, "risk": "SAFE"}
    result = _invoke(["--json", "validate", "--session", "ses_test", "read_email", "Read inbox"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "approved"
    assert mc.process_event.call_args.kwargs.get("session") == "ses_test"
    # No KV write — validate uses proposal lifecycle, not KV snapshots
    mc.kv_set.assert_not_called()


# TST-CLI-034
# TRACE: {"suite": "CLI", "case": "0034", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "18", "title": "validate_pending"}
def test_validate_pending():
    mc = MagicMock()
    mc.process_event.return_value = {
        "approved": False, "requires_approval": True, "risk": "HIGH",
        "proposal_id": "prop_abc123",
    }
    result = _invoke(["--json", "validate", "--session", "ses_test", "delete_emails", "Delete 247 emails", "--count", "247"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "pending_approval"
    assert data["id"] == "prop_abc123"
    assert "dashboard_url" in data
    assert "prop_abc123" in data["dashboard_url"]


# TST-CLI-035
# TRACE: {"suite": "CLI", "case": "0035", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "19", "title": "validate_fallback_safe"}
def test_validate_fallback_safe():
    """When Core is unavailable, safe actions auto-approve."""
    mc = MagicMock()
    mc.process_event.side_effect = DinaClientError("Cannot reach Dina at http://localhost:8100. Is it running?")
    result = _invoke(["--json", "validate", "--session", "ses_test", "search", "Search inbox"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "approved"


# TST-CLI-036
# TRACE: {"suite": "CLI", "case": "0036", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "20", "title": "validate_fallback_risky"}
def test_validate_fallback_risky():
    """When Core is unavailable, risky actions need approval."""
    mc = MagicMock()
    mc.process_event.side_effect = DinaClientError("Cannot reach Dina at http://localhost:8100. Is it running?")
    result = _invoke(["--json", "validate", "--session", "ses_test", "send_email", "Send to 500 people"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "pending_approval"


# ── validate-status ───────────────────────────────────────────────────────


# TST-CLI-037
# TRACE: {"suite": "CLI", "case": "0037", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "21", "title": "validate_status_found"}
def test_validate_status_found():
    mc = MagicMock()
    mc.get_proposal_status.return_value = {
        "id": "prop_abc123", "status": "approved",
        "action": "read_email", "kind": "intent",
    }
    result = _invoke(["--json", "validate-status", "prop_abc123"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "approved"
    assert data["id"] == "prop_abc123"


# TST-CLI-038
# TRACE: {"suite": "CLI", "case": "0038", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "22", "title": "validate_status_not_found"}
def test_validate_status_not_found():
    mc = MagicMock()
    mc.get_proposal_status.side_effect = DinaClientError("HTTP 404: proposal not found")
    result = _invoke(["--json", "validate-status", "prop_missing"], mock_client=mc)
    assert result.exit_code != 0


# ── scrub ─────────────────────────────────────────────────────────────────


# TST-CLI-039
# TRACE: {"suite": "CLI", "case": "0039", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "23", "title": "scrub_json"}
def test_scrub_json(tmp_path):
    mc = MagicMock()
    mc.pii_scrub.return_value = {
        "scrubbed": "[EMAIL_1] sent a message",
        "entities": [{"type": "EMAIL", "value": "john@ex.com", "start": 0, "end": 11}],
    }
    runner = CliRunner()
    with patch("dina_cli.main.DinaClient", return_value=mc), \
         patch("dina_cli.main.load_config", return_value=_test_config()), \
         patch("dina_cli.main.SessionStore") as MockSS:
        mock_store = MagicMock()
        mock_store.new_id.return_value = "pii_test1234"
        MockSS.return_value = mock_store
        result = runner.invoke(cli, ["--json", "scrub", "john@ex.com sent a message"], env={})
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["scrubbed"] == "[EMAIL_1] sent a message"
    assert data["pii_id"] == "pii_test1234"


# ── rehydrate ─────────────────────────────────────────────────────────────


# TST-CLI-040
# TRACE: {"suite": "CLI", "case": "0040", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "24", "title": "rehydrate_json"}
def test_rehydrate_json():
    runner = CliRunner()
    with patch("dina_cli.main.DinaClient"), \
         patch("dina_cli.main.load_config", return_value=_test_config()), \
         patch("dina_cli.main.SessionStore") as MockSS:
        mock_store = MagicMock()
        mock_store.rehydrate.return_value = "Dr. Sharma at Apollo Hospital"
        MockSS.return_value = mock_store
        result = runner.invoke(
            cli,
            ["--json", "rehydrate", "[PERSON_1] at [ORG_1]", "--session", "sess_abc"],
            env={},
        )
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["restored"] == "Dr. Sharma at Apollo Hospital"


# ── draft ─────────────────────────────────────────────────────────────────


# TST-CLI-041
# TRACE: {"suite": "CLI", "case": "0041", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "25", "title": "draft_json"}
def test_draft_json():
    mc = MagicMock()
    mc.staging_ingest.return_value = {"id": "stg-draft-001", "staged": True}
    result = _invoke(
        ["--json", "draft", "Hello!", "--to", "alice@ex.com", "--channel", "email", "--subject", "Hi"],
        mock_client=mc,
    )
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "pending_review"
    assert data["draft_id"].startswith("drf_")
    # Phase 4: draft must use staging_ingest, NOT vault_store
    mc.staging_ingest.assert_called_once()
    item = mc.staging_ingest.call_args[0][0]
    assert item["type"] == "email_draft"
    assert item["body"] == "Hello!"
    mc.vault_store.assert_not_called()


# ── sign ──────────────────────────────────────────────────────────────────


# TST-CLI-042
# TRACE: {"suite": "CLI", "case": "0042", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "26", "title": "sign_json"}
def test_sign_json(tmp_path):
    """sign command signs locally — no server call needed."""
    from dina_cli.signing import CLIIdentity

    identity = CLIIdentity(identity_dir=tmp_path / "identity")
    identity.generate()

    runner = CliRunner()
    with patch("dina_cli.signing.CLIIdentity", return_value=identity):
        result = runner.invoke(cli, ["--json", "sign", "I approve the budget"], env={})
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["signed_by"].startswith("did:key:z")
    assert len(data["signature"]) == 128  # Ed25519 sig = 64 bytes = 128 hex
    assert "timestamp" in data


# ── audit ─────────────────────────────────────────────────────────────────


# TST-CLI-043
# TRACE: {"suite": "CLI", "case": "0043", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "27", "title": "audit_json"}
def test_audit_json():
    mc = MagicMock()
    mc.audit_query.return_value = {"entries": [
        {"action": "vault_query", "persona": "general", "timestamp": "2026-03-15T10:00:00Z"},
    ]}
    result = _invoke(["--json", "audit", "--limit", "5"], mock_client=mc)
    assert result.exit_code == 0
    mc.audit_query.assert_called_once_with(limit=5, action="")


# ── missing keypair ───────────────────────────────────────────────────────


# TST-CLI-044
# TRACE: {"suite": "CLI", "case": "0044", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "28", "title": "missing_keypair"}
def test_missing_keypair():
    """CLI exits with error when no Ed25519 keypair exists."""
    runner = CliRunner()
    result = runner.invoke(cli, ["--json", "ask", "--session", "ses_test", "test"], env={})
    assert result.exit_code != 0


# ── configure ─────────────────────────────────────────────────────────────


# TST-CLI-045
# TRACE: {"suite": "CLI", "case": "0045", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "29", "title": "configure_signature_mode"}
def test_configure_signature_mode(tmp_path):
    """Configure generates Ed25519 keypair and attempts pairing.

    LAN-only setup: no MsgBox relay, so the user explicitly picks
    `direct` transport. (CLI.3: the prompt default is now `msgbox`, which
    requires a relay URL — a LAN user must opt into `direct`.)"""
    runner = CliRunner()

    with patch("dina_cli.main._configure_signature") as mock_sig, \
         patch("dina_cli.main.save_config") as mock_save, \
         patch("dina_cli.main._load_saved", return_value={}):
        mock_save.return_value = tmp_path / "config.json"
        # Prompts (in order): setup code (Enter = manual) → config_location →
        # core_url → msgbox_url → homenode_did → transport mode →
        # device_name → test connection?
        user_input = "\n".join([
            "",           # setup code (blank — manual setup)
            "",           # config_location (default: global)
            "",           # core_url (default)
            "",           # msgbox_url (blank — LAN only)
            "",           # homenode_did (blank)
            "direct",     # transport mode — LAN, no relay (default is msgbox)
            "my-laptop",  # device name
            "n",          # don't test connection
        ])
        result = runner.invoke(cli, ["configure"], input=user_input, env={})

    assert result.exit_code == 0
    mock_sig.assert_called_once()
    saved = mock_save.call_args[0][0]
    assert saved["device_name"] == "my-laptop"
    assert saved["transport_mode"] == "direct"
    assert saved["msgbox_url"] == ""
    assert saved["homenode_did"] == ""
    assert "client_token" not in saved
    assert "auth_mode" not in saved
    assert "brain_url" not in saved
    assert "brain_token" not in saved


def test_configure_quick_paste_setup_code(tmp_path):
    """Pasting a `dina1:` setup code skips every connection prompt: the
    relay URL, Home Node DID, transport, device name AND the pairing code
    all come from the one string (the code is threaded into
    `_configure_signature` so `_pair_with_key` never prompts)."""
    import base64 as _b64

    payload = {
        "v": 1,
        "msgbox_url": "wss://relay.example.com/ws",
        "homenode_did": "did:plc:home",
        "transport": "msgbox",
        "device_name": "openclaw-agent",
        "code": "ABCD2EFG",
    }
    compact = json.dumps(payload, separators=(",", ":"))
    setup_str = "dina1:" + _b64.urlsafe_b64encode(compact.encode()).decode().rstrip("=")

    runner = CliRunner()
    with patch("dina_cli.main._configure_signature") as mock_sig, \
         patch("dina_cli.main.save_config") as mock_save, \
         patch("dina_cli.main._load_saved", return_value={}):
        mock_save.return_value = tmp_path / "config.json"
        # Prompts: setup code (pasted) → config_location → test connection?
        # — NO core_url / msgbox / DID / transport / device-name prompts.
        user_input = "\n".join([
            setup_str,  # the one paste
            "",         # config_location (default: global)
            "n",        # don't test connection
        ])
        result = runner.invoke(cli, ["configure"], input=user_input, env={})

    assert result.exit_code == 0, result.output
    # The per-field prompts must NOT have appeared.
    assert "MsgBox WebSocket URL" not in result.output
    assert "Home Node DID (did:plc" not in result.output
    saved = mock_save.call_args[0][0]
    assert saved["msgbox_url"] == "wss://relay.example.com/ws"
    assert saved["homenode_did"] == "did:plc:home"
    assert saved["transport_mode"] == "msgbox"
    assert saved["device_name"] == "openclaw-agent"
    # The embedded pairing code reached the pairing step.
    assert mock_sig.call_args.kwargs["pairing_code"] == "ABCD2EFG"


def test_configure_headless_setup_code(tmp_path):
    """`--headless --setup-code dina1:…` is the greenfield automation path:
    the one string supplies relay + DID + transport + name + pairing code,
    and explicit flags still override field-by-field."""
    import base64 as _b64

    payload = {
        "v": 1,
        "msgbox_url": "wss://relay.example.com/ws",
        "homenode_did": "did:plc:home",
        "transport": "msgbox",
        "device_name": "openclaw-agent",
        "code": "ABCD2EFG",
    }
    compact = json.dumps(payload, separators=(",", ":"))
    setup_str = "dina1:" + _b64.urlsafe_b64encode(compact.encode()).decode().rstrip("=")

    runner = CliRunner()
    with patch("dina_cli.main._configure_headless") as mock_headless:
        result = runner.invoke(
            cli,
            [
                "configure", "--headless", "--role", "agent",
                "--setup-code", setup_str,
                "--device-name", "flag-wins",  # explicit flag overrides the string
            ],
            env={},
        )
    assert result.exit_code == 0, result.output
    kwargs = mock_headless.call_args.kwargs
    assert kwargs["msgbox_url"] == "wss://relay.example.com/ws"
    assert kwargs["homenode_did"] == "did:plc:home"
    assert kwargs["transport_mode"] == "msgbox"
    assert kwargs["pairing_code"] == "ABCD2EFG"
    assert kwargs["device_name"] == "flag-wins"
    assert kwargs["role"] == "agent"


def test_configure_rejects_corrupted_setup_code(tmp_path):
    """A string that claims to be a setup code but doesn't parse must fail
    loudly (re-copy) — NOT silently fall through to manual prompts."""
    runner = CliRunner()
    with patch("dina_cli.main._configure_signature"), \
         patch("dina_cli.main.save_config") as mock_save, \
         patch("dina_cli.main._load_saved", return_value={}):
        mock_save.return_value = tmp_path / "config.json"
        result = runner.invoke(
            cli, ["configure"], input="dina1:%%%broken%%%\n", env={},
        )
    assert result.exit_code != 0
    assert "Setup code rejected" in result.output


# CLI follow-up #1: the interactive connection test must honor the SELECTED
# transport. Regression for the bug where it built `Config(core_url=...)`
# only — which, now that the default is msgbox, falsely failed with
# "transport=msgbox requires msgbox_url" even after a valid MsgBox setup.
def test_configure_connection_test_uses_msgbox_transport(tmp_path):
    """A MsgBox setup + 'test connection: yes' probes via MsgBox, not a bare
    direct Config that would falsely fail on the msgbox-default validator."""
    runner = CliRunner()

    captured = {}

    class _FakeClient:
        def __init__(self, cfg, *a, **k):
            # Capture the Config the probe was built with.
            captured["transport_mode"] = cfg.transport_mode
            captured["msgbox_url"] = cfg.msgbox_url
            captured["homenode_did"] = cfg.homenode_did

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def _request(self, *a, **k):
            return None  # /healthz "succeeds"

        @property
        def _core(self):
            return None

        @property
        def _identity(self):
            class _Id:
                def did(self_inner):
                    return "did:key:zTest"
            return _Id()

        def did_get(self):
            return {"id": "did:plc:home"}

    with patch("dina_cli.main._configure_signature"), \
         patch("dina_cli.main.save_config") as mock_save, \
         patch("dina_cli.main._load_saved", return_value={}), \
         patch("dina_cli.main.DinaClient", _FakeClient):
        mock_save.return_value = tmp_path / "config.json"
        user_input = "\n".join([
            "",                                # setup code (blank — manual setup)
            "",                                # config_location
            "",                                # core_url (default)
            "wss://relay.example.com/ws",      # msgbox_url
            "did:plc:home",                    # homenode_did
            "",                                # transport mode — accept default (msgbox)
            "my-laptop",                       # device name
            "y",                               # YES, test connection
        ])
        result = runner.invoke(cli, ["configure"], input=user_input, env={})

    assert result.exit_code == 0
    # The probe Config carried the selected MsgBox transport, not a bare
    # core-only config that the msgbox-default validator would reject.
    assert captured["transport_mode"] == "msgbox"
    assert captured["msgbox_url"] == "wss://relay.example.com/ws"
    assert captured["homenode_did"] == "did:plc:home"
    # The label reflects MsgBox, and the probe reported a successful connect.
    assert "MsgBox" in result.output
    assert "Connected" in result.output


# CLI.3: the transport prompt now defaults to `msgbox`. Accepting that
# default WITHOUT a MsgBox URL + Home Node DID is a dead end — the
# configure flow must reject it rather than save an unusable config.
def test_configure_msgbox_default_requires_relay(tmp_path):
    """Blank MsgBox URL + accept the msgbox default → UsageError (no save)."""
    runner = CliRunner()

    with patch("dina_cli.main._configure_signature"), \
         patch("dina_cli.main.save_config") as mock_save, \
         patch("dina_cli.main._load_saved", return_value={}):
        mock_save.return_value = tmp_path / "config.json"
        user_input = "\n".join([
            "",           # config_location
            "",           # core_url
            "",           # msgbox_url (blank)
            "",           # homenode_did (blank)
            "",           # transport mode — accept default (msgbox)
            "my-laptop",  # device name
            "n",
        ])
        result = runner.invoke(cli, ["configure"], input=user_input, env={})

    # Non-zero exit (click UsageError) and nothing persisted.
    assert result.exit_code != 0
    mock_save.assert_not_called()


# TST-CLI-046
# TRACE: {"suite": "CLI", "case": "0046", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "30", "title": "configure_help"}
def test_configure_help():
    """Configure --help shows without requiring a token."""
    runner = CliRunner()
    result = runner.invoke(cli, ["configure", "--help"], env={})
    assert result.exit_code == 0
    assert "Set up connection" in result.output


# ── session ──────────────────────────────────────────────────────────────


# TST-CLI-047
# TRACE: {"suite": "CLI", "case": "0047", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "31", "title": "session_start"}
def test_session_start():
    """Session start creates a named session."""
    mc = MagicMock()
    mc.session_start.return_value = {"session_id": "ses-123", "status": "open"}
    result = _invoke(["session", "start", "--name", "research"], mock_client=mc)
    assert result.exit_code == 0
    assert "research" in result.output
    assert "active" in result.output
    mc.session_start.assert_called_once_with("research")


# TST-CLI-048
# TRACE: {"suite": "CLI", "case": "0048", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "32", "title": "session_end"}
def test_session_end():
    """Session end closes a session."""
    mc = MagicMock()
    mc.session_end.return_value = {"ok": True}
    result = _invoke(["session", "end", "ses-123"], mock_client=mc)
    assert result.exit_code == 0
    assert "ended" in result.output or "ses-123" in result.output
    mc.session_end.assert_called_once_with("ses-123")


# TST-CLI-049
# TRACE: {"suite": "CLI", "case": "0049", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "33", "title": "session_list_empty"}
def test_session_list_empty():
    """Session list shows no sessions when none active."""
    mc = MagicMock()
    mc.session_list.return_value = {"sessions": []}
    result = _invoke(["session", "list"], mock_client=mc)
    assert result.exit_code == 0
    assert "No active sessions" in result.output
    mc.session_list.assert_called_once_with()


# TST-CLI-050
# TRACE: {"suite": "CLI", "case": "0050", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "34", "title": "session_list_with_sessions"}
def test_session_list_with_sessions():
    """Session list shows active sessions with grants."""
    mc = MagicMock()
    mc.session_list.return_value = {
        "sessions": [
            {
                "session_id": "ses-123",
                "name": "chair-research",
                "status": "active",
                "grants": [{"persona_id": "health"}],
            }
        ]
    }
    result = _invoke(["session", "list"], mock_client=mc)
    assert result.exit_code == 0
    assert "chair-research" in result.output
    assert "health" in result.output


# TST-CLI-051
# TRACE: {"suite": "CLI", "case": "0051", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "35", "title": "session_start_json"}
def test_session_start_json():
    """Session start with --json returns JSON."""
    mc = MagicMock()
    mc.session_start.return_value = {
        "session_id": "ses-456",
        "status": "open",
        "lease_expires_at": 123,
    }
    result = _invoke(["--json", "session", "start", "--name", "tax"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["session_id"] == "ses-456"


# ── ask with session ──────────────────────────────────────────────────


# TST-CLI-052
# TRACE: {"suite": "CLI", "case": "0052", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "36", "title": "ask_uses_brain_reason"}
def test_ask_uses_brain_reason():
    """Recall routes through Brain's ask endpoint (persona-blind)."""
    mc = MagicMock()
    mc.ask.return_value = {"content": "Based on your vault data, here is the answer."}
    result = _invoke(["ask", "--session", "ses_test", "office chair recommendations"], mock_client=mc)
    assert result.exit_code == 0
    mc.ask.assert_called_once()
    assert "answer" in result.output


# TST-CLI-053
# TRACE: {"suite": "CLI", "case": "0053", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "37", "title": "ask_with_session"}
def test_ask_with_session():
    """Recall with --session passes session to ask()."""
    mc = MagicMock()
    mc.ask.return_value = {"content": "Chair data found."}
    result = _invoke(
        ["ask", "--session", "chair-research", "back pain"],
        mock_client=mc,
    )
    assert result.exit_code == 0
    mc.ask.assert_called_once_with("back pain", session="chair-research")


# TST-CLI-054
# TRACE: {"suite": "CLI", "case": "0054", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "38", "title": "ask_no_persona_flag"}
def test_ask_no_persona_flag():
    """Recall does NOT have a --persona flag (agents are persona-blind)."""
    mc = MagicMock()
    mc.ask.return_value = {"content": "ok"}
    result = _invoke(["ask", "--session", "ses_test", "test", "--persona", "health"], mock_client=mc)
    # --persona should be rejected as unknown option
    assert result.exit_code != 0


# TST-CLI-055
# TRACE: {"suite": "CLI", "case": "0055", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "39", "title": "ask_approval_required"}
def test_ask_approval_required():
    """Recall shows approval message when access requires approval."""
    mc = MagicMock()
    mc.ask.side_effect = DinaClientError("Access denied: approval_required")
    result = _invoke(["ask", "--session", "ses_test", "health data"], mock_client=mc)
    assert result.exit_code == 1
    assert "approval" in result.output.lower()


# TST-CLI-056
# TRACE: {"suite": "CLI", "case": "0056", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "40", "title": "ask_persona_locked_shows_hint"}
def test_ask_persona_locked_shows_hint():
    """Recall shows helpful message when persona is locked."""
    mc = MagicMock()
    mc.ask.side_effect = DinaClientError("Access denied: persona locked")
    result = _invoke(["ask", "--session", "ses_test", "hello"], mock_client=mc)
    assert result.exit_code == 1
    assert "locked" in result.output.lower()


# TST-CLI-057
# TRACE: {"suite": "CLI", "case": "0057", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "41", "title": "ask_with_verbose"}
def test_ask_with_verbose():
    """Recall --verbose flag is accepted."""
    mc = MagicMock()
    mc.ask.return_value = {"content": "ok"}
    result = _invoke(["-v", "ask", "--session", "ses_test", "hello"], mock_client=mc)
    assert result.exit_code == 0


# ── persona-blind contract ───────────────────────────────────────────────


# TST-CLI-058
# TRACE: {"suite": "CLI", "case": "0058", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "42", "title": "remember_uses_remember_endpoint"}
def test_remember_uses_remember_endpoint():
    """Remember uses the remember endpoint, not vault_store."""
    mc = MagicMock()
    mc.remember.return_value = {"id": "stg123", "status": "processing"}
    result = _invoke(["remember", "--session", "ses_test", "User prefers window seats"], mock_client=mc)
    assert result.exit_code == 0
    mc.remember.assert_called_once()
    # No persona specified — Brain classifies into the right one
    mc.vault_store.assert_not_called()


# TST-CLI-059
# TRACE: {"suite": "CLI", "case": "0059", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "43", "title": "audit_uses_audit_endpoint"}
def test_audit_uses_audit_endpoint():
    """Audit delegates to the caller-aware client projection, not vault query."""
    mc = MagicMock()
    mc.audit_query.return_value = {"entries": []}
    result = _invoke(["--json", "audit"], mock_client=mc)
    assert result.exit_code == 0
    mc.audit_query.assert_called_once_with(limit=20, action="")
    mc.vault_query.assert_not_called()


# ── unpair ────────────────────────────────────────────────────────────────


# TRACE: {"suite": "CLI", "case": "0012", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "44", "title": "unpair_not_paired"}
def test_unpair_not_paired(tmp_path):
    """Without a key there is no authenticated remote authority to revoke."""
    identity_dir = tmp_path / "identity"
    identity_dir.mkdir()
    runner = CliRunner()
    with patch("dina_cli.main._load_saved", return_value={}), patch(
        "dina_cli.main.save_config"
    ), patch("dina_cli.config.IDENTITY_DIR", identity_dir):
        result = runner.invoke(cli, ["unpair"])
    assert result.exit_code == 0
    assert "no keypair" in result.output.lower()


# TRACE: {"suite": "CLI", "case": "0013", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "45", "title": "unpair_json"}
def test_unpair_json(tmp_path):
    """Unpair succeeds and returns JSON."""
    identity_dir = tmp_path / "identity"
    identity_dir.mkdir()
    (identity_dir / "ed25519_private.pem").touch()

    runner = CliRunner()
    with patch("dina_cli.main._load_saved", return_value={"device_id": "dev-123", "core_url": "http://localhost:8100"}), \
         patch("dina_cli.main.save_config"), \
         patch("dina_cli.config.IDENTITY_DIR", identity_dir), \
         patch("dina_cli.main.load_config", return_value=_test_config()), \
         patch("dina_cli.main.DinaClient") as MockClient:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        MockClient.return_value._request.return_value = mock_resp
        result = runner.invoke(cli, ["--json", "unpair"])
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "unpaired"
    assert data["device_id"] == "dev-123"
    assert MockClient.return_value._request.call_args.args[2] == "/v1/devices/self"


def test_reconfigure_self_revokes_old_key_without_admin_device_route():
    """Replacing a key revokes the authenticated old key via the self route."""
    identity = MagicMock()
    identity.sign_request.return_value = (
        "did:key:zOld",
        "1700000000",
        "nonce",
        "signature",
    )
    transport = MagicMock()
    transport.request.return_value.status = 204

    with patch(
        "dina_cli.main._load_saved",
        return_value={
            "device_id": "dev-old",
            "core_url": "http://old-core:8100",
            "transport_mode": "direct",
        },
    ), patch("dina_cli.main.save_config") as save, patch(
        "dina_cli.main._build_pairing_transport",
        return_value=transport,
    ) as build_transport:
        _try_unpair(
            "http://new-core:8100",
            identity,
            transport_mode="direct",
        )

    identity.sign_request.assert_called_once_with(
        "DELETE",
        "/v1/devices/self",
        b"",
    )
    assert transport.request.call_args.args[:2] == (
        "DELETE",
        "/v1/devices/self",
    )
    build_transport.assert_called_once_with(
        "http://old-core:8100",
        "",
        "",
        "direct",
        identity=identity,
    )
    save.assert_called_once_with(
        {
            "core_url": "http://old-core:8100",
            "transport_mode": "direct",
        }
    )


def test_reconfigure_keeps_old_key_state_when_self_revoke_fails():
    identity = MagicMock()
    identity.sign_request.return_value = (
        "did:key:zOld",
        "1700000000",
        "nonce",
        "signature",
    )
    transport = MagicMock()
    transport.request.return_value.status = 503

    with patch(
        "dina_cli.main._load_saved",
        return_value={"device_id": "dev-old"},
    ), patch("dina_cli.main.save_config") as save, patch(
        "dina_cli.main._build_pairing_transport",
        return_value=transport,
    ):
        try:
            _try_unpair(
                "http://localhost:8100",
                identity,
                transport_mode="direct",
            )
        except Exception as exc:
            assert "not orphaned" in str(exc)
        else:
            raise AssertionError("reconfiguration must stop when revoke fails")

    save.assert_not_called()


# TRACE: {"suite": "CLI", "case": "0014", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "46", "title": "unpair_core_unreachable"}
def test_unpair_core_unreachable(tmp_path):
    """Unpair fails gracefully when Core is unreachable."""
    identity_dir = tmp_path / "identity"
    identity_dir.mkdir()
    (identity_dir / "ed25519_private.pem").touch()

    runner = CliRunner()
    with patch("dina_cli.main._load_saved", return_value={"device_id": "dev-123", "core_url": "http://localhost:8100"}), \
         patch("dina_cli.config.IDENTITY_DIR", identity_dir), \
         patch("dina_cli.main.load_config", return_value=_test_config()), \
         patch("dina_cli.main.DinaClient", side_effect=DinaClientError("connection refused")):
        result = runner.invoke(cli, ["unpair"])
    assert result.exit_code != 0


# TST-CLI-060
# TRACE: {"suite": "CLI", "case": "0060", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "47", "title": "cli_config_has_no_persona"}
def test_cli_config_has_no_persona():
    """CLI Config has no persona field — agents are persona-blind."""
    from dina_cli.config import Config
    config = Config(core_url="http://localhost:8100", timeout=5.0)
    assert not hasattr(config, "persona") or "persona" not in config.__dict__
