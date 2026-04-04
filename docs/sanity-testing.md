# Sanity Testing Guide

End-to-end tests that exercise Dina through real Telegram bots, real OpenClaw agents, real Gmail, and detached task execution.

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
       │  docker exec             ┌──────────────────────────────┐
       └─────────────────────────►│  OpenClaw (13000)             │
                                  │  Gateway + Dina MCP Server    │
                                  │  + agent-daemon + gog + hooks │
                                  │  + Chromium (headless)        │
                                  └──────────────────────────────┘
```

## Three Containers

| Container | Project Name | Ports | What |
|-----------|-------------|-------|------|
| Regression Alonso | `dina-regression-alonso` | Core 18100, PDS 18101 | Primary Dina node, Telegram bot `@regression_test_dina_alonso_bot` |
| Regression Sancho | `dina-regression-sancho` | Core 18300, PDS 18301 | Secondary node, `@regression_test_dina_sancho_bot` |
| OpenClaw | `sanity-openclaw` | Gateway 13000 | OpenClaw gateway + Dina MCP server + agent-daemon + gog Gmail + Chromium browser |

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
tests/sanity/*.lock               # Telethon session lock
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
# Full suite (24 tests, ~9 minutes)
GOG_KEYRING_PASSWORD=<pw> python -m pytest tests/sanity/test_telegram_sanity.py -v -s

# Specific test class
python -m pytest tests/sanity/ -v -s -k "TestHealth"
python -m pytest tests/sanity/ -v -s -k "TestPurchaseJourney"
python -m pytest tests/sanity/ -v -s -k "TestOpenClaw"
python -m pytest tests/sanity/ -v -s -k "TestDelegatedTaskLifecycle"
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
  -e DINA_HOOK_CALLBACK_TOKEN="<callback_token>" \
  -v "$(pwd)/tests/sanity/gog-auth:/root/.config/gogcli" \
  -p 13000:3000 \
  dina-sanity-openclaw
```

The container runs:
- OpenClaw gateway (port 3000) with hooks enabled
- Dina MCP server (stdio, spawned by OpenClaw)
- `dina agent-daemon` (background, polls for delegated tasks)
- Chromium headless (for web browsing tasks)
- gog Gmail CLI (for email tests)

## 24 Test Scenarios

| # | Class | Test | What it validates |
|---|-------|------|-------------------|
| 1 | TestHealth | test_alonso_status | Alonso bot responds to /status with DID |
| 2 | TestHealth | test_sancho_status | Sancho bot responds to /status with DID |
| 3 | TestAsk | test_ask_question | LLM reasoning via Telegram /ask |
| 4 | TestRemember | test_remember_stores | /remember stores in correct vault |
| 5 | TestRemember | test_timed_reminder_fires | Timed reminder fires within 90 seconds |
| 6 | TestContacts | test_alonso_adds_sancho | Add contact by DID (cleanup removes stale) |
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
| 22 | TestDelegatedTaskLifecycle | test_task_via_telegram | /task creates durable task in Core |
| 23 | TestDelegatedTaskLifecycle | test_taskstatus_reads_core | /taskstatus reads from delegated_tasks table |
| 24 | TestDelegatedTaskLifecycle | test_task_approve_and_complete | Full detached: /task → approve → daemon submit → OpenClaw execute → MCP callback → completed |

## Key Implementation Details

### Telethon client (`telegram_client.py`)

- `send_and_wait(bot, text, timeout)` — sends message, polls for bot response using message ID ordering
- `send_and_click(bot, text, button_text, timeout)` — sends, waits for inline buttons, clicks one
- Uses "settle" polling: waits for the latest message ID to stabilize across two polls (handles reminder noise)
- File lock prevents concurrent session access (avoids Telegram auth key invalidation)
- Rate limit: 1s delay before each send to avoid Telegram flood limits

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

MCP tools exposed:

