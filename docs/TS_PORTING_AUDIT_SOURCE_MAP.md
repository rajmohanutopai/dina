# TypeScript Porting Audit Source Map

This file is the starting matrix for comparing the TypeScript implementation
against the original Dina implementation.

Correctness oracle:

- Go Core: `core/`
- Python Brain: `brain/`
- Wire contracts: `api/`
- Existing TS implementation to audit: `packages/core`, `packages/brain`,
  `packages/protocol`, `apps/home-node-lite`, `apps/mobile`

This is an inventory and planning file, not a parity sign-off. A row marked
`TS counterpart visible` only means there is TS code in the same functional
area. It does not mean behavior has been proven equivalent.

## Status Legend

| Field | Meaning |
|---|---|
| `P0` | Must be correct for Lite M1-M3. User data, auth, D2D, workflow, Brain reasoning, or service network correctness depends on it. |
| `P1` | Required before broad beta/public use. Important but not necessarily blocking the first demoable Lite milestone. |
| `P2` | Operational parity, admin/deploy polish, or later migration support. |
| `TS counterpart visible` | TS files exist in the equivalent area; focused parity review is still required. |
| `TS partial or weaker` | TS files exist, but the surface looks narrower than Go/Python or is known to be milestone-limited. |
| `TS missing or unclear` | No obvious TS counterpart found during source inventory. Treat as a gap until proven otherwise. |
| `Deferred` | Keep Go/Python as oracle, but do not block early Lite milestones unless the milestone explicitly needs it. |

## Audit Fields To Maintain Per Row

When a row is audited, update these fields in-place:

| Field | Expected value |
|---|---|
| `porting_quality_status` | `not_started`, `in_progress`, `parity_pass`, `partial`, `failed`, `deferred` |
| `wire_parity` | `pass`, `partial`, `fail`, `not_applicable`, `not_checked` |
| `security_parity` | `pass`, `partial`, `fail`, `not_applicable`, `not_checked` |
| `data_migration_risk` | `none`, `low`, `medium`, `high`, `unknown` |
| `test_evidence` | Exact test file, fixture, or command proving the status. |
| `open_gaps` | Concrete behavioral gaps, not vague notes. |

## Core Source Map

