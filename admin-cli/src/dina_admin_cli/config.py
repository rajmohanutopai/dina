"""Configuration for dina-admin CLI.

dina-admin connects to Core exclusively via Unix domain socket.
Socket access = admin auth (no token needed).
Runs inside the Core container: docker compose exec core dina-admin ...
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import click

DEFAULT_SOCKET_PATH = "/data/run/admin.sock"


@dataclass(frozen=True)
class Config:
    """Immutable admin CLI configuration."""

    socket_path: str
    timeout: float = 30.0


def load_config() -> Config:
    """Build Config from env vars / defaults.

    DINA_ADMIN_SOCKET overrides the default socket path.
    Fails if the socket does not exist.
    """
    env_socket = os.environ.get("DINA_ADMIN_SOCKET")
    if env_socket is not None:
        socket_path = env_socket
    else:
        socket_path = DEFAULT_SOCKET_PATH

    timeout = float(os.environ.get("DINA_TIMEOUT") or 30.0)

    if not socket_path:
        raise click.UsageError(
            "Admin socket disabled (DINA_ADMIN_SOCKET is empty)."
        )

    sock = Path(socket_path)
    if not sock.exists():
        raise click.UsageError(
            "Admin socket not found at {}.\n"
            "  Is Core running? Are you inside the container?\n"
            "  Run: docker compose exec core dina-admin ...".format(socket_path)
        )

    # AC1: Reject if socket is readable by group or other users.
    # Socket access = full admin, so permissions must be owner-only.
    try:
        mode = sock.stat().st_mode
        if mode & 0o077:
            raise click.UsageError(
                "Admin socket at {} has unsafe permissions (mode {:o}).\n"
                "  Socket must be owner-only (no group/other access).\n"
                "  Fix: chmod 600 {}".format(socket_path, mode & 0o777, socket_path)
            )
    except OSError:
        pass  # stat failed — socket may be abstract or containerised

    return Config(socket_path=socket_path, timeout=timeout)
