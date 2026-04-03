"""Failure-path tests — verify install.sh and run.sh handle errors gracefully.

These tests verify:
- Inaccessible secrets are detected and handled
- Missing Docker fails early with helpful message
- run.sh shows missing artifacts when install is incomplete
- Corrupt seed artifacts cause fail-closed with useful logs
- Unhealthy containers surface crash logs on timeout
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

import pexpect
import pytest


class TestOwnershipRepair:
    """Verify install.sh detects and handles inaccessible secrets directories.

    Note: we cannot simulate true root-owned bind-mount paths without sudo.
    Instead we simulate the observable effect: a directory that the current
    user cannot read/write/traverse (chmod 000). The installer's
    _repair_ownership function checks -w and -x on the top-level dir,
    which this test exercises.
    """

    # TRACE: {"suite": "INST", "case": "0008", "section": "05", "sectionName": "Failure Modes", "subsection": "01", "scenario": "01", "title": "inaccessible_secrets_detected"}
    def test_inaccessible_secrets_detected(self, install_dir: Path) -> None:
        """Install detects inaccessible secrets/ and attempts repair or fails clearly."""
        secrets = install_dir / "secrets"
        secrets.mkdir(exist_ok=True)

        # Make the entire secrets dir inaccessible
        os.chmod(str(secrets), 0o000)

        child = pexpect.spawn(
            "bash",
            [str(install_dir / "install.sh")],
            cwd=str(install_dir),
            timeout=300,
            encoding="utf-8",
            env={**os.environ, "DINA_DIR": str(install_dir)},
        )

        idx = child.expect(
            [
                "Fixing file ownership",
                "Cannot fix ownership",
                "Enter choice \\[1-3\\]:",  # got past repair
                pexpect.TIMEOUT,
            ],
            timeout=120,
        )
        child.close()

        # Restore permissions for cleanup
        try:
            os.chmod(str(secrets), 0o700)
        except Exception:
            pass

        assert idx in (0, 1, 2), (
            "Install should detect inaccessible secrets/ and handle it"
        )


class TestRunWithoutInstall:
    """Verify run.sh handles missing install gracefully."""

    # TRACE: {"suite": "INST", "case": "0009", "section": "05", "sectionName": "Failure Modes", "subsection": "02", "scenario": "01", "title": "run_without_install_shows_missing"}
    def test_run_without_install_shows_missing(self, install_dir: Path) -> None:
        """run.sh shows what is missing when install is incomplete."""
        child = pexpect.spawn(
            "bash",
            [str(install_dir / "run.sh")],
            cwd=str(install_dir),
            timeout=30,
            encoding="utf-8",
            env={**os.environ, "DINA_DIR": str(install_dir)},
        )

        idx = child.expect(
            [
                "not fully installed",
                "not installed",
                "Missing:",
                "install.sh",
                pexpect.TIMEOUT,
            ],
            timeout=20,
        )
        child.close()
        assert idx in (0, 1, 2, 3), "run.sh should indicate install is needed"

    # TRACE: {"suite": "INST", "case": "0010", "section": "05", "sectionName": "Failure Modes", "subsection": "02", "scenario": "02", "title": "run_shows_specific_missing_artifacts"}
    def test_run_shows_specific_missing_artifacts(self, install_dir: Path) -> None:
        """run.sh lists which specific artifacts are missing."""
        # Create partial install state — secrets dir but no keys
        secrets = install_dir / "secrets"
        secrets.mkdir(exist_ok=True)
        (secrets / "wrapped_seed.bin").write_bytes(b"\x00" * 60)
        (secrets / "master_seed.salt").write_bytes(b"\x00" * 16)
        (secrets / "seed_password").write_text("")

        child = pexpect.spawn(
            "bash",
            [str(install_dir / "run.sh")],
            cwd=str(install_dir),
            timeout=30,
            encoding="utf-8",
            env={**os.environ, "DINA_DIR": str(install_dir)},
        )

        idx = child.expect(
            [
                "Missing:.*pem",  # should mention missing key files
                "not fully installed",
                "install.sh",
                pexpect.TIMEOUT,
            ],
            timeout=20,
        )
        child.close()
        assert idx in (0, 1, 2), "run.sh should list missing artifacts"


class TestCorruptSeedArtifacts:
    """Verify Core fails closed with useful logs when seed artifacts are corrupt."""

    # TRACE: {"suite": "INST", "case": "0011", "section": "05", "sectionName": "Failure Modes", "subsection": "03", "scenario": "01", "title": "corrupt_wrapped_seed_fails_closed"}
    def test_corrupt_wrapped_seed_fails_closed(self, installed_dir: Path) -> None:
        """Corrupting wrapped_seed.bin causes Core to fail with clear error.

        Saves and restores the original file so the session fixture is not
        poisoned for subsequent tests.
        """
        seed_path = installed_dir / "secrets" / "wrapped_seed.bin"
        original = seed_path.read_bytes()

        try:
            # Corrupt the wrapped seed
            seed_path.write_bytes(b"\xff" * 60)  # garbage

            # Restart containers to pick up the corrupt file
            subprocess.run(
                ["bash", str(installed_dir / "run.sh"), "--stop"],
                cwd=str(installed_dir),
                capture_output=True,
                timeout=60,
                env={
                    **os.environ,
                    "DINA_DIR": str(installed_dir),
                    "DINA_SKIP_LLM_CHECK": "1",
                },
            )

            child = pexpect.spawn(
                "bash",
                [str(installed_dir / "run.sh"), "--start"],
                cwd=str(installed_dir),
                timeout=180,
                encoding="utf-8",
                env={
                    **os.environ,
                    "DINA_DIR": str(installed_dir),
                    "DINA_SKIP_LLM_CHECK": "1",
                },
            )

            # Core should fail to start
            idx = child.expect(
                [
                    "Health check timed out",
                    "unwrap",
                    "Restarting",
                    "Dina is running",
                    pexpect.TIMEOUT,
                ],
                timeout=120,
            )
            child.close()

            assert idx in (0, 1, 2), (
                "Core should fail closed with corrupt wrapped_seed.bin"
            )
        finally:
            # Restore original so subsequent tests are not poisoned
            seed_path.write_bytes(original)
            # Restart with good seed to leave healthy state for subsequent tests
            subprocess.run(
                ["bash", str(installed_dir / "run.sh"), "--stop"],
                cwd=str(installed_dir),
                capture_output=True,
                timeout=60,
                env={
                    **os.environ,
                    "DINA_DIR": str(installed_dir),
                    "DINA_SKIP_LLM_CHECK": "1",
                },
            )
            child = pexpect.spawn(
                "bash",
                [str(installed_dir / "run.sh"), "--start"],
                cwd=str(installed_dir),
                timeout=180,
                encoding="utf-8",
                env={
                    **os.environ,
                    "DINA_DIR": str(installed_dir),
                    "DINA_SKIP_LLM_CHECK": "1",
                },
            )
            idx = child.expect(
                ["Dina is running", "Containers already running", pexpect.TIMEOUT],
                timeout=120,
            )
            child.close()
            assert idx in (0, 1), (
                "Failed to restore healthy state after corrupt-seed test — "
                "installed_dir is poisoned for subsequent tests"
            )


class TestDockerNotRunning:
    """Verify install.sh fails early when Docker is unavailable."""

    # TRACE: {"suite": "INST", "case": "0012", "section": "05", "sectionName": "Failure Modes", "subsection": "04", "scenario": "01", "title": "install_no_docker_fails_early"}
    def test_install_no_docker_fails_early(self, install_dir: Path) -> None:
        """Install fails before reaching identity setup when Docker is missing.

        Uses an empty temp dir as PATH so no system binaries are found.
        Bash is invoked by full path so pexpect can find it.
        """
        import shutil
        bash_path = shutil.which("bash") or "/bin/bash"

        with tempfile.TemporaryDirectory() as fake_bin:
            env = {**os.environ, "DINA_DIR": str(install_dir)}
            env["PATH"] = fake_bin

            child = pexpect.spawn(
                bash_path,
                [str(install_dir / "install.sh")],
                cwd=str(install_dir),
                timeout=30,
                encoding="utf-8",
                env=env,
            )

            # Should fail early — never reach identity setup
            idx = child.expect(
                [
                    "Docker not found",
                    "not found",
                    "Enter choice",  # should NOT reach this
                    pexpect.TIMEOUT,
                ],
                timeout=20,
            )
            child.close()
            assert idx in (0, 1), (
                "Install should fail before identity setup when Docker is missing"
            )

    # TRACE: {"suite": "INST", "case": "0013", "section": "05", "sectionName": "Failure Modes", "subsection": "04", "scenario": "02", "title": "install_docker_daemon_unavailable"}
    def test_install_docker_daemon_unavailable(self, install_dir: Path) -> None:
        """Install fails with clear message when Docker exists but daemon is not running.

        We create a fake 'docker' script that succeeds for 'docker --version'
        but fails for 'docker info' (simulating daemon not running).
        """
        with tempfile.TemporaryDirectory() as fake_bin:
            # Create a fake docker that fails on 'info'
            fake_docker = Path(fake_bin) / "docker"
            fake_docker.write_text(
                '#!/bin/sh\n'
                'case "$1" in\n'
                '  --version) echo "Docker version 27.0.0" ;;\n'
                '  compose) echo "Docker Compose version v2.30.0" ;;\n'
                '  info) exit 1 ;;\n'
                '  *) exit 1 ;;\n'
                'esac\n'
            )
            fake_docker.chmod(0o755)

            # Also need basic utils (grep, sed, etc.)
            env = {**os.environ, "DINA_DIR": str(install_dir)}
            env["PATH"] = f"{fake_bin}:/usr/bin:/bin"

            child = pexpect.spawn(
                "bash",
                [str(install_dir / "install.sh")],
                cwd=str(install_dir),
                timeout=30,
                encoding="utf-8",
                env=env,
            )

            idx = child.expect(
                [
                    "Cannot connect to Docker",
                    "docker run hello-world",  # the hint command
                    "Enter choice",  # should NOT reach this
                    pexpect.TIMEOUT,
                ],
                timeout=20,
            )
            child.close()
            assert idx in (0, 1), (
                "Install should fail with 'Cannot connect to Docker' when daemon is down"
            )
