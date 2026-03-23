# Universal Staging Architecture — Implementation Plan

**Created:** 2026-03-20
**Status:** Complete (all 4 phases implemented)
**Phase:** 4 of 4 (vault writes locked down)

## Ground Rules

**No migration. No legacy support. No backward compatibility.**

This is the first version of Dina. There is no existing user data, no deployed production system, no third-party integrations to preserve. Every change is a clean implementation, not a migration.

Specifically:
- No `ALTER TABLE` — define the schema correctly from the start
- No backfill scripts — there is no old data to backfill
- No "accept old format or new format" — pick one format and use it
- No deprecated-but-still-supported paths — remove the old path when the new one is ready
- No feature flags or gradual rollout — implement it, test it, ship it

Anyone implementing this plan should treat every file as if it's being written for the first time.

## Core Thesis

All memory-producing ingress passes through one universal staging layer before it can affect the vault. No new content goes straight to vault unless it's an internal trusted system write from Brain/Admin.

## Three Layers

| Layer | Purpose | Examples |
|-------|---------|----------|
| Transport ingress | Delivery + durability | Dead drop, rate limiting, D2D envelope, replay protection |
| Ingress staging | Single provenance/classification airlock | `dina remember`, connector data, Telegram notes, D2D memory content |
| Action staging | Draft/cart-handover approval | Email drafts, purchase intents (keep separate) |

## Current State (What's Wrong)

| Path | Where it goes | Should go |
|------|--------------|-----------|
| `dina remember` | `POST /api/v1/remember` → staging ingest + Brain drain + poll (synchronous, up to 15s) | Staging (correct) |
| Connector data | Staging (`/v1/staging/ingest`) | Staging (correct) |
| D2D messages | Transport/dead-drop | Transport → then staging for memory content |
| Telegram notes | Direct to vault | Staging |
| Brain enrichment | Direct to vault (after staging resolution) | Correct (trusted system write) |

## Phase 1: CLI Writes Staged

### Trust Model

Trust is derived from `(ingress_channel, origin_kind)`, NOT from source strings.

| Channel | origin_kind | sender_trust | Confidence | Retrieval policy |
|---------|-------------|--------------|------------|-----------------|
| telegram | user | self | high | normal |
| cli | user | self | high | normal |
| cli | agent | unknown | medium | caveated |
| d2d | remote_dina | contact ring (if known), else unknown | medium | caveated |
| connector | service | unknown | low | caveated |

**Critical distinction:** CLI content authored by the user (`dina remember "..."`) gets `origin_kind=user`. Content produced by an agent running through the CLI (OpenClaw task output) gets `origin_kind=agent`. The device identity (DID) determines which: if the device was paired as an agent (e.g., OpenClaw skill), origin_kind=agent. If paired as the user's personal CLI, origin_kind=user.

This prevents the current bug where agent-produced memory inherits user-level trust.

### Changes by File

#### Tier 1: Domain & Schema

**`core/internal/domain/staging.go`**
- Add to `StagingItem`:
  - `IngressChannel string json:"ingress_channel"` — cli, connector, telegram, d2d, brain, admin
  - `OriginDID string json:"origin_did"` — device DID, remote DID, or empty
  - `OriginKind string json:"origin_kind"` — user, agent, remote_dina, service
- Add channel constants: `IngressCLI`, `IngressConnector`, `IngressTelegram`, `IngressD2D`, `IngressBrain`, `IngressAdmin`
- Add origin kind constants: `OriginUser`, `OriginAgent`, `OriginRemoteDina`, `OriginService`

**`core/internal/domain/device.go`**
- Add `Role string json:"role"` to `PairedDevice` — "user" (default, personal CLI) or "agent" (OpenClaw/bot)
- This is how Core knows whether a device-scoped caller is a person or an agent

**`core/internal/port/device.go`**
- Add `GetDeviceByDID(ctx context.Context, did string) (*domain.PairedDevice, error)` to `DevicePairer` interface
- This is how the staging handler looks up device role from the authenticated DID

