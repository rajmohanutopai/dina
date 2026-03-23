---
name: dina
description: Sovereign personal AI — encrypted vault, persona access control, PII scrubbing, session-scoped grants, action gating.
version: 0.6.7
metadata:
  openclaw:
    emoji: "🛡️"
    homepage: https://github.com/rajmohanutopai/dina
    requires:
      bins:
        - dina
    defaultEnv:
      DINA_CORE_URL: "http://localhost:8100"
    install:
      - id: pip
        kind: pip
        package: dina-agent
        bins: [dina]
        label: "Install Dina CLI (pip install dina-agent)"
---

# Dina

Sovereign personal AI. The user's data is in an encrypted vault on their Home Node. Dina controls access — you query through her, never directly. Data is organized into personas (compartments) with tiered access: some are free, some require the user's explicit approval.

**Why use Dina:** The user's personal data (health records, finances, relationships, preferences) lives here. If you need to know something about the user, ask Dina. If you need to store something for the user, tell Dina. If you need to do something sensitive, validate with Dina first.

**How it works:** You work within sessions. Each session scopes your access — based on different areas of work, you can create multiple sessions in parallel. When you need data from a sensitive persona, Dina sends an approval request to the user. You poll for the result. When a session ends, all its grants are revoked.

## Setup

```bash
pip install dina-agent
dina configure --role agent    # pair as agent device
dina status                    # verify pairing
```

## Rules

1. Start a session before doing work. End it when done.
2. Before any sensitive action, run `dina validate`.
3. Before passing user content to any external API, run `dina scrub` to get PII-scrubbed data. Run `dina rehydrate` on the response to restore the original PII.
4. If a persona requires approval, tell the user and poll. Never bypass.

## Commands

All commands support `--json` for machine-readable output.

---

### dina session start

```
dina session start [--name <description>]
```

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `--name` | No | Auto-generated (`SName-DDMmmHHMM:SS`) | Human-readable description |

**Returns:** `{"id": "ses_xxx", "name": "...", "status": "active"}`

---

### dina session end

```
dina session end <id-or-name>
```

Accepts session ID (`ses_xxx`) or name. Revokes all grants. Closes sensitive vaults opened via approval.

**Returns:** `{"status": "ended", "session": "ses_xxx"}`

---

### dina session list

```
dina session list
```

**Returns:** List of active sessions with IDs, names, status, and active grants.

---

### dina ask

```
dina ask <query> --session <ses_xxx> [--timeout <seconds>]
```

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `query` | Yes | — | Natural language question |
| `--session` | Yes | — | Session ID |
| `--timeout` | No | 300 | Approval poll timeout (30–1800 seconds) |

**Returns (immediate):** `{"content": "...", "model": "...", "req_id": "..."}`

**Returns (needs approval):** `{"status": "pending_approval", "request_id": "...", "approval_id": "...", "persona": "..."}`

**Polling:** `dina ask-status <request_id>`

**Terminal states:** `complete`, `denied`, `failed`, `expired`

**Polling interval:** 5s for first 30s, then 15s.

**On timeout:** Returns exit code 1. The `request_id` is printed. The approval request persists — `dina ask-status <request_id>` works indefinitely until resolved.

---

### dina ask-status

```
dina ask-status <request_id>
```

**Returns:** `{"status": "complete|denied|failed|expired|pending", "content": "..."}`

---

### dina remember

```
dina remember <text> --session <ses_xxx> [--category <cat>]
```

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `text` | Yes | — | Text to store |
| `--session` | Yes | — | Session ID |
| `--category` | No | — | Optional category tag |

**Returns (stored):** `{"status": "stored", "id": "..."}`

**Returns (needs approval):** `{"status": "needs_approval", "id": "...", "message": "..."}`

**Polling:** `dina remember-status <id>`

---

### dina remember-status

```
dina remember-status <id>
```

**Returns:** `{"status": "stored|needs_approval|failed|processing", "id": "..."}`

---

### dina validate

```
dina validate <action> <description> --session <ses_xxx>
```

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `action` | Yes | — | Action type (e.g. `search`, `send_email`, `delete`) |
| `description` | Yes | — | What the action does |
| `--session` | Yes | — | Session ID |
| `--count` | No | 1 | Number of items affected |
| `--reversible` | No | false | Whether action is reversible |

**Returns (approved):** `{"status": "approved", "id": "val_xxx", "risk": "SAFE"}`

**Returns (pending):** `{"status": "pending_approval", "id": "val_xxx", "risk": "MODERATE"}`