| ID | Area | Priority | Go oracle files | TS areas to audit | Initial porting quality status | Main parity checks |
|---|---:|---|---|---|---|---|
| CORE-01 | API contracts and generated types | P0 | `api/core-api.yaml`, `api/brain-api.yaml`, `api/components/schemas.yaml`, `core/internal/gen/core_types.gen.go`, `core/internal/gen/brainapi/brain_types.gen.go`, `brain/src/gen/core_types.py` | `packages/protocol/src/gen`, `packages/core/src/api`, `packages/brain/src/api` | TS counterpart visible; spec-vs-runtime audit required | Field names, status codes, error keys, optional fields, snake_case/camelCase translation boundaries. |
| CORE-02 | HTTP server routing and middleware | P0 | `core/internal/adapter/server/server.go`, `core/internal/handler/*.go`, `core/internal/middleware/*.go`, `core/internal/ingress/router.go` | `packages/core/src/server`, `packages/core/src/server/routes`, `apps/home-node-lite/core-server` | TS partial or weaker; route-by-route audit required | Every Go route accounted for or explicitly descoped; auth, body limits, timeout, CORS, recovery, logging behavior. |
| CORE-03 | Identity, DID, DID document, key lifecycle | P0 | `core/internal/domain/identity.go`, `core/internal/domain/did_document.go`, `core/internal/adapter/identity/*.go`, `core/internal/handler/identity.go`, `core/internal/adapter/pds/plc_*.go` | `packages/core/src/identity`, `packages/core/src/pds`, `apps/mobile/src/services/identity_*` | TS counterpart visible; high-risk audit required | DID generation, key derivation, document shape, PLC updates, rotation, export/import, deterministic signing inputs. |
| CORE-04 | Crypto primitives and signing | P0 | `core/internal/adapter/crypto/*.go`, `core/internal/port/crypto.go`, `core/internal/adapter/auth/auth.go`, `core/internal/adapter/auth/session.go` | `packages/core/src/crypto`, `packages/core/src/auth`, `packages/protocol/src` | TS counterpart visible; cross-runtime vectors required | Ed25519, k256, nacl/sealed box, HKDF, Argon2, key wrapping, canonical request signing, nonce/timestamp validation. |
| CORE-05 | Storage, SQLCipher, migrations, DB lifecycle | P0 | `core/internal/adapter/sqlite/pool.go`, `core/internal/adapter/sqlite/schema/*.sql`, `core/internal/adapter/sqlite/*.go`, `core/cmd/dina-core/vault_*.go` | `packages/core/src/storage`, `packages/core/src/schema`, `packages/storage-node`, `packages/storage-expo` | TS counterpart visible; persistence parity unknown | Encryption-at-rest assumptions, migration ordering, transaction semantics, no-CGO behavior, crash recovery, WAL/journal behavior. |
| CORE-06 | Vault CRUD, search, tiered content | P0 | `core/internal/domain/vault.go`, `core/internal/domain/vault_limits.go`, `core/internal/service/vault.go`, `core/internal/handler/vault.go`, `core/internal/adapter/vault/vault.go`, `core/internal/adapter/sqlite/vault.go` | `packages/core/src/vault`, `packages/core/src/storage/vault_db.ts`, `packages/brain/src/vault_context` | TS counterpart visible; must audit before user-data sign-off | Store/query/delete semantics, persona isolation, tier limits, hybrid/semantic search, embeddings, locked persona access. |
| CORE-07 | PII detection, scrub, rehydrate | P0 | `core/internal/domain/pii.go`, `core/internal/handler/pii.go`, `core/internal/adapter/pii/scrubber.go`, `brain/src/adapter/scrubber_*.py`, `brain/src/service/entity_vault.py` | `packages/core/src/pii`, `packages/brain/src/pii`, `apps/mobile/__tests__/ai/pii_scrub.test.ts` | TS counterpart visible; fixture parity required | Regex/entity coverage, offsets, token numbering, allowlist behavior, rehydration, no raw PII logging. |
| CORE-08 | Pairing, devices, sessions, service keys | P0 | `core/internal/adapter/pairing/*.go`, `core/internal/handler/device.go`, `core/internal/handler/session.go`, `core/internal/adapter/servicekey/servicekey.go`, `core/internal/port/auth.go` | `packages/core/src/pairing`, `packages/core/src/devices`, `packages/core/src/session`, `packages/core/src/auth` | TS counterpart visible; route/auth parity required | Pairing ceremony, token hashing, revoke semantics, device roles, service-key authorization, replay/expiry behavior. |
| CORE-09 | D2D message envelope, gates, quarantine | P0 | `core/internal/domain/message.go`, `core/internal/service/transport.go`, `core/internal/adapter/transport/transport.go`, `core/internal/adapter/transport/rpc_decrypt.go`, `core/internal/adapter/transport/rpc_bridge.go` | `packages/core/src/d2d`, `packages/core/src/rpc`, `packages/core/src/relay`, `packages/core/src/transport` | TS counterpart visible; security parity not proven | Envelope shape, signature verification, decrypt path, SSRF restrictions, replay cache, idempotency, quarantine behavior. |
| CORE-10 | MsgBox client, outbox, websocket relay | P0 | `core/internal/adapter/transport/msgbox_client.go`, `core/internal/adapter/transport/rpc_worker_pool.go`, `core/internal/adapter/sqlite/d2d_outbox.go`, `core/internal/ingress/deaddrop.go`, `msgbox/internal/*.go` | `packages/core/src/relay`, `packages/core/src/ws`, `packages/core/src/transport/outbox.ts`, `packages/adapters-node` | TS counterpart visible; delivery parity must be proven | Connect/reconnect, ack, retries, outbox durability, dedupe, backpressure, websocket compression compatibility. |
| CORE-11 | Workflow tasks, approvals, events, sweepers | P0 | `core/internal/domain/workflow.go`, `core/internal/service/workflow.go`, `core/internal/handler/workflow.go`, `core/internal/handler/approval.go`, `core/internal/handler/task.go`, `core/internal/adapter/sqlite/workflow.go` | `packages/core/src/workflow`, `packages/core/src/approval`, `packages/brain/src/service/workflow_event_consumer.ts` | TS counterpart visible; complex/high-risk | State machine, terminal transitions, leases, expiry, approval/claim races, event delivery, task completion bridge, idempotency. |
| CORE-12 | Service config, service.query/respond, query windows | P0 | `core/internal/domain/task.go`, `core/internal/port/service.go`, `core/internal/service/service_config.go`, `core/internal/service/query_window.go`, `core/internal/handler/service_config.go`, `core/internal/handler/service_query.go`, `core/internal/handler/service_respond.go` | `packages/core/src/service`, `packages/core/src/server/routes/service_*`, `packages/brain/src/service` | TS counterpart visible; M3 blocker | Response policies, provider windows, stale schemas, service response durability, task bridging, AppView profile sync. |
| CORE-13 | Trust network, AppView resolver, PDS publish | P1 | `core/internal/domain/trust.go`, `core/internal/service/trust.go`, `core/internal/adapter/trust/*.go`, `core/internal/handler/trust.go`, `core/internal/adapter/appview/service_resolver.go`, `core/internal/adapter/pds/*.go` | `packages/core/src/trust`, `packages/core/src/appview`, `packages/core/src/pds`, `packages/brain/src/appview_client` | TS counterpart visible; M3 parity required | Trust scores, source trust, public profile publish, AppView lookup, service ranking, cache behavior, failure modes. |
| CORE-14 | Staging inbox and memory touch | P0 | `core/internal/domain/staging.go`, `core/internal/service/memory.go`, `core/internal/handler/staging.go`, `core/internal/handler/memory.go`, `core/internal/adapter/sqlite/staging_inbox.go`, `core/internal/adapter/sqlite/topic_store.go` | `packages/core/src/staging`, `packages/core/src/memory`, `packages/brain/src/staging`, `packages/brain/src/enrichment` | TS counterpart visible; M1/M4 audit required | Staging state transitions, drain loop, topic touches, persistence ordering, crash/retry behavior. |
| CORE-15 | Contacts, people, personas | P1 | `core/internal/domain/contact.go`, `core/internal/domain/person.go`, `core/internal/handler/contact.go`, `core/internal/handler/person.go`, `core/internal/handler/persona.go`, `core/internal/adapter/sqlite/contacts.go`, `core/internal/adapter/sqlite/person_store.go` | `packages/core/src/contacts`, `packages/core/src/people`, `packages/core/src/persona`, `packages/brain/src/contact`, `packages/brain/src/persona` | TS counterpart visible; check isolation and update semantics | Contact aliases, preferred-for bindings, person resolution, persona lock/tier state, update merge semantics. |
| CORE-16 | Gatekeeper, egress policy, intent policy | P0 | `core/internal/service/gatekeeper.go`, `core/internal/adapter/gatekeeper/gatekeeper.go`, `core/internal/domain/intent.go`, `core/internal/domain/actions.go`, `core/internal/port/gatekeeper.go` | `packages/core/src/gatekeeper`, `packages/brain/src/ask`, `packages/brain/src/composition` | TS counterpart visible; policy parity required | Allowed/blocked decisions, approval-needed paths, persona tier gating, sharing policy, action risk classification. |
| CORE-17 | Reminders, notifications, scheduler | P1 | `core/internal/handler/reminder.go`, `core/internal/adapter/sqlite/reminders.go`, `core/internal/port/notification.go`, `brain/src/service/reminder_planner.py`, `brain/src/service/nudge.py` | `packages/core/src/reminders`, `packages/core/src/notifications`, `packages/brain/src/pipeline/reminder_planner.ts`, `apps/mobile/src/notifications` | TS counterpart visible; integration parity needed | Reminder storage, fire timing, local notification bridge, nudge generation, duplicate prevention. |
| CORE-18 | Audit, trace, observability, metrics | P1 | `core/internal/domain/audit.go`, `core/internal/handler/audit.go`, `core/internal/handler/trace.go`, `core/internal/adapter/sqlite/audit.go`, `core/internal/adapter/sqlite/trace.go`, `brain/src/infra/trace*.py` | `packages/core/src/audit`, `packages/core/src/diagnostics`, `packages/brain/src/diagnostics`, `apps/home-node-lite/core-server` | TS counterpart visible; operational parity required | Hash chain, trace correlation, redaction, metrics shape, sync-status, health/readiness. |
| CORE-19 | Sync, living windows, multi-device | P2 | `core/internal/service/sync.go`, `core/internal/adapter/sync/sync.go`, `core/internal/port/websocket.go`, `brain/src/service/sync_engine.py` | `packages/core/src/sync`, `packages/brain/src/sync`, `apps/mobile/__tests__/sync` | TS counterpart visible; later milestone | Multi-device ordering, dedupe, living-window semantics, conflict behavior, websocket fanout. |
| CORE-20 | Export, backup, portability | P2 | `core/internal/handler/export.go`, `core/internal/adapter/identity/export.go`, `core/internal/adapter/portability/portability.go`, `core/internal/port/backup.go` | `packages/core/src/export`, `packages/core/src/identity` | TS partial or unclear; migration risk high | Archive format, key export policy, portability metadata, restore behavior, compatibility with Go vaults. |
| CORE-21 | Onboarding, bootstrap, config loading | P0 | `core/internal/service/onboarding.go`, `core/internal/adapter/onboarding/onboarding.go`, `core/internal/config/config.go`, `brain/src/infra/config.py`, `brain/src/main.py` | `packages/core/src/onboarding`, `packages/core/src/config`, `packages/brain/src/config`, `apps/mobile/src/onboarding`, `apps/mobile/src/services/bootstrap.ts` | TS counterpart visible; M1 blocker | First-run identity, vault open, default personas, env/config precedence, side effects during startup. |
| CORE-22 | Admin, CLI, well-known, deploy surfaces | P2 | `core/internal/handler/admin.go`, `core/internal/handler/wellknown.go`, `core/internal/adapter/adminproxy/adminproxy.go`, `admin-cli/src/dina_admin_cli/*.py` | `packages/core/src/cli`, `apps/home-node-lite`, `apps/mobile/app/admin.tsx` | Deferred unless needed for Lite install/admin UX | Admin route auth, sync status, CLI command parity, .well-known DID document exposure. |
| CORE-23 | Agent/task runtime control plane | P0 | `core/internal/handler/agent.go`, `core/internal/handler/task.go`, `core/internal/service/task.go`, `core/internal/adapter/taskqueue/taskqueue.go`, `core/internal/domain/task.go`, `core/internal/port/task.go` | `packages/core/src/task/queue.ts`, `packages/core/src/cli/task.ts`, `packages/brain/src/mcp/delegation.ts`, `apps/home-node-lite/core-server/src/brain/agent_gateway.ts`, `apps/home-node-lite/core-server/src/brain/agent_intent_summary.ts` | TS counterpart visible; execution-plane parity required | `/v1/agent/validate`, `/v1/task/ack`, agent-role devices, OpenClaw/task ack lifecycle, task queue ordering, validation result shape. |
| CORE-24 | Ask/remember public API orchestration | P0 | `core/internal/handler/reason.go`, `core/internal/handler/remember.go`, `core/internal/adapter/sqlite/pending_reason.go`, `core/internal/domain/pending_reason.go`, `core/internal/service/gatekeeper.go` | `packages/brain/src/ask`, `packages/brain/src/chat`, `apps/home-node-lite/core-server/src/brain/ask_pipeline.ts`, `apps/home-node-lite/core-server/src/brain/reason_handler.ts` | TS counterpart visible; route parity required | `/api/v1/ask`, `/api/v1/ask/{id}/status`, `/api/v1/remember`, `/api/v1/remember/{id}`, pending reason lifecycle, 202-vs-200 semantics. |
| CORE-25 | Intent proposals and review queue | P0 | `core/internal/handler/intent_proposal.go`, `core/internal/domain/intent.go`, `core/internal/domain/approval.go`, `brain/src/dina_brain/routes/proposals.py` | `packages/core/src/server/routes/intent.ts`, `packages/core/src/gatekeeper/intent.ts`, `packages/brain/src/ask`, `apps/home-node-lite/core-server/src/brain/review_queue.ts`, `apps/home-node-lite/core-server/src/brain/agent_intent_summary.ts` | TS counterpart visible; approval bridge audit required | `/v1/intent/proposals/{id}/{approve,deny,status}`, proposal listing, Guardian approval path, denial semantics, agent wait/poll behavior. |
| CORE-26 | Local websocket and notification push | P1 | `core/internal/adapter/ws/*.go`, `core/internal/handler/notify.go`, `core/internal/port/websocket.go`, `core/internal/port/notification.go`, `core/internal/adapter/bot/bot.go` | `packages/core/src/ws`, `packages/core/src/relay/ws_hub.ts`, `packages/core/src/notifications`, `apps/home-node-lite/core-server/src/ws`, `apps/home-node-lite/core-server/src/brain/notify_dispatcher.ts` | TS counterpart visible; channel delivery parity required | `/ws`, `/v1/notify`, heartbeat, buffering, reconnect semantics, push envelope shape, priority mapping, no cross-device leakage. |
| CORE-27 | Ingress dead-drop and locked-vault recovery | P0 | `core/internal/ingress/*.go`, `core/internal/handler/message.go`, `core/internal/adapter/vault/staging.go`, `core/internal/service/watchdog.go` | `packages/core/src/lifecycle/dead_drop_drain.ts`, `packages/core/src/d2d/receive_pipeline.ts`, `apps/home-node-lite/core-server/src/ingress/dead_drop.ts` | TS counterpart visible; locked-state safety audit required | `/msg` ingress, locked-vault dead drop, pending drain after unlock, sweeper behavior, duplicate ingress suppression, raw envelope retention/deletion. |
| CORE-28 | Runtime supervision, estate, process lifecycle | P2 | `core/internal/domain/docker.go`, `core/internal/adapter/estate/estate.go`, `core/internal/service/estate.go`, `core/internal/service/watchdog.go`, `core/entrypoint.sh`, `deploy/**` | `packages/core/src/process`, `apps/home-node-lite/core-server/src/boot.ts`, `apps/home-node-lite/core-server/src/shutdown.ts`, `apps/home-node-lite/core-server/src/crash_log.ts` | TS counterpart visible; operational parity later | Core/Brain process start/stop, watchdog restarts, estate notifications, shutdown order, crash log persistence, install/deploy assumptions. |
| CORE-29 | Unlock, passphrase, sessions, auto-lock | P0 | `core/internal/handler/session.go`, `core/internal/domain/session.go`, `core/internal/adapter/security/security.go`, `core/cmd/dina-core/vault_*.go`, `brain/src/domain/errors.py` | `packages/core/src/lifecycle/unlock.ts`, `packages/core/src/session/lifecycle.ts`, `packages/core/src/vault/lifecycle.ts`, `apps/home-node-lite/core-server/src/persona/passphrase_unlock.ts`, `apps/home-node-lite/core-server/src/persona/auto_lock.ts`, `apps/home-node-lite/core-server/src/persona/session_grants.ts` | TS counterpart visible; persona safety critical | `/unlock`, `/v1/session/*`, auto-lock TTL, sensitive-vs-locked tier behavior, agent grants, pending-unlock retry behavior. |
| CORE-30 | Dev/test-only and operator escape hatches | P2 | `core/cmd/dina-core/main.go`, `core/internal/handler/vault.go`, `core/internal/handler/reminder.go` | `apps/home-node-lite/core-server/__tests__`, `apps/home-node-lite/core-server/src/server.ts` | TS missing or unclear; should be explicitly scoped | `/v1/vault/clear`, `/v1/reminder/fire`, `/v1/test/register-service-key`, dev-only route guards, production disablement. |

