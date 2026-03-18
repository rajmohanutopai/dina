# OpenAPI Transformation: Core ↔ Brain Interface Contract

## Problem Statement

Core (Go) and Brain (Python) communicate via HTTP/JSON with no shared schema contract. Each side independently defines its types:

- **Core** defines Go structs with `json` tags — these are the wire format.
- **Brain** parses raw `dict` responses from Core and guesses field names.
- **Tests** hedge with dual-casing fallbacks: `item.get("ID", item.get("id", ""))`.
- **Enums** are bare strings — a typo like `"open"` vs `"default"` compiles fine and fails at runtime.

The result: every new consumer re-discovers the same bugs. The field-name guessing, the string-typed enums, and the duplicate type definitions are symptoms. The disease is: **no shared contract definition**.

## Diagnosis: What the Code Actually Shows

### The Casing Problem is Real but Narrow

A full audit of `core/internal/domain/` reveals a clear split:

| Category | json Tags? | Casing | Examples |
|----------|-----------|--------|----------|
| **Domain types that cross HTTP** | Yes | snake_case | VaultItem, Contact, TrustEntry, ApprovalRequest, AgentSession, StagingItem, Reminder, TaskEvent, ReasonResult |
| **Handler request/response structs** | Yes | snake_case | queryRequest, storeRequest, enrichRequest, all 16 handler files |
| **Domain types used internally** | **No** | PascalCase (Go default) | PairedDevice, PairResponse, Device, Intent, Decision, DinaMessage, PIIEntity, ScrubResult, ImportResult, ExportManifest, configs |

The PascalCase problem affects ~15 types. Of these, the ones that **cross HTTP boundaries** are:

- `PairedDevice` / `PairResponse` — device pairing endpoints
- `ImportResult` — export/import endpoints
- `ScrubResult` / `PIIEntity` — PII scrub response
- `Device` — device listing

### The Enum Problem is Systemic

These fields are bare strings with no compile-time or runtime validation:

| Field | Valid Values | Where Defined |
|-------|-------------|---------------|
| VaultItem.Confidence | high, medium, low, unverified | Comment in vault.go |
| VaultItem.RetrievalPolicy | normal, caveated, quarantine, briefing_only | Comment in vault.go |
| VaultItem.EnrichmentStatus | pending, processing, ready, failed | Comment in vault.go |
| VaultItem.SenderTrust | self, contact_ring1, contact_ring2, unknown, marketing | Comment in vault.go |
| VaultItem.SourceType | self, contact, service, unknown, marketing | Comment in vault.go |
| Reminder.Status | pending, done, dismissed | Comment in task.go |
| Reminder.Kind | payment_due, appointment, birthday | Comment in task.go |
| ApprovalRequest.Status | pending, approved, denied, expired | Comment in approval.go |
| NotifyHandler priority | fiduciary, solicited, engagement | Constants in notify.go |

Brain has proper Python enums (`IntentRisk`, `Priority`, `Sensitivity`, `SilenceDecision`) but they don't map to any Go contract.

### Brain's CoreHTTPClient Returns Raw Dicts

~30 methods in `brain/src/adapter/core_http.py` call Core endpoints and return untyped `dict`. Examples:

```python
# No type safety — caller must know the field names
async def store_vault_item(self, persona_id, item, *, user_origin=""):
    resp = await self._request("POST", "/v1/vault/store", json=body)
    data = resp.json()
    return data.get("id", data.get("item_id", ""))  # legacy fallback

# Defensive shape handling — is it a dict or a list?
async def search_vault(self, persona_id, query, ...):
    data = resp.json()
    items = data.get("items", []) if isinstance(data, dict) else data
    return items if items else []
```

This defensive parsing appears in `search_vault`, `list_personas`, `list_devices`, `get_kv` — each guessing whether Core returns a wrapped object or a bare value.

### ProcessEvent is a Polymorphic Blob

`POST /api/v1/process` accepts arbitrary JSON with a `type` field that selects behavior:

```go
// AgentHandler forwards raw bytes — no schema validation
func (h *AgentHandler) HandleValidate(w http.ResponseWriter, r *http.Request) {
    var payload map[string]interface{}
    json.NewDecoder(r.Body).Decode(&payload)
    payload["agent_did"] = authenticatedDID  // patch in-place
    payload["trust_level"] = "verified"
    patched, _ := json.Marshal(payload)
    resp, _ := h.Brain.ProcessEvent(patched)  // raw bytes in, raw bytes out
}
```

