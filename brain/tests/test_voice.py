"""Tests for voice STT integration — Deepgram Nova-3 + Gemini fallback.

Maps to Brain TEST_PLAN §18 (Voice STT Integration).
"""

from __future__ import annotations

import pytest


# ---------------------------------------------------------------------------
# §18 Voice STT Integration (3 scenarios) — arch §16, §17
# ---------------------------------------------------------------------------


# TST-BRAIN-400
def test_voice_18_1_deepgram_to_guardian(mock_guardian) -> None:
    """§18.1: Voice input via Deepgram → text → guardian loop.

    Architecture §16: Brain integrates with Deepgram Nova-3 via WebSocket
    streaming for real-time voice-to-text. Transcribed text is processed
    as a regular text query through the guardian loop.
    """
    pytest.skip("Voice STT integration not yet implemented")
    # audio_stream = b"\x00" * 1024  # mock audio
    # transcription = await voice_client.transcribe_stream(audio_stream)
    # assert transcription == "Check my email"
    # result = await mock_guardian.process_event({"type": "query", "body": transcription})
    # assert result is not None


# TST-BRAIN-401
def test_voice_18_2_deepgram_fallback_gemini() -> None:
    """§18.2: Deepgram unavailable → fallback to Gemini Flash Lite STT.

    Architecture §16: Fallback: Gemini Flash Lite Live API.
    Transparent to user — same interface, different backend.
    """
    pytest.skip("Voice STT fallback not yet implemented")
    # voice_client.is_primary_available = MagicMock(return_value=False)
    # transcription = await voice_client.transcribe_fallback(audio_stream)
    # assert transcription is not None


# TST-BRAIN-402
def test_voice_18_3_latency_target() -> None:
    """§18.3: Voice latency within target (< 300ms).

    Architecture §16: ~150-300ms latency target for Deepgram Nova-3.
    """
    pytest.skip("Voice STT latency verification not yet implemented")
    # result = make_voice_transcription(latency_ms=180)
    # assert result["latency_ms"] <= 300