## Route Groups That Must Be Covered

This route list is a second guardrail against missing functionality. It is
derived from `core/cmd/dina-core/main.go` and `brain/src/dina_brain/routes`.
Each group should either have TS parity evidence or a documented descoping
decision.

| Route group | Oracle route files | Related map IDs | Required audit result |
|---|---|---|---|
| Health, readiness, unlock, `.well-known` | `core/internal/handler/health.go`, `core/internal/handler/wellknown.go`, `core/cmd/dina-core/main.go` | `CORE-02`, `CORE-21`, `CORE-22`, `CORE-29` | Wire shape, auth bypass rules, locked-node behavior, DID document exposure. |
| D2D ingress and local message send/inbox | `core/internal/handler/message.go`, `core/internal/ingress/*.go` | `CORE-09`, `CORE-10`, `CORE-27` | `/msg`, `/v1/msg/send`, `/v1/msg/inbox`, dead-drop behavior, dedupe. |
| Vault and KV | `core/internal/handler/vault.go` | `CORE-05`, `CORE-06`, `SQL-02` | Query/store/batch/get/delete/enrich/KV semantics and errors. |
| Staging and memory | `core/internal/handler/staging.go`, `core/internal/handler/memory.go` | `CORE-14`, `SQL-07`, `BRAIN-07` | Ingest/claim/resolve/fail/extend/status, topic touch, ToC. |
| Identity and signing | `core/internal/handler/identity.go` | `CORE-03`, `CORE-04` | DID, sign, verify, document, PLC interactions. |
| PII, audit, trace | `core/internal/handler/pii.go`, `core/internal/handler/audit.go`, `core/internal/handler/trace.go` | `CORE-07`, `CORE-18`, `BRAIN-21`, `SQL-09` | Scrub/rehydrate, hash-chain, trace query, redaction. |
| Task, agent, workflow, internal callbacks | `core/internal/handler/task.go`, `core/internal/handler/agent.go`, `core/internal/handler/workflow.go` | `CORE-11`, `CORE-23`, `SQL-04` | Task ack, agent validate, claim/heartbeat/complete/fail/progress/cancel/approve, callback auth. |
| Persona, approval, sessions | `core/internal/handler/persona.go`, `core/internal/handler/approval.go`, `core/internal/handler/session.go` | `CORE-15`, `CORE-16`, `CORE-25`, `CORE-29`, `SQL-13` | Tier behavior, unlock/lock, approval routes, session grants. |
| Contacts and people | `core/internal/handler/contact.go`, `core/internal/handler/person.go` | `CORE-15`, `BRAIN-12`, `SQL-06` | Contact CRUD, aliases, policy/scenario routes, person merge/link/confirm/reject. |
| Trust and AppView | `core/internal/handler/trust.go`, `core/internal/adapter/appview/service_resolver.go` | `CORE-13`, `BRAIN-11`, `SQL-11`, `SQL-12` | Cache/stats/sync/resolve/search behavior and failure modes. |
| Pairing, devices, service agents | `core/internal/handler/device.go` | `CORE-08`, `CORE-23`, `SQL-10` | Pair initiate/complete, revoke, list devices, list service agents. |
| Service network | `core/internal/handler/service_config.go`, `core/internal/handler/service_query.go`, `core/internal/handler/service_respond.go` | `CORE-12`, `BRAIN-09`, `BRAIN-10`, `SQL-08` | Config, query, respond, query windows, schema/version checks. |
| Intent proposals | `core/internal/handler/intent_proposal.go`, `brain/src/dina_brain/routes/proposals.py` | `CORE-25`, `BRAIN-19`, `SQL-13` | Approve/deny/status/list semantics and agent polling. |
| Notify, reminders, websocket | `core/internal/handler/notify.go`, `core/internal/handler/reminder.go`, `core/internal/adapter/ws/*.go` | `CORE-17`, `CORE-26`, `SQL-10` | Notify priority, reminder store/delete/list/fire, `/ws` protocol. |
| Ask, remember, reason callback | `core/internal/handler/reason.go`, `core/internal/handler/remember.go`, `brain/src/dina_brain/routes/reason.py` | `CORE-24`, `BRAIN-08`, `BRAIN-18` | `/api/v1/ask`, `/api/v1/remember`, `/v1/reason/{id}/result`, pending reason behavior. |
| Admin, export/import, dev/test routes | `core/internal/handler/admin.go`, `core/internal/handler/export.go`, `core/cmd/dina-core/main.go` | `CORE-20`, `CORE-22`, `CORE-28`, `CORE-30` | Auth, production gating, import/export safety, sync-status shape. |
| Brain process/reason/pii/proposals | `brain/src/dina_brain/routes/*.py` | `BRAIN-01`, `BRAIN-18`, `BRAIN-19`, `BRAIN-21` | Brain API payload unions, unknown event behavior, reasoning output shape. |
| Brain admin routes | `brain/src/dina_admin/routes/*.py` | `BRAIN-17`, `BRAIN-20` | Login/session, dashboard, settings, trust, history, device pages. |

## Brain Source Map