**`core/internal/adapter/pairing/pairing.go`**
- Add `role` field to `deviceRecord` struct
- Accept optional `role` in `CompletePairingWithKey` (defaults to "user" if empty)
- Store role in `deviceRecord`
- Return role in `ListDevices` response via `PairedDevice`
- Implement `GetDeviceByDID`: iterate devices, match by DID, return `*PairedDevice` with role

**`core/internal/adapter/pairing/persist.go`**
- Add `Role string json:"role"` to `persistedDevice` struct
- `persistDevices()`: write role to JSON
- `SetPersistPath()` / load: read role from JSON, default to "user" if empty

**`core/internal/service/device.go`**
- Add `GetDeviceByDID` pass-through to DeviceService (delegates to pairer)

**`core/internal/handler/device.go`**
- Accept `role` in `completePairingRequest` JSON body
- Pass to pairing manager

**`api/core-api.yaml` + `api/components/schemas.yaml`**
- Add `ingress_channel`, `origin_did`, `origin_kind`, and `producer_id` to `StagingIngestRequest` and `StagingItem`
- Add `role` to `PairCompleteRequest` and `PairedDevice`
- Run `make generate`

#### Tier 2: Core Storage

**`core/internal/adapter/sqlite/staging_inbox.go`**
- Add `ingress_channel`, `origin_did`, `origin_kind`, and `producer_id` to INSERT
- Change dedup unique constraint from `(connector_id, source, source_id)` to `(producer_id, source, source_id)`
- `producer_id` is a server-derived composite key that uniquely identifies the producer:
  - CLI device: `cli:<device DID>` (each paired device is a distinct producer)
  - Connector: `connector:<connector_id>` (each connector instance is a distinct producer)
  - Telegram: `telegram:<user_id>` (the Telegram user)
  - D2D: `d2d:<remote DID>` (each remote Dina)
  - Brain: `brain:system` (singleton)
  - Admin: `admin:system` (singleton)
- This avoids the origin_did collision where all connectors share one service DID
- Include all new columns in Claim SELECT so Brain receives them

**`core/internal/domain/staging.go`** (add to StagingItem alongside the other new fields)
- Add `ProducerID string json:"producer_id"` — the dedup namespace key

**`core/internal/adapter/sqlite/pool.go`**
- Add `ingress_channel`, `origin_did`, `origin_kind`, and `producer_id` columns in staging_inbox CREATE TABLE
- Dedup unique index: `(producer_id, source, source_id)`
- No migration needed — initial phase, no existing data

**`core/internal/adapter/vault/staging.go`** (in-memory)
- Update dedup key to use `producer_id` instead of `connector_id`
- Store `ingress_channel`, `origin_did`, `origin_kind`, and `producer_id` on ingest

#### Tier 3: Core Handler

**`core/internal/handler/staging.go`**
- Add `IngressChannel`, `OriginDID`, `OriginKind`, and `ProducerID` to `ingestRequest` struct (all in the DTO — device callers get overridden, Brain sets them in Phase 2)
- **Server-override (not auto-detect):** Core ALWAYS sets `IngressChannel`, `OriginDID`, and `OriginKind` from auth context, ignoring any values external callers send:
  - CallerType "agent" (device key) → `ingress_channel=cli`, `origin_did=<device DID>`, `origin_kind=<device role from pairing: "user" or "agent">`
  - ServiceID "connector" → `ingress_channel=connector`, `origin_did=<connector service ID>`, `origin_kind=service`
  - ServiceID "brain" → `ingress_channel=brain`, `origin_did=brain`, `origin_kind=service`
  - CLIENT_TOKEN admin → `ingress_channel=admin`, `origin_did=admin`, `origin_kind=user`
- External callers cannot spoof `ingress_channel`, `origin_did`, or `origin_kind`
- Only trusted service-key callers (Brain) can set these fields explicitly (for Telegram/D2D relay in Phase 2+)
- Handler calls `DeviceService.GetDeviceByDID(did)` to look up device role → maps role to `origin_kind` ("user"→`OriginUser`, "agent"→`OriginAgent`)
- Handler derives `producer_id` from auth context:
  - Device: `"cli:" + deviceDID`
  - Connector: `"connector:" + req.ConnectorID` (from request body — connector identity is per-account, not per-service-key)
  - Brain: `"brain:system"`
  - Admin: `"admin:system"`
