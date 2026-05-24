# Mobile Process Schema And Architecture Review

Date: 2026-05-24

Scope: current TS mobile and home-node-lite code, plus AppView paths used by mobile service discovery. This review intentionally follows the same method as the identity redesign: start from product scenarios, then check whether the schema and architecture can support current release behavior and future-compatible evolution.

This is not a code-fix plan. It is a risk map.

## Status Legend

| Status | Meaning |
| --- | --- |
| ok | Current scenario is supported and the schema has a reasonable extension path. |
| watch | Current scenario is mostly supported, but future extensions will need schema or architectural work. |
| gap | A real schema or architecture gap exists. It can be deferred only if the related scenario is out of release scope. |
| blocker | Should be fixed before release if the related scenario is included in the release checklist. |

## Executive Summary

Identity was the biggest foundational schema issue, but it is not the only one.

The next highest-risk areas are:

| ID | Area | Status | Why It Matters |
| --- | --- | --- | --- |
| MOB-VLT-01 | Vault route/client contract drift | blocker | The client transport exposes vault store/list/delete methods that do not fully match registered server routes. This can break mobile vault browser, persona writes, and home-node-lite split-process usage. |
| MOB-D2D-01 | D2D outbound durability | blocker if offline/restart D2D is in release scope | The TS outbox is in-memory. If delivery is queued and the app restarts, the message is lost. Go had durable outbox semantics. |
| MOB-DEV-01 | Paired-device revoke persistence | blocker if pair/revoke is in release scope | Revocation updates memory but does not persist to the SQL repository, so a revoked device may be trusted again after restart. |
| MOB-NOTIF-01 | Notification inbox persistence | gap, blocker if notification restart behavior is in scope | OS local notifications have some persistence, but the unified in-app notification log/inbox is memory-only in production wiring. |
| MOB-SVC-01 | Service config hydration | blocker if mobile provider mode is in release scope | Service config is persisted, but mobile boot does not appear to hydrate it back into the runtime service config singleton. Provider mode can disappear after restart. |
| MOB-AGENT-01 | Agent locked-vault data request sessions | blocker if OpenClaw locked-vault approval-resume is in scope | Session/persona-pinning routes are explicit stubs. Approval tasks exist, but durable session grants/resume semantics are not fully ported. |
| MOB-PL-01 | PeerLens outbox persistence | gap | PeerLens mobile outbox is in-memory. Offline review publishing cannot survive restart. |
| MOB-AUDIT-01 | Audit log durability model | gap, blocker if audit evidence is release-critical | The SQL audit repository exists, but the audit service reads memory and does not hydrate from SQL. After restart, audit history and chain verification are not reliable. |
| MOB-EXPORT-01 | Export/import archive contents | blocker if backup/export is in release scope | `.dina` archive creation currently writes an encrypted manifest with zero personas and zero identity data, not the actual vaults. |
| MOB-WIPE-01 | Wipe/reinstall keychain coverage | gap | The keychain wipe registry is manually maintained and already misses newer services such as model overrides, services AppView URL, and PeerLens first-run state. |
| MOB-LITE-01 | Home-node-lite server-local registries | gap if lite admin/pairing is in release scope | Lite storage hydrates the shared Core repositories, but some lite-only admin registries remain in-memory and duplicate older schema concepts. |
| MOB-SCHEMA-01 | Runtime schema contract drift | gap | Runtime migrations, fixture SQL, and schema metadata disagree. This creates high regression risk for a greenfield TS rewrite. |

If the first mobile release is limited to onboarding, local chat, local remember/recall, contacts, basic D2D receive/send while the app stays alive, approvals, and simple service query demo, most of these are not fatal except vault route parity and device revoke if those flows are exposed.

If the first mobile release promises the full manual release document, then D2D outbox durability, device revocation persistence, service config hydration, notification persistence, locked-vault agent session behavior, export archive contents, and erase/reinstall keychain coverage should be treated as release blockers.

## Runtime Schema Sources

The runtime schema currently comes from:

| Layer | Source |
| --- | --- |
| Identity DB migrations | `packages/core/src/storage/schemas.ts` |
| Persona DB migrations | `packages/core/src/storage/schemas.ts` |
| Mobile SQLCipher opening | `apps/mobile/src/storage/provider.ts` |
| Mobile repository wiring | `apps/mobile/src/storage/init.ts` |
| Stale schema metadata | `packages/core/src/schema/identity.ts`, `packages/core/src/schema/persona.ts` |
| Stale SQL fixtures | `packages/fixtures/schema/identity_001.sql`, `packages/fixtures/schema/persona_001.sql` |

The runtime schema and the fixture/metadata schema do not match. Treat `packages/core/src/storage/schemas.ts` as the current source of truth until the schema contract is cleaned up.

## Process Matrix

