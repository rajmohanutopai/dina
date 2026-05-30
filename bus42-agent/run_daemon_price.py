"""Wrapper registering stub_price_runner before invoking the dina-agent
daemon for the "Corner Market" price_check provider.

Same shape as run_daemon.py / run_daemon_appt.py. MUST set DINA_CONFIG_DIR
to the price agent's config dir, else dina_cli's resolver falls through to
the local bus42-agent/.dina/cli config (priority 2) and the daemon talks to
the wrong Core. DINA_CONFIG_DIR is priority 1 (cli/src/dina_cli/config.py).

Run:
  source venv/bin/activate
  DINA_CONFIG_DIR=$PWD/price-agent/.dina/cli python run_daemon_price.py
"""

from __future__ import annotations

import sys

from dina_cli.runner_registry import register_runner
from dina_cli.agent_daemon import run_daemon

from stub_price_runner import StubPriceRunner


def main() -> None:
    register_runner("stub_price", StubPriceRunner)
    print("[run_daemon_price] registered runner: stub_price", flush=True)
    run_daemon(poll_interval=5, lease_duration=120, runner_name="stub_price")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
