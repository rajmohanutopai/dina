"""Protocol classes (contracts) for all dina-brain subsystems.

Source modules in dina_brain/ implement these protocols.
Tests use mock implementations initially; swap to real when code arrives.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


# ---------- §1 Authentication ----------


@runtime_checkable
class TokenVerifier(Protocol):
    """Contract for BRAIN_TOKEN verification (§1.1)."""

    def verify(self, token: str) -> bool:
        """Constant-time comparison of BRAIN_TOKEN."""
        ...


# ---------- §2 Guardian Loop ----------


@runtime_checkable
class GuardianLoop(Protocol):
    """Contract for the guardian angel loop (§2)."""

    async def process_event(self, event: dict) -> dict:
        """Process an incoming event and return an action decision."""
        ...

    async def classify_silence(self, event: dict) -> str:
        """Classify an event into fiduciary|solicited|engagement priority."""
        ...


@runtime_checkable
class WhisperDelivery(Protocol):
    """Contract for whisper delivery to clients (§2.4)."""

    async def send_whisper(self, client_id: str, message: dict) -> None:
        """Send a non-streaming whisper via WebSocket."""
        ...

    async def stream_whisper(self, client_id: str, chunks: list[dict]) -> None:
        """Send a streaming whisper as chunked messages."""
        ...


@runtime_checkable
class BriefingGenerator(Protocol):
    """Contract for daily briefing generation (§2.5)."""

    async def generate(self) -> dict:
        """Generate a morning briefing from engagement-tier items."""
        ...


# ---------- §3 PII Scrubber ----------


@runtime_checkable
class PIIScrubber(Protocol):
    """Contract for PII scrubbing pipeline (§3)."""

    def scrub(self, text: str) -> tuple[str, list[dict]]:
        """Scrub PII from text. Returns (scrubbed_text, entities)."""
        ...

    def detect(self, text: str) -> list[dict]:
        """Detect PII entities without scrubbing."""
        ...


@runtime_checkable
class EntityVault(Protocol):
    """Contract for ephemeral entity vault (§3.3)."""

    def create(self, entities: list[dict]) -> dict:
        """Create an in-memory replacement map from entities."""
        ...

    def rehydrate(self, text: str, vault: dict) -> str:
        """Replace tokens with original values."""
        ...

    def destroy(self, vault: dict) -> None:
        """Destroy the vault (clear the dict)."""
        ...


# ---------- §4 LLM Router ----------


@runtime_checkable
class LLMRouter(Protocol):
    """Contract for multi-provider LLM routing (§4)."""

    async def route(self, task_type: str, prompt: str, persona_tier: str = "open") -> dict:
        """Route a task to the optimal LLM path."""
        ...

    def available_models(self) -> list[str]:
        """Return list of available model identifiers."""
        ...


@runtime_checkable
class LLMClient(Protocol):
    """Contract for LLM client communication (§4.2)."""

    async def complete(self, prompt: str, model: str | None = None) -> dict:
        """Send a completion request to an LLM."""
        ...

    async def stream(self, prompt: str, model: str | None = None):
        """Stream a completion response."""
        ...


# ---------- §5 Sync Engine ----------


@runtime_checkable
class SyncEngine(Protocol):
    """Contract for the sync engine / ingestion pipeline (§5)."""

    async def ingest(self, source: str, data: dict) -> str:
        """Ingest a single item from a source. Returns item_id."""
        ...

    async def dedup(self, source: str, source_id: str) -> bool:
        """Check if an item is a duplicate. Returns True if duplicate."""
        ...

    def get_cursor(self, source: str) -> str | None:
        """Get the sync cursor for a source."""
        ...

    async def set_cursor(self, source: str, value: str) -> None:
        """Update the sync cursor for a source."""
        ...


@runtime_checkable
class SyncScheduler(Protocol):
    """Contract for sync scheduling (§5.1)."""

    async def schedule(self, connector: str, interval_seconds: int) -> None:
        """Schedule a connector to run at an interval."""
        ...

    async def trigger_now(self, connector: str) -> None:
        """Trigger an immediate sync for a connector."""
        ...

    async def stop(self, connector: str) -> None:
        """Stop a scheduled connector."""
        ...


# ---------- §6 MCP Client ----------


@runtime_checkable
class MCPClient(Protocol):
    """Contract for MCP agent delegation (§6)."""

    async def call_tool(self, server: str, tool: str, args: dict) -> dict:
        """Call a tool on an MCP server."""
        ...

    async def list_tools(self, server: str) -> list[dict]:
        """List available tools on an MCP server."""
        ...

    async def disconnect(self, server: str) -> None:
        """Disconnect from an MCP server."""
        ...


# ---------- §7 Core Client ----------


@runtime_checkable
class CoreClient(Protocol):
    """Contract for typed HTTP calls to dina-core (§7)."""

    async def get_vault_item(self, persona_id: str, item_id: str) -> dict:
        """Retrieve a vault item from core."""
        ...

    async def store_vault_item(self, persona_id: str, item: dict) -> str:
        """Store a vault item in core. Returns item_id."""
        ...

    async def store_vault_batch(self, persona_id: str, items: list[dict]) -> None:
        """Store a batch of vault items in core."""
        ...

    async def staging_ingest(self, item: dict) -> str:
        """Stage content for classification via /v1/staging/ingest."""
        ...

    async def search_vault(self, persona_id: str, query: str, mode: str = "hybrid") -> list[dict]:
        """Search the vault via core."""
        ...

    async def write_scratchpad(self, task_id: str, step: int, context: dict) -> None:
        """Write a scratchpad checkpoint."""
        ...

    async def read_scratchpad(self, task_id: str) -> dict | None:
        """Read the latest scratchpad checkpoint."""
        ...

    async def get_kv(self, key: str) -> str | None:
        """Get a value from core's KV store."""
        ...

    async def set_kv(self, key: str, value: str) -> None:
        """Set a value in core's KV store."""
        ...

    async def health(self) -> dict:
        """Check core's health."""
        ...