| Process | Current Support | Forward Compatibility | Release Risk | Notes |
| --- | --- | --- | --- | --- |
| Onboarding and identity creation | ok | watch | low | PDS/PLC account creation, key derivation, seed storage, default personas, and unlock are present. Future multi-device data restore is not solved by schema. |
| Recovery phrase restore | ok for identity, watch for data | watch | medium if users expect data restore | Recovery restores identity/key material. It does not restore local encrypted vault data from cloud or another device. That is acceptable only if documented. |
| Unlock and persona vault opening | ok | watch | low | Per-persona SQLCipher DBs are a good base. Durable session/persona grants are not fully ported. |
| Ask/chat local flow | ok | watch | low | Chat messages persist. No first-class thread participants, read receipts, delivery receipts, or attachment schema yet. Fine for one-user local chat. |
| Remember and vault storage | gap | watch | medium | Runtime vault schema is capable, especially with `vault_item_subjects`, but route/client persona contract has drift. |
| Vault browser/search/delete | gap | watch | medium | Query and item get exist. Transport expects list/delete routes that are not currently registered. |
| Identity-linked recall | ok if identity redesign lands as planned | ok | high value | New people, identities, surfaces, and subject links are the correct foundation. This was the right issue to fix before release. |
| Locked persona approval | partial | gap | high if in release scope | Workflow approvals exist. Durable session/persona grant behavior for agent continuation is not fully ported. |
| Reminders | ok for simple reminders | watch | low/medium | Simple due reminders persist. Future RRULE, exception dates, calendar metadata, and richer update semantics need schema work. |
| Notifications and badges | partial | gap | medium/high | OS scheduled notification mirror exists. Unified in-app notification log is memory-only unless a repository is installed. |
| Contacts and people | ok if redesign lands | ok | high value | The redesigned identity hub is the right foundation. Admission policy should stay separate from contacts. |
| D2D personal receive | ok | watch | medium | Inbound staging is durable. Admission policy needs to remain deterministic and independent from fuzzy identity matching. |
| D2D personal send/offline | gap | gap | high if offline/restart is in scope | Outbound D2D outbox is in-memory. Restart loses queued delivery. |
| Device pairing | partial | watch | high if pair/revoke is in scope | Pairing persists devices. Revocation does not currently persist through the SQL repo path. |
| Workflow tasks and approvals | ok | ok | medium | Workflow task/event schema is broad and durable. It is one of the stronger TS areas. |
| Agent action validation | partial | gap | high if OpenClaw mail validation is in scope | `/v1/agent/validate` creates approval tasks, but session approvals use in-memory state for some paths. |
| Agent asks Dina for locked vault data | partial | gap | high if in release scope | Current session route is a stub, so approval-resume around locked persona data is not yet architecturally complete. |
| Service provider discovery/execution | partial/ok | watch | high if provider mode is in scope | BusDriver-style execution through task/OpenClaw is architecturally correct. Service config hydration and AppView discoverability edge cases need attention. |
| PeerLens | partial | gap | medium if PeerLens is in release scope | AppView side exists. Mobile outbox is memory-only, so offline/restart publishing is not durable. |
| PII scrubbing | partial | watch | medium for split-process | Scrub route exists. Client declares rehydrate route that server does not register. In-process Brain paths may bypass this. |
| AI provider settings | partial/ok | watch | medium | BYOK keys and active provider are in keychain. Model overrides are separate keychain rows and are not covered by the wipe registry. |
| Policy settings | ok | watch | low | Action policy overrides persist through `kv_store`. Future multi-user/admin policy should not remain a single flat KV blob. |
| Connector settings | prototype | gap | low unless connectors are in release scope | Connector registry is in-memory simulation. No durable connector account/sync state schema exists. |
| Audit log | partial | gap | medium/high if audit evidence is in scope | SQL table exists, but service state is not hydrated and app reads the in-memory chain. |
| Export/import/share | placeholder | gap | high if backup/export is in scope | Archive format exists, but actual identity/persona data is not included yet. |
| Home-node-lite server-only admin | partial | gap | medium if lite admin is in scope | Lite boot hydrates service config correctly, but local pair token/audit/session registries still use in-memory scaffolds. |
| Settings, wipe, upgrade | partial | gap | medium | Keychain and DB wipe paths exist, but the manual keychain service list is incomplete and schema governance drift makes upgrade testing risky. |

## Detailed Findings

### MOB-SCHEMA-01: Runtime Schema Contract Drift

Status: gap

Scenario:

The TS rewrite needs a stable schema contract across mobile, home-node-lite, fixtures, tests, and docs. A future developer should be able to answer "what is the schema?" from one authoritative place.

Current behavior:

Runtime migrations are in `packages/core/src/storage/schemas.ts`. However, the schema metadata and SQL fixtures still describe older tables and columns. Examples:

| Source | Problem |
| --- | --- |
| `packages/fixtures/schema/identity_001.sql` | Old DID-keyed contacts, old `device_tokens`, old staging shape, no people graph, no workflow/chat/service config. |
| `packages/core/src/schema/identity.ts` | Claims DDL matches server, but still describes old contact and device tables. |
| `packages/core/src/schema/persona.ts` | Missing newer runtime fields such as `author_person_id`, `vault_item_subjects`, topic tables, and identity-linked recall shape. |

