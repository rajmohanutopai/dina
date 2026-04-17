# Telegram Sanity Tests

End-to-end regression tests that exercise Dina through real Telegram bots.

## Two Modes

| Mode | Flag | What happens |
|------|------|-------------|
| **New** | `--new` | Stops existing instances, runs `install.sh --instance` for both Alonso and Sancho, creates new DIDs, starts fresh |
| **Existing** | `--existing` | Reuses running instances (same DIDs, same bots). Starts them if stopped. |

```bash
# Fresh install (new DID, new instances)
./tests/sanity/run_sanity.sh --new

# Reuse existing (same DID, same bots — default for daily runs)
./tests/sanity/run_sanity.sh --existing

# Auto-detect (uses existing if healthy, fails otherwise)
./tests/sanity/run_sanity.sh

# Pass extra pytest args
./tests/sanity/run_sanity.sh --existing -k "TestHealth"
```

## Prerequisites

1. **Telethon session** (one-time): `python tests/sanity/create_session.py`
2. **`.env.sanity`** with API credentials (not in git):
   ```
   SANITY_TELEGRAM_API_ID=...
   SANITY_TELEGRAM_API_HASH=...
   SANITY_ALONSO_TELEGRAM_TOKEN=...
   SANITY_SANCHO_TELEGRAM_TOKEN=...
   SANITY_OWNER_TELEGRAM_ID=...
   ```
3. **Config files** for `--new` mode: `config-alonso.json`, `config-sancho.json`

## Test Scenarios

| # | Class | What it tests |
|---|-------|--------------|
| 1 | TestHealth | Both bots respond to /status with DID |
| 2 | TestAsk | LLM reasoning via /ask |
| 3 | TestRemember | Vault storage + timed reminder fires |
| 4 | TestContacts | Mutual contact registration |
| 5 | TestSanchoMoment | D2D arrival + vault recall + contextual nudge |
| 6 | TestTrust | Trust Network query |
| 7 | TestAgentGateway | Safe/risky action validation via Core API |
| 8 | TestWS2ServiceQuery | `/service_query` command grammar + routing (`test_ws2_telegram.py`) |
| 9 | TestTransitEndToEnd | Full BusDriver transit scenario — real OpenClaw + transit MCP, Telegram user sees real ETA + map URL (`test_transit_e2e.py`) |

## Transit E2E (Test #9) — opt-in

Gated on `SANITY_TRANSIT_ENABLED=1`. Requires a third Home Node
(`regression-busdriver`) that's not part of the default two-instance
setup. Extra preconditions:

- `regression-busdriver` Core+Brain running (default port 18500/18600).
- BusDriver paired with an OpenClaw container that has the
  `demo/transit` MCP tool registered (see `demo/transit/openclaw-setup.sh`).
- `dina agent-daemon` running inside that OpenClaw container.
- BusDriver's `/v1/service/config` published with the canonical
  `eta_query` schema (hash must match `test_transit_e2e.py::ETA_QUERY_SCHEMA_HASH`).
- Alonso's `regression-alonso` has AppView access and — for the
  natural-language path — an LLM key configured.

Extra env vars in `.env.sanity`:

```
SANITY_TRANSIT_ENABLED=1
SANITY_BUSDRIVER_CORE_URL=http://localhost:18500
SANITY_BUSDRIVER_DID=did:plc:...
SANITY_LLM_ENABLED=1      # optional — enables the /ask natural-language test
```

The module auto-skips if `SANITY_TRANSIT_ENABLED` isn't `1` or
BusDriver isn't reachable, so leaving it off doesn't break the
default sanity run.

## Architecture

Uses Telethon (user client) to send messages AS the real Telegram user to bot
accounts, then polls for bot responses. Two isolated Dina instances:

- **Regression Alonso**: port 18100, `@regression_test_dina_alonso_bot`
- **Regression Sancho**: port 18300, `@regression_test_dina_sancho_bot`
