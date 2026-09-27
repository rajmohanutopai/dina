# A2A: implementation plan

**Status:** Plan. Nothing is built. No A2A code exists in the repo (checked 2026-09-27; the only hits are docs).
**Date:** 2026-09-27.
**Builds:** `docs/A2A_GATEWAY_ARCHITECTURE.md` (the design, written 2026-07-30/31, one commit `f0fd9fe8`; 81 commits have landed since).
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

**Recommended first step:** M0 (a pure `@dina/a2a` package, no migrations, no routes, ~2 weeks), then a thin M1 ("M1a", §4.2) that delivers owner-approved delegation to a remote A2A agent end to end.

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

`AllowedOrigins` (`workflow/domain.ts:108`) and the SQL check (`storage/schemas.ts:229`) allow `'', telegram, api, d2d, admin, system, cli, dinamobile, agent`. The design widens the check by rebuilding the table. `workflow_events` and two other tables reference `workflow_tasks` with `ON DELETE CASCADE`; foreign keys are on (op-sqlite sets it; the server adapter is believed to, to confirm); and the migration runner wraps each migration in a transaction, so `PRAGMA foreign_keys = OFF` cannot be used inside it. Earlier rebuilds (v12, v13, v46, v50) were of tables with no children. **Plan:** do not rebuild. Keep the task's origin as `'api'` (inbound) or `'system'` (outbound) and record `a2a` on the `a2a_tasks` row, which already links to the workflow task. Add a test that fails if any migration rebuilds a table that has cascading children.

### 3.3 `service_configs.revision` — still needed

No `revision` column exists (`schemas.ts:557`). Writes go through `SQLiteServiceConfigRepository` (`service/service_config_repository.ts:87`, upsert at :137), `setServiceConfig`/`setServiceConfigDurable` (`service_config.ts:163/193`) and `listing_rebind.ts`. Precedent: `plugin_installs.config_revision`, already checked by the claim guard. **Plan:** as designed, in migration v51 or later (an `ALTER TABLE … ADD COLUMN`, not a rebuild), bumped in the repository's single upsert.

### 3.4 Execution planes — four, not one

`ServiceConfig` (`packages/protocol/src/types/capability.ts`) now binds a capability to one of: an `mcpServer` delegation task (any paired `agent` may claim via `runner_filter`); Tier 1 on `dina.local` (`LocalDelegationRunner`, `HttpTier1Runner`); Core reasoning (`ServiceReasoningSubmitter`); or a plugin install (`pluginInstallId`, lane `plugin:<install_id>`). The plugin lane already has the design's executor binding: `plugin_installs.device_did` (unique per active device), and `claimPluginTask` (`plugins/claim_guard.ts`) checks exact lane, install active, capability consented, device not revoked, scope hash current and config revision current, terminalising stale claims with `stale_authority`; `claim_id` is required on heartbeat, progress and complete; lease loss on an effectful task becomes `outcome_unknown`. **Plan:** inbound A2A tasks for plugin-bound capabilities go on the plugin lane unchanged. The design's `a2a_runner_bindings` applies only to `mcpServer`-bound capabilities. Tier 1 and Core-reasoning capabilities run as they do for D2D.

### 3.5 Ingress validation still lives in Brain

`packages/brain/src/service/service_handler.ts` (1263 lines) checks the schema hash, validates params, branches `auto`/`review` and calls `providerIngressSubmitter` for plugin-bound capabilities. The design (A2A-I3, §7.2 step 9) wants Core to do all of it for A2A. `evaluateServiceIngressBypass` (`service/bypass.ts:189`) takes a D2D message shape. **Plan:** this is the largest single piece of M2. Port validation into a Core module both D2D and A2A call, rather than a second copy for A2A. Doing it for D2D too removes a Brain-in-the-path check, which the sidecar rule prefers anyway.

### 3.6 Commerce capabilities inbound

