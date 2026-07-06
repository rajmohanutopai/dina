# Home Node E2E — Detailed Test Plan

Companion to `docs/E2E_TESTING.md` (the strategy) and `implementation-notes.html`
(the running build log). This is the **scenario enumeration**: every MRS
functionality, its positive/negative/edge cases, failure modes, the layer
each is tested at, and current coverage status. Behavior source of truth:
`dina_details.md §3.1–3.9` + the Four Laws.

Legend — **Status:** ✅ implemented+green · 🟡 partial · ⛔ pending (infra).
**Layer:** L1 UI (browser now) · 2×UI (two contexts) · +agent (CLI) ·
backstage (direct-API assert) · phone (Maestro residue).

---

## MRS-01 — Remember + persona routing (§3.1) — ✅

| # | Scenario | Assertion | Layer | Status |
|---|---|---|---|---|
| 01.1 | Remember a general fact ("Emma loves dinosaurs") | routes to `general` vault | UI + backstage | ✅ |
| 01.2 | Remember a health fact ("HbA1c is 6.1") | routes to `health` (sensitive) | UI + backstage | ✅ |
| 01.3 | Remember a finance fact ("Barclays balance…") | routes to `finance` (sensitive) | UI + backstage | ✅ |
| 01.4 | Owner-in-app remembers sensitive content | **NO approval card** (deterministic) | UI | ✅ |
| 01.5 | Stored-confirmation bubble appears | a Dina `answer` row per remember | UI | ✅ |
- **Edge/failure:** async staging→drain lag (fact not queryable immediately) → polled with `waitForPersonaContaining` (F3). Empty/whitespace remember → composer send disabled (not asserted; product-guarded).
- **Not covered:** exact classifier confidence on ambiguous content (LLM-variable; asserted routing on clear content only).

## MRS-02 — Ask / recall (§3.2) — ✅

| # | Scenario | Assertion | Layer | Status |
|---|---|---|---|---|
| 02.1 | Ask recalls the general fact | judge: answer states/implies dinosaurs | UI + judge | ✅ |
| 02.2 | Ask recalls the health fact | judge: answer states 6.1 | UI + judge | ✅ |
| 02.3 | Health answer must not leak finance | judge: no bank/account detail (cross-domain) | UI + judge | ✅ |
| 02.4 | Owner-in-app Ask on sensitive data | **no lock prompt / no approval card** | UI | ✅ |
- **Edge/failure:** recall immediately after a reload is re-hydration-sensitive (F3) → durability asserts persistence deterministically instead.
- **Not covered:** multi-domain synthesis (ask spanning general+health in one answer); ask with no matching memory (graceful "I don't know").

## MRS-03 — Reminder + enrichment (§3.3) — ✅

| # | Scenario | Assertion | Layer | Status |
|---|---|---|---|---|
| 03.1 | Dated fact ("Emma's birthday Nov 7") | an enriched `reminder` card appears | UI | ✅ |
| 03.2 | The reminder is enriched, not generic | judge: references the birthday event | UI + judge | ✅ |
| 03.3 | Plain preference ("favorite color blue") | **NO reminder card** (negative) | UI | ✅ |
- **Edge/failure:** the negative case races reminder rendering → asserted after the ack lands + a settle window.
- **Not covered:** reminder from a Talk message (03 via peer, overlaps MRS-04); reminder snooze/complete actions; recurring reminders.

## MRS-13 — Durability (§7) — ✅ (reload slice)