Why this matters:

This is not necessarily a runtime bug today, but it is a forward-compatibility risk. The rewrite can silently regress because tests, fixtures, and docs may validate the wrong schema.

Recommended action:

Make runtime migrations the generated source for fixtures and schema metadata, or add a contract test that fails if the fixture/metadata schema diverges from `packages/core/src/storage/schemas.ts`.

### MOB-VLT-01: Vault Route And Client Contract Drift

Status: blocker if vault browser, persona writes, or split-process home-node-lite are in scope

Scenarios:

| Scenario | Expected |
| --- | --- |
| Remember into a non-default persona | Item is stored in the requested persona DB. |
| Vault browser list | Mobile can list stored vault items. |
| Vault delete | Mobile can delete a vault item. |
| Home-node-lite split process | CoreClient methods match server routes exactly. |

Current behavior:

The client transports expose:

| Client method | Route expected by client |
| --- | --- |
| `vaultStore` | `POST /v1/vault/store`, persona in request body |
| `vaultList` | `GET /v1/vault/list` |
| `vaultDelete` | `DELETE /v1/vault/items/:id` |
| `vaultItemsForPerson` | `GET /v1/vault/subjects` |

The current server route file includes:

| Server route | Status |
| --- | --- |
| `POST /v1/vault/query` | exists |
| `POST /v1/vault/store` | exists, but reads persona from query |
| `GET /v1/vault/item/:id` | exists |
| `GET /v1/vault/subjects` | exists |
| `GET /v1/vault/list` | missing |
| `DELETE /v1/vault/items/:id` | missing |

Why this matters:

This can cause items to be written to `general` even when the caller intended another persona, and can break list/delete calls from mobile or home-node-lite.

Recommended action:

Add a route parity test: every `CoreClient` transport method should have a registered server route with matching path, method, parameter location, and response shape.

### MOB-D2D-01: D2D Outbound Durability Is In-Memory

Status: blocker if offline/restart D2D is in release scope

Scenarios:

| Scenario | Expected |
| --- | --- |
| Send D2D while network is down | Message queues durably. |
| App restarts before relay recovers | Queued message survives and retries. |
| User sends service query and app restarts | Query delivery does not disappear. |

Current behavior:

The TS D2D outbox is an in-memory `Map`. It can retry while the process is alive, but queued messages are lost on restart.

Why this matters:

The manual release scenarios include bad network, offline delivery, and long-running D2D behavior. Without durable outbound storage, those scenarios are not release-safe.

Recommended action:

Add an identity DB table such as `d2d_outbox` with idempotency key, target DID, message kind, encrypted payload, state, attempt count, next retry, expiry, and last error. The in-memory worker should become a runtime projection of this table.

### MOB-DEV-01: Paired Device Revocation Does Not Persist Reliably

Status: blocker if pair/revoke is in release scope

Scenarios:

| Scenario | Expected |
| --- | --- |
| Pair a CLI/OpenClaw device | Device is trusted after restart. |
| Revoke a paired device | Revocation survives app restart. |
| Revoked device calls privileged route | Request is rejected. |

Current behavior:

Device registration writes to the SQL repository asynchronously. Device revocation updates the in-memory registry and auth index, but does not call the SQL repository revoke path. Hydration on restart re-registers non-revoked devices from SQL.

Why this matters:

If revocation is not persisted, a revoked device can become trusted again after restart. That is a release blocker for any app exposing pair/revoke.

Recommended action:

Make revocation a durable write before or atomically with in-memory auth index removal. Add a restart test: pair device, revoke device, restart app/core, verify the device cannot authenticate.

Schema note:

The `paired_devices` table also lacks DB-level uniqueness for active public keys or DIDs. At minimum, repository logic must guarantee no duplicate active key binding. A partial unique index on active public key can be considered if key reuse after revoke should be allowed.

### MOB-NOTIF-01: Notification Inbox Is Not Persisted In Production Wiring

Status: gap, blocker if notification restart behavior is in release scope

Scenarios:

| Scenario | Expected |
| --- | --- |
| Approval notification arrives | Notification appears in app inbox and badge. |
| App restarts | Notification history/badge state is restored. |
| Push/deep link opens approval | The approval notification still maps to a durable task. |

Current behavior:

The notification log repository currently has an in-memory implementation. Mobile has a local OS notification mirror in KV storage, but the unified Brain/Core notification inbox is not wired to a durable SQL repository during normal mobile boot.

Why this matters:

The durable approval task may exist, but the notification center/badge can lose its state. This creates confusing UX and can break manual release tests around notification persistence and deep links.

Recommended action:

Either add a `notification_log` identity table, or explicitly derive notification inbox state from durable workflow tasks and events on boot. Do not rely on process memory for release notification state.

