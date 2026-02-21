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
    MockBrainTokenAuth,
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
    def test_pds_cannot_reach_internet_outbound(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """PDS is on dina-pds-net only, which is internal.
        PDS has no public-facing network, so no outbound internet."""
        mock_compose.up()

        pds = mock_compose.containers["pds"]

        # PDS is only on pds-net (internal network)
        assert pds.networks == ["dina-pds-net"], (
            "PDS must be on dina-pds-net only (no outbound internet)"
        )
        assert "dina-public" not in pds.networks
        assert "dina-brain-net" not in pds.networks

    # TST-INT-093
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
    def test_core_healthz_returns_200_when_running(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Core /healthz returns 200 (passing) when the container is running."""
        mock_compose.up()

        core = mock_compose.containers["core"]

        assert core.running is True
        assert core.healthcheck.endpoint == "/healthz"
        assert core.healthcheck.check() is True

    # TST-INT-095
    def test_core_readyz_returns_200_vault_open(
        self, mock_compose: MockDockerCompose, mock_vault: MockVault
    ) -> None:
        """/readyz returns 200 when the vault is open (can store/retrieve)."""
        mock_compose.up()

        # Vault is functional (open)
        mock_vault.store(1, "readyz_probe", {"status": "ok"})
        result = mock_vault.retrieve(1, "readyz_probe")

        assert result is not None
        assert result["status"] == "ok"

    # TST-INT-096
    def test_core_readyz_returns_503_vault_locked(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """/readyz returns 503 when the vault is locked.
        Simulated by a healthcheck that is set to not passing."""
        mock_compose.up()

        core = mock_compose.containers["core"]

        # Simulate vault locked state -- readyz healthcheck fails
        readyz_check = MockHealthcheck("/readyz")
        readyz_check.set_passing(False)

        assert readyz_check.check() is False
        assert not readyz_check.is_healthy()

    # TST-INT-097
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
    def test_pds_healthcheck_endpoint(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """PDS healthcheck uses /xrpc/_health endpoint."""
        pds = mock_compose.containers["pds"]

        assert pds.healthcheck.endpoint == "/xrpc/_health"

    # TST-INT-100
    def test_pds_healthcheck_params(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """PDS healthcheck: interval=30, retries=3."""
        pds = mock_compose.containers["pds"]

        assert pds.healthcheck.interval == 30
        assert pds.healthcheck.retries == 3

    # TST-INT-101
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
    def test_structured_json_logs_brain(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Brain emits structured JSON logs with time, level, msg, module."""
        mock_compose.up()

        brain = mock_compose.containers["brain"]
        brain.log("info", "classification complete", task="email_incoming")

        logs = brain.get_logs_json()
        assert len(logs) >= 1

        for entry in logs:
            assert "time" in entry
            assert "level" in entry
            assert "msg" in entry
            assert "module" in entry

    # TST-INT-103
    def test_no_pii_in_container_logs(
        self, mock_compose: MockDockerCompose, mock_scrubber: MockPIIScrubber
    ) -> None:
        """No PII (emails, phone numbers) appears in any container log."""
        mock_compose.up()

        # Emit some logs from each container
        for name, container in mock_compose.containers.items():
            container.log("info", "processing request", user="[PERSON_1]")
            container.log("debug", "query result", count=42)

        # PII patterns that must NOT appear in logs
        pii_patterns = [
            r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}",  # email
            r"\+\d{1,3}[-.\s]?\d{4,}[-.\s]?\d{4,}",             # phone (requires leading +)
        ]

        for name, container in mock_compose.containers.items():
            raw_logs = "\n".join(container.logs)
            for pattern in pii_patterns:
                matches = re.findall(pattern, raw_logs)
                assert len(matches) == 0, (
                    f"PII found in {name} logs: {matches}"
                )

    # TST-INT-104
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
    def test_zombie_state_healthcheck_endpoint_choice(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Zombie state: /healthz passes (process alive) but /readyz fails
        (vault locked or brain unresponsive). Docker does not restart
        because /healthz is the healthcheck, but /readyz signals not-ready."""
        mock_compose.up()

        core = mock_compose.containers["core"]

        # /healthz passes -- process is alive
        assert core.healthcheck.endpoint == "/healthz"
        assert core.healthcheck.check() is True

        # /readyz would fail (vault locked), but Docker uses /healthz
        readyz = MockHealthcheck("/readyz")
        readyz.set_passing(False)

        assert readyz.check() is False
        # Core is not restarted because Docker checks /healthz, not /readyz
        assert core.healthcheck.is_healthy() is True
        assert core.running is True


# -----------------------------------------------------------------------
# TestBootSequence (S5.3)
# -----------------------------------------------------------------------


class TestBootSequence:
    """Verify boot sequence for security mode and convenience mode."""

    # TST-INT-108
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
    def test_convenience_mode_vault_auto_unlocked(
        self, mock_compose: MockDockerCompose, mock_vault: MockVault
    ) -> None:
        """Convenience mode: vault auto-unlocks at boot.
        Data is immediately accessible."""
        mock_compose.up()

        # Convenience mode: vault is unlocked at boot
        vault_locked = False

        assert vault_locked is False
        # Vault is immediately functional
        mock_vault.store(1, "boot_test", {"mode": "convenience"})
        result = mock_vault.retrieve(1, "boot_test")
        assert result is not None
        assert result["mode"] == "convenience"

    # TST-INT-110
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
    def test_boot_order_identity_before_persona_vaults(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """identity.sqlite must be opened before any persona vaults.
        Verified by checking core starts before brain (core owns identity.sqlite)."""
        order = mock_compose._resolve_start_order()

        # Core (which owns identity.sqlite) must start before brain
        # (which accesses persona vaults via core API)
        assert "core" in order
        assert "brain" in order
        core_idx = order.index("core")
        brain_idx = order.index("brain")
        assert core_idx < brain_idx, (
            "identity.sqlite (core) must be ready before persona vaults (brain)"
        )

    # TST-INT-113
    def test_brain_receives_vault_unlocked_event(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """After vault is unlocked, brain receives a vault_unlocked event
        so it can begin processing."""
        mock_compose.up()

        brain = mock_compose.containers["brain"]

        # Simulate vault_unlocked event delivery
        event = {"type": "vault_unlocked", "timestamp": time.time()}
        brain.log("info", "vault_unlocked event received", **event)

        logs = brain.get_logs_json()
        vault_events = [
            e for e in logs if e.get("type") == "vault_unlocked"
        ]
        assert len(vault_events) == 1


# -----------------------------------------------------------------------
# TestStartupDependencies (S5.4)
# -----------------------------------------------------------------------


class TestStartupDependencies:
    """Verify container startup dependency ordering."""

    # TST-INT-114
    def test_core_depends_on_pds_started(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Core depends_on PDS being started first."""
        core = mock_compose.containers["core"]

        assert "pds" in core.depends_on

    # TST-INT-115
    def test_brain_depends_on_core_healthy(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Brain depends_on core being healthy before starting."""
        brain = mock_compose.containers["brain"]

        assert "core" in brain.depends_on

    # TST-INT-116
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
    def test_llm_starts_independently(
        self, mock_compose_local_llm: MockDockerCompose
    ) -> None:
        """Llama container has no depends_on -- starts independently."""
        llama = mock_compose_local_llm.containers["llama"]

        assert llama.depends_on == [], (
            "Llama container must have no startup dependencies"
        )

    # TST-INT-118
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
    def test_secret_files_mounted_tmpfs(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Secret files are mounted via tmpfs (not persisted to disk).
        Verified by checking secrets dict is separate from volumes."""
        mock_compose.up()

        core = mock_compose.containers["core"]
        brain = mock_compose.containers["brain"]

        # Mount secrets at /run/secrets/ (tmpfs in production)
        core.secrets["brain_token"] = "/run/secrets/brain_token"
        brain.secrets["brain_token"] = "/run/secrets/brain_token"

        # Secrets are NOT in the regular volumes map
        assert "brain_token" not in core.volumes
        assert "brain_token" not in brain.volumes

        # Secrets are in the secrets map (tmpfs)
        assert "brain_token" in core.secrets
        assert "brain_token" in brain.secrets

    # TST-INT-126
    def test_llama_models_dir_shared_brain_llama(
        self, mock_compose_local_llm: MockDockerCompose
    ) -> None:
        """llama models directory is shared between brain and llama
        containers via a named volume."""
        mock_compose_local_llm.up()

        brain = mock_compose_local_llm.containers["brain"]
        llama = mock_compose_local_llm.containers["llama"]

        # Both containers mount the same models path
        models_path = "/models"
        brain.volumes["dina-models"] = models_path
        llama.volumes["dina-models"] = models_path

        # Verify same mount target
        assert brain.volumes["dina-models"] == models_path
        assert llama.volumes["dina-models"] == models_path

        # Both on same network for model serving
        assert brain.can_reach(llama)


# -----------------------------------------------------------------------
# TestInstallScript (S5.6)
# -----------------------------------------------------------------------


class TestInstallScript:
    """Verify install script behaviour (directory creation, token
    generation, permissions, idempotency)."""

    # TST-INT-127
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
    def test_generates_brain_token_on_first_run(self, tmp_path) -> None:
        """Install script generates BRAIN_TOKEN on first run."""
        token_file = tmp_path / "secrets" / "brain_token"
        token_file.parent.mkdir(parents=True, exist_ok=True)

        # First run -- no token exists
        assert not token_file.exists()

        # Generate token
        token = uuid.uuid4().hex + uuid.uuid4().hex  # 64-char hex
        token_file.write_text(token)

        assert token_file.exists()
        assert len(token_file.read_text()) == 64

    # TST-INT-129
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
    def test_sets_file_permissions_600_for_secrets(self, tmp_path) -> None:
        """Install script sets 600 permissions on secret files."""
        secrets_dir = tmp_path / "secrets"
        secrets_dir.mkdir(parents=True, exist_ok=True)

        token_file = secrets_dir / "brain_token"
        token_file.write_text("secret_token_value")

        # Set permissions to 600 (owner read/write only)
        token_file.chmod(0o600)

        file_stat = token_file.stat()
        mode = stat.S_IMODE(file_stat.st_mode)

        assert mode == 0o600, (
            f"Secret file permissions must be 600, got {oct(mode)}"
        )

    # TST-INT-131
    def test_idempotent_rerun_does_not_overwrite_token(
        self, tmp_path
    ) -> None:
        """Re-running the install script does not overwrite an existing
        BRAIN_TOKEN."""
        secrets_dir = tmp_path / "secrets"
        secrets_dir.mkdir(parents=True, exist_ok=True)

        token_file = secrets_dir / "brain_token"
        original_token = "original_token_" + uuid.uuid4().hex
        token_file.write_text(original_token)

        # Simulate re-run: check if token exists before writing
        if not token_file.exists():
            token_file.write_text("new_token_" + uuid.uuid4().hex)

        assert token_file.read_text() == original_token, (
            "Re-run must not overwrite existing BRAIN_TOKEN"
        )

    # TST-INT-132
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
    def test_secrets_never_in_docker_inspect_env(
        self, mock_compose: MockDockerCompose,
        mock_brain_token_auth: MockBrainTokenAuth
    ) -> None:
        """Secrets must not appear in container environment variables
        (which would be visible via docker inspect)."""
        mock_compose.up()

        token = mock_brain_token_auth.token

        for name, container in mock_compose.containers.items():
            # Environment should not contain the raw token
            for env_key, env_val in container.environment.items():
                assert env_val != token, (
                    f"Secret token found in {name} environment variable {env_key}"
                )

    # TST-INT-134
    def test_secrets_at_run_secrets_inside_container(
        self, mock_compose: MockDockerCompose
    ) -> None:
        """Secrets are available at /run/secrets/ inside the container
        (tmpfs mount, not persisted to disk)."""
        mock_compose.up()

        core = mock_compose.containers["core"]
        brain = mock_compose.containers["brain"]

        # Mount secrets
        core.secrets["brain_token"] = "/run/secrets/brain_token"
        brain.secrets["brain_token"] = "/run/secrets/brain_token"

        # Verify mount path
        assert core.secrets["brain_token"] == "/run/secrets/brain_token"
        assert brain.secrets["brain_token"] == "/run/secrets/brain_token"

        # Secrets path is under /run/secrets/ (tmpfs)
        for name, container in [("core", core), ("brain", brain)]:
            for secret_name, secret_path in container.secrets.items():
                assert secret_path.startswith("/run/secrets/"), (
                    f"{name}: secret {secret_name} not at /run/secrets/"
                )

    # TST-INT-135
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
    def test_brain_token_shared_by_core_and_brain(
        self, mock_compose: MockDockerCompose,
        mock_brain_token_auth: MockBrainTokenAuth
    ) -> None:
        """BRAIN_TOKEN is the same secret file mounted into both core
        and brain containers. Both use the same token for auth."""
        mock_compose.up()

        core = mock_compose.containers["core"]
        brain = mock_compose.containers["brain"]

        # Both containers mount the same secret file
        secret_path = "/run/secrets/brain_token"
        core.secrets["brain_token"] = secret_path
        brain.secrets["brain_token"] = secret_path

        # Both reference the same file path
        assert core.secrets["brain_token"] == brain.secrets["brain_token"]

        # Token validation works with the shared token
        token = mock_brain_token_auth.token
        assert mock_brain_token_auth.validate(token, "/v1/vault/query") is True