| ID | Area | Priority | Python Brain oracle files | TS areas to audit | Initial porting quality status | Main parity checks |
|---|---:|---|---|---|---|---|
| BRAIN-01 | Brain API app and route contracts | P0 | `brain/src/dina_brain/app.py`, `brain/src/dina_brain/routes/process.py`, `brain/src/dina_brain/routes/reason.py`, `brain/src/dina_brain/routes/pii.py`, `brain/src/domain/*.py` | `packages/brain/src/api/process.ts`, `packages/brain/src/pipeline`, `apps/home-node-lite/brain-server` | TS counterpart visible; route coverage unclear | `/v1/process`, `/v1/reason`, `/v1/pii/scrub`, request/response shape, error handling, rate limiting. |
| BRAIN-02 | Core HTTP client / CoreClient boundary | P0 | `brain/src/adapter/core_http.py`, `brain/src/port/core_client.py` | `packages/core/src/client/core-client.ts`, `packages/core/src/client/http-transport.ts`, `packages/brain/src/service/*` | TS counterpart visible; migration mostly underway | Method coverage, camel/snake translation, never-call-Core-directly invariant, typed errors, retry/degradation behavior. |
| BRAIN-03 | LLM providers, router, model config | P0 | `brain/src/adapter/llm_*.py`, `brain/src/service/llm_router.py`, `brain/src/infra/model_config.py`, `brain/src/port/llm.py`, `brain/src/prompts.py` | `packages/brain/src/llm`, `apps/mobile/src/ai`, `packages/brain/src/reasoning` | TS counterpart visible; output parity hard to prove | Provider selection, local/cloud gates, streaming/non-streaming behavior, JSON extraction, prompt invariants, timeout/fallback behavior. |
| BRAIN-04 | Intent, domain, persona, tier classification | P0 | `brain/src/service/intent_classifier.py`, `brain/src/service/domain_classifier.py`, `brain/src/service/persona_selector.py`, `brain/src/service/tier_classifier.py`, `brain/src/service/sensitive_signals.py` | `packages/brain/src/routing`, `packages/brain/src/reasoning/intent_classifier.ts`, `packages/brain/src/ask/persona_gate.ts` | TS counterpart visible; classification parity requires fixture corpus | Ask/remember/task routing, sensitive data tiering, persona selection, escalation to approval, multilingual/code-mixed inputs. |
| BRAIN-05 | Guardian, notification policy, silence tiers | P1 | `brain/src/service/guardian.py`, `brain/src/service/telegram.py`, `brain/src/adapter/telegram_*.py`, `brain/src/adapter/bluesky_*.py` | `packages/brain/src/guardian`, `packages/brain/src/notifications`, `packages/brain/src/notify`, `apps/mobile/src/notifications` | TS counterpart visible; likely partial outside mobile | Notification priority, silence windows, density controls, channel fanout, service event formatting, raw PII avoidance. |
| BRAIN-06 | Vault context and memory retrieval | P0 | `brain/src/service/vault_context.py`, `brain/src/service/entity_vault.py`, `brain/src/service/scratchpad.py` | `packages/brain/src/vault_context`, `packages/brain/src/reasoning/vault_tool.ts`, `packages/core/src/vault`, `packages/core/src/scratchpad` | TS counterpart visible; M1 ask quality depends on it | Context assembly, persona lock handling, FTS/semantic/hybrid modes, scratchpad resume/checkpoint, PII entity vault. |
| BRAIN-07 | Staging processor and enrichment pipeline | P0 | `brain/src/service/staging_processor.py`, `brain/src/service/enrichment.py`, `brain/src/service/topic_extractor.py`, `brain/src/service/preference_extractor.py`, `brain/src/service/event_extractor.py`, `brain/src/service/subject_attributor.py` | `packages/brain/src/staging`, `packages/brain/src/enrichment`, `packages/brain/src/pipeline` | TS counterpart visible; parity needs event corpus | L0 deterministic enrichments, topic/preference/event extraction, sponsored processing, idempotency, write ordering. |
| BRAIN-08 | Ask/chat orchestration and command parsing | P0 | `brain/src/service/command_dispatcher.py`, `brain/src/service/user_commands.py`, `brain/src/dina_brain/routes/reason.py` | `packages/brain/src/chat`, `packages/brain/src/ask`, `packages/brain/src/composition`, `apps/mobile/src/ai/chat.ts` | TS counterpart visible; command parity required | `/ask`, remember, approvals, command aliases, response type normalization, thread persistence. |
| BRAIN-09 | Service discovery/query/provider handling | P0 | `brain/src/service/service_query.py`, `brain/src/service/service_handler.py`, `brain/src/service/service_publisher.py`, `brain/src/service/capabilities/*.py`, `brain/src/adapter/appview_client.py` | `packages/brain/src/service`, `packages/brain/src/appview_client`, `packages/brain/src/reasoning/requester_autofill.ts` | TS counterpart visible; M3 blocker | Search_public_services, param autofill, provider schema handling, service.query task delegation, result formatting, approval policy. |
| BRAIN-10 | MCP and local execution plane integration | P0 | `brain/src/adapter/mcp_http.py`, `brain/src/adapter/mcp_stdio.py`, `brain/src/port/mcp.py`, `brain/src/service/service_handler.py` | `packages/brain/src/mcp`, `packages/brain/src/reasoning/tool_registry.ts`, `packages/brain/src/reasoning/bus_driver_tools.ts` | TS counterpart visible; architecture-specific audit needed | Brain must not directly execute provider service work when OpenClaw/local execution plane is required; MCP tool invocation boundaries. |
| BRAIN-11 | Trust scoring and service ranking | P1 | `brain/src/service/trust_scorer.py`, `brain/src/service/service_query.py`, `brain/src/adapter/appview_client.py` | `packages/brain/src/trust`, `packages/brain/src/service/candidate_ranker.ts`, `packages/core/src/trust` | TS counterpart visible; ranking parity unproven | Trust tiers, distance/service-area scoring, preference reranking, unknown trust fallback. |
| BRAIN-12 | Contacts and person linking | P1 | `brain/src/service/contact_matcher.py`, `brain/src/service/person_resolver.py`, `brain/src/service/person_link_extractor.py`, `brain/src/adapter/recognizers_*.py` | `packages/brain/src/contact`, `packages/brain/src/person`, `packages/core/src/people` | TS counterpart visible; some extractors may be weaker | Alias matching, link extraction, cross-locale recognizers, person graph writes, false-positive controls. |
| BRAIN-13 | Reminders, nudges, whisper | P1 | `brain/src/service/reminder_planner.py`, `brain/src/service/nudge.py`, `brain/src/service/event_extractor.py` | `packages/brain/src/pipeline/reminder_planner.ts`, `packages/brain/src/nudge`, `packages/core/src/reminders` | TS counterpart visible; mobile tests exist but oracle parity needed | Time parsing, reminder intent, background delivery, whisper/nudge thresholds, duplicate suppression. |
| BRAIN-14 | PDS publish and AT Protocol service profile | P1 | `brain/src/adapter/pds_publisher.py`, `brain/src/service/service_publisher.py`, `core/internal/adapter/pds/*.go` | `packages/brain/src/pds`, `packages/core/src/pds`, `packages/brain/src/service/service_publisher.ts` | TS counterpart visible; schema publishing audit required | Profile record shape, capability schemas, schema hash, retries, signed publishing, AppView indexing compatibility. |
| BRAIN-15 | Crash safety, degradation, rate limits | P1 | `brain/src/infra/crash_handler.py`, `brain/src/infra/rate_limit.py`, `brain/src/infra/logging.py`, `brain/src/infra/trace_emit.py` | `packages/brain/src/crash`, `packages/brain/src/resilience`, `packages/brain/src/diagnostics`, `packages/core/src/auth/ratelimit.ts` | TS counterpart visible; operational audit required | Crash persistence, degraded-mode behavior, log redaction, trace correlation, rate limit shape. |
| BRAIN-16 | Telegram, Bluesky, channel adapters | P2 | `brain/src/adapter/telegram_bot.py`, `brain/src/adapter/telegram_channel.py`, `brain/src/adapter/bluesky_bot.py`, `brain/src/adapter/bluesky_channel.py`, `brain/src/port/channel.py` | `apps/mobile`, `packages/brain/src/notifications`, possible future channel adapters | Deferred for home-node Lite unless channel server support is required | Channel identity, parse modes, markdown/plain URL behavior, fanout, multi-channel delivery, command parity. |
| BRAIN-17 | Admin UI | P2 | `brain/src/dina_admin/app.py`, `brain/src/dina_admin/routes/*.py`, `brain/src/dina_admin/templates/*.html` | `apps/mobile/app/admin.tsx`, `apps/home-node-lite` | Deferred; not a protocol blocker | Settings, trust, history, devices, contacts admin behavior; auth/session parity. |
| BRAIN-18 | Agentic reasoning loop and tool execution | P0 | `brain/src/service/vault_context.py`, `brain/src/prompts.py`, `brain/src/domain/errors.py`, `brain/src/port/mcp.py`, `brain/src/adapter/mcp_*.py` | `packages/brain/src/reasoning/agentic_loop.ts`, `packages/brain/src/reasoning/tool_registry.ts`, `packages/brain/src/reasoning/vault_tool.ts`, `packages/brain/src/reasoning/trust_tool.ts`, `packages/brain/src/reasoning/requester_autofill.ts`, `packages/brain/src/mcp/delegation.ts` | TS counterpart visible; behavior parity hard/high-risk | Tool-call loop limits, prompt invariants, JSON parsing, tool error fallback, approval-required handling, MCP delegation failure behavior. |
| BRAIN-19 | Process/proposal event handling | P0 | `brain/src/dina_brain/routes/process.py`, `brain/src/dina_brain/routes/proposals.py`, `brain/src/domain/enums.py`, `brain/src/domain/request.py`, `brain/src/domain/response.py` | `packages/brain/src/pipeline/event_processor.ts`, `packages/brain/src/guardian/d2d_dispatcher.ts`, `packages/brain/src/service/workflow_event_consumer.ts`, `apps/home-node-lite/core-server/src/brain/review_queue.ts` | TS counterpart visible; event contract audit required | `agent_intent`, `agent_response`, `approval_needed`, `vault_unlocked`, `persona_unlocked`, unknown event behavior, polling/listing semantics. |
| BRAIN-20 | Brain auth, signing, UI auth | P0 | `brain/src/adapter/signing.py`, `brain/src/infra/config.py`, `brain/src/dina_admin/routes/login.py`, `brain/src/dina_admin/core_client.py`, `brain/src/port/core_client.py` | `packages/brain/src/auth/service_key.ts`, `packages/brain/src/auth/ui_auth.ts`, `packages/core/src/auth`, `apps/home-node-lite/core-server/src/auth` | TS counterpart visible; boundary security audit required | Service-key signing, admin/UI session auth, request header construction, key loading, caller identity propagation. |
| BRAIN-21 | PII scrubber adapters and locale recognizers | P0 | `brain/src/adapter/scrubber_presidio.py`, `brain/src/adapter/scrubber_spacy.py`, `brain/src/adapter/recognizers_eu.py`, `brain/src/adapter/recognizers_india.py`, `brain/src/port/pii.py`, `brain/src/port/scrubber.py` | `packages/core/src/pii`, `packages/brain/src/pii`, `apps/home-node-lite/core-server/src/pii*`, `apps/mobile/__tests__/ai/pii_scrub.test.ts` | TS counterpart visible; locale coverage audit required | Presidio/spaCy parity decision, India/EU recognizers, token offsets, allowlist, unsupported-locale degradation. |
| BRAIN-22 | Brain bootstrap and service wiring | P0 | `brain/src/main.py`, `brain/src/infra/config.py`, `brain/src/infra/model_config.py`, `brain/src/infra/logging.py` | `packages/brain/src/index.ts`, `packages/brain/src/config/loading.ts`, `packages/brain/src/service/service_wiring.ts`, `apps/home-node-lite/brain-server/src/boot.ts`, `apps/home-node-lite/brain-server/src/main.ts` | TS counterpart visible; integration wiring audit required | Startup order, optional adapter wiring, env var parity, provider selection, background loop startup/shutdown, failure behavior. |

## SQL And Persistent Model Source Map

SQL/schema parity is a separate audit axis. It should not be treated as part of
generic storage only, because table shape, indexes, uniqueness constraints, and
transaction semantics decide whether Lite can safely replace Go/Python without
data loss or behavioral drift.

