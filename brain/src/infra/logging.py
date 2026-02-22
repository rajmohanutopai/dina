"""Structured logging configuration for dina-brain.

Maps to Brain TEST_PLAN SS13.8 (Logging Audit — no PII in brain log output).

Architecture SS04 rule: brain log output MUST NOT contain vault content,
user queries, PII, brain reasoning output, NaCl plaintext,
passphrase/keys, or API tokens.  Only metadata is allowed: timestamps,
endpoint, persona_id, query type, error codes, item counts, latency.

Uses ``structlog`` for JSON-formatted structured logging in production
and pretty console output in development.
"""

from __future__ import annotations

import logging
import sys
import uuid

import structlog


def setup_logging(level: str = "INFO") -> None:
    """Configure structlog and stdlib logging for the brain process.

    Parameters:
        level: Logging level string (e.g. ``"INFO"``, ``"DEBUG"``).
               Defaults to ``"INFO"``.

    Behaviour:
        * ``level == "DEBUG"`` -> coloured console output (dev mode).
        * All other levels    -> JSON lines to stdout (production mode).
        * A ``request_id`` is bound to each log entry for distributed
          tracing across core <-> brain.
    """
    numeric_level = getattr(logging, level.upper(), logging.INFO)
    is_dev = level.upper() == "DEBUG"

    # Shared processors applied to every log entry
    shared_processors: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.UnicodeDecoder(),
    ]

    if is_dev:
        # Human-friendly coloured console output for local development
        renderer: structlog.types.Processor = structlog.dev.ConsoleRenderer()
    else:
        # Machine-parseable JSON lines for Docker / production
        renderer = structlog.processors.JSONRenderer()

    structlog.configure(
        processors=[
            *shared_processors,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            renderer,
        ],
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.addHandler(handler)
    root_logger.setLevel(numeric_level)

    # Suppress noisy third-party loggers
    for noisy in ("httpx", "httpcore", "uvicorn.access"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def bind_request_id(request_id: str | None = None) -> str:
    """Bind a ``request_id`` to the current structlog context.

    If no *request_id* is provided a new UUID4 is generated.

    Returns:
        The bound request ID (useful for propagating to downstream calls).
    """
    rid = request_id or uuid.uuid4().hex[:12]
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(request_id=rid)
    return rid
