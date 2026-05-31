"""Wrapper that registers stub_eta_runner before invoking the dina-agent daemon.

Why this wrapper exists: dina-agent's runner_registry auto-registers
only `openclaw` + `hermes` on import. To plug in our test stub without
patching dina_cli source we register it here and then dispatch to the
daemon loop.

Run:
  source venv/bin/activate
  python run_daemon.py
"""

from __future__ import annotations

import sys

from dina_cli.runner_registry import register_runner
from dina_cli.agent_daemon import run_daemon

from stub_eta_runner import StubEtaRunner


def main() -> None:
    register_runner("stub_eta", StubEtaRunner)
    print("[run_daemon] registered runner: stub_eta", flush=True)
    # Hand off to the canonical daemon loop. It will pick up dina config
    # from the standard location (~/.config/dina-cli/config.toml or
    # bus42-agent/.dina/cli/config.toml depending on `dina configure`
    # --config-location).
    run_daemon(poll_interval=5, lease_duration=120, runner_name="stub_eta")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
