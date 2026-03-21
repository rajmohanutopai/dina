"""Secrets directory management — session ID, PDS secrets, directory structure.

Handles creation of the secrets/ layout, session ID generation,
and PDS secret generation. All idempotent — safe to call on re-runs.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path


def ensure_secrets_dir(dina_dir: Path) -> Path:
    """Create secrets/ and service_keys/ subdirectories with correct permissions.

    Returns the secrets directory path.
    """
    secrets_dir = dina_dir / "secrets"
    service_key_dir = secrets_dir / "service_keys"

    secrets_dir.mkdir(parents=True, exist_ok=True)
    for d in [
        service_key_dir,
        service_key_dir / "core",
        service_key_dir / "brain",
    ]:
        d.mkdir(parents=True, exist_ok=True)
        os.chmod(d, 0o700)

    pub_dir = service_key_dir / "public"
    pub_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(pub_dir, 0o755)

    return secrets_dir


def ensure_session_id(secrets_dir: Path) -> str:
    """Read or generate the 3-char alphanumeric session ID.

    Generated once, preserved across re-runs.
    """
    session_file = secrets_dir / "session_id"

    if session_file.exists():
        session_id = session_file.read_text().strip()
        if session_id:
            return session_id

    # Generate 3-char lowercase alphanumeric
    chars = "abcdefghijklmnopqrstuvwxyz0123456789"
    session_id = "".join(secrets.choice(chars) for _ in range(3))

    fd = os.open(str(session_file), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, session_id.encode())
    finally:
        os.close(fd)

    return session_id


def generate_pds_secrets(env_file: Path | None = None) -> dict[str, str]:
    """Read existing or generate new PDS secrets.

    Returns dict with keys: jwt_secret, admin_password, rotation_key_hex.
    Reuses existing values from .env if present.
    """
    existing: dict[str, str] = {}
    if env_file and env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("DINA_PDS_JWT_SECRET="):
                existing["jwt_secret"] = line.split("=", 1)[1]
            elif line.startswith("DINA_PDS_ADMIN_PASSWORD="):
                existing["admin_password"] = line.split("=", 1)[1]
            elif line.startswith("DINA_PDS_ROTATION_KEY_HEX="):
                existing["rotation_key_hex"] = line.split("=", 1)[1]

    return {
        "jwt_secret": existing.get("jwt_secret") or secrets.token_hex(32),
        "admin_password": existing.get("admin_password") or secrets.token_hex(16),
        "rotation_key_hex": existing.get("rotation_key_hex") or secrets.token_hex(32),
    }


def is_already_wrapped(secrets_dir: Path) -> bool:
    """Check if seed is already wrapped (wrapped_seed.bin + salt exist)."""
    return (
        (secrets_dir / "wrapped_seed.bin").is_file()
        and (secrets_dir / "master_seed.salt").is_file()
    )