`com.dinakernel.commerce.*` go through `provider_ingress` with Core-owned probing refusal, negotiation and order settlement. The design's "no custom Dina capabilities inbound in v1" excludes them. **Plan:** keep them excluded, and say so. Outside agents that want to buy from a Dina supplier should come through UCP (UCP doc §5), whose checkout model matches what outside agents expect.

### 3.7 Consent cards

`CORE_MINTED_PAYLOAD_TYPES` (`server/routes/workflow.ts:1195`) now exists: Brain may not create (400 `reserved_payload_type`) or decide (403) those card types. Hooks are composed through `WorkflowServiceOptions` (`approvalDecisionHandler`, `responseEgressGate`, `ingressResultTransformer`, `pluginCompletionHandler`). **Plan:** add `a2a_delegation_consent` to the set; decide it through an `approvalDecisionHandler`; contribute A2A's hooks through `composeWorkflowHooks`. Templates: `coordination/disclosure_egress.ts` (a card that is a decision, with release rebuilt from the stored result) and `agent/coding_permit.ts` (payload-hash-bound single-use permits). Render the card in the owner console's `approvalCard()` (`owner_console.ts:818`), mobile, and phone approval sync.

### 3.8 Owner routes

Owner calls are `callerType === 'owner'` plus `x-dina-owner-capability` (`routes/owner_guard.ts`). Owner setup lives under `/v1/owner/setup/*`, and the console is Core-served. **Plan:** move the design's `/v1/a2a/clients|remote-agents|directory-listing|publisher/*` to **`/v1/owner/a2a/*`**, with console panels. Route constants in `server/routes/paths.ts`; Brain calls through new `CoreClient` methods.

### 3.9 Credentials for remote agents

There is no provider-key store in Core. Brain's `llm/provider_config.ts` holds LLM keys at the wrong tier. The nearest real store is commerce's (`commerce/credential_store.ts`, table `commerce_credentials`, released only through `useSecret`, plus `credential_broker.ts` leases), but it treats rotation as a replace, while the design wants immutable, versioned `credential_ref`s. **Plan:** a new `a2a_remote_credentials` table as designed, reusing the broker's lease and `useSecret` pattern. M1a needs only the `none` kind.

### 3.10 Outbound network policy

`transport/ssrf.ts` checks URLs only. **Plan:** reuse `commerce/catalog_feed_policy.ts` (`isBlockedAddress`, redirect and size caps) with `fetchUnderPolicy` (`catalog_ingest.ts:152`), which re-checks the connected address through the host transport (`core-server/src/commerce/connector_transport.ts`). This covers design §6.6.

### 3.11 Result guard

Brain's guard scan is a fail-open post-processor; nothing scans tool results for injected instructions. **Plan:** model the guard job on `run/classification.ts` (a Core-owned, lease-checked Brain pull worker with an encrypted, shreddable payload store), but **fail closed**: a result the guard did not clear is never released.

### 3.12 PII and audit

`core/pii/{patterns,scrub}.ts` already serve both halves; drop the design's "new shared PII patterns" item. Audit (`audit/service.ts`, hash chain) is fine as is.

### 3.13 Card signing and JWS

No JWS code exists; JCS-style canonical JSON exists (`packages/protocol/src/plugins/digests.ts:58`, `packages/commerce-protocol/src/canonical.ts:25`). `commerce/held_evidence_verifier.ts` handles `#dina_signing` rotation and is reusable. **Plan:** sign cards with **ES256** from the P-256 branch `m/9999'/5'/{generation}'` proposed in the AP2 doc §6.1 (one key for A2A cards, UCP request signatures and AP2), because ES256 is what verifiers everywhere accept. Publish its JWK set (`jku`). JWS and JCS helpers go in `@dina/a2a` so AppView verifies with the same code.

### 3.14 Ports, hosting, tenants

