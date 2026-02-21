"""Test data factories for dina-brain tests.

Builders produce deterministic test data for events, messages, tokens, and PII text.
"""

from __future__ import annotations

import time
from typing import Any


# ---------- Events (§2 Guardian Loop) ----------


def make_event(type: str = "message", **overrides: Any) -> dict:
    """Create a base event with sensible defaults."""
    base = {
        "type": type,
        "timestamp": "2026-01-01T00:00:00Z",
        "persona_id": "default",
        "source": "test",
    }
    base.update(overrides)
    return base


def make_fiduciary_event(**overrides: Any) -> dict:
    """Create a fiduciary-priority event (silence causes harm)."""
    defaults = {
        "priority": "fiduciary",
        "body": "Your flight is cancelled in 2 hours",
    }
    defaults.update(overrides)
    return make_event(type=defaults.pop("type", "alert"), **defaults)


def make_solicited_event(**overrides: Any) -> dict:
    """Create a solicited-priority event (user asked for this)."""
    defaults = {
        "priority": "solicited",
        "body": "Meeting reminder: Team standup in 15 minutes",
    }
    defaults.update(overrides)
    return make_event(type=defaults.pop("type", "reminder"), **defaults)


def make_engagement_event(**overrides: Any) -> dict:
    """Create an engagement-priority event (nice-to-know)."""
    defaults = {
        "priority": "engagement",
        "body": "New episode of your podcast released",
    }
    defaults.update(overrides)
    return make_event(type=defaults.pop("type", "notification"), **defaults)


def make_security_alert(**overrides: Any) -> dict:
    """Create a security fiduciary event."""
    defaults = {
        "priority": "fiduciary",
        "body": "Unusual login from new device in Singapore",
        "source": "security",
    }
    defaults.update(overrides)
    return make_event(type=defaults.pop("type", "alert"), **defaults)


def make_health_alert(**overrides: Any) -> dict:
    """Create a health fiduciary event."""
    defaults = {
        "priority": "fiduciary",
        "body": "Critical lab result: potassium level 6.2 mEq/L — contact your physician immediately",
        "source": "health_system",
    }
    defaults.update(overrides)
    return make_event(type=defaults.pop("type", "alert"), **defaults)


def make_financial_alert(**overrides: Any) -> dict:
    """Create a financial fiduciary event."""
    defaults = {
        "priority": "fiduciary",
        "body": "Payment due in 1 hour, account overdrawn",
        "source": "bank",
    }
    defaults.update(overrides)
    return make_event(type=defaults.pop("type", "alert"), **defaults)


def make_vault_unlocked_event(**overrides: Any) -> dict:
    """Create a vault_unlocked lifecycle event."""
    defaults = dict(overrides)
    return make_event(type=defaults.pop("type", "vault_unlocked"), **defaults)


def make_vault_locked_event(**overrides: Any) -> dict:
    """Create a vault_locked lifecycle event."""
    defaults = {"persona_id": "financial"}
    defaults.update(overrides)
    return make_event(type=defaults.pop("type", "vault_locked"), **defaults)


# ---------- Agent Intents (§2.3 Guardian Execution) ----------


def make_safe_intent(**overrides: Any) -> dict:
    """Create an auto-approvable agent intent."""
    base = {
        "type": "agent_intent",
        "agent_did": "did:key:z6MkWeatherBot",
        "action": "fetch_weather",
        "target": "zip:94105",
        "risk_level": "safe",
    }
    base.update(overrides)
    return base


def make_risky_intent(**overrides: Any) -> dict:
    """Create a risky intent requiring user review."""
    base = {
        "type": "agent_intent",
        "agent_did": "did:key:z6MkEmailBot",
        "action": "send_email",
        "target": "boss@company.com",
        "risk_level": "risky",
        "attachment": True,
    }
    base.update(overrides)
    return base


