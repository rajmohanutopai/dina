# Dina Simplified Architecture

This is the short architecture document for the TypeScript consolidation.

The direction is:

- `apps/mobile` is a full Home Node on Android and iPhone. It is not a wrapper.
- `apps/home-node-lite` is the server/Home Node build of the same TypeScript node.
- Shared behavior belongs in `packages/core`, `packages/brain`, and `packages/protocol`.
- Go `core/` and Python `brain/` are behavior references only. There is no
  legacy runtime support or migration layer in the greenfield TS target.
- Mobile trust publish is the best current reference for trust publishing behavior.
- Home Nodes do not need public inbound ports. They connect out to MsgBox.
- Trust/public data goes through the shared PDS and AppView.

## Behavior References

Use these as the source of truth while consolidating:

| Flow | Reference |
|---|---|
| `/remember`, staging, approval, persona gating | Main Go Core + Python Brain behavior, ported into TS |
| `/ask`, agentic tools, pending approvals | Main Go Core + Python Brain behavior, plus TS agentic ask |
| D2D send/receive envelope | TypeScript `packages/core/src/d2d` |
| Trust publish | `apps/mobile` trust write/outbox, plus `packages/core/src/trust/pds_publish.ts` |
| Service query/response | Main Go Core + Python Brain behavior, plus TS D2D service windows |

## Network Defaults

Development and preview installs should use the test fleet by default.

| Service | Test / preview | Release |
|---|---|---|
| MsgBox | `wss://test-mailbox.dinakernel.com/ws` | `wss://mailbox.dinakernel.com/ws` |
| System PDS | `https://test-pds.dinakernel.com` | `https://pds.dinakernel.com` |
| AppView | `https://test-appview.dinakernel.com` | `https://appview.dinakernel.com` |
| PLC Directory | `https://plc.directory` | `https://plc.directory` |

These endpoints move together. A node should not publish to production PDS
while advertising the test MsgBox, or query production AppView while writing test
records.

## Architecture Review

Short answer: yes, this is the right simplified architecture.

The main idea is sound: Android, iPhone, and server should all be full Home
Nodes, with the same TypeScript Core/Brain/protocol behavior and different
platform adapters. Private state stays local. Public trust and service records
go through PDS and AppView. All node-to-node traffic goes through MsgBox so a
Home Node does not need public inbound ports.

The Go/Python implementation should not be treated as the future deployment
shape. It should be treated as the mature behavior reference for flows that the
TS port must preserve: staging-first `/remember`, persona gates, pending
approvals, agentic `/ask`, service query windows, and trust/service publish
semantics. Mobile trust publish is the stronger current TS reference for trust
composition.
This is a greenfield TS Home Node target: Go and Python are behavior references,
not runtime surfaces that the TS apps need to keep supporting. No legacy support,
no normal migration path, and no old-runtime compatibility layer is part of this
architecture.

Possible mistakes to guard against:

- Do not let mobile remain the only real Home Node composition. The shared TS
  Home Node runtime must be concrete, not just a documentation idea.
- Do not let `apps/home-node-lite` become a second product shaped around the
  prior Go Core / Python Brain split. Separate processes are acceptable server
  adapters, but the behavior must come from the same TS runtime.
- Keep endpoint mode atomic. MsgBox, PDS, AppView, and PLC config must move as
  one selected mode for a given node.
- Be precise about MsgBox transport. The architecture means "through the MsgBox
  service"; current TS D2D uses MsgBox HTTP `/forward` while WebSocket handles
  relay session/RPC. If WS D2D becomes supported later, update code and docs
  together.
- Install must include a usable PDS account/session, not only DID/key material.
  Otherwise service profile publish and trust publish remain incomplete.
- `/remember` must cross a Core transport/API boundary, even on mobile. Direct
  imports into Core staging internals should be test-only.
- Do not add upgrade or compatibility behavior for earlier Go/Python or
  transitional TS runtime shapes. Runtime config and local data should be
  canonical on first write; non-canonical inputs should fail fast or be handled
  by explicit import tooling outside the Home Node runtime.
