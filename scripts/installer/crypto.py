"""Seed wrapping and service key provisioning.

Reuses existing implementations as single source of truth:
- cli/src/dina_cli/seed_wrap.py for Argon2id + AES-256-GCM wrapping
- scripts/provision_derived_service_keys.py for SLIP-0010 Ed25519 derivation
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Add cli package to path for seed_wrap imports.
_CLI_SRC = Path(__file__).resolve().parent.parent.parent / "cli" / "src"
if str(_CLI_SRC) not in sys.path:
    sys.path.insert(0, str(_CLI_SRC))

# Add scripts/ to path for provision_derived_service_keys imports.
_SCRIPTS = Path(__file__).resolve().parent.parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from dina_cli.seed_wrap import save_wrapped, wrap  # noqa: E402
from provision_derived_service_keys import (  # noqa: E402
    _write_keypair,
    derive_service_key,
)


def wrap_seed(seed: bytes, passphrase: str, secrets_dir: Path) -> None:
    """Wrap seed with passphrase, write wrapped_seed.bin + master_seed.salt.

    Uses Argon2id + AES-256-GCM, byte-compatible with Go Core.
    """
    wrapped, salt = wrap(seed, passphrase)
    save_wrapped(wrapped, salt, secrets_dir)


def provision_service_keys(seed: bytes, service_key_dir: Path) -> None:
    """Derive and write Core + Brain Ed25519 keypairs via SLIP-0010.

    Layout:
        <service_key_dir>/core/core_ed25519_private.pem
        <service_key_dir>/brain/brain_ed25519_private.pem
        <service_key_dir>/public/core_ed25519_public.pem
        <service_key_dir>/public/brain_ed25519_public.pem
    """
    # Core = service index 0, Brain = service index 1.
    core_key = derive_service_key(seed, 0)
    brain_key = derive_service_key(seed, 1)

    _write_keypair(service_key_dir, "core", core_key)
    _write_keypair(service_key_dir, "brain", brain_key)


def write_seed_password(
    secrets_dir: Path, passphrase: str, clear: bool = False
) -> None:
    """Write or clear the seed_password file.

    In SERVER mode: passphrase persists for unattended restart.
    In MAXIMUM mode: passphrase is written for initial startup,
    then cleared after containers are healthy.
    """
    pw_path = secrets_dir / "seed_password"
    if clear:
        fd = os.open(str(pw_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.close(fd)
    else:
        fd = os.open(str(pw_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, passphrase.encode("utf-8"))
        finally:
            os.close(fd)
