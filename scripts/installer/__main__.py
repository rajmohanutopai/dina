"""CLI entry point for the installer core.

Called by install.sh via Docker:
    echo '{"dina_dir": "/work", ...}' | docker run ... python3 -m scripts.installer apply

Passphrase is read from DINA_SEED_PASSPHRASE env var (never in JSON/argv).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from scripts.installer.models import InstallerConfig
from scripts.installer.pipeline import run_install


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] != "apply":
        print("usage: python3 -m scripts.installer apply [--config FILE]", file=sys.stderr)
        return 2

    # Read config from --config file or stdin
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

    # Override passphrase from env var (security: never in JSON/argv)
    passphrase_env = os.environ.get("DINA_SEED_PASSPHRASE", "")
    if passphrase_env:
        data = json.loads(config_json)
        data["passphrase"] = passphrase_env
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

    # Output result as JSON (for install.sh to parse)
    print(result.model_dump_json(indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