- Persona gates and approval resume must be durable before `/remember` can be
  called release-complete.
- AppView must be one configured client shared by node runtime, agentic tools,
  trust UI, and service discovery. Split AppView paths will create release
  drift.
- Trust test injection is useful for preview, but release publish must go
  through signed PDS records and durable outbox/retry.

## TS Drift Against The Target

| Area | Target | Mobile TS | Home-node-lite TS |
|---|---|---|---|
| Shared runtime | One TS Home Node runtime with platform adapters. | Partial. Mobile has the real composition in `boot_service.ts`, `boot_capabilities.ts`, and `bootstrap.ts`; those files now depend on public `@dina/core/runtime` and `@dina/brain/runtime` subpaths, but the composition is still mobile-owned. | Partial. Core binds the shared CoreRouter, and Brain consumes shared `@dina/home-node/ask-runtime` and `@dina/home-node/service-runtime`; the full server Home Node runtime is still not assembled. |
| Install / onboarding | Seed, DID, PDS account/session, DID doc with MsgBox endpoint, local vault, AppView visibility check. | Partial/strong. Mobile provisions did:plc and MsgBox endpoint and seeds personas, but PDS session/publisher lifecycle is not fully booted. | Missing. Server install/account flow is not yet a full Home Node install. |
| Endpoint defaults | Test fleet by default; release fleet only by release config. | Done for endpoint policy. Mobile MsgBox, onboarding PDS host/PLC URL, HandlePicker, OwnerName, trust AppView, and node-runtime AppView resolve through `@dina/home-node`; PDS publisher/session runtime is still incomplete. | Done for config policy. Core and Brain server config resolve hosted endpoints through `@dina/home-node`; Core uses the hosted MsgBox endpoint at boot; Brain boot constructs the hosted AppView client; PDS runtime clients and AppView route composition still need wiring. |
| Boot / reconnect | Local vault first, then MsgBox, AppView, PDS publisher, schedulers. | Partial/strong. Mobile boots Core router, in-process transport, MsgBox, D2D, a real hosted AppView client, staging drain, ask coordinator, and service loops. PDS publisher/session still degrades unless injected. | Partial. Core binds the shared CoreRouter and connects/authenticates to MsgBox by default, with `/readyz` failing instead of killing local boot when the relay is offline; storage/adapters remain pending. Brain boots health, returns `503 not_ready`, configures AppView and signed CoreClient when keyed, starts the staging drain scheduler, composes/registers ask routes when Gemini is explicitly configured, and consumes shared `@dina/home-node/service-runtime` when explicit dependencies are supplied; PDS and full runtime ownership remain unwired. |
| `/remember` | Core ingest, Brain drain, enrichment, persona gates, durable pending approvals, vault store. | Partial/strong. Mobile has one production path through Brain -> `CoreClient.stagingIngest`; staging is repository-authoritative, resolve gates are explicit, approvals are durable, enrichment runs before store, and shared transport parity tests pass. | Partial. Core has signed staging ingest, repository authority, explicit resolve gates, approval-backed locked staging rows, and the same HTTP transport contract; Brain server now starts the shared staging scheduler against a signed Core client when service-key material is provisioned. |
| `/ask` | Same coordinator/tool semantics on mobile and server. | Partial/strong. Agentic pipeline and approvals exist when prerequisites are configured. | Partial/strong. Boot now consumes shared `@dina/home-node/ask-runtime` to build the same agentic ask coordinator from signed Core, hosted AppView, approval manager, service orchestrator, and config-driven Gemini provider; remaining gap is full Home Node runtime ownership and service-response delivery parity. |
| D2D / MsgBox | Signed/sealed D2D through MsgBox with clear relay contract. | Partial/strong. Mobile wires MsgBox and `sendD2D`; current TS uses `/forward` for D2D and WS for RPC/inbox. | Partial. Core server connects to MsgBox and reports that state in readiness; full D2D/service delivery parity and the relay contract decision remain open. |
| Trust publish | Test injection for dev; release publishes signed records to PDS and reconciles through AppView. | Partial. Mobile UI/test injection and record helpers are good, but durable outbox and default PDS publish path are missing. | Missing. No full trust publish runtime. |
| Service discovery/query | Provider publishes profile to PDS; requester discovers through AppView and queries over D2D service windows. | Partial. Service workflow, D2D windows, and the requester-side hosted AppView client exist by default; provider PDS publisher is not release-ready. | Partial. Shared `@dina/home-node/service-runtime` composes discovery, handler, D2D dispatcher, workflow event delivery, and approval reconciliation with signed Core/AppView; Brain server consumes it when dependencies are supplied. MsgBox delivery, provider PDS publish, and parity tests remain. |
| Pairing / trust network | Pair through MsgBox; persist device/contact trust; enforce gates. | Partial. Contact hydration and D2D gates exist, but full pairing flow and durable trust integration need parity review. | Missing. No shared pairing runtime. |

