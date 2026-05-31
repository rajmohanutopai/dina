"""Typed exceptions for dina-brain.

All brain-specific errors inherit from DinaError so callers can catch
the full family with a single handler.  Each subclass carries semantic
meaning that maps to a specific failure mode in the architecture.

No imports from adapter/ or infra/ are permitted here.
"""

from __future__ import annotations


class DinaError(Exception):
    """Base exception for all dina-brain errors.

    Callers can ``except DinaError`` to catch every brain-specific failure.
    """


class PersonaLockedError(DinaError):
    """Core returned HTTP 403 — the requested persona vault is locked.

    The guardian should whisper an unlock request to the user and queue
    the original query for retry after the persona_unlocked event.
    """


class AuthorizationError(DinaError):
    """Core returned HTTP 403 for authorization/policy reasons (not persona lock)."""


class ApprovalRequiredError(DinaError):
    """Core returned HTTP 403 with ``approval_required`` — agent needs user approval.

    The approval request has already been created by Core and a notification
    sent to the user (WebSocket + Telegram).  The CLI should inform the user
    and exit; retrying the same query after approval will succeed.
    """

    def __init__(self, persona: str = "", approval_id: str = "", message: str = ""):
        self.persona = persona
        self.approval_id = approval_id
        super().__init__(message or f"Approval required for persona '{persona}' (id={approval_id})")


class CoreUnreachableError(DinaError):
    """Core HTTP endpoint is not responding.

    After exhausting retries with exponential backoff the brain enters
    degraded mode.  Fiduciary events are still delivered via stdout
    one-liner; all other processing is paused until core recovers.
    """


class LLMError(DinaError):
    """LLM provider error or timeout.

    Covers connection failures, HTTP 5xx from cloud providers, rate
    limiting (HTTP 429), malformed responses, and hard timeouts.
    The LLM router uses this to trigger fallback logic (local <-> cloud).
    """


class MCPError(DinaError):
    """MCP agent delegation failed.

    The MCP client raises this when call_tool encounters a connection
    error, protocol violation, or the remote agent times out (>30 s).
    The agent router catches it and falls back to local LLM processing.
    """


class TelegramError(DinaError):
    """Telegram Bot API communication failed.

    Raised by the Telegram adapter when the Bot API returns an error,
    the connection times out, or the bot token is invalid.
    """


class PIIScrubError(DinaError):
    """PII scrubbing failed — blocks cloud send.

    When either Tier 1 (Go regex via core) or Tier 2 (Python spaCy)
    fails, the brain MUST NOT send unscrubbed data to a cloud LLM.
    This is a hard security gate, not a soft preference.
    """


class ConfigError(DinaError):
    """Configuration error detected at startup.

    Raised by ``load_brain_config()`` when required environment
    variables are missing (e.g. service key directory) or values are invalid
    (e.g. CORE_URL is not a valid URL).
    """


class WorkflowConflictError(DinaError):
    """Core returned HTTP 409 on a workflow task endpoint.

    Typically means the task already exists (duplicate create) or the
    requested transition is not legal (e.g. cancelling an already-terminal
    task). Callers that treat these as idempotent no-ops should catch this
    exception explicitly rather than pattern-matching HTTP error text.
    """


class CloudConsentError(DinaError):
    """Cloud LLM consent has not been given by the user.

    Architecture rule: cloud LLM users must explicitly acknowledge
    consent during setup.  Without the consent flag, sensitive-persona
    queries to cloud are blocked even if Entity Vault scrubbing would
    technically work.
    """
