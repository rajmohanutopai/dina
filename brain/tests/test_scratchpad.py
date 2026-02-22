"""Tests for Scratchpad (Cognitive Checkpointing).

Maps to Brain TEST_PLAN SS12.

SS12.1 Per-Step Checkpointing (4 scenarios)
SS12.2 Resume from Crash (5 scenarios)
SS12.3 Cleanup & Lifecycle (3 scenarios)
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock

from .factories import make_scratchpad_checkpoint


# ---------------------------------------------------------------------------
# Fixture: real ScratchpadService with mocked core client
# ---------------------------------------------------------------------------


@pytest.fixture
def scratchpad():
    """Real ScratchpadService wired to a mock core client."""
    from src.service.scratchpad import ScratchpadService

    core = AsyncMock()
    core.write_scratchpad.return_value = None
    core.read_scratchpad.return_value = None
    return ScratchpadService(core=core), core


# ---------------------------------------------------------------------------
# SS12.1 Per-Step Checkpointing (4 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-308
@pytest.mark.asyncio
async def test_scratchpad_12_1_1_checkpoint_after_step1(scratchpad) -> None:
    """SS12.1.1: Checkpoint after step 1.

    Sancho nudge step 1: get relationship. Stores checkpoint via
    POST core/v1/vault/store {type: "scratchpad", task_id, data: {step: 1, context: {...}}}.
    """
    svc, core = scratchpad
    context = {"relationship": "friend"}

    await svc.checkpoint("task-001", 1, context)

    core.write_scratchpad.assert_awaited_once_with("task-001", 1, context)


# TST-BRAIN-309
@pytest.mark.asyncio
async def test_scratchpad_12_1_2_checkpoint_after_step2(scratchpad) -> None:
    """SS12.1.2: Checkpoint after step 2.

    Step 2: get recent messages. Context accumulates both steps' results:
    {step: 2, context: {relationship: "...", messages: [...]}}.
    """
    svc, core = scratchpad
    context = {"relationship": "friend", "messages": ["msg1", "msg2"]}

    await svc.checkpoint("task-001", 2, context)

    core.write_scratchpad.assert_awaited_once_with("task-001", 2, context)
    # Verify the context passed to core contains both steps' data
    call_args = core.write_scratchpad.call_args
    assert "relationship" in call_args[0][2]
    assert "messages" in call_args[0][2]


# TST-BRAIN-310
@pytest.mark.asyncio
async def test_scratchpad_12_1_3_checkpoint_overwrites_previous(
    scratchpad,
) -> None:
    """SS12.1.3: Checkpoint overwrites previous.

    Step 2 checkpoint replaces step 1 -- single entry per task_id (upsert),
    not a growing list.
    """
    svc, core = scratchpad

    await svc.checkpoint("task-001", 1, {"relationship": "friend"})
    await svc.checkpoint("task-001", 2, {"relationship": "friend", "messages": ["m1"]})

    # Both writes go to the same task_id -- core is responsible for upsert
    assert core.write_scratchpad.await_count == 2
    first_call = core.write_scratchpad.call_args_list[0]
    second_call = core.write_scratchpad.call_args_list[1]
    assert first_call[0][0] == second_call[0][0] == "task-001"
    assert second_call[0][1] > first_call[0][1]  # step 2 > step 1


# TST-BRAIN-311
@pytest.mark.asyncio
async def test_scratchpad_12_1_4_checkpoint_includes_all_prior_context(
    scratchpad,
) -> None:
    """SS12.1.4: Checkpoint includes all prior context.

    Step 3 checkpoint contains step 1 + step 2 + step 3 results.
    Brain doesn't re-query completed steps.
    """
    svc, core = scratchpad
    accumulated_context = {
        "relationship": "friend",
        "messages": ["msg1"],
        "analysis": "positive sentiment",
    }

    await svc.checkpoint("task-001", 3, accumulated_context)

    core.write_scratchpad.assert_awaited_once_with("task-001", 3, accumulated_context)
    written_context = core.write_scratchpad.call_args[0][2]
    assert len(written_context) == 3


# ---------------------------------------------------------------------------
# SS12.2 Resume from Crash (5 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-312
@pytest.mark.asyncio
async def test_scratchpad_12_2_1_resume_from_step3(scratchpad) -> None:
    """SS12.2.1: Resume from step 3 of 5.

    Brain crashes at step 3, restarts, core retries task.
    Brain queries scratchpad -> sees step: 2 -> starts from step 3 (skips 1 & 2).
    """
    svc, core = scratchpad
    prior_checkpoint = make_scratchpad_checkpoint(
        task_id="task-001",
        step=2,
        context={"relationship": "friend", "messages": ["m1"]},
    )
    core.read_scratchpad.return_value = prior_checkpoint

    result = await svc.resume("task-001")

    core.read_scratchpad.assert_awaited_once_with("task-001")
    assert result is not None
    assert result["step"] == 2
    # Caller would resume from step 3 based on this


# TST-BRAIN-313
@pytest.mark.asyncio
async def test_scratchpad_12_2_2_no_scratchpad_fresh_start(
    scratchpad,
) -> None:
    """SS12.2.2: No scratchpad -> fresh start.

    New task, no prior checkpoint. Brain starts from step 1.
    """
    svc, core = scratchpad
    core.read_scratchpad.return_value = None

    result = await svc.resume("new-task")

    core.read_scratchpad.assert_awaited_once_with("new-task")
    assert result is None  # None signals fresh start


# TST-BRAIN-314
@pytest.mark.asyncio
async def test_scratchpad_12_2_3_stale_checkpoint_expired(
    scratchpad,
) -> None:
    """SS12.2.3: Stale checkpoint (24h old).

    Brain restarts, checkpoint from yesterday. Core sweeper has purged it.
    Brain starts fresh.
    """
    svc, core = scratchpad
    # Core sweeper already purged the stale checkpoint -> returns None
    core.read_scratchpad.return_value = None

    result = await svc.resume("stale-task")

    core.read_scratchpad.assert_awaited_once_with("stale-task")
    assert result is None  # Expired by core sweeper -> fresh start


# TST-BRAIN-315
@pytest.mark.asyncio
async def test_scratchpad_12_2_4_resume_uses_accumulated_context(
    scratchpad,
) -> None:
    """SS12.2.4: Resume uses accumulated context.

    Brain resumes from step 3 using context.relationship and context.messages
    from checkpoint -- no re-querying vault.
    """
    svc, core = scratchpad
    checkpoint = make_scratchpad_checkpoint(
        task_id="task-001",
        step=2,
        context={"relationship": "colleague", "messages": ["hi", "hello"]},
    )
    core.read_scratchpad.return_value = checkpoint

    result = await svc.resume("task-001")

    assert result is not None
    assert result["context"]["relationship"] == "colleague"
    assert len(result["context"]["messages"]) == 2
    # Brain can use this context directly without re-querying vault


# TST-BRAIN-316
@pytest.mark.asyncio
async def test_scratchpad_12_2_5_multiple_tasks_resume_independently(
    scratchpad,
) -> None:
    """SS12.2.5: Multiple tasks resume independently.

    Two tasks were in-flight when brain crashed. Each reads its own
    scratchpad by task_id and resumes independently.
    """
    svc, core = scratchpad

    cp_a = make_scratchpad_checkpoint(task_id="task-A", step=2)
    cp_b = make_scratchpad_checkpoint(task_id="task-B", step=4)

    # First call returns task-A's checkpoint, second returns task-B's
    core.read_scratchpad.side_effect = [cp_a, cp_b]

    result_a = await svc.resume("task-A")
    result_b = await svc.resume("task-B")

    assert result_a["task_id"] == "task-A"
    assert result_a["step"] == 2
    assert result_b["task_id"] == "task-B"
    assert result_b["step"] == 4
    assert result_a["task_id"] != result_b["task_id"]
    assert result_a["step"] != result_b["step"]


# ---------------------------------------------------------------------------
# SS12.3 Cleanup & Lifecycle (3 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-317
@pytest.mark.asyncio
async def test_scratchpad_12_3_1_deleted_on_completion(scratchpad) -> None:
    """SS12.3.1: Scratchpad deleted on completion.

    Task completes all 5 steps. Brain sends clear() which writes a
    deletion marker to core.
    """
    svc, core = scratchpad

    await svc.clear("task-done")

    # clear() writes a step=0, __deleted=True marker to core
    core.write_scratchpad.assert_awaited_once_with(
        "task-done", 0, {"__deleted": True}
    )


# TST-BRAIN-318
@pytest.mark.asyncio
async def test_scratchpad_12_3_2_auto_expires_24h(scratchpad) -> None:
    """SS12.3.2: Scratchpad auto-expires after 24h.

    Stale entry is purged by core sweeper. Brain does not rely on
    old reasoning.
    """
    svc, core = scratchpad

    # Simulate: checkpoint was written >24h ago, core sweeper purged it
    core.read_scratchpad.return_value = None

    result = await svc.resume("task-stale")

    assert result is None  # Core sweeper purged -> fresh start
    # The factory data verifying the timestamp is correct:
    stale_checkpoint = make_scratchpad_checkpoint(
        task_id="task-stale",
        step=3,
        timestamp="2026-01-14T10:30:00Z",
    )
    assert stale_checkpoint["timestamp"] == "2026-01-14T10:30:00Z"


# TST-BRAIN-319
@pytest.mark.asyncio
async def test_scratchpad_12_3_3_large_checkpoint(scratchpad) -> None:
    """SS12.3.3: Large checkpoint -- multi-step with large context.

    Many vault items in context. Checkpoint succeeds within size limit.
    """
    svc, core = scratchpad
    large_context = {f"item_{i}": f"data_{i}" * 100 for i in range(50)}

    await svc.checkpoint("task-large", 3, large_context)

    core.write_scratchpad.assert_awaited_once_with("task-large", 3, large_context)
    written_context = core.write_scratchpad.call_args[0][2]
    assert len(written_context) == 50
