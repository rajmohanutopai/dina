# Test Session Issues — 2026-03-23

Environment: macOS (TestEnv/dina), Docker, dina-agent 0.6.7
Session: ses_usvnzr2xusvn
CLI: /Users/rajmohan/TestEnv/dina/.venv/bin/dina

---

## Issue 1: CRITICAL — `list_personas` tool crashes with NameError

**Every `dina ask` query is broken.** The LLM loops calling `list_personas` 6 times, each crashing, then gives up.

**Brain log (req_id: 4ffc16044bfc):**
```
"tool": "list_personas", "error": "name 'persona_name' is not defined"
  at vault_context.py:224
```

**Root cause:** The code I added in `vault_context.py` for `ApprovalRequiredError` handling references `persona_name` but the actual variable in the loop is named differently.

**Test output:**
```
$ dina ask --session ses_usvnzr2xusvn "What kind of tea do I like?"
I don't have any information about that yet.

$ dina ask --session ses_usvnzr2xusvn "When is my daughters birthday?"
I don't have any information about that yet.
```

**Fix:** Fix the variable name in `vault_context.py` `list_personas` handler.

---

## Issue 2: HIGH — `work` persona requires approval (should be standard tier)

**20+ approval requests for `work` persona in a single `dina ask` call.**

**Core log (req_id: 4ffc16044bfc):**
```
"Approval requested" approval_id="apr-1774267499435903833" client_did="tok-1"
  persona="work" session="ses_usvnzr2xusvn" reason="Query work persona"
/v1/vault/query status=403 caller="agent"
```

**Approval list:**
```
apr-xxx vault_query persona=work agent=tok-1 session=ses_usvnzr2xusvn  (x20+)
```

**Root cause:** `work` is tier `standard`. Standard tier requires session grants for agents but should NOT require explicit approval — the grant should be auto-created when the session starts, or standard tier should not need grants for vault queries through Brain.

**Expected:** Standard tier auto-approves for agents with active sessions. Only sensitive tier (health, finance) should require explicit approval.

---

## Issue 3: HIGH — Anti-Her fallback triggers on empty content after unsolicited filter

**"Do I have any diseases?" gets anti-her redirect even though it's not emotional dependency.**

**Brain log (req_id: 4ffc16044bfc):**
```
"anti_her": [], "unsolicited": [1, 2, 3], ...
"event": "guardian.anti_her_fallback_redirect"
```

**Sequence:**
1. LLM generates 3 sentences (engagement hooks like "How can I help")
2. Guard scan flags all 3 as `unsolicited` (correct — they ARE engagement hooks)
3. All sentences removed → empty content
4. Code falls back to `_build_anti_her_redirect()` → wrong!

**Root cause:** When guard_scan removes everything as unsolicited (not anti-her), the fallback should be "no data found", not the anti-her human redirect. The anti-her redirect is only appropriate when `anti_her_sentences` flagged content.

**Fix:** In `guardian.py:3133`, check if the removal was due to `anti_her_sentences` before using the anti-her redirect. If only `unsolicited_sentences` triggered, return a neutral "no relevant data found" message.

---

## Issue 4: OK — Remember health/finance returns `needs_approval`

Working as designed. Sensitive tier requires approval.

```
$ dina remember --session ses_usvnzr2xusvn "Dr. Sharma said my B12 is low..."
status: needs_approval
message: Classified into a sensitive persona. Approve access via Telegram or dina-admin.

$ dina-admin approvals
apr-xxx staging_resolve persona=health agent=tok-1 session=ses_usvnzr2xusvn
  reason="Store memory in health"
  preview="Dr. Sharma said my B12 is low at 180 pg/mL. Start supplements for 3 months."
```

Preview field works correctly — shows the actual message for admin decision.

---

## Issue 5: BLOCKED — All ask queries return "no information"

Blocked by Issue 1 (list_personas crash). Once that's fixed, tea/daughter queries should work since they were stored in `general` persona (default tier, no approval needed).

---

## Summary

| # | Severity | Issue | Fix Location |
|---|----------|-------|-------------|
| 1 | CRITICAL | list_personas NameError crash | vault_context.py — variable name bug |
| 2 | HIGH | work persona needs approval | identity.go AccessPersona — standard tier grant logic |
| 3 | HIGH | Anti-her fallback on unsolicited-only removal | guardian.py:3133 — wrong fallback path |
| 4 | OK | health/finance needs_approval | Working as designed |
| 5 | BLOCKED | ask returns "no info" | Blocked by #1 |