Known event types routed through this endpoint: `agent_intent`, `document_ingest`, `reminder_fired`, `delegation_request`, `cross_persona_request`, `connector_event`, `post_publish`, `reason`. Each has different required fields, but they all share one untyped `ProcessEventRequest` Pydantic model with ~16 optional fields.

### Brain Already Has OpenAPI (via FastAPI)

Brain's FastAPI app auto-generates OpenAPI from its Pydantic models. In dev/test mode:

- `/api/openapi.json` — Brain API schema
- `/api/docs` — Swagger UI
- `/admin/openapi.json` — Admin API schema

This means Brain's 3 routes already HAVE a machine-readable spec. Writing a separate hand-maintained `brain-api.yaml` would create a second source of truth.

### ReasonResult Has Three Shapes

| Location | Fields |
|----------|--------|
| Go `domain.ReasonResult` | content, model, tokens_in, tokens_out |
| Brain `ReasonResponse` (Pydantic) | content, model, tokens_in, tokens_out, **vault_context_used** |
| Brain `types.ReasonResult` (dataclass) | content, model, tokens_in, tokens_out, **finish_reason** |

Go silently drops `vault_context_used` and `finish_reason` from Brain's response.

## Solution: OpenAPI as the Single Source of Truth

### Architecture

```
api/
  components/
    schemas.yaml         # Shared domain types & enums (VaultItem, Contact, enums)
  core-api.yaml          # Core's HTTP API (~50 routes, port 8100) — hand-authored
  brain-api.yaml         # Brain's HTTP API (3 routes, port 8200) — extracted from FastAPI

core/internal/gen/       # Generated Go types from both specs
brain/src/gen/           # Generated Python types from core-api.yaml
```

### Key Design Rules

**Rule 1: Generated models replace handwritten HTTP boundary types.**

Generated types are the ONLY types used at the HTTP boundary. Hand-written domain types exist at the service layer. Translation happens at the handler/client edge. If generated types sit alongside existing types, we've made things worse (three definitions instead of two).

```
Before:  Go struct → json.Marshal → HTTP → resp.json() → dict guessing
After:   Generated Go type → json.Marshal → HTTP → Generated Pydantic model
```

**Rule 2: Ownership flows one way per service.**

Each service owns its API definition in its native format. Codegen flows outward to consumers:

```
Core HTTP contract:   hand-authored spec (core-api.yaml) → source of truth
                      → generate Python client types for Brain's CoreHTTPClient
                      → Go handlers use spec-aligned boundary DTOs

Brain HTTP contract:  FastAPI/Pydantic models → source of truth
                      → extract spec from FastAPI's /api/openapi.json
                      → generate Go client types for Core's BrainClient
```

Do NOT generate Python models from the extracted Brain spec and feed them back into Brain — that inverts ownership and creates a loop. Brain's Pydantic models stay hand-written; they ARE the contract.

**Rule 3: The spec models HTTP boundary DTOs, not domain objects.**

Many endpoints return ad-hoc response shapes, not domain structs:

| Endpoint | Actual Response | Not |
|----------|----------------|-----|
| `POST /v1/personas` | `{id, status, vault}` or `{status, vault}` | `Persona` |
| `POST /v1/pair/initiate` | `{code, expires_in}` | `PairSession` |
| `POST /v1/pair/complete` | `{device_id, node_did}` | `PairResponse` |
| `POST /v1/export` | `{status, archive_path}` | `ExportResult` |

The spec must describe what the handler actually serializes, not reuse domain structs by default. If a handler returns `map[string]string{"id": personaID, "status": "created", "vault": vaultStatus}`, the spec defines a `CreatePersonaResponse` DTO with those exact fields. Reusing domain structs in the spec when the wire format differs is how contract drift starts.

**Rule 4: `/api/v1/process` gets discriminated unions.**

The current `ProcessEventRequest` with 16 optional fields becomes `oneOf` with discriminator on `type`:

```yaml
ProcessEvent:
  discriminator:
    propertyName: type
  oneOf:
    - $ref: '#/components/schemas/AgentIntentEvent'
    - $ref: '#/components/schemas/DocumentIngestEvent'
    - $ref: '#/components/schemas/ReminderFiredEvent'
    - $ref: '#/components/schemas/DelegationRequestEvent'
    - $ref: '#/components/schemas/CrossPersonaRequestEvent'
    - $ref: '#/components/schemas/PostPublishEvent'
    - $ref: '#/components/schemas/ReasonEvent'
    - $ref: '#/components/schemas/ConnectorEvent'
```

Each variant has explicit required fields. No more 16-field optional blob.

**Rule 5: Enums are defined once in the spec.**

```yaml
# api/components/schemas.yaml
PersonaTier:
  type: string
  enum: [default, standard, sensitive, locked]

Confidence:
  type: string
  enum: [high, medium, low, unverified]

RetrievalPolicy:
  type: string
  enum: [normal, caveated, quarantine, briefing_only]
```

Go gets typed string constants via `oapi-codegen`. Python gets `str, Enum` classes via `datamodel-code-generator`. A typo is a compile/validation error, not a silent runtime bug.

**Rule 6: Sign the exact bytes produced by the generated serializer.**

Ed25519 auth signs `METHOD\nPATH\nQUERY\nTIMESTAMP\nNONCE\nSHA256(BODY)`. Generated serializers must not casually change field ordering, null-omission behavior, or encoding — otherwise signatures break. The rule: sign the actual serialized bytes, not a re-serialization.

**Rule 7: snake_case is the only wire format.**

Already true for 90%+ of Core. The untagged types (`PairedDevice`, `ImportResult`, etc.) get json tags added as a prerequisite.

### Codegen Tools

| Side | Tool | Output | What It Generates |
|------|------|--------|-------------------|
| **Go** (Core) | `oapi-codegen` v2 | `core/internal/gen/types.gen.go` | Types + enum constants. No server stubs (handlers stay hand-written). |
| **Python** (Brain) | `datamodel-code-generator` | `brain/src/gen/core_types.py` | Pydantic v2 BaseModel classes from Core spec. |
| **Go** (BrainClient) | `oapi-codegen` v2 | `core/internal/gen/brain_types.gen.go` | Request/response types for Brain's 3 endpoints. |

Note: `datamodel-code-generator` has known issues with cross-file `$ref` resolution. If `schemas.yaml` + `core-api.yaml` causes problems, use a bundling step (`swagger-cli bundle core-api.yaml -o core-api.bundled.yaml`) before Python codegen.

## Implementation Phases

### Phase 0: Prerequisites — Fix the Wire Format

**Before writing any spec, fix the code the spec will describe.**

#### 0a: Add json tags to untagged domain types

These types cross HTTP boundaries without json tags (Go defaults to PascalCase):

| File | Struct | Impact |
|------|--------|--------|
| `domain/device.go` | `Device`, `PairedDevice`, `PairResponse`, `DeviceToken` | Device listing, pairing endpoints |
| `domain/pii.go` | `PIIEntity`, `ScrubResult` | PII scrub response |
| `domain/onboarding.go` | `ImportResult`, `ExportManifest`, `ExportOptions`, `ImportOptions` | Export/import endpoints |
| `domain/intent.go` | `Intent`, `Decision` | Gatekeeper (currently internal, but logged in audit) |
| `domain/message.go` | `DinaMessage`, `DinaEnvelope`, `OutboxMessage` | D2D messaging |

Add `json:"snake_case"` tags to every field of every struct that could appear in an HTTP response or audit log.

**This is a breaking change.** `PairedDevice.TokenID` becomes `token_id` on the wire. Tests, CLI, and admin-cli code that expects PascalCase will need updating. This is an internal contract cleanup with broad test impact — call it what it is.

**Deliverable:** Standalone PR. Pure Go change + test updates. Independently reviewable.

#### 0b: Standardize response shapes

Core has inconsistent response wrapping:

| Endpoint | Current | Standard |
|----------|---------|----------|
| `GET /v1/personas` | Sometimes bare `[]`, sometimes `{"personas": [...]}` | `{"personas": [...]}` |
| `GET /v1/devices` | Sometimes bare `[]`, sometimes `{"devices": [...]}` | `{"devices": [...]}` |
| `GET /v1/vault/kv/{key}` | Sometimes bare string, sometimes `{"value": "..."}` | `{"value": "..."}` |
| `POST /v1/vault/query` | Sometimes bare `[]`, sometimes `{"items": [...]}` | `{"items": [...]}` |