### MOB-SVC-01: Service Config Persistence Exists But Hydration Is Missing

Status: blocker if mobile provider mode or BusDriver-style provider config is in scope

Scenarios:

| Scenario | Expected |
| --- | --- |
| User enables service provider mode | Config is persisted. |
| App restarts | Provider config is restored into runtime singleton. |
| Inbound `service.query` arrives after restart | Capability validation and policy use persisted config. |

Current behavior:

The service config repository exists and mobile boot installs it. The service config module has a hydration function, but mobile boot does not appear to call it. That means persisted config can remain in SQL without being loaded into runtime service config state.

Why this matters:

Provider mode can disappear after restart even though the DB row exists. This is especially important after the BusDriver architecture work, because provider config owns schemas, response policy, and capability validation.

Recommended action:

Hydrate service config during mobile boot after installing the repository. Add a restart test: enable provider config, restart, assert `isCapabilityConfigured` and published schema behavior still work.

### MOB-AGENT-01: Agent Locked-Vault Data Request Is Not Fully Durable

Status: blocker if OpenClaw locked-vault approval-resume is in release scope

Scenarios:

| Scenario | Expected |
| --- | --- |
| OpenClaw asks Dina for data | Dina checks persona access. |
| Data is in locked vault | User approval is requested. |
| User approves | OpenClaw continues from the same request. |
| App/core restarts while waiting | Approval and continuation can recover. |

Current behavior:

Workflow approval tasks are durable. However, the session/persona-pinning HTTP routes are explicit stubs, and some agent approval/session state is in-memory.

Why this matters:

This scenario is different from a simple approval notification. It requires durable continuation context: who asked, what persona/data scope was requested, what approval grants, and how the agent resumes.

Recommended action:

If this is in first-release scope, add durable session/grant state or encode enough continuation context in workflow tasks to resume after restart. If it is not in scope, remove it from manual release blockers and mark it as next release.

### MOB-PL-01: PeerLens Mobile Outbox Is In-Memory

Status: gap

Scenarios:

| Scenario | Expected |
| --- | --- |
| User writes a review offline | Draft/outbox item persists. |
| App restarts before network returns | Review is still queued. |
| Network returns | Review publishes exactly once. |

Current behavior:

PeerLens AppView support exists, but the mobile outbox store is in-memory. Comments indicate a real SQLCipher repository is planned later.

Why this matters:

PeerLens can be demoed online, but offline/restart behavior is not release-safe.

Recommended action:

If PeerLens offline behavior is in scope, add a `peerlens_outbox` table or a typed KV-backed outbox. If PeerLens is online-only for the first release, document that limitation.

### MOB-API-01: Client Declares Routes The Server Does Not Register

Status: gap

Known examples:

| Client route | Server status |
| --- | --- |
| `GET /v1/vault/list` | missing |
| `DELETE /v1/vault/items/:id` | missing |
| `POST /v1/pii/rehydrate` | missing |

Why this matters:

In-process mobile paths may hide these gaps. Home-node-lite and any real HTTP split process will hit them directly.

Recommended action:

Add an API contract test that instantiates the server router and checks every method in the HTTP and in-process transports.

### MOB-APPVIEW-01: Service Discoverability Policy Is Not Consistent

Status: gap

Scenario:

Public service egress should only bypass contact trust if the target service is actually discoverable and not redacted/tombstoned.

Current behavior:

Service search filters redacted and tombstoned services. The `service-is-discoverable` endpoint checks `operatorDid` and `isDiscoverable`, but does not appear to apply the same tombstone/redaction filters.

Why this matters:

The admission/egress bypass can permit a service interaction that search would hide. This is a moderation/trust policy mismatch.

Recommended action:

Make `service-is-discoverable` use the same discoverability predicate as service search.

### MOB-AUDIT-01: Audit Log Persistence Is Not The Runtime Read Source

Status: gap, blocker if audit evidence is release-critical

Scenarios:

| Scenario | Expected |
| --- | --- |
| Security-relevant event happens | Event is appended to a tamper-evident audit log. |
| App restarts | Audit history and latest hash chain state are restored. |
| User opens admin/health audit view | View reflects persisted audit entries, not only current-process memory. |
| New audit entry after restart | Entry continues the persisted chain instead of starting from genesis. |

Current behavior:

The identity schema has an `audit_log` table and a `SQLiteAuditRepository`. However, the audit service keeps the authoritative log and sequence counter in module memory. Appends write through to SQL fire-and-forget. Query and verification read the in-memory array, and there is no boot-time hydrate path from SQL back into the audit service.

Why this matters:

After restart, the audit UI can show an empty or partial chain even though SQL rows exist. New entries can restart at sequence 1 and fail SQL persistence if old rows already use that sequence, with the write failure swallowed. That means audit evidence is not durable enough for security claims.

Recommended action:

Either make SQL the authoritative read/write source for audit operations, or add a strict hydrate step that restores `log`, `nextSeq`, and chain head before any new append. Add a restart test: append audit entry, restart, verify query and chain include the old entry, append a new entry, verify chain continuity.

### MOB-EXPORT-01: Export Archive Is Currently Manifest-Only

Status: blocker if backup/export/import is in release scope

Scenarios:

| Scenario | Expected |
| --- | --- |
| User exports a `.dina` archive | Archive contains encrypted identity and persona data. |
| User imports archive on a new install | Memories, contacts, reminders, and settings are restored according to scope. |
| User verifies archive | Verification proves the archive can be decrypted and restored. |

Current behavior:

`createArchive()` currently builds an encrypted manifest with `persona_count: 0`, an empty persona list, and `identity_size_bytes: 0`. The import handler is injectable, and when no handler is registered import validates and succeeds silently.

Why this matters:

The archive format exists, but it is not a backup yet. If the UI exposes export as user-data backup, users can create an archive that contains no actual data.

Recommended action:

If export/import is in release scope, wire the archive layer to identity DB and persona DB snapshots, include format-versioned manifests, and make import fail loudly when no production import handler is registered. If not in scope, hide the export UI or label it as not yet available.

### MOB-WIPE-01: Keychain Wipe Registry Is Incomplete

Status: gap

Scenarios:

| Scenario | Expected |
| --- | --- |
| User erases everything | All Dina-owned keychain rows are removed. |
| User uninstalls/reinstalls on iOS | Orphan keychain state from prior install is wiped. |
| New preference modules are added | Wipe coverage does not depend on remembering a manual list. |

Current behavior:

The reinstall/orphan cleanup path keeps a hardcoded list of keychain service names. That list does not currently include every keychain-backed module. Examples found in the current tree:

| Missing or Fragile Keychain Area | Evidence |
| --- | --- |
| Services AppView URL | `infra_preferences.ts` stores `dina.infra.services_appview_url`, but `install_marker.ts` list omits it. |
| Per-tier model overrides | `model_overrides.ts` stores `dina.llm.model_override.<provider>:<tier>`, but the wipe list only clears API keys under `dina.llm.<provider>`. |
| PeerLens first-run state | `peerlens/first_run.ts` stores `dina.trust.first_run_dismissed_at`, but the wipe list omits it. |

Why this matters:

Erase/reinstall can leave stale preferences from a prior user or prior install. Most of these are not secrets, but stale infrastructure URLs, model choices, or trust UI state can create confusing or unsafe boot behavior.

Recommended action:

Centralize keychain service registration so modules declare their owned keys once, and wipe/orphan cleanup iterates that registry. Add a test that scans known Dina keychain service constants and asserts wipe coverage.

### MOB-LITE-01: Home-Node-Lite Has Server-Local In-Memory Registries

Status: gap if lite admin/pairing is in release scope

Scenarios:

| Scenario | Expected |
| --- | --- |
| Lite server pairs an admin/agent device | Pairing token and revoke state survive restart. |
| Lite server audit/admin screen is used | Audit history survives restart and verifies from persistent state. |
| Lite server grants agent persona access | Grant lifecycle is explicit, and restart behavior is intentional. |

Current behavior:

`apps/home-node-lite/core-server/src/storage/init.ts` correctly opens the shared encrypted identity DB, wires the shared Core SQLite repositories, hydrates service config, hydrates paired devices, hydrates contacts, staging, reminders, and opens persona vaults. That part is better than mobile for service config hydration.

However, home-node-lite also has local server-only registries:

| Local Registry | Current Shape |
| --- | --- |
| `pair/device_tokens.ts` | In-memory `DeviceTokenRegistry`; comments still describe an older `device_tokens` schema. |
| `audit/audit_log.ts` | In-memory `AuditLog`; SQL-backed variant is described as future work. |
| `persona/session_grants.ts` | In-memory session grants. This may be acceptable for ephemeral sessions, but it must be a deliberate release decision. |
| `workflow/workflow_persistence.ts` | In-memory adapter exists, though the boot path also wires shared `SQLiteWorkflowRepository` for the actual workflow plane. |

Why this matters:

There are two trust/pairing concepts in play: the shared Core `paired_devices` model and the lite-specific `device_tokens` model. That may be intentional for server admin tokens, but it should be documented as a separate auth plane. If not, it becomes another identity/trust split similar to the one fixed in the people graph.

Recommended action:

For first mobile release, this is not a blocker unless home-node-lite admin/pairing is part of the same release. Before promoting lite admin as production, decide whether lite device tokens remain a separate admin-token plane or collapse into the shared paired-device identity model. Add restart tests for pair, revoke, audit, and grant semantics.

## Area-By-Area Scenario Checks

### 1. Onboarding, Recovery, And Local Encryption

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| New user creates mobile Dina | Supported. Key derivation, PDS/PLC flow, and local encrypted DB opening are present. |
| User reopens app and unlocks | Supported if keychain state remains intact. |
| User restores from recovery phrase | Identity/key restore is supported. Data restore is not. |
| User expects old memories after reinstall | Not supported without local backup/sync. |
| Future multi-device sync | Needs explicit sync/backup architecture. Current per-device SQLCipher files are local-only. |