Port 8300 is `GRANTS_PORT` in `deploy/managed/infra/docker-compose.infra.yml` and core's port in `deploy/managed/docker-compose.prod.yml`. Managed multi-tenant hosting (`packages/managed-runtime`, `deploy/managed`) is new and the design does not address it. **Plan:** pick a free gateway port (not 8300) and record it in one config place. For managed hosting, one gateway serving many tenants through A2A's `tenant` field fits best; design it in M2, do not assume one gateway per node.

### 3.15 Lane 3 publishing and AppView

- `PDSPublisher` (`packages/brain/src/pds/publisher.ts`) now supports `swapRecord` on `putRecord` and returns CIDs from `getRecord`; it has no `swapCommit` or `getLatestCommit`, and `deleteRecord` has no swap. **Plan:** build the card-publication fence on the commerce epoch pattern (`packages/home-node/src/commerce_epoch.ts`, `CommerceEpochService`, `isCommerceRestorePending`): a PDS record fenced with `swapRecord` compare-and-swap, fail-closed, already tested against two restores of one backup.
- AppView's `handleIdentityEvent` (`appview/src/ingester/jetstream-consumer.ts:724`) only logs; the design assumed AppView refreshes DID documents. **Plan:** add real identity-event handling in M5, scoped to card holders first.
- AppView is now a workspace package that depends on `@dina/commerce-protocol`. **Plan:** make `@dina/a2a` a normal dependency instead of the design's byte-copied file. Copy the commerce catalog ingest shape (pure decision module, thin handler).
- Unchanged and as designed: the global `trust_v1_enabled` gate runs before every record (A2A must route around it), `RecordOp` has no `rev`, the existing spool is lossy.

### 3.16 Numbering

Next identity migration: **v51** (latest is v50 `commerce_tender_notice_outcomes`). Next AppView Drizzle migration: **0025**.

---

## 4. Milestones, revised

Sizes are rough, for one engineer who knows the codebase, and exclude review rounds.

### 4.1 M0 — the pure package (~2 weeks)

No migrations, no routes, no network.

- `packages/a2a/` (`@dina/a2a`), copying the scaffolding and the dependency-hygiene test of `packages/commerce-protocol`: v1.0 types from `specification/a2a.proto`, JSON-RPC envelope parse and validate, error codes, both state maps (§2 row 10), card projection and pin (§2 rows 3–9), JWS/JCS sign and verify (injected ES256 functions, keeping the package dependency-free), `directory_envelope.ts`, golden vectors.
- `packages/core/src/a2a/`: `action_registry.ts` on `ActionClass` and `PLUGIN_ACTION_FLOORS` (`payment` always denied), skill-binding validator, `normalize.ts`, `dispatch_binding.ts`, the default result schema with its hash pinned.
- P-256 derivation at `m/9999'/5'/{generation}'` in `slip0010.ts` with a frozen vector (shared with the UCP and AP2 work).
- Dropped from the design's M0: shared PII patterns (exist).

### 4.2 M1a — owner-approved delegation, thin (~3–4 weeks)

A person asks Dina to have a remote A2A agent do something; Dina shows exactly what it will send; the owner approves; the result comes back scanned and quarantined.

- Migration v51: `a2a_remote_agents`, `a2a_skill_bindings`, `a2a_remote_credentials` (`none` kind only), `a2a_tasks`, `a2a_permits`, `a2a_guard_jobs`. No `workflow_tasks` change (§3.2), no `service_configs` change.
- Owner registration under `/v1/owner/a2a/remote-agents`: fetch the card under the network policy, verify signatures when present, pin its hash; bind skills.
- Brain tool `delegate_to_a2a_agent` → Core proposal route → Core-minted consent card showing the exact outgoing message (PII scrubbed) → single-use permit bound to the payload hash.
- Reserved `a2a:` lanes beside the `dina.local` and `plugin:*` guards (`workflow.ts:504/520`).
- A host runner in `packages/home-node` sending `SendMessage` and polling `GetTask`, through `fetchUnderPolicy`; `TASK_STATE_INPUT_REQUIRED` fails as `remote_needs_input` (design §6.4).
- Results: sanitize → validate against the skill's result schema → quarantine → fail-closed guard job → receipt → release to Brain.
- Tests against an a2a-sdk (Python) reference agent and the `a2a-tck` client checks.