- Staging handler needs `DeviceService` injected (add field to `StagingHandler` struct, wire in `main.go`)

#### Tier 4: Auth

**`core/internal/adapter/auth/auth.go`**
- Add `/v1/staging/ingest` to device allowlist
- Keep `/v1/vault/store` in device allowlist for Phase 1 (removed in Phase 4)
- `/v1/vault/store` is still used by `dina draft` — drafts are action staging (separate from ingress staging) and write directly to vault with type=email_draft/cart_handover. This is intentional and is NOT part of the ingress staging refactor

#### Tier 5: CLI

**`cli/src/dina_cli/client.py`**
- Add `remember(text, session, source_id, metadata) -> dict` method → `POST /api/v1/remember`
- This endpoint wraps staging ingest + Brain drain + completion polling (up to 15s). It is NOT purely async — it blocks and returns a terminal status (`stored`, `needs_approval`, `processing`, `failed`) when possible.
- Add `remember_check(item_id) -> dict` method → `GET /api/v1/remember/{id}` for polling items that returned `processing`
- Session is **required** by both the CLI command and the Core endpoint (400 if missing)

**`cli/src/dina_cli/main.py`**
- Change `remember` command: `client.vault_store(...)` → `client.remember(text, session=session, ...)`
- `--session` is **required** (enforced by Click and by Core)
- Fields: `source: "dina-cli"`, `source_id: f"cli-{uuid}"`, `type: "note"`, `summary: text`, `body: text`
- Output: `{"status": "stored"}` on success, `{"status": "needs_approval", "id": "stg_xxx"}` if persona locked, `{"status": "processing", "id": "stg_xxx"}` if still in flight

#### Tier 6: Brain

**`brain/src/service/trust_scorer.py`** (significant refactor)
- Replace source-string-driven trust (current: hardcoded lists at line 90) with `(ingress_channel, origin_kind)` as primary provenance input
- `source` becomes descriptive metadata only (for display/audit), not a trust signal
- Trust derivation: `(ingress_channel, origin_kind)` → `(sender_trust, confidence, retrieval_policy)`
- Remove hardcoded source string lists; derive trust from structured provenance fields
- This is a real refactor, not just plumbing — the trust scoring logic changes its primary input

**`brain/src/service/staging_processor.py`** (significant refactor)
- Current code builds a connector-shaped item_dict (line 84) — generalize to work with any ingress channel
- Include `ingress_channel`, `origin_did`, `origin_kind`, and `producer_id` in item_dict passed to trust scorer
- Trust scorer uses `(ingress_channel, origin_kind)` as primary trust input, not source strings
- Persona routing stays content-based (Brain classifies by summary/body text, not CLI category metadata) — this is intentional and correct

### Tests

#### Go Unit Tests (`core/test/staging_inbox_test.go`)

| Test | What it verifies |
|------|-----------------|
| `TestStagingInbox_IngestCLIChannel` | Ingest with `ingress_channel: "cli"` stores correctly |
| `TestStagingInbox_DedupByProducerIdentity` | Same (source, source_id) from different origin_dids does NOT dedup |
| `TestStagingInbox_ConnectorChannelSet` | Connector-auth ingest gets `ingress_channel=connector`, `origin_kind=service` |
| `TestStagingInbox_CLIChannelServerDerived` | Device-auth ingest always gets server-set "cli" channel |

#### Device Role Tests (`core/test/pairing_test.go`)