def make_blocked_intent(**overrides: Any) -> dict:
    """Create an intent that should be blocked."""
    base = {
        "type": "agent_intent",
        "agent_did": "did:key:z6MkUntrustedBot",
        "action": "read_vault",
        "target": "financial",
        "risk_level": "blocked",
        "trust_level": "untrusted",
    }
    base.update(overrides)
    return base


# ---------- Email / Sync Data (§5 Sync Engine) ----------


def make_email_metadata(
    message_id: str = "msg-001",
    sender: str = "friend@example.com",
    subject: str = "Hello from a friend",
    category: str = "PRIMARY",
    **overrides: Any,
) -> dict:
    """Create Gmail-style email metadata."""
    base = {
        "source": "gmail",
        "source_id": message_id,
        "type": "email",
        "sender": sender,
        "subject": subject,
        "category": category,
        "timestamp": "2026-01-15T10:30:00Z",
    }
    base.update(overrides)
    return base


def make_email_batch(n: int = 10, **overrides: Any) -> list[dict]:
    """Create a batch of email metadata items."""
    return [
        make_email_metadata(
            message_id=f"msg-{i:04d}",
            subject=f"Test email #{i}",
            **overrides,
        )
        for i in range(n)
    ]


def make_calendar_event(**overrides: Any) -> dict:
    """Create a calendar event item."""
    base = {
        "source": "calendar",
        "source_id": "cal-001",
        "type": "event",
        "summary": "Team standup",
        "body_text": "Daily standup meeting with engineering team",
        "timestamp": "2026-01-15T09:00:00Z",
        "metadata": '{"attendees": ["alice@co.com", "bob@co.com"]}',
    }
    base.update(overrides)
    return base


# ---------- PII Text (§3 PII Scrubber) ----------


def make_pii_text(include: tuple[str, ...] = ("email", "phone")) -> str:
    """Create text containing specified PII types."""
    parts = []
    if "email" in include:
        parts.append("Contact john@example.com")
    if "phone" in include:
        parts.append("or call 555-123-4567")
    if "ssn" in include:
        parts.append("SSN: 123-45-6789")
    if "credit_card" in include:
        parts.append("Card: 4111-1111-1111-1111")
    if "person" in include:
        parts.append("Ask John Smith")
    if "org" in include:
        parts.append("at Google Inc.")
    if "location" in include:
        parts.append("in San Francisco, CA")
    if "medical" in include:
        parts.append("diagnosed with L4-L5 disc herniation")
    return " ".join(parts) if parts else "The weather is nice today"


def make_pii_entities(types: tuple[str, ...] = ("email", "phone")) -> list[dict]:
    """Create expected PII entity results."""
    entities = []
    if "email" in types:
        entities.append({"type": "EMAIL", "value": "john@example.com", "token": "[EMAIL_1]"})
    if "phone" in types:
        entities.append({"type": "PHONE", "value": "555-123-4567", "token": "[PHONE_1]"})
    if "ssn" in types:
        entities.append({"type": "SSN", "value": "123-45-6789", "token": "[SSN_1]"})
    if "person" in types:
        entities.append({"type": "PERSON", "value": "John Smith", "token": "[PERSON_1]"})
    if "org" in types:
        entities.append({"type": "ORG", "value": "Google Inc.", "token": "[ORG_1]"})
    if "location" in types:
        entities.append({"type": "LOC", "value": "San Francisco, CA", "token": "[LOC_1]"})
    return entities


# ---------- LLM / Routing (§4, §8) ----------


def make_llm_response(content: str = "Test response", **overrides: Any) -> dict:
    """Create a mock LLM response."""
    base = {
        "content": content,
        "model": "test-model",
        "tokens_in": 10,
        "tokens_out": 5,
        "finish_reason": "stop",
    }
    base.update(overrides)
    return base


def make_routing_task(task_type: str = "summarize", **overrides: Any) -> dict:
    """Create a task for the agent router."""
    base = {
        "type": task_type,
        "prompt": "Summarize the meeting notes",
        "persona_id": "personal",
        "persona_tier": "open",
    }
    base.update(overrides)
    return base