Standardize: **always wrap list/value responses in an object**. This makes the spec unambiguous and removes Brain's defensive `isinstance(data, dict)` checks.

**Deliverable:** Same or separate PR from 0a. Go handler changes + Brain client cleanup.

### Phase 1: Shared Schemas + Core Vault/Staging Spec

**This is the highest-leverage work.** Brain calls ~10 vault-related Core endpoints constantly. Typed responses here eliminate the most dict-guessing.

#### 1a: Write `api/components/schemas.yaml`

Define all shared enums and the canonical `VaultItem` schema:

```yaml
# Enums
PersonaTier, Confidence, RetrievalPolicy, EnrichmentStatus,
SenderTrust, SourceType, SearchMode, SharingTier, TaskStatus,
ReminderStatus, ReminderKind, ApprovalStatus, IngressDecision,
IntentRisk, NotificationPriority

# Core domain types
VaultItem, Contact, TrustEntry, StagingItem, Reminder,
ApprovalRequest, AccessGrant, AgentSession, PairedDevice
```

#### 1b: Write Core Vault/Staging endpoints in `api/core-api.yaml`

```
POST   /v1/vault/query          — queryRequest → {items: VaultItem[]}
POST   /v1/vault/store           — storeRequest → {id: string}
POST   /v1/vault/store/batch     — storeBatchRequest → {ids: string[]}
GET    /v1/vault/item/{id}       — → VaultItem
DELETE /v1/vault/item/{id}       — → 204
PATCH  /v1/vault/item/{id}/enrich — enrichRequest → {id, enrichment_status}
GET    /v1/vault/kv/{key}        — → {value: string}
PUT    /v1/vault/kv/{key}        — {value: string} → 204
POST   /v1/staging/ingest        — ingestRequest → {id: string}
POST   /v1/staging/claim         — {limit: int} → {items: StagingItem[]}
POST   /v1/staging/resolve       — resolveRequest → StagingItem
POST   /v1/staging/fail          — {id, error} → StagingItem
```

#### 1c: Set up codegen tooling

- Add `oapi-codegen` to Go tools (`tools.go` pattern)
- Add `datamodel-code-generator` to Brain's dev deps
- Add `make generate` target (or script in `scripts/`)
- Add CI check: `make generate && git diff --exit-code`

#### 1d: Generate types and migrate

- Generate `core/internal/gen/types.gen.go` — vault/staging request/response types
- Generate `brain/src/gen/core_types.py` — Pydantic models for vault/staging responses
- Update `CoreHTTPClient` vault methods to return generated Pydantic models instead of `dict`
- Update Core vault handlers to use generated request types (replacing inline `queryRequest` etc.)
- Remove Brain's defensive `isinstance(data, dict)` checks — the generated model validates shape

**Deliverable:** PR with spec, generated code, and migrated vault/staging endpoints.

### Phase 2: Core Identity, Contact, Device, Persona APIs

Extend `core-api.yaml` with:

```
GET    /v1/did                  — → DIDDocument
POST   /v1/did/sign             — {data: hex} → {signature: hex}
GET    /v1/contacts             — → {contacts: Contact[]}
POST   /v1/contacts             — addContactRequest → Contact
PUT    /v1/contacts/{did}       — updateContactRequest → Contact
DELETE /v1/contacts/{did}       — → 204
GET    /v1/personas             — → {personas: Persona[]}
POST   /v1/personas             — createPersonaRequest → {id, status, vault} (boundary DTO, not domain Persona)
POST   /v1/persona/unlock       — unlockRequest → {status}
POST   /v1/persona/lock         — lockRequest → {status}
GET    /v1/persona/approvals    — → {approvals: ApprovalRequest[]}
POST   /v1/persona/approve      — approveRequest → ApprovalRequest
POST   /v1/persona/deny         — {id} → ApprovalRequest
GET    /v1/devices              — → {devices: PairedDevice[]}
POST   /v1/pair/initiate        — {} → {code, expires_in} (boundary DTO)
POST   /v1/pair/complete        — completePairingRequest → {device_id, node_did} (boundary DTO)
DELETE /v1/devices/{id}         — → 204
POST   /v1/session/start        — {name} → AgentSession
POST   /v1/session/end          — {id} → AgentSession
GET    /v1/sessions             — → {sessions: AgentSession[]}
```

