"""The Vault — Decentralized verdict storage via Ceramic Network."""

from __future__ import annotations

import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

from dina.did_key import derive_did_key
from dina.identity import DinaIdentity
from dina.models import ProductVerdict

logger = logging.getLogger(__name__)

_DEFAULT_VAULT_DIR = Path.home() / ".dina" / "vault"


class CeramicVault:
    """Decentralized verdict storage backed by the Ceramic Network.

    When ``ceramic_url`` (or the ``DINA_CERAMIC_URL`` env var) is set, verdicts
    are dual-written to Ceramic alongside ChromaDB.  If the URL is not set or the
    node is unreachable, all operations gracefully degrade to no-ops.
    """

    def __init__(
        self,
        identity: DinaIdentity,
        ceramic_url: str | None = None,
        vault_dir: Path | None = None,
    ) -> None:
        self._identity = identity
        self._ceramic_url = ceramic_url or os.environ.get("DINA_CERAMIC_URL", "")
        self._vault_dir = vault_dir or _DEFAULT_VAULT_DIR
        self._enabled = bool(self._ceramic_url)
        self._connected = False
        self._client = None  # lazily initialised SDK client
        self._did = derive_did_key(identity)

        # Local stream index: video_id → stream_id
        self._index_path = self._vault_dir / "stream_index.json"
        self._index: dict[str, str] = self._load_index()

        if self._enabled:
            self.health_check()

    # ── public properties ─────────────────────────────────────────

    @property
    def enabled(self) -> bool:
        """Whether a Ceramic URL has been configured."""
        return self._enabled

    @property
    def connected(self) -> bool:
        """Whether the last health check succeeded."""
        return self._connected

    @property
    def synced_count(self) -> int:
        """Number of verdicts in the local stream index."""
        return len(self._index)

    @property
    def status_lines(self) -> list[str]:
        """Human-readable status for the REPL banner."""
        if not self._enabled:
            return ["Vault: disabled (set DINA_CERAMIC_URL to enable)"]
        state = "connected" if self._connected else "disconnected"
        return [
            f"Vault: {self._ceramic_url} ({state})",
            f"Vault synced: {self.synced_count} verdict(s)",
        ]

    # ── health check ──────────────────────────────────────────────

    def health_check(self) -> bool:
        """Ping the Ceramic node's healthcheck endpoint.

        Returns ``True`` if the node responds within 5 s.
        """
        if not self._enabled:
            return False
        try:
            url = f"{self._ceramic_url.rstrip('/')}/api/v0/node/healthcheck"
            with urlopen(url, timeout=5):  # noqa: S310
                pass
            self._connected = True
        except (URLError, ConnectionRefusedError, TimeoutError, OSError):
            self._connected = False
        return self._connected

    # ── publish ───────────────────────────────────────────────────

    def publish(self, verdict: ProductVerdict, video_id: str, url: str) -> str | None:
        """Publish a verdict to Ceramic.  Returns the stream_id or ``None``.

        Guards:
        - If the vault is disabled → returns ``None`` immediately.
        - If not connected → retries health check once.
        - SDK failures are caught and logged; never crash the caller.
        """
        if not self._enabled:
            return None

        if not self._connected:
            self.health_check()
            if not self._connected:
                logger.warning("Ceramic node unreachable — skipping vault publish")
                return None

        try:
            client = self._init_client()
            content = self._build_content(verdict, video_id, url)
            stream_id = self._create_document(client, content)
            if stream_id:
                self._index[video_id] = stream_id
                self._save_index()
            return stream_id
        except Exception:
            logger.warning("Ceramic publish failed", exc_info=True)
            return None

    # ── lookups ───────────────────────────────────────────────────

    def get_stream_id(self, video_id: str) -> str | None:
        """Look up a stream_id from the local index (no network call)."""
        return self._index.get(video_id)

    # ── private helpers ───────────────────────────────────────────

    def _init_client(self):
        """Lazily create a ``ceramicsdk`` client, authenticated with our DID."""
        if self._client is not None:
            return self._client
        try:
            from ceramicsdk import CeramicClient  # type: ignore[import-untyped]
        except ImportError:
            raise RuntimeError(
                "ceramicsdk is not installed.  Install with: pip install 'dina[ceramic]'"
            )

        client = CeramicClient(self._ceramic_url)
        seed_hex = self._identity.private_key_seed().hex()
        client.authenticate_with_did(self._did, seed_hex)
        self._client = client
        return client

    def _create_document(self, client, content: dict) -> str | None:
        """Create a Ceramic document and return its stream_id."""
        result = client.create_document(content)
        return result.get("stream_id") if isinstance(result, dict) else None

    @staticmethod
    def _build_content(verdict: ProductVerdict, video_id: str, url: str) -> dict:
        """Build the document content for Ceramic."""
        data = verdict.model_dump()
        data["video_id"] = video_id
        data["youtube_url"] = url
        data["published_at"] = datetime.now(timezone.utc).isoformat()
        return data

    # ── stream index persistence ──────────────────────────────────

    def _load_index(self) -> dict[str, str]:
        """Load the stream index from disk, returning an empty dict on failure."""
        if not self._index_path.exists():
            return {}
        try:
            return json.loads(self._index_path.read_text())
        except (json.JSONDecodeError, OSError):
            return {}

    def _save_index(self) -> None:
        """Atomically write the stream index to disk."""
        self._vault_dir.mkdir(parents=True, exist_ok=True)
        data = json.dumps(self._index, indent=2)
        # Write to a temp file then rename for atomicity
        fd, tmp = tempfile.mkstemp(dir=self._vault_dir, suffix=".tmp")
        try:
            os.write(fd, data.encode())
            os.close(fd)
            os.replace(tmp, self._index_path)
        except OSError:
            os.close(fd)
            try:
                os.unlink(tmp)
            except OSError:
                pass