# ---------- MCP / Core Client (§6, §7) ----------


def make_mcp_tool(name: str = "gmail_fetch", **overrides: Any) -> dict:
    """Create an MCP tool descriptor."""
    base = {
        "name": name,
        "description": f"Tool: {name}",
        "parameters": {"type": "object", "properties": {}},
    }
    base.update(overrides)
    return base


def make_vault_item(item_id: str = "item-001", **overrides: Any) -> dict:
    """Create a vault item for core client tests."""
    base = {
        "id": item_id,
        "type": "email",
        "source": "gmail",
        "source_id": "msg-abc123",
        "summary": "Meeting reminder for Thursday",
        "body_text": "Hi, reminder about our meeting on Thursday at 2pm.",
        "timestamp": 1700000000,
        "ingested_at": 1700000001,
    }
    base.update(overrides)
    return base


# ---------- Auth Tokens (§1) ----------


# Deterministic test tokens
TEST_BRAIN_TOKEN = "test-brain-token-" + "a" * 46
TEST_BRAIN_TOKEN_WRONG = "wrong-brain-token-" + "b" * 46
TEST_CLIENT_TOKEN = "test-client-token-" + "c" * 46


# ---------- Config (§9) ----------


def make_brain_config(**overrides: Any) -> dict:
    """Create a brain config dict."""
    base = {
        "CORE_URL": "http://core:8300",
        "BRAIN_TOKEN": TEST_BRAIN_TOKEN,
        "LISTEN_PORT": 8200,
        "LOG_LEVEL": "INFO",
    }
    base.update(overrides)
    return base


# ---------- Scratchpad / Crash (§2.3, §12, §13) ----------


def make_scratchpad_checkpoint(
    task_id: str = "task-001", step: int = 1, **overrides: Any
) -> dict:
    """Create a scratchpad checkpoint."""
    base = {
        "task_id": task_id,
        "step": step,
        "context": {"accumulated": f"data through step {step}"},
        "timestamp": "2026-01-15T10:30:00Z",
    }
    base.update(overrides)
    return base


def make_crash_report(**overrides: Any) -> dict:
    """Create a crash report for the crash handler."""
    base = {
        "error": "RuntimeError",
        "traceback": "Traceback (most recent call last):\n  File ...\nRuntimeError: test",
        "task_id": "task-001",
    }
    base.update(overrides)
    return base


# ---------- Admin UI (§8) ----------


def make_contact(
    did: str = "did:key:z6MkAliceFriend",
    name: str = "Alice",
    trust_level: str = "verified",
    **overrides: Any,
) -> dict:
    """Create a contact entry for admin UI tests."""
    base = {
        "did": did,
        "name": name,
        "trust_level": trust_level,
        "sharing_tier": "open",
        "created_at": "2026-01-01T00:00:00Z",
    }
    base.update(overrides)
    return base


def make_device(
    device_id: str = "dev-001",
    name: str = "iPhone 15",
    **overrides: Any,
) -> dict:
    """Create a paired device entry for admin UI tests."""
    base = {
        "device_id": device_id,
        "name": name,
        "last_seen": "2026-01-15T10:30:00Z",
        "paired_at": "2026-01-01T00:00:00Z",
        "status": "active",
    }
    base.update(overrides)
    return base


def make_persona(
    persona_id: str = "personal",
    tier: str = "open",
    **overrides: Any,
) -> dict:
    """Create a persona entry for admin UI tests."""
    base = {
        "persona_id": persona_id,
        "name": persona_id.title(),
        "tier": tier,
        "item_count": 42,
        "created_at": "2026-01-01T00:00:00Z",
    }
    base.update(overrides)
    return base


def make_system_status(
    core: str = "healthy",
    llm: str = "available",
    **overrides: Any,
) -> dict:
    """Create a system status response for admin dashboard tests."""
    base = {
        "core": core,
        "llm": llm,
        "memory": "ok",
        "uptime_seconds": 86400,
    }
    base.update(overrides)
    return base