Verdict:

Good enough for first release if recovery is documented as identity recovery, not full data recovery.

### 2. Persona Vaults And Memory

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| `/remember Emma loves chicken` | Supported by vault items plus identity subject links if identity redesign lands. |
| Remember into locked/private persona | Persona DB separation supports this. Access policy must be enforced in routes/tools. |
| Query across allowed personas | Supported by opening persona DBs and policy checks, but route contract needs tests. |
| Delete vault item | Client expects delete route; server route is missing in current route file. |
| Recall all notes about a person | `vault_item_subjects` is the right schema. |
| Future memory provenance | Current `vault_items` has source, sender, trust, author, metadata. Enough for near-term. |

Verdict:

Schema direction is good. Route/client drift is the release risk.

### 3. Chat And Ask

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| User asks a local question | Supported. |
| Chat history survives restart | Supported by `chat_messages`. |
| Service query appears in chat timeline | Supported through chat metadata. |
| Future group chat | Needs thread participants and delivery/read receipt schema. |
| Future attachments | Needs attachment table or content-addressed blob references. |

Verdict:

Good for first release. Future group/multi-device chat should not be built on the current single-table chat model without adding thread metadata.

### 4. Reminders

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| Create one-time reminder | Supported. |
| Hydrate reminders on boot | Supported by repository hydration. |
| Daily/weekly/monthly reminder | Basic recurring field exists. |
| Edit reminder text/timezone/rule | Repository update path is narrow. |
| Future calendar-grade recurrence | Needs RRULE, exception dates, source calendar metadata, and notification ids. |

Verdict:

Good enough for simple first release reminders. Do not promise full calendar semantics yet.

### 5. Notifications

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| Approval notification while app is live | Supported through in-memory notification flow. |
| Scheduled local notification | Mobile KV mirror exists. |
| Notification inbox after restart | Gap. No durable production notification log is wired. |
| Badge count after restart | Gap unless derived from workflow/reminder state. |

Verdict:

If release tests only check live notifications, this is acceptable. If tests check notification history or badge restoration after restart, add durable notification state or derive it deterministically.

### 6. Contacts, People, And Admission

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| Add contact | Identity hub redesign is the right shape. |
| Contact has multiple DIDs | `person_identities` supports this. |
| Fuzzy name recall | `person_surfaces` plus confirmation workflow is the right shape. |
| Unknown DID with matching name | Must not bypass admission. Admission must use verified identity/trust, not fuzzy name. |
| Future org/service/device identities | `entity_type` gives a low-cost forward-compatible path. |

Verdict:

This was worth fixing before release. Keep admission policy separate from identity matching.

### 7. D2D Messaging

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| Known contact sends personal message | Inbound staging is durable. |
| Unknown personal sender | Admission policy can quarantine. |
| Public service query from non-contact | Should be admitted only if published service policy allows it. |
| Outbound message while relay unavailable | Gap. In-memory outbox only. |
| App restart while outbound queued | Gap. Queued message is lost. |

Verdict:

Inbound side is closer to release-ready than outbound offline durability. Add durable outbox if offline/restart D2D is promised.

### 8. Pairing, CLI, And OpenClaw Devices

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| Pair Dina CLI agent | Table exists and hydration exists. |
| Revoke paired device | Gap. Revocation does not persist through current registry flow. |
| Restart after revoke | Gap. SQL can rehydrate the device as active. |
| Future multiple devices per DID | Schema can represent it, but constraints need clarity. |

Verdict:

Persisted revoke is security-sensitive. Fix before exposing revoke in release.

### 9. Workflow Tasks, Approvals, And Service Execution

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| Create approval task | Supported. |
| Claim/complete task | Supported. |
| Recover task after restart | Supported by workflow schema, with caveats around external runtime state. |
| BusDriver service execution through OpenClaw | Architecturally correct: service query creates delegation task, OpenClaw executes, response bridge sends D2D response. |
| Future long-running agent sessions | Needs durable session/grant model if the session itself matters after restart. |

Verdict:

Workflow task schema is one of the strongest areas. The main gap is not tasks; it is session/continuation state around agents and locked personas.

### 10. Agent Action Validation

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| OpenClaw wants to send mail | `/v1/agent/validate` can create approval workflow. |
| User approves | Approval task can complete. |
| Agent resumes after approval | Needs explicit durable continuation semantics if not already embedded in task/result. |
| App restarts while approval pending | Workflow task survives. In-memory session approval state may not. |

Verdict:

Good enough for simple approval if the agent polls task state. Not good enough if release requires durable interactive session continuation through restart.

