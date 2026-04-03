# Sanity Testing Guide

End-to-end tests that exercise Dina through real Telegram bots, real OpenClaw agents, and real Gmail.

## Architecture

```
┌─────────────┐     Telethon      ┌──────────────────┐
│  pytest      │ ───────────────► │  Telegram API     │
│  (host)      │                  │  (real messages)  │
└──────┬───────┘                  └────────┬──────────┘
       │                                   │
       │  subprocess                       ▼
       │                          ┌──────────────────┐
       ├─────────────────────────►│  Regression       │
       │  docker exec             │  Alonso (18100)   │
       │                          │  Core + Brain     │
       │                          │  + PDS + Telegram  │
       │                          └──────────────────┘
       │
       │  docker exec             ┌──────────────────┐
       ├─────────────────────────►│  Regression       │
       │                          │  Sancho (18300)   │
       │                          │  Core + Brain     │
       │                          │  + PDS + Telegram  │
       │                          └──────────────────┘
       │
       │  docker exec             ┌──────────────────┐
       └─────────────────────────►│  OpenClaw (13000) │
                                  │  Gateway + Dina   │
                                  │  MCP Server + gog │
                                  └──────────────────┘
```

## Three Containers

| Container | Project Name | Ports | What |
|-----------|-------------|-------|------|
| Regression Alonso | `dina-regression-alonso` | Core 18100, PDS 18101 | Primary Dina node, Telegram bot `@regression_test_dina_alonso_bot` |
| Regression Sancho | `dina-regression-sancho` | Core 18300, PDS 18301 | Secondary node, `@regression_test_dina_sancho_bot` |
| OpenClaw | `sanity-openclaw` | Gateway 13000 | OpenClaw gateway with Dina MCP server, gog Gmail CLI |

## Prerequisites

### One-time setup

1. **Telegram bots** created via @BotFather (two bots, one per regression instance)
2. **Telethon session** (interactive phone login, one-time):
   ```bash
   python tests/sanity/create_session.py
   ```
3. **Regression instances installed**:
   ```bash
   ./install.sh --instance regression-alonso --port 18100 --config tests/sanity/config-alonso.json
   ./install.sh --instance regression-sancho --port 18300 --config tests/sanity/config-sancho.json
   ```
4. **Gmail OAuth** (one-time on any machine, tokens are portable):
   ```bash
   gog auth credentials ~/Downloads/gmail_credentials.json
   gog auth keyring file
   gog auth add dinaworker85@gmail.com --services gmail
   ```
   Copy `~/.config/gogcli/` to `tests/sanity/gog-auth/`

### Secrets file: `tests/sanity/.env.sanity` (gitignored)

```bash
# Telethon
SANITY_TELEGRAM_API_ID=<api_id>
SANITY_TELEGRAM_API_HASH=<api_hash>
SANITY_ALONSO_TELEGRAM_TOKEN=<bot_token>
SANITY_SANCHO_TELEGRAM_TOKEN=<bot_token>
SANITY_OWNER_TELEGRAM_ID=<user_id>

# Gemini
SANITY_GOOGLE_API_KEY=<key>

# Gmail
SANITY_GMAIL_ACCOUNT=dinaworker85@gmail.com
GOG_KEYRING_PASSWORD=<password>
```

### Gitignored files (never committed)

```
tests/sanity/.env.sanity          # All credentials
tests/sanity/*.session            # Telethon session
tests/sanity/config-*.json        # Instance install configs
tests/sanity/gmail_credentials.json
tests/sanity/gog-auth/            # Gmail OAuth tokens
tests/sanity/regression-alonso/   # Local instance state
tests/sanity/regression-sancho/
instances/                        # All instance data
```

## Running Tests

### Quick run (instances already running)

```bash
# Full suite (21 tests, ~9 minutes)
GOG_KEYRING_PASSWORD=<pw> python -m pytest tests/sanity/test_telegram_sanity.py -v -s

# Specific test class
python -m pytest tests/sanity/ -v -s -k "TestHealth"
python -m pytest tests/sanity/ -v -s -k "TestPurchaseJourney"
python -m pytest tests/sanity/ -v -s -k "TestOpenClaw"
```

### Via runner script

```bash
./tests/sanity/run_sanity.sh --existing    # Reuse running instances
./tests/sanity/run_sanity.sh --new         # Fresh install (new DIDs)
```

### Starting the OpenClaw container

The OpenClaw container must be started manually (not managed by pytest):

```bash
# Build
docker build -f tests/sanity/Dockerfile.openclaw -t dina-sanity-openclaw .

# Get a pairing code
PAIR_CODE=$(docker compose -p dina-regression-alonso exec -T core \
  dina-admin --json device pair | python3 -c "import sys,json; print(json.load(sys.stdin)['code'])")

# Start
docker run -d --name sanity-openclaw \
  --add-host=host.docker.internal:host-gateway \
  -e GOOGLE_API_KEY="<gemini_key>" \
  -e DINA_CORE_URL="http://host.docker.internal:18100" \
  -e DINA_PAIRING_CODE="$PAIR_CODE" \
  -e OPENCLAW_TOKEN="sanity-test-token-fixed" \
  -e GOG_KEYRING_PASSWORD="<gog_pw>" \
  -v "$(pwd)/tests/sanity/gog-auth:/root/.config/gogcli" \
  -p 13000:3000 \
  dina-sanity-openclaw
```

