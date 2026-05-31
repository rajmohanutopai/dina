"""Safe crash handler for the guardian loop.

Maps to Brain TEST_PLAN SS13 (Crash Traceback Safety).

Problem: Python tracebacks include local variable values.  If brain
crashes mid-reasoning, the traceback could contain PII (e.g.
``query="find emails about my cancer diagnosis"``).

Solution:
    1. Sanitised one-liner to stdout (type + line number only).
    2. Full traceback stored in encrypted vault via core's scratchpad API.
    3. Traceback is NEVER written to a file on disk.
    4. Crash report includes ``task_id`` for debugging correlation.
    5. After logging + vault write the error is re-raised so Docker's
       restart policy triggers a container restart.
"""

from __future__ import annotations

import re
import sys
import traceback

import structlog

logger = structlog.stdlib.get_logger(__name__)

# Pattern to extract type and line number from a traceback
_LINE_PATTERN = re.compile(r'File ".*?", line (\d+)')


def _sanitize_oneliner(error: BaseException) -> str:
    """Build a PII-free one-liner from an exception.

    Format: ``"guardian crash: <ErrorType> at line <N>"``

    Only the error class name and the line number from the deepest
    frame are included.  No local variable values, no message text.
    """
    error_type = type(error).__name__
    tb = traceback.format_exception(type(error), error, error.__traceback__)
    tb_text = "".join(tb)

    # Find the last (deepest) line number
    matches = _LINE_PATTERN.findall(tb_text)
    line_number = matches[-1] if matches else "unknown"

    return f"guardian crash: {error_type} at line {line_number}"


def _build_crash_report(error: BaseException, task_id: str | None) -> dict:
    """Build a full crash report dict for vault storage.

    The report contains the unsanitised traceback which may include PII.
    It is stored only in the encrypted vault (via scratchpad), never
    written to a file or logged to stdout.
    """
    tb_lines = traceback.format_exception(
        type(error), error, error.__traceback__
    )
    return {
        "error": type(error).__name__,
        "traceback": "".join(tb_lines),
        "task_id": task_id or "unknown",
    }


async def handle_crash(
    error: BaseException,
    task_id: str | None = None,
    core_client: object | None = None,
) -> None:
    """Handle an unrecoverable crash in the guardian loop.

    Steps:
        1. Write a sanitised one-liner to stdout (always succeeds).
        2. Attempt to store the full traceback in the encrypted vault
           via the core scratchpad API.  If core is also down the
           write fails silently — the traceback is lost but the task
           will be retried on restart.
        3. Re-raise the original error so Docker's restart policy
           triggers a container restart.

    Parameters:
        error:       The caught exception.
        task_id:     The in-flight task ID for debugging correlation.
        core_client: An object implementing the ``CoreClient`` protocol.
                     If ``None`` the vault write is skipped.
    """
    # Step 1 — sanitised one-liner (always works, no PII)
    oneliner = _sanitize_oneliner(error)
    print(oneliner, file=sys.stderr, flush=True)
    logger.error("guardian_crash", error_type=type(error).__name__, task_id=task_id)

    # Step 2 — full traceback to encrypted vault (best-effort)
    if core_client is not None:
        report = _build_crash_report(error, task_id)
        try:
            # Use write_scratchpad to store the crash report.  Step 0
            # is reserved for crash data by convention.
            await core_client.write_scratchpad(  # type: ignore[union-attr]
                task_id or "crash",
                0,
                report,
            )
        except Exception:
            # Core is down too — traceback lost.  The task will be
            # retried on container restart via the task-queue timeout.
            logger.warning(
                "crash_report_storage_failed",
                task_id=task_id,
                reason="core_unreachable",
            )

    # Step 3 — re-raise so Docker restart policy kicks in
    raise error