Note: Responses marked "boundary DTO" are ad-hoc `map[string]string` or `map[string]interface{}` in the handler, not serialized domain structs. The spec defines dedicated response schemas for these.

Generate types, migrate handlers and `CoreHTTPClient` methods.

**Deliverable:** PR extending the spec + migrated endpoints.

### Phase 3: Brain API Spec + ProcessEvent Discriminated Unions

#### 3a: Extract Brain's OpenAPI from FastAPI

Brain's FastAPI sub-app (`dina_brain/app.py`) defines routes at `/v1/process`, `/v1/reason`, `/v1/pii/scrub`. But it's mounted on the master app at `/api`, so the deployed paths are `/api/v1/process`, etc. Core's BrainClient calls the deployed paths (`/api/v1/process` at brainclient.go:107).

The extracted spec must use the **deployed paths** (what Core's BrainClient actually calls):

```bash
# Extract from the sub-app (app-native paths /v1/*)
DINA_ENV=test python -m uvicorn brain.src.main:app --port 18200 &
curl http://localhost:18200/api/openapi.json > api/brain-api.extracted.json
```

Then canonicalize: either (a) spec the app-native paths and set `servers: [{url: /api}]`, or (b) rewrite paths to include the `/api` prefix. Pick one and document it. The canonical form must match what `oapi-codegen` uses to generate Go client types — if the generated client constructs `/v1/reason` but BrainClient calls `/api/v1/reason`, signatures will mismatch.

Clean up the extracted spec:
- Pin version, choose base-path convention
- Replace inline schemas with `$ref` to `components/schemas.yaml` where types overlap
- Add `securitySchemes` for Ed25519 auth (documentation, not codegen)
- Do NOT feed the extracted spec back into Brain to generate Python models — Brain's Pydantic models are the source, the spec is the derived artifact

#### 3b: Design discriminated unions for ProcessEvent

Define explicit event schemas in `brain-api.yaml`:

```yaml
paths:
  /api/v1/process:
    post:
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ProcessEvent'

components:
  schemas:
    ProcessEvent:
      discriminator:
        propertyName: type
        mapping:
          agent_intent: '#/components/schemas/AgentIntentEvent'
          document_ingest: '#/components/schemas/DocumentIngestEvent'
          reminder_fired: '#/components/schemas/ReminderFiredEvent'
          delegation_request: '#/components/schemas/DelegationRequestEvent'
          cross_persona_request: '#/components/schemas/CrossPersonaRequestEvent'
          post_publish: '#/components/schemas/PostPublishEvent'
          connector_event: '#/components/schemas/ConnectorEvent'

    AgentIntentEvent:
      required: [type, action, agent_did, trust_level]
      properties:
        type:
          type: string
          const: agent_intent
        action:
          type: string
        agent_did:
          type: string
        target:
          type: string
        trust_level:
          $ref: '#/components/schemas/TrustLevel'
        risk_level:
          $ref: '#/components/schemas/IntentRisk'
```

Each event type gets its own schema with explicit required fields.

#### 3c: Generate Go types for BrainClient

Generate `core/internal/gen/brain_types.gen.go` from the extracted+cleaned Brain spec. Update `BrainClient.Reason*` methods to use generated `ReasonRequest`/`ReasonResponse` types instead of `map[string]string`.

#### 3d: Update Brain's ProcessEventRequest

Brain's current 16-field `ProcessEventRequest` Pydantic model becomes the discriminated union. FastAPI supports `Discriminator` with Pydantic v2. The route handler dispatches on `type` using the typed variants.

**Deliverable:** PR with Brain spec extraction, discriminated unions, generated Go types, migrated BrainClient.

### Phase 4: Remaining Endpoints + Cleanup

#### 4a: Complete Core spec

Add remaining endpoints to `core-api.yaml`:

```
POST   /v1/agent/validate       — AgentIntentEvent → ProcessEventResponse
POST   /v1/notify               — notifyRequest → {status, priority}
POST   /v1/reminder             — storeReminderRequest → {id}
GET    /v1/reminders/pending     — → {reminders: Reminder[]}
POST   /v1/pii/scrub            — {text} → ScrubResult
POST   /v1/audit/append          — auditEntry → {id}
GET    /v1/audit/query           — ?action=&persona=&limit= → {entries: AuditEntry[]}
POST   /v1/task/ack              — {task_id} → {status}
GET    /v1/trust/cache           — → {entries: TrustEntry[]}
GET    /v1/trust/stats           — → TrustCacheStats
POST   /v1/trust/sync            — → {synced_count}
GET    /v1/trust/resolve         — ?did={did} → TrustProfile (passthrough)
POST   /v1/msg/send              — sendRequest → {status}
GET    /v1/msg/inbox             — → {messages: DinaMessage[]}
POST   /v1/export                — exportRequest → {status, archive_path} (boundary DTO)
POST   /v1/import                — importRequest → ImportResult
POST   /api/v1/reason            — ReasonRequest → ReasonResponse (proxy)
GET    /healthz                   — → {status}
GET    /readyz                    — → {status, checks}
```

#### 4b: Deprecate hand-written boundary types

Replace boundary types following the ownership rule:

**Core side (spec is source → generated types replace hand-written boundary structs):**

| Hand-written | Generated replacement |
|-------------|----------------------|
| `handler/vault.go::queryRequest` | `gen.QueryRequest` |
| `handler/vault.go::storeRequest` | `gen.StoreRequest` |
| `handler/vault.go::enrichRequest` | `gen.EnrichRequest` |
| `handler/persona.go::createPersonaRequest` | `gen.CreatePersonaRequest` |
| `handler/device.go::completePairingRequest` | `gen.CompletePairingRequest` |

**Brain side (Pydantic is source → stays hand-written; generated types only for Core's Go client):**

| Brain model (stays) | Generated Go equivalent (for BrainClient) |
|---------------------|-------------------------------------------|
| `routes/reason.py::ReasonRequest` | `gen.BrainReasonRequest` |
| `routes/reason.py::ReasonResponse` | `gen.BrainReasonResponse` |
| `routes/process.py::ProcessEventRequest` | `gen.BrainProcessEventRequest` (discriminated union) |
| `routes/process.py::ProcessEventResponse` | `gen.BrainProcessEventResponse` |

**Brain's Core client (spec is source → generated Python types replace dict access):**

| Hand-written | Generated replacement |
|-------------|----------------------|
| `brain/adapter/core_http.py` → returns `dict` | Returns `gen.core_types.VaultItem`, `gen.core_types.StoreResponse`, etc. |
| `brain/domain/types.py::VaultItem` | `gen.core_types.VaultItem` (for Core API responses) |

Domain types (`domain.VaultItem` in Go) remain for internal/service use. Translation happens at the handler/client boundary.

### Testing Strategy

Tests are the highest-risk area of this transformation. The codebase has 5 test tiers (unit, integration, E2E, system, release) with 850+ tests, 60+ mock classes, and pervasive field-name assumptions baked into assertions. Each phase changes the wire format or type shapes, and tests must be updated **in the same PR** as the code change — never separately. A green test suite is the gate for every merge.

#### Principle: Tests Change With the Code, Not After

Every phase that changes wire format or response shapes includes its test fixes. The sequence within each PR is:

1. Make the code change (add json tags, standardize response, swap to generated types)
2. Run the full test suite — collect all failures
3. Fix every failing assertion in the same PR
4. Green suite = merge

Never land a code change that "will break tests fixed in a follow-up PR." That creates a window where `main` is red.

#### Phase 0a Test Impact: json Tag Additions (Highest Risk)

Adding `json:"snake_case"` tags to `PairedDevice`, `Device`, `ImportResult`, `ScrubResult`, `PIIEntity` changes their wire format from PascalCase to snake_case. This is a broad internal breaking change.

**Affected test tiers and known patterns:**

| Tier | Files | Pattern | Example |
|------|-------|---------|---------|
| **E2E** | `tests/e2e/test_*.py` | `item["TokenID"]`, `device["Name"]` | `test_05_agent_gateway.py` — PairedDevice fields |
| **System** | `tests/system/user_stories/test_05_*.py`, `test_08_*.py` | `result["FilesRestored"]`, `device.get("TokenID")` | Story 05 (device list), Story 08 (import result) |
| **Integration** | `tests/integration/test_*.py` | `item.get("ID")`, dual-casing fallbacks | Vault item assertions, device pairing |
| **Release** | `tests/release/test_*.py` | Device listing assertions | REL scenarios with paired agents |
| **Go unit** | `core/test/*_test.go` | May use raw JSON with PascalCase expectations | PII, device, export tests |

**Migration approach:**

1. `grep -rn "TokenID\|FilesRestored\|PersonaCount\|RequiresRepair\|RequiresRestart\|PIIEntity\|ScrubResult" tests/` — find every PascalCase reference to the affected types
2. Also grep Go tests: `grep -rn "TokenID\|FilesRestored" core/test/`
3. Bulk-rename all field access to snake_case
4. For tests that use both cases (`item.get("Summary", item.get("summary", ""))`), simplify to snake_case only
5. Run all 5 tiers: `./run_all_tests.sh --continue`

**Estimated scope:** 50-100 assertion changes across 10-20 test files.

#### Phase 0b Test Impact: Response Shape Standardization

Standardizing Core's responses (e.g., `GET /v1/personas` always returns `{"personas": [...]}` instead of sometimes a bare `[]`) changes what tests receive.

**Affected patterns:**

| Test code | Before | After |
|-----------|--------|-------|
| `resp.json()` expecting a list | `[{"name": "personal"}, ...]` | `{"personas": [{"name": "personal"}, ...]}` |
| `resp.json()` expecting bare value | `"some_value"` | `{"value": "some_value"}` |

Brain's `CoreHTTPClient` defensive checks (`isinstance(data, dict)`) protect it from this change, but tests that call Core directly (integration, E2E, system) may not have the same guards.

**Migration approach:**

1. Update handler to always wrap
2. Update `CoreHTTPClient` to remove defensive checks (now unnecessary)
3. Update tests that call the endpoint directly to unwrap the response
4. Run full suite

#### Phase 1-4 Test Impact: Generated Types

When handlers switch from inline structs to generated types, the wire format should not change (the spec describes the existing format). But subtle differences can appear:

- **`omitempty` behavior:** Generated types may include `omitempty` on fields that the inline struct didn't, or vice versa. A test asserting `"embedding": null` might get no `embedding` field at all.
- **Field ordering:** JSON field order may change. Tests that compare raw JSON strings will break. Tests that parse and compare fields are safe.
- **Extra fields:** Generated types from the spec may include fields the old inline struct didn't have. Tests doing exact-match comparison (`assert resp.json() == expected_dict`) will fail if new fields appear.

**Migration approach:**

- Prefer field-by-field assertions over whole-dict comparison
- After switching to generated types, run the tier that exercises those endpoints and fix assertions
- For integration mock classes: update the mock to return dicts matching the generated type's field set

#### Integration Mock Classes (60+ mocks)

`tests/integration/mocks/` contains hand-written mock implementations that return raw dicts. These must be updated to return shapes matching the spec:

| Mock | What it returns | Migration |
|------|----------------|-----------|
| `MockVault` | `{"id": "...", "Type": "note", ...}` | Switch to spec-compliant snake_case fields |
| `MockGoCore` | Device lists with PascalCase | Switch to snake_case |
| `MockPIIScrubber` | `ScrubResult` with PascalCase | Switch to snake_case |
| `MockPairingManager` | `PairResponse` with PascalCase | Switch to snake_case |

These mock updates should happen in Phase 0a (json tag change) since the mocks mirror Core's wire format.

#### E2E Multi-Node Tests

The E2E suite (`tests/e2e/`) runs 4 Docker nodes (Don Alonso, Sancho, ChairMaker, Albert). Tests call Core APIs directly via HTTP and assert on response field names. Every PascalCase field access must be updated.

**Key files:** `tests/e2e/conftest.py` (actor setup), `tests/e2e/real_nodes.py` (HTTP helpers — contains `item_data.get("ID")`), `tests/e2e/real_clients.py`.

#### System User Story Tests

The 14 user story tests (`tests/system/user_stories/test_01_*.py` through `test_14_*.py`) call Core and Brain via HTTP. Stories that exercise device pairing (05), export/import (08), PII scrubbing, and device listing are affected by Phase 0a.

#### ProcessEvent Discriminated Union (Phase 3)

When Brain's `ProcessEventRequest` changes from a 16-field optional blob to typed discriminated variants, tests that send partial/mismatched event payloads may fail validation:

```python
# Before: any combination of fields accepted
brain_signer.post("/api/v1/process", json={"type": "agent_intent", "action": "search"})

# After: AgentIntentEvent requires agent_did, trust_level — missing fields → 422
```

**Migration approach:**

1. Identify all test calls to `/api/v1/process` and `/v1/agent/validate`
2. Ensure each provides the required fields for its event type
3. Tests that intentionally send malformed payloads (negative tests) should assert 422, not 200

#### CI Test Pipeline

Each phase PR must pass the full pipeline before merge:

```
Phase 0a PR:  go test ./... && pytest tests/integration/ && ./scripts/run_e2e_all.sh
Phase 0b PR:  same
Phase 1 PR:   same + make generate && git diff --exit-code
Phase 2+ PR:  same
```

The `make generate && git diff --exit-code` gate (added in Phase 1c) ensures the spec and generated code stay in sync from Phase 1 onward.

#### Test Helpers: Spec-Aware Assertions (Optional)

Consider adding a small test utility that validates response bodies against the OpenAPI spec at test time:

```python
# tests/conftest.py or tests/helpers.py
def assert_matches_spec(response_json, schema_name):
    """Validate response against OpenAPI schema at test time."""
    # Load schema from api/core-api.yaml
    # Validate response_json against components.schemas[schema_name]
    # Fail with clear diff if mismatch
```

This is optional but powerful — it catches contract drift in tests before it reaches production. Libraries like `openapi-core` or `jsonschema` can validate against the spec.

### Phase 5: Documentation and CI

- Update `ARCHITECTURE.md` to document the OpenAPI-first pattern
- Update `CLAUDE.md` build section with `make generate` instructions
- Add linting: `spectral lint api/*.yaml` in CI
- Add drift gate: `make generate && git diff --exit-code` in CI
- Document the signing canonicalization constraint

## Risk Registry

| Risk | Severity | Mitigation |
|------|----------|------------|
| PairedDevice PascalCase → snake_case breaks CLI/admin-cli | Medium | Update simultaneously. No external consumers yet. |
| Response shape standardization (Phase 0b) breaks Brain | Medium | Brain already handles both shapes defensively. Remove defensive code after Core is fixed. |
| `datamodel-code-generator` chokes on cross-file `$ref` | Low | Bundle step: `swagger-cli bundle` before Python codegen. |
| Generated serializer changes field order → signature mismatch | High | Rule 6: sign actual serialized bytes. Test signing round-trip in CI. |
| ProcessEvent discriminated unions too complex for oapi-codegen | Medium | Fallback: generate base types, hand-write the discriminator dispatch. |
| Generated types alongside hand-written types → 3 definitions | High | Rule 1: generated types REPLACE boundary types. Enforce in code review. |
| Large PR blocks development | Medium | Each phase is a separate PR. Phase 0 is independently mergeable. |
| Phase 0a json tag change breaks 50-100 test assertions | Medium | Grep + bulk-fix in same PR. Run all 5 tiers before merge. Known scope: PairedDevice, ImportResult, ScrubResult, PIIEntity, Device. |
| ProcessEvent discriminated unions break tests sending partial payloads | Medium | Audit all test calls to `/api/v1/process` and `/v1/agent/validate`. Add required fields. Negative tests should assert 422. |
| `omitempty` differences between generated and hand-written types | Low | Field-by-field assertions, not whole-dict comparison. Audit `omitempty` tags in generated output. |
| 60+ integration mocks return stale shapes after spec migration | Medium | Update mocks in same PR as the code change. Consider spec-aware assertion helper for ongoing validation. |

## Success Criteria

1. **Zero dual-casing fallbacks** in Brain's `CoreHTTPClient` — every method returns a typed Pydantic model.
2. **Zero bare-string enums** at HTTP boundaries — all enum fields reference the spec.
3. **ProcessEvent has typed variants** — each event type has explicit required fields.
4. **CI catches drift** — changing a Go struct field without updating the spec fails the build.
5. **One source of truth per API** — Core spec is hand-authored, Brain spec is extracted from FastAPI.
6. **All 5 test tiers green at every phase merge** — no "tests will be fixed in a follow-up." Each PR includes its test fixes.
7. **Integration mocks match spec shapes** — mock return values validated against the same contract as real responses.

## Non-Goals

- **gRPC migration** — HTTP/JSON is the right transport for this architecture (Go Core + Python Brain + CLI consumers).
- **Full server stub generation** — Handlers contain business logic and stay hand-written.
- **External API versioning** — No external consumers yet. Internal contract cleanup only.
- **Changing auth mechanism** — Ed25519 signature middleware stays unchanged. Only the signed payload format is documented.