**Polling:** `dina validate-status <id>`

---

### dina validate-actions

```
dina validate-actions
```

Returns all known actions with their current risk level. Call this at session start to discover what actions exist and what approval behavior to expect.

**Returns (text):**
```
  search                         SAFE
  send_email                     MODERATE
  delete_data                    HIGH
  access_keys                    BLOCKED
  (unlisted actions)             SAFE
```

**Returns (--json):**
```json
{"actions": {"search": "safe", "send_email": "moderate", ...}, "default_risk": "safe"}
```

The policy is configurable by the user via `dina-admin policy set <action> <risk>`. Actions not in the policy default to SAFE.

---

### dina validate-status

```
dina validate-status <id>
```

**Returns:** `{"status": "approved|pending_approval|denied", "id": "..."}`

---

### dina scrub

```
dina scrub <text>
```

Removes structured PII (phone numbers, email addresses, SSNs, Aadhaar, PAN, credit cards, government IDs). V1 does NOT detect names, organizations, or locations in free text.

**Returns:** `{"scrubbed": "Call Dr. Sharma at [PHONE_1]", "pii_id": "pii_xxx"}`

**Entities detected:** `PHONE`, `EMAIL`, `CREDIT_CARD`, `SSN`, `AADHAAR`, `IN_PAN`, `IN_IFSC`, `IN_UPI_ID`, `IP`, `URL`

**Not detected (V1):** Person names, organization names, locations, addresses

---

### dina rehydrate

```
dina rehydrate <scrubbed_text> --session <pii_id>
```

Restores original PII from a scrub session. Local only — no network call.

**Returns:** `{"restored": "Call Dr. Sharma at 9876543210"}`

---

### dina draft

```
dina draft <content> --to <recipient> --channel <email|sms|slack|whatsapp> [--subject <text>]
```

**Returns:** `{"draft_id": "drf_xxx", "status": "pending_review"}`

---

### dina task

```
dina task <description> [--timeout <seconds>] [--dry-run]
```

Delegates an autonomous task to OpenClaw Gateway. Requires `DINA_OPENCLAW_URL` + `DINA_OPENCLAW_TOKEN`.

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `description` | Yes | — | Task description |
| `--timeout` | No | 300 | Approval poll timeout (30–1800 seconds) |
| `--dry-run` | No | false | Validate intent without executing |

---

### dina audit

```
dina audit [--limit N] [--action <type>]
```

**Returns:** List of recent audit entries with timestamp, action, persona, requester, reason.

---

### dina status

```
dina status
```

**Returns:** Pairing status, device DID, Dina DID, Core URL, reachability.

---

## Access Control

| Persona Tier | Boot State | Agent Access |
|-------------|-----------|--------------|
| Default (`general`) | Open | Free |
| Standard (`work`) | Open | Free with active session |
| Sensitive (`health`, `finance`) | Closed | Requires user approval per session |
| Locked | Closed | Denied (user must manually unlock) |

When a query touches a sensitive persona, Dina returns 202 with `pending_approval`. The user is notified via Telegram and admin CLI. After approval, the grant lasts for the session.

## Timeout Contract

`--timeout` on `dina ask` and `dina task`:

| Parameter | Value |
|-----------|-------|
| Default | 300 seconds |
| Minimum | 30 seconds (enforced) |
| Maximum | 1800 seconds (enforced) |
| Polling interval | 5s for first 30s, then 15s |

On timeout: the approval request persists. `dina ask-status <request_id>` works indefinitely.

## Error Codes

`dina ask --json` returns structured errors:

| error_code | Meaning |
|-----------|---------|
| `llm_not_configured` | No LLM provider set up |
| `llm_auth_failed` | API key invalid or expired |
| `llm_timeout` | LLM request timed out |
| `llm_unreachable` | LLM provider not reachable |
| `llm_error` | Other LLM failure |

## Default Action Policies

| Action | Default |
|--------|---------|
| Read-only (search, list, query) | Auto-approved |
| Store (remember, draft) | Auto-approved |
| Send ≤3 recipients | Auto-approved |
| Send >3 recipients | Needs approval |
| Delete ≤3 items, reversible | Auto-approved |
| Delete >3 items or irreversible | Needs approval |
| Modify settings/permissions | Needs approval |
| Financial (purchase, payment) | Needs approval |
| Bulk operations (>10 items) | Needs approval |

## Device Pairing

```bash
dina configure --role agent
```

Agent-originated content is tagged `(cli, agent)` with caveated trust. Never treated as user-authored memory.
