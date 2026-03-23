# Dina Flow Diagrams

Architecture flow diagrams covering every security and data path. All diagrams are Mermaid and render natively on GitHub.

---

## 1. Authentication Paths

**Use case:** Every HTTP request to Core must be authenticated. A CLI command, a Brain API call, an admin UI action, and a connector push all take different auth paths that produce different permissions.

**Example:** When you run `dina recall "office chairs"`, the CLI signs the request with your device's Ed25519 key. Core verifies the signature, sets CallerType=agent, and checks the device allowlist before forwarding to Brain.

```mermaid
flowchart TB
    REQ[Incoming Request] --> AUTH{Auth Middleware}

    AUTH -->|X-DID + X-Signature| SIG{Signature Type?}
    AUTH -->|Bearer token| BEARER[CLIENT_TOKEN]
    AUTH -->|No credentials| DENY[401 Unauthorized]

    SIG -->|Device key| DEV[CallerType = agent]
    SIG -->|Service key| SVC[CallerType = brain/user]

    DEV --> AUTHZ{Authz Check}
    SVC --> AUTHZ
    BEARER --> AUTHZ

    AUTHZ -->|Allowed| HANDLER[Request Handler]
    AUTHZ -->|Denied| FORBID[403 Forbidden]

    style DENY fill:#f66,color:#fff
    style FORBID fill:#f66,color:#fff
    style HANDLER fill:#6c6,color:#fff
```

---

## 2. Per-Service Authorization

**Use case:** Brain, admin, and connectors each get minimum-privilege access. A compromised connector cannot read vault data. A compromised admin backend cannot access vault contents.

**Example:** A Gmail connector can push emails to `/v1/staging/ingest` but cannot call `/v1/vault/query` to read your health data. Brain can read/write vaults but cannot sign DIDs or export backups.

| Endpoint | Brain | Admin | Connector |
|----------|:-----:|:-----:|:---------:|
| `/v1/vault/query` (read) | **yes** | no | no |
| `/v1/vault/store` (write) | **yes** | no | no |
| `/v1/staging/ingest` | **yes** | no | **yes** |
| `/v1/staging/claim` | **yes** | no | no |
| `/v1/persona/unlock` | no | **yes** | no |
| `/v1/devices` | no | **yes** | no |
| `/v1/export` | no | **yes** | no |
| `/v1/pair` | no | **yes** | no |
| `/v1/did/sign` | no | no | no |
| `/v1/did/rotate` | no | no | no |
| `/healthz` | **yes** | **yes** | **yes** |

Unknown service IDs are denied on all paths (fail-closed).

---

## 3. Signing Protocol

**Use case:** Every Ed25519-signed request includes a random nonce so identical payloads within the same second produce different signatures, preventing replay rejection.

**Example:** The CLI runs `dina remember "buy milk"` twice in one second. Each request gets a unique nonce, so Core accepts both instead of rejecting the second as a replay.

```mermaid
sequenceDiagram
    participant C as Client
    participant H as Core
    participant V as Verifier

    Note over C: Build payload and sign
    C->>H: POST /v1/vault/store
    Note right of C: Headers: X-DID, X-Timestamp, X-Nonce, X-Signature

    H->>V: VerifySignature(did, method, path, query, ts, nonce, body, sig)
    V->>V: Lookup DID in key registry
    V->>V: Check 5-min timestamp window
    V->>V: Rebuild canonical payload
    V->>V: Ed25519.Verify(pubkey, payload, sig)
    V->>V: Nonce cache replay check
    V-->>H: TokenService brain or TokenClient device-id
    H-->>C: 200 OK or 401 Invalid
```

---

## 4. Agent Reasoning Flow

**Use case:** User asks Dina a question. The CLI sends the query to Core, Core proxies to Brain, Brain's LLM autonomously decides which persona vaults to search, and returns a personalized answer with source citations.

**Example:** You run `dina recall "I need a new office chair for my back pain"`. Brain searches the consumer vault for chair preferences and the health vault for your back condition, then synthesizes an answer: "Given your L4-L5 disc herniation, I recommend a chair with strong lumbar support."

```mermaid
sequenceDiagram
    participant CLI as CLI
    participant CORE as Core
    participant BRAIN as Brain
    participant LLM as LLM
    participant VAULT as Vault

    CLI->>CORE: POST /api/v1/reason (device-signed)
    CORE->>BRAIN: Forward with agent context
    BRAIN->>BRAIN: Guardian handles reason event

    loop LLM Tool Loop (max 6 turns)
        BRAIN->>LLM: prompt + tools
        LLM-->>BRAIN: tool_call search_vault
        BRAIN->>CORE: POST /v1/vault/query (service-signed)
        CORE->>VAULT: AccessPersona + Query
        VAULT-->>CORE: items
        CORE-->>BRAIN: 200 items
        BRAIN->>LLM: tool results
    end

    LLM-->>BRAIN: final answer
    BRAIN-->>CORE: 200 content
    CORE-->>CLI: answer with citations
```