### 11. Service Provider Mode And AppView

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| Provider publishes schema | AppView schema indexing exists. |
| Requester gets schema from search | Supported. |
| Provider validates params | Supported in Brain service handler. |
| Provider executes through OpenClaw | Supported by delegation task architecture. |
| Provider config survives restart | Gap unless service config hydration is called. |
| Redacted/tombstoned service bypass | Gap in discoverability endpoint predicate. |

Verdict:

The architecture is now directionally correct. The first-release risk is boot hydration and policy consistency, not the BusDriver execution-plane design.

### 12. PeerLens

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| Online review publish | AppView side likely supports it. |
| Offline review queued | Mobile outbox is in-memory. |
| Restart before publish | Queued review is lost. |
| Future exactly-once publish | Needs durable outbox/idempotency table. |

Verdict:

Do not include offline PeerLens publish in first release unless persistence is added.

### 13. PII Scrubbing

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| Scrub before cloud LLM | Scrub route exists. |
| Rehydrate result | Client declares route, server route missing. |
| Store entity map | Usually should be ephemeral, not persistent. |
| Split-process Brain/Core | Route parity matters. |

Verdict:

No major DB schema issue. There is an API contract issue for HTTP/split-process usage.

### 14. Wipe, Upgrade, And Migration

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| App wipe | Local DB/keychain wipe paths exist, but keychain service coverage is manual and incomplete. |
| Upgrade app with old DB | Runtime migrations exist. |
| Greenfield first release | No customer migration needed yet. |
| Future migration safety | Schema contract drift is a risk. |

Verdict:

Because this is greenfield, lack of customer migration is acceptable. But schema source-of-truth drift and keychain wipe coverage should be fixed before real users create persistent data.

### 15. AI Provider And Model Settings

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| User stores BYOK API key | Supported through platform keychain. |
| User selects active provider | Supported through keychain-backed active provider. |
| User picks per-tier model override | Supported through separate keychain rows. |
| App restarts | Boot hydrates active provider and model overrides before constructing the LLM provider. |
| User erases/reinstalls | Gap: model override rows are not covered by the hardcoded keychain wipe registry. |
| Future provider catalog changes | Watch: provider names and wipe list are manually duplicated. |

Verdict:

Good enough for first release LLM settings. The lifecycle risk is wipe/orphan cleanup, not SQL schema.

### 16. Policy Settings

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| User changes action risk | Supported through `kv_store`. |
| App restarts | KV-backed policy survives restart. |
| User resets action to default | Supported by deleting override. |
| Future per-agent/per-persona policy | Needs schema beyond one flat KV blob. |
| Future audit of policy changes | Should append audit entries if admin evidence matters. |

Verdict:

Fine for single-user first release. Do not grow admin/multi-agent policy on the current flat KV shape without a real policy table.

### 17. Connector Settings And External Sources

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| User connects Gmail/calendar/contacts | Current connector registry is in-memory simulation. |
| OAuth token refresh | No durable connector credential/state schema found. |
| Last sync cursor | No durable sync cursor schema found. |
| Imported items provenance | Vault schema has source/source_id fields, but connector account state is missing. |
| Future background sync | Needs durable connector config, cursor, error, and backoff state. |

Verdict:

Do not include external connector sync in first release unless this is built. The UI can remain a placeholder, but it should not imply real durable connector support.

### 18. Audit, Diagnostics, And Admin Screens

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| Audit event is appended | Supported in memory and attempted in SQL. |
| Audit survives restart | Gap: audit service is not hydrated from SQL. |
| Audit chain verifies after restart | Gap: verification reads current memory chain. |
| Health check validates audit | Only meaningful for current process unless audit hydrate is fixed. |
| Future compliance/security evidence | Needs SQL-authoritative chain and retention semantics. |

Verdict:

Admin/diagnostics can be dev-only. If audit is presented as security evidence in release, fix the durable audit model first.

### 19. Export, Import, And Share

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| User exports data | Gap: archive currently contains only an encrypted empty manifest. |
| User imports archive | Import validates manifest and calls optional handler, but no production restore path is guaranteed. |
| User shares archive | Share flow can write and share a file if native functions are configured. |
| Future full backup | Needs versioned identity/persona snapshots and restore conflict policy. |

Verdict:

Archive format is a scaffold, not backup. Hide or defer export/import unless full data inclusion is implemented.

### 20. Home-Node-Lite Server Boundary

Important scenarios:

| Scenario | Schema/Architecture Assessment |
| --- | --- |
| Lite boots from encrypted storage | Supported. It uses the shared Core storage migrations and repository wiring. |
| Lite provider config survives restart | Supported in lite: storage init calls `hydrateServiceConfig()`. This is a mobile gap, not a lite gap. |
| Lite workflow tasks survive restart | Actual workflow plane uses shared `SQLiteWorkflowRepository`; the older in-memory adapter appears scaffold/test-oriented. |
| Lite admin pairing survives restart | Gap if using lite `DeviceTokenRegistry`; it is in-memory and separate from shared `paired_devices`. |
| Lite audit survives restart | Gap if using lite `AuditLog`; it is in-memory. |
| Lite session grants survive restart | In-memory by design today; acceptable only if sessions are deliberately ephemeral. |

