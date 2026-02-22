"""Domain enumerations for dina-brain.

Enums define closed sets of values used across the domain layer.
No imports from adapter/ or infra/ are permitted here.
"""

from __future__ import annotations

from enum import Enum


class Priority(Enum):
    """Silence-First priority tiers (The Four Laws, Law 1).

    FIDUCIARY  = interrupt — silence causes harm (flight cancel, security alert).
    SOLICITED  = notify   — user explicitly asked for this information.
    ENGAGEMENT = silent   — save for briefing; silence merely misses an opportunity.
    """

    FIDUCIARY = 1
    SOLICITED = 2
    ENGAGEMENT = 3


class SilenceDecision(Enum):
    """Action decision from silence classification.

    Maps the Priority tier to a concrete delivery action.
    """

    INTERRUPT = "interrupt"
    NOTIFY = "notify"
    SILENT = "silent"


class LLMProvider(Enum):
    """Supported LLM providers for the routing decision tree.

    LLAMA  = local on-device model (best privacy, no PII leaves node).
    GEMINI = Google cloud model (requires PII scrubbing before send).
    CLAUDE = Anthropic cloud model (requires PII scrubbing before send).
    """

    LLAMA = "llama"
    GEMINI = "gemini"
    CLAUDE = "claude"


class IntentRisk(Enum):
    """Risk classification for agent intents (Agent Safety Layer).

    SAFE    = auto-approve, no user review (e.g. fetch_weather).
    RISKY   = flag for user review before execution (e.g. send_email).
    BLOCKED = deny outright, no user prompt needed (e.g. untrusted bot reading vault).
    """

    SAFE = "safe"
    RISKY = "risky"
    BLOCKED = "blocked"


class TaskType(Enum):
    """Task types dispatched through the guardian loop.

    PROCESS = standard event processing (triage, classify, store).
    REASON  = multi-step LLM reasoning with scratchpad checkpointing.
    """

    PROCESS = "process"
    REASON = "reason"