Overall assessment: the simplified architecture is correct. The drift is in the
TS implementation, especially the incomplete shared runtime and the much larger
home-node-lite gap. Mobile is the closest current TS Home Node; home-node-lite
should be moved toward mobile's runtime shape instead of independently porting
the prior Go/Python process structure.

## One Node Shape

```mermaid
flowchart TB
    subgraph Mobile["apps/mobile: full Home Node"]
        MUI["React Native UI"]
        MCore["packages/core"]
        MBrain["packages/brain"]
        MStore["Expo storage, keychain, SQLite"]
        MUI --> MBrain
        MBrain --> MCore
        MCore --> MStore
    end

    subgraph Server["apps/home-node-lite: full Home Node"]
        API["Fastify APIs"]
        SCore["packages/core"]
        SBrain["packages/brain"]
        SStore["Node storage, key files, SQLCipher"]
        API --> SBrain
        SBrain --> SCore
        SCore --> SStore
    end

    MCore --> MsgBox["MsgBox relay"]
    SCore --> MsgBox
    MCore --> PDS["System PDS"]
    SCore --> PDS
    MBrain --> AppView["Trust AppView"]
    SBrain --> AppView
```

Mobile and server differ only in adapters:

- Mobile uses Expo adapters and in-process Core/Brain calls.
- Server Lite uses Node adapters and Fastify process boundaries.
- The protocol, vault rules, D2D envelope, trust records, and memory behavior
  should be the same.

## Install / Onboarding

During install and onboarding, the node uses the test fleet by default unless a
release configuration is explicitly selected.
The result is a local Home Node with keys, a local vault, a PDS account, a DID
document, and a MsgBox route.

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant App as Mobile or Home Node Lite
    participant Core as Shared Core
    participant Store as Local Vault and Key Store
    participant PDS as test-pds.dinakernel.com
    participant MsgBox as test-mailbox.dinakernel.com
    participant AppView as test-appview.dinakernel.com

    User->>App: Start install / onboarding
    App->>Core: Generate or load seed and signing keys
    Core->>Store: Save encrypted identity material
    User->>App: Pick owner name / handle
    App->>PDS: Check handle availability
    PDS-->>App: Available / alternatives
    App->>PDS: Create account and publish DID document
    Note over App,PDS: DID document advertises DinaMsgBox endpoint
    App->>MsgBox: Open outbound WebSocket
    MsgBox-->>App: Challenge
    App->>MsgBox: Signed challenge response
    MsgBox-->>App: Authenticated
    App->>AppView: Optional health / discovery check
    AppView-->>App: Ready
    App-->>User: Home Node ready