| Test | What it verifies |
|------|-----------------|
| `TestPairing_DefaultRoleIsUser` | Pair without role field → device role defaults to "user" |
| `TestPairing_AgentRolePersists` | Pair with `role=agent` → device record has role "agent" |
| `TestPairing_RoleInDeviceList` | GET /v1/devices returns role field for each device |
| `TestPairing_RoleSurvivesRestart` | After Core restart, device role is reloaded from persistence |
| `TestStagingInbox_DeviceCannotSpoofChannel` | Device caller sending `ingress_channel=telegram` gets overridden to "cli" |
| `TestStagingInbox_DeviceCannotSpoofOriginDID` | Device caller sending `origin_did=did:plc:fake` gets overridden to actual device DID |
| `TestStagingInbox_DeviceCannotSpoofOriginKind` | Device caller sending `origin_kind=user` when paired as agent still gets "agent" |

#### Integration Tests (`tests/integration/test_staging_cli.py`)

| Test | What it verifies |
|------|-----------------|
| `test_cli_device_signed_ingest` | Device-signed POST to `/v1/staging/ingest` succeeds (201) |
| `test_cli_ingest_claim_resolve` | Full pipeline: CLI ingest → Brain claim → classify → enrich → resolve → verify in vault |
| `test_cli_ingest_dedup` | Same (producer_id, source, source_id) dedups correctly |
| `test_cli_ingest_user_trust` | After resolve, user-origin item has sender_trust: "self", confidence: "high" |
| `test_cli_ingest_agent_trust` | After resolve, agent-origin item has sender_trust: "unknown", confidence: "medium" |
| `test_cli_ingress_channel_server_derived` | Device-signed ingest always gets server-set ingress_channel="cli" regardless of what caller sends |
| `test_connector_gets_service_provenance` | Connector ingest gets `ingress_channel=connector`, `origin_kind=service` |
| `test_device_cannot_spoof_origin_did` | Device sending `origin_did=did:plc:fake` in body → stored item has actual device DID, not fake |
| `test_device_cannot_spoof_origin_kind` | Device sending `origin_kind=user` when paired as agent → stored item has "agent" |
| `test_device_cannot_claim_telegram` | Device sending `ingress_channel=telegram` → stored item has "cli" |

#### Release Tests (`tests/release/test_rel_023_cli_agent.py`)

| Test | What it verifies |
|------|-----------------|
| `test_rel_023_agent_can_store_data` | Require `{"staged": True, "id": "..."}` — direct vault write is a regression |
| `test_rel_023_staged_item_reaches_vault` (new) | After `dina remember`, wait for Brain sweep, verify item appears via `dina ask` |

#### CLI Unit Tests (`cli/tests/test_commands.py`)

| Test | What it verifies |
|------|-----------------|
| `test_remember_stages` (update) | `remember` calls `POST /api/v1/remember`, not vault_store |
| `test_remember_returns_stored` | Response has `{"status": "stored"}` when Brain completes within 15s |
| `test_remember_requires_session` | `remember` without `--session` exits with error |

#### Existing Tests to Update

These tests currently encode direct vault-store behavior and must be updated:

| File | Test | Current behavior | New behavior |
|------|------|-----------------|-------------|
| `cli/tests/test_commands.py` | `test_remember_json` (line 117) | Mocks `vault_store` | Mock `remember` (POST /api/v1/remember) |
| `cli/tests/test_commands.py` | `test_remember_stores_to_general` (line 657) | Asserts persona=general in vault_store call | Assert `remember` called with session (no persona — Brain classifies) |
| `tests/release/test_rel_023_cli_agent.py` | `test_rel_023_agent_can_store_data` (line 21) | Checks `{"stored": True}` | Check `{"status": "stored"}` |
| `tests/install/TEST_PLAN.md` | Vault round-trip description (line 99) | Describes `remember` as direct vault_store returning `stored: true` | Update to describe staging flow returning `staged: true` |
| `cli/tests/TEST_PLAN.md` | CLI remember description (line 95) | Describes `remember` as direct vault_store | Update to describe staging ingest |
| `tests/e2e/test_suite_15_cli_signing.py` | Signed vault store (line 190) | Device-signed `/v1/vault/store` succeeds | Device-signed `/v1/staging/ingest` succeeds (Phase 4: vault/store blocked) |
| `tests/integration/test_persona_tiers.py` | Tier access via store (line 373) | Direct vault store to test persona access | Use staging ingest or Brain-mediated store |

### Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| CLI `remember` polling window | `POST /api/v1/remember` polls for up to 15s. If Brain is slow, status may be `processing` — caller should poll `GET /api/v1/remember/{id}` | Core's remember endpoint triggers Brain drain immediately after ingest; 15s is typically sufficient |
| Dedup index change | Schema includes new columns from the start | No migration — initial phase, no existing data |
| Connector provenance | All connectors must go through staging | Server-override sets `ingress_channel=connector` from service key |
| Brain Pydantic model | New fields needed | `make generate` after OpenAPI update; fields are optional |
| Persona classification | CLI items may go to health/finance instead of general | This is correct behavior — Brain classifies by content |

### Implementation Order

1. Domain model + OpenAPI spec + codegen
2. Storage adapters (both in-memory and SQLite)
3. Handler + auth allowlist
4. Go unit tests
5. Brain trust scorer + staging processor
6. CLI client + command
7. Integration tests
8. Release tests
9. CLI unit tests

---

## Phase 2: Telegram & Admin Content Staged

**Prerequisite:** Phase 1 complete (CLI staging works, trust derived from provenance)

### What Changes

Telegram messages that produce memory (`_store_message`) are redirected through staging with `ingress_channel=telegram`. This gives them proper provenance and trust scoring.

**Excluded from staging:** `_handle_document_ingest` (guardian.py) stays as a direct vault write. Document extraction is Brain-processed output — Brain has already PII-scrubbed, LLM-extracted, rehydrated, and determined the persona. The document-to-reminder linkage depends on synchronous vault IDs (doc_id → reminder metadata → `get_vault_item` on reminder_fired). Staging would break this cross-referencing because IDs and personas are determined asynchronously by the staging processor. Brain is a trusted resolver and is explicitly allowed direct vault writes.

**Admin UI:** No admin routes perform direct vault writes — no changes needed.

### Trust Model Addition

| Channel | origin_kind | sender_trust | Confidence | Retrieval policy |
|---------|-------------|--------------|------------|-----------------|
| telegram | user | self | high | normal |
| admin | user | self | high | normal |

Telegram and admin are the highest-trust channels — the user is directly authoring content through a channel they control.

### Changes by File

**`brain/src/service/telegram.py`**
- `_store_message()`: replace `store_vault_item("default", {...})` with `staging_ingest({..., ingress_channel: "telegram", origin_kind: "user"})`
- Field name changes: `body_text` → `body` (staging API field name)

**`brain/src/service/guardian.py`**
- `_handle_document_ingest()`: KEEP as `store_vault_item` — Brain-processed output with ID cross-referencing (see exclusion note above)

**`brain/src/port/core_client.py`**
- Add `staging_ingest(item: dict) -> str` to the CoreClient protocol

**`brain/src/adapter/core_http.py`**
- `staging_ingest()` already exists (added in connector staging) — no change needed

**`core/internal/handler/staging.go`**
- Service-key callers (Brain, admin) are already allowed to set `ingress_channel` explicitly (from Phase 1)
- Device-key callers still get server-override (from Phase 1)

### Tests

| Test | File | What it verifies |
|------|------|-----------------|
| `test_telegram_memory_staged` | `tests/integration/test_staging_telegram.py` | Telegram "remember" goes through staging, not direct vault |
| `test_telegram_trust_is_self` | same | After resolve, telegram-origin item has sender_trust=self, confidence=high |
| `test_admin_import_staged` | same | Admin UI content import goes through staging |
| `test_brain_can_set_channel` | `core/test/staging_test.go` | Service-key caller can set ingress_channel=telegram |
| `test_device_cannot_set_telegram` | same | Device-key caller sending ingress_channel=telegram gets overridden to "cli" |

### Risks

