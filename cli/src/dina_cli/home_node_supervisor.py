"""Crash-restarting native supervisor for Home Node Lite Core and Brain."""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .home_node import HomeNodeError, HomeNodeManager, _atomic_private_write, _rotate_log

HEALTH_FAILURE_LIMIT = 3


class NativeSupervisor:
    def __init__(self, install_dir: Path, token: str) -> None:
        self.manager = HomeNodeManager(install_dir)
        self.token = token
        self.stop_requested = False
        self.core: subprocess.Popen[bytes] | None = None
        self.brain: subprocess.Popen[bytes] | None = None
        self.spec: dict[str, Any] | None = None
        self.runtime_dir = self.manager.runtime_dir
        self.log_dir = self.manager.log_dir
        self.health_failures = {"core": 0, "brain": 0}

    def run(self) -> int:
        self._install_signals()
        with self._single_instance_lock():
            try:
                self.spec = self.manager.runtime_spec()
                self.runtime_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
                self.log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
                self._write_heartbeat()
                self._remove_verified_orphans()
                backoff = 1.0
                while not self.stop_requested:
                    config = self.manager._load_config()
                    if config is None or not config.autostart_enabled:
                        break
                    self._write_heartbeat()
                    try:
                        self._reconcile()
                        backoff = 1.0
                    except HomeNodeError as exc:
                        self._log(
                            f"managed service startup failed: {exc}; "
                            f"retrying in {backoff:g}s"
                        )
                        self._stop_children()
                        deadline = time.monotonic() + backoff
                        while not self.stop_requested and time.monotonic() < deadline:
                            self._write_heartbeat()
                            time.sleep(0.25)
                        backoff = min(backoff * 2, 30.0)
                    time.sleep(0.5)
                return 0
            except HomeNodeError as exc:
                self._log(f"supervisor error: {exc}")
                return 1
            except Exception as exc:
                self._log(f"supervisor fatal: {exc}")
                return 1
            finally:
                self._stop_children()
                with contextlib.suppress(FileNotFoundError):
                    (self.runtime_dir / "supervisor.json").unlink()

    def _reconcile(self) -> None:
        assert self.spec is not None
        core_url = (
            f"http://127.0.0.1:{self.spec['config']['core_port']}/healthz"
        )
        brain_url = (
            f"http://127.0.0.1:{self.spec['config']['brain_port']}/readyz"
        )
        if self._needs_restart("core", self.core, core_url):
            self._stop_brain()
            self._terminate("core", self.core)
            self.core = None
        if self.core is None:
            self.core = self._spawn("core")
            self._wait_endpoint(
                core_url,
                self.core,
                timeout=120,
            )
            self.health_failures["core"] = 0
        if self._needs_restart("brain", self.brain, brain_url):
            self._terminate("brain", self.brain)
            self.brain = None
        if self.brain is None:
            self.brain = self._spawn("brain")
            self._wait_endpoint(
                brain_url,
                self.brain,
                timeout=120,
            )
            self.health_failures["brain"] = 0

    def _needs_restart(
        self,
        service: str,
        process: subprocess.Popen[bytes] | None,
        health_url: str,
    ) -> bool:
        if process is None:
            return False
        status = process.poll()
        if status is not None:
            self._log(f"{service} exited with status {status}; restarting")
            return True
        if self._endpoint_healthy(health_url):
            self.health_failures[service] = 0
            return False
        failures = self.health_failures[service] + 1
        self.health_failures[service] = failures
        if failures < HEALTH_FAILURE_LIMIT:
            return False
        self._log(
            f"{service} failed {failures} consecutive health probes; restarting"
        )
        return True

    @staticmethod
    def _endpoint_healthy(url: str) -> bool:
        try:
            with urlopen(
                Request(url, headers={"Cache-Control": "no-store"}),
                timeout=1.5,
            ) as response:
                return 200 <= int(response.status) < 300
        except (HTTPError, URLError, OSError, ValueError):
            return False

    def _spawn(self, service: str) -> subprocess.Popen[bytes]:
        assert self.spec is not None
        entrypoint = self.spec[f"{service}_entrypoint"]
        log_path = self.log_dir / f"{service}.log"
        _rotate_log(log_path)
        command = [
            self.spec["node"],
            entrypoint,
            f"--dina-supervisor-token={self.token}",
        ]
        env = dict(self.spec["environment"])
        with log_path.open("ab", buffering=0) as log:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                cwd=self.manager.install_dir,
                env=env,
                close_fds=True,
            )
        self._write_record(
            f"{service}.json",
            {
                "schema": 1,
                "pid": process.pid,
                "token": self.token,
                "entrypoint": entrypoint,
                "started_at": time.time(),
            },
        )
        self._log(f"started {service} pid={process.pid}")
        return process

    def _wait_endpoint(
        self,
        url: str,
        process: subprocess.Popen[bytes],
        *,
        timeout: float,
    ) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and not self.stop_requested:
            if process.poll() is not None:
                raise HomeNodeError(
                    f"managed process exited during startup with status {process.returncode}"
                )
            try:
                with urlopen(
                    Request(url, headers={"Cache-Control": "no-store"}), timeout=1.5
                ) as response:
                    if 200 <= response.status < 300:
                        return
            except (HTTPError, URLError, OSError):
                pass
            self._write_heartbeat()
            time.sleep(0.25)
        if self.stop_requested:
            return
        raise HomeNodeError(f"managed process did not become ready: {url}")

    def _stop_children(self) -> None:
        self._stop_brain()
        self._terminate("core", self.core)
        self.core = None

    def _stop_brain(self) -> None:
        self._terminate("brain", self.brain)
        self.brain = None

    def _terminate(
        self,
        service: str,
        process: subprocess.Popen[bytes] | None,
    ) -> None:
        if process is None:
            with contextlib.suppress(FileNotFoundError):
                (self.runtime_dir / f"{service}.json").unlink()
            return
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        with contextlib.suppress(FileNotFoundError):
            (self.runtime_dir / f"{service}.json").unlink()

    def _remove_verified_orphans(self) -> None:
        for service, marker in (("brain", "brain.cjs"), ("core", "core.cjs")):
            path = self.runtime_dir / f"{service}.json"
            if not path.is_file() or path.is_symlink():
                continue
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                value = {}
            pid = value.get("pid")
            token = value.get("token")
            if (
                isinstance(pid, int)
                and isinstance(token, str)
                and self.manager._pid_matches(pid, token, marker)
            ):
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.kill(pid, signal.SIGTERM)
            with contextlib.suppress(FileNotFoundError):
                path.unlink()

    def _install_signals(self) -> None:
        def stop(_signum: int, _frame: object) -> None:
            self.stop_requested = True

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)

    def _write_heartbeat(self) -> None:
        self._write_record(
            "supervisor.json",
            {
                "schema": 1,
                "pid": os.getpid(),
                "token": self.token,
                "updated_at": time.time(),
            },
        )

    def _write_record(self, name: str, value: dict[str, Any]) -> None:
        payload = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode(
            "utf-8"
        )
        _atomic_private_write(self.runtime_dir / name, payload)

    def _log(self, message: str) -> None:
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        print(f"{stamp} {message}", flush=True)

    @contextlib.contextmanager
    def _single_instance_lock(self):
        lock_path = self.runtime_dir / "supervisor.lock"
        self.runtime_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock = lock_path.open("a+")
        if os.name != "nt":
            os.chmod(lock_path, 0o600)
        try:
            if os.name == "nt":
                import msvcrt

                lock.seek(0)
                try:
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                except OSError as exc:
                    raise HomeNodeError("another native supervisor already owns this node") from exc
            else:
                import fcntl

                try:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError as exc:
                    raise HomeNodeError("another native supervisor already owns this node") from exc
            yield
        finally:
            lock.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--install-dir", required=True, type=Path)
    parser.add_argument("--token", required=True)
    args = parser.parse_args(argv)
    if (
        len(args.token) != 48
        or any(ch not in "0123456789abcdef" for ch in args.token)
    ):
        print("invalid supervisor token", file=sys.stderr)
        return 2
    return NativeSupervisor(args.install_dir.expanduser().resolve(), args.token).run()


if __name__ == "__main__":
    raise SystemExit(main())