```

Production uses the release fleet only when release configuration is selected:
`mailbox.dinakernel.com`, `pds.dinakernel.com`, and `appview.dinakernel.com`.

## Boot / Reconnect

Boot is local first. Network services attach after the node can open its
identity and vault.

```mermaid
sequenceDiagram
    autonumber
    participant App as Home Node Runtime
    participant Store as Local Vault and Key Store
    participant Core as Shared Core
    participant Brain as Shared Brain
    participant MsgBox as MsgBox
    participant AppView as AppView

    App->>Store: Load identity, keys, role, contacts
    Store-->>App: Local node state
    App->>Core: Build Core router and vault services
    App->>Brain: Build ask, remember, staging, trust tools
    Brain->>Core: Register local tools and approval bridge
    App->>MsgBox: Connect outbound WebSocket
    MsgBox-->>App: Authenticated or degraded
    App->>AppView: Configure discovery / trust client
    App-->>App: Start background loops
```

If MsgBox is offline, local memory still works. D2D and service queries degrade
until the relay reconnects.

## `/remember`: Store Local Memory

Main behavior is staging first. Core records provenance and session context,
Brain classifies and enriches, and Core stores only after persona gates pass.

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant UI as App UI or CLI
    participant Brain as Brain Orchestrator
    participant Core as Core Staging API
    participant Staging as Core Staging
    participant Drain as Brain Staging Drain
    participant Gate as Persona Gate
    participant Vault as Local Encrypted Vault

    User->>UI: /remember "Emma likes dinosaurs"
    UI->>Brain: handleChat('/remember ...')
    Brain->>Core: CoreClient.stagingIngest(text + provenance)
    Core->>Core: Validate caller session when needed
    Core->>Staging: Ingest text with derived provenance
    Staging-->>Core: staging_id
    Core-->>Brain: staging_id
    Brain->>Drain: Trigger staging drain
    Drain->>Staging: Claim received item
    Staging-->>Drain: Text, metadata, provenance
    Drain->>Drain: Classify persona(s), sensitivity, type
    Drain->>Drain: Enrich L0, L1, embedding
    Drain->>Gate: Read accessible personas for this session
    Gate-->>Drain: Access map per target persona
    Drain->>Staging: Resolve classified item + persona access map
    Staging->>Gate: Check persona access
    Gate-->>Staging: Allowed
    Staging->>Vault: Store encrypted memory and index metadata
    Staging-->>Drain: Stored
    Drain-->>Brain: Stored
    Brain-->>UI: Stored
    UI-->>User: Confirmation
```

The main Core handler polls staging for a short window. If the item stores
quickly, `/remember` returns `stored`. If a persona approval is needed, it
returns an accepted/pending response instead of pretending the memory was stored.
Enrichment runs before Core resolve. When LLM and embedding providers are
registered, the stored row has L1, embedding, and `enrichment_status=ready`.
When a provider is unavailable or fails, the row remains `l0_complete` and
metadata records the exact skipped or failed stage.

## `/remember`: Sensitive Or Locked Persona

Sensitive memory follows the same staging path, but pauses at the persona gate.

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant UI as App UI or CLI
    participant Brain as Brain Orchestrator
    participant Core as Core Staging API
    participant Staging as Core Staging
    participant Drain as Brain Staging Drain
    participant Gate as Persona Gate
    participant Approval as Local Approval Inbox
    participant Vault as Local Encrypted Vault

    User->>UI: /remember "My HbA1c is 9"
    UI->>Brain: handleChat('/remember ...')
    Brain->>Core: CoreClient.stagingIngest(text + session)
    Core->>Staging: Ingest with provenance
    Brain->>Drain: Trigger staging drain
    Drain->>Staging: Claim and classify
    Drain->>Drain: Mark health persona / sensitive category
    Drain->>Drain: Enrich before resolve
    Drain->>Gate: Read accessible personas for this session
    Gate-->>Drain: health = locked
    Drain->>Staging: Resolve health with persona_access.health=false
    Staging->>Gate: Check persona access
    Gate-->>Staging: Not allowed
    Staging->>Staging: Mark pending_unlock
    Staging->>Approval: Create durable approval request
    Staging-->>Brain: pending_unlock
    Brain-->>UI: Accepted, needs approval
    Approval-->>User: Approve / deny
    alt Approved
    User->>Approval: Approve once or approve session
    Approval->>Staging: Resume pending item by approval_id
    Staging->>Vault: Store encrypted memory
    Staging-->>UI: Status becomes stored
    else Denied
    User->>Approval: Deny
    Approval->>Staging: Mark pending item failed
    Staging-->>UI: Status becomes denied/failed
    end