---

## 5. Approval Lifecycle

**Use case:** An agent tries to access sensitive health data. Core blocks it, creates an approval request, and notifies the user via Telegram. The user approves from their phone, and the next query succeeds.

**Example:** OpenClaw agent researching office chairs triggers a health vault search for "back pain". Core returns 403 approval_required. You get a Telegram message: "Agent requests health access for chair-research session." You reply `approve apr-123`. The agent retries and gets the data.

```mermaid
sequenceDiagram
    participant AG as Agent
    participant CORE as Core
    participant WS as WebSocket
    participant TG as Telegram
    participant USER as User

    AG->>CORE: Query sensitive persona
    CORE->>CORE: AccessPersona returns ErrApprovalRequired
    CORE->>CORE: Create approval request

    par Notify
        CORE->>WS: broadcast approval_needed
        CORE->>TG: send approval prompt
    end

    CORE-->>AG: 403 {"error": "approval_required", "approval_id": "apr-123"}

    USER->>TG: approve apr-123
    TG->>CORE: POST /v1/persona/approve

    CORE->>CORE: Create grant in session
    CORE->>CORE: Open sensitive vault
    CORE-->>USER: 200 approved

    AG->>CORE: Retry same query
    CORE->>CORE: hasActiveGrant = true
    CORE-->>AG: 200 items
```

---

## 6. Persona Tier Enforcement

**Use case:** Four tiers control who can access each persona's data. Default is always open. Standard requires agents to have a session grant. Sensitive requires explicit user approval. Locked requires a passphrase.

**Example:** Your "general" persona (notes, bookmarks) is open to everyone. Your "health" persona (medical records) requires approval — an agent can't read it without your explicit consent via Telegram.

```mermaid
flowchart TB
    subgraph Callers
        U[User]
        B[Brain]
        A[Agent]
    end

    subgraph Default
        D1[Always open]
    end

    subgraph Standard
        S1[Auto-approved]
        S2[Needs grant]
    end

    subgraph Sensitive
        SE1[With confirm]
        SE2[Needs approval]
    end

    subgraph Locked
        L1[Passphrase]
        L2[Always denied]
    end

    U --> D1
    U --> S1
    U --> SE1
    U --> L1

    B --> D1
    B --> S1
    B --> SE2

    A --> D1
    A --> S2
    A --> SE2
    A --> L2

    style D1 fill:#6c6,color:#fff
    style S1 fill:#6c6,color:#fff
    style S2 fill:#f90,color:#fff
    style SE1 fill:#6c6,color:#fff
    style SE2 fill:#f66,color:#fff
    style L1 fill:#fc0,color:#000
    style L2 fill:#f66,color:#fff
```

---

## 7. Agent Session Lifecycle

**Use case:** Agents work within named sessions that scope their access grants. When you end a session, all grants are revoked and sensitive vaults auto-close.

**Example:** OpenClaw starts a "chair-research" session, gets approval for health data, queries successfully. When the session ends, the health grant is revoked. A new session starts clean — no inherited permissions.

```mermaid
stateDiagram-v2
    [*] --> Active : session start
    Active --> GrantPending : query denied
    GrantPending --> GrantActive : admin approves
    GrantActive --> Active : grant consumed
    Active --> Ended : session end
    GrantActive --> Ended : session end
    Ended --> [*]
```

---

## 8. Connector Staging Pipeline

**Use case:** Connectors (Gmail, Calendar) push raw emails to Core's staging inbox. Brain claims items, classifies them into the right persona, and Core stores the classified result. Raw data is transient — only classified data lives in vaults.

**Example:** Gmail connector pushes an email from Dr. Sharma about blood test results. Brain classifies it as health persona, scores trust as "service/high/normal", generates L0/L1 summaries, and Core stores it in the health vault. A spam email from an unknown sender gets classified as "unknown/low/caveated" and quarantined.

```mermaid
sequenceDiagram
    participant CONN as Connector
    participant CORE as Core Staging
    participant BRAIN as Brain
    participant CLF as Classifier
    participant VAULT as Persona Vault

    CONN->>CORE: POST /v1/staging/ingest (connector-signed)
    CORE->>CORE: Dedup check + store raw item
    CORE-->>CONN: 201 staging_id

    BRAIN->>CORE: POST /v1/staging/claim
    CORE-->>BRAIN: items with status=received

    BRAIN->>CLF: Classify persona + score trust
    CLF-->>BRAIN: persona=health, confidence=high

    BRAIN->>CORE: POST /v1/staging/resolve
    Note over CORE: Core checks persona state

    alt Persona open
        CORE->>VAULT: Store classified item
        CORE-->>BRAIN: status=stored
    else Persona locked
        CORE->>CORE: Keep as pending_unlock
        CORE-->>BRAIN: status=pending_unlock
    end

    Note over CORE: On persona unlock
    CORE->>VAULT: DrainPending promotes items
```