| Risk | Mitigation |
|------|------------|
| Telegram bot response latency | Staging sweep is 5s — user sees slight delay. Acceptable for "remember" commands, which aren't time-critical |
| Admin bulk import performance | Current ingest accepts one item per call. If bulk import is needed, add a `/v1/staging/ingest/batch` endpoint in Phase 2 |
| Brain service-key trust | Brain CAN set ingress_channel because it authenticates via Ed25519 service key. If Brain is compromised, staging provenance is the least of the problems |

---

## Phase 3: D2D & AppView Memory Content Staged

**Prerequisite:** Phase 2 complete (Telegram/admin staging works)

### What Changes

After D2D decryption in the transport layer, any payload intended to become memory goes through staging instead of being written directly. This applies to:

- Relationship notes shared between Dinas
- Trust attestation data from the AppView/AT Protocol
- Shared context (e.g., Sancho's Dina shares "mother is ill" with Alonso's Dina)
- Product reviews/recommendations relayed between Dinas

Dead drop remains as transport durability — it handles encrypted envelope delivery and replay protection. After decryption, the content is either:
- A real-time signal (arrival notification, typing indicator) → processed immediately, NOT staged
- Memory-producing content (shared note, attestation) → staged with `ingress_channel=d2d`

### Trust Model Addition

| Channel | origin_kind | sender_trust | Confidence | Retrieval policy |
|---------|-------------|--------------|------------|-----------------|
| d2d | remote_dina (known contact) | contact ring level | medium | caveated |
| d2d | remote_dina (unknown) | unknown | low | quarantine |
| appview | service | verified (if AT Protocol signed) | medium | caveated |

D2D trust depends on the sender's position in the contact directory and trust network:
- Ring 1 (verified + actioned): trust the content, caveat the source
- Ring 2 (verified): lower confidence, caveat
- Unknown sender: quarantine until verified

### Changes by File

**`core/internal/handler/message.go`**
- After D2D decryption (`handleDecryptedMessage` or equivalent), classify payload:
  - Real-time signals → process immediately (existing path)
  - Memory-producing content (type contains "note", "attestation", "review", "context") → create staging record
- Set `ingress_channel=d2d`, `origin_did=<sender DID>`, `origin_kind=remote_dina`

**`core/internal/handler/staging.go`**
- Accept `origin_kind=remote_dina` for D2D staging
- Lookup sender in contact directory to pre-populate trust metadata

**`brain/src/service/trust_scorer.py`**
- D2D trust derivation: query contact directory for sender DID → get ring level → map to trust
- Unknown sender → `sender_trust=unknown`, `confidence=low`, `retrieval_policy=quarantine`
- Known contact → `sender_trust=contact_ring{N}`, `confidence=medium`, `retrieval_policy=caveated`

**`brain/src/service/staging_processor.py`**
- Handle D2D-origin items: include remote DID in provenance, cross-reference with trust network
- For AT Protocol attestations: verify signature chain before promoting to vault

**`core/internal/adapter/sqlite/pool.go`**
- No schema change needed — `ingress_channel` and `origin_did` fields from Phase 1 handle D2D

### Tests

| Test | File | What it verifies |
|------|------|-----------------|
| `test_d2d_memory_content_staged` | `tests/integration/test_staging_d2d.py` | D2D note goes through staging, not direct vault |
| `test_d2d_realtime_signal_not_staged` | same | Arrival notification processed immediately, not staged |
| `test_d2d_known_contact_trust` | same | Known sender gets contact ring trust level |
| `test_d2d_unknown_sender_quarantined` | same | Unknown sender content quarantined with low confidence |
| `test_d2d_dedup_by_remote_did` | `core/test/staging_test.go` | Same content from two different remote DIDs creates two staging records |
| `test_appview_attestation_staged` | `tests/integration/test_staging_appview.py` | AT Protocol attestation goes through staging with signature verification |
| USR-02 Sancho Moment update | `tests/system/user_stories/test_02_sancho_moment.py` | Sancho's arrival triggers vault recall via staging (not direct write) |

### Implementation Notes

**Core-side wiring:** D2D staging is wired in Core's ingress callbacks (main.go), not in Brain's process endpoint. After decryption + trust filtering, Core checks `D2DMemoryTypes` and calls `stagingInbox.Ingest()` directly. This avoids schema changes to Brain's `/api/v1/process` endpoint and provides correct metadata (timestamp, DIDComm type) from the transport layer.

