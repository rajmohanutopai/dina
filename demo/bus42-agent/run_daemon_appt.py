"""Wrapper that registers stub_appointment_runner before invoking the
dina-agent daemon for the "Dr Carl's Clinic" appointment provider.

Same shape as run_daemon.py (the bus ETA provider) but registers the
appointment stub and claims tasks for the `stub_appt` runner. MUST set
DINA_CONFIG_DIR to the Dr Carl agent's config dir — otherwise dina_cli's
config resolver falls through to the local `bus42-agent/.dina/cli/`
config (priority 2) and the daemon would talk to the bus42 Core, not
Dr Carl. DINA_CONFIG_DIR is priority 1 in cli/src/dina_cli/config.py.

Run:
  source venv/bin/activate
  DINA_CONFIG_DIR=$PWD/drcarl-agent/.dina/cli python run_daemon_appt.py
"""

from __future__ import annotations

import sys

from dina_cli.runner_registry import register_runner
from dina_cli.agent_daemon import run_daemon

from stub_appointment_runner import StubAppointmentRunner


def main() -> None:
    register_runner("stub_appt", StubAppointmentRunner)
    print("[run_daemon_appt] registered runner: stub_appt", flush=True)
    run_daemon(poll_interval=5, lease_duration=120, runner_name="stub_appt")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