## 21 Test Scenarios

| # | Class | Test | What it validates |
|---|-------|------|-------------------|
| 1 | TestHealth | test_alonso_status | Alonso bot responds to /status with DID |
| 2 | TestHealth | test_sancho_status | Sancho bot responds to /status with DID |
| 3 | TestAsk | test_ask_question | LLM reasoning via Telegram /ask |
| 4 | TestRemember | test_remember_stores | /remember stores in correct vault |
| 5 | TestRemember | test_timed_reminder_fires | Timed reminder fires within 3 minutes |
| 6 | TestContacts | test_alonso_adds_sancho | Add contact by DID |
| 7 | TestContacts | test_sancho_adds_alonso | Mutual contact registration |
| 8 | TestContacts | test_contact_list | Contact list shows added contacts |
| 9 | TestSanchoMoment | test_sancho_remembers_alonso_context | Vault stores relationship context |
| 10 | TestSanchoMoment | test_alonso_sends_arrival | D2D /send delivers presence signal |
| 11 | TestSanchoMoment | test_sancho_receives_contextual_nudge | Arrival triggers vault-context nudge |
| 12 | TestPurchaseJourney | test_sancho_health_context | Health data auto-classified to health vault |
| 13 | TestPurchaseJourney | test_sancho_budget_context | Budget auto-classified to finance vault |
| 14 | TestPurchaseJourney | test_alonso_publishes_review | /review + Publish button → PDS record |
| 15 | TestPurchaseJourney | test_sancho_asks_for_chair | /ask finds health + budget + Trust Network review |
| 16 | TestAgentGateway | test_validate_safe_action | CLI `dina validate` search → approved |
| 17 | TestAgentGateway | test_validate_risky_action | CLI `dina validate` send_email → pending_approval |
| 18 | TestOpenClaw | test_openclaw_validate_safe | MCP `dina_validate` search → approved |
| 19 | TestOpenClaw | test_openclaw_validate_risky | MCP `dina_validate` send_email → pending (agent stops) |
| 20 | TestOpenClaw | test_openclaw_ask_vault | MCP `dina_ask` returns vault context |
| 21 | TestOpenClaw | test_openclaw_email_send | Full safety: validate → Telegram approve → send → verify inbox |

## Key Implementation Details

### Telethon client (`telegram_client.py`)

- `send_and_wait(bot, text, timeout)` — sends message, polls for bot response using message ID ordering
- `send_and_click(bot, text, button_text, timeout)` — sends, waits for inline buttons, clicks one
- Uses "settle" polling: waits for the latest message ID to stabilize across two polls (handles reminder noise)

### OpenClaw MCP integration

OpenClaw connects to Dina via MCP stdio transport. Config in `openclaw.json`:
```json5
{
  mcp: {
    servers: {
      dina: {
        command: "dina",
        args: ["mcp-server"],
        env: { DINA_CONFIG_DIR: "/root/.dina/cli" }
      }
    }
  }
}
```

MCP tools exposed: `dina_session_start`, `dina_session_end`, `dina_validate`, `dina_validate_status`, `dina_ask`, `dina_remember`, `dina_scrub`, `dina_status`.

### Approval flow (agent safety)

```
Agent calls dina_validate(send_email) → pending_approval + proposal_id
  ↓
Dina sends Telegram notification with [Approve] [Deny] buttons
  ↓
Human taps Approve in Telegram
  ↓
Agent calls dina_validate_status(proposal_id) → status: approved
  ↓
Agent proceeds with action
```

The `--context` flag on `dina validate` adds structured metadata (to, subject, attachment_count) visible in the Telegram approval notification.

### Cleanup fixtures

- Contacts: deleted at session start via `/contact delete` Telegram commands
- Trust records: deleted via PDS `deleteRecord` API before/after TestPurchaseJourney
- Sessions: each test creates its own session

### Known timing issues

- Timed reminders fire ~60s later; `_check_new_messages` polls the full timeout to catch them
- The reminder test always takes ~3 minutes (waiting for fire)
- Reminder notifications can arrive between `/send` and its response (handled by settle-polling)

## Debugging

```bash
# Check recent Telegram messages
python3 -c "
import asyncio
from telethon import TelegramClient
async def check():
    c = TelegramClient('tests/sanity/sanity_session', API_ID, API_HASH)
    await c.connect()
    msgs = await c.get_messages('regression_test_dina_alonso_bot', limit=10)
    for m in reversed(msgs):
        print(f'[{m.date}] {\"YOU>\" if m.out else \"BOT>\"} {m.text[:80]}')
asyncio.run(check())
"

# Check OpenClaw logs
docker logs sanity-openclaw 2>&1 | tail -20

# Test MCP server directly
docker exec -e DINA_CONFIG_DIR=/root/.dina/cli sanity-openclaw dina mcp-server

# Test gog Gmail
docker exec -e GOG_KEYRING_PASSWORD=<pw> sanity-openclaw \
  gog gmail search "is:unread" --limit 5 --account dinaworker85@gmail.com

# List pending intent proposals
docker compose -p dina-regression-alonso exec -T core dina-admin --json intent list
```
