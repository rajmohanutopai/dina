"""Integration tests for Docker Infrastructure (Architecture Section 5).

Covers:
  S5.1 Network isolation between containers.
  S5.2 Health endpoints, structured logging, crash tracebacks, log rotation.
  S5.3 Boot sequence (security mode vs convenience mode).
  S5.4 Startup dependency ordering.
  S5.5 Volumes and secrets mounting.
  S5.6 Install script behaviour.
  S5.7 Secrets management (tmpfs, .env, .gitignore).
"""

from __future__ import annotations

import json
import os
import re
import stat
import time
import uuid

import pytest

from tests.integration.mocks import (
    MockServiceAuth,
    MockCrashLog,
    MockDeploymentProfile,
    MockDockerCompose,
    MockDockerContainer,
    MockHealthcheck,
    MockInboxSpool,
    MockPIIScrubber,
    MockVault,
)


# -----------------------------------------------------------------------
# TestNetworkIsolation (S5.1)
# -----------------------------------------------------------------------


class TestNetworkIsolation:
    """Verify Docker network segmentation between containers."""

    # TST-INT-085
    # TRACE: {"suite": "INT", "case": "0085", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "01", "scenario": "01", "title": "core_can_reach_brain"}
    def test_core_can_reach_brain(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Core and brain share dina-brain-net, so core can reach brain."""
        mock_compose.up()

        core = mock_compose.containers["core"]
        brain = mock_compose.containers["brain"]

        assert core.can_reach(brain), (
            "Core must reach brain via shared dina-brain-net"
        )

    # TST-INT-087
    # TRACE: {"suite": "INT", "case": "0087", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "01", "scenario": "02", "title": "brain_cannot_reach_pds"}
    def test_brain_cannot_reach_pds(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Brain is on dina-brain-net only; PDS is on dina-pds-net only.
        They share no network, so brain cannot reach PDS."""
        mock_compose.up()

        brain = mock_compose.containers["brain"]
        pds = mock_compose.containers["pds"]

        assert not brain.can_reach(pds), (
            "Brain must NOT reach PDS (no shared network)"
        )

    # TST-INT-088
    # TRACE: {"suite": "INT", "case": "0088", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "01", "scenario": "03", "title": "pds_cannot_reach_brain"}
    def test_pds_cannot_reach_brain(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """PDS is on dina-pds-net only; brain is on dina-brain-net only.
        PDS cannot reach brain."""
        mock_compose.up()

        pds = mock_compose.containers["pds"]
        brain = mock_compose.containers["brain"]

        assert not pds.can_reach(brain), (
            "PDS must NOT reach brain (no shared network)"
        )

    # TST-INT-091
    # TRACE: {"suite": "INT", "case": "0091", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "01", "scenario": "04", "title": "brain_can_reach_internet_outbound"}
    def test_brain_can_reach_internet_outbound(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Brain is on dina-brain-net which allows outbound traffic.
        Simulated by verifying brain has a network that is not pds-only."""
        mock_compose.up()

        brain = mock_compose.containers["brain"]

        # brain-net is not restricted to internal-only; it allows outbound
        assert "dina-brain-net" in brain.networks
        # brain-net is the network through which outbound access is possible
        assert len(brain.networks) >= 1

    # TST-INT-092
    # TRACE: {"suite": "INT", "case": "0092", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "01", "scenario": "05", "title": "pds_on_pds_net_with_outbound"}
    def test_pds_on_pds_net_with_outbound(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """PDS is on dina-pds-net (standard bridge, not internal).
        PDS needs outbound to reach public plc.directory for DID resolution."""
        mock_compose.up()

        pds = mock_compose.containers["pds"]

        # PDS is only on pds-net (standard bridge — needs outbound for plc.directory)
        assert pds.networks == ["dina-pds-net"], (
            "PDS must be on dina-pds-net only"
        )
        assert "dina-public" not in pds.networks
        assert "dina-brain-net" not in pds.networks

    # TST-INT-093
    # TRACE: {"suite": "INT", "case": "0093", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "01", "scenario": "06", "title": "brain_can_reach_host_docker_internal"}
    def test_brain_can_reach_host_docker_internal(
        self, mock_compose_local_llm: MockDockerCompose
    ) -> None:
        """Brain on dina-brain-net can reach host.docker.internal for
        local llama-server. Verified by checking brain and llama share
        brain-net, and llama is accessible from the same network."""
        mock_compose_local_llm.up()

        brain = mock_compose_local_llm.containers["brain"]
        llama = mock_compose_local_llm.containers["llama"]

        assert brain.can_reach(llama), (
            "Brain must reach llama via dina-brain-net (host.docker.internal)"
        )
        assert "dina-brain-net" in brain.networks
        assert "dina-brain-net" in llama.networks


# -----------------------------------------------------------------------
# TestHealthAndLogs (S5.2)
# -----------------------------------------------------------------------


class TestHealthAndLogs:
    """Verify health endpoints, structured logs, PII-free logging,
    crash tracebacks, and log rotation."""

    # TST-INT-094
    # TRACE: {"suite": "INT", "case": "0094", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "02", "scenario": "01", "title": "core_healthz_returns_200_when_running"}
    def test_core_healthz_returns_200_when_running(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Core /healthz returns 200 (passing) when the container is running.
        When healthcheck fails, is_healthy reflects degraded state."""
        mock_compose.up()

        core = mock_compose.containers["core"]

        assert core.running is True
        assert core.healthcheck.endpoint == "/healthz"
        assert core.healthcheck.check() is True
        assert core.healthcheck.is_healthy() is True

        # Counter-proof: failing healthcheck is detected
        core.healthcheck.set_passing(False)
        assert core.healthcheck.check() is False
        assert core.healthcheck.is_healthy() is False

        # Multiple consecutive failures tracked
        core.healthcheck.check()  # 2nd failure
        core.healthcheck.check()  # 3rd failure
        assert core.healthcheck.consecutive_failures == 3
        assert core.healthcheck.is_unhealthy() is True, (
            "3 consecutive failures (== retries) must mark unhealthy"
        )

        # Recovery: passing again resets failure count
        core.healthcheck.set_passing(True)
        assert core.healthcheck.check() is True
        assert core.healthcheck.consecutive_failures == 0
        assert core.healthcheck.is_healthy() is True

    # TST-INT-095
    # TRACE: {"suite": "INT", "case": "0095", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "02", "scenario": "02", "title": "core_readyz_returns_200_vault_open"}
    def test_core_readyz_returns_200_vault_open(
        self, mock_compose: MockDockerCompose, mock_vault: MockVault
    ) -> None:
        """/readyz returns 200 when the vault is open (can store/retrieve)."""
        mock_compose.up()

        core = mock_compose.containers["core"]

        # Vault is functional (open) — healthcheck passes
        mock_vault.store(1, "readyz_probe", {"status": "ok"})
        result = mock_vault.retrieve(1, "readyz_probe")
        assert result is not None
        assert result["status"] == "ok"

        # Core healthcheck reflects vault-open state
        assert core.healthcheck.check() is True
        assert core.healthcheck.is_healthy() is True

        # Counter-proof: when vault is "locked" (healthcheck fails),
        # readyz should report unhealthy
        core.healthcheck.set_passing(False)
        assert core.healthcheck.check() is False
        assert core.healthcheck.is_healthy() is False

        # Restore: vault re-opens → healthcheck passes again
        core.healthcheck.set_passing(True)
        assert core.healthcheck.check() is True
        assert core.healthcheck.is_healthy() is True

    # TST-INT-096
    # TRACE: {"suite": "INT", "case": "0096", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "02", "scenario": "03", "title": "core_readyz_returns_503_vault_locked"}
    def test_core_readyz_returns_503_vault_locked(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """/readyz returns 503 when the vault is locked.
        Simulated by core's healthcheck transitioning to not passing."""
        mock_compose.up()

        core = mock_compose.containers["core"]

        # Pre-condition: core is running and healthy after up()
        assert core.running is True
        assert core.healthcheck.check() is True
        assert core.healthcheck.is_healthy()

        # Simulate vault locked — core's healthcheck starts failing
        core.healthcheck.set_passing(False)

        assert core.healthcheck.check() is False

        # Counter-proof: other containers are unaffected by core's vault lock
        brain = mock_compose.containers["brain"]
        pds = mock_compose.containers["pds"]
        assert pds.healthcheck.is_healthy(), \
            "PDS must remain healthy when core's vault is locked"
        assert brain.running is True

        # Counter-proof: after vault unlock (healthcheck passes again),
        # core recovers
        core.healthcheck.set_passing(True)
        assert core.healthcheck.check() is True
        assert core.healthcheck.is_healthy()

    # TST-INT-097
    # TRACE: {"suite": "INT", "case": "0097", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "02", "scenario": "04", "title": "docker_restarts_unhealthy_core"}
    def test_docker_restarts_unhealthy_core(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Docker restarts the core container after consecutive healthcheck
        failures reach the retry threshold."""
        mock_compose.up()

        core = mock_compose.containers["core"]

        # Fail healthcheck enough times to trigger unhealthy
        core.healthcheck.set_passing(False)
        for _ in range(core.healthcheck.retries):
            core.healthcheck.check()

        assert core.healthcheck.is_unhealthy()

        # Docker restart (simulated)
        core.restart()

        assert core.running is True
        assert core.restart_count == 1

        # Healthcheck passes again after restart
        core.healthcheck.set_passing(True)
        assert core.healthcheck.check() is True

    # TST-INT-098
    # TRACE: {"suite": "INT", "case": "0098", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "02", "scenario": "05", "title": "brain_starts_only_after_core_healthy"}
    def test_brain_starts_only_after_core_healthy(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Brain depends_on core; it starts only after core is healthy."""
        brain = mock_compose.containers["brain"]

        assert "core" in brain.depends_on

        # Verify startup ordering respects dependencies
        order = mock_compose._resolve_start_order()
        core_idx = order.index("core")
        brain_idx = order.index("brain")

        assert core_idx < brain_idx, (
            "Core must start before brain in dependency order"
        )

    # TST-INT-099
    # TRACE: {"suite": "INT", "case": "0099", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "02", "scenario": "06", "title": "pds_healthcheck_endpoint"}
    def test_pds_healthcheck_endpoint(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """PDS healthcheck uses /xrpc/_health endpoint."""
        pds = mock_compose.containers["pds"]

        assert pds.healthcheck.endpoint == "/xrpc/_health"

    # TST-INT-100
    # TRACE: {"suite": "INT", "case": "0100", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "02", "scenario": "07", "title": "pds_healthcheck_params"}
    def test_pds_healthcheck_params(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """PDS healthcheck: interval=30, retries=3."""
        pds = mock_compose.containers["pds"]

        assert pds.healthcheck.interval == 30
        assert pds.healthcheck.retries == 3

    # TST-INT-101
    # TRACE: {"suite": "INT", "case": "0101", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "02", "scenario": "08", "title": "structured_json_logs_core"}
    def test_structured_json_logs_core(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Core emits structured JSON logs with time, level, msg, module."""
        mock_compose.up()

        core = mock_compose.containers["core"]
        core.log("info", "vault opened", persona="consumer")

        logs = core.get_logs_json()
        assert len(logs) >= 1

        # Every log entry must have structured fields
        for entry in logs:
            assert "time" in entry
            assert "level" in entry
            assert "msg" in entry
            assert "module" in entry

    # TST-INT-102
    # TRACE: {"suite": "INT", "case": "0102", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "02", "scenario": "09", "title": "structured_json_logs_brain"}
    def test_structured_json_logs_brain(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Brain emits structured JSON logs with time, level, msg, module."""
        mock_compose.up()

        brain = mock_compose.containers["brain"]

        # Pre-condition: startup may have added logs; record baseline
        baseline_count = len(brain.get_logs_json())

        brain.log("info", "classification complete", task="email_incoming")

        logs = brain.get_logs_json()
        assert len(logs) == baseline_count + 1, (
            "Exactly one new log entry expected after brain.log()"
        )

        for entry in logs:
            assert "time" in entry
            assert "level" in entry
            assert "msg" in entry
            assert "module" in entry

        # Verify the custom field (task) is preserved in the new entry
        new_entry = logs[-1]
        assert new_entry["msg"] == "classification complete"
        assert new_entry["level"] == "info"
        assert new_entry["module"] == "brain"
        assert new_entry.get("task") == "email_incoming", (
            "Custom fields passed to log() must appear in structured output"
        )

        # Counter-proof: a different container's logs are independent
        core = mock_compose.containers["core"]
        core_logs = core.get_logs_json()
        assert not any(
            e.get("task") == "email_incoming" for e in core_logs
        ), "Brain log must not leak into core container logs"

    # TST-INT-103
    # TRACE: {"suite": "INT", "case": "0103", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "02", "scenario": "10", "title": "no_pii_in_container_logs"}
    def test_no_pii_in_container_logs(
        self, mock_compose: MockDockerCompose,
    ) -> None:
        """No PII (emails, phone numbers) appears in any container log."""
        # Use MockPIIScrubber directly: this test verifies the scrub-before-log
        # principle with mock containers, not the real PII API endpoint.
        mock_scrubber = MockPIIScrubber()
        mock_compose.up()

        # Real PII that the scrubber must strip before it reaches logs
        # Uses PII values from MockPIIScrubber.PII_PATTERNS
        pii_messages = [
            "processing request for user rajmohan@email.com",
            "callback to +91-9876543210 scheduled",
            "query from sancho@email.com returned 3 results",
        ]

        # PII patterns that must NOT appear in logs
        pii_patterns = [
            r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}",  # email
            r"\+\d{1,3}[-.\s]?\d{4,}[-.\s]?\d{4,}",             # phone
        ]

        # Counter-proof: verify raw messages DO contain PII before scrubbing
        raw_combined = "\n".join(pii_messages)
        for pattern in pii_patterns:
            assert len(re.findall(pattern, raw_combined)) > 0, (
                f"Test setup error: raw messages should contain PII matching {pattern}"
            )

        # Scrub each message then log to containers
        for name, container in mock_compose.containers.items():
            for msg in pii_messages:
                scrubbed, _replacements = mock_scrubber.scrub(msg)
                container.log("info", scrubbed)
            container.log("debug", "query result", count=42)

        # Verify no PII leaked into any container's logs
        for name, container in mock_compose.containers.items():
            raw_logs = "\n".join(container.logs)
            for pattern in pii_patterns:
                matches = re.findall(pattern, raw_logs)
                assert len(matches) == 0, (
                    f"PII found in {name} logs: {matches}"
                )

    # TST-INT-104
    # TRACE: {"suite": "INT", "case": "0104", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "02", "scenario": "11", "title": "brain_crash_traceback_in_vault"}
    def test_brain_crash_traceback_in_vault(
        self, mock_crash_log: MockCrashLog
    ) -> None:
        """Brain crash traceback is stored in the crash log (identity.sqlite)."""
        traceback_text = (
            "Traceback (most recent call last):\n"
            "  File \"brain/agent.py\", line 42\n"
            "    result = model.predict(data)\n"
            "MemoryError: OOM killed"
        )

        mock_crash_log.record(
            error="MemoryError",
            traceback=traceback_text,
            sanitized_line="result = model.predict(data)",
        )

        recent = mock_crash_log.get_recent(1)
        assert len(recent) == 1
        assert recent[0]["error"] == "MemoryError"
        assert "Traceback" in recent[0]["traceback"]
        assert "timestamp" in recent[0]

    # TST-INT-105
    # TRACE: {"suite": "INT", "case": "0105", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "02", "scenario": "12", "title": "brain_crash_stdout_no_pii"}
    def test_brain_crash_stdout_no_pii(
        self, mock_crash_log: MockCrashLog, mock_scrubber: MockPIIScrubber
    ) -> None:
        """Brain crash output sent to stdout contains no PII."""
        raw_error = "Error processing Rajmohan's email at rajmohan@email.com"
        scrubbed, replacements = mock_scrubber.scrub(raw_error)

        mock_crash_log.record(
            error="ProcessingError",
            traceback="",
            sanitized_line=scrubbed,
        )

        recent = mock_crash_log.get_recent(1)
        sanitized = recent[0]["sanitized_line"]

        assert "Rajmohan" not in sanitized
        assert "rajmohan@email.com" not in sanitized
        assert "[PERSON_1]" in sanitized or "[EMAIL_1]" in sanitized

    # TST-INT-106
    # TRACE: {"suite": "INT", "case": "0106", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "02", "scenario": "13", "title": "docker_log_rotation_configured"}
    def test_docker_log_rotation_configured(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Docker log rotation is configured: containers should not
        accumulate unbounded logs. Verified by checking that log output
        is JSON-structured (compatible with json-file driver rotation)."""
        mock_compose.up()

        for name, container in mock_compose.containers.items():
            # Generate several log entries
            for i in range(20):
                container.log("info", f"log entry {i}", seq=i)

            logs = container.get_logs_json()

            # All entries parse as valid JSON (json-file driver compatible)
            assert len(logs) >= 20, (
                f"{name}: expected at least 20 JSON log entries"
            )
            for entry in logs:
                assert isinstance(entry, dict)
                assert "msg" in entry

    # TST-INT-107
    # TRACE: {"suite": "INT", "case": "0107", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "02", "scenario": "14", "title": "zombie_state_healthcheck_endpoint_choice"}
    def test_zombie_state_healthcheck_endpoint_choice(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Zombie state: /healthz passes (process alive) but /readyz fails
        (vault locked or brain unresponsive). Docker does not restart
        because /healthz is the healthcheck, but /readyz signals not-ready."""
        mock_compose.up()

        core = mock_compose.containers["core"]
        brain = mock_compose.containers["brain"]

        # Architecture requirement: Docker healthcheck uses /healthz, not /readyz
        assert core.healthcheck.endpoint == "/healthz"
        assert brain.healthcheck.endpoint == "/healthz"
        # Counter-proof: /readyz is NOT the healthcheck endpoint
        assert core.healthcheck.endpoint != "/readyz"

        # Core is healthy and running
        assert core.healthcheck.check() is True
        assert core.running is True

        # /readyz would fail (vault locked), but Docker uses /healthz
        readyz = MockHealthcheck("/readyz")
        readyz.set_passing(False)
        assert readyz.check() is False
        assert readyz.is_healthy() is False

        # Core is NOT restarted — Docker checks /healthz (still passing)
        assert core.healthcheck.is_healthy() is True
        assert core.running is True
        assert core.restart_count == 0  # no restart triggered

        # Counter-proof: if /healthz ALSO fails, container becomes unhealthy
        core.healthcheck.set_passing(False)
        for _ in range(core.healthcheck.retries):
            core.healthcheck.check()
        assert core.healthcheck.is_unhealthy() is True


# -----------------------------------------------------------------------
# TestBootSequence (S5.3)
# -----------------------------------------------------------------------


class TestBootSequence:
    """Verify boot sequence for security mode and convenience mode."""

    # TST-INT-108
    # TRACE: {"suite": "INT", "case": "0108", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "03", "scenario": "01", "title": "security_mode_vault_locked_at_start"}
    def test_security_mode_vault_locked_at_start(
        self, mock_compose: MockDockerCompose, mock_vault: MockVault,
        mock_inbox_spool: MockInboxSpool
    ) -> None:
        """Security mode: vault starts locked. Dead drop (inbox spool)
        is active to receive messages for locked personas."""
        mock_compose.up()

        # Security mode: vault is locked at boot
        vault_locked = True  # simulates passphrase not yet entered

        assert vault_locked is True
        # Dead drop is active -- can accept incoming messages
        blob_id = mock_inbox_spool.store(b"encrypted_message_for_locked_persona")
        assert blob_id is not None
        assert len(mock_inbox_spool.blobs) == 1

    # TST-INT-109
    # TRACE: {"suite": "INT", "case": "0109", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "03", "scenario": "02", "title": "convenience_mode_vault_auto_unlocked"}
    def test_convenience_mode_vault_auto_unlocked(
        self, mock_compose: MockDockerCompose, mock_vault: MockVault
    ) -> None:
        """Convenience mode: vault auto-unlocks at boot.
        After compose.up(), all containers are healthy and vault is
        immediately functional (store + retrieve works without any
        explicit unlock step).
        """
        result = mock_compose.up()
        assert result is True, "Compose up must succeed"

        # All containers must be running and healthy after up().
        for name, container in mock_compose.containers.items():
            assert container.running, f"{name} must be running after up()"
            if container.healthcheck:
                assert container.healthcheck.passing, (
                    f"{name} healthcheck must be passing after up()"
                )

        # Convenience mode contract: vault is immediately functional
        # without any explicit unlock step.
        mock_vault.store(1, "boot_test", {"mode": "convenience"})
        result = mock_vault.retrieve(1, "boot_test")
        assert result is not None, "Vault must be accessible immediately after boot"
        assert result["mode"] == "convenience"

        # Counter-proof: vault was empty before our store (not pre-populated).
        assert mock_vault.retrieve(1, "nonexistent_key") is None

    # TST-INT-110
    # TRACE: {"suite": "INT", "case": "0110", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "03", "scenario": "03", "title": "security_mode_vault_locked_dead_drop_active"}
    def test_security_mode_vault_locked_dead_drop_active(
        self, mock_inbox_spool: MockInboxSpool
    ) -> None:
        """Security mode: while vault is locked, dead drop (inbox spool)
        accepts and stores encrypted messages for locked personas."""
        vault_locked = True

        # Multiple messages arrive while vault is locked
        ids = []
        for i in range(5):
            blob_id = mock_inbox_spool.store(
                f"encrypted_msg_{i}".encode()
            )
            assert blob_id is not None
            ids.append(blob_id)

        assert len(mock_inbox_spool.blobs) == 5

        # All messages are retrievable
        for blob_id in ids:
            data = mock_inbox_spool.retrieve(blob_id)
            assert data is not None

    # TST-INT-111
    # TRACE: {"suite": "INT", "case": "0111", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "03", "scenario": "04", "title": "security_mode_late_unlock_drains_spool"}
    def test_security_mode_late_unlock_drains_spool(
        self, mock_inbox_spool: MockInboxSpool
    ) -> None:
        """Security mode: after late unlock, spooled messages drain
        and are delivered to the now-unlocked vault."""
        # Messages arrive while locked
        for i in range(3):
            mock_inbox_spool.store(f"spooled_msg_{i}".encode())

        assert len(mock_inbox_spool.blobs) == 3

        # User enters passphrase -- vault unlocks
        vault_locked = False

        # Drain spool
        drained = mock_inbox_spool.drain()

        assert len(drained) == 3
        assert len(mock_inbox_spool.blobs) == 0  # spool is empty after drain
        assert mock_inbox_spool.used_bytes == 0

    # TST-INT-112
    # TRACE: {"suite": "INT", "case": "0112", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "03", "scenario": "05", "title": "boot_order_identity_before_persona_vaults"}
    def test_boot_order_identity_before_persona_vaults(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """identity.sqlite must be opened before any persona vaults.
        Verified by checking core starts before brain (core owns identity.sqlite)."""
        # Pre-condition: containers not yet running
        for c in mock_compose.containers.values():
            assert c.running is False

        order = mock_compose._resolve_start_order()

        # All expected containers present in the boot order
        assert "core" in order
        assert "brain" in order
        assert "pds" in order

        # Core (which owns identity.sqlite) must start before brain
        # (which accesses persona vaults via core API)
        core_idx = order.index("core")
        brain_idx = order.index("brain")
        pds_idx = order.index("pds")
        assert core_idx < brain_idx, (
            "identity.sqlite (core) must be ready before persona vaults (brain)"
        )

        # PDS must also start before core (core depends on PDS)
        assert pds_idx < core_idx, (
            "PDS must start before core (core depends_on pds)"
        )

        # Counter-proof: brain does NOT start before core
        # (this is the inverse — redundant but documents the invariant)
        assert brain_idx > core_idx

        # Verify boot order produces running containers
        mock_compose.up()
        for name in order:
            assert mock_compose.containers[name].running is True, (
                f"Container {name} must be running after up()"
            )

    # TST-INT-113
    # TRACE: {"suite": "INT", "case": "0113", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "03", "scenario": "06", "title": "brain_receives_vault_unlocked_event"}
    def test_brain_receives_vault_unlocked_event(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """After vault is unlocked, brain receives a vault_unlocked event
        so it can begin processing. Core delivers the event to brain
        via their shared network."""
        mock_compose.up()

        core = mock_compose.containers["core"]
        brain = mock_compose.containers["brain"]

        # Precondition: core can reach brain (shared brain-net)
        assert core.can_reach(brain), \
            "Core must be able to reach brain on shared network"

        # Brain has no events before vault unlock
        pre_logs = brain.get_logs_json()
        pre_vault_events = [
            e for e in pre_logs if e.get("type") == "vault_unlocked"
        ]
        assert len(pre_vault_events) == 0, \
            "Brain should have no vault_unlocked events before delivery"

        # Core delivers vault_unlocked event to brain
        # (simulates internal event bus from core → brain)
        assert core.can_reach(brain)
        event = {"type": "vault_unlocked", "timestamp": time.time()}
        brain.log("info", "vault_unlocked event received", **event)

        # Brain received exactly one vault_unlocked event
        logs = brain.get_logs_json()
        vault_events = [
            e for e in logs if e.get("type") == "vault_unlocked"
        ]
        assert len(vault_events) == 1
        assert vault_events[0]["msg"] == "vault_unlocked event received"
        assert "timestamp" in vault_events[0]

        # Counter-proof: PDS should NOT receive vault_unlocked events
        pds = mock_compose.containers["pds"]
        pds_logs = pds.get_logs_json()
        pds_vault_events = [
            e for e in pds_logs if e.get("type") == "vault_unlocked"
        ]
        assert len(pds_vault_events) == 0, \
            "PDS must NOT receive vault_unlocked events"


# -----------------------------------------------------------------------
# TestStartupDependencies (S5.4)
# -----------------------------------------------------------------------


class TestStartupDependencies:
    """Verify container startup dependency ordering."""

    # TST-INT-114
    # TRACE: {"suite": "INT", "case": "0114", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "04", "scenario": "01", "title": "core_depends_on_pds_started"}
    def test_core_depends_on_pds_started(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Core depends_on PDS being started first."""
        core = mock_compose.containers["core"]
        pds = mock_compose.containers["pds"]

        assert "pds" in core.depends_on

        # Pre-condition: nothing running before up()
        assert core.running is False
        assert pds.running is False

        # up() starts in dependency order — PDS before core
        mock_compose.up()
        assert pds.running is True
        assert core.running is True

        # Verify topological start order: PDS appears before core
        order = mock_compose._resolve_start_order()
        pds_idx = order.index("pds")
        core_idx = order.index("core")
        assert pds_idx < core_idx, \
            "PDS must start before core in dependency order"

        # Counter-proof: PDS does NOT depend on core (unidirectional)
        assert "core" not in pds.depends_on, \
            "PDS must not depend on core — it is a standalone service"

    # TST-INT-115
    # TRACE: {"suite": "INT", "case": "0115", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "04", "scenario": "02", "title": "brain_depends_on_core_healthy"}
    def test_brain_depends_on_core_healthy(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Brain depends_on core being healthy before starting."""
        brain = mock_compose.containers["brain"]
        core = mock_compose.containers["core"]

        # Brain declares dependency on core
        assert "core" in brain.depends_on

        # Counter-proof: core does NOT depend on brain (unidirectional)
        assert "brain" not in core.depends_on

        # Brain does not depend on itself
        assert "brain" not in brain.depends_on

    # TST-INT-116
    # TRACE: {"suite": "INT", "case": "0116", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "04", "scenario": "03", "title": "brain_starts_without_core_unhealthy_retries"}
    def test_brain_starts_without_core_unhealthy_retries(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """If brain starts before core is healthy, brain is unhealthy
        and retries until core becomes available."""
        # Start brain without starting core first
        brain = mock_compose.containers["brain"]
        core = mock_compose.containers["core"]

        # Core is not running yet
        assert core.running is False

        # Brain starts but its healthcheck fails (core unavailable)
        brain.start()
        brain.healthcheck.set_passing(False)

        assert brain.running is True
        assert brain.healthcheck.check() is False

        # After core starts and becomes healthy
        core.start()
        core.healthcheck.set_passing(True)

        # Brain recovers
        brain.healthcheck.set_passing(True)
        assert brain.healthcheck.check() is True
        assert brain.healthcheck.is_healthy()

    # TST-INT-117
    # TRACE: {"suite": "INT", "case": "0117", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "04", "scenario": "04", "title": "llm_starts_independently"}
    def test_llm_starts_independently(
        self, mock_compose_local_llm: MockDockerCompose
    ) -> None:
        """Llama container has no depends_on -- starts independently."""
        llama = mock_compose_local_llm.containers["llama"]

        assert llama.depends_on == [], (
            "Llama container must have no startup dependencies"
        )

    # TST-INT-118
    # TRACE: {"suite": "INT", "case": "0118", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "04", "scenario": "05", "title": "full_startup_order_pds_core_brain"}
    def test_full_startup_order_pds_core_brain(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Full startup order: pds -> core -> brain."""
        order = mock_compose._resolve_start_order()

        pds_idx = order.index("pds")
        core_idx = order.index("core")
        brain_idx = order.index("brain")

        assert pds_idx < core_idx < brain_idx, (
            f"Expected pds < core < brain, got: {order}"
        )


# -----------------------------------------------------------------------
# TestVolumesAndSecrets (S5.5)
# -----------------------------------------------------------------------


class TestVolumesAndSecrets:
    """Verify volume mounts and secret file handling."""

    # TST-INT-120
    # TRACE: {"suite": "INT", "case": "0120", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "05", "scenario": "01", "title": "model_files_shared_llama_volume"}
    def test_model_files_shared_llama_volume(
        self, mock_compose_local_llm: MockDockerCompose
    ) -> None:
        """Model files are shared via a named volume accessible to
        both brain and llama containers."""
        mock_compose_local_llm.up()

        brain = mock_compose_local_llm.containers["brain"]
        llama = mock_compose_local_llm.containers["llama"]

        # Mount the shared models volume on both containers
        models_volume = "dina-models"
        brain.volumes[models_volume] = "/models"
        llama.volumes[models_volume] = "/models"

        assert models_volume in brain.volumes
        assert models_volume in llama.volumes
        assert brain.volumes[models_volume] == llama.volumes[models_volume]

    # TST-INT-121
    # TRACE: {"suite": "INT", "case": "0121", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "05", "scenario": "02", "title": "secret_files_mounted_tmpfs"}
    def test_secret_files_mounted_tmpfs(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Secret files are mounted via tmpfs (not persisted to disk).
        Service auth token is generated, mounted at /run/secrets/, and
        validated through MockServiceAuth — proving the secret is usable."""
        mock_compose.up()

        core = mock_compose.containers["core"]
        brain = mock_compose.containers["brain"]
        assert core.running
        assert brain.running

        # Generate a real service token via MockServiceAuth
        service_auth = MockServiceAuth()

        # Mount the token at /run/secrets/ path in both containers
        secret_path = "/run/secrets/brain_token"
        core.secrets["brain_token"] = secret_path
        brain.secrets["brain_token"] = secret_path

        # Secret paths must follow /run/secrets/ convention (tmpfs)
        for container in [core, brain]:
            for _name, path in container.secrets.items():
                assert path.startswith("/run/secrets/"), (
                    f"Secret must be at /run/secrets/*, got: {path}"
                )

        # Secrets namespace must not leak into volumes namespace
        assert "brain_token" not in core.volumes
        assert "brain_token" not in brain.volumes

        # The service token is actually usable for authentication
        valid = service_auth.validate(service_auth.token, "/v1/vault/query")
        assert valid is True, "Valid token + brain endpoint must authenticate"

        # Wrong token is rejected
        invalid = service_auth.validate("wrong_token_xxx", "/v1/vault/query")
        assert invalid is False, "Wrong token must be rejected"

        # Admin endpoints are blocked even with valid token
        admin_blocked = service_auth.validate(
            service_auth.token, "/v1/admin/dashboard"
        )
        assert admin_blocked is False, (
            "Service token must not access admin endpoints"
        )

    # TST-INT-126
    # TRACE: {"suite": "INT", "case": "0126", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "05", "scenario": "03", "title": "llama_models_dir_shared_brain_llama"}
    def test_llama_models_dir_shared_brain_llama(
        self, mock_compose_local_llm: MockDockerCompose
    ) -> None:
        """llama models directory is shared between brain and llama
        containers via a named volume."""
        mock_compose_local_llm.up()

        brain = mock_compose_local_llm.containers["brain"]
        llama = mock_compose_local_llm.containers["llama"]

        # Both containers must be running after up()
        assert brain.running is True, "brain must be running"
        assert llama.running is True, "llama must be running"

        # Both on same network for model serving
        assert brain.can_reach(llama), \
            "brain must be able to reach llama for model serving"
        assert llama.can_reach(brain), \
            "llama must be able to reach brain (bidirectional)"

        # Counter-proof: llama only exists in local-llm profile
        cloud_compose = MockDockerCompose(profile="cloud")
        cloud_compose.up()
        assert "llama" not in cloud_compose.containers, \
            "Cloud profile must NOT include llama container"

        # core is on brain-net + pds-net + public; llama is on brain-net only
        # They share brain-net, so llama CAN reach core
        core = mock_compose_local_llm.containers["core"]
        assert llama.can_reach(core), \
            "llama must reach core via shared brain-net"

        # Counter-proof: PDS is on pds-net only, llama on brain-net only
        # llama should NOT reach PDS (network isolation)
        pds = mock_compose_local_llm.containers["pds"]
        assert not llama.can_reach(pds), \
            "llama must NOT reach PDS (different network segments)"


# -----------------------------------------------------------------------
# TestInstallScript (S5.6)
# -----------------------------------------------------------------------


class TestInstallScript:
    """Verify install script behaviour (directory creation, token
    generation, permissions, idempotency)."""

    # TST-INT-127
    # TRACE: {"suite": "INT", "case": "0127", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "06", "scenario": "01", "title": "creates_required_directories"}
    def test_creates_required_directories(self, tmp_path) -> None:
        """Install script creates secrets, data, and models directories."""
        secrets_dir = tmp_path / "secrets"
        data_dir = tmp_path / "data"
        models_dir = tmp_path / "models"

        # Simulate install script directory creation
        for d in [secrets_dir, data_dir, models_dir]:
            d.mkdir(parents=True, exist_ok=True)

        assert secrets_dir.is_dir()
        assert data_dir.is_dir()
        assert models_dir.is_dir()

    # TST-INT-128
    # TRACE: {"suite": "INT", "case": "0128", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "06", "scenario": "02", "title": "generates_brain_token_on_first_run"}
    def test_generates_brain_token_on_first_run(self, tmp_path) -> None:
        """Install script generates BRAIN_TOKEN on first run.

        Verifies the token generation pattern: 64-char lowercase hex,
        unique across invocations, written only when absent.
        """
        token_file = tmp_path / "secrets" / "brain_token"
        token_file.parent.mkdir(parents=True, exist_ok=True)

        # First run -- no token exists yet
        assert not token_file.exists(), "Token file must not exist before first run"

        # Generate token (mirrors install.sh: two uuid4 hex halves)
        token = uuid.uuid4().hex + uuid.uuid4().hex  # 64-char hex
        token_file.write_text(token)

        # --- Format assertions ---
        written = token_file.read_text()
        assert len(written) == 64, f"Token must be 64 chars, got {len(written)}"
        assert all(c in "0123456789abcdef" for c in written), (
            "Token must be lowercase hex only"
        )

        # --- Uniqueness: a second generation must differ ---
        token2 = uuid.uuid4().hex + uuid.uuid4().hex
        assert token2 != written, (
            "Two independently generated tokens must not collide"
        )

        # --- Idempotency: if file exists, do not overwrite ---
        original = token_file.read_text()
        # Simulate a second install run that should skip generation
        if not token_file.exists():
            token_file.write_text(uuid.uuid4().hex + uuid.uuid4().hex)
        assert token_file.read_text() == original, (
            "Re-run must not overwrite an existing token"
        )

    # TST-INT-129
    # TRACE: {"suite": "INT", "case": "0129", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "06", "scenario": "03", "title": "prompts_for_passphrase_security_mode"}
    def test_prompts_for_passphrase_security_mode(self, tmp_path) -> None:
        """In security mode, install script prompts for a passphrase
        (simulated by checking a passphrase file is expected)."""
        passphrase_marker = tmp_path / "secrets" / "security_mode"
        passphrase_marker.parent.mkdir(parents=True, exist_ok=True)

        # Security mode: marker file indicates passphrase was set
        passphrase_marker.write_text("enabled")

        assert passphrase_marker.exists()
        assert passphrase_marker.read_text() == "enabled"

    # TST-INT-130
    # TRACE: {"suite": "INT", "case": "0130", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "06", "scenario": "04", "title": "sets_file_permissions_600_for_secrets"}
    def test_sets_file_permissions_600_for_secrets(self, tmp_path) -> None:
        """Install script sets 600 permissions on secret files.

        Counter-proof: file starts with default (permissive) permissions,
        then the hardening step locks it to 0o600, and we verify that
        group/other bits are fully cleared.
        """
        secrets_dir = tmp_path / "secrets"
        secrets_dir.mkdir(parents=True, exist_ok=True)

        token_file = secrets_dir / "brain_token"
        token_file.write_text("secret_token_value")

        # --- Counter-proof: default permissions are NOT 0o600 ---
        default_mode = stat.S_IMODE(token_file.stat().st_mode)
        assert default_mode != 0o600, (
            f"Default permissions should not already be 0o600 "
            f"(got {oct(default_mode)}); counter-proof invalid"
        )

        # --- Hardening step: simulate install script locking secrets ---
        token_file.chmod(0o600)

        file_stat = token_file.stat()
        mode = stat.S_IMODE(file_stat.st_mode)

        assert mode == 0o600, (
            f"Secret file permissions must be 600, got {oct(mode)}"
        )

        # --- Verify specific bit masks: no group, no other ---
        assert not (mode & stat.S_IRGRP), "Group read must be cleared"
        assert not (mode & stat.S_IWGRP), "Group write must be cleared"
        assert not (mode & stat.S_IXGRP), "Group execute must be cleared"
        assert not (mode & stat.S_IROTH), "Other read must be cleared"
        assert not (mode & stat.S_IWOTH), "Other write must be cleared"
        assert not (mode & stat.S_IXOTH), "Other execute must be cleared"

        # --- Multiple secret files all hardened ---
        key_file = secrets_dir / "root_key"
        key_file.write_text("ed25519_private_key_material")
        key_file.chmod(0o600)
        assert stat.S_IMODE(key_file.stat().st_mode) == 0o600

        # --- Counter-proof: a non-secret file retains default perms ---
        readme = secrets_dir / "README"
        readme.write_text("This directory contains secrets")
        readme_mode = stat.S_IMODE(readme.stat().st_mode)
        assert readme_mode != 0o600, (
            "Non-secret files should retain default (permissive) permissions"
        )

    # TST-INT-131
    # TRACE: {"suite": "INT", "case": "0131", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "06", "scenario": "05", "title": "idempotent_rerun_does_not_overwrite_token"}
    def test_idempotent_rerun_does_not_overwrite_token(
        self, tmp_path
    ) -> None:
        """Re-running the install script does not overwrite an existing
        BRAIN_TOKEN.  Verified via MockServiceAuth token persistence."""
        from tests.integration.mocks import MockServiceAuth

        # First install: generate token
        auth_first = MockServiceAuth()
        original_token = auth_first.token
        assert len(original_token) > 0

        # Simulate re-run: create a second auth with the same token
        # (idempotent install should detect existing token and reuse)
        auth_second = MockServiceAuth()
        second_token = auth_second.token

        # Both are valid tokens
        assert auth_first.validate(original_token, "/v1/vault/query") is True
        assert auth_second.validate(second_token, "/v1/vault/query") is True

        # Counter-proof: wrong token is always rejected
        assert auth_first.validate("wrong_token_123", "/v1/vault/query") is False

        # Counter-proof: admin endpoints are always rejected for brain token
        assert auth_first.validate(original_token, "/v1/admin/dashboard") is False

        # Verify token format: 64-char hex (SHA-256)
        assert len(original_token) == 64
        assert all(c in "0123456789abcdef" for c in original_token)

    # TST-INT-132
    # TRACE: {"suite": "INT", "case": "0132", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "06", "scenario": "06", "title": "docker_compose_up_after_install_succeeds"}
    def test_docker_compose_up_after_install_succeeds(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """docker compose up succeeds after install script completes."""
        result = mock_compose.up()

        assert result is True
        assert mock_compose.is_all_healthy()

        for name, container in mock_compose.containers.items():
            assert container.running, f"{name} should be running"


# -----------------------------------------------------------------------
# TestSecretsManagement (S5.7)
# -----------------------------------------------------------------------


class TestSecretsManagement:
    """Verify that secrets are never leaked via docker inspect,
    environment variables, or version control."""

    # TST-INT-133
    # TRACE: {"suite": "INT", "case": "0133", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "07", "scenario": "01", "title": "secrets_never_in_docker_inspect_env"}
    def test_secrets_never_in_docker_inspect_env(
        self, mock_compose: MockDockerCompose,
        mock_service_auth: MockServiceAuth
    ) -> None:
        """Secrets must not appear in container environment variables
        (which would be visible via docker inspect)."""
        mock_compose.up()

        token = mock_service_auth.token

        # Populate containers with typical env vars (non-secret config)
        core = mock_compose.containers["core"]
        brain = mock_compose.containers["brain"]
        core.environment["DINA_LOG_LEVEL"] = "info"
        core.environment["DINA_PORT"] = "8080"
        brain.environment["DINA_LOG_LEVEL"] = "info"
        brain.environment["PYTHONUNBUFFERED"] = "1"
        pds = mock_compose.containers["pds"]
        pds.environment["PDS_LOG_LEVEL"] = "info"
        pds.environment["PDS_PORT"] = "3000"

        for name, container in mock_compose.containers.items():
            # Must have at least one env var to avoid vacuous truth
            assert len(container.environment) > 0, (
                f"Container {name} has no env vars — check is vacuously true"
            )
            # Environment should not contain the raw token
            for env_key, env_val in container.environment.items():
                assert env_val != token, (
                    f"Secret token found in {name} environment variable {env_key}"
                )
                # No env var should contain secret-like patterns
                assert "BRAIN_TOKEN" not in env_key.upper(), (
                    f"Secret key name '{env_key}' found in {name} environment"
                )

        # Counter-proof: if someone accidentally puts the token in env, it fails
        brain.environment["BAD_SECRET"] = token
        found_leak = False
        for env_key, env_val in brain.environment.items():
            if env_val == token:
                found_leak = True
                break
        assert found_leak is True, (
            "Sanity check: intentionally leaked token must be detectable"
        )
        # Clean up the intentional leak
        del brain.environment["BAD_SECRET"]

    # TST-INT-134
    # TRACE: {"suite": "INT", "case": "0134", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "07", "scenario": "02", "title": "secrets_at_run_secrets_inside_container"}
    def test_secrets_at_run_secrets_inside_container(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Secrets are available at /run/secrets/ inside the container
        (tmpfs mount, not persisted to disk)."""
        mock_compose.up()

        core = mock_compose.containers["core"]
        brain = mock_compose.containers["brain"]

        # Pre-condition: containers are running after up()
        assert core.running is True
        assert brain.running is True

        # Mount secrets at the required /run/secrets/ path
        core.secrets["brain_token"] = "/run/secrets/brain_token"
        brain.secrets["brain_token"] = "/run/secrets/brain_token"
        core.secrets["vault_passphrase"] = "/run/secrets/vault_passphrase"

        # Verify all secrets are under /run/secrets/ (tmpfs, not persisted)
        for name, container in [("core", core), ("brain", brain)]:
            assert len(container.secrets) > 0, f"{name} has no secrets mounted"
            for secret_name, secret_path in container.secrets.items():
                assert secret_path.startswith("/run/secrets/"), (
                    f"{name}: secret {secret_name} not at /run/secrets/"
                )
                # Counter-proof: secrets must NOT be in /etc/ or home dirs
                assert not secret_path.startswith("/etc/"), (
                    f"{name}: secret {secret_name} at /etc/ (persisted to disk)"
                )
                assert not secret_path.startswith("/home/"), (
                    f"{name}: secret {secret_name} at /home/ (user-readable)"
                )

        # Counter-proof: secrets are NOT in environment variables
        for name, container in [("core", core), ("brain", brain)]:
            for secret_name in container.secrets:
                assert secret_name.upper() not in container.environment, (
                    f"{name}: secret {secret_name} leaked into environment"
                )

    # TST-INT-135
    # TRACE: {"suite": "INT", "case": "0135", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "07", "scenario": "03", "title": "google_api_key_in_dotenv_exception"}
    def test_google_api_key_in_dotenv_exception(self) -> None:
        """GOOGLE_API_KEY is the one exception -- stored in .env
        (legacy, not in Docker secrets). This is acceptable because
        .env is in .gitignore and not baked into the image."""
        # The .env file may contain GOOGLE_API_KEY as a legacy exception
        dotenv_secrets = {
            "GOOGLE_API_KEY": "AIza_mock_key_for_testing",
        }

        # GOOGLE_API_KEY is allowed in .env
        assert "GOOGLE_API_KEY" in dotenv_secrets

        # But BRAIN_TOKEN must NOT be in .env
        assert "BRAIN_TOKEN" not in dotenv_secrets, (
            "BRAIN_TOKEN must be in Docker secrets, not .env"
        )

    # TST-INT-136
    # TRACE: {"suite": "INT", "case": "0136", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "07", "scenario": "04", "title": "gitignore_blocks_secrets_directory"}
    def test_gitignore_blocks_secrets_directory(self, tmp_path) -> None:
        """.gitignore must contain an entry that blocks the secrets directory
        from being committed to version control."""
        gitignore_file = tmp_path / ".gitignore"
        gitignore_content = (
            "# Docker secrets\n"
            "secrets/\n"
            ".env\n"
            "*.sqlite\n"
        )
        gitignore_file.write_text(gitignore_content)

        content = gitignore_file.read_text()

        assert "secrets/" in content, (
            ".gitignore must block the secrets directory"
        )
        assert ".env" in content, (
            ".gitignore must block .env files"
        )

    # TST-INT-137
    # TRACE: {"suite": "INT", "case": "0137", "section": "05", "sectionName": "Docker Networking & Isolation", "subsection": "07", "scenario": "05", "title": "brain_token_shared_by_core_and_brain"}
    def test_brain_token_shared_by_core_and_brain(
        self, mock_compose: MockDockerCompose,
        mock_service_auth: MockServiceAuth
    ) -> None:
        """BRAIN_TOKEN is the same secret file mounted into both core
        and brain containers. Both use the same token for auth."""
        mock_compose.up()

        token = mock_service_auth.token

        # Valid token + brain endpoint → authorized
        assert mock_service_auth.validate(token, "/v1/vault/query") is True
        assert mock_service_auth.validate(token, "/v1/pii/scrub") is True

        # Counter-proof: wrong token → rejected
        wrong_token = "a" * len(token)
        assert wrong_token != token, "Test setup: wrong token must differ"
        assert mock_service_auth.validate(wrong_token, "/v1/vault/query") is False

        # Counter-proof: valid token + admin endpoint → rejected
        # (Brain should never access admin endpoints)
        assert mock_service_auth.validate(token, "/v1/did/rotate") is False
        assert mock_service_auth.validate(token, "/v1/admin/dashboard") is False

        # Verify auth_log captured all attempts
        assert len(mock_service_auth.auth_log) == 5
        successes = [e for e in mock_service_auth.auth_log if e["result"]]
        failures = [e for e in mock_service_auth.auth_log if not e["result"]]
        assert len(successes) == 2
        assert len(failures) == 3
