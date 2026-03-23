"""PII scrub/rehydrate session persistence."""

from __future__ import annotations

import json
import os
import uuid
from collections import defaultdict
from pathlib import Path


class SessionStore:
    """Persist PII scrub sessions so scrubbed text can be rehydrated later."""

    def __init__(self, base_dir: Path | None = None) -> None:
        self._dir = base_dir or Path.home() / ".dina" / "cli" / "sessions"

    def new_id(self) -> str:
        """Generate a short, unique PII scrub identifier."""
        return f"pii_{uuid.uuid4().hex[:8]}"

    def save(self, session_id: str, entities: list[dict]) -> None:
        """Persist entities for a scrub session (atomic write).

        Normalizes entities from the Core PII response format.  Core returns
        entities with snake_case keys::

            {"type": "EMAIL", "value": "john@ex.com", "start": 10, "end": 22}

        The scrubbed text uses tokens like ``[EMAIL_1]``, ``[PHONE_1]``, etc.
        This method groups entities by type and numbers them so each entity
        maps to its corresponding token.
        """
        self._dir.mkdir(parents=True, exist_ok=True, mode=0o700)

        # Normalize and build token mapping.
        # Group by entity type to assign occurrence indices.
        type_counters: dict[str, int] = defaultdict(int)
        normalized: list[dict] = []

        for entity in entities:
            entity_type: str = entity.get("type", "UNKNOWN")
            entity_value: str = entity.get("value", "")

            type_counters[entity_type] += 1
            token = f"[{entity_type}_{type_counters[entity_type]}]"

            normalized.append({"token": token, "value": entity_value})

        # Atomic write: write to a temp file then replace.
        target = self._dir / f"{session_id}.json"
        tmp = target.with_suffix(".tmp")
        old_umask = os.umask(0o077)
        try:
            tmp.write_text(json.dumps(normalized, indent=2))
            os.replace(tmp, target)
        finally:
            os.umask(old_umask)
        target.chmod(0o600)

    def load(self, session_id: str) -> list[dict]:
        """Load a previously saved session.

        Raises ``FileNotFoundError`` if the session does not exist.
        """
        path = self._dir / f"{session_id}.json"
        if not path.exists():
            raise FileNotFoundError(f"Session {session_id} not found")
        return json.loads(path.read_text())

    def rehydrate(self, text: str, session_id: str) -> str:
        """Replace scrub tokens in *text* with the original PII values."""
        entities = self.load(session_id)
        for entity in entities:
            text = text.replace(entity["token"], entity["value"])
        return text