def make_activity_entry(
    action: str = "verdict_stored",
    **overrides: Any,
) -> dict:
    """Create an activity log entry for admin dashboard tests."""
    base = {
        "action": action,
        "timestamp": "2026-01-15T10:30:00Z",
        "details": f"Action: {action}",
    }
    base.update(overrides)
    return base


# ---------- Embedding (§14) ----------


def make_embedding(
    dimensions: int = 768,
    source_id: str = "vault_a1b2c3",
    **overrides: Any,
) -> dict:
    """Create an embedding result for embedding generation tests."""
    base = {
        "vector": [0.1] * dimensions,
        "dimensions": dimensions,
        "source_id": source_id,
        "model": "embedding-gemma",
    }
    base.update(overrides)
    return base


# ---------- Task ACK (§2.3) ----------


def make_task_ack(task_id: str = "task-001", **overrides: Any) -> dict:
    """Create a task ACK payload for core."""
    base = {
        "task_id": task_id,
        "status": "done",
        "processed_at": "2026-01-15T10:30:00Z",
    }
    base.update(overrides)
    return base


def make_task_event(task_id: str = "task-001", **overrides: Any) -> dict:
    """Create a task event as received from core's task queue."""
    base = {
        "task_id": task_id,
        "type": "process",
        "payload": {"event": "sync_complete", "source": "gmail", "count": 42},
        "attempt": 1,
        "timeout_at": "2026-01-15T10:35:00Z",
    }
    base.update(overrides)
    return base


# ---------- Voice STT (§18) ----------


def make_voice_transcription(text: str = "Check my email", **overrides: Any) -> dict:
    """Create a voice transcription result."""
    base = {
        "text": text,
        "confidence": 0.95,
        "provider": "deepgram",
        "latency_ms": 180,
        "model": "nova-3",
    }
    base.update(overrides)
    return base


# ---------- Bot Response (§6.2) ----------


def make_bot_response(content: str = "The Aeron chair is highly rated", **overrides: Any) -> dict:
    """Create a bot/agent response for PII validation tests."""
    base = {
        "content": content,
        "bot_did": "did:key:z6MkChairBot",
        "attribution": {
            "source_url": "https://example.com/review",
            "creator_name": "Expert Reviewer",
        },
        "confidence": 0.88,
    }
    base.update(overrides)
    return base


# ---------- Reputation (§6.1) ----------


def make_reputation_score(did: str = "did:key:z6MkChairBot", **overrides: Any) -> dict:
    """Create a reputation score result from AppView."""
    base = {
        "did": did,
        "overall_score": 0.85,
        "transaction_count": 42,
        "attestation_count": 7,
        "last_updated": "2026-01-10T00:00:00Z",
    }
    base.update(overrides)
    return base


# ---------- D2D Messages (§2.8) ----------


def make_didcomm_message(
    msg_type: str = "dina/social/arrival",
    from_did: str = "did:plc:sancho123",
    **overrides: Any,
) -> dict:
    """Create a DIDComm message for D2D tests."""
    base = {
        "type": msg_type,
        "from": from_did,
        "to": "did:plc:user123",
        "body": {"summary": "Arriving in 15 minutes"},
        "created_time": "2026-01-15T10:30:00Z",
    }
    base.update(overrides)
    return base


# ---------- Hybrid Search (§4.1) ----------


def make_search_result(
    item_id: str = "item-001",
    fts5_rank: float = 0.8,
    cosine_sim: float = 0.7,
    **overrides: Any,
) -> dict:
    """Create a search result with both FTS5 rank and cosine similarity scores."""
    base = {
        "id": item_id,
        "type": "email",
        "summary": "Meeting notes from Thursday",
        "fts5_rank": fts5_rank,
        "cosine_similarity": cosine_sim,
        "relevance": 0.4 * fts5_rank + 0.6 * cosine_sim,
    }
    base.update(overrides)
    return base
