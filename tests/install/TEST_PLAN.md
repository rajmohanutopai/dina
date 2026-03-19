# Install Test Plan

Tests that verify the full install-to-first-use journey. Every test maps to a real bug found during manual testing.

## Test Files

| File | Tests | Scope | Speed |
|------|-------|-------|-------|
| `test_install_blackbox.py` | 10 | Fresh install, lifecycle, device pairing survives restart | Slow (full install) |
| `test_install_rerun.py` | 6 | Idempotency (seed, salt, keys, DID, .env preserved on rerun) | Slow (full install + rerun) |
| `test_install_failures.py` | 6 | Failure paths (corrupt seed, missing Docker, bad permissions) | Medium (pexpect, no build) |
| `test_startup_modes.py` | 4 | Auto-start vs manual-start behavior | Slow (full install) |
| `test_install_functional.py` | 15 | run.sh UX, dina-admin commands, input validation, .env correctness | Slow (pexpect) |
| `test_post_install.py` | 21 | Functional validation against running Core (dual-mode) | Fast with env vars |
| `test_model_set.py` | 10 | dina-admin model set (direct + interactive, models.json edit) | Fast (2s, no Docker) |

**Total: 73 tests**

## Running

```bash
# Full suite (slow — runs pexpect install)
python scripts/test_status.py --suite install

# Post-install only (fast — needs running Core)
DINA_CORE_URL=http://localhost:8100 DINA_CLIENT_TOKEN=<token> \
  pytest tests/install/test_post_install.py -v

# Quick standalone
./scripts/test_install.sh --quick
```

## Issue Traceability

| # | Issue | Test |
|---|-------|------|
| 1 | "No results found" when LLM not configured | `test_post_install::TestLLMErrorReporting` (3 tests) |
| 2 | "persona not found" on fresh install | `test_post_install::TestDefaultPersonas` (5 tests) |
| 3 | DID not available after restart | `test_install_blackbox::TestFullLifecycle`, `test_post_install::TestDID` |
| 5 | run.sh bare invocation starts containers | `test_install_functional::TestRunShBehavior` (4 tests) |
| 6 | dina-admin device list shows ? for IDs | `test_install_functional::TestDinaAdminPostInstall::test_device_list` |
| 7 | dina-admin model status shows "No LLM" incorrectly | `test_install_functional::TestDinaAdminPostInstall::test_model_list` |
| 8 | dina-admin model list "Override" section empty | `test_install_functional::TestDinaAdminPostInstall::test_model_list` |
| 9 | LLM menu accepts pasted API key silently | `test_install_functional::TestInputValidation::test_api_key_at_llm_menu` |
| 10 | "Continue anyway" with bad key | Fixed in llm_provider.sh (now "Skip this provider") |
| 12 | Telegram blocks install if skipped | `test_install_functional::TestTelegramOptional` |
| 13 | --status service names misaligned | Visual — not testable |
| 14 | healthz logs flood output | `test_post_install::TestHealthzLogSuppression` (requires live containers) |
| 17 | Owner name not asked | `test_post_install::TestOwnerName` |
| 18 | No LLM smoke test during install | In install.sh, verified by manual test |
| 31 | Invalid Telegram choice not caught | `test_install_functional::TestInputValidation::test_invalid_telegram_choice` |
| 47 | Deleted persona recreated on restart | `test_post_install::TestPersonaBootstrapIdempotent` |
| 48 | Paired device auth lost on restart | `test_install_blackbox::TestDevicePairingSurvivesRestart` |

## Coverage by Area

| Area | Tests | Status |
|------|-------|--------|
| Secret creation & permissions | 5 | Complete |
| Service key provisioning | 1 | Complete |
| .env generation | 3 | Complete |
| Container health | 2 | Complete |
| DID generation & stability | 3 | Complete |
| Device pairing survives restart | 1 | Complete |
| Idempotent rerun | 6 | Complete |
| Startup modes (auto/manual) | 5 | Complete |
| Failure paths (corrupt, missing Docker) | 6 | Complete |
| Default personas (4 created, tiers correct) | 5 | Complete |
| Vault store + query round-trip | 1 | Complete |
| LLM error reporting (structured codes) | 3 | Complete |
| KV store round-trip | 1 | Complete |
| PII scrubbing | 1 | Complete |
| Auth enforcement | 3 | Complete |
| Unified approvals API | 2 | Complete |
| Async approval endpoints | 2 | Complete |
| run.sh behavior (usage, status, flags) | 4 | Complete |
| dina-admin commands | 4 | Complete |
| Input validation (all prompts) | 4 | Complete |
| Telegram optional | 1 | Complete |
| Owner name | 1 | Complete |
| Bootstrap idempotency | 1 | Complete |
| Model set direct (lite/primary/heavy) | 6 | Complete |
| Model set interactive (number, paste, keep, change all) | 4 | Complete |