| ID | Area | Priority | Oracle schema/model files | TS schema/model files to audit | Initial porting quality status | Main parity checks |
|---|---:|---|---|---|---|---|
| SQL-01 | Identity database schema | P0 | `core/internal/adapter/sqlite/schema/identity_001.sql`, `core/internal/adapter/sqlite/schema/identity_002_trust_cache.sql`, `core/internal/adapter/sqlite/pool.go`, `core/internal/adapter/identity/*.go` | `packages/fixtures/schema/identity_001.sql`, `packages/fixtures/schema/identity_002_trust_cache.sql`, `packages/core/src/schema/identity.ts`, `packages/core/src/storage/schemas.ts`, `packages/core/__tests__/schema/identity_schema.test.ts` | TS counterpart visible; migration safety must be proven | Table names, columns, nullability, indexes, trust-cache additions, schema version tracking, open/migrate behavior. |
| SQL-02 | Persona vault schema | P0 | `core/internal/adapter/sqlite/schema/persona_001.sql`, `core/internal/adapter/sqlite/vault.go`, `core/internal/adapter/sqlite/embedding_codec.go`, `core/internal/adapter/sqlite/hnsw_index.go` | `packages/fixtures/schema/persona_001.sql`, `packages/core/src/schema/persona.ts`, `packages/core/src/storage/vault_db.ts`, `packages/core/src/storage/schemas.ts`, `packages/core/__tests__/schema/persona_schema.test.ts` | TS counterpart visible; high data-migration risk | Vault item columns, FTS/search tables, embedding storage, tombstone/delete semantics, tier fields, persona isolation. |
| SQL-03 | Migration runner and schema versioning | P0 | `core/internal/adapter/sqlite/pool.go`, `core/internal/service/migration.go`, `core/internal/adapter/sqlite/schema/*.sql`, `core/cmd/dina-core/vault_cgo.go`, `core/cmd/dina-core/vault_nocgo.go` | `packages/core/src/storage/migration.ts`, `packages/storage-node/src/migration.ts`, `packages/core/__tests__/integration/migration.test.ts`, `packages/storage-node/__tests__/migration.test.ts` | TS counterpart visible; must audit before user migration | Idempotent migrations, partial migration recovery, transaction boundaries, SQLCipher open mode, no-CGO/dev-mode behavior. |
| SQL-04 | Workflow task/event tables | P0 | `core/internal/adapter/sqlite/workflow.go`, `core/internal/domain/workflow.go`, `core/internal/service/workflow.go` | `packages/core/src/workflow/repository.ts`, `packages/core/src/workflow/domain.ts`, `packages/core/src/storage/schemas.ts` | TS counterpart visible; complex/high-risk | State enum persistence, unique IDs, leases, expires_at, idempotency keys, terminal transition atomicity, event delivery rows. |
| SQL-05 | D2D outbox / durable transport tables | P0 | `core/internal/adapter/sqlite/d2d_outbox.go`, `core/internal/adapter/transport/*.go`, `core/internal/service/transport.go` | `packages/core/src/transport/outbox.ts`, `packages/core/src/relay`, `packages/core/src/storage/schemas.ts` | TS partial or unclear; delivery safety audit required | Outbox enqueue/ack/delete, retry timestamps, message IDs, dedupe window, crash recovery after send/complete failures. |
| SQL-06 | Contacts, people, aliases, preferred-for | P1 | `core/internal/adapter/sqlite/contacts.go`, `core/internal/adapter/sqlite/contact_aliases.go`, `core/internal/adapter/sqlite/person_store.go`, `core/internal/domain/contact.go`, `core/internal/domain/person.go` | `packages/core/src/contacts/repository.ts`, `packages/core/src/people/repository.ts`, `packages/core/src/contacts/preferred_for.ts`, `packages/core/src/storage/schemas.ts` | TS counterpart visible; semantic parity required | Contact upsert/merge, alias uniqueness, preferred-for clear-vs-omit behavior, person graph links, delete/update constraints. |
| SQL-07 | Staging inbox, topics, memory touches | P0 | `core/internal/adapter/sqlite/staging_inbox.go`, `core/internal/adapter/sqlite/topic_store.go`, `core/internal/service/memory.go`, `core/internal/domain/staging.go`, `core/internal/domain/topic.go` | `packages/core/src/staging/repository.ts`, `packages/core/src/memory/repository.ts`, `packages/core/src/storage/schemas.ts` | TS counterpart visible; M1 data-path audit required | Staging state machine persistence, heartbeat fields, topic canonicalization, memory-touch idempotency, drain ordering. |
| SQL-08 | Service config and provider schemas | P0 | `core/internal/adapter/sqlite/service_config.go`, `core/internal/service/service_config.go`, `core/internal/handler/service_config.go`, `core/internal/port/service.go` | `packages/core/src/service/service_config_repository.ts`, `packages/core/src/service/service_config.ts`, `packages/brain/src/service/capabilities/schema_validator.ts`, `apps/home-node-lite/core-server/src/appview/schema_hash.ts` | TS counterpart visible; M3 blocker | Capability schemas, response policies, schema_hash canonicalization, provider config persistence, config event channel behavior. |
| SQL-09 | Audit, trace, scratchpad, chat messages | P1 | `core/internal/adapter/sqlite/audit.go`, `core/internal/adapter/sqlite/trace.go`, `core/internal/handler/audit.go`, `core/internal/handler/trace.go`, `brain/src/service/scratchpad.py` | `packages/core/src/audit/repository.ts`, `packages/core/src/scratchpad/repository.ts`, `packages/core/src/chat/repository.ts`, `packages/core/src/storage/schemas.ts` | TS counterpart visible; operational parity required | Hash chain continuity, trace correlation IDs, scratchpad checkpoint/resume semantics, chat-thread persistence. |
| SQL-10 | Reminders, devices, notifications, KV | P1 | `core/internal/adapter/sqlite/reminders.go`, `core/internal/domain/device.go`, `core/internal/handler/reminder.go`, `core/internal/handler/device.go` | `packages/core/src/reminders/repository.ts`, `packages/core/src/devices/repository.ts`, `packages/core/src/notifications/repository.ts`, `packages/core/src/kv/repository.ts`, `packages/core/src/storage/schemas.ts` | TS counterpart visible; route parity required | Reminder due-time indexes, device revocation fields, notification delivery state, KV namespace/key constraints. |
| SQL-11 | Trust cache and trust graph | P1 | `core/internal/adapter/trust/schema.sql`, `core/internal/adapter/trust/cache.go`, `core/internal/adapter/trust/resolver.go`, `core/internal/domain/trust.go` | `packages/core/src/trust`, `packages/core/src/storage/schemas.ts` | TS partial or unclear; M3 trust audit required | Trust edge/cache tables, expiry/refresh, level mapping, resolver fallback, source-trust fields. |
| SQL-12 | AppView database schema and service discovery models | P1 | `appview/src/db/schema/*.ts`, `appview/src/db/queries/*.ts`, `appview/src/ingester/handlers/service-profile.ts`, `appview/src/api/xrpc/service-search.ts`, `appview/tests/integration/11-database-schema.test.ts` | `appview/src/db/schema/*.ts`, `packages/brain/src/appview_client`, `packages/core/src/appview`, `packages/brain/src/service/service_publisher.ts` | Existing AppView is TS; compatibility with Lite must be audited | `services` schema, capability schemas/hash fields, DID profile rows, trust graph tables, search result shape, index coverage. |
| SQL-13 | Pending reasons, approvals, scenario policy | P0 | `core/internal/adapter/sqlite/pending_reason.go`, `core/internal/adapter/sqlite/scenario_policy.go`, `core/internal/domain/pending_reason.go`, `core/internal/domain/approval.go`, `core/internal/domain/contact.go` | `packages/core/src/approval/pending_reason.ts`, `packages/core/src/approval/manager.ts`, `apps/home-node-lite/core-server/src/brain/review_queue.ts`, `packages/test-harness/src/ports.ts` | TS partial or unclear; approval safety audit required | Pending reason IDs, proposal linkage, approval scope, scenario policy uniqueness, grant/deny persistence, cleanup after resolution. |
| SQL-14 | AppView ingestion cursor, tombstones, dirty flags | P1 | `appview/src/db/schema/ingester-cursor.ts`, `appview/src/db/schema/tombstones.ts`, `appview/src/db/schema/flags.ts`, `appview/src/db/queries/dirty-flags.ts`, `appview/src/ingester/deletion-handler.ts`, `appview/tests/integration/12-dirty-flags.test.ts`, `appview/tests/integration/13-cursor-management.test.ts` | `appview/src/db/schema/*.ts`, `packages/brain/src/pds`, `packages/brain/src/service/service_publisher.ts` | Existing AppView is TS; Lite compatibility must be audited | Cursor resume, deletion/tombstone behavior, dirty flag propagation, profile republish visibility, stale AppView result handling. |

## Supporting System Source Map

These rows are not strictly Go Core or Python Brain modules, but they are part
of the production behavior that the TS home node depends on. They should be
audited because a correct Core/Brain port can still fail if MsgBox, AppView,
protocol conformance, platform adapters, or fixtures drift.

