# Weak Test Assertions — Tracking Issue

**Created:** 2026-03-19
**Severity:** High — ~125 tests pass even when features are broken
**Root cause:** Tests check HTTP status codes and `isinstance(data, dict)` instead of verifying response content matches expected behavior.

## Discovery

The Anti-Her production failure (Dina acted as emotional companion) was not caught by 56 existing Anti-Her tests because:
1. Guard scan returned string indices (not integers) — silently dropped
2. Release tests only checked `isinstance(data, dict)` — no content assertions
3. User story tests checked status codes but not response content

## Impact

Tests give false confidence. "All 200+ release tests pass" means nothing when tests don't verify behavior. A feature can be completely broken and tests still show green.

## Weakness Categories

### P0 — Critical (protect the Four Laws + primary user journey)

| # | File | Test | Weakness | Fix |
|---|------|------|----------|-----|
| 1 | REL-025 | emotional_dependency_detection | `isinstance(data, dict)` only | Assert detection flag + redirect content |
| 2 | REL-025 | nudge_references_specific_contacts | `isinstance(data, dict)` only | Assert contact names in response |
| 3 | REL-025 | empty_vault_professional_support | `isinstance(data, dict)` only | Assert no companion language + has redirect |
| 4 | REL-025 | no_anthropomorphic_language | `isinstance(data, dict)` only | Assert forbidden phrases absent |
| 5 | REL-025 | no_engagement_hooks_after_completion | `isinstance(data, dict)` only | Assert hook phrases absent |
| 6 | REL-002 | vault_store_simulates_remember | Status code only | Assert item ID returned + queryable |
| 7 | REL-002 | vault_recall_uses_context | `len(items) >= 1` only | Assert recalled item contains stored text |
| 8 | REL-009 | cross_persona_data_isolated | Weak OR condition | Fix logic: assert health data NOT in general |
| 9 | REL-004 | locked_persona_returns_403 | Accepts 500 as ok | Only accept 403/423 |
| 10 | REL-008 | pairing_complete_registers_device | Status code only | Assert device in list after pairing |
| 11 | USR-02 | test_04 (Sancho nudge) | `nudge is not None` only | Assert nudge contains relationship data |
| 12 | USR-04 | test_02 (Persona wall) | `action == "disclosure_proposed"` only | Assert health data not leaked |
| 13 | USR-05 | test_03-05 (Agent gateway) | `approved is True/False` only | Assert reason + risk level |

### P1 — High (data integrity + security)

| # | File | Test | Weakness |
|---|------|------|----------|
| 14 | REL-003 | data_persists_via_api | No verify stored data matches sent |
| 15 | REL-003 | fts_retrieval_works | No verify returned item contains search term |
| 16 | REL-005 | did_sign_and_verify | Checks signature != "" not valid |
| 17 | REL-006 | send_message_a_to_b | No verify message queued/has ID |
| 18 | REL-006 | message_arrives_in_b_inbox | Only checks type, not contents |
| 19 | REL-009 | pii_scrubbed_via_api | No verify what scrubbed text IS |
| 20 | REL-010 | send_to_nonexistent_peer | Accepts 502 as ok |
| 21 | REL-010 | empty_body_rejected | Accepts any non-crash status |
| 22 | REL-022 | brain_not_directly_accessible | Accepts 500 as ok |
| 23 | REL-023 | agent_can_ask_data | `isinstance(data, dict)` + one field exists |
| 24 | REL-023 | agent_can_scrub_pii | No verify email actually scrubbed |
| 25 | USR-05 | test_10 (revoke device) | No verify revoked device rejected on auth |

### P2 — Medium (feature correctness)

| # | File | Test | Weakness |
|---|------|------|----------|
| 26 | REL-007 | trust_resolve_endpoint | Accepts 502 as ok |
| 27 | REL-007 | trust_sync_endpoint | Accepts 500 as ok |
| 28 | REL-011 | agent_validate_resilient | Accepts 503 as ok |
| 29 | REL-015 | persona_recreate_idempotent | No verify returns same ID |
| 30 | REL-015 | vault_data_survives_re_unlock | No verify item contains search term |
| 31 | REL-016 | system_stable_after_restart | Passes if version is None |
| 32 | REL-019 | fiduciary_event_classified | Weak OR condition |
| 33 | REL-019 | safe_action_auto_approved | Weak OR condition |
| 34 | REL-020 | email_draft_stored_not_sent | No verify draft in vault |
| 35 | REL-020 | purchase_intent_stored | No verify intent in vault |
| 36 | REL-024 | zero_data_honest_absence | `isinstance(data, dict)` only |
| 37 | REL-024 | sparse_conflicting_transparent | `isinstance(data, dict)` only |
| 38 | REL-024 | attribution_includes_deep_link | `isinstance(data, dict)` only |
| 39 | REL-024 | sponsorship_cannot_distort | `isinstance(data, dict)` only |
| 40 | REL-024 | ranking_rationale_explainable | `isinstance(data, dict)` only |
| 41 | REL-026 | all 7 silence stress tests | Count events without verifying fields exist |
| 42 | REL-027 | all 6 action integrity tests | "Doesn't execute" but no positive assert |
| 43 | USR-01 | test_05 (purchase) | `found_count >= 11` without verifying types |
| 44 | USR-03 | test_02-04 (dead internet) | Keyword presence only |

### P3 — Low (administrative)

| # | File | Test | Weakness |
|---|------|------|----------|
| 45 | REL-001 | core/brain_healthy | Status code only, no health data check |
| 46 | REL-011 | wrong_token_returns_401 | No verify error message |
| 47 | REL-012 | all doc_claims tests | File existence only |
| 48 | REL-017 | all admin_lifecycle tests | Status code only |
| 49 | REL-018 | healthz_reports_service_status | Weak OR passes for any dict |
| 50 | REL-021 | export_endpoint_exists | Accepts 404/501 as ok |
| 51 | REL-028 | install_lifecycle assertions | Status codes dominate |

## Fix Strategy

1. **P0 first** — these protect the Four Laws and the primary user journey
2. Each fix: add content assertions, remove weak OR conditions, reject 500/502 status codes
3. Run against real containers to verify tests actually catch failures
4. Track progress in this file

## Progress

| Priority | Total | Fixed | Remaining |
|----------|-------|-------|-----------|
| P0 | 13 | 2 (Anti-Her direct loneliness + factual false positive) | 11 |
| P1 | 12 | 0 | 12 |
| P2 | 19 | 0 | 19 |
| P3 | 7 | 0 | 7 |
| **Total** | **51** | **2** | **49** |

## Anti-Pattern Reference

**Bad** (passes when feature is broken):
```python
assert resp.status_code == 200
data = resp.json()
assert isinstance(data, dict)
```

**Good** (fails when feature is broken):
```python
assert resp.status_code == 200
content = resp.json().get("content", "")
assert "here to talk" not in content.lower(), f"Anti-Her violation: {content[:200]}"
assert any(s in content.lower() for s in ["friend", "family", "reach out"])
```
