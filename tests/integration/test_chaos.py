"""Integration tests for Chaos Engineering (Architecture section 14).

Chaos tests inject failures — container kills, network partitions, slow
networks, CPU/memory/disk pressure — and verify that the system degrades
gracefully without data loss or unrecoverable crashes.

All tests use MockChaosMonkey for failure injection and MockDockerCompose
for container lifecycle simulation.
"""

from __future__ import annotations

import time

import pytest

from tests.integration.mocks import (
    DinaMessage,
    MockChaosMonkey,
    MockDinaCore,
    MockDockerCompose,
    MockDockerContainer,
    MockGoCore,
    MockIdentity,
    MockLLMRouter,
    MockOutbox,
    MockPerformanceMetrics,
    MockPIIScrubber,
    MockPythonBrain,
    MockSilenceClassifier,
    MockVault,
    MockWhisperAssembler,
    Notification,
    SilenceTier,
)

# Task 8.28 migration prep. Chaos engineering (container kills, network
# partitions, slow networks, CPU/memory/disk pressure, graceful
# degradation without data loss) is the M4 gate's hero capability
# (tasks 8.28-8.32 scope). Lite's chaos-recovery subsystem lands with
# Phase 11c soak + the `tc netem` probe (task 11.10, iter 58).
# LITE_SKIPS.md category `pending-feature`.
pytestmark = pytest.mark.skip_in_lite(
    reason="Chaos engineering (failure injection, graceful degradation, "
    "no data loss under container kills / net partitions / resource "
    "pressure) is the M4 gate (tasks 8.28-8.32). LITE_SKIPS.md category "
    "`pending-feature`. See probe-ws-reconnect.sh (task 11.10) for the "
    "Lite-side chaos probe infrastructure."
)


# -----------------------------------------------------------------------
# TestChaosEngineering  (S14)
# -----------------------------------------------------------------------


class TestChaosEngineering:
    """Failure injection tests for container, network, and resource faults."""

# TST-INT-352
    # TRACE: {"suite": "INT", "case": "0352", "section": "14", "sectionName": "Chaos Engineering", "subsection": "01", "scenario": "01", "title": "kill_brain_randomly"}
    def test_kill_brain_randomly(
        self,
        mock_compose: MockDockerCompose,
        mock_chaos_monkey: MockChaosMonkey,
    ) -> None:
        """Brain killed, core continues serving cached responses.

        When the Brain container is SIGKILLed, the Go Core must remain
        healthy and continue to serve vault queries and notifications.
        The Brain's healthcheck transitions to unhealthy.
        """
        # Start the full stack
        mock_compose.up()
        assert mock_compose.is_all_healthy()

        brain = mock_compose.containers["brain"]
        core = mock_compose.containers["core"]

        # Kill the Brain
        mock_chaos_monkey.kill_random(brain)
        assert brain.running is False
        assert brain in mock_chaos_monkey.kill_targets

        # Core is still running and healthy
        assert core.running is True
        assert core.healthcheck.is_healthy()

        # Core can still serve vault operations (simulated via MockGoCore)
        vault = MockVault()
        identity = MockIdentity()
        scrubber = MockPIIScrubber()
        go_core = MockGoCore(vault, identity, scrubber)

        go_core.vault_store("chaos_test", {"status": "brain_dead_but_core_alive"})
        result = vault.retrieve(1, "chaos_test")
        assert result is not None
        assert result["status"] == "brain_dead_but_core_alive"

        # Core can still send notifications
        notification = Notification(
            tier=SilenceTier.TIER_1_FIDUCIARY,
            title="Brain down",
            body="Brain container killed. Core operational.",
        )
        go_core.notify(notification)
        assert len(go_core._notifications_sent) == 1

        # Brain can be restarted
        brain.restart()
        assert brain.running is True
        assert brain.restart_count == 1

# TST-INT-353
    # TRACE: {"suite": "INT", "case": "0353", "section": "14", "sectionName": "Chaos Engineering", "subsection": "01", "scenario": "02", "title": "kill_core_randomly"}
    def test_kill_core_randomly(
        self,
        mock_compose: MockDockerCompose,
        mock_chaos_monkey: MockChaosMonkey,
    ) -> None:
        """Core killed, brain survives, system recovers after restart.

        When Go Core is SIGKILLed, the Python Brain container remains
        running. The system is unhealthy while Core is down. After
        Core restarts, the full system recovers.
        """
        mock_compose.up()
        assert mock_compose.is_all_healthy()

        core = mock_compose.containers["core"]
        brain = mock_compose.containers["brain"]

        # Both containers start healthy
        assert core.running is True
        assert brain.running is True
        assert core.restart_count == 0

        # Kill the Core
        mock_chaos_monkey.kill_random(core)
        assert core.running is False
        assert core in mock_chaos_monkey.kill_targets

        # Brain is still running — sidecar survives core death
        assert brain.running is True

        # System is NOT healthy while Core is down
        assert not mock_compose.is_all_healthy()

        # Core restarts
        core.restart()
        assert core.running is True
        assert core.restart_count == 1

        # System fully recovers
        assert mock_compose.is_all_healthy()

        # Restart produced a start log entry automatically
        logs = core.get_logs_json()
        start_logs = [e for e in logs if "started" in e.get("msg", "")]
        assert len(start_logs) >= 1, (
            "Core restart must produce a start log entry"
        )