**Dual-path staging (belt-and-suspenders):** Brain's `_handle_didcomm` also stages memory-producing content if it receives a DIDComm event via the process endpoint. Dedup by `(producer_id, source, source_id)` prevents duplicates.

### Known Gaps

**Trust model mismatch (Core ingress vs Brain vault policy):** Core's trust cache accepts D2D senders with AppView reputation score >= 0.3, even if they're not in the contact directory. Brain's trust scorer only checks the contact directory — if the DID is not a contact, it gets `quarantine` retrieval policy. This means a DID accepted by Core's trust cache but not in the user's contacts will be accepted at transport but quarantined in vault. This is the safer default: transport acceptance (broad) does not imply vault trust (strict). The user must add the sender as a contact to promote from quarantine. Future improvement: Brain could query the trust cache to derive a `caveated` policy for non-contact DIDs with verified reputation.

**Integration test coverage:** The Core-level integration test for `/msg` → decrypt → staging → resolve requires the full Docker stack (Core + Brain running) and belongs in `tests/integration/test_staging_d2d.py`. The current unit tests cover Brain-side staging logic and trust scoring. The Core staging hook is tested via build + compilation and will be exercised by the E2E Sancho Moment test (USR-02) when run against the Docker stack.

### Risks

| Risk | Mitigation |
|------|------------|
| Latency on D2D memory writes | Real-time signals (arrival, typing) are NOT staged — only memory content. 5s staging delay is acceptable for notes/attestations |
| Unknown sender flood | Rate limiting at transport layer + quarantine at staging layer. Quarantined items don't affect vault until manually approved |
| AT Protocol signature verification | Brain verifies signatures during resolve, not during ingest. Invalid signatures → item stays in staging forever (or is expired by sweep) |
| Dead drop interaction | Dead drop is transport-only. After decryption, content enters staging. No change to dead drop itself |

---

## Phase 4: Lock Down Vault Writes

**Prerequisite:** Phase 3 complete (all external content flows through staging)

### What Changes

Remove `/v1/vault/store` from the device auth allowlist. Only Brain (after staging resolution) and tightly controlled admin paths can write directly to vault. This is the final enforcement of the "one airlock" rule.

### Remaining Direct Vault Write Paths

After Phase 4, these are the ONLY paths that write directly to vault:

| Caller | Path | Why allowed |
|--------|------|-------------|
| Brain (service key) | `/v1/vault/store` | After staging resolution — Brain is the trusted resolver |
| Brain (service key) | `/v1/vault/store/batch` | Batch resolution for connector sweeps |
| Admin (CLIENT_TOKEN, scope=admin) | `/v1/vault/store` | Emergency manual writes, admin tools |
| Core internal | In-process vault writes | Persona creation, system state |

NOT allowed (removed):
| Caller | Path | What it should use instead |
|--------|------|--------------------------|
| Device (CLI/agent) | `/v1/vault/store` | `/v1/staging/ingest` |
| Connector (service key) | `/v1/vault/store` | `/v1/staging/ingest` (already does this) |

### Changes by File

**`core/internal/adapter/auth/auth.go`**
- Remove `/v1/vault/store` from `deviceAllowedPrefix` list
- Add comment: "Device clients must use /v1/staging/ingest for all memory-producing writes"

**`core/internal/middleware/auth.go`**
- The auth middleware's `AllowedForTokenKind` already returns 403 "forbidden" when path is not in the device allowlist
- Update the middleware to return an actionable error body: `{"error":"forbidden","message":"Use /v1/staging/ingest for content ingestion"}` when the blocked path is `/v1/vault/store`
- No handler-level check needed — the middleware blocks before the request reaches the handler

**`cli/src/dina_cli/main.py`**
- `remember` uses `staging_ingest` (done in Phase 1)
- `draft` uses `staging_ingest` (was `vault_store` — broken by Phase 4 lockdown)
- No remaining `vault_store` calls in any user-facing command
- `vault_store` retained in client.py for admin/debug use only

