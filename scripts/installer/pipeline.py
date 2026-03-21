"""Install pipeline — phases: collect → provision → write_config.

Each phase is a pure function that takes config and returns results.
No Docker, no prompts, no display. Those live in install.sh (the presenter).

Phases:
  1. COLLECT   — validate config, check idempotency
  2. PROVISION — seed generation/restore, wrapping, service key derivation
  3. WRITE     — .env, permissions, gitignore

The remaining phases (launch, verify) are handled by install.sh since they
involve Docker Compose operations that run outside the installer container.
"""

from __future__ import annotations

from pathlib import Path

from scripts.installer.crypto import (
    provision_service_keys,
    wrap_seed,
    write_seed_password,
)
from scripts.installer.env_writer import backfill_env, write_env
from scripts.installer.identity import resolve_identity
from scripts.installer.models import (
    InstallerConfig,
    InstallerResult,
    StartupMode,
    StepResult,
)
from scripts.installer.permissions import ensure_gitignore, lock_permissions
from scripts.installer.ports import allocate_ports
from scripts.installer.secrets import (
    ensure_secrets_dir,
    ensure_session_id,
    generate_pds_secrets,
    is_already_wrapped,
)


def run_install(config: InstallerConfig) -> InstallerResult:
    """Execute the install pipeline (phases 1-3).

    Phase 1: COLLECT — validate, check idempotency
    Phase 2: PROVISION — seed, wrap, keys
    Phase 3: WRITE — .env, permissions

    Returns InstallerResult with full audit trail.
    Recovery phrase is returned in memory only — never persisted to disk.
    """
    steps: list[StepResult] = []

    # --- Phase 1: COLLECT ---

    # Ensure output directories exist
    secrets_dir = ensure_secrets_dir(config.dina_dir)
    service_key_dir = secrets_dir / "service_keys"
    steps.append(StepResult(name="ensure_secrets_dir", success=True))

    # Session ID
    session_id = ensure_session_id(secrets_dir)
    steps.append(StepResult(
        name="ensure_session_id", success=True,
        message=f"session={session_id}",
    ))

    # Port allocation — use explicit ports if provided (install.sh allocates
    # on the host), otherwise auto-allocate (only safe when running on host).
    env_file = config.dina_dir / ".env"
    if config.core_port and config.pds_port:
        core_port, pds_port = config.core_port, config.pds_port
    else:
        core_port, pds_port = allocate_ports(
            env_file=env_file if env_file.exists() else None,
        )
    steps.append(StepResult(
        name="allocate_ports", success=True,
        message=f"core={core_port}, pds={pds_port}",
    ))

    # PDS secrets
    pds_secrets = generate_pds_secrets(
        env_file=env_file if env_file.exists() else None,
    )
    steps.append(StepResult(name="generate_pds_secrets", success=True))

    # --- Phase 2: PROVISION ---

    recovery_phrase: list[str] | None = None
    seed_wrapped = False

    if is_already_wrapped(secrets_dir):
        # Idempotent: seed already wrapped, skip provisioning
        seed_wrapped = True
        steps.append(StepResult(
            name="identity", success=True,
            message="already wrapped", skipped=True,
        ))
        # Service keys: check if they already exist
        core_key = service_key_dir / "core" / "core_ed25519_private.pem"
        keys_exist = core_key.is_file()
        steps.append(StepResult(
            name="service_keys", success=True,
            message="already provisioned" if keys_exist else "missing",
            skipped=keys_exist,
        ))
    else:
        # Resolve identity (generate or restore seed)
        seed, recovery_phrase = resolve_identity(config)
        steps.append(StepResult(
            name="resolve_identity", success=True,
            message=config.identity_choice.value,
        ))

        # Wrap seed with passphrase (Argon2id + AES-256-GCM)
        wrap_seed(seed, config.passphrase, secrets_dir)
        seed_wrapped = True
        steps.append(StepResult(name="wrap_seed", success=True))

        # Write seed password for initial startup
        write_seed_password(secrets_dir, config.passphrase)
        steps.append(StepResult(
            name="write_seed_password", success=True,
            message=config.startup_mode.value,
        ))

        # Provision deterministic service keys (SLIP-0010)
        provision_service_keys(seed, service_key_dir)
        steps.append(StepResult(name="provision_service_keys", success=True))

        # Zero seed from memory (best effort in Python)
        # In production, install.sh also unsets the variable.
        seed = b"\x00" * 32  # noqa: F841

    # --- Phase 3: WRITE ---
    # .env writing is controlled by config.write_env.
    # install.sh sets write_env=False because it writes .env itself after
    # collecting LLM/Telegram prompts interactively. Tests use the default
    # (True) to get a complete install without bash.

    if config.write_env:
        if not env_file.exists():
            write_env(config, session_id, core_port, pds_port, pds_secrets)
            steps.append(StepResult(name="write_env", success=True))
        else:
            backfill_env(env_file, session_id, core_port, pds_port, pds_secrets)
            steps.append(StepResult(
                name="backfill_env", success=True, message="existing .env updated",
            ))
    else:
        steps.append(StepResult(
            name="write_env", success=True, skipped=True,
            message="deferred to shell wrapper",
        ))

    # Lock permissions
    lock_permissions(secrets_dir)
    ensure_gitignore(config.dina_dir)
    steps.append(StepResult(name="lock_permissions", success=True))

    # NOTE: For MAXIMUM mode, the passphrase is NOT cleared here.
    # install.sh clears it after Docker health check (the Core process
    # needs the passphrase to decrypt the wrapped seed on first boot).
    # Tests that verify maximum-mode passphrase behavior should call
    # clear_passphrase_if_maximum() explicitly after asserting the
    # passphrase was written.

    # Verify key files exist
    service_keys_ok = all(
        (service_key_dir / f).is_file()
        for f in [
            "core/core_ed25519_private.pem",
            "brain/brain_ed25519_private.pem",
            "public/core_ed25519_public.pem",
            "public/brain_ed25519_public.pem",
        ]
    )

    return InstallerResult(
        secrets_dir=secrets_dir,
        env_file=env_file,
        session_id=session_id,
        core_port=core_port,
        pds_port=pds_port,
        startup_mode=config.startup_mode,
        seed_wrapped=seed_wrapped,
        service_keys_provisioned=service_keys_ok,
        recovery_phrase=recovery_phrase,
        steps=steps,
    )