# ---------- §8 Routing ----------


@runtime_checkable
class AgentRouter(Protocol):
    """Contract for agent routing and MCP delegation (§8)."""

    async def route_task(self, task: dict) -> dict:
        """Route a task to the appropriate agent or local handler."""
        ...

    async def check_trust(self, agent_did: str) -> float:
        """Check an agent's trust score."""
        ...


# ---------- §9 Config ----------


@runtime_checkable
class BrainConfig(Protocol):
    """Contract for brain configuration (§9)."""

    @property
    def core_url(self) -> str:
        """URL for dina-core."""
        ...

    @property
    def brain_token(self) -> str:
        """BRAIN_TOKEN for authenticating with core."""
        ...

    @property
    def listen_port(self) -> int:
        """Port brain listens on (default 8200)."""
        ...


# ---------- §15 Silence Edge Cases ----------


@runtime_checkable
class SilenceClassifier(Protocol):
    """Contract for detailed silence classification (§15)."""

    async def classify(self, event: dict, context: dict | None = None) -> dict:
        """Classify an event with full context. Returns {priority, reason, action}."""
        ...

    async def apply_dnd(self, event: dict, dnd_active: bool) -> dict:
        """Apply Do Not Disturb rules to a classified event."""
        ...


# ---------- §6.1 Trust / AppView ----------


@runtime_checkable
class TrustClient(Protocol):
    """Contract for Trust AppView queries (§6.1, arch §08)."""

    async def query_trust_scores(self, did: str) -> dict:
        """Query trust scores for a DID from AppView API."""
        ...

    async def submit_outcome(self, bot_did: str, outcome: dict) -> None:
        """Submit an interaction outcome for bot trust scoring."""
        ...


# ---------- §18 Voice STT ----------


@runtime_checkable
class VoiceSTTClient(Protocol):
    """Contract for voice-to-text integration (§18, arch §16)."""

    async def transcribe_stream(self, audio_stream: bytes) -> str:
        """Transcribe audio via Deepgram Nova-3 WebSocket streaming."""
        ...

    async def transcribe_fallback(self, audio_stream: bytes) -> str:
        """Fallback transcription via Gemini Flash Lite Live API."""
        ...

    def is_primary_available(self) -> bool:
        """Check if primary STT provider (Deepgram) is available."""
        ...


# ---------- §2.3 Task Queue ACK ----------


@runtime_checkable
class TaskAckHandler(Protocol):
    """Contract for task queue ACK protocol (§2.3, arch §04)."""

    async def ack_task(self, task_id: str) -> None:
        """Send ACK to core after successful task processing."""
        ...

    async def handle_retry(self, task_id: str, checkpoint: dict | None) -> dict:
        """Handle a retried task, resuming from checkpoint if available."""
        ...
