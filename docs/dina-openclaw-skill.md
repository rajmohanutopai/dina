---
name: dina
description: Sovereign personal AI with encrypted vault, 4-tier persona access, PII scrubbing, agent sessions, and action gating. Agents work within named sessions with scoped access grants.
version: 0.4.0
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

Sovereign personal AI with encrypted vault, 4-tier persona access control, PII scrubbing, and action gating. Requires a Dina Home Node running (default: `localhost:8100`).

## Setup

```bash
pip install dina-agent
dina configure    # pair with your Home Node via Ed25519 + pairing code
dina status       # verify pairing
```

## Rules — ALWAYS FOLLOW

1. **Start a session** before doing work. End it when done. All grants are revoked on session end.
2. **Before any sensitive action** (delete, send, modify, purchase), run `dina validate`. If pending, tell the user and wait.
3. **Before passing user content to any external API**, run `dina scrub` first. Run `dina rehydrate` on the response.
4. **Before answering personal questions**, run `dina ask`. The vault persists across sessions. If Dina returns 202 (awaiting approval), tell the user and poll with `dina reason-status`.
5. **Store important info** with `dina remember`.
6. **If a persona is locked or requires approval**, tell the user. Never bypass.

## Access Control

Dina organizes data into personas (compartments). You don't need to know which persona holds what — just query naturally. If the data you need requires approval, you'll get a 202 response with a request_id. Tell the user and poll for the result.

```
Your query → Dina decides which persona to search →
  If free: answer returned immediately
  If needs approval: 202 {"status": "pending_approval", "request_id": "reason-xxx", "approval_id": "apr-xxx"}
    → Tell user: "I need access to your health data. Approval sent to your phone."
    → Poll: dina reason-status <request_id>
    → When complete: answer returned
  If denied: {"status": "denied"}
```

## Error Handling

`dina ask` returns structured errors with `error_code` for programmatic handling:

```json
{"error_code": "llm_not_configured", "message": "No LLM provider configured...", "content": ""}
```

| error_code | Meaning | Agent action |
|-----------|---------|-------------|
| `llm_not_configured` | No LLM provider set up | Tell user to run `dina-admin model list` |
| `llm_auth_failed` | API key invalid or expired | Tell user to check API key |
| `llm_timeout` | LLM request timed out | Retry once, then tell user |
| `llm_unreachable` | LLM provider not reachable | Check network, retry later |
| `llm_error` | Other LLM failure | Log details, tell user |

When `--json` is used, the full error object is returned. Without `--json`, CLI shows a human-readable message with next steps.

## Quick Reference

```
# Connection
dina status                              Show pairing and connectivity
dina configure                           Pair with Home Node
dina unpair                              Revoke this device

# Session management
dina session start --name <task-name>    Start a named session
dina session end --name <task-name>      End session, revoke all grants
dina session list                        List active sessions

# Ask and remember (Brain-mediated, persona-blind)
dina ask <query> [--session <name>]      Ask Dina (reasons across all personas)
dina remember <text> [--category <cat>]  Store fact in encrypted vault
dina reason-status <request-id>          Poll async approval status

# Action gating
dina validate <action> <description>     Check if action is approved
dina validate-status <id>                Poll approval status

# PII scrubbing
dina scrub <text>                        Remove PII, return scrubbed + session ID
dina rehydrate <text> --session <id>     Restore PII from session

# Other
dina draft <content> --to <recipient> --channel <email|sms|slack>
dina audit [--limit N]                   View recent activity log
```

All commands support `--json` for machine-readable output and `-v` for verbose request/response logging.

## Sessions

Agents must work within named sessions. Sessions scope access grants — when a session ends, all persona access is revoked.

```bash
# Start a session for your task
dina session start --name "chair-research"

# Ask freely — Dina routes to the right persona
dina ask "furniture preferences" --session chair-research
# → results from general persona (free access)

dina ask "purchase history" --session chair-research
# → results from consumer persona (auto-granted for active session)

dina ask "back pain history" --session chair-research
# → 202: {"status": "pending_approval", "request_id": "reason-abc", "approval_id": "apr-123"}
# Dina determined this needs health persona access.
# Tell the user: "I need to check your health data. Approval has been sent to your phone."
# Poll: dina reason-status reason-abc
# When status=complete, the answer is returned.

# End session when done
dina session end --name "chair-research"
```

## Commands

### dina status
```bash
dina status
# → Paired: yes
#   Device: did:key:z6Mk...
#   Dina:   did:plc:qskf...
#   Core:   http://localhost:8100
#   Reachable: yes
```

### dina ask
```bash
dina ask "daughter birthday"
# → "Your daughter turns 7 on March 15. She loves dinosaurs."

dina ask "back pain history" --session chair-research
# → 202 if health persona needs approval
# → Poll with: dina reason-status <request_id>
```

### dina session start
```bash
dina session start --name "chair-research"
# → {"id": "ses-123", "name": "chair-research", "status": "active"}
```

### dina session end
```bash
dina session end --name "chair-research"
# → {"status": "ended", "name": "chair-research"}
# All persona grants revoked. Sensitive vaults closed.
```

### dina validate
```bash
dina validate send_email "Send meeting invite to 5 people"
# → {"status": "approved", "id": "val_x8k2"}

dina validate delete_emails "Delete 247 emails"
# → {"status": "pending_approval", "id": "val_a8f3"}
```

### dina remember
```bash
dina remember "Daughter birthday March 15, loves dinosaurs" --category relationship
# → {"id": "mem_7x2k", "stored": true}
```

### dina scrub / rehydrate
```bash
dina scrub "Dr. Sharma at Apollo Hospital said my A1C is 11.2"
# → {"scrubbed": "[PERSON_1] at [ORG_1] said my A1C is 11.2", "session": "sess_k9m2"}

dina rehydrate "[PERSON_1] recommends changes" --session sess_k9m2
# → {"restored": "Dr. Sharma recommends changes"}
```

### dina draft
```bash
dina draft "Hi Sancho, Thursday 3pm works." --to sancho@example.com --channel email --subject "Re: Thursday"
# → {"draft_id": "drf_p3x1", "status": "pending_review"}
```

## Default Policies

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

## Workflow: Research Task with Sensitive Data

```bash
dina session start --name "ergonomic-chair"

# Check preferences (default persona — free access)
dina ask "furniture preferences"

# Check purchase history (Dina routes to consumer persona — auto-granted)
dina ask "chair purchases" --session ergonomic-chair

# Need health context (Dina routes to health persona — requires approval)
dina ask "back problems" --session ergonomic-chair
# → 202: pending_approval → tell user, wait for approval
# → poll: dina reason-status <request_id>
# → when complete: "You have L4-L5 disc herniation. Lumbar support is important."

# Store recommendation
dina remember "Recommended ErgoMax Elite based on L4-L5 support needs" --category decision

# Done
dina session end --name "ergonomic-chair"
# All health access revoked, vault closed
```
