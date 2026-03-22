"""Wizard state machine — drives the install flow over a JSON-lines protocol.

The wizard runs as a single long-lived process inside a Docker container.
install.sh reads structured messages from stdout, renders prompts, collects
user input, and writes answers to stdin. The seed never leaves this process.

Protocol (JSON lines over stdin/stdout):

  Wizard → Bash:
    {"type":"prompt", "field":"identity_choice", "kind":"choice", "message":"...", "choices":[...], ...}
    {"type":"event", "name":"show_recovery_phrase", "words":["abandon","art",...]}
    {"type":"event", "name":"info", "message":"..."}
    {"type":"error", "field":"passphrase", "message":"Passphrase must be at least 8 characters"}
    {"type":"done", "result":{...}}

  Bash → Wizard:
    {"field":"identity_choice", "value":"1"}
    {"field":"passphrase", "value":"mypass123"}
    {"field":"recovery_ack", "value":"ok"}
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from scripts.installer.crypto import provision_service_keys, wrap_seed, write_seed_password
from scripts.installer.env_writer import backfill_env, write_env
from scripts.installer.identity import resolve_identity
from scripts.installer.models import (
    IdentityChoice,
    InstallerConfig,
    InstallerResult,
    LLMProviderConfig,
    StartupMode,
    StepResult,
    TelegramConfig,
)
from scripts.installer.permissions import ensure_gitignore, lock_permissions
from scripts.installer.ports import allocate_ports
from scripts.installer.secrets import (
    ensure_secrets_dir,
    ensure_session_id,
    generate_pds_secrets,
    is_already_wrapped,
)


def _emit(msg: dict) -> None:
    """Write a JSON line to stdout."""
    print(json.dumps(msg, default=str), flush=True)


def _read_answer() -> dict:
    """Read a JSON line from stdin."""
    line = sys.stdin.readline()
    if not line:
        raise EOFError("stdin closed")
    return json.loads(line.strip())


def _prompt(
    field: str,
    kind: str,
    message: str,
    *,
    choices: list[dict] | None = None,
    default: str = "",
    secret: bool = False,
    allow_blank: bool = False,
    help_text: str = "",
    multi_select: bool = False,
) -> str:
    """Emit a prompt and wait for a valid answer. Returns the raw value."""
    _emit({
        "type": "prompt",
        "field": field,
        "kind": kind,
        "message": message,
        "choices": choices or [],
        "default": default,
        "secret": secret,
        "allow_blank": allow_blank,
        "help_text": help_text,
        "multi_select": multi_select,
    })
    ans = _read_answer()
    return ans.get("value", "")


def _event(name: str, **kwargs) -> None:
    """Emit an event."""
    _emit({"type": "event", "name": name, **kwargs})


def _error(field: str, message: str) -> None:
    """Emit a validation error."""
    _emit({"type": "error", "field": field, "message": message})


# ======================================================================
# Wizard steps
# ======================================================================


def _step_identity_choice() -> tuple[IdentityChoice, str | None, str | None]:
    """Ask how to set up identity. Returns (choice, mnemonic_or_none, hex_or_none)."""
    while True:
        val = _prompt(
            "identity_choice", "choice",
            "Creating your identity",
            choices=[
                {"key": "1", "label": "Create new identity", "help": "first-time setup"},
                {"key": "2", "label": "Restore from recovery phrase", "help": "24 words"},
                {"key": "3", "label": "Restore from seed hex", "help": "advanced — 64-char hex"},
            ],
            help_text="Your identity generates your username (DID) and encryption keys.\n"
                      "Your recovery phrase is the master key.",
        )
        if val == "1":
            return IdentityChoice.NEW, None, None
        elif val == "2":
            mnemonic = _step_restore_mnemonic()
            if mnemonic is not None:
                return IdentityChoice.RESTORE_MNEMONIC, mnemonic, None
            # User chose "create new instead" — loop back
            continue
        elif val == "3":
            hex_seed = _step_restore_hex()
            if hex_seed is not None:
                return IdentityChoice.RESTORE_HEX, None, hex_seed
            # Invalid hex, fall through to new
            return IdentityChoice.NEW, None, None
        else:
            _error("identity_choice", "Please enter 1, 2, or 3.")


def _step_restore_mnemonic() -> str | None:
    """Ask for 24-word recovery phrase. Returns phrase or None (user wants new)."""
    while True:
        phrase = _prompt(
            "mnemonic", "text",
            "Enter your 24-word recovery phrase",
            help_text="Space-separated, e.g.: abandon ability able ...",
        )
        # Validate via the identity module
        try:
            from dina_cli.seed_wrap import mnemonic_to_seed as _validate_mnemonic
            words = phrase.strip().split()
            if len(words) != 24:
                raise ValueError(f"expected 24 words, got {len(words)}")
            _validate_mnemonic(words)
            return phrase
        except (ValueError, Exception) as e:
            _error("mnemonic", str(e))
            # Ask retry or create new
            retry = _prompt(
                "mnemonic_retry", "choice",
                "What would you like to do?",
                choices=[
                    {"key": "1", "label": "Try again"},
                    {"key": "2", "label": "Create new identity instead"},
                ],
            )
            if retry != "1":
                return None


def _step_restore_hex() -> str | None:
    """Ask for 64-char hex seed. Returns hex or None (invalid)."""
    val = _prompt(
        "hex_seed", "text",
        "Enter your 64-character hex seed",
    )
    val = val.strip().lower()
    if len(val) == 64 and all(c in "0123456789abcdef" for c in val):
        return val
    _event("warning", message="Invalid hex seed — creating new identity")
    return None


def _step_passphrase() -> str:
    """Ask for passphrase with confirmation. Returns validated passphrase."""
    _event("info", message="")
    _event("heading", message="Choose a passphrase to protect your identity:")
    _event("info", message="(minimum 8 characters)")
    while True:
        pw = _prompt(
            "passphrase", "text",
            "Passphrase",
            secret=True,
        )
        if len(pw) < 8:
            _error("passphrase", "Passphrase must be at least 8 characters")
            continue
        confirm = _prompt(
            "passphrase_confirm", "text",
            "Confirm",
            secret=True,
        )
        if pw != confirm:
            _error("passphrase_confirm", "Passphrases do not match — try again")
            continue
        return pw


def _step_startup_mode() -> StartupMode:
    """Ask for startup mode."""
    while True:
        val = _prompt(
            "startup_mode", "choice",
            "How should Dina start?",
            choices=[
                {"key": "1", "label": "Enter passphrase each time", "help": "most secure"},
                {"key": "2", "label": "Start automatically", "help": "passphrase stored locally"},
            ],
            help_text="You can switch later: dina-admin security auto-start or manual-start",
        )
        if val == "1":
            return StartupMode.MAXIMUM
        elif val == "2":
            return StartupMode.SERVER
        else:
            _error("startup_mode", "Please enter 1 or 2.")


def _read_env_value(env_file: Path, key: str) -> str:
    """Read a value from an existing .env file. Returns "" if not found."""
    if not env_file.exists():
        return ""
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1].strip()
    return ""


def _step_owner_name() -> str:
    """Ask for owner name (optional)."""
    name = _prompt(
        "owner_name", "text",
        "What should Dina call you?",
        allow_blank=True,
    )
    return name.strip()


def _validate_api_key(env_key: str, api_key: str) -> tuple[bool, str]:
    """Validate an API key using scripts/validate_key.py (real completion test).

    Returns (True, "") on success, (False, error_message) on failure.
    """
    from scripts.validate_key import validate
    try:
        ok = validate(env_key, api_key)
        return ok, ("" if ok else "Key did not work")
    except Exception as e:
        return False, str(e)


def _step_llm_providers() -> list[LLMProviderConfig]:
    """Ask which LLM providers to configure."""
    while True:
        val = _prompt(
            "llm_selection", "choice",
            "Which LLM providers would you like to configure?",
            choices=[
                {"key": "1", "label": "Google Gemini"},
                {"key": "2", "label": "OpenAI GPT"},
                {"key": "3", "label": "Anthropic Claude"},
                {"key": "4", "label": "OpenRouter"},
                {"key": "5", "label": "Ollama (local)"},
                {"key": "6", "label": "Skip"},
            ],
            multi_select=True,
            help_text="Enter one or more numbers separated by spaces (e.g. 1 3)",
        )
        tokens = val.strip().split()
        if not tokens:
            _error("llm_selection", "Please enter at least one number 1-6.")
            continue
        if not all(t in "123456" and len(t) == 1 for t in tokens):
            _error("llm_selection", "Please enter numbers 1-6 only.")
            continue
        if "6" in tokens:
            return []
        break

    providers: list[LLMProviderConfig] = []
    provider_map = {
        "1": ("Google Gemini", "GEMINI_API_KEY"),
        "2": ("OpenAI GPT", "OPENAI_API_KEY"),
        "3": ("Anthropic Claude", "ANTHROPIC_API_KEY"),
        "4": ("OpenRouter", "OPENROUTER_API_KEY"),
    }

    for token in tokens:
        if token == "5":
            # Ollama — no key needed
            providers.append(LLMProviderConfig(
                env_key="OLLAMA_BASE_URL",
                env_value="http://localhost:11434",
            ))
            _event("info", message="Using local Ollama at http://localhost:11434")
            continue

        if token not in provider_map:
            continue

        label, env_key = provider_map[token]
        while True:
            key_val = _prompt(
                f"api_key_{env_key}", "text",
                f"{label} API key",
                secret=True,
                allow_blank=True,
                help_text="Press Enter to skip this provider",
            )
            if not key_val.strip():
                _event("info", message=f"Skipped {label}")
                break
            # Validate the API key with a real completion test
            _event("info", message=f"Validating {label} API key...")
            valid, err_msg = _validate_api_key(env_key, key_val.strip())
            if not valid:
                _error(f"api_key_{env_key}", f"Validation failed: {err_msg}")
                continue
            _event("ok", message=f"{label} API key validated")
            providers.append(LLMProviderConfig(env_key=env_key, env_value=key_val.strip()))
            if token == "4":
                # OpenRouter auto-adds default model
                providers.append(LLMProviderConfig(
                    env_key="OPENROUTER_MODEL",
                    env_value="google/gemini-3-flash",
                ))
            break

    return providers


def _step_telegram() -> TelegramConfig | None:
    """Ask about Telegram setup."""
    while True:
        val = _prompt(
            "telegram_choice", "choice",
            "Connect Telegram?",
            choices=[
                {"key": "1", "label": "Yes — enter Bot Token", "help": "recommended"},
                {"key": "2", "label": "Skip for now"},
            ],
            default="1",
            help_text="Without Telegram, agent approval requests will queue\n"
                      "until you check via dina-admin or the admin web UI.",
        )
        if val == "2" or val == "":
            return None
        if val == "1":
            break
        _error("telegram_choice", "Please enter 1 or 2.")

    token = _prompt(
        "telegram_token", "text",
        "Enter your bot token",
        help_text="From @BotFather (looks like 123456:ABC-DEF...)",
        allow_blank=True,
    ).strip()

    if not token:
        _event("info", message="Skipping Telegram — approve requests via: dina-admin persona approvals")
        return None

    user_id = _prompt(
        "telegram_user_id", "text",
        "Enter your Telegram user ID",
        help_text="From @userinfobot (numeric ID)",
        allow_blank=True,
    ).strip()

    return TelegramConfig(token=token, user_id=user_id)


# ======================================================================
# Main wizard flow
# ======================================================================


def run_wizard(dina_dir: Path, core_port: int = 0, pds_port: int = 0) -> None:
    """Run the full install wizard. Reads/writes JSON lines on stdin/stdout.

    All state stays in this process. The seed never leaves.
    install.sh is just a renderer.

    core_port/pds_port: if non-zero, use these instead of auto-allocating.
    install.sh allocates ports on the host (where socket probing is valid)
    and passes them here via env vars.
    """
    secrets_dir = ensure_secrets_dir(dina_dir)
    service_key_dir = secrets_dir / "service_keys"
    env_file = dina_dir / ".env"

    # Check if already installed (idempotent rerun)
    already_wrapped = is_already_wrapped(secrets_dir)

    if already_wrapped:
        _event("info", message="Identity already created — skipping identity setup")
        identity_choice = None
        mnemonic_str = None
        hex_seed = None
        passphrase = None
        startup_mode = StartupMode.SERVER  # doesn't matter for rerun
        recovery_phrase = None
    else:
        # Step 1: Identity choice
        identity_choice, mnemonic_str, hex_seed = _step_identity_choice()

        # Step 2: Resolve identity (generate seed or restore)
        config_for_identity = InstallerConfig(
            dina_dir=dina_dir,
            identity_choice=identity_choice,
            passphrase="placeholder",  # not used yet
            mnemonic=mnemonic_str,
            hex_seed=hex_seed,
        )
        seed, recovery_phrase = resolve_identity(config_for_identity)

        # Step 3: Show recovery phrase (new identities only)
        if recovery_phrase is not None:
            _emit({
                "type": "event",
                "name": "show_recovery_phrase",
                "words": recovery_phrase,
            })
            # Wait for acknowledgement
            _read_answer()  # {"field":"recovery_ack","value":"ok"}

            # Step 3b: Verify — handled by the presenter (install.sh)
            # because it needs alt-screen control for re-showing the phrase.
            # Wizard just waits for verification_done ack.
            if os.environ.get("DINA_SKIP_MNEMONIC_VERIFY") != "1":
                _read_answer()  # {"field":"verification_done","value":"ok"}

        # Step 4: Passphrase
        passphrase = _step_passphrase()

        # Step 5: Startup mode
        startup_mode = _step_startup_mode()

        # === Provision (seed stays in this process) ===
        _event("info", message="Securing your identity...")
        wrap_seed(seed, passphrase, secrets_dir)
        write_seed_password(secrets_dir, passphrase)
        provision_service_keys(seed, service_key_dir)

        # Zero seed
        seed = b"\x00" * 32  # noqa: F841

        _event("ok", message="Identity secured")

    # Step 6: Owner name (skip if already set in .env)
    existing_owner = _read_env_value(env_file, "DINA_OWNER_NAME")
    if existing_owner:
        owner_name = existing_owner
    else:
        owner_name = _step_owner_name()
    if owner_name:
        _event("ok", message=f"Hello, {owner_name}")

    # Step 7: Telegram (skip if already configured in .env)
    existing_telegram = _read_env_value(env_file, "DINA_TELEGRAM_TOKEN")
    if existing_telegram:
        telegram = TelegramConfig(token=existing_telegram)
    else:
        telegram = _step_telegram()

    # Step 8: LLM providers (skip if any API key already in .env)
    llm_providers: list[LLMProviderConfig] = []
    _has_llm = any(
        _read_env_value(env_file, k)
        for k in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY",
                   "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OLLAMA_BASE_URL")
    )
    if not _has_llm:
        llm_providers = _step_llm_providers()
        if llm_providers:
            n = len([p for p in llm_providers if p.env_key != "OPENROUTER_MODEL"])
            _event("info", message=f"{n} provider(s) configured")

    # === Write config ===
    session_id = ensure_session_id(secrets_dir)
    # Use explicit ports if provided (host-allocated), else auto-detect.
    if core_port and pds_port:
        pass  # already set
    else:
        core_port, pds_port = allocate_ports(
            env_file=env_file if env_file.exists() else None,
        )
    pds_secrets = generate_pds_secrets(
        env_file=env_file if env_file.exists() else None,
    )

    config = InstallerConfig(
        dina_dir=dina_dir,
        identity_choice=identity_choice or IdentityChoice.NEW,
        passphrase=passphrase or "placeholder",
        startup_mode=startup_mode,
        mnemonic=mnemonic_str,
        hex_seed=hex_seed,
        llm_providers=llm_providers,
        telegram=telegram,
        owner_name=owner_name,
    )

    if not env_file.exists():
        write_env(config, session_id, core_port, pds_port, pds_secrets)
    else:
        backfill_env(env_file, session_id, core_port, pds_port, pds_secrets)
        # Backfill owner name
        if owner_name:
            content = env_file.read_text()
            if "DINA_OWNER_NAME=" not in content:
                with open(env_file, "a") as f:
                    f.write(f"\n# Owner\nDINA_OWNER_NAME={owner_name}\n")

    lock_permissions(secrets_dir)
    ensure_gitignore(dina_dir)

    # Verify service keys
    keys_ok = all(
        (service_key_dir / f).is_file()
        for f in [
            "core/core_ed25519_private.pem",
            "brain/brain_ed25519_private.pem",
            "public/core_ed25519_public.pem",
            "public/brain_ed25519_public.pem",
        ]
    ) if not already_wrapped else True

    # Emit result
    _emit({
        "type": "done",
        "result": {
            "session_id": session_id,
            "core_port": core_port,
            "pds_port": pds_port,
            "startup_mode": startup_mode.value,
            "seed_wrapped": already_wrapped or True,
            "service_keys_provisioned": keys_ok,
            "env_file": str(env_file),
            "secrets_dir": str(secrets_dir),
        },
    })