| ID | Area | Priority | Oracle/source files | TS areas to audit | Initial porting quality status | Main parity checks |
|---|---:|---|---|---|---|---|
| SUPPORT-01 | MsgBox relay service | P0 | `msgbox/cmd/dina-msgbox/main.go`, `msgbox/internal/auth.go`, `msgbox/internal/handler.go`, `msgbox/internal/hub.go`, `msgbox/internal/buffer.go`, `msgbox/internal/nonce_cache.go`, `msgbox/internal/plc_resolver.go`, `api/msgbox-api.yaml` | `packages/core/src/relay`, `packages/net-node`, `packages/net-expo`, `packages/adapters-node`, `packages/adapters-expo`, `apps/mobile/src/services/msgbox_wiring.ts` | Go MsgBox remains source; TS client compatibility must be audited | Auth headers, nonce replay, forward/buffer behavior, websocket handshake, reconnect, compression, PLC resolution, live relay vs fake relay parity. |
| SUPPORT-02 | AppView XRPC/service-discovery API | P0 | `appview/src/api/xrpc/*.ts`, `appview/src/api/middleware/swr-cache.ts`, `appview/src/web/server.ts`, `appview/tests/integration/10-api-endpoints.test.ts`, `appview/tests/unit/08-xrpc-params.test.ts` | `packages/brain/src/appview_client/http.ts`, `packages/core/src/appview/service_resolver.ts`, `packages/brain/src/service/service_query_orchestrator.ts`, `apps/home-node-lite/core-server/src/appview/*` | Existing AppView is TS; client compatibility must be audited | XRPC param names, service search result shape, cache headers/staleness, error envelopes, pagination/limits, schema/hash exposure. |
| SUPPORT-03 | AppView ingester, lexicons, record validation | P1 | `appview/src/config/lexicons.ts`, `appview/src/ingester/record-validator.ts`, `appview/src/ingester/handlers/*.ts`, `appview/src/ingester/jetstream-consumer.ts`, `appview/src/ingester/deletion-handler.ts`, `appview/tests/integration/01-ingester-handlers.test.ts`, `appview/tests/integration/05-idempotency.test.ts` | `packages/brain/src/pds/publisher.ts`, `packages/core/src/pds`, `packages/protocol/src/types/capability.ts`, `apps/home-node-lite/core-server/src/appview/schema_hash.ts` | Existing AppView is TS; producer compatibility must be audited | Lexicon field names, AT URI handling, delete/tombstone behavior, idempotent ingestion, service-profile capability schema compatibility. |
| SUPPORT-04 | AppView scorer and trust/recommendation jobs | P1 | `appview/src/scorer/algorithms/*.ts`, `appview/src/scorer/jobs/*.ts`, `appview/src/scorer/scheduler.ts`, `appview/tests/unit/01-scorer-algorithms.test.ts`, `appview/tests/integration/09-scorer-jobs.test.ts` | `packages/core/src/trust`, `packages/brain/src/trust`, `packages/brain/src/service/candidate_ranker.ts` | Existing AppView is TS; behavioral compatibility unproven | Trust score inputs/outputs, decay, Sybil/coordination detection, reviewer quality, domain scores, service/provider ranking impact. |
| SUPPORT-05 | Protocol docs, wire families, conformance suite | P0 | `proto/*.md`, `api/*.yaml`, `CAPABILITIES.md`, `packages/protocol/src`, `packages/protocol/conformance`, `packages/protocol/docs`, `packages/protocol/__tests__` | `packages/protocol`, `packages/core/src/d2d`, `packages/core/src/auth`, `packages/brain/src/service`, non-TS clients later | TS protocol package visible; must stay implementation-neutral | Canonical signing, D2D envelope, capability schema types, constants, generated API types, validators, conformance vectors usable outside TS. |
| SUPPORT-06 | Cross-runtime fixtures and oracle vectors | P0 | `packages/fixtures/**`, `brain/tests/**`, `core/internal/**/*_test.go`, `msgbox/internal/*_test.go`, `appview/tests/**`, `tests/e2e/**`, `tests/LIVE_TEST_PLAN.md` | `packages/fixtures`, `packages/protocol/conformance`, `packages/core/__tests__`, `packages/brain/__tests__`, `apps/mobile/__tests__`, `apps/home-node-lite/**/__tests__` | Fixture corpus visible; coverage completeness must be audited | Every P0 row has at least one fixture/vector/test, fixtures identify oracle source, live-vs-unit coverage separated, LLM assertions oracle-neutral. |
| SUPPORT-07 | Node/Expo platform adapters | P0 | Go/Python runtime adapters: `core/internal/adapter/crypto`, `core/internal/adapter/sqlite`, `core/internal/adapter/transport`, `brain/src/adapter/*`; TS adapter packages: `packages/*-node`, `packages/*-expo`, `packages/adapters-*` | `packages/crypto-node`, `packages/crypto-expo`, `packages/storage-node`, `packages/storage-expo`, `packages/fs-node`, `packages/fs-expo`, `packages/net-node`, `packages/net-expo`, `packages/keystore-node`, `packages/keystore-expo`, `packages/adapters-node`, `packages/adapters-expo` | TS counterpart visible; adapter parity gates required | Node vs Expo behavior, native crypto/keychain/storage differences, WebSocket compression, secure random, file permissions, keystore persistence, tree-shaking. |
| SUPPORT-08 | Mobile integration surface | P1 | `apps/mobile/src/services`, `apps/mobile/src/hooks`, `apps/mobile/src/ai`, `apps/mobile/src/notifications`, `apps/mobile/__tests__` | `apps/mobile`, shared `packages/*`, `apps/home-node-lite` | TS mobile exists; shared-package drift must be audited | Mobile/home shared package behavior, bootstrap/onboarding, D2D chat, service inbox, reminders, notification deep links, local wipe/security. |
| SUPPORT-09 | Deployment, install, perf, security checks | P2 | `deploy/**`, `docker-compose*.yml`, `core/entrypoint.sh`, `brain/Dockerfile`, `msgbox/Dockerfile`, `appview/Dockerfile`, `apps/home-node-lite/docker/**`, `docs/lite-adoption-gate.md` | `apps/home-node-lite/docker`, root package scripts, CI workflows | Deferred; required before adoption gate | Pi/VPS install, env vars, secrets, resource budgets, startup/restart, backup paths, perf probes, production route gating. |
| SUPPORT-10 | Operator tooling and admin clients | P2 | `admin-cli/src/dina_admin_cli/*.py`, `brain/src/dina_admin/**`, `apps/mobile/app/admin.tsx`, `apps/home-node-lite/*/ADMIN_GAP.md` | `apps/mobile/app/admin.tsx`, future TS admin tooling, `apps/home-node-lite` admin routes | Partial; not M1 core unless chosen as UX path | Admin auth, settings mutation, history/audit visibility, contacts/devices/trust screens, CLI command parity. |

## TS Implementation Validation Snapshot

Audit date: 2026-04-29.

Scope checked: `packages/core`, `packages/brain`, `packages/protocol`, `packages/storage-node`, `packages/storage-expo`, `apps/home-node-lite/core-server`, `apps/home-node-lite/brain-server`, and `apps/mobile`.

Evidence used:

- Shared router and route constants: `packages/core/src/server/core_server.ts`, `packages/core/src/server/routes/paths.ts`.
- Home Node Lite route and admin gap docs: `apps/home-node-lite/core-server/GAP.md`, `apps/home-node-lite/core-server/ADMIN_GAP.md`, `apps/home-node-lite/brain-server/ADMIN_GAP.md`.
- Service-network implementation: `packages/brain/src/service/service_handler.ts`, `packages/core/src/workflow/service.ts`, `packages/core/src/workflow/response_bridge_sender.ts`, `apps/home-node-lite/core-server/src/brain/service_workflow_bridge.ts`.
- SQL/model implementation: `packages/core/src/storage/schemas.ts`, `packages/core/src/storage/migration.ts`, `packages/storage-node/src/migration.ts`.
- Test inventory: `packages/core/__tests__`, `packages/brain/__tests__`, `packages/protocol/__tests__`, `packages/storage-node/__tests__`, `apps/home-node-lite/core-server/__tests__`, `apps/mobile/__tests__`.

How to read this snapshot:

| Field | Values |
|---|---|
| `Implemented` | `yes`, `partial`, `external`, `not_found`, `deferred` |
| `Parity vs oracle` | `strong`, `partial`, `not_matching`, `not_applicable`, `unproven` |
| `Mismatch class` | `none`, `miss`, `ok_divergence`, `deferred`, `unknown` |
| `TS quality / concern` | Short implementation-quality judgment from source inspection. |

Important interpretation:

- `apps/home-node-lite/core-server/GAP.md` says Python Brain primitives have TS counterparts, but that is primitive-level parity, not full HTTP/wire/data parity.
- `apps/home-node-lite/core-server/ADMIN_GAP.md` and `apps/home-node-lite/brain-server/ADMIN_GAP.md` still list pending route surfaces. Do not use primitive parity as a release sign-off.
- Mobile uses the shared packages in-process. That is an acceptable architecture difference from Go/Python HTTP sidecars, but it still needs wire-contract tests where it speaks to other Dinas.
- `SUPPORT-01` is not a MsgBox porting task. MsgBox remains the existing Go service; the Home Node Lite TS scope is only the client/relay compatibility surface used by `apps/mobile` and `apps/home-node-lite`.
- Several TS files are intentionally demo or stub surfaces (`apps/mobile/src/services/demo_bus_driver_responder.ts`, `apps/mobile/src/services/appview_stub.ts`). They should not be counted as production AppView/provider parity.

### Core Validation

| ID | Implemented | Parity vs oracle | Mismatch class | TS quality / concern |
|---|---|---|---|---|
| CORE-01 | yes | partial | miss | Generated protocol types and route contract tests exist, but runtime routes are not fully generated from OpenAPI. Keep route matrix as the authority until every handler has spec fixtures. |
| CORE-02 | partial | partial | miss | Fastify/CoreRouter composition is clean. Home Node Lite and shared router cover MVP routes only; admin gap doc confirms multiple Go routes are pending or replaced. |
| CORE-03 | partial | partial | miss | DID/key primitives and tests exist across shared core/mobile/home. HTTP wrappers for DID sign/verify/rotate are still pending in Lite admin gap. |
| CORE-04 | yes | strong | none | Crypto modules are well factored with cross-language tests. Continue requiring fixtures for every signing/canonicalization change. |
| CORE-05 | partial | partial | miss | Migration runners and schemas exist. Need explicit SQLCipher/encryption-at-rest and Go schema migration parity before real user-data migration. |
| CORE-06 | yes | partial | miss | Vault CRUD/search/tier modules and tests exist. Need final confirmation of semantic/hybrid search parity and locked-persona access behavior against Go. |
| CORE-07 | yes | partial | miss | TS PII scrub/rehydrate exists and has tests. Presidio/spaCy and India/EU recognizer parity is not proven, so full Brain PII parity remains open. |
| CORE-08 | partial | partial | ok_divergence | Pairing/device primitives exist; Lite replaces `/v1/devices` with `/v1/pair/devices`. This is acceptable if clients are updated, but not wire-identical to Go. |
| CORE-09 | yes | partial | miss | D2D envelope/gates/quarantine modules and tests exist. Live MsgBox, replay, SSRF, quarantine, and locked-vault paths need end-to-end evidence. |
| CORE-10 | partial | partial | miss | MsgBox relay/outbox clients exist. Durable delivery parity is not fully proven, and mobile/home relay code is a high-risk integration surface. |
| CORE-11 | yes | partial | miss | Workflow repository/service/bridge/sweepers exist with many tests. This remains high risk because state-machine, expiry, bridge durability, and race parity must match Go exactly. |
| CORE-12 | yes | partial | miss | Service config/query/respond and schema-aware service handling exist. Need production wiring proof for provider windows, stale schema retry, and response durability across Home Node Lite/mobile. |
| CORE-13 | partial | partial | miss | Trust/AppView/PDS clients and publisher primitives exist. Full AppView resolver, cache, trust ranking, and failure-mode parity still needs M3 integration tests. |
| CORE-14 | yes | partial | miss | Staging/memory primitives and tests exist. Need crash/retry/persistence ordering parity against Go before data-path sign-off. |
| CORE-15 | partial | partial | miss | Contacts/persona/person modules exist; people/person HTTP surface is not fully bound in Lite. Merge/link/update semantics need route-level tests. |
| CORE-16 | yes | partial | miss | Gatekeeper/intent/sharing modules exist with tests. Need approval-needed and persona-tier behavior checked against Go/Python scenarios. |
| CORE-17 | partial | partial | miss | Reminder/notification services and mobile local notification bridges exist. Server route parity and duplicate/fire timing behavior remain open. |
| CORE-18 | partial | partial | miss | Audit hash chain, metrics, trace context, and health checks exist. Full trace query, redaction, and operational metrics parity is incomplete. |
| CORE-19 | partial | partial | deferred | Sync/living-window primitives and mobile tests exist. This is later-milestone functionality and not a blocker unless multi-device Lite is in scope. |
| CORE-20 | partial | partial | deferred | Export/archive primitives exist. Restore, portability metadata, and Go vault compatibility are not release-ready yet. |
| CORE-21 | yes | partial | miss | Boot/onboarding/config modules exist for shared core, HNL, and mobile. Duplication between mobile boot and HNL boot needs consolidation checks. |
| CORE-22 | partial | partial | deferred | Admin route docs explicitly list pending/descoped surfaces. Fine for early Lite, not fine for install/admin UX sign-off. |
| CORE-23 | partial | partial | miss | Agent/task primitives and gateway exist. `/v1/task/ack`, service-agent listing, and OpenClaw lifecycle parity are still open in Lite docs. |
| CORE-24 | partial | partial | miss | Ask route exists in brain-server and shared ask modules exist. Remember/reason callback HTTP parity is not complete. |
| CORE-25 | partial | partial | miss | Intent/proposal/review primitives exist. Full approval bridge and list/status HTTP parity remains open. |
| CORE-26 | partial | partial | miss | WS notify hub and push envelope primitives exist. Need `/v1/notify`, channel buffering, and reconnect parity evidence. |
| CORE-27 | partial | partial | miss | Dead-drop and receive pipeline primitives exist. Locked-vault durable drain and raw-envelope retention/deletion must be proven. |
| CORE-28 | partial | partial | deferred | Boot/shutdown/crash/supervision primitives exist. Estate/deploy/watchdog parity is operational work, not core M1. |
| CORE-29 | partial | partial | miss | Unlock/session/autolock primitives exist. Persona HTTP routes and sensitive-vs-locked tier semantics need exact tests before safety sign-off. |
| CORE-30 | partial | unproven | miss | Some test/admin helpers exist. Need explicit production-disable guards for all dev/test-only routes before adoption. |

