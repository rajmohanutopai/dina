from __future__ import annotations

from pathlib import Path

from dina_cli.home_node_supervisor import HEALTH_FAILURE_LIMIT, NativeSupervisor


class FakeProcess:
    def __init__(self, status: int | None = None) -> None:
        self.status = status
        self.returncode = status
        self.terminated = False
        self.killed = False

    def poll(self) -> int | None:
        return self.status

    def terminate(self) -> None:
        self.terminated = True
        self.status = 0
        self.returncode = 0

    def wait(self, timeout: float) -> int:
        return self.status or 0

    def kill(self) -> None:
        self.killed = True
        self.status = -9
        self.returncode = -9


def _supervisor(tmp_path: Path) -> NativeSupervisor:
    supervisor = NativeSupervisor(tmp_path / "home-node", "a" * 48)
    supervisor.runtime_dir.mkdir(parents=True)
    supervisor.log_dir.mkdir(parents=True)
    supervisor.spec = {
        "config": {"core_port": 8100, "brain_port": 8200},
        "node": "/runtime/node",
        "core_entrypoint": "/release/core.cjs",
        "brain_entrypoint": "/release/brain.cjs",
        "environment": {},
    }
    return supervisor


def test_reconcile_restarts_brain_after_crashed_core(
    tmp_path: Path,
    monkeypatch,
) -> None:
    supervisor = _supervisor(tmp_path)
    crashed_core = FakeProcess(17)
    old_brain = FakeProcess()
    supervisor.core = crashed_core  # type: ignore[assignment]
    supervisor.brain = old_brain  # type: ignore[assignment]
    events: list[str] = []

    def spawn(service: str) -> FakeProcess:
        events.append(f"spawn:{service}")
        return FakeProcess()

    monkeypatch.setattr(supervisor, "_spawn", spawn)
    monkeypatch.setattr(
        supervisor,
        "_wait_endpoint",
        lambda _url, _process, *, timeout: events.append(f"ready:{timeout:g}"),
    )
    monkeypatch.setattr(supervisor, "_endpoint_healthy", lambda _url: True)

    supervisor._reconcile()

    assert crashed_core.terminated is False
    assert old_brain.terminated is True
    assert events == ["spawn:core", "ready:120", "spawn:brain", "ready:120"]


def test_reconcile_tolerates_transient_health_failures_before_restart(
    tmp_path: Path,
    monkeypatch,
) -> None:
    supervisor = _supervisor(tmp_path)
    old_core = FakeProcess()
    old_brain = FakeProcess()
    supervisor.core = old_core  # type: ignore[assignment]
    supervisor.brain = old_brain  # type: ignore[assignment]
    events: list[str] = []

    def healthy(url: str) -> bool:
        return url.endswith("/readyz")

    def spawn(service: str) -> FakeProcess:
        events.append(f"spawn:{service}")
        return FakeProcess()

    monkeypatch.setattr(supervisor, "_endpoint_healthy", healthy)
    monkeypatch.setattr(supervisor, "_spawn", spawn)
    monkeypatch.setattr(
        supervisor,
        "_wait_endpoint",
        lambda _url, _process, *, timeout: events.append(f"ready:{timeout:g}"),
    )

    for _ in range(HEALTH_FAILURE_LIMIT - 1):
        supervisor._reconcile()
        assert old_core.terminated is False
        assert old_brain.terminated is False
        assert events == []

    supervisor._reconcile()

    assert old_core.terminated is True
    assert old_brain.terminated is True
    assert events == ["spawn:core", "ready:120", "spawn:brain", "ready:120"]


def test_successful_probe_resets_consecutive_failure_count(
    tmp_path: Path,
    monkeypatch,
) -> None:
    supervisor = _supervisor(tmp_path)
    supervisor.core = FakeProcess()  # type: ignore[assignment]
    supervisor.brain = FakeProcess()  # type: ignore[assignment]
    core_results = iter([False, False, True, False, False])

    def healthy(url: str) -> bool:
        if url.endswith("/healthz"):
            return next(core_results)
        return True

    monkeypatch.setattr(supervisor, "_endpoint_healthy", healthy)

    for _ in range(5):
        supervisor._reconcile()

    assert supervisor.health_failures["core"] == 2
    assert supervisor.core is not None
    assert supervisor.core.terminated is False  # type: ignore[union-attr]