| # | Scenario | Assertion | Layer | Status |
|---|---|---|---|---|
| 13.1 | Fact survives a browser reload | still in the Core vault after reload | UI + backstage | ✅ |
| 13.2 | Reload does not re-onboard | unlocks existing seed (no "get started") | UI | ✅ |
- **Not covered (pending):** full Core-process-restart durability (kill+reboot Core against the same vault dir — needs a process-control harness outside Playwright's webServer); Export/Import round-trip (`/v1/export`→`/v1/import`); archive excludes master seed / API keys / PDS password.

## MRS-14 — Safety invariants / log hygiene (§4.3) — ✅

| # | Scenario | Assertion | Layer | Status |
|---|---|---|---|---|
| 14.1 | Vault content never in server logs | scan core.log+brain.log for seeded tokens | backstage teardown | ✅ |
| 14.2 | Vault content never in browser console | scan console transcript | fixture teardown | ✅ |
| 14.3 | No unexpected third-party egress | all request hosts in the allowlist | fixture teardown | ✅ |
| 14.4 | Same-origin API bodies are NOT swept | (scope enforced by call sites) | design | ✅ |
| 14.5 | No approval card in any owner-in-app flow | asserted throughout MRS-01/02/03 | UI | ✅ |
- **Known allowlisted:** Core's first-boot mnemonic dev-log (open question: log a fingerprint instead); egress to plc.directory + test-grants.
- **Not covered:** the literal PDS app-password leak (shape regex removed as false-positive-prone; capture the literal from onboarding → future).

## MRS-05 — Talk safety / unknown-sender quarantine (§3.5, §3.6) — ⛔

| # | Scenario | Assertion | Layer | Status |
|---|---|---|---|---|
| 05.1 | Non-contact sends a D2D message | `quarantine` card, body HIDDEN | UI + backstage-sender | ⛔ |
| 05.2 | Add releases the held message | message posts to thread | UI | ⛔ |
| 05.3 | Block drops the message | never surfaces | UI | ⛔ |
| 05.4 | No D2D plaintext in logs | (MRS-14 sweep over the run) | teardown | ⛔ |
- **Infra needed:** a peer sender (a second node or backstage `POST /v1/msg/send`) over the relay.

## MRS-06 — Task via agent (delegation lifecycle) (§3.4) — ✅

| # | Scenario | Assertion | Layer | Status |
|---|---|---|---|---|
| 06.1 | Delegation task staged (pending_approval) | listed pending_approval (kind=delegation) | backstage | ✅ |
| 06.2 | Unclaimable before approval | agent claim → 204 | +real agent | ✅ |
| 06.3 | Owner approves → queued | pending_approval → queued | backstage owner route | ✅ |
| 06.4 | Agent claims → running | claim returns THIS task; state=running | +real agent | ✅ |
| 06.5 | Agent completes → completed | complete 200; state=completed | +real agent | ✅ |
| 06.6 | Only the holder may complete | `agentCompletionGuard` (real) | +real agent | ✅ |
- Uses a REAL paired `role='agent'` device over signed RPCs, with a scoped `runner_filter` so the claim takes only this test's task. The UI-tap approval half is F4-gated (Maestro on mobile).

## MRS-07 — Security / agent vault-read persona gate (§3.6) — ✅ (corrected after review)

| # | Scenario | Assertion | Layer | Status |
|---|---|---|---|---|
| 07.0 | Positive control (agent is authenticated) | agent 204 on `/v1/workflow/tasks/claim` | +real agent | ✅ |
| 07.1 | Agent query DEFAULT persona (general) | served (200) — gate allows a free tier | +real agent | ✅ |
| 07.2 | Agent query SENSITIVE persona (health) | agentGate → 403 `approval_required` + task | +real agent | ✅ |
| 07.3 | Owner reads the same sensitive persona | not gated (owner-vs-agent) | backstage | ✅ |
| 07.4 | Owner APPROVES → agent retry served | 403 → (grant) → 200 | +real agent | ✅ |
- **Corrected (was a false-green — review):** the earlier version probed `GET /v1/vault/list`, which isn't in the authz allowlist → a blanket fail-closed 403 for every caller (not the agent gate). The real gate is `agentGate`/`requireAgentPersonaAccess` on the agent-reachable `/v1/vault/query`. The positive control + default-served case prove the 403 is a GATE decision, not a blanket deny. Uses a REAL paired `role='agent'` device (canonical-signed → `callerType='agent'`), and now covers the full approval-unblock — the complete spec MRS-07.

## MRS-08 — Approvals / risk ladder (§3.7) — ✅ (ladder + state machine) / 🟡 (UI tap)

| # | Scenario | Assertion | Layer | Status |
|---|---|---|---|---|
| 08.1 | `search` (SAFE) | `auto_approve`, no task | backstage (real validate) | ✅ |
| 08.2 | `send_email` (MODERATE) | `flag_for_review` → pending_approval task | backstage | ✅ |
| 08.3 | `transfer_money` (HIGH) | `flag_for_review` → pending_approval task | backstage | ✅ |
| 08.4 | `read_vault` (BLOCKED) | `deny`, no task | backstage | ✅ |
| 08.5 | Owner APPROVE (HIGH) | pending_approval → queued (real owner route) | backstage | ✅ |
| 08.6 | Owner DENY (MODERATE) | pending_approval → cancelled, never queued | backstage | ✅ |
| 08.7 | Activity surface renders the inbox | Activity → Needs-action visible, no crash | UI | ✅ |
| 08.8 | Human TAP Approve/Deny on the card | card renders + tap drives the decision | UI | 🟡 F4 |
- **Deviation (X3):** the human-TAP (08.8) is blocked by F4 — the limited-mode-web inbox doesn't surface an externally-staged Core task. MRS-08 drives the owner decision through the EXACT route the tap invokes and asserts the state machine; the card-tap is covered by Maestro on the mobile full node.
- Staging via `/v1/agent/validate` is the same endpoint dina-agent uses; the gatekeeper table (already unit-tested in `packages/core`) is exercised end-to-end here through the real Core.

## MRS-04 — Talk (D2D) + enrichment (§3.5) — ⛔

| # | Scenario | Assertion | Layer | Status |
|---|---|---|---|---|
| 04.1 | Peer sends "coming tomorrow" | arrives as a `d2d-message` (verbatim) | 2×UI | ⛔ |
| 04.2 | Receiver gets an enriched reminder | judge: weaves in receiver's vault context | 2×UI + judge | ⛔ |
| 04.3 | Chit-chat peer msg | message shows, NO reminder (negative) | 2×UI | ⛔ |
- **Infra needed:** two browser contexts on two `dina-nodes` + mutual contacts + the relay.

## MRS-10 — Services, public (§3.9) — ⛔

| # | Scenario | Assertion | Layer | Status |
|---|---|---|---|---|
| 10.1 | Ask a transit question | discovers provider on AppView | UI + provider | ⛔ |
| 10.2 | Service card resolves | judge: presents an ETA | UI + judge | ⛔ |
- **Infra needed:** a provider node + `put_service_config` listing + `run_daemon.py` stub runner + the relay.

## MRS-11 — Services, known_only (§3.9) — ⛔ (harness-side)
- Grantee query resolves; non-grantee silently dropped; absent from search + getByUri. Authorization invariant, backstage on the provider.

## MRS-09 — PeerLens read (§3.8) — ✅

| # | Scenario | Assertion | Layer | Status |
|---|---|---|---|---|
| 09.1 | Network tab → Browse reviews → search a subject | resolves to results OR a clean empty state | UI | ✅ |
| 09.2 | Never a crash | known terminal UI state + no hard console error (fixture) | UI | ✅ |
- LLM-free (AppView HTTP read) → runs in the hermetic PR tier as well as live/isolated. Publish/write stays phone-only (Maestro).

## MRS-12 — Identity (§ foundational) — 🟡 / phone
- Own-identity card + modal (DID/keys) — gated on the People-screen web parity. Real `did:plc` provisioning + Bluesky login stay on the phone.

## MRS-GD-01 — Guided demo — phone (Maestro), out of the web tier.

---

## Cross-cutting scenarios

| Concern | Test | Status |
|---|---|---|
| Owner-vs-agent gate | owner-in-app never gated (01.4, 02.4); agent gated (06/07/08) | ✅ owner / ⛔ agent |
| Judge trust | calibration golden set (6 cases incl. injection) passes before judged tier | ✅ |
| Judge data-safety | `DINA_E2E_LIVE_JUDGE` opt-in; seeded data only | ✅ |
| Test isolation | per-test vault reset; state-perturbing reload test last (F3) | ✅ |
| Determinism | judge temp-0 + pinned model + confidence floor; retries:1 for transient LLM | ✅ |
| Hermetic PR tier | smoke config excludes functional + calibration | ✅ |

## Failure modes deliberately exercised
- Wrong recall answer → judge FAILs with a readable reason (verified in calibration + the reload-recall discovery).
- Prompt injection in scraped text → judge ignores it (calibration case).
- Cross-domain leak (health answer with finance) → judge FAILs.
- Vault content in logs → MRS-14 FAILs the run (verified: false-positive + mnemonic-race both found and fixed).
- Async drain lag → polled, not flaky.
- Shared-brain corruption after reload → deterministic; mitigated by ordering (F3).

## Coverage summary
- **Green now (web tier):** MRS-01, 02, 03, 13 (reload), 14; + calibration + CI + hermetic smoke.
- **Pending (relay/agent infra):** MRS-05, 06, 07, 08 (agent/quarantine), 04, 10, 11 (Talk/services), the scripted PR tier, full-restore durability, Export/Import.
- **Phone residue (Maestro):** MRS-09 publish, MRS-12 provisioning, GD-01.