### Route Group Validation

| Route group | Implemented | Parity vs oracle | Mismatch class | TS quality / concern |
|---|---|---|---|---|
| Health, readiness, unlock, `.well-known` | partial | partial | miss | Health/readiness exist. `.well-known`, DID routes, and unlock/persona HTTP parity are still pending or split. |
| D2D ingress and local message send/inbox | partial | partial | ok_divergence | Shared D2D and MsgBox WS exist. Lite descopes direct `/v1/msg/*` HTTP inbox in favor of MsgBox; acceptable only if all clients use MsgBox. |
| Vault and KV | yes | partial | miss | Shared router registers vault/KV. Need Go error/edge-case fixture parity and migration proof. |
| Staging and memory | yes | partial | miss | Shared staging/memory routes and HNL memory route exist. Need crash/retry and topic touch ordering parity. |
| Identity and signing | partial | partial | miss | Primitives exist, route binding is incomplete in Lite. |
| PII, audit, trace | partial | partial | miss | PII routes exist; audit/trace are not full Go route parity yet. |
| Task, agent, workflow, internal callbacks | partial | partial | miss | Workflow routes exist in shared core. Agent/task ack and internal callback route parity remain open. |
| Persona, approval, sessions | partial | partial | miss | Primitives exist; admin gap docs still show pending HTTP surfaces. |
| Contacts and people | partial | partial | miss | Contacts route exists; people/person graph HTTP parity is incomplete. |
| Trust and AppView | partial | partial | miss | Client and publishing primitives exist; proxy/search/cache route parity needs integration tests. |
| Pairing, devices, service agents | partial | partial | ok_divergence | Pairing exists. Device route path differs in Lite; service-agent listing remains pending. |
| Service network | yes | partial | miss | Core/Brain service query flow exists. Need durable bridge and real AppView/MsgBox evidence for Lite/mobile production paths. |
| Intent proposals | partial | partial | miss | Intent validation exists; approve/deny/status/list semantics need route-level parity. |
| Notify, reminders, websocket | partial | partial | miss | Notify WS and reminder primitives exist. Route and channel-delivery parity is incomplete. |
| Ask, remember, reason callback | partial | partial | miss | Ask route exists. Remember and reason callback surfaces are incomplete. |
| Admin, export/import, dev/test routes | partial | partial | deferred | Admin/export/import are later-phase or mobile UI surfaces. Production gating still needs audit. |
| Brain process/reason/pii/proposals | partial | partial | miss | Shared Brain process modules exist, but brain-server currently exposes ask routes only. |
| Brain admin routes | partial | partial | deferred | Brain admin primitives exist; `ADMIN_GAP.md` says HTTP routes are mostly not wired. |

### Brain Validation

| ID | Implemented | Parity vs oracle | Mismatch class | TS quality / concern |
|---|---|---|---|---|
| BRAIN-01 | partial | partial | miss | Shared process API and ask route exist. Brain-server route surface is much narrower than Python Brain routes. |
| BRAIN-02 | yes | strong | none | Core client boundary is well isolated and tested, with in-process and HTTP transports. |
| BRAIN-03 | yes | partial | miss | LLM providers/router are broad and tested. Provider-specific behavior, cloud gating, and fallback policy need live/config tests. |
| BRAIN-04 | yes | partial | miss | Intent/domain/persona classification exists. Need oracle-neutral fixture corpus to control LLM variability. |
| BRAIN-05 | yes | partial | miss | Guardian/silence/notification primitives exist. Channel-specific behavior and fanout still need integration coverage. |
| BRAIN-06 | yes | partial | miss | Vault context assembler exists. Need retrieval budget, persona isolation, and PII redaction parity with Python. |
| BRAIN-07 | yes | partial | miss | Enrichment/staging primitives exist. IO half and Core staging interaction must be proven end-to-end. |
| BRAIN-08 | yes | partial | miss | Chat/ask command surfaces exist. Remember and public command parity remains incomplete. |
| BRAIN-09 | yes | partial | miss | Service query/provider orchestration exists. Direct demo/stub code must stay out of production service discovery paths. |
| BRAIN-10 | partial | partial | miss | MCP/delegation and bus driver tool tests exist. Need ensure provider execution is via local execution plane, not Brain direct execution, in production wiring. |
| BRAIN-11 | partial | partial | miss | Trust scorer/ranker primitives exist. Need AppView scorer/ranking parity and live service-search tests. |
| BRAIN-12 | yes | partial | miss | Contact/person linking primitives exist. Need route/storage merge semantics parity. |
| BRAIN-13 | yes | partial | miss | Reminder planner/nudge modules exist. Need scheduler/fire integration parity. |
| BRAIN-14 | yes | partial | miss | PDS/service profile publisher exists. Schema/hash/profile republish compatibility with AppView needs live evidence. |
| BRAIN-15 | partial | partial | miss | Crash/degradation/rate-limit modules exist. Need startup/shutdown and transient-failure behavior tests across HNL and mobile. |
| BRAIN-16 | partial | partial | ok_divergence | Mobile replaces many Telegram/server-channel needs. If server Telegram remains a requirement, this becomes a miss. |
| BRAIN-17 | partial | partial | deferred | Mobile admin UI and HNL admin primitives exist. Python admin route/template parity is not implemented. |
| BRAIN-18 | yes | partial | miss | Agentic loop/tool registry/vault/trust tools exist. Tool error fallback, approval suspension, and JSON parsing need parity fixtures. |
| BRAIN-19 | partial | partial | miss | Event processor, D2D dispatcher, workflow consumer, review queue exist. Unknown event and proposal polling semantics need route-level proof. |
| BRAIN-20 | yes | partial | miss | Service-key/UI auth modules exist. Boundary security and caller propagation need cross-service tests. |
| BRAIN-21 | partial | partial | miss | TS PII patterns/entity vault exist. Presidio/spaCy and locale recognizer parity is not complete. |
| BRAIN-22 | partial | partial | miss | Config/service wiring and HNL brain-server boot exist. Route mounting/background loop startup is still limited. |

### SQL And Persistent Model Validation

| ID | Implemented | Parity vs oracle | Mismatch class | TS quality / concern |
|---|---|---|---|---|
| SQL-01 | yes | strong | none | Identity fixture/schema tests exist. Keep Go fixture comparison mandatory for new columns. |
| SQL-02 | yes | partial | miss | Persona/vault schema exists. Embedding/HNSW/tombstone semantics and Go data migration need deeper proof. |
| SQL-03 | yes | partial | miss | Migration runners are clean and tested. SQLCipher/open mode and partial migration recovery parity remain open. |
| SQL-04 | yes | partial | miss | Workflow tables and repository exist. Race/terminal transition and bridge stash durability remain high risk. |
| SQL-05 | partial | partial | miss | Outbox code exists. Crash recovery after send/complete failures is not fully proven across mobile/HNL. |
| SQL-06 | partial | partial | miss | Contacts/people repositories exist. Alias uniqueness, preferred-for clear-vs-omit, and graph link parity need tests. |
| SQL-07 | yes | partial | miss | Staging/topic repositories exist. Drain ordering and retry persistence need parity evidence. |
| SQL-08 | yes | partial | miss | Service config/schema hash persistence exists. Full schema snapshot/version handling must stay aligned with service.query wire. |
| SQL-09 | partial | partial | miss | Audit/trace/scratchpad/chat repositories exist. Trace and scratchpad resume semantics need oracle tests. |
| SQL-10 | partial | partial | miss | Reminder/device/notification/KV repositories exist. Route integration and device revoke semantics need parity proof. |
| SQL-11 | partial | partial | miss | Trust cache modules exist. Table shape and expiry/refresh semantics need AppView integration tests. |
| SQL-12 | external | partial | miss | AppView is already TS. Lite/mobile clients still need compatibility tests for schema/hash/search result shapes. |
| SQL-13 | partial | partial | miss | Pending reason/approval/review primitives exist. Scenario policy uniqueness and cleanup semantics need parity tests. |
| SQL-14 | external | partial | miss | AppView cursor/tombstone/dirty flags exist in TS. Provider republish visibility and stale result handling need client-side tests. |

