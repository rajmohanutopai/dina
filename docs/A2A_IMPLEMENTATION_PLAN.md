# A2A: implementation plan

**Status:** In implementation. M0 was built on 2026-10-02 on top of `6a53f7e3` (`packages/a2a/`, `packages/core/src/a2a/`, the P-256 branch, `SERVICE_INDEX`); M1a (outbound, server only) and M1b (provenance, real credentials) were built and reviewed on 2026-10-03, and so was the ingress move (D2D service-query ingress now in Core). M2 (Lane 2: the gateway, Core's ingress for SendMessage, GetTask, ListTasks and CancelTask, the signed card) and its preconditions (Brain authenticates every caller; the gateway runs in its own container) were built and reviewed on 2026-10-03; M3 (streams, webhooks, push configs, the extended card) was built and reviewed on 2026-10-03 (five rounds, ending in a pass). M4 was built and reviewed on 2026-10-03 in three steps, each ending in a pass: DID credentials (four rounds), inbound multi-turn (two), and the REST binding (two). M5 (the trust-ranked directory) was built on 2026-10-03: the publisher and its state in Core (reviewed in two rounds, ending in a pass), the card key in the DID document, and AppView's directory (ingest, gates, gap generations, `searchAgents` and `getCard`). The Brain tool `search_a2a_agents` (candidates, never grants) completes M5; it was reviewed in five rounds, ending in a pass, together with the fixes from the first test-plan run. The test plan (`docs/A2A_TEST_PLAN.md`) was then written area by area, every gap in it turned into a permanent test, and the findings that run raised fixed (among them: Brain could report on an in-process inbound child; a rotated bearer left a thief's webhook running; Dina could not call another Dina's rkey-qualified skill; the owner's review showed no PeerLens evidence). On 2026-10-03 and 2026-10-04, seven rounds of dual review (Codex and Claude) and two cold audits found 23 more defects. All are fixed and tested, and an independent reviewer has checked each fix. Among them:
- an inbound round could run under the wrong listing;
- a rotated or expired credential's streams went on;
- `SendMessage` did not wait;
- a result Dina could not use after an effect began read FAILED;
- Brain could make a Dina remote run a skill the owner never bound.

Four further cold audits (a fresh Claude reviewer per slice, each finding put to a skeptic) found 16, 10, 12 and then 13 more, and fixing the last turned up one more; all are fixed and tested but one, a ListTasks cost that grows with history, left as an open question. Among them: the reference a2a-sdk signs another form of the card, a DID request signature named no audience, a re-read lowered a private read's tier, a step could stand the node down in the middle of the owner's own activation, and every inbound call that ran posted its result in the owner's chat. The owner closed the Claude cold audits after the sixth. Codex's half of the cold audits stopped at its usage limit, so a cold audit by Codex is still owed. The official A2A TCK run, the Playwright web E2E, the reference-PDS-to-Jetstream run and a phone run are owed. `implementation-notes.html` records every interpretation and departure.
**Date:** 2026-09-27; reconciled with the code at `6a53f7e3` on 2026-10-02.
**Builds:** `docs/A2A_GATEWAY_ARCHITECTURE.md` (the design, written 2026-07-30/31, commit `f0fd9fe8`). The corrections in §2–§3 below are now folded into the design body, which is the single source for *what* is built. This plan owns *order*, *size*, the open decisions (§6), and the reconciliation log (§3), which records why each design change was made.
**Spec pin:** A2A **v1.0.1** (2026-05-28; wire-identical to v1.0.0 of 2026-03-12). Normative file `specification/a2a.proto`, proto package `lf.a2a.v1`.
**Related:** `docs/AGENT_CONTROL_PLANE.md` §18, §24.8, §30.4, §31 Phase 8; `docs/UCP_UNIVERSAL_COMMERCE.md`; `docs/AP2_AGENT_PAYMENTS.md`; `docs/PLUGIN_ARCHITECTURE.md`.

---

## 1. Summary

The design stands: three lanes (outbound delegation, inbound gateway, trust-ranked directory), A2A only at the edges, D2D stays the Dina-to-Dina path, every outbound call approved by the owner, no payments over A2A. Two things have changed since it was written.

**The spec.** The design pinned "v1.0" before v1.0 shipped and guessed several details. The card path, card fields, extension shape, enum spellings and the proto path are wrong (§2). They are cheap to fix now and expensive after wire code exists.

**The code.** Most seams the design relies on still exist. Five need a changed plan (§3):

1. The service key it assigns the gateway, `m/9999'/3'/2'`, is already used by the owner-phone approval client.
2. Its migration rebuilds `workflow_tasks` to widen the `origin` check. Three tables reference `workflow_tasks` with `ON DELETE CASCADE`, so the rebuild would delete their rows.
3. It knows one execution plane (`mcpServer`). There are now four, and the plugin lane already enforces most of what the design asks of its "PEP-bound claims".
4. Its owner routes live under `/v1/a2a/*`. Owner surfaces now live under `/v1/owner/*` with a Core-served owner console.
5. Its gateway port, 8300, is taken in the managed deploy files.

A second pass against the code (2026-10-02) found more that the plan must carry (§3.17–§3.22): the phone cannot run the outbound lane yet; tasks can be created on reserved lanes; the native install gives the gateway no process isolation; an existing tool leaks PII originals into task payloads; the phone's vault reads bypass the router; and v1.0 cards have no `agentId`.

**Recommended first step:** M0 (a pure `@dina/a2a` package, no migrations, no routes, ~2 weeks), then a thin, server-only M1a (§4.2) that delivers owner-approved delegation to a remote A2A agent end to end.

---

## 2. Spec corrections (design §2 against v1.0.1)

| # | Design says | v1.0.1 says | Fix |
|---|---|---|---|
| 1 | Normative artifact `spec/a2a.proto` | `specification/a2a.proto` (`spec/` is a 404; the spec text contradicts itself) | Cite `specification/a2a.proto` |
| 2 | Card at `/.well-known/agent-card` | **`/.well-known/agent-card.json`** (spec §8.2, §14.3; JS SDK agrees) | Use `.json` |
| 3 | Card lists `agentInterfaces[]` | **`supportedInterfaces[]`**, each `{url, protocolBinding ("JSONRPC"|"GRPC"|"HTTP+JSON"), protocolVersion, tenant?}`, in preference order | Rename; `protocolVersion` moves onto each interface |
| 4 | Card fields `agentId`, `displayName`, top-level `protocolVersion` | **`name`**, `description`, `version`, `provider {url, organization}`, `documentationUrl`, `iconUrl`, `defaultInputModes[]`, `defaultOutputModes[]`; no top-level protocol version | Rewrite the card projection |
| 5 | `skills[]` = `{name, description, inputSchema}` | `AgentSkill {id, name, description, tags[] (all required), examples[], inputModes[], outputModes[], securityRequirements[]}`. **No `inputSchema`.** | Carry Dina's params schema in a Dina extension (§7.6 of the design) or skill metadata; structured input travels as a `data` Part |
| 6 | `securitySchemes[]`, `security[]` | `securitySchemes` is a **map** name → scheme; `securityRequirements[]` of `{schemes: map<string, StringList>}` | Rename and reshape |
| 7 | Top-level `extensions[]` | **`capabilities.extensions[]`** | Move |
| 8 | Extension `{uri, required, version?}` | `{uri, description, required, params}`; **no `version`**; version goes in the URI; a breaking change needs a new URI | Put the version in the Dina extension URI |
| 9 | One `signature` (JWS) | **`signatures[]`** of `{protected, signature, header?}`; JWS over the JCS (RFC 8785) canonical card, excluding `signatures` and default-valued fields; header needs `alg`, `typ` ("JOSE"), `kid`, optional `jku` | Support several signatures (key rotation); see §3.13 for the key |
| 10 | Task states `SUBMITTED`, `WORKING`, … | Wire form is ProtoJSON: **`TASK_STATE_SUBMITTED`**, `TASK_STATE_WORKING`, `TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`, **`TASK_STATE_CANCELED`** (one L), `TASK_STATE_REJECTED`, `TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_AUTH_REQUIRED`, `TASK_STATE_UNSPECIFIED`. Roles `ROLE_USER`, `ROLE_AGENT` | Update the state maps (design §7.4) |
| 11 | Push config `{url, token?, authentication?}` | `TaskPushNotificationConfig {tenant, id, taskId, url, token, authentication {scheme, credentials}}`; several per task; may be set inline on `SendMessageConfiguration`; body is a `StreamResponse`; delivery at least once | Update the outbox (design §7.5) |
| 12 | Service parameters `A2A-Version`, `A2A-Extensions` | Correct. `A2A-Version` is `Major.Minor` (e.g. `1.0`); **an empty version means 0.3**; unsupported → `VersionNotSupportedError` (-32009). `ExtensionSupportRequiredError` is -32008 | Send `A2A-Version: 1.0` always; reject empty as 0.3 unless a 0.3 interface is offered |

Confirmed correct: the three bindings with none mandatory; the eleven operations with PascalCase JSON-RPC method names (`SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`, the four push-config methods, `GetExtendedAgentCard`); `Message` and `Part` shapes (the `kind` field is gone); server-generated `taskId`; `contextId` grouping; continuation by `taskId`.

Other v1.0 facts to plan for:

- REST paths have no `/v1` prefix: `POST /message:send`, `GET /tasks/{id}`, `POST /tasks/{id}:cancel`; REST content type `application/a2a+json`. The proto says `GET /tasks/{id}:subscribe`, the prose says POST; unresolved upstream, and REST is M4 anyway.
- Multi-tenancy through `tenant`. Relevant to managed hosting (§3.14).
- OAuth: authorization code (with `pkceRequired`), client credentials, and new device code; implicit and password deprecated.
- The extended card must require authentication.
- No agent identity beyond signed cards. DID proposals are open community issues (#2259 `did:web`, #2167), not spec.

**Action:** correct design §2 and the header's spec pin in place (done alongside this plan), and re-check at M0 against the proto, as the design already requires.

---

## 3. Code reconciliation

Each row: what the design assumes, what the code does now, and the plan.

### 3.1 Gateway service key — collision

`deriveServiceKey` (`packages/core/src/crypto/slip0010.ts:271`). `SERVICE_INDEX` in `apps/home-node-lite/core-server/src/identity/derivations.ts:47` lists core = 0, brain = 1. But `apps/home-node-lite/core-server/src/approval/phone_approval_manager.ts:203` derives index **2** for the owner-phone relay client, outside the table. **Plan:** add index 2 (phone approval) to `SERVICE_INDEX`, give the gateway **index 3**, and add a test that no two users share an index.

### 3.2 `workflow_tasks.origin` — the rebuild would delete rows

`AllowedOrigins` (`workflow/domain.ts:108`) and the SQL check (`storage/schemas.ts:229`) allow `'', telegram, api, d2d, admin, system, cli, dinamobile, agent`. The design widens the check by rebuilding the table. `workflow_events` and two other tables reference `workflow_tasks` with `ON DELETE CASCADE`; foreign keys are on in both adapters (op-sqlite sets the pragma; the server adapter sets none, but `better-sqlite3-multiple-ciphers` enables foreign keys by default, confirmed 2026-10-02 by `foreign_keys = 1` on a fresh connection); and the migration runner wraps each migration in a transaction, so `PRAGMA foreign_keys = OFF` cannot be used inside it. Earlier rebuilds (v12, v13, v46, v50) were of tables with no children. **Plan:** do not rebuild. Keep the task's origin as `'api'` (inbound) or `'system'` (outbound). Mark A2A in a new `a2a_task_children` table, one row per workflow child, written with the child and kept for its life, since an operation has several children (approval, execution, one per continuation generation) and `a2a_tasks.internal_id` can hold only one (design §9). Because foreign keys are on, A2A sweeps delete child rows before the `a2a_tasks` row, in one transaction. Add a test that fails if any migration rebuilds a table that has cascading children.

### 3.3 `service_configs.revision` — still needed

No `revision` column exists (`schemas.ts:557`). Writes go through `SQLiteServiceConfigRepository` (`service/service_config_repository.ts:87`, upsert at :137), `setServiceConfig`/`setServiceConfigDurable` (`service_config.ts:163/193`) and `listing_rebind.ts`. Precedent: `plugin_installs.config_revision`, already checked by the claim guard. **Plan:** as designed, in migration v53 or later (an `ALTER TABLE … ADD COLUMN`, not a rebuild), bumped in the same transaction as every write to `config_json` (from M5 on, those writes also bump `card_projection_revision`, which M5's migration creates; M2 code never touches it). That means the repository upsert and `listing_rebind.ts:76`, which updates `config_json` directly when a plugin update changes the pinned manifest; route the rebind through the repository or bump there too. Test that a rebind voids a pinned inbound snapshot (design §9).

### 3.4 Execution planes — four, not one

`ServiceConfig` (`packages/protocol/src/types/capability.ts`) now binds a capability to one of: an `mcpServer` delegation task (any paired `agent` may claim via `runner_filter`); Tier 1 on `dina.local` (`LocalDelegationRunner`, `HttpTier1Runner`); Core reasoning (`ServiceReasoningSubmitter`); or a plugin install (`pluginInstallId`, lane `plugin:<install_id>`). The plugin lane already has the design's executor binding: `plugin_installs.device_did` (unique per active device), and `claimPluginTask` (`plugins/claim_guard.ts`) checks exact lane, install active, capability consented, device not revoked, scope hash current and config revision current, terminalising stale claims with `stale_authority`; `claim_id` is required on heartbeat, progress and complete; lease loss on an effectful task becomes `outcome_unknown`. **Plan:** inbound A2A tasks for plugin-bound capabilities go on the plugin lane unchanged. The design's `a2a_runner_bindings` applies only to `mcpServer`-bound capabilities. For D2D, a Tier 1 capability tries the reasoning submitter first and falls back to Tier 1 (`packages/core/src/service/query_ingress.ts`, `tryCreateReasoningExecution`). A2A never enters the reasoning path until an adapter exists; Core picks and freezes the A2A executor at ingress (plugin lane, bound `mcpServer` lane, or in-process Tier 1), and the same function gates projection and invocation by reference (design §7.3). The reasoning path cannot take an A2A caller today: `service_execution.ts` accepts only a `did:` requester (`a2a:<client_id>` fails at :123), stamps `ingress: 'd2d'` (:303), and may execute on a connected host through the separate reasoning routes (design §7.3).

### 3.5 Ingress validation still lives in Brain

`packages/brain/src/service/service_handler.ts` (1263 lines) checks the schema hash, validates params, branches `auto`/`review` and calls `providerIngressSubmitter` for plugin-bound capabilities. The design (A2A-I3, §7.2 step 9) wants Core to do all of it for A2A. `evaluateServiceIngressBypass` (`service/bypass.ts:189`) takes a D2D message shape. **Plan:** port validation into one Core module that both D2D and A2A call; do not write a second copy for A2A. Because this changes the live D2D path, it ships as its own change before M2, for D2D alone, with D2D parity tests (§4.2a, "Ingress move"). Doing it for D2D also removes a Brain-in-the-path check, which the sidecar rule prefers anyway. **As built (2026-10-03):** `packages/core/src/service/query_ingress.ts` (`ServiceQueryIngress`), with the params validator and the first-party capability registry moved beside it (`service/capabilities/`) and one schema-hash recipe (Core's `capabilitySchemaHash`) for every publisher and check. `@dina/home-node`'s service runtime wires it for both hosts; Brain's `ServiceHandler` is gone. M0's `a2a/normalize.ts` keeps three differences on purpose (the hash is optional for A2A, params use the strict validator, a schema that validator cannot enforce is refused) and shares the hash recipe.

### 3.6 Commerce capabilities inbound

`com.dinakernel.commerce.*` go through `provider_ingress` with Core-owned probing refusal, negotiation and order settlement. The design's "no custom Dina capabilities inbound in v1" excludes them. **Plan:** keep them excluded, and say so. Outside agents that want to buy from a Dina supplier should come through UCP (UCP doc §5), whose checkout model matches what outside agents expect.

### 3.7 Consent cards

`CORE_MINTED_PAYLOAD_TYPES` (`server/routes/workflow.ts:1265`) now exists: Brain may not create (400 `reserved_payload_type`) or decide (403) those card types. Hooks are composed through `WorkflowServiceOptions` (`approvalDecisionHandler`, `responseEgressGate`, `ingressResultTransformer`, `pluginCompletionHandler`). **Plan:** add `a2a_delegation_consent` to the set; decide it through an `approvalDecisionHandler`, which runs after the approval commits and swallows its own errors (`workflow/service.ts:601-646`), so the permit mint is an idempotent step keyed by the approval (a UNIQUE index on `a2a_permits.approval_task_id` over outbound permits in every state, so a voided outbound permit is never replaced; inbound permits are keyed per execution child, so a `review` continuation still mints one fresh permit per generation, design §7.7, §9), run by the handler and re-run by a Core sweeper over committed `approved` events whose approval has no permit in any state and whose operation is not terminal (design §6.2 step 6); contribute A2A's hooks through `composeWorkflowHooks`. Templates: `coordination/disclosure_egress.ts` (a card that is a decision, with release rebuilt from the stored result) and `agent/coding_permit.ts` (payload-hash-bound single-use permits). Render the card in the owner console's `approvalCard()` (`owner_console.ts:818`), mobile, and phone approval sync.

### 3.8 Owner routes

Owner calls are `callerType === 'owner'` plus `x-dina-owner-capability` (`routes/owner_guard.ts`). Owner setup lives under `/v1/owner/setup/*`, and the console is Core-served. **Plan:** move the design's `/v1/a2a/clients|remote-agents|directory-listing|publisher/*` to **`/v1/owner/a2a/*`**, with console panels. Route constants in `server/routes/paths.ts`; Brain calls through new `CoreClient` methods.

### 3.9 Credentials for remote agents

There is no provider-key store in Core. Brain's `llm/provider_config.ts` holds LLM keys at the wrong tier. The nearest real store is commerce's (`commerce/credential_store.ts`, table `commerce_credentials`, released only through `useSecret`, plus `credential_broker.ts` leases), but it treats rotation as a replace, while the design wants immutable, versioned `credential_ref`s. **Plan:** a new `a2a_remote_credentials` table as designed, reusing the broker's lease and `useSecret` pattern. M1a needs only the `none` kind.

### 3.10 Outbound network policy

`transport/ssrf.ts` checks URLs only. The commerce feed path (`commerce/catalog_feed_policy.ts`, `fetchUnderPolicy` at `catalog_ingest.ts:152`, the host transport `core-server/src/commerce/connector_transport.ts`) does not meet design §6.6: its transport sends only bodiless `GET`s, `fetchUnderPolicy` follows up to three redirects, the caps are the catalog feed's, public literal IPs pass, and the connected address is checked only after the request has gone. **Plan:** M1a builds an A2A host transport: `POST` with a JSON body, resolve and refuse blocked or literal addresses before connecting, connect to the vetted address with TLS/SNI/`Host` checked against the original name, no redirects, A2A caps, JSON only. `isBlockedAddress` is reused; the rest is new (design §6.6). Tests prove a forbidden destination receives no connection.

### 3.11 Result guard

Brain's guard scan is a fail-open post-processor; nothing scans tool results for injected instructions. **Plan:** model the Core side of the guard job on `run/classification.ts` (a Core-owned, lease-checked queue with an encrypted, shreddable payload store), but **fail closed**: a result the guard did not clear is never released. The Brain side has no precedent to reuse: the run plane's Brain classify worker was never built, and its classify jobs end on their 15 s timeout today. The guard worker is new code, and it needs a configured LLM; with none, results stay held and the owner gets one plain notice saying why (design §6.5).

### 3.12 PII and audit

`core/pii/{patterns,scrub}.ts` already serve both halves; drop the design's "new shared PII patterns" item. Audit (`audit/service.ts`, hash chain) is fine as is.

### 3.13 Card signing and JWS

No JWS code exists; JCS-style canonical JSON exists (`packages/protocol/src/plugins/digests.ts:58`, `packages/commerce-protocol/src/canonical.ts:25`). `commerce/held_evidence_verifier.ts` handles `#dina_signing` rotation and is reusable. **Plan:** sign cards with **ES256** from the P-256 branch `m/9999'/5'/{generation}'` proposed in the AP2 doc §6.1 (one key for A2A cards, UCP request signatures and AP2), because ES256 is what verifiers everywhere accept. Publish its JWK set (`jku`). JWS and JCS helpers go in `@dina/a2a` so AppView verifies with the same code.

### 3.14 Ports, hosting, tenants

Port 8300 is `GRANTS_PORT` in `deploy/managed/infra/docker-compose.infra.yml` and core's port in `deploy/managed/docker-compose.prod.yml`. Managed multi-tenant hosting (`packages/managed-runtime`, `deploy/managed`) is new and the design does not address it. **Plan:** pick a free gateway port (not 8300) and record it in one config place. For managed hosting, one gateway serving many tenants through A2A's `tenant` field fits best; design it in M2, do not assume one gateway per node.

### 3.15 Lane 3 publishing and AppView

- `PDSPublisher` (`packages/brain/src/pds/publisher.ts`) now supports `swapRecord` on `putRecord` and returns CIDs from `getRecord`; it has no `swapCommit` or `getLatestCommit`, and `deleteRecord` has no swap. **Plan:** reuse the commerce epoch service's structure for the publisher (`packages/home-node/src/commerce_epoch.ts`, `CommerceEpochService`, `isCommerceRestorePending`: a bounded CAS loop, fail-closed, restore marker, already tested against two restores of one backup). `swapRecord` alone is not enough: it guards one record, and design §8.2 must bind the fence and the card, two records, in one check. So the PDS client also gains `getLatestCommit` and a `swapCommit` parameter on put and delete, as design §8.2 requires.
- AppView's `handleIdentityEvent` (`appview/src/ingester/jetstream-consumer.ts:724`) only logs; the design assumed AppView refreshes DID documents. **Plan:** add real identity-event handling in M5, scoped to card holders first.
- AppView is now a workspace package that depends on `@dina/commerce-protocol`. **Plan:** make `@dina/a2a` a normal dependency instead of the design's byte-copied file. Copy the commerce catalog ingest shape (pure decision module, thin handler).
- Unchanged and as designed: the global `trust_v1_enabled` gate runs before every record (A2A must route around it), `RecordOp` has no `rev`, the existing spool is lossy.

### 3.16 Numbering

Next identity migration: **v53** (v51 `commerce_tender_not_asked` and v52 `listed_from_json` shipped in `85a41b79`). Next AppView Drizzle migration: **0025**. Re-check both at M1a; commerce work keeps adding migrations.

### 3.17 Reserved lanes at creation

The claim route guards `dina.local` and `plugin:*`, but `POST /v1/workflow/tasks` (`createTask`, `server/routes/workflow.ts` ~352) accepts any `requested_runner`, and the plugin claim guard checks provenance only for grant-backed tasks, so a signed Brain can queue a task on a reserved lane. Brain's `ServiceHandler` used to create Tier 1 tasks on `dina.local` through that route. **Plan:** in M1a, `createTask` refuses `plugin:*` and `a2a:*` from every caller (Core's producers use the workflow service directly); `dina.local` follows once the ingress move ships. **Done:** since the ingress move, `createTask` refuses all three; Core's ingress fills `dina.local` through the workflow service. Design §6.3.

### 3.18 Process isolation for the gateway

The design's gateway compromise model assumes a separate OS identity with no keys. The CLI's native supervisor starts Core and Brain as one user with one environment (`cli/src/dina_cli/home_node_supervisor.py:161`); Core→Brain calls are unsigned; brain-server's `POST /api/v1/ask` and `POST /api/v1/ask/:id/approve` (`apps/home-node-lite/brain-server/src/routes/ask.ts:119`) authenticate no caller and take `requesterDid` from the body. **Plan:** M2 opens no public port until the gateway runs under its own user or container and Brain's loopback routes authenticate their caller. Design §4.1. **Done (2026-10-03):** Brain serves signed callers only (Core under its service key, the owner's paired devices, learnt from Core); Core signs its five Brain calls; the web app signs with the owner device, its event streams included; `/ask` takes the requester from the verified caller. The lite compose file runs the gateway in its own container on a network only Core shares. A native install that runs the gateway as Core's user still does not meet the precondition.

### 3.19 PII originals in task payloads

`delegate_to_agent` stores raw entities in `payload._pii_entities` (`packages/brain/src/reasoning/delegate_agent_tool.ts:140`), and Core returns that payload to whichever agent claims the task. **Plan:** the A2A proposal path never copies this; a contract test asserts no original rides in any A2A task, permit, snapshot or runner request. Remote agents get placeholders; whether the owner may release a real value is D7. Design §6.2 step 3. (Fixing `delegate_to_agent` itself is outside this plan.)

### 3.20 The phone cannot run Lane 1 yet

Two reasons. The phone's fetch can neither resolve and pin an address before connecting nor report the address it connected to, so it cannot apply the §3.10 policy (the same reason it runs no networked commerce connectors, `apps/mobile/src/storage/init.ts:423`). And it suspends its relay when backgrounded (`apps/mobile/src/hooks/useRelayWake.ts`), so a runner polling `GetTask` would stall. **Plan:** M1a is server-only; the paired phone renders and decides the cards. Phone Lane 1 waits for a mobile transport that can satisfy §3.10 (D6). Design §1.3.

### 3.21 Disclosure recording on the phone

The design records disclosures at Core's vault-read dispatch layer. On the phone, Brain reads the vault through direct `@dina/core` calls (`packages/brain/src/vault_context/assembly.ts:277` calls `queryVault`) that never pass through `CoreRouter`. **Plan:** M1b records in the vault read functions themselves (`packages/core/src/vault/crud.ts`) with the release context passed down. M1a has no log at all, so it labels every payload *unverified, may contain sensitive data* and the owner's reading is the only check (D1). Design §4.2, §6.2.

### 3.22 Card identity and signing key

v1.0 cards have no `agentId` and skills have no input schema (§2 rows 4–5), but design §7.1 and §8.3 still keyed card identity on `agentId` and signed with `dina_signing`. **Plan:** the node's `did:plc` and the per-skill params schemas ride the Dina extension's `params`; cards are signed with the D4 key (recommended ES256 from `m/9999'/5'`, its public key published as a verification method in the DID document so AppView verifies with no extra fetch; confirmed at M0: did:plc v0.1 accepts any syntactically valid `did:key` in `verificationMethods`). The directory envelope and fence stay Ed25519 under `dina_signing`. Design §7.1, §7.6, §8.3.

---

## 4. Milestones, revised

Sizes are rough, for one engineer who knows the codebase, and exclude review rounds.

### 4.1 M0 — the pure package (~2 weeks)

No migrations, no routes, no network.

- `packages/a2a/` (`@dina/a2a`), copying the scaffolding and the dependency-hygiene test of `packages/commerce-protocol`: v1.0 types from `specification/a2a.proto`, JSON-RPC envelope parse and validate, error codes, both state maps (§2 row 10), card projection and pin (§2 rows 3–9), JWS/JCS sign and verify (injected ES256 functions, keeping the package dependency-free), `directory_envelope.ts`, golden vectors.
- `packages/core/src/a2a/`: `action_registry.ts` on `ActionClass` and `PLUGIN_ACTION_FLOORS` (`payment` always denied), skill-binding validator, `normalize.ts`, `dispatch_binding.ts`, the default result schema with its hash pinned.
- P-256 derivation at `m/9999'/5'/{generation}'` in `slip0010.ts` with a frozen vector (shared with the UCP and AP2 work), if D4 is accepted.
- `SERVICE_INDEX` lists phone approval (2) and gateway (3), with a test that no two users share an index (§3.1).
- Dropped from the design's M0: shared PII patterns (exist).

### 4.2 M1a — owner-approved delegation, thin, server only (~4–5 weeks)

A person asks Dina to have a remote A2A agent do something; Dina shows exactly what it will send; the owner approves; the result comes back scanned and quarantined. The server node runs the lane; the owner answers on the server's console or the paired phone (§3.20). The full test inventory is design §12 (M1a).

- Migration v53: `a2a_remote_agents`, `a2a_skill_bindings`, `a2a_remote_credentials` (`none` kind only), `a2a_tasks` (with `status_updated_at`), `a2a_task_children`, `a2a_permits`, `a2a_guard_jobs`, `a2a_cancel_requests` (claim-independent cancellation is in M1a). No `workflow_tasks` change (§3.2), no `service_configs` change.
- The A2A host transport (§3.10). This is new work, so M1a grows from ~3–4 to ~4–5 weeks (a rough guess).
- Owner registration under `/v1/owner/a2a/remote-agents`: fetch the card under the network policy, verify signatures when present, pin its hash; bind skills.
- Brain tool `delegate_to_a2a_agent` → Core proposal route → Core-minted consent card showing the exact outgoing message (PII scrubbed; the remote agent gets placeholders, D7) and labelling it *unverified, may contain sensitive data* (§3.21) → single-use permit bound to the payload hash. No original rides in any task, permit, snapshot or runner request (§3.19).
- Reserved `a2a:` lanes beside the `dina.local` and `plugin:*` claim guards (`workflow.ts`, `claimTask`), and `createTask` refusing `plugin:*` and `a2a:*` (§3.17).
- A host runner in `packages/home-node` sending `SendMessage` and polling `GetTask` through the A2A host transport (§3.10, design §6.6); `TASK_STATE_INPUT_REQUIRED` fails as `remote_needs_input` (design §6.4).
- Results: sanitize → validate against the skill's result schema → quarantine → fail-closed guard job → receipt → release to Brain. The Brain guard worker is new code; with no LLM configured, results stay held and the owner is told why (§3.11).
- Tests against an a2a-sdk (Python) reference agent, including one that answers `SendMessage` with a bare `Message` (design §6.4); plus the consent-card fence, the approval-to-permit crash cases, and the no-connection SSRF cases (design §12, M1a). (The `a2a-tck` kit tests servers only; it has no client checks, so it starts at M2.)

**M1a versus M1b (D1, now in the design):** the original M1 also built the disclosure log, per-turn utterance digests and per-span entity provenance, so Core could prove which vault reads fed an outgoing message. None of that exists today (vault reads take `session_id` only on the agent path). M1a relies instead on the owner seeing and approving the exact outgoing text every time, with every payload labelled unverified. **M1b** (~3–4 weeks) adds the provenance machinery, recording disclosures in the vault read functions so the phone's direct reads are covered (§3.21), before any auto-approved outbound lane (design §13 Q6) is considered. Design §12 now splits M1 this way; if the owner rejects D1, M1a and M1b merge back into one M1.

### 4.2a Ingress move (before M2; ~3–4 weeks, a rough guess)

Move service-query ingress validation, hashing, `auto`/`review` branching and child minting from Brain's `ServiceHandler` into one Core module, for D2D alone (§3.5). Done when D2D parity tests show identical outcomes for every existing service-query case and Brain no longer creates D2D service tasks; the create route can then refuse `dina.local` (§3.17). It touches live traffic, so it ships and settles on its own before M2 starts. **Built 2026-10-03.** Parity: Brain's 73 handler cases run against Core with every assertion unchanged, and 50,000 generated cases gave identical creates, cancels, replies, notices, submitter calls and log lines from both before Brain's copy was deleted. The one difference is recorded: a failed create is logged where Brain's handler threw it, and the requester sees nothing in both cases.

### 4.3 M2 — inbound gateway (~6–8 weeks, after the ingress move)

**Preconditions (§3.18):** the gateway runs under its own OS user or container with no access to Core's files, and Brain's loopback routes authenticate their caller. Neither exists today; size them with M2.

- Gateway process (`apps/home-node-lite/a2a-gateway/`) on a free port, service key index 3, mounting the JS SDK's framework-free `DefaultRequestHandler` / `JsonRpcTransportHandler` on Fastify (the SDK ships only an Express adapter).
- Public card at `/.well-known/agent-card.json`, projected from `surface: 'services'` listings with pinned schema pairs; commerce excluded (§3.6).
- Client registration and bearer auth under `/v1/owner/a2a/clients`; grants as `service_grants` with `grantee_did = 'a2a:<client_id>'` (no schema change; the column has no check).
- `SendMessage`, `GetTask`, `ListTasks`, `CancelTask`.
- A2A calls the Core ingress module the ingress move built (§4.2a); M2 adds only the A2A envelope and access-mode rules on top.
- `service_configs.revision` (§3.3); execution through the existing planes (§3.4).
- An A2A direction in the response bridge (`workflow/response_bridge_sender.ts` produces only D2D today).
- Rate-limit exemption for the gateway's signed calls into Core.

**As built (2026-10-03):** the gateway (`apps/home-node-lite/a2a-gateway/`, port 8400, loopback by default) carries bytes and decides nothing: it routes by the method→route table in `@dina/a2a` and forwards the raw body and the client's bearer, signed with its own random service key (Core learns its did:key; index 3 stays reserved). Core parses, binds the route to the signed body, and writes every JSON-RPC answer (`packages/core/src/a2a/inbound.ts`); the JS SDK's handler is not used (a second interpreter in front of Core's receipts and binding). Core exempts the gateway's routes from its per-address limiter and the gateway's DID from its per-DID bucket; per-client budgets do the limiting. The card is projected with invocation's own functions and signed ES256 with the D4 key, its key set at the gateway's `jku` (the DID document waits for M5). ListTasks refuses a `status` filter. `implementation-notes.html` has the full list.

### 4.4 M3 — streaming and push (~2–3 weeks)

Push outbox with claim/ack, SSE for `SendStreamingMessage`/`SubscribeToTask`, webhooks with the v1.0 config shape (§2 row 11), extended card behind authentication.

**As built (2026-10-03):** Core records each change a client can see once, inside the transaction that made it (`packages/core/src/a2a/delivery.ts`, migration v57), as outbox rows per target: the task's streams and each webhook config. The workflow repository tells A2A of a requeue through a hook, no longer through A2A SQL of its own. The gateway claims due rows (`POST /v1/a2a/ingress/events/claim`, a POST because a claim leases rows), fans stream events out from its hub, and POSTs webhooks through the host transport, now in `@dina/net-node` so Lane 1 and the gateway share it, in a status-only mode. Every claim re-checks the client's authority and suppresses a revoked task's events. Streaming calls open from Core's Task and an event cursor (`x-dina-a2a-event-seq`). The extended card is the public projection with an audience: the public skills in scope, plus those live grants open on unlisted and known_only listings. All eleven methods are served, and the card's flags are true. `implementation-notes.html` has the decisions, departures and open questions.

### 4.5 M4 — DID auth, multi-turn, REST (~3–4 weeks)

As designed, with REST on v1.0 paths (§2). Watch the open DID proposals; Dina's DID challenge is an extension, not the spec.

**As built (2026-10-03):**
- **DID credentials.** The owner names a DID when issuing a challenge; the client signs it with that DID's key, and the binding needs no other credential. Keys are read from `authentication`, or, in a document with none (every did:plc document), from its Ed25519 verification methods. Requests are checked against the bound key, with spent nonces kept on disk per DID. The A2A runner looks bound DIDs up again every 10 minutes and suspends a client whose key left its document or whose DID was deactivated (410), never one whose directory is down.
- **Inbound multi-turn.** A runner holding a round's claim asks with a prompt and an object schema. Core parks the round and voids its permit; the caller sees INPUT_REQUIRED. A SendMessage naming the task answers it and runs the next round with every answer so far, under a fresh permit and the call's original approval. Only pre-effect rounds can ask: external effectful runners never, and in-process capabilities only if declared as authorizing their own effects. A question is shown only while the call's authority holds. Streams end at INPUT_REQUIRED, as the reference SDK's do. The Python agent learned the claim token (missing since M2), the ask tool and the continuation prompt.
- **REST.** At `/a2a/rest` on the v1.0 paths, one table shared by the gateway and Core, the same operations as JSON-RPC. Answers are bare (`application/a2a+json`) and errors are `google.rpc.Status` with A2A's mapping, the gateway's own included. The card lists REST after JSON-RPC.

`implementation-notes.html` records every decision and deviation.

### 4.6 M5 — trust-ranked directory (~5–7 weeks)

As designed, with the fence on the commerce epoch pattern (§3.15), real identity-event handling in AppView, `@dina/a2a` as a dependency, and AppView migration 0025 onward. The Brain tool `search_a2a_agents` returns candidates, never grants. Worth noting: Google Cloud's Agent Registry accepts v0.3 and v1.0 cards; ANS and DNS-AID are IETF individual drafts. None ranks by trust, which remains the reason to build Lane 3.

**As built (2026-10-03):** the publisher runs in core-server beside the profile publisher, with Core holding the state (`a2a_card_publication`, migration v59) and every rule as a guarded update; whether the repository may hold a card is tracked by evidence (`card_maybe_present`), and a rotated key re-signs the fence and the envelope at once. The P-256 card key goes into the DID document as `#a2a_card` (`ensureA2ACardKey`) before any card is published. AppView records every card event in a Postgres spool before acknowledging it, processes it in revision order while `a2a_directory_enabled` is on, and serves `searchAgents` and `getCard` only when `ready`; the moderator's takedown is a table of its own. Departures: `did:web` publishers are refused (AppView has no resolve-then-connect fetcher), the trust handlers do not take `commit.rev`, and an inactive account is a fourth gate. `implementation-notes.html` has the full list.

---

## 5. First slice, concretely (M0)

| File | What |
|---|---|
| `packages/a2a/package.json`, `tsconfig*.json`, `jest.config.js` | Copied from `packages/commerce-protocol` |
| `packages/a2a/src/types.ts` | v1.0 messages, parts, tasks, card, errors |
| `packages/a2a/src/jsonrpc.ts` | Envelope parse/validate, method names, error codes |
| `packages/a2a/src/state_map.ts` | Workflow ↔ `TASK_STATE_*`, both directions, total |
| `packages/a2a/src/card.ts` | Projection from Dina listings, pin, validation |
| `packages/a2a/src/jws.ts`, `jcs.ts` | Card signature sign/verify with injected ES256 |
| `packages/a2a/src/directory_envelope.ts` | As designed |
| `packages/a2a/__tests__/*` | Golden vectors, dependency hygiene, a card round-trip against `a2a-inspector` output |
| `packages/core/src/a2a/{action_registry,skill_bindings,normalize,dispatch_binding}.ts` | Pure, as designed |
| `packages/core/src/crypto/slip0010.ts` | If D4: `derivePathP256`, `deriveCommerceSigningKeyP256` (name to settle), vector |
| `apps/home-node-lite/core-server/src/identity/derivations.ts` | Add phone-approval index 2, gateway index 3 |

---

## 6. Decisions needed

Each is open until the owner decides. The design follows the recommendation where it must assume one, and says so.

| # | Decision | Recommendation |
|---|---|---|
| D1 | **M1a before M1b** (§4.2): accept "the owner sees and approves every outgoing payload, all labelled unverified" as the M1 safety line, with provenance in M1b? | Yes. The design now assumes it (design §6.2, §12). |
| D2 | **Commerce inbound** (§3.6): keep `com.dinakernel.commerce.*` off A2A and point outside buyers to UCP? | Yes. The design excludes them from the card (design §7.1). |
| D3 | **Origin handling** (§3.2): keep `workflow_tasks.origin` as it is and mark A2A children in `a2a_task_children`? | Yes. The design assumes it (design §9); the alternative deletes child rows. |
| D4 | **One P-256 key** at `m/9999'/5'/{generation}'` for A2A cards, UCP and AP2 (§3.13), published as a DID-document verification method (§3.22)? | Yes. M0 confirmed the precondition: the did:plc v0.1 spec accepts any syntactically valid `did:key` in `verificationMethods` (only rotation keys are limited to k256 and p256). |
| D5 | **Gateway port**, and one multi-tenant gateway for managed hosting (§3.14)? | Pick a free port and record it in one config place now. Decide multi-tenancy in M2. |
| D6 | **Lane 1 on the phone** (§3.20): run the outbound runner on the phone? | Not in M1a. Server first; the phone approves cards. Revisit when a mobile transport can resolve, refuse and pin the address before connecting (§3.10), and use `@dina/a2a`'s own thin client then, since the JS SDK targets Node. |
| D7 | **Releasing a real scrubbed value** (§3.19): may the owner send a scrubbed span (their phone number for a booking, say) to a remote agent? | Decide before M1a ships. If yes: a per-span "send as written" control on the consent card, off by default, limited to spans Core can prove came from the owner's own request (so not before M1b), with the released value bound into the consent hash. Until then, nothing scrubbed leaves. |

---

## 7. Four Laws check

Unchanged from the design (§11 there). The plan keeps every outbound call owner-approved, keeps A2A out of Core's internals, keeps payments off A2A, and keeps trust ranking (Verified Truth) as the directory's reason to exist.

---

## 8. Sources

- A2A v1.0.0 / v1.0.1 / main proto: `https://raw.githubusercontent.com/a2aproject/A2A/{v1.0.0|v1.0.1|main}/specification/a2a.proto`
- Spec: https://a2a-protocol.org/latest/specification/ ; releases: https://github.com/a2aproject/A2A/releases
- v1.0 announcement: https://a2a-protocol.org/latest/blog/2026/03/12/a2a-protocol-ships-v10-production-ready-standard-for-agent-to-agent-communication/
- Linux Foundation one-year release (2026-04-09): https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year
- JS SDK `@a2a-js/sdk` 1.2.1: https://github.com/a2aproject/a2a-js ; Python `a2a-sdk` 1.1.5: https://pypi.org/project/a2a-sdk/ ; conformance kit: https://github.com/a2aproject/a2a-tck
- Discovery: https://a2a-protocol.org/latest/topics/agent-discovery/ ; Google Cloud Agent Registry schemas: https://docs.cloud.google.com/agent-registry/json-schemas ; ANS: https://datatracker.ietf.org/doc/draft-narajala-courtney-ansv2/
- UCP A2A binding: https://ucp.dev/latest/specification/shopping/checkout/a2a/
- Code references: as cited per row in §3.