Verdict:

Home-node-lite is mostly aligned with the shared Core storage for the main workflow/service/vault path. The risk is server-local admin scaffolding that still duplicates older models. Keep it dev/admin-only or unify it before production release.

## Recommended First-Release Gates

These are the tests I would require if the corresponding feature is in the release checklist.

| Gate | Required If | Test |
| --- | --- | --- |
| Vault route parity | Vault browser, remember, or home-node-lite split process | Store/list/get/delete item in a non-default persona through CoreClient transport. |
| D2D durable outbox | Offline D2D or restart D2D | Queue outbound message, kill/restart app/core, verify retry delivery. |
| Device revoke persistence | Pair/revoke exposed | Pair device, revoke, restart, verify auth is rejected. |
| Notification restore | Notification center/badges in release | Create approval notification, restart, verify inbox/badge/deep link still works. |
| Service config hydration | Provider mode in release | Configure provider, restart, verify capability config and schema are active. |
| Agent locked-vault resume | OpenClaw data request in release | Agent asks for locked persona data, user approves, restart at each waiting point, verify continuation. |
| PeerLens durable outbox | Offline PeerLens in release | Create review offline, restart, reconnect, verify exactly-once publish. |
| Audit durability | Audit/admin evidence in release | Append event, restart, query audit, verify chain, append another event, verify continuity. |
| Export archive contents | Backup/export in release | Create archive with non-empty identity/persona data, import into clean install, verify restored rows. |
| Wipe coverage | Erase/reinstall in release | Set every keychain-backed preference, erase/reinstall, verify no Dina-owned keychain rows survive. |
| Connector persistence | Connectors in release | Connect account, restart, verify account/cursor/error state survives without re-auth. |
| Lite admin persistence | Home-node-lite admin/pairing in release | Pair device, revoke, append audit, restart lite server, verify revocation and audit chain survive. |
| Schema contract | Any release with persistent user data | Assert runtime migrations, fixtures, and schema metadata describe the same tables/columns. |

## Minimal Fix List If Release Is This Week

If the goal is to ship this week, I would not expand scope. I would do only the release-critical items:

| Priority | Fix |
| --- | --- |
| P0 | Fix vault route/client parity and persona parameter handling. |
| P0 | Persist device revocation if pairing/revoke is exposed. |
| P0/P1 | Hydrate service config on boot if provider mode is exposed. |
| P1 | Add durable D2D outbox if offline/restart D2D is promised. |
| P1 | Persist or derive notification inbox if notification history/badges after restart are promised. |
| P1 | Decide whether OpenClaw locked-vault data request is in this release. If yes, add durable continuation/session state. If no, move it out of manual release blockers. |
| P1 | Hide or complete export/import if users can reach the share archive flow. |
| P1 | Fix keychain wipe coverage before shipping erase/reinstall claims. |
| P2 | Make audit SQL-authoritative if audit/admin is more than a dev diagnostic. |
| P2 | Keep home-node-lite server-local admin registries dev-only, or unify them with shared Core persistence before production. |
| P2 | Clean schema source-of-truth drift before real users accumulate data. |

## Answer To The Original Question

Yes, there are DB/schema architecture issues outside identity.

They are not as conceptually central as identity, but a few are similarly release-sensitive because they affect trust, durability, or restart behavior:

| Comparable To Identity? | Area | Reason |
| --- | --- | --- |
| yes, for security | Device revoke persistence | A revoked agent/device must not regain trust after restart. |
| yes, for reliability | D2D durable outbox | Messages should not disappear on app restart if the product promises offline messaging. |
| yes, for provider mode | Service config hydration | Published service capabilities must survive restart. |
| yes, for locked data | Agent session/grant durability | Approval to access locked vault data must be deterministic and recoverable. |
| yes, for account safety | Keychain wipe coverage | Erase/reinstall must not leak old user preferences or credentials into a new install. |
| yes, if exposed as backup | Export archive contents | A backup file that contains no data is worse than no backup UI. |
| medium | Notification persistence | UX and release-test risk, but can be derived from durable workflow state. |
| medium | Vault route parity | Concrete bug risk rather than deep schema flaw. |
| medium/high | Audit persistence | Important if audit is a security claim; dev-only if admin remains internal. |
| medium | Home-node-lite local registries | Not a mobile blocker unless lite admin/pairing is released as production. |
| medium | Schema contract drift | Future regression risk. Fix before persistent customer data exists. |

The right release decision is scope-based:

If the first release does not promise offline D2D through restart, provider mode through restart, PeerLens offline publishing, locked-vault agent continuation, full archive backup, or complete erase/reinstall guarantees, those can be deferred explicitly.

If the manual release checklist includes them, they need to be fixed or removed from the release checklist. Otherwise the tests will be asking the current architecture to guarantee behavior it does not yet persist.