### Supporting System Validation

| ID | Implemented | Parity vs oracle | Mismatch class | TS quality / concern |
|---|---|---|---|---|
| SUPPORT-01 | external | not_applicable | none | MsgBox intentionally remains Go and is outside the Home Node Lite TS port. Audit only TS client compatibility with the existing relay: auth headers, reconnect, compression, nonce replay, and live/fake relay smoke tests. |
| SUPPORT-02 | partial | partial | miss | AppView API exists in TS and clients exist. Client compatibility with cache, error, and schema/hash fields needs tests. |
| SUPPORT-03 | partial | partial | miss | AppView ingester exists; TS producers exist. Lexicon and service-profile schema compatibility still need fixture tests. |
| SUPPORT-04 | partial | partial | miss | AppView scorer exists; TS trust/ranker clients exist. Ranking impact and trust-score semantics are unproven. |
| SUPPORT-05 | yes | strong | none | Protocol package and conformance suite are strong. Keep it implementation-neutral and required for wire changes. |
| SUPPORT-06 | yes | partial | miss | Fixture/test corpus is large. It is not yet mapped so every P0 row has explicit evidence. |
| SUPPORT-07 | partial | partial | miss | Node/Expo adapters exist. Need adapter parity gates for crypto, storage, websocket, secure random, and keystore behavior. |
| SUPPORT-08 | yes | partial | ok_divergence | Mobile is a first-class TS surface, not a direct Go/Python clone. Accept UI/runtime divergence, but shared package drift must be tested. |
| SUPPORT-09 | partial | partial | deferred | Docker/perf/security docs exist. Pi/VPS install, secrets, backup paths, and production route gating remain later-phase work. |
| SUPPORT-10 | partial | partial | deferred | Mobile admin and HNL admin docs exist. Full Python admin/CLI parity is not implemented. |

### Cross-Cutting Validation

| Area | Current TS validation | Gap classification |
|---|---|---|
| API/wire parity | Partial. Protocol/generated types exist, but not every runtime route is spec-generated or covered by route fixtures. | miss |
| Route inventory parity | Partial. Shared mobile-MVP router is broad; HNL route/admin docs show pending surfaces. | miss |
| SQL/schema parity | Partial. Schemas and migrations exist, but SQLCipher and Go-data migration parity are not complete. | miss |
| Protocol conformance parity | Strong. Protocol package and conformance tests exist. | none |
| Platform adapter parity | Partial. Node/Expo adapters exist; native behavior needs gate tests. | miss |
| Supporting service compatibility | Partial. AppView and MsgBox clients exist; live compatibility must be continuously tested. | miss |
| Fixture coverage completeness | Partial. Many tests exist, but the document still needs per-row evidence links before sign-off. | miss |
| Crypto/signature parity | Strong relative to other areas, with cross-language tests visible. | none |
| PII parity | Partial. TS path exists; locale/Presidio/spaCy parity is not complete. | miss |
| D2D/MsgBox parity | Partial and high risk. Requires fake and live relay tests. | miss |
| Workflow/approval parity | Partial and high risk. Requires race/recovery/bridge durability tests. | miss |
| Brain reasoning parity | Partial. Primitive coverage is broad; LLM behavior needs oracle-neutral fixtures. | miss |
| End-to-end parity | Partial. Mobile and BusDriver-style E2E tests exist, but Lite production path sign-off is not complete. | miss |

## Cross-Cutting Test And Evidence Map

| Area | Existing oracle evidence | TS evidence to collect | Initial status |
|---|---|---|---|
| API/wire parity | `api/*.yaml`, `core/internal/handler/*_test.go`, `brain/tests/test_api.py`, `brain/tests/test_core_client.py` | `packages/protocol/__tests__`, `packages/core/__tests__/client`, route fixture tests | Partial evidence visible; needs route matrix. |
| Route inventory parity | `core/cmd/dina-core/main.go` route registration, `brain/src/dina_brain/routes/*.py`, `brain/src/dina_admin/routes/*.py` | `packages/core/src/server/routes`, `apps/home-node-lite/*-server/src`, route fixture tests | Needs an explicit route-by-route checklist before M1 sign-off. |
| SQL/schema parity | `core/internal/adapter/sqlite/schema/*.sql`, `core/internal/adapter/sqlite/*.go`, `core/internal/adapter/trust/schema.sql`, `appview/src/db/schema/*.ts` | `packages/fixtures/schema/*.sql`, `packages/core/src/schema`, `packages/core/src/storage/schemas.ts`, migration/schema tests | Must be audited before any real user-data migration. |
| Protocol conformance parity | `proto/*.md`, `api/*.yaml`, `packages/protocol/conformance/vectors/*.json` | `packages/protocol/conformance`, generated API types, validators, cross-runtime vectors | Required before declaring third-party protocol compatibility. |
| Platform adapter parity | Go/Python concrete adapters, mobile native adapters, `packages/*-node`, `packages/*-expo` tests | Node/Expo adapter test suites and smoke tests in `apps/mobile` and `apps/home-node-lite` | Required before sharing one TS core across server and mobile. |
| Supporting service compatibility | `msgbox/internal/*_test.go`, `appview/tests/**`, live BusDriver/MsgBox/AppView runs | TS MsgBox clients, AppView clients, Lite service-discovery integration tests | Required before M3 service-network sign-off. |
| Fixture coverage completeness | `packages/fixtures/**`, `brain/tests/**`, `core/**/*_test.go`, `tests/e2e/**` | Per-row fixture/test evidence links in this document | Needs coverage matrix; no P0 row should remain evidence-free. |
| Crypto/signature parity | Go crypto adapters and auth tests, protocol docs | Cross-runtime vectors under `packages/fixtures`, protocol tests | Must be explicit before trust/D2D sign-off. |
| PII parity | `brain/tests/test_pii.py`, `core` PII tests where present | `packages/core` PII fixtures, route tests, mobile AI PII tests | Needs fixture corpus mapped back to Go/Python cases. |
| D2D/MsgBox parity | `core/internal/adapter/transport/*_test.go`, `msgbox/internal/*_test.go`, E2E tests | `packages/core/src/d2d`, `relay`, `rpc`, mobile D2D integration tests | High-risk; needs live and fake MsgBox paths. |
| Workflow/approval parity | `core/internal/handler/workflow.go`, `core/internal/adapter/sqlite/workflow.go`, recent WS2 tests/reviews | `packages/core/src/workflow`, `packages/brain/src/service/*approval*` tests | High-risk; audit terminal transitions and recovery. |
| Brain reasoning parity | `brain/tests/test_*classifier*.py`, `test_guardian.py`, `test_vault_context.py`, `test_service_query*.py` | `packages/brain/__tests__`, mobile integration tests | Needs oracle-neutral fixture corpus for LLM variability. |
| End-to-end parity | `tests/e2e`, Telegram/Telethon regressions, WS2 BusDriver demo | `apps/mobile/__tests__/integration`, future Lite E2E | Needs milestone-specific pass/fail gates. |

## Suggested Audit Order

1. `CORE-01`, `CORE-02`, `BRAIN-01`, `BRAIN-02`, `SUPPORT-05`, `SUPPORT-06`: lock route, API, protocol, and fixture boundaries first.
2. `SQL-01` through `SQL-04`: lock identity, persona, migration, and workflow schemas before deeper behavior audit.
3. `CORE-03`, `CORE-04`, `CORE-08`, `CORE-09`, `CORE-10`, `CORE-27`, `CORE-29`, `BRAIN-20`, `SUPPORT-01`, `SUPPORT-07`: prove identity, auth, D2D, locked-vault ingress, platform adapters, and transport safety.
4. `CORE-05`, `CORE-06`, `CORE-07`, `SQL-05` through `SQL-10`, `SQL-13`, `BRAIN-06`, `BRAIN-21`: prove user data and PII are safe.
5. `CORE-11`, `CORE-12`, `CORE-23` through `CORE-25`, `SQL-08`, `BRAIN-09`, `BRAIN-10`, `BRAIN-18`, `BRAIN-19`, `SUPPORT-02`, `SUPPORT-03`: prove workflow, agent, approval, AppView, and service-network behavior.
6. `BRAIN-03`, `BRAIN-04`, `BRAIN-07`, `BRAIN-08`, `BRAIN-22`: prove Brain behavior and boot wiring against fixture corpora.
7. `CORE-13` through `CORE-22`, `CORE-26`, `CORE-28`, `CORE-30`, `SQL-11`, `SQL-12`, `SQL-14`, `SUPPORT-04`, `SUPPORT-08` through `SUPPORT-10`, and `BRAIN-11` through `BRAIN-17`: finish beta/operational parity.

## Notes

- This map intentionally separates "files exist" from "parity proven".
- Go/Python behavior wins whenever TS behavior disagrees, unless the audit records
  an explicit design change and updates the oracle tests.
- Keep this file current by changing row status and evidence links as each audit
  finishes. Do not delete oracle file references just because a TS area passes;
  future regressions need the source map.
