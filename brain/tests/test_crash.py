"""Tests for Crash Traceback Safety.

Maps to Brain TEST_PLAN SS13.

Python tracebacks include local variable values. If brain crashes mid-reasoning,
the traceback could contain PII (e.g., query="find emails about my cancer diagnosis").
Fix: sanitized one-liner to stdout, full traceback to encrypted vault.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from src.infra.crash_handler import handle_crash, _sanitize_oneliner, _build_crash_report


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_exception_with_traceback(
    msg: str = "test crash",
    exc_type: type = RuntimeError,
) -> BaseException:
    """Create an exception with a real traceback attached.

    We raise-and-catch so that ``__traceback__`` is populated, which is
    required by ``traceback.format_exception``.
    """
    try:
        query = "find emails about my cancer diagnosis"  # PII in local vars
        raise exc_type(msg)
    except exc_type as exc:
        return exc


# ---------------------------------------------------------------------------
# SS13 Crash Traceback Safety (7 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-320
@pytest.mark.asyncio
async def test_crash_13_1_catchall_wraps_guardian(mock_core_client) -> None:
    """SS13.1: Catch-all wraps guardian loop.

    handle_crash() can be called with an exception and a core_client.
    After logging + vault write it re-raises, ensuring no unhandled
    exception leaks silently.
    """
    error = _make_exception_with_traceback("guardian failure")

    with pytest.raises(RuntimeError, match="guardian failure"):
        await handle_crash(error, task_id="task-001", core_client=mock_core_client)

    # Vault write was attempted
    mock_core_client.write_scratchpad.assert_awaited_once()


# TST-BRAIN-321
@pytest.mark.asyncio
async def test_crash_13_2_stdout_sanitized_oneliner(capsys) -> None:
    """SS13.2: Stdout -- sanitized one-liner only.

    Brain crashes with PII in local vars. Docker logs show only:
    "guardian crash: RuntimeError at line <N>" -- type + line number only.
    No PII leaks to stderr.
    """
    error = _make_exception_with_traceback("secret stuff")

    with pytest.raises(RuntimeError):
        await handle_crash(error, task_id="task-pii")

    captured = capsys.readouterr()
    # The one-liner is written to stderr
    assert "guardian crash: RuntimeError at line" in captured.err
    # PII from local variables must NOT appear in stderr
    assert "cancer" not in captured.err
    assert "secret stuff" not in captured.err


# TST-BRAIN-322
@pytest.mark.asyncio
async def test_crash_13_3_vault_full_traceback(mock_core_client) -> None:
    """SS13.3: Vault -- full traceback stored.

    Same crash sends full traceback to encrypted vault via
    core_client.write_scratchpad().  The report includes error type,
    traceback text, and task_id.
    """
    error = _make_exception_with_traceback("vault test crash")

    with pytest.raises(RuntimeError):
        await handle_crash(
            error, task_id="task-abc123", core_client=mock_core_client
        )

    # Verify write_scratchpad was called with the crash report
    mock_core_client.write_scratchpad.assert_awaited_once()
    call_args = mock_core_client.write_scratchpad.call_args
    # Positional args: (task_id_or_key, step, report_dict)
    report = call_args[0][2]
    assert report["error"] == "RuntimeError"
    assert "Traceback" in report["traceback"]
    assert report["task_id"] == "task-abc123"


# TST-BRAIN-323
@pytest.mark.asyncio
async def test_crash_13_4_traceback_never_written_to_file(
    mock_core_client, tmp_path, monkeypatch,
) -> None:
    """SS13.4: Traceback never written to file.

    No crash.log, no /tmp/traceback.txt -- only encrypted vault via core API.
    We run handle_crash in a tmp directory and verify no new files appear.
    """
    monkeypatch.chdir(tmp_path)
    error = _make_exception_with_traceback("file test crash")

    files_before = set(tmp_path.iterdir())

    with pytest.raises(RuntimeError):
        await handle_crash(error, task_id="task-file", core_client=mock_core_client)

    files_after = set(tmp_path.iterdir())
    new_files = files_after - files_before
    # No new files should have been created
    assert new_files == set(), f"Unexpected files created: {new_files}"
    # Specifically check for common crash-file names
    assert not (tmp_path / "crash.log").exists()
    assert not Path("/tmp/traceback.txt").exists()


# TST-BRAIN-324
@pytest.mark.asyncio
async def test_crash_13_5_task_id_correlated(mock_core_client) -> None:
    """SS13.5: Task ID correlated.

    Brain crashes during task "abc123".  Crash report task_id matches
    the in-flight task -- debugging correlates crash with event.
    """
    error = _make_exception_with_traceback("correlation test")

    with pytest.raises(RuntimeError):
        await handle_crash(
            error, task_id="abc123", core_client=mock_core_client
        )

    call_args = mock_core_client.write_scratchpad.call_args
    # First positional arg is the task key used for scratchpad storage
    scratchpad_key = call_args[0][0]
    assert scratchpad_key == "abc123"

    # The report dict also contains the matching task_id
    report = call_args[0][2]
    assert report["task_id"] == "abc123"


# TST-BRAIN-325
@pytest.mark.asyncio
async def test_crash_13_6_crash_handler_reraises() -> None:
    """SS13.6: Crash handler re-raises.

    After logging + vault write, the handler re-raises so Docker
    restart policy triggers container restart.
    """
    error = _make_exception_with_traceback("reraise test")

    with pytest.raises(RuntimeError, match="reraise test"):
        await handle_crash(error)

    # If we get here the error was re-raised -- test passes.


# TST-BRAIN-326
@pytest.mark.asyncio
async def test_crash_13_7_core_unreachable() -> None:
    """SS13.7: Core unreachable during crash.

    Brain crashes, core is also down.  One-liner to stdout (always works),
    vault write fails silently.  Traceback lost, but event retried on restart.
    """
    # Create a core client whose write_scratchpad raises ConnectionError
    unreachable_client = AsyncMock()
    unreachable_client.write_scratchpad.side_effect = ConnectionError(
        "core is down"
    )

    error = _make_exception_with_traceback("core down crash")

    # handle_crash should still re-raise the *original* error, not the
    # ConnectionError from the failed vault write.
    with pytest.raises(RuntimeError, match="core down crash"):
        await handle_crash(
            error, task_id="task-doomed", core_client=unreachable_client
        )

    # Vault write was attempted but failed silently
    unreachable_client.write_scratchpad.assert_awaited_once()


# ---------------------------------------------------------------------------
# §13 Logging Audit (1 scenario) -- arch §04
# ---------------------------------------------------------------------------


# TST-BRAIN-418
def test_crash_13_8_logging_audit_no_pii() -> None:
    """§13.8: Logging audit -- no sqlite3 imports in brain source.

    Architecture §04: Brain must not import sqlite3 (that belongs to core).
    Scan all Python files under src/ for sqlite3 imports.
    """
    src_dir = Path(__file__).resolve().parents[1] / "src"
    assert src_dir.is_dir(), f"src/ directory not found at {src_dir}"

    violations: list[str] = []
    for py_file in src_dir.rglob("*.py"):
        content = py_file.read_text(encoding="utf-8", errors="replace")
        for lineno, line in enumerate(content.splitlines(), start=1):
            stripped = line.strip()
            # Skip comments
            if stripped.startswith("#"):
                continue
            if "import sqlite3" in stripped or "from sqlite3" in stripped:
                rel = py_file.relative_to(src_dir)
                violations.append(f"{rel}:{lineno}: {stripped}")

    assert violations == [], (
        "Brain source must not import sqlite3 (belongs to core):\n"
        + "\n".join(violations)
    )
