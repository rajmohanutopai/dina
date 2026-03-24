# Extended Test Session Issues — 2026-03-23 Round 2

Session: ses_akopuhhwakop

---

## Issue 6: HIGH — PII tokens leak into vault data and ask responses

**Dog name replaced with Faker name:**
```
$ dina ask "What is my dogs name and breed?"
Your dog's name is Victor Davila, and he is a golden retriever.
```
Original was "Bruno". Presidio replaced it during enrichment.

**Recipe has raw PII tokens:**
```
$ dina ask "How do I make grandmas biryani?"
...grandma's <<PII:Brian Mullen MD>>>>
```
"biryani" scrubbed as a person name. Double `>>` formatting bug too.

**Root cause:** The enrichment rehydration fix (`enrichment.py`) was deployed but items ingested before the fix still have scrubbed L0/L1 in the vault. Also, Presidio is scrubbing non-PII words (biryani, Bruno, B12) — the scrubber is too aggressive.

---

## Issue 7: OK — Allergy → health → needs_approval (by design)

Working as designed. Allergies are health data → sensitive tier.

---

## Issue 8: HIGH — PII scrub over-aggressively scrubs non-PII words

```
$ dina scrub "Dr. Sharma from Mother Hospital told Raju to take vitamin B12"
scrubbed: Dr. <<PII:Brian Mullen MD>> from <<PII:Evans Ltd>> told <<PII:Jones, Torres and Mccarthy>> to take vitamin <<PII:Williams PLC>>
```
- "B12" (vitamin) scrubbed as org — not PII
- "Raju" (person) replaced with org name — type mismatch
- Faker replacement types don't match entity types

---

## Issue 9: MEDIUM — `dina-admin persona list` crashes

```
AttributeError: 'str' object has no attribute 'get'
  at dina_admin_cli/main.py:499
```
API returns list of strings, CLI expects list of dicts.

---

## Issue 10: MEDIUM — `dina-admin vault list/search` returns 400

```
$ dina-admin vault list --persona general
Error: HTTP 400: {"error":"invalid persona name"}
```
`persona-general` not accepted by Core's `NewPersonaName()`.

---

## Issue 11: LOW — Approval request spam (no dedup)

30+ approvals from a few queries. Each tool turn creates new approvals for the same (persona, session, agent).

---

## Issue 12: OK — Health/finance approval messages excellent

LLM provides the exact `dina-admin approvals approve <id>` command. Great UX.

---

## Issue 13: OK — Validate works correctly

Safe → approved. Risky → pending_approval with dashboard URL.

---

## Summary

| # | Sev | Issue | Fix |
|---|-----|-------|-----|
| 6 | HIGH | PII tokens in vault data | Enrichment rehydration + re-ingest |
| 8 | HIGH | PII scrub too aggressive | Presidio NER tuning |
| 9 | MED | persona list crashes | CLI parsing fix |
| 10 | MED | vault list/search 400 | Persona name format |
| 11 | LOW | Approval spam | Dedup on create |
