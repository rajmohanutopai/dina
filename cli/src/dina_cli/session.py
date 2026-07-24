"""PII scrub/rehydrate session persistence."""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
import uuid
from collections import defaultdict
from pathlib import Path

from . import config as _config_mod

DEFAULT_SESSION_TTL_SECONDS = 60 * 60
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class SessionStore:
    """Persist PII scrub sessions so scrubbed text can be rehydrated later."""

    def __init__(
        self,
        base_dir: Path | None = None,
        ttl_seconds: int = DEFAULT_SESSION_TTL_SECONDS,
    ) -> None:
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive")
        # Keep sensitive mappings inside the active CLI instance. This respects
        # DINA_CONFIG_DIR and project-local multi-Home-Node configurations.
        self._dir = base_dir or _config_mod.CONFIG_DIR / "sessions"
        self._ttl_seconds = ttl_seconds

    def new_id(self) -> str:
        """Generate a short, unique PII scrub identifier."""
        return f"pii_{uuid.uuid4().hex}"

    def _path(self, session_id: str) -> Path:
        if _SESSION_ID_RE.fullmatch(session_id) is None:
            raise ValueError("invalid PII session id")
        return self._dir / f"{session_id}.json"

    def save(self, session_id: str, entities: list[dict]) -> None:
        """Persist entities for a scrub session (atomic write).

        Normalizes entities from the Core PII response format.  Core returns
        entities with snake_case keys::

            {"type": "EMAIL", "value": "john@ex.com", "start": 10, "end": 22}

        The scrubbed text uses tokens like ``[EMAIL_1]``, ``[PHONE_1]``, etc.
        This method groups entities by type and numbers them so each entity
        maps to its corresponding token.
        """
        target = self._path(session_id)
        self._dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._dir.chmod(0o700)

        # Normalize and build token mapping.
        # Group by entity type to assign occurrence indices.
        type_counters: dict[str, int] = defaultdict(int)
        normalized: list[dict] = []

        for entity in entities:
            # Older Core/Brain adapters used title-cased keys. Accept both
            # shapes at this local compatibility boundary, but persist one
            # canonical representation.
            entity_type = entity.get("type", entity.get("Type"))
            entity_value = entity.get("value", entity.get("Value"))
            if not isinstance(entity_type, str) or entity_type == "":
                raise ValueError("PII entity is missing a valid type")
            if not isinstance(entity_value, str):
                raise ValueError("PII entity is missing its original value")

            type_counters[entity_type] += 1
            generated_token = f"[{entity_type}_{type_counters[entity_type]}]"
            supplied_token = entity.get("token", entity.get("Token"))
            if supplied_token is not None and not isinstance(supplied_token, str):
                raise ValueError("PII entity has an invalid token")
            token = supplied_token or generated_token

            normalized.append({"token": token, "value": entity_value})

        # Atomic write without changing the process-global umask. MCP hosts can
        # execute tools concurrently, so os.umask() would be a cross-thread
        # race that could affect unrelated files.
        fd, tmp_name = tempfile.mkstemp(
            prefix=f".{session_id}.",
            suffix=".tmp",
            dir=self._dir,
        )
        tmp = Path(tmp_name)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                fd = -1
                json.dump(normalized, handle, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, target)
        finally:
            if fd >= 0:
                os.close(fd)
            tmp.unlink(missing_ok=True)
        target.chmod(0o600)

    def load(self, session_id: str) -> list[dict]:
        """Load a previously saved session.

        Raises ``FileNotFoundError`` if the session does not exist.
        """
        path = self._path(session_id)
        if not path.exists():
            raise FileNotFoundError(f"Session {session_id} not found")
        if time.time() - path.stat().st_mtime > self._ttl_seconds:
            path.unlink(missing_ok=True)
            raise FileNotFoundError(f"Session {session_id} expired")
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            path.unlink(missing_ok=True)
            raise ValueError(f"Session {session_id} is corrupt") from exc
        if not isinstance(payload, list):
            path.unlink(missing_ok=True)
            raise ValueError(f"Session {session_id} is corrupt")
        for entity in payload:
            if (
                not isinstance(entity, dict)
                or not isinstance(entity.get("token"), str)
                or not isinstance(entity.get("value"), str)
            ):
                path.unlink(missing_ok=True)
                raise ValueError(f"Session {session_id} is corrupt")
        return payload

    def delete(self, session_id: str) -> None:
        """Delete a scrub session if it exists."""
        self._path(session_id).unlink(missing_ok=True)

    def rehydrate(self, text: str, session_id: str, *, consume: bool = False) -> str:
        """Replace scrub tokens in *text* with the original PII values.

        ``consume=True`` removes the sensitive mapping after a successful
        round-trip. CLI and MCP user-facing commands use this one-shot mode.
        """
        entities = self.load(session_id)
        for entity in entities:
            text = text.replace(entity["token"], entity["value"])
        if consume:
            self.delete(session_id)
        return text
