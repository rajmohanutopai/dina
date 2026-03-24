# Negative Test Results — 2026-03-24

## Summary

| Test | Status | Notes |
|------|--------|-------|
| **Sessions** | | |
| N-001: End nonexistent session | PASS | 404 error |
| N-002: End already-ended session | PASS | 404 error |
| N-003: Use ended session for ask | PASS | **FIXED** — "session not found or not active" |
| N-004: Use fake session ID for ask | PASS | **FIXED** — "session not found or not active" |
| N-005: Very long session name | PASS | Accepted |
| **Remember** | | |
| N-010: Empty text | PASS | 400 "text is required" |
| N-011: Very long text (5000 chars) | PASS | Stored |
| N-012: Invalid session ID | PASS | **FIXED** — "session not found or not active" |
| **Ask** | | |
| N-020: Very long query | PASS | Handled |
| N-021: Special characters | PASS | Handled |
| N-022: SQL injection | PASS | Treated as text |
| N-023: Prompt injection | PASS | "no relevant info" |
| **Scrub** | | |
| N-030: Very long text (100 phones) | PASS | All 100 detected |
| N-031: Whitespace only | PASS | Returns whitespace (acceptable) |
| N-032: Unicode/emoji | PASS | Phone detected, unicode preserved |
| N-033: Rehydrate wrong session | PASS | "Session not found" |
| **Validate** | | |
| N-040: Unknown action type | PASS | Defaults to SAFE (by design) |
| N-041: Empty description | PASS | Accepted |
| **Admin** | | |
| N-050: Approve nonexistent | PASS | 404 |
| N-051: Deny nonexistent | PASS | 404 |
| N-052: Vault list nonexistent persona | PASS | 404 |
| N-053: Vault delete wrong persona | PASS | 404 |
| N-054: Persona edit nonexistent | PASS | 404 |
| N-055: Invalid risk level | PASS | Click rejects |
| N-056: Trace nonexistent req_id | PASS | "No trace found" |
| N-057: Device revoke nonexistent | ISSUE | 500 (should be 404) |
| **Security** | | |
| N-060-062: Missing --session | PASS | Click enforces required |
| N-063: Draft missing fields | PASS | Click enforces required |
| N-064: Timeout 0 (clamped to 30) | PASS | Works |
| N-070: Concurrent duplicate remember | PASS | Both stored (by design — dedup on source_id, not content) |
| N-072: XSS in scrub | PASS | HTML preserved (scrub is PII, not XSS) |
| N-073: Path traversal in remember | PASS | Stored as text |
| N-074: SQL injection in vault search | PASS | No results — FTS5 sanitized |

## Session Validation (FIXED in this session)

Entry-point handlers (`HandleReason`, `HandleRemember`) now validate
that the session ID maps to a real, active session owned by the calling
agent's DID. Validated at the handler level, not in `AccessPersona`,
because Brain re-signs requests and Core sees "brain" as the caller.

| Scenario | Before | After |
|----------|--------|-------|
| Fake session ID | Accepted (ask worked) | **Rejected** — 403 |
| Ended session | Accepted (ask worked) | **Rejected** — 403 |
| Wrong device's session | Accepted | **Rejected** — 403 |
| Real active session | Works | Works |

## Remaining Issue

N-057: `dina-admin device revoke nonexistent` returns 500 instead of 404.

## Cross-Session / Cross-Device Security Tests (2026-03-24)

| Test | Expected | Result |
|------|----------|--------|
| SEC-001: Session 1 + health grant → ask health | Works | PASS |
| SEC-002: Session 2 (no health grant) → ask health | Denied | PASS |
| SEC-003: Ended Session 1 → ask | Rejected | PASS |
| SEC-004: Session 2 → general data | Works | PASS |
| SEC-005: Different device uses Session 2's ID | Should fail | INCONCLUSIVE — Sancho running stale code |
| SEC-006: Approve finance on Session 2 | Works | PASS |
| SEC-007: Session 2 health=NO, finance=YES | Correct | PASS |
| SEC-008: Session list shows grants | Correct | PASS |

SEC-005 note: Sancho's Core was running code without session validation.
The test is invalid — needs both instances on the same build. Session
validation IS implemented (HandleReason/HandleRemember check at entry
point), just not deployed to Sancho yet.

## Same-Node Cross-Device Security Tests (2026-03-24)

Two agents (tok-3, tok-4) paired to the SAME Home Node (port 8100).
Agent1 gets finance grant, Agent2 tries to steal it.

| Test | Expected | Result |
|------|----------|--------|
| SEC-101: Agent1 own session + finance grant | Works | PASS |
| SEC-102: Agent2 steals Agent1's session ID | Rejected | PASS — "session not found" |
| SEC-103: Agent2 own session, no finance grant | Denied | PASS |
| SEC-104: Agent2 stores general data (own session) | Works | PASS |
| SEC-105: Agent1 reads Agent2's general data (shared vault) | Works | PASS |
| SEC-106: Agent2 remembers via Agent1's session | Rejected | PASS — "session not found" |

Key: sessions are bound to (session_id + agent_did). Two devices on the
same node cannot steal each other's sessions or grants. General vault
data is shared (both see it), but sensitive access requires per-session approval.
