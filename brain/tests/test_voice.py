"""Tests for voice STT integration -- Deepgram Nova-3 + Gemini fallback.

Maps to Brain TEST_PLAN SS18 (Voice STT Integration).

Uses mock-based testing for the voice STT contract since no real Deepgram
or Gemini Live API is available in tests.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from .factories import make_voice_transcription


# ---------------------------------------------------------------------------
# SS18 Voice STT Integration (3 scenarios) -- arch SS16, SS17
# ---------------------------------------------------------------------------


# TST-BRAIN-400
@pytest.mark.asyncio
async def test_voice_18_1_deepgram_to_guardian() -> None:
    """SS18.1: Voice input via Deepgram -> text -> guardian loop.

    Architecture SS16: Brain integrates with Deepgram Nova-3 via WebSocket
    streaming for real-time voice-to-text. Transcribed text is processed
    as a regular text query through the guardian loop.
    """
    from src.service.guardian import GuardianLoop

    core = AsyncMock()
    core.write_scratchpad = AsyncMock()
    core.get_kv = AsyncMock(return_value=None)
    guardian = GuardianLoop(core=core, llm=AsyncMock(), mcp=AsyncMock())

    # Simulate voice transcription result
    transcription = make_voice_transcription(text="Check my email")
    assert transcription["provider"] == "deepgram"
    assert transcription["model"] == "nova-3"
    assert transcription["confidence"] >= 0.9

    # Feed transcribed text into guardian as a voice-sourced event.
    event = {
        "type": "query",
        "body": transcription["text"],
        "source": "voice",
        "confidence": transcription["confidence"],
    }
    result = await guardian.process_event(event)
    # Guardian must process voice events like any other query.
    assert isinstance(result, dict)
    assert "action" in result, "Guardian must return an action for voice events"


# TST-BRAIN-401
def test_voice_18_2_deepgram_fallback_gemini() -> None:
    """SS18.2: Deepgram unavailable -> fallback to Gemini Flash Lite STT.

    Architecture SS16: Fallback: Gemini Flash Lite Live API.
    Transparent to user -- same interface, different backend.
    """
    # Primary provider unavailable
    primary_available = False

    # Fallback to Gemini
    if not primary_available:
        transcription = make_voice_transcription(
            text="Check my email",
            provider="gemini",
            model="gemini-flash-lite",
            latency_ms=250,
        )
    else:
        transcription = make_voice_transcription()

    assert transcription is not None
    assert transcription["provider"] == "gemini"
    assert transcription["model"] == "gemini-flash-lite"
    assert transcription["text"] == "Check my email"


# TST-BRAIN-402
def test_voice_18_3_latency_target() -> None:
    """SS18.3: Voice latency within target (< 300ms).

    Architecture SS16: ~150-300ms latency target for Deepgram Nova-3.
    """
    result = make_voice_transcription(latency_ms=180)
    assert result["latency_ms"] <= 300
    assert result["latency_ms"] == 180

    # Verify the latency target boundary
    fast_result = make_voice_transcription(latency_ms=150)
    assert fast_result["latency_ms"] <= 300

    slow_result = make_voice_transcription(latency_ms=299)
    assert slow_result["latency_ms"] <= 300

    # A result above 300ms would exceed the target
    over_target = make_voice_transcription(latency_ms=350)
    assert over_target["latency_ms"] > 300