**`cli/src/dina_cli/client.py`**
- Error messages now surface the `message` field from JSON error responses (e.g. migration hints from the middleware's actionable 403)

**`docs/dina-openclaw-skill.md`**
- Update: `dina remember` now stages content, not direct vault write
- Note: content appears in vault after Brain processes it (typically <10s)

### Tests

| Test | File | What it verifies |
|------|------|-----------------|
| `TestStagingInbox_Phase4_DeviceVaultStoreLockdown` | `core/test/staging_inbox_test.go` | Device-scoped token gets 403 on `/v1/vault/store` |
| `TestStagingInbox_Phase4_BrainVaultStoreAllowed` | same | Brain service key can still write directly to vault |
| `TestStagingInbox_Phase4_AdminVaultStoreAllowed` | same | Admin CLIENT_TOKEN can still write directly to vault |
| `test_remember_uses_staging` | `cli/tests/test_commands.py` | `remember` command calls `staging_ingest`, not `vault_store` |
| `test_draft_json` | `cli/tests/test_commands.py` | `draft` command calls `staging_ingest`, not `vault_store` |
| `test_device_uses_staging_not_vault_store` | `tests/integration/test_persona_tiers.py` | Device ingests via staging (201), blocked from vault/store (403 with migration message) |

### Risks

| Risk | Mitigation |
|------|------------|
| Emergency direct writes | Admin scope still allowed. `dina-admin` can write directly if needed |
| Brain downtime | If Brain is down, staging accumulates items durably in SQLite. When Brain recovers, sweep processes backlog. No data loss |

---

## Cross-Phase Architecture Diagram

```
Phase 1 (CLI):
  dina remember → POST /api/v1/remember → staging ingest → Brain drain → classify → enrich → resolve → vault
  (synchronous: polls up to 15s, returns terminal status when possible)

Phase 2 (Telegram/Admin):
  Telegram bot → Brain → /v1/staging/ingest → staging_inbox → Brain sweep → vault
  Admin UI import → Brain → /v1/staging/ingest → staging_inbox → Brain sweep → vault

Phase 3 (D2D):
  D2D encrypted → dead drop → decrypt → classify → /v1/staging/ingest → staging_inbox → Brain sweep → vault
  D2D realtime signal → dead drop → decrypt → process immediately (no staging)

Phase 4 (Lock down):
  /v1/vault/store → Brain + Admin ONLY
  Everything else → /v1/staging/ingest → staging_inbox → Brain sweep → vault

Non-staged paths (unchanged):
  dina ask → /api/v1/reason → Brain reasoning → vault query (read, not write)
  dina validate → /v1/agent/validate → Brain guardian → decision (no vault write)
  dina session start/end → /v1/session/* → session management
  dina approvals → /v1/approvals/* → approval management
```

## Test Coverage Summary

| Phase | Go Unit | Integration | Release | CLI Unit | Total |
|-------|---------|-------------|---------|----------|-------|
| 1 (core) | 7 | 10 | 2 | 2 | 21 |
| 1 (device role) | 4 | 0 | 0 | 0 | 4 |
| 2 | 2 | 3 | 0 | 0 | 5 |
| 3 | 1 | 4 | 1 | 0 | 6 |
| 4 | 3 | 1 | 1 | 1 | 6 |
| Update existing | 0 | 1 | 1 | 2 | 4 |
| **Total** | **17** | **19** | **5** | **5** | **46** |

### OpenClaw Implication

Under this architecture:
- OpenClaw uses the CLI channel with its own device identity
- CLI stages automatically with `ingress_channel=cli`
- OpenClaw's device is registered as `origin_kind=agent` during pairing
- Therefore OpenClaw output gets `(cli, agent)` → `unknown/medium/caveated` trust
- User's personal CLI device is `origin_kind=user` → `self/high/normal` trust
- No `--source` trust hack needed — trust is derived from device registration, not caller flags
- Different trust levels for user vs agent content through the same CLI channel
