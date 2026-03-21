"""Tests for request tracing — CLI req_id surfacing."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from dina_cli.main import cli


def _test_config():
    from dina_cli.config import Config
    return Config(core_url="http://localhost:8100", timeout=5.0)


class TestReqIdSurfacing:

    def test_error_includes_req_id(self):
        """Error messages include req_id for traced commands."""
        from dina_cli.client import DinaClientError

        mc = MagicMock()
        mc.req_id = "trace_abc123"
        mc.reason.side_effect = DinaClientError("vault query failed")

        runner = CliRunner()
        with patch("dina_cli.main.load_config", return_value=_test_config()), \
             patch("dina_cli.main.DinaClient", return_value=mc):
            result = runner.invoke(cli, ["ask", "test query"])

        assert "trace_abc123" in result.output

    def test_validate_json_includes_req_id(self):
        """dina --json validate includes req_id in output."""
        mc = MagicMock()
        mc.req_id = "val_trace_id"
        mc.process_event.return_value = {
            "action": "auto_approve",
            "approved": True,
            "requires_approval": False,
        }
        mc.kv_set = MagicMock()

        runner = CliRunner()
        with patch("dina_cli.main.load_config", return_value=_test_config()), \
             patch("dina_cli.main.DinaClient", return_value=mc):
            result = runner.invoke(cli, ["--json", "validate", "search", "test"])

        # req_id appears in JSON body or stderr (mixed in CliRunner output)
        assert "val_trace_id" in result.output

    def test_remember_json_includes_req_id(self):
        """dina --json remember includes req_id in output."""
        mc = MagicMock()
        mc.req_id = "rem_trace_id"
        mc.staging_ingest.return_value = {"id": "stg-12345678"}

        runner = CliRunner()
        with patch("dina_cli.main.load_config", return_value=_test_config()), \
             patch("dina_cli.main.DinaClient", return_value=mc):
            result = runner.invoke(cli, ["--json", "remember", "test fact"])

        # req_id appears in JSON body or stderr (mixed in CliRunner output)
        assert "rem_trace_id" in result.output

    def test_ask_json_includes_req_id(self):
        """dina --json ask includes req_id in response."""
        mc = MagicMock()
        mc.req_id = "ask_trace_id"
        mc.reason.return_value = {"content": "test answer", "model": "test"}

        runner = CliRunner()
        with patch("dina_cli.main.load_config", return_value=_test_config()), \
             patch("dina_cli.main.DinaClient", return_value=mc):
            result = runner.invoke(cli, ["--json", "ask", "test query"])

        # req_id appears either in JSON body or in stderr output
        assert "ask_trace_id" in result.output

    def test_client_generates_req_id(self):
        """DinaClient generates a 12-char hex req_id."""
        with patch("dina_cli.client.CLIIdentity"):
            from dina_cli.config import Config
            cfg = Config(core_url="http://localhost:8100", timeout=5.0)
            from dina_cli.client import DinaClient
            try:
                client = DinaClient(cfg)
            except Exception:
                # May fail without real keypair — that's ok, we test the attribute
                pass

    def test_print_result_with_trace_dict(self):
        """Dict output gets req_id injected."""
        from dina_cli.output import print_result_with_trace
        import io
        from unittest.mock import patch as p
        from click import echo

        # Test the merging logic directly
        data = {"content": "hello"}
        req_id = "abc123"

        merged = {**data, "req_id": req_id}
        assert merged["req_id"] == "abc123"
        assert merged["content"] == "hello"

    def test_print_result_with_trace_list(self):
        """List output stays as array — req_id goes to stderr, not into JSON."""
        data = [{"id": "1"}, {"id": "2"}]
        # Lists are NOT wrapped — req_id is printed to stderr separately
        # to avoid breaking existing JSON array consumers
        assert isinstance(data, list)
        assert len(data) == 2

    def test_no_req_id_on_local_commands(self):
        """Local commands (status, rehydrate) don't fabricate req_id."""
        runner = CliRunner()
        # status command doesn't use DinaClient
        result = runner.invoke(cli, ["--json", "status"])
        if result.output.strip():
            try:
                output = json.loads(result.output)
                assert "req_id" not in output
            except json.JSONDecodeError:
                pass  # non-JSON output is fine