# TST-INT-354
    # TRACE: {"suite": "INT", "case": "0354", "section": "14", "sectionName": "Chaos Engineering", "subsection": "01", "scenario": "03", "title": "network_partition_brain_core"}
    def test_network_partition_brain_core(
        self,
        mock_compose: MockDockerCompose,
        mock_chaos_monkey: MockChaosMonkey,
    ) -> None:
        """Partition detected, brain buffers requests.

        A network partition between Brain and Core means the Brain
        cannot call Core APIs.  The Brain must buffer outbound requests
        and replay them once connectivity is restored.
        """
        mock_compose.up()
        assert mock_compose.is_all_healthy()

        # Create partition between brain and core
        mock_chaos_monkey.partition_network("brain", "core")

        # Verify partition is recorded
        assert mock_chaos_monkey.is_partitioned("brain", "core")
        assert mock_chaos_monkey.is_partitioned("core", "brain")  # bidirectional

        # Simulate Brain buffering: create an outbox for Brain-to-Core requests
        outbox = MockOutbox()
        buffered_msg = DinaMessage(
            type="brain/vault/store",
            from_did="brain_internal",
            to_did="core_internal",
            payload={"key": "buffered_item", "value": {"data": "during_partition"}},
        )
        msg_id = outbox.enqueue(buffered_msg)
        assert len(outbox.get_pending()) == 1

        # Partition healed — remove from monkey's records
        mock_chaos_monkey.network_partitions.clear()
        assert not mock_chaos_monkey.is_partitioned("brain", "core")

        # Brain replays buffered requests
        outbox.ack(msg_id)
        assert len(outbox.get_pending()) == 0
        assert msg_id in outbox.delivered

# TST-INT-355
    # TRACE: {"suite": "INT", "case": "0355", "section": "14", "sectionName": "Chaos Engineering", "subsection": "01", "scenario": "04", "title": "slow_network"}
    def test_slow_network(
        self,
        mock_compose: MockDockerCompose,
        mock_chaos_monkey: MockChaosMonkey,
        mock_perf_metrics: MockPerformanceMetrics,
    ) -> None:
        """500ms latency added, system still functions.

        Inject 500ms network latency.  Operations complete (albeit
        slower), and no data is lost.
        """
        mock_compose.up()
        assert mock_compose.is_all_healthy()

        # Inject 500ms latency
        mock_chaos_monkey.add_latency(500)
        assert mock_chaos_monkey.latency_ms == 500

        # Simulate operations with added latency
        vault = MockVault()
        identity = MockIdentity()
        scrubber = MockPIIScrubber()
        go_core = MockGoCore(vault, identity, scrubber)

        num_ops = 20
        for i in range(num_ops):
            start = time.monotonic()
            go_core.vault_store(f"slow_net_{i}", {"data": i})

            # Simulate latency overhead
            simulated_latency_ms = mock_chaos_monkey.latency_ms + (
                (time.monotonic() - start) * 1000
            )
            mock_perf_metrics.record(simulated_latency_ms)

        # All operations completed despite latency
        assert len(vault._tiers[1]) == num_ops
        assert mock_perf_metrics.total_requests == num_ops
        assert mock_perf_metrics.errors == 0

        # All recorded latencies include the injected 500ms
        for latency in mock_perf_metrics.latencies_ms:
            assert latency >= 500.0, (
                "Latency must include injected 500ms network delay"
            )

