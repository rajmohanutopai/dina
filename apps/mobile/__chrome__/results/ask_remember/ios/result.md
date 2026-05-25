# Scenario: ask + remember — iOS driver (`idb`)

**Date:** 2026-05-25
**Target:** iPhone 17 Pro simulator (UDID 6D57099D…), `com.dinakernel.mobile`
(Expo dev-client + Metro on :8081). Storage backend = op-sqlite/SQLCipher
(native iOS), not IndexedDB. Driven entirely via `idb ui tap/text` +
`idb screenshot` + `idb ui describe-all`.

## Result: PASS (3/3)

| Step | Input | Dina response | Pass |
|---|---|---|---|
| remember #1 | `My daughters name is Emma` | "Stored in General vault." | ✅ |
| remember #2 | `My daughter loves dinosaurs` | "Stored in General vault." | ✅ |
| ask | `What does Emma like?` | "Based on your notes, Emma loves dinosaurs." | ✅ |

The `/ask` answer confirms the full agentic path: vault recall of the two
stored memories + LLM synthesis (dev Gemini key) — matches dina_details
§13.2's expected "Emma loves dinosaurs".

## Notable finding — stale dev DB blocked boot (fixed)

First launch after pulling the identity-hub branch failed with
`[unlock] persistence init failed: … sqlite query error: no such column:
person_id`. The simulator's `Documents/*.sqlite` were created before the
contacts→person_id re-key. Per the runbook (dev data disposable;
"wipe dev DBs on sim, re-seed"), the stale `identity/general/health/work/
finance.sqlite*` + `.dina_install` marker were deleted and the app
re-onboarded fresh — after which the schema initialised cleanly and all
flows passed. This is the live confirmation of the identity-hub redesign's
"[ ] Wipe dev DBs on sim/emulator; re-seed" checklist item.

## Onboarding walked (fresh identity)

infra (test-pds/test-appview defaults) → intro → Create a new Dina →
name "Alonso" → handle (picked a free suggestion; `alonso` was taken) →
passphrase (Unlock automatically) → recovery phrase → confirm words
(#1 snack / #3 soap / #21 genre) → Chat.

## Artefacts

Screenshots `01_launch.png` … `24_ask_resp.png` in this directory. Key:
`19_remember_resp.png`, `22_remember2_stored.png`, `24_ask_resp.png`.
