"""Port allocation — find free TCP ports for Core and PDS.

NOTE: The current probe-based allocation is subject to TOCTOU races when
multiple installs run concurrently. A proper fix would use bind+listen
reservation or a file lock. This matches the behavior of the shell-side
allocator in scripts/setup/env_ensure.sh.
"""

from __future__ import annotations

import socket
from pathlib import Path


def port_free(port: int) -> bool:
    """Check if a TCP port is free."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", port))
            return True
    except OSError:
        return False


def find_free_port(start: int, step: int = 100, max_attempts: int = 20) -> int:
    """Find first free port starting from start, stepping by step."""
    port = start
    for _ in range(max_attempts):
        if port_free(port):
            return port
        port += step
    raise RuntimeError(
        f"no free port found starting from {start} "
        f"(tried {max_attempts} ports, step {step})"
    )


def allocate_ports(
    env_file: Path | None = None,
    default_core: int = 8100,
    default_pds: int = 2583,
) -> tuple[int, int]:
    """Allocate Core and PDS ports.

    Reads saved values from .env if present; otherwise auto-detects free ports.
    Returns (core_port, pds_port).
    """
    saved_core = None
    saved_pds = None

    if env_file and env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("DINA_CORE_PORT="):
                try:
                    saved_core = int(line.split("=", 1)[1])
                except ValueError:
                    pass
            elif line.startswith("DINA_PDS_PORT="):
                try:
                    saved_pds = int(line.split("=", 1)[1])
                except ValueError:
                    pass

    core_port = saved_core or find_free_port(default_core)
    pds_port = saved_pds or find_free_port(default_pds)

    return core_port, pds_port
