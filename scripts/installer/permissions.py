"""Post-install permission lockdown and .gitignore management."""

from __future__ import annotations

import os
from pathlib import Path


def lock_permissions(secrets_dir: Path) -> None:
    """Lock secrets directory and files with restrictive permissions."""
    os.chmod(secrets_dir, 0o700)

    # Lock all files in secrets/ (not recursive into subdirs)
    for f in secrets_dir.iterdir():
        if f.is_file():
            os.chmod(f, 0o600)


def ensure_gitignore(dina_dir: Path) -> None:
    """Ensure .env and secrets/ are in .gitignore."""
    gitignore = dina_dir / ".gitignore"
    entries_needed = [".env", "secrets/"]

    existing: set[str] = set()
    if gitignore.exists():
        existing = set(gitignore.read_text().splitlines())

    additions = [e for e in entries_needed if e not in existing]
    if additions:
        with open(gitignore, "a") as f:
            for entry in additions:
                f.write(f"{entry}\n")
