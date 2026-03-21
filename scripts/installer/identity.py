"""Identity resolution — seed generation, mnemonic conversion, hex restore.

Reuses cli/src/dina_cli/seed_wrap.py as the single source of truth for
BIP-39 mnemonic handling and seed generation.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Add cli package to path so we can import seed_wrap directly.
_CLI_SRC = Path(__file__).resolve().parent.parent.parent / "cli" / "src"
if str(_CLI_SRC) not in sys.path:
    sys.path.insert(0, str(_CLI_SRC))

from dina_cli.seed_wrap import (  # noqa: E402
    generate_seed,
    mnemonic_to_seed,
    seed_to_mnemonic,
)

from scripts.installer.models import IdentityChoice, InstallerConfig


def resolve_identity(config: InstallerConfig) -> tuple[bytes, list[str] | None]:
    """Resolve the 32-byte seed and optional recovery phrase.

    Returns:
        (seed, recovery_phrase) where recovery_phrase is a list of 24 words
        for NEW identities, or None for restores.
    """
    if config.identity_choice == IdentityChoice.NEW:
        seed = generate_seed()
        phrase = seed_to_mnemonic(seed)
        return seed, phrase

    if config.identity_choice == IdentityChoice.RESTORE_MNEMONIC:
        if not config.mnemonic:
            raise ValueError("mnemonic required for RESTORE_MNEMONIC")
        words = config.mnemonic.strip().split()
        seed = mnemonic_to_seed(words)
        return seed, None

    if config.identity_choice == IdentityChoice.RESTORE_HEX:
        if not config.hex_seed:
            raise ValueError("hex_seed required for RESTORE_HEX")
        seed = bytes.fromhex(config.hex_seed)
        if len(seed) != 32:
            raise ValueError(f"hex_seed must decode to 32 bytes, got {len(seed)}")
        return seed, None

    raise ValueError(f"unknown identity_choice: {config.identity_choice}")