---

## 9. Staging Item State Machine

**Use case:** Each staged item moves through a well-defined state machine. Leases prevent duplicate processing. Expired items are automatically cleaned up.

```mermaid
stateDiagram-v2
    [*] --> received : ingest
    received --> classifying : Brain claims (lease)
    classifying --> stored : resolve (persona open)
    classifying --> pending_unlock : resolve (persona locked)
    classifying --> failed : classification error
    classifying --> received : lease expired (sweep)
    pending_unlock --> stored : persona unlocked (Core drain)
    failed --> received : retry (sweep)
    stored --> [*]
```

---

## 10. Source Trust and Provenance

**Use case:** Every vault item carries metadata about who sent it and how reliable it is. Spam health claims are quarantined, not mixed with doctor reports. The LLM cites sources and caveats unverified claims.

**Example:** Dr. Sharma's email about blood tests gets `sender_trust=contact_ring1, confidence=high, retrieval_policy=normal`. A spam email claiming vitamin D deficiency gets `sender_trust=unknown, confidence=low, retrieval_policy=caveated`. When you ask about health issues, Dina says "You have L4-L5 disc herniation based on Dr. Sharma's reports" — not "You have vitamin D deficiency."

```mermaid
flowchart TB
    subgraph Sources
        USER_S[User input]
        CONTACT[Known contact]
        SERVICE[Verified service]
        UNKNOWN[Unknown sender]
        MARKETING[Marketing]
    end

    subgraph Trust Assignment
        SELF[self / high / normal]
        RING1[contact_ring1 / high / normal]
        SVC_T[service / high / normal]
        UNK_T[unknown / low / caveated]
        MKT_T[marketing / low / briefing_only]
    end

    subgraph Retrieval
        NORMAL[Normal search]
        CAVEATED[Included with caveat]
        QUARANTINE[Excluded from search]
        BRIEFING[Briefing only]
    end

    USER_S --> SELF --> NORMAL
    CONTACT --> RING1 --> NORMAL
    SERVICE --> SVC_T --> NORMAL
    UNKNOWN --> UNK_T --> CAVEATED
    MARKETING --> MKT_T --> BRIEFING

    style NORMAL fill:#6c6,color:#fff
    style CAVEATED fill:#f90,color:#fff
    style QUARANTINE fill:#f66,color:#fff
    style BRIEFING fill:#999,color:#fff
```

---

## 11. Tiered Content Loading (L0/L1/L2)

**Use case:** Brain loads content progressively — one-line summaries for scanning, paragraph overviews for answering, full documents only for deep dive. This reduces prompt tokens from ~50K to ~5K.

**Example:** A search returns 20 vault items. Brain sees L0 ("Blood test from Dr. Sharma, March 2026") for all 20, reads L1 (key findings: B12 low, all else normal) for the top 5, and only loads full L2 content for the one item the user asks about specifically.

```mermaid
sequenceDiagram
    participant BRAIN as Brain
    participant LLM as LLM
    participant CORE as Core

    Note over BRAIN: Phase 1 - Store L2 immediately
    BRAIN->>CORE: POST /v1/vault/store (body = L2)
    Note over CORE: FTS5 indexed, keyword search works

    Note over BRAIN: Phase 2 - Async enrichment
    BRAIN->>LLM: Generate L0 + L1 from L2 (single call)
    LLM-->>BRAIN: JSON with l0 and l1
    BRAIN->>LLM: Generate embedding from L1
    LLM-->>BRAIN: 768-dim vector
    BRAIN->>CORE: PATCH /v1/vault/item/id/enrich
    Note over CORE: L0, L1, embedding, status=ready

    Note over BRAIN: Query time - progressive loading
    BRAIN->>CORE: Search returns 20 items with L0+L1
    BRAIN->>LLM: 15 items as L0, 4 as L1, 1 as L2
    LLM-->>BRAIN: Personalized answer with citations
```

---

## 12. Vault Write Path (dina remember)

**Use case:** User saves a quick note via CLI. The item goes through Core's remember endpoint, which wraps staging ingest + Brain drain + completion polling into a single synchronous call. Brain classifies the content into the right persona, enriches it (L0/L1 summaries, embedding), and resolves it into the vault. Session is required.

**Example:** You run `dina remember "Buy ergonomic chair with lumbar support" --session chair-research`. The CLI posts to `/api/v1/remember`, Core stages the item, triggers Brain drain, and polls for up to 15 seconds. Brain classifies it into the general persona, enriches it, and resolves it. Core returns `{"status": "stored"}`. If the target persona requires approval, Core returns 202 with `{"status": "needs_approval"}`.

