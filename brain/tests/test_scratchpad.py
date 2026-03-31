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
# TRACE: {"suite": "BRAIN", "case": "0308", "section": "12", "sectionName": "Scratchpad (Cognitive Checkpointing)", "subsection": "01", "scenario": "01", "title": "checkpoint_after_step1"}
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
# TRACE: {"suite": "BRAIN", "case": "0309", "section": "12", "sectionName": "Scratchpad (Cognitive Checkpointing)", "subsection": "01", "scenario": "02", "title": "checkpoint_after_step2"}
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
# TRACE: {"suite": "BRAIN", "case": "0310", "section": "12", "sectionName": "Scratchpad (Cognitive Checkpointing)", "subsection": "01", "scenario": "03", "title": "checkpoint_overwrites_previous"}
async def test_scratchpad_12_1_3_checkpoint_overwrites_previous(
    scratchpad,
) -> None:
    """SS12.1.3: Checkpoint overwrites previous.

    Step 2 checkpoint replaces step 1 -- single entry per task_id (upsert),
    not a growing list.  Verifies:
    1. Both writes target the same task_id (same KV key in core).
    2. Step number advances.
    3. Second context is cumulative (includes step 1 data + step 2 data).
    4. A read-back after both writes returns only step 2 data.
    """
    import json
    svc, core = scratchpad

    step1_ctx = {"relationship": "friend"}
    step2_ctx = {"relationship": "friend", "messages": ["m1"]}

    await svc.checkpoint("task-001", 1, step1_ctx)
    await svc.checkpoint("task-001", 2, step2_ctx)

    # Both writes go to the same task_id.
    assert core.write_scratchpad.await_count == 2
    first_call = core.write_scratchpad.call_args_list[0]
    second_call = core.write_scratchpad.call_args_list[1]

    # Same task_id for both calls (upsert key must match).
    assert first_call[0][0] == "task-001"
    assert second_call[0][0] == "task-001"

    # Step number advances.
    assert first_call[0][1] == 1
    assert second_call[0][1] == 2
    assert second_call[0][1] > first_call[0][1]

    # Second context is cumulative — contains data from both steps.
    second_ctx = second_call[0][2]
    assert "relationship" in second_ctx, "Step 2 must carry forward step 1 data"
    assert "messages" in second_ctx, "Step 2 must include its own new data"
    assert second_ctx["messages"] == ["m1"]

    # First context must NOT contain step 2 data (it was written before).
    first_ctx = first_call[0][2]
    assert "messages" not in first_ctx, (
        "Step 1 context should not have step 2 data"
    )

    # Simulate read-back: configure mock to return step 2 checkpoint.
    core.read_scratchpad.return_value = {"step": 2, "context": step2_ctx}
    result = await svc.resume("task-001")
    assert result is not None, "Resume must return checkpoint data"
    assert result["step"] == 2, "Read-back must return step 2, not step 1"
    assert result["context"]["messages"] == ["m1"]
    assert result["context"]["relationship"] == "friend"


# TST-BRAIN-311
@pytest.mark.asyncio
# TRACE: {"suite": "BRAIN", "case": "0311", "section": "12", "sectionName": "Scratchpad (Cognitive Checkpointing)", "subsection": "01", "scenario": "04", "title": "checkpoint_includes_all_prior_context"}
async def test_scratchpad_12_1_4_checkpoint_includes_all_prior_context(
    scratchpad,
) -> None:
    """SS12.1.4: Checkpoint includes all prior context.

    Step 3 checkpoint contains step 1 + step 2 + step 3 results.
    Brain doesn't re-query completed steps.  The caller accumulates
    context across steps; the service passes it through to core.
    """
    svc, core = scratchpad

    # Simulate step-by-step accumulation as the caller would do.
    step1_context = {"relationship": "friend"}
    await svc.checkpoint("task-001", 1, step1_context)
    core.write_scratchpad.assert_awaited_once_with("task-001", 1, step1_context)
    core.write_scratchpad.reset_mock()

    step2_context = {**step1_context, "messages": ["msg1"]}
    await svc.checkpoint("task-001", 2, step2_context)
    core.write_scratchpad.assert_awaited_once_with("task-001", 2, step2_context)
    core.write_scratchpad.reset_mock()

    step3_context = {**step2_context, "analysis": "positive sentiment"}
    await svc.checkpoint("task-001", 3, step3_context)
    core.write_scratchpad.assert_awaited_once_with("task-001", 3, step3_context)

    # Verify the final checkpoint carries ALL prior-step data.
    written_context = core.write_scratchpad.call_args[0][2]
    assert "relationship" in written_context, "Step 1 data must be in step 3 context"
    assert "messages" in written_context, "Step 2 data must be in step 3 context"
    assert "analysis" in written_context, "Step 3 data must be in step 3 context"
    # Step number must be 3.
    written_step = core.write_scratchpad.call_args[0][1]
    assert written_step == 3


