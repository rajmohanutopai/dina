"""CLI entry point for the installer core.

Commands:
    python3 -m scripts.installer wizard          # Interactive wizard (JSON lines on stdin/stdout)
    python3 -m scripts.installer apply            # Non-interactive apply from JSON config
    python3 -m scripts.installer validate-config  # Validate a config without applying

The wizard command is used by install.sh via Docker:
    docker run -i -v "$DINA_DIR:/work" ... python3 -m scripts.installer wizard

The apply command is used for non-interactive installs and tests:
    echo '{"dina_dir":"/work",...}' | python3 -m scripts.installer apply
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from scripts.installer.models import InstallerConfig
from scripts.installer.pipeline import run_install


def _cmd_wizard() -> int:
    """Run the interactive wizard over JSON lines."""
    from scripts.installer.wizard import run_wizard

    dina_dir = Path(os.environ.get("DINA_DIR", "/work"))
    # Ports are allocated on the host (where socket probing is valid)
    # and passed via env vars. Inside the container, socket probing sees
    # the container's network namespace, not the host's.
    core_port = int(os.environ.get("DINA_CORE_PORT", "0"))
    pds_port = int(os.environ.get("DINA_PDS_PORT", "0"))
    try:
        run_wizard(dina_dir, core_port=core_port, pds_port=pds_port)
    except EOFError:
        print(json.dumps({"type": "error", "message": "stdin closed unexpectedly"}))
        return 1
    except Exception as e:
        print(json.dumps({"type": "error", "message": str(e)}))
        return 1
    return 0


def _cmd_apply() -> int:
    """Non-interactive apply from JSON config (stdin or --config file)."""
    config_json = None
    for i, arg in enumerate(sys.argv):
        if arg == "--config" and i + 1 < len(sys.argv):
            config_json = Path(sys.argv[i + 1]).read_text()
            break

    if config_json is None:
        if not sys.stdin.isatty():
            config_json = sys.stdin.read()
        else:
            print("error: provide --config FILE or pipe JSON to stdin", file=sys.stderr)
            return 1

    # Override from env vars (security: passphrase never in JSON/argv;
    # ports must be allocated on host, not inside container).
    data = json.loads(config_json)
    passphrase_env = os.environ.get("DINA_SEED_PASSPHRASE", "")
    if passphrase_env:
        data["passphrase"] = passphrase_env
    core_port_env = os.environ.get("DINA_CORE_PORT", "")
    if core_port_env:
        data["core_port"] = int(core_port_env)
    pds_port_env = os.environ.get("DINA_PDS_PORT", "")
    if pds_port_env:
        data["pds_port"] = int(pds_port_env)
    config_json = json.dumps(data)

    try:
        config = InstallerConfig.model_validate_json(config_json)
    except Exception as e:
        print(f"error: invalid config: {e}", file=sys.stderr)
        return 1

    try:
        result = run_install(config)
    except Exception as e:
        print(f"error: install failed: {e}", file=sys.stderr)
        return 1

    print(result.model_dump_json(indent=2))
    return 0


def _cmd_validate() -> int:
    """Validate a config without applying."""
    config_json = sys.stdin.read() if not sys.stdin.isatty() else None
    if not config_json:
        print("error: pipe JSON config to stdin", file=sys.stderr)
        return 1
    try:
        InstallerConfig.model_validate_json(config_json)
        print("valid")
        return 0
    except Exception as e:
        print(f"invalid: {e}", file=sys.stderr)
        return 1


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "usage: python3 -m scripts.installer <command>\n"
            "  wizard          Interactive wizard (JSON lines protocol)\n"
            "  apply            Non-interactive apply from config JSON\n"
            "  validate-config  Validate config without applying",
            file=sys.stderr,
        )
        return 2

    cmd = sys.argv[1]
    if cmd == "wizard":
        return _cmd_wizard()
    elif cmd == "apply":
        return _cmd_apply()
    elif cmd == "validate-config":
        return _cmd_validate()
    else:
        print(f"error: unknown command: {cmd}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
