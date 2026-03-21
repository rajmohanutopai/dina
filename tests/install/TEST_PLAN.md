# Install Test Plan

Tests that verify the full install-to-first-use journey. Every test maps to a real bug found during manual testing.

## Test Suites

### Install suite (`--suite install`) — ~6s with env vars, ~5min without

| File | Tests | Scope |
|------|-------|-------|
| `test_installer_core.py` | 31 | Provisioning logic: seed generation, wrapping, key derivation, .env, permissions, idempotency, validation |
| `test_model_set.py` | 11 | dina-admin model set (direct + interactive, models.json edit) |
| `test_post_install.py` | 21 | Functional validation against running Core (fast with `DINA_CORE_URL`, falls back to pexpect install) |

### Pexpect suite (`--suite install-pexpect`) — included in `run_non_unit_tests.sh`, requires Docker

| File | Tests | Scope |
|------|-------|-------|
| `test_install_blackbox.py` | 9 | Container health, DID reachable, stop/start lifecycle, device pairing survives restart, rerun idempotency, prompt flows |
| `test_install_failures.py` | 6 | Failure paths (corrupt seed, missing Docker, bad permissions) |
| `test_install_functional.py` | 12 | run.sh UX, dina-admin commands, input validation, .env/Telegram wrapper correctness |
| `test_startup_modes.py` | 2 | Auto-start run.sh (no prompt), manual-start run.sh (passphrase prompt + clear) |

**Total: 92 tests** (63 fast + 29 pexpect)

## Architecture

The installer core (`scripts/installer/`) is a Python module that handles:
- Seed generation, mnemonic conversion, hex restore
- Seed wrapping (Argon2id + AES-256-GCM)
- Service key provisioning (SLIP-0010 Ed25519)
- .env generation, port allocation, permissions

**Same code runs in production and tests.** In production, install.sh collects prompts and calls the core via Docker. In tests, `run_install(InstallerConfig(...))` is called directly.

`install.sh` remains the user-facing entry point — it handles:
- Interactive prompts (identity, passphrase, startup mode, owner name, Telegram, LLM)
- Recovery phrase display (alternate screen)
- Docker Compose build/up/health check
- Maximum-security passphrase clearing (after health check)

## Running

```bash
# Fast suite — installer core + model set always run instantly (~3s).
# test_post_install.py uses DINA_CORE_URL if set (fast), otherwise
# falls back to installed_dir fixture (runs install.sh once, ~5 min).
python scripts/test_status.py --suite install

# Fast with env vars (skips pexpect install entirely)
DINA_CORE_URL=http://localhost:8100 DINA_CLIENT_TOKEN=<token> \
  python scripts/test_status.py --suite install

# Pexpect suite (requires Docker)
python scripts/test_status.py --suite install-pexpect

# Post-install only (fast — needs running Core)
DINA_CORE_URL=http://localhost:8100 DINA_CLIENT_TOKEN=<token> \
  pytest tests/install/test_post_install.py -v

# Installer core only (fastest — no Docker, no network)
pytest tests/install/test_installer_core.py -v
```

## Issue Traceability

| # | Issue | Test |
|---|-------|------|
| 1 | "No results found" when LLM not configured | `test_post_install::TestLLMErrorReporting` (3 tests) |
| 2 | "persona not found" on fresh install | `test_post_install::TestDefaultPersonas` (5 tests) |
| 3 | DID not available after restart | `test_install_blackbox::TestFullLifecycle`, `test_post_install::TestDID` |
| 5 | run.sh bare invocation shows usage (--start to start) | `test_install_functional::TestRunShBehavior` (4 tests) |
| 6 | dina-admin device list shows ? for IDs | `test_install_functional::TestDinaAdminPostInstall::test_device_list` |
| 7 | dina-admin model status shows "No LLM" incorrectly | `test_install_functional::TestDinaAdminPostInstall::test_model_list` |
| 8 | dina-admin model list "Override" section empty | `test_install_functional::TestDinaAdminPostInstall::test_model_list` |
| 9 | LLM menu accepts pasted API key silently | `test_install_functional::TestInputValidation::test_api_key_at_llm_menu` |
| 12 | Telegram blocks install if skipped | `test_install_functional::TestTelegramOptional` |
| 17 | Owner name not asked | `test_post_install::TestOwnerName` |
| 31 | Invalid Telegram choice not caught | `test_install_functional::TestInputValidation::test_invalid_telegram_choice` |
| 47 | Deleted persona recreated on restart | `test_post_install::TestPersonaBootstrapIdempotent` |
| 48 | Paired device auth lost on restart | `test_install_blackbox::TestDevicePairingSurvivesRestart` |