```mermaid
sequenceDiagram
    participant CLI as CLI
    participant CORE as Core
    participant STG as Staging Inbox
    participant BRAIN as Brain
    participant CLF as Classifier
    participant VAULT as Persona Vault

    CLI->>CORE: POST /api/v1/remember (device-signed, --session)
    Note over CORE: Session required
    CORE->>STG: Ingest (canonical provenance from auth context)
    CORE->>BRAIN: Trigger staging drain

    BRAIN->>STG: Claim item
    BRAIN->>CLF: Classify persona + score trust
    CLF-->>BRAIN: persona=general, confidence=high
    BRAIN->>CLF: Enrich (L0/L1 summaries, embedding)
    BRAIN->>CORE: POST /v1/staging/resolve
    Note over CORE: AccessPersona check (session-scoped)

    alt Persona open (default/standard)
        CORE->>CORE: Auto-open vault
        CORE->>VAULT: Store classified + enriched item
        CORE-->>BRAIN: status=stored
    else Persona needs approval (sensitive)
        CORE-->>BRAIN: status=pending_unlock
    end

    Note over CORE: Poll staging status (up to 15s)

    alt Stored
        CORE-->>CLI: 200 {"status": "stored"}
    else Needs approval
        CORE-->>CLI: 202 {"status": "needs_approval", "id": "stg_xxx"}
    else Still processing
        CORE-->>CLI: 200 {"status": "processing", "id": "stg_xxx"}
    end
```

---

## 13. Admin UI Authentication

**Use case:** You open the admin dashboard in a browser. The browser authenticates with a passphrase, gets a session cookie, and Brain proxies vault operations to Core using CLIENT_TOKEN.

**Example:** You navigate to `https://dina.local/admin/`, enter your passphrase, and see pending approval requests. You click "Approve" on an agent's health access request.

```mermaid
sequenceDiagram
    participant BR as Browser
    participant CORE as Core
    participant BRAIN as Brain

    BR->>CORE: GET /admin/
    CORE->>BRAIN: Reverse proxy
    BRAIN-->>BR: Login page

    BR->>BRAIN: POST /admin/login with passphrase
    BRAIN->>BRAIN: Verify (Argon2id)
    BRAIN-->>BR: Session cookie (HttpOnly, SameSite=Strict)

    BR->>BRAIN: GET /admin/dashboard
    BRAIN->>CORE: GET /v1/persona/approvals (Bearer token)
    CORE-->>BRAIN: Pending approvals
    BRAIN-->>BR: Dashboard
```

---

## 14. WebSocket Authentication

**Use case:** Paired devices maintain a persistent WebSocket connection for real-time push notifications (approval requests, vault updates, nudges). The upgrade must be Ed25519-signed — no token handshake.

**Example:** Your phone connects via WebSocket. When an agent requests health access, Core pushes the approval notification instantly to your phone via the WebSocket.

```mermaid
sequenceDiagram
    participant DEV as Device
    participant MW as Auth Middleware
    participant WS as WebSocket
    participant HUB as Hub

    DEV->>MW: GET /ws (Ed25519-signed upgrade)
    MW->>MW: VerifySignature
    MW->>WS: HTTP 101 Upgrade
    WS->>WS: Extract PreAuthIdentity
    WS-->>DEV: auth_ok
    WS->>HUB: Register device

    loop Connection lifetime
        HUB-->>DEV: Push notifications
        DEV->>WS: Queries
        WS-->>DEV: Responses
    end
```

---

## 15. Full Request Lifecycle

**Use case:** Every request passes through the same middleware chain in order: CORS, body limit, rate limit, authentication, authorization, then the handler with persona tier checks and gatekeeper intent evaluation.

```mermaid
flowchart TB
    REQ[Request] --> RATE[Rate Limiter]
    RATE --> AUTH[Auth Middleware]

    AUTH -->|401| REJECT1[Unauthorized]
    AUTH --> AUTHZ[Authz Middleware]

    AUTHZ -->|403| REJECT2[Forbidden]
    AUTHZ --> HANDLER[Handler]

    HANDLER --> PERSONA{Persona Tier}
    PERSONA -->|approval needed| APPROVAL[403 + approval_id]
    PERSONA -->|locked| LOCKED[403 locked]
    PERSONA -->|allowed| GK{Gatekeeper}

    GK -->|denied| GK_DENY[403]
    GK -->|allowed| OP[Execute]
    OP --> RESP[200/201]

    style REJECT1 fill:#f66,color:#fff
    style REJECT2 fill:#f66,color:#fff
    style APPROVAL fill:#f90,color:#fff
    style LOCKED fill:#f66,color:#fff
    style GK_DENY fill:#f66,color:#fff
    style RESP fill:#6c6,color:#fff
```