```

Multi-persona memories can fan out. Open personas store immediately; locked
personas get pending copies and approval records.

Current TS status: Core resolve now rejects missing `persona_open` /
`persona_access`, and Brain drain supplies explicit per-persona access
decisions. Locked targets become `pending_unlock` with a durable workflow
approval id. Approve drains by approval id and stores the encrypted memory;
deny marks the staging row failed with retries exhausted. Persona unlock by
itself does not store approval-gated rows.

## `/ask`: Local Reasoning

Ask is local first. The node searches its own vault, assembles context, and only
uses network services when the question requires them.

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant UI as App UI or CLI
    participant Core as Core Reason API
    participant Brain as Brain Agentic Ask
    participant Tools as Local Tools
    participant Vault as Local Encrypted Vault
    participant LLM as Optional LLM Provider
    participant Pending as Pending Reason Store

    User->>UI: /ask "What does Emma like?"
    UI->>Core: POST prompt + session
    Core->>Core: Validate caller and session
    Core->>Brain: ReasonWithContext(prompt, caller)
    Brain->>Brain: Intent classify and guard scan
    Brain->>Tools: vault_search / browse_vault
    Tools->>Vault: Search unlocked personas with access checks
    Vault-->>Tools: Relevant memories
    Tools-->>Brain: Search results and citations
    alt External LLM configured
        Brain->>Brain: Scrub PII / prepare safe context
        Brain->>LLM: Generate answer
        LLM-->>Brain: Draft answer
        Brain->>Brain: Rehydrate local placeholders
    else No external LLM
        Brain->>Brain: Use deterministic or reduced answer path
    end
    alt Answer ready inside fast path
        Brain-->>Core: Answer
        Core-->>UI: 200 answer
    else Still running or approval needed
        Core->>Pending: Create pending_reason
        Core-->>UI: 202 request_id
        UI->>Core: Poll ask status
        Core-->>UI: completed / pending / needs approval
    end
```

Main Core uses a short fast path before creating a pending reason. If Brain hits
a persona approval gate, the pending reason is tied to the approval request and
resumes after approval.

## `/ask`: Trust Context

When a question needs public trust data, the node combines local memory with
AppView results. Private memory stays local.

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant Brain as Brain Agentic Ask
    participant Tools as Agentic Tools
    participant Vault as Local Vault
    participant AppView as test-appview.dinakernel.com
    participant LLM as Optional LLM Provider

    User->>Brain: /ask "I want to buy a chair"
    Brain->>Tools: vault_search for local constraints
    Tools->>Vault: Preferences, work setup, health constraints
    Vault-->>Tools: Local context
    Tools-->>Brain: Local context
    Brain->>Tools: search_trust_network
    Tools->>AppView: Query public trust evidence
    AppView-->>Tools: Signed records, scores, subject matches
    Tools-->>Brain: Ranked evidence
    Brain->>Brain: Combine private context with public evidence
    alt LLM configured
        Brain->>LLM: Generate answer using scrubbed context
        LLM-->>Brain: Draft answer
    else No LLM configured
        Brain->>Brain: Build structured summary
    end
    Brain-->>User: Personalized answer with evidence and uncertainty