**Deviation from the design, needs agreement:** the design's M1 also builds the disclosure log, per-turn utterance digests and per-span entity provenance, so Core can prove which vault reads fed an outgoing message. None of that exists today (vault reads take `session_id` only on the agent path). M1a relies instead on the owner seeing and approving the exact outgoing text every time. **M1b** (~3–4 weeks) adds the provenance machinery as designed, before any auto-approved outbound lane (design §13 Q6) is considered.

### 4.3 M2 — inbound gateway (~6–8 weeks)

- Gateway process (`apps/home-node-lite/a2a-gateway/`) on a free port, service key index 3, mounting the JS SDK's framework-free `DefaultRequestHandler` / `JsonRpcTransportHandler` on Fastify (the SDK ships only an Express adapter).
- Public card at `/.well-known/agent-card.json`, projected from `surface: 'services'` listings with pinned schema pairs; commerce excluded (§3.6).
- Client registration and bearer auth under `/v1/owner/a2a/clients`; grants as `service_grants` with `grantee_did = 'a2a:<client_id>'` (no schema change; the column has no check).
- `SendMessage`, `GetTask`, `ListTasks`, `CancelTask`.
- **Ingress validation ported to Core for both D2D and A2A (§3.5).**
- `service_configs.revision` (§3.3); execution through the existing planes (§3.4).
- An A2A direction in the response bridge (`workflow/response_bridge_sender.ts` produces only D2D today).
- Rate-limit exemption for the gateway's signed calls into Core.

### 4.4 M3 — streaming and push (~2–3 weeks)

Push outbox with claim/ack, SSE for `SendStreamingMessage`/`SubscribeToTask`, webhooks with the v1.0 config shape (§2 row 11), extended card behind authentication.

### 4.5 M4 — DID auth, multi-turn, REST (~3–4 weeks)

As designed, with REST on v1.0 paths (§2). Watch the open DID proposals; Dina's DID challenge is an extension, not the spec.

### 4.6 M5 — trust-ranked directory (~5–7 weeks)

As designed, with the fence on the commerce epoch pattern (§3.15), real identity-event handling in AppView, `@dina/a2a` as a dependency, and AppView migration 0025 onward. The Brain tool `search_a2a_agents` returns candidates, never grants. Worth noting: Google Cloud's Agent Registry accepts v0.3 and v1.0 cards; ANS and DNS-AID are IETF individual drafts. None ranks by trust, which remains the reason to build Lane 3.

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
| `packages/core/src/crypto/slip0010.ts` | `derivePathP256`, `deriveCommerceSigningKeyP256` (name to settle), vector |
| `apps/home-node-lite/core-server/src/identity/derivations.ts` | Add phone-approval index 2, gateway index 3 |

---

## 6. Decisions needed

1. **M1a before M1b** (§4.2): accept owner-sees-every-payload as the M1 safety line, with provenance in M1b?
2. **Commerce inbound** (§3.6): keep `com.dinakernel.commerce.*` off A2A and point outside buyers to UCP?
3. **Origin handling** (§3.2): keep `origin` as is and mark A2A on `a2a_tasks`?
4. **One P-256 key** for A2A cards, UCP and AP2 (§3.13)?
5. **Gateway port** and whether managed hosting runs one multi-tenant gateway (§3.14).
6. **Lane 1 on the phone**: the design allows Lane 1 on mobile. The JS SDK targets Node; the runner should use `@dina/a2a`'s own thin client so it runs on Hermes.

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