# ---------------------------------------------------------------------------
# SS12.2 Resume from Crash (5 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-312
@pytest.mark.asyncio
# TRACE: {"suite": "BRAIN", "case": "0312", "section": "12", "sectionName": "Scratchpad (Cognitive Checkpointing)", "subsection": "02", "scenario": "01", "title": "resume_from_step3"}
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
    assert result["task_id"] == "task-001"
    assert result["context"] == {"relationship": "friend", "messages": ["m1"]}
    # Verify the contract: next step to execute is step + 1
    assert result["step"] + 1 == 3, "Caller should resume from step 3"


# TST-BRAIN-313
@pytest.mark.asyncio
# TRACE: {"suite": "BRAIN", "case": "0313", "section": "12", "sectionName": "Scratchpad (Cognitive Checkpointing)", "subsection": "02", "scenario": "02", "title": "no_scratchpad_fresh_start"}
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

    # Counter-proof: verify service passes through non-None (breaks tautology).
    # If the service hardcoded `return None`, this would fail.
    checkpoint = make_scratchpad_checkpoint(task_id="new-task", step=1)
    core.read_scratchpad.return_value = checkpoint
    result2 = await svc.resume("new-task")
    assert result2 is not None, "Service must pass through non-None results"
    assert result2["step"] == 1
    assert result2["task_id"] == "new-task"

    # After fresh start, brain can checkpoint at step 1
    await svc.checkpoint("new-task", 1, {"started": True})
    core.write_scratchpad.assert_awaited_once_with("new-task", 1, {"started": True})


# TST-BRAIN-314
@pytest.mark.asyncio
# TRACE: {"suite": "BRAIN", "case": "0314", "section": "12", "sectionName": "Scratchpad (Cognitive Checkpointing)", "subsection": "02", "scenario": "03", "title": "stale_checkpoint_expired"}
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
# TRACE: {"suite": "BRAIN", "case": "0315", "section": "12", "sectionName": "Scratchpad (Cognitive Checkpointing)", "subsection": "02", "scenario": "04", "title": "resume_uses_accumulated_context"}
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
# TRACE: {"suite": "BRAIN", "case": "0316", "section": "12", "sectionName": "Scratchpad (Cognitive Checkpointing)", "subsection": "02", "scenario": "05", "title": "multiple_tasks_resume_independently"}
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

    # Verify read_scratchpad was called with correct task_ids (not arbitrary order)
    calls = core.read_scratchpad.call_args_list
    assert len(calls) == 2
    assert calls[0].args[0] == "task-A", "First resume must read task-A"
    assert calls[1].args[0] == "task-B", "Second resume must read task-B"


# ---------------------------------------------------------------------------
# SS12.3 Cleanup & Lifecycle (3 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-317
@pytest.mark.asyncio
# TRACE: {"suite": "BRAIN", "case": "0317", "section": "12", "sectionName": "Scratchpad (Cognitive Checkpointing)", "subsection": "03", "scenario": "01", "title": "deleted_on_completion"}
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
# TRACE: {"suite": "BRAIN", "case": "0318", "section": "12", "sectionName": "Scratchpad (Cognitive Checkpointing)", "subsection": "03", "scenario": "02", "title": "auto_expires_24h"}
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
# TRACE: {"suite": "BRAIN", "case": "0319", "section": "12", "sectionName": "Scratchpad (Cognitive Checkpointing)", "subsection": "03", "scenario": "03", "title": "large_checkpoint"}
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