```

AppView is public trust search. PDS is public record storage. Neither should
receive raw private vault memory.

## D2D Message Through MsgBox

Every node uses outbound MsgBox transport. The sender does not need the
recipient to expose a public port.

In current TS, `DinaMsgBox` D2D egress is implemented as MsgBox HTTP
`/forward` derived from the WebSocket URL. The WebSocket session is still used
for relay connection/RPC/inbound delivery. Treat the diagram below as the
logical MsgBox relay flow, not a promise that every D2D byte is sent as a WS
frame.

```mermaid
sequenceDiagram
    autonumber
    participant Alice as Alice Home Node
    participant PDS as System PDS
    participant MsgBox as MsgBox Relay
    participant Bob as Bob Home Node
    participant BobVault as Bob Local Vault

    Alice->>PDS: Resolve Bob DID document
    PDS-->>Alice: Bob public key and DinaMsgBox endpoint
    Alice->>Alice: Build D2D v1 message
    Alice->>Alice: Sign with Ed25519 and seal with NaCl
    Alice->>MsgBox: Deliver encrypted envelope
    alt Bob online
        MsgBox->>Bob: Deliver over Bob outbound WebSocket
    else Bob offline
        MsgBox->>MsgBox: Buffer encrypted envelope
        Bob->>MsgBox: Reconnect later
        MsgBox->>Bob: Drain buffered envelope
    end
    Bob->>Bob: Unseal ciphertext
    Bob->>Bob: Verify signature, replay, type, body size
    alt Blocked sender
        Bob->>Bob: Drop
    else Service query/response
        Bob->>Bob: Use service ingress window bypass
        Bob->>Bob: Process service message
    else Known contact allowed
        Bob->>Bob: Run contact/scenario gates
        Bob->>BobVault: Stage or store message locally
    else Unknown sender
        Bob->>BobVault: Quarantine locally
    end
```

MsgBox sees routing metadata and ciphertext. It does not see the message body.

## Trust Network: Mobile Test Publish

Mobile is the best current reference for trust publish. In test builds, mobile
can publish directly to the test AppView injection endpoint when the test token
is bundled.

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant Mobile as apps/mobile Trust Write
    participant Draft as Local Draft State
    participant AppView as test-appview.dinakernel.com
    participant Outbox as Local Trust Outbox

    User->>Mobile: Write review / publish draft
    Mobile->>Mobile: Validate subject, sentiment, headline, body, confidence
    alt Test inject token available
        Mobile->>AppView: POST test inject attestation
        AppView->>AppView: Verify test token and index record
        AppView-->>Mobile: Indexed / rejected
        Mobile->>Draft: Mark lifecycle card published
    else No test token or offline
        Mobile->>Outbox: Queue local publish row
        Outbox-->>Mobile: Show queued / pending state
    end
```

This test path is for development and preview. It bypasses PDS so mobile can
validate compose, review, and AppView indexing quickly.

## Trust Network: Release Publish

Release publish should use signed records through the user's PDS, then AppView
indexes from the public repo stream.

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant Mobile as apps/mobile Trust Write
    participant Core as Trust Publish Core
    participant Outbox as Local Trust Outbox
    participant PDS as pds.dinakernel.com
    participant AppView as appview.dinakernel.com

    User->>Mobile: Publish trust review
    Mobile->>Core: Build attestation record
    Core->>Core: Validate AppView wire constraints
    Core->>Core: Canonicalize and sign with node identity
    Core->>Outbox: queued-offline or submitted-pending
    Outbox->>PDS: com.atproto.repo.createRecord
    PDS-->>Outbox: at:// URI or error
    PDS-->>AppView: Repo/firehose update
    AppView->>AppView: Verify signature and index
    Outbox->>AppView: Poll attestation status
    AppView-->>Outbox: indexed / rejected / pending
    Outbox-->>Mobile: Update published state
```

The current mobile outbox model already names the important states:
`queued-offline`, `submitted-pending`, `indexed`, `rejected`, `stuck-offline`,
and `stuck-pending`. Durable mobile persistence is the remaining implementation
detail to keep aligned with this flow.

## Trust Network: Query Review Evidence

AppView is the read path. PDS is the durable publication path.

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant Brain as Brain Agentic Ask
    participant Tools as Trust Tools
    participant Vault as Local Vault
    participant AppView as test-appview.dinakernel.com

    User->>Brain: /ask "Is ErgoMax 205 trustworthy?"
    Brain->>Tools: vault_search
    Tools->>Vault: Local constraints and preferences
    Vault-->>Tools: Local context
    Tools-->>Brain: Private context
    Brain->>Tools: search_trust_network
    Tools->>AppView: Query subject ErgoMax 205
    AppView-->>Tools: Reviews, vouches, flags, scores, signed payloads
    Tools-->>Brain: Public evidence
    Brain->>Brain: Rank by trust, relevance, and user context
    Brain-->>User: Answer with evidence and uncertainty
```

