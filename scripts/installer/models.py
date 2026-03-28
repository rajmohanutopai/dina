"""Pydantic models for installer input/output contract.

InstallerConfig is the complete specification of all user choices.
InstallerResult is the complete output — inspectable, serializable.

If the config validates, the installer will work.
If a test produces a valid result, the same code path works in production.
"""

from __future__ import annotations

from enum import Enum
from pathlib import Path

from pydantic import BaseModel, field_validator


class IdentityChoice(str, Enum):
    """How the user wants to set up their identity."""
    NEW = "new"
    RESTORE_MNEMONIC = "restore_mnemonic"
    RESTORE_HEX = "restore_hex"


class StartupMode(str, Enum):
    """How Dina starts after install."""
    MAXIMUM = "maximum"   # passphrase required each restart
    SERVER = "server"     # passphrase stored for unattended boot


class LLMProviderConfig(BaseModel):
    """A single LLM provider configuration."""
    env_key: str          # e.g. "GEMINI_API_KEY"
    env_value: str        # the API key value


class TelegramConfig(BaseModel):
    """Telegram bot configuration."""
    token: str
    user_id: str = ""


class BlueskyConfig(BaseModel):
    """Bluesky channel configuration."""
    handle: str           # e.g., "dina.bsky.social"
    password: str         # app password (not main password)
    service: str = "https://bsky.social"
    owner_did: str = ""   # DID of the owner — only DMs from this DID are processed


class InstallerConfig(BaseModel):
    """Complete specification of all user choices. No I/O, no prompts."""

    dina_dir: Path

    # Identity
    identity_choice: IdentityChoice = IdentityChoice.NEW
    passphrase: str
    startup_mode: StartupMode = StartupMode.SERVER
    mnemonic: str | None = None         # 24 words space-separated (for restore)
    hex_seed: str | None = None         # 64-char hex (for restore)

    # LLM providers
    llm_providers: list[LLMProviderConfig] = []

    # Telegram
    telegram: TelegramConfig | None = None

    # Bluesky
    bluesky: BlueskyConfig | None = None

    # User
    owner_name: str = ""

    # Explicit ports — when set, skip auto-allocation (which uses socket
    # probing and must run on the host, not inside a Docker container).
    # install.sh allocates ports on the host and passes them here.
    # Tests and direct invocations leave these as None for auto-allocation.
    core_port: int | None = None
    pds_port: int | None = None

    # Phase control — install.sh sets this to False because it writes
    # .env itself (after collecting LLM/Telegram prompts interactively).
    # Tests set this to True (default) to get a complete install.
    write_env: bool = True

    @field_validator("passphrase")
    @classmethod
    def passphrase_min_length(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("passphrase must be at least 8 characters")
        return v

    @field_validator("hex_seed")
    @classmethod
    def hex_seed_format(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip().lower()
        if len(v) != 64:
            raise ValueError(f"hex_seed must be 64 hex characters, got {len(v)}")
        if not all(c in "0123456789abcdef" for c in v):
            raise ValueError("hex_seed must be hexadecimal")
        return v

    @field_validator("mnemonic")
    @classmethod
    def mnemonic_word_count(cls, v: str | None) -> str | None:
        if v is None:
            return None
        words = v.strip().split()
        if len(words) != 24:
            raise ValueError(f"mnemonic must be 24 words, got {len(words)}")
        return " ".join(words)


class StepResult(BaseModel):
    """Outcome of one pipeline step."""
    name: str
    success: bool
    message: str = ""
    skipped: bool = False


class InstallerResult(BaseModel):
    """Complete output of the install pipeline."""

    # Paths
    secrets_dir: Path
    env_file: Path

    # Identity
    session_id: str
    core_port: int
    pds_port: int
    startup_mode: StartupMode

    # Crypto
    seed_wrapped: bool
    service_keys_provisioned: bool
    recovery_phrase: list[str] | None = None  # 24 words, only for new identities

    # Audit trail
    steps: list[StepResult] = []
