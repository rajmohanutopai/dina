---
name: dina
description: Encrypted memory vault, PII scrubbing, and destructive-action gating. Remember facts across sessions, scrub personal data before external calls, block bulk deletes/sends until human approves in dashboard.
version: 0.1.0
metadata:
  openclaw:
    emoji: "🛡️"
    homepage: https://github.com/rajmohanutopai/dina
    requires:
      env:
        - DINA_CLIENT_TOKEN
        - DINA_CORE_URL
      bins:
        - dina
    primaryEnv: DINA_CLIENT_TOKEN
    defaultEnv:
      DINA_CORE_URL: "http://localhost:8100"
    install:
      - id: pip
        kind: pip
        package: dina-cli
        bins: [dina]
        label: "Install Dina CLI (pip)"
---

# Dina

Encrypted memory, PII scrubbing, and action gating via CLI. Requires Dina Core running (default: `localhost:8100`, override with `DINA_CORE_URL`).

## Rules — ALWAYS FOLLOW

1. **Before any sensitive action** (delete, send, modify settings, purchase, bulk ops), run `dina validate`. If approved, proceed. If pending, tell the user it's awaiting approval in the Dina dashboard, then wait.
2. **Before passing user content to any external API**, run `dina scrub` first. Run `dina rehydrate` on the response.
3. **Before answering personal questions**, run `dina recall`. The vault persists across sessions.
4. **Store important info** (names, preferences, decisions, events) with `dina remember`.

## Quick Reference

```
dina remember <text> [--category <cat>]    Store fact in encrypted vault
dina recall <query> [--limit N]            Search the vault
dina validate <action> <description> [--count N] [--reversible]   Check if action is approved
dina validate status <id>                  Poll approval status for a pending action
dina scrub <text>                          Remove PII, return scrubbed + session ID
dina rehydrate <text> --session <id>       Restore PII from session
dina draft <content> --to <recipient> --channel <email|sms|slack|whatsapp> [--subject <s>]
dina sign <content>                        Cryptographic signature with user's DID key
dina audit [--limit N]                     View recent agent activity log
```

All commands support `--json` for machine-readable output.

## Commands

### dina validate
Check if an action is approved by user's policy. Run BEFORE sends, deletes, bulk ops, settings changes, purchases.
```bash
dina validate send_email "Send meeting invite to 5 people" --count 5
# → {"status": "approved", "id": "val_x8k2"}   ← proceed

dina validate delete_emails "Delete 247 emails older than Feb 15" --count 247
# → {"status": "pending_approval", "id": "val_a8f3", "dashboard_url": "${DINA_CORE_URL}/approvals/val_a8f3"}
```
If `approved`: proceed with the action.
If `pending_approval`: tell the user it's waiting for their approval in the Dina dashboard. Poll with `dina validate status <id>` or wait for user to confirm in chat.

### dina remember
```bash
dina remember "Daughter birthday March 15, loves dinosaurs" --category relationship
# → {"id": "mem_7x2k", "stored": true}

dina remember "Prefers window seat, vegetarian meals on flights" --category preference
```
Categories: `fact`, `preference`, `decision`, `relationship`, `event`, `note`

### dina recall
```bash
dina recall "daughter birthday" --limit 5
# → [{"id": "mem_7x2k", "content": "Daughter birthday March 15, loves dinosaurs", "category": "relationship", "created": "2026-02-20T..."}]

dina recall "flight preference"
```

### dina scrub
```bash
dina scrub "Dr. Sharma at Apollo Hospital, Aadhaar 9876-5432-1012, said my A1C is 11.2"
# → {"scrubbed": "[PERSON_1] at [ORG_1], [AADHAAR_1], said my A1C is 11.2", "session": "sess_k9m2"}
```
Pass scrubbed text to external APIs. Keep the session ID for rehydration.

### dina rehydrate
```bash
dina rehydrate "[PERSON_1] at [ORG_1] recommends dietary changes" --session sess_k9m2
# → {"restored": "Dr. Sharma at Apollo Hospital recommends dietary changes"}
```

### dina draft
Stage a message for human review. Use when `dina validate` returns `pending_approval` for a send action. User reviews and sends from dashboard.
```bash
dina draft "Hi Sancho, Thursday 3pm works for me." --to sancho@example.com --channel email --subject "Re: Thursday"
# → {"draft_id": "drf_p3x1", "status": "pending_review", "dashboard_url": "${DINA_CORE_URL}/drafts/drf_p3x1"}
```

### dina sign
```bash
dina sign "I approve the Q4 budget"
# → {"signed_by": "did:plc:abc123...", "signature": "base64...", "timestamp": "2026-02-24T..."}
```

### dina audit
View recent agent activity log. Filter by action type with `--action`.
```bash
dina audit --limit 20
dina audit --action send_email --limit 10
dina audit --action checkpoint --limit 10
```
Action types: `send_email`, `delete_emails`, `remember`, `scrub`, `validate`, `draft`, `sign`, `checkpoint`

## Default Policies

| Action | Default |
|---|---|
| Read-only (search, list, query) | Auto-approved |
| Store (remember, draft) | Auto-approved |
| Send (email, message, post) ≤3 recipients | Auto-approved |
| Send to >3 recipients | Needs approval |
| Delete/archive ≤3 items, reversible | Auto-approved |
| Delete >3 items or irreversible | Needs approval |
| Modify settings/permissions | Needs approval |
| Financial (purchase, payment) | Needs approval |
| Bulk operations (>10 items) | Needs approval |

Users configure thresholds and policies in the Dina dashboard at `${DINA_CORE_URL}/settings`.

## Workflows

**Email cleanup:**
```bash
dina recall "email preferences"                          # check user history
# ... read inbox, build candidate list ...
dina validate delete_emails "Delete 247 old emails" --count 247
# → pending_approval
# Tell user: "247 emails ready to clean up. Approve in Dina dashboard."
# User approves 180, skips 67
# Proceed with approved items
```

**Sending messages:**
```bash
dina validate send_email "Send meeting invite to team" --count 3
# → approved  (≤3 recipients, auto-approved by default policy)
# Proceed to send

dina validate send_email "Send newsletter to 500 subscribers" --count 500
# → pending_approval
dina draft "March newsletter content..." --to list@company.com --channel email --subject "March Update"
# User reviews and sends from dashboard
```

**PII-safe external API call:**
```bash
dina scrub "Patient Rajesh Kumar, Aadhaar 1234-5678-9012, diagnosis: Type 2 diabetes"
# → scrubbed text + session ID
# Send scrubbed text to external API
dina rehydrate "<api response with placeholders>" --session sess_xxx
# → restored response with real names
```

**Cross-session memory:**
```bash
# Session 1
dina remember "Daughter turns 7 on March 15, loves dinosaurs" --category relationship
# Session 47
dina recall "daughter birthday"   # → instant recall from encrypted vault
```