## Service Discovery And Query

Provider Dinas publish what they can answer. Requester Dinas discover providers
through AppView, then ask the provider through MsgBox.

```mermaid
sequenceDiagram
    autonumber
    participant Provider as Provider Home Node
    participant ProviderBrain as Provider Brain
    participant PDS as System PDS
    participant AppView as AppView
    participant Requester as Requester Home Node
    participant MsgBox as MsgBox

    Provider->>Provider: Configure service capability and schema
    Provider->>PDS: Publish com.dina.service.profile
    PDS-->>AppView: Repo/firehose update
    AppView->>AppView: Index provider profile

    Requester->>AppView: Search by capability and location
    AppView-->>Requester: Candidate providers
    Requester->>Requester: Create idempotent service_query workflow task
    Requester->>MsgBox: Encrypted service.query to provider DID
    MsgBox->>Provider: Deliver query
    Provider->>Provider: Validate capability, schema_hash, params
    alt Provider policy requires review
        Provider->>Provider: Create approval workflow task
        Provider-->>ProviderBrain: Notify operator
    else Provider policy allows auto
        Provider->>ProviderBrain: Create OpenClaw delegation task
    end
    ProviderBrain-->>Provider: Approved response payload
    Provider->>MsgBox: Encrypted service.response
    MsgBox->>Requester: Deliver response
    Requester->>Requester: Consume response window and complete task
```

Service messages use D2D service windows so a query/response can pass without
turning the provider into a general open inbox.

## Pairing A Second Device

Pairing also goes through MsgBox. There is no direct LAN/public-port
requirement in the default path.

```mermaid
sequenceDiagram
    autonumber
    participant Existing as Existing Home Node
    participant New as New Device
    participant MsgBox as MsgBox
    participant Store as Local Vault

    Existing->>Existing: Generate short pairing code
    Existing-->>New: User enters pairing code
    New->>New: Generate device keypair
    New->>MsgBox: Send encrypted pair request to existing DID
    MsgBox->>Existing: Relay pair request
    Existing->>Existing: Verify code and device key binding
    Existing->>Store: Register paired device
    Existing->>MsgBox: Send pair response
    MsgBox->>New: Relay pair response
    New->>New: Save paired node config
```

## What Stays Local

These should not go to PDS, AppView, or MsgBox as plaintext:

- Vault contents
- Persona data
- Health and finance memory
- User prompts and `/ask` text
- Local search results
- Approval decisions
- PII replacement maps
- Raw D2D message bodies

## What Goes To Shared Infrastructure

| Destination | Data |
|---|---|
| MsgBox | Encrypted D2D/RPC/service envelopes plus routing metadata |
| PDS | Public DID/account data and signed public trust/service records |
| AppView | Indexed public records derived from PDS firehose, plus test-only injected trust records |

The simplest rule: private life is local; public trust is signed and published;
transport is encrypted and relayed.

## Porting Checklist

Keep the TypeScript node aligned with the main behavior:

- Remember: preserve staging provenance, caller session, user-origin bypass,
  L0/L1/embedding enrichment before resolve, explicit enrichment fallback
  metadata, multi-persona fanout, and pending approval status.
- Ask: preserve fast response vs pending reason, persona approval resume,
  all-unlocked-persona vault search, trust-network tool use, service query tool
  use, PII scrub before cloud LLM calls, and final guard scan.
- D2D: preserve sign/seal, replay checks, type/body validation, blocked-sender
  drop, unknown-sender quarantine, and service bypass windows.
- Trust: use the mobile write/review/outbox behavior as the reference; test
  builds may inject into test AppView, release builds should publish signed
  records through PDS.
- Service: preserve workflow task idempotency, schema validation, review/auto
  policy, OpenClaw delegation, service.response completion, and D2D service
  windows.