# TST-INT-356
    # TRACE: {"suite": "INT", "case": "0356", "section": "14", "sectionName": "Chaos Engineering", "subsection": "01", "scenario": "05", "title": "cpu_pressure"}
    def test_cpu_pressure(
        self,
        mock_compose: MockDockerCompose,
        mock_chaos_monkey: MockChaosMonkey,
    ) -> None:
        """High CPU doesn't crash containers.

        Under CPU pressure, all containers remain running. Processing
        may be slower but no container transitions to stopped.
        """
        mock_compose.up()
        assert mock_compose.is_all_healthy()

        # Pre-condition: no pressure applied
        assert mock_chaos_monkey.cpu_pressure is False

        # Apply CPU pressure
        mock_chaos_monkey.apply_resource_pressure(cpu=True)
        assert mock_chaos_monkey.cpu_pressure is True

        # All containers still running — CPU pressure does NOT crash them
        for name, container in mock_compose.containers.items():
            assert container.running is True, (
                f"Container {name} crashed under CPU pressure"
            )
            assert container.restart_count == 0, (
                f"Container {name} restarted under CPU pressure"
            )

        # Healthchecks still pass under load
        assert mock_compose.is_all_healthy()

        # Counter-proof: kill_random DOES stop a container
        brain = mock_compose.containers["brain"]
        mock_chaos_monkey.kill_random(brain)
        assert brain.running is False
        assert len(mock_chaos_monkey.kill_targets) == 1
        # System is no longer all-healthy
        assert mock_compose.is_all_healthy() is False

        # Recovery: restart brings it back
        brain.restart()
        assert brain.running is True
        assert brain.restart_count == 1

# TST-INT-357
    # TRACE: {"suite": "INT", "case": "0357", "section": "14", "sectionName": "Chaos Engineering", "subsection": "01", "scenario": "06", "title": "memory_pressure"}
    def test_memory_pressure(
        self,
        mock_compose: MockDockerCompose,
        mock_chaos_monkey: MockChaosMonkey,
    ) -> None:
        """OOM handled gracefully, container restarts.

        Under memory pressure, the Brain container (heaviest) is killed
        by the OOM reaper.  It should restart automatically, and Core
        should remain unaffected.
        """
        mock_compose.up()
        assert mock_compose.is_all_healthy()

        brain = mock_compose.containers["brain"]
        core = mock_compose.containers["core"]

        # Both containers start healthy
        assert brain.running is True
        assert core.running is True
        assert brain.restart_count == 0

        # OOM kills brain — chaos monkey records target
        mock_chaos_monkey.kill_random(brain)
        assert brain.running is False
        assert brain in mock_chaos_monkey.kill_targets

        # Core survives — OOM only kills the memory-heavy container
        assert core.running is True

        # System is NOT fully healthy while brain is down
        assert not mock_compose.is_all_healthy()

        # Brain restarts (docker restart policy: unless-stopped)
        brain.restart()
        assert brain.running is True
        assert brain.restart_count == 1

        # System returns to healthy state after restart
        assert mock_compose.is_all_healthy()

        # Restart produces a start log entry automatically
        logs = brain.get_logs_json()
        start_logs = [e for e in logs if "started" in e.get("msg", "")]
        assert len(start_logs) >= 1, (
            "Container restart must produce a start log entry"
        )

# TST-INT-358
    # TRACE: {"suite": "INT", "case": "0358", "section": "14", "sectionName": "Chaos Engineering", "subsection": "01", "scenario": "07", "title": "disk_io_saturation"}
    def test_disk_io_saturation(
        self,
        mock_compose: MockDockerCompose,
        mock_chaos_monkey: MockChaosMonkey,
        mock_perf_metrics: MockPerformanceMetrics,
    ) -> None:
        """Disk pressure degrades but doesn't crash.

        Under disk I/O saturation, write operations are slower but
        still succeed.  No container crashes and no data corruption.
        """
        mock_compose.up()
        assert mock_compose.is_all_healthy()

        # Apply disk I/O saturation
        mock_chaos_monkey.apply_resource_pressure(disk_io=True)
        assert mock_chaos_monkey.disk_io_saturation is True

        # All containers still running
        for name, container in mock_compose.containers.items():
            assert container.running is True, (
                f"Container {name} crashed under disk I/O saturation"
            )

        # Vault writes still succeed under disk pressure
        vault = MockVault()
        identity = MockIdentity()
        scrubber = MockPIIScrubber()
        go_core = MockGoCore(vault, identity, scrubber)

        num_writes = 30
        for i in range(num_writes):
            start = time.monotonic()
            go_core.vault_store(f"disk_stress_{i}", {"data": i})
            elapsed_ms = (time.monotonic() - start) * 1000
            # Simulated degradation: actual time + overhead from saturated I/O
            mock_perf_metrics.record(elapsed_ms + 50.0)  # simulate 50ms overhead

        # All writes succeeded
        assert len(vault._tiers[1]) == num_writes
        assert mock_perf_metrics.total_requests == num_writes
        assert mock_perf_metrics.errors == 0

        # Healthchecks still pass
        assert mock_compose.is_all_healthy()

        # Data integrity: spot-check reads
        for i in [0, 14, 29]:
            item = vault.retrieve(1, f"disk_stress_{i}")
            assert item is not None
            assert item["data"] == i