| Tool | Purpose |
|------|---------|
| `dina_session_start` | Start a scoped session |
| `dina_session_end` | End session, revoke grants |
| `dina_validate` | Check if action is approved |
| `dina_validate_status` | Poll approval status |
| `dina_ask` | Query encrypted vault |
| `dina_remember` | Store fact in vault |
| `dina_scrub` | Remove PII from text |
| `dina_task_complete` | Report task completion |
| `dina_task_fail` | Report task failure |
| `dina_task_progress` | Report intermediate progress |
| `dina_status` | Check connectivity |

### Delegated task execution (detached)

The full lifecycle for `/task` commands:

```
User: /task Find the top 3 books on Amazon
  ↓
Brain creates task in Core (pending_approval)
  ↓
Telegram: [Approve] [Deny] → user approves
  ↓
Guardian queues task (pending_approval → queued)
  ↓
agent-daemon claims task (queued → claimed, lease-based)
  ↓
Daemon POSTs to /hooks/agent (fire-and-forget)
  ↓
Daemon marks task running (claimed → running, lease cleared)
  ↓
OpenClaw executes detached (uses Dina MCP tools)
  ↓
Agent calls dina_task_complete via MCP (running → completed)
  ↓
Core ends linked session, stores result
  ↓
User: /taskstatus task-xxx → completed with result
```

Key design:
- **Daemon is a submitter, not a waiter** — submits via HTTP hook and moves to next task immediately
- **Dina is source of truth** — Core's `delegated_tasks` table is authoritative, not OpenClaw
- **MCP callback for completion** — the task prompt instructs OpenClaw to call `dina_task_complete` when done
- **Reconciler as backstop** — background thread checks stale running tasks against OpenClaw's ledger
- **Lease only for claimed** — `ExpireLeases()` never touches running tasks

State machine:
| Status | Meaning | Lease? |
|--------|---------|--------|
| pending_approval | waiting for human approval | no |
| queued | ready for daemon claim | no |
| claimed | daemon owns, not yet submitted to OpenClaw | yes |
| running | OpenClaw accepted, executing detached | no |
| completed | done successfully (result stored) | no |
| failed | error/timeout/cancelled | no |

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

### Internal callback endpoints

Core exposes internal endpoints for task lifecycle callbacks:
- `POST /v1/internal/delegated-tasks/{id}/complete` — mark completed + end session
- `POST /v1/internal/delegated-tasks/{id}/fail` — mark failed + end session
- `POST /v1/internal/delegated-tasks/{id}/progress` — update progress
- `GET /v1/internal/delegated-tasks?status=running` — list all running tasks (for reconciler)

Authenticated by `DINA_HOOK_CALLBACK_TOKEN` Bearer token (constant-time comparison). Idempotent: already-terminal tasks return success no-op.

### Cleanup fixtures

- Contacts: deleted at session start via `/contact delete` Telegram commands (2s delay between calls)
- Trust records: deleted via PDS `deleteRecord` API before/after TestPurchaseJourney
- Sessions: each test creates its own; Core ends sessions on task complete/fail

### Known timing

- Timed reminders fire ~60s later; polls for 90s
- OpenClaw agent calls take 10-30s (LLM reasoning + tool execution)
- Email send test: ~75s (two agent turns + approval + send + verify)
- Delegated task test: ~45-90s (daemon claim + OpenClaw execution + MCP callback)
- Full suite: ~9 minutes

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

# Check agent-daemon logs
docker exec sanity-openclaw cat /tmp/agent-daemon.log

# Test MCP server directly
docker exec -e DINA_CONFIG_DIR=/root/.dina/cli sanity-openclaw dina mcp-server

# Test gog Gmail
docker exec -e GOG_KEYRING_PASSWORD=<pw> sanity-openclaw \
  gog gmail search "is:unread" --limit 5 --account dinaworker85@gmail.com

# List pending intent proposals
docker compose -p dina-regression-alonso exec -T core dina-admin --json intent list

# Check delegated task status via Core API
curl -s http://localhost:18100/v1/internal/delegated-tasks?status=running \
  -H "Authorization: Bearer <callback_token>"

# Re-create Telethon session (if auth key invalidated)
rm tests/sanity/sanity_session.session
python tests/sanity/create_session.py
```
