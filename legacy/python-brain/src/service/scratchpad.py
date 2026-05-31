"""Cognitive checkpointing for crash recovery.

The scratchpad service writes per-step checkpoints to core's vault so that
a multi-step reasoning task can resume from the last successful step after
a crash or restart.

Maps to Brain TEST_PLAN SS12 (Scratchpad).

Architecture invariants:
    - One checkpoint per task_id at any time (upsert, not append).
    - Each checkpoint accumulates all prior-step context so the guardian
      never re-queries completed steps.
    - Checkpoints are cleared after task completion.
    - Core's sweeper auto-expires entries after 24 hours.

No imports from adapter/ — only port protocols and domain types.
"""

from __future__ import annotations

import structlog

from ..port.core_client import CoreClient

log = structlog.get_logger(__name__)


class ScratchpadService:
    """Write / read / clear cognitive checkpoints via core's scratchpad API.

    Parameters
    ----------
    core:
        Typed HTTP client for dina-core. Used for all persistence calls —
        the scratchpad service never touches the filesystem directly.
    """

    def __init__(self, core: CoreClient) -> None:
        self._core = core

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def checkpoint(
        self, task_id: str, step: int, context: dict
    ) -> None:
        """Write a checkpoint to core scratchpad.

        Each call upserts the single entry for *task_id*.  The *context*
        dict should contain the accumulated results from all steps up to
        and including *step* so that a resumed task can skip every
        already-completed step.

        Parameters
        ----------
        task_id:
            Correlates with ``dina_tasks.id`` in core's task queue.
        step:
            1-based step number just completed.
        context:
            Accumulated reasoning context (relationship data, messages,
            analysis results, etc.).
        """
        log.info(
            "scratchpad.checkpoint",
            task_id=task_id,
            step=step,
            context_keys=list(context.keys()),
        )
        await self._core.write_scratchpad(task_id, step, context)

    async def resume(self, task_id: str) -> dict | None:
        """Read the latest checkpoint for *task_id*.

        Returns
        -------
        dict or None
            The checkpoint dict (with ``step``, ``context``, etc.) if one
            exists, or ``None`` for a fresh start (no prior checkpoint or
            checkpoint expired by core's 24-hour sweeper).
        """
        result = await self._core.read_scratchpad(task_id)
        if result is None:
            log.info("scratchpad.resume.fresh_start", task_id=task_id)
        else:
            log.info(
                "scratchpad.resume.found",
                task_id=task_id,
                step=result.get("step"),
            )
        return result

    async def clear(self, task_id: str) -> None:
        """Clear scratchpad after task completion.

        Sends a ``scratchpad_delete`` marker to core so the entry is
        removed immediately rather than waiting for the 24-hour sweeper.
        """
        log.info("scratchpad.clear", task_id=task_id)
        # Core interprets step=0 + empty context as a delete signal,
        # or we can use a dedicated write_scratchpad with a sentinel.
        # We write an empty context with step 0 to signal deletion.
        await self._core.write_scratchpad(task_id, 0, {"__deleted": True})
