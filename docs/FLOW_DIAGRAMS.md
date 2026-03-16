# Dina Flow Diagrams

Architecture flow diagrams for every security-relevant path. All diagrams are Mermaid — they render natively on GitHub.

---

## 1. Authentication Paths

Three authentication methods, each producing different context for downstream authorization.

```mermaid
flowchart TB
    subgraph "HTTP Request"
        REQ[Incoming Request]
    end

    REQ --> AUTH{Auth Middleware}

    AUTH -->|"X-DID + X-Signature<br/>Device key"| DEV[Device Ed25519]
    AUTH -->|"X-DID + X-Signature<br/>Service key"| SVC[Service Ed25519]
    AUTH -->|"Bearer token"| BRR[CLIENT_TOKEN]
    AUTH -->|"No credentials"| DENY[401 Unauthorized]

    DEV --> DEV_CTX["TokenKind=client<br/>Scope=device<br/>CallerType=agent<br/>AgentDID=device_id"]
    SVC --> SVC_CTX["TokenKind=service<br/>Scope=serviceID<br/>ServiceID=brain|admin|connector<br/>CallerType=brain|user"]
    BRR --> BRR_CTX["TokenKind=client<br/>Scope=admin|device<br/>CallerType=user|agent"]

    DEV_CTX --> AUTHZ{Authz Middleware}
    SVC_CTX --> AUTHZ
    BRR_CTX --> AUTHZ

    AUTHZ -->|"Allowed"| HANDLER[Request Handler]
    AUTHZ -->|"Denied"| FORBID[403 Forbidden]

    style DENY fill:#f66,color:#fff
    style FORBID fill:#f66,color:#fff
    style HANDLER fill:#6c6,color:#fff
```

---

## 2. Per-Service Authorization (Least Privilege)

Each service identity gets its own endpoint allowlist. Unknown services are denied on all paths.

```mermaid
flowchart LR
    subgraph "Service Keys"
        BRAIN["brain"]
        ADMIN["admin"]
        CONN["connector"]
        UNKNOWN["unknown"]
    end

    subgraph "Vault Operations"
        VQ["/v1/vault/query"]
        VS["/v1/vault/store"]
    end

    subgraph "Admin Operations"
        PU["/v1/persona/unlock"]
        DV["/v1/devices"]
        EX["/v1/export"]
        PR["/v1/pair"]
    end

    subgraph "Security Operations"
        DS["/v1/did/sign"]
        DR["/v1/did/rotate"]
    end

    BRAIN -->|"✓"| VQ
    BRAIN -->|"✓"| VS
    BRAIN -->|"✗"| PU
    BRAIN -->|"✗"| DS

    ADMIN -->|"✗"| VQ
    ADMIN -->|"✗"| VS
    ADMIN -->|"✓"| PU
    ADMIN -->|"✓"| DV
    ADMIN -->|"✓"| EX
    ADMIN -->|"✓"| PR

    CONN -->|"✗"| VQ
    CONN -->|"✓"| VS
    CONN -->|"✗"| PU
    CONN -->|"✗"| DS

    UNKNOWN -->|"✗"| VQ
    UNKNOWN -->|"✗"| PU
    UNKNOWN -->|"✗"| DS

    style BRAIN fill:#36f,color:#fff
    style ADMIN fill:#f90,color:#fff
    style CONN fill:#693,color:#fff
    style UNKNOWN fill:#f66,color:#fff
```

---

## 3. Signing Protocol (6-Part Canonical Payload)

Every Ed25519-signed request uses this format. The nonce prevents same-second replay collisions.

```mermaid
sequenceDiagram
    participant C as Client (CLI/Brain)
    participant H as Core HTTP
    participant V as Verifier (auth.go)

    Note over C: Generate 16-byte random nonce
    Note over C: Build canonical payload:<br/>{METHOD}\n{PATH}\n{QUERY}<br/>\n{TIMESTAMP}\n{NONCE}<br/>\n{SHA256(BODY)}
    Note over C: Ed25519.Sign(payload)

    C->>H: POST /v1/vault/store<br/>X-DID: did:key:z6Mk...<br/>X-Timestamp: 2026-03-16T14:30:00Z<br/>X-Nonce: a1b2c3d4e5f6...<br/>X-Signature: aabb...

    H->>V: VerifySignature(did, method, path,<br/>query, timestamp, nonce, body, sig)
    V->>V: Lookup DID → service or device key
    V->>V: Check timestamp within 5-min window
    V->>V: Rebuild canonical payload with nonce
    V->>V: Ed25519.Verify(pubkey, payload, sig)
    V->>V: Check nonce cache (replay protection)
    V->>V: Add signature to nonce cache

    V-->>H: (TokenService, "brain") or (TokenClient, "device-id")
    H-->>C: 200 OK / 401 Invalid
```

---

## 4. Agent Reasoning Flow (dina recall)

The full path from CLI to vault, through Brain's LLM reasoning loop. Agents are persona-blind — Brain decides which personas to search.

```mermaid
sequenceDiagram
    participant CLI as CLI (dina recall)
    participant CORE as Core
    participant BRAIN as Brain
    participant LLM as LLM (Gemini/Local)
    participant VAULT as Vault (SQLCipher)

    CLI->>CORE: POST /api/v1/reason<br/>{prompt, X-Session}<br/>[Ed25519 device signature]

    Note over CORE: Auth: CallerType=agent<br/>AgentDID=device_id

    CORE->>CORE: ReasonHandler: forward agent<br/>context only if CallerType=agent

    CORE->>BRAIN: POST /api/v1/reason<br/>{prompt, agent_did, session}<br/>[Ed25519 service signature]

    Note over BRAIN: Auth: verify Core's service key

    BRAIN->>BRAIN: Guardian._handle_reason()

    loop Agentic Tool Loop (max 6 turns)
        BRAIN->>LLM: prompt + tool declarations
        LLM-->>BRAIN: tool_call: search_vault("health", "back pain")

        BRAIN->>CORE: POST /v1/vault/query<br/>{persona: health, query: back pain}<br/>X-Agent-DID: device_id<br/>X-Session: chair-research<br/>[Ed25519 service signature]

        Note over CORE: Auth: service key + X-Agent-DID<br/>→ CallerType overridden to "agent"

        CORE->>VAULT: AccessPersona("health")<br/>→ check tier + session grant

        alt Grant exists
            VAULT-->>CORE: items[]
            CORE-->>BRAIN: 200 {items: [...]}
        else No grant (sensitive/standard)
            CORE-->>BRAIN: 403 approval_required
            BRAIN-->>BRAIN: ApprovalRequiredError propagates
            BRAIN-->>CORE: 403 {error: approval_required}
            CORE-->>CLI: 403 {error: approval_required}
            Note over CLI: "Access requires approval.<br/>Notification sent."
        end

        BRAIN->>LLM: tool results
    end

    LLM-->>BRAIN: final text response
    BRAIN-->>CORE: 200 {content: "...", vault_context_used: true}
    CORE-->>CLI: 200 {content: "..."}
```

---

## 5. Approval Lifecycle

From initial denial through user approval to successful retry.

```mermaid
sequenceDiagram
    participant AG as Agent (CLI)
    participant CORE as Core
    participant PM as PersonaManager
    participant WS as WebSocket Hub
    participant BRAIN as Brain
    participant TG as Telegram
    participant ADMIN as Admin User

    AG->>CORE: vault query on sensitive persona<br/>(via Brain or direct store)

    CORE->>PM: AccessPersona("health")
    PM-->>CORE: ErrApprovalRequired

    CORE->>PM: RequestApproval({<br/>  clientDID, personaID,<br/>  sessionID, action, reason<br/>})
    PM-->>CORE: approval_id = "apr-123"

    par Notification delivery
        CORE->>WS: broadcast {type: approval_needed,<br/>id: apr-123, persona: health}
        CORE->>BRAIN: Process({type: approval_needed, ...})
        BRAIN->>TG: send_approval_prompt({<br/>  id, persona, agent, session, reason})
        TG-->>ADMIN: "Agent requests health access.<br/>Reply: approve apr-123"
    end

    CORE-->>AG: 403 {error: approval_required,<br/>approval_id: apr-123}

    Note over ADMIN: Reviews request

    alt Approve via Telegram
        ADMIN->>TG: "approve apr-123"
        TG->>BRAIN: handle_approval_response()
        BRAIN->>CORE: POST /v1/persona/approve<br/>{id: apr-123, scope: session}
    else Approve via Admin UI
        ADMIN->>CORE: POST /v1/persona/approve<br/>{id: apr-123, scope: session}
    end

    CORE->>PM: ApproveRequest("apr-123", "session")
    PM->>PM: Create AccessGrant in session
    PM->>PM: Open sensitive vault (if closed)
    PM->>PM: MarkGrantOpened (for auto-close)
    CORE-->>ADMIN: 200 {status: approved}

    Note over AG: Retry same query

    AG->>CORE: vault query on "health"<br/>(same session)
    CORE->>PM: AccessPersona("health")
    PM->>PM: hasActiveGrant() → true
    PM-->>CORE: nil (access granted)
    CORE-->>AG: 200 {items: [...]}
```

---

## 6. Persona Tier Enforcement Matrix

How each tier responds to each caller type.

```mermaid
flowchart TB
    subgraph "Caller Types"
        USER["User (admin)"]
        BRAIN_C["Brain"]
        AGENT["Agent (device)"]
    end

    subgraph "Default Tier"
        D_U["✓ Always open"]
        D_B["✓ Always open"]
        D_A["✓ Always open"]
    end

    subgraph "Standard Tier"
        S_U["✓ Auto-approved"]
        S_B["✓ Auto-approved"]
        S_A["❌ Needs session grant"]
    end

    subgraph "Sensitive Tier"
        SE_U["✓ With confirmation"]
        SE_B["❌ Needs grant"]
        SE_A["❌ Needs grant + approval"]
    end

    subgraph "Locked Tier"
        L_U["✓ Passphrase required"]
        L_B["❌ Always denied"]
        L_A["❌ Always denied"]
    end

    USER --> D_U
    USER --> S_U
    USER --> SE_U
    USER --> L_U

    BRAIN_C --> D_B
    BRAIN_C --> S_B
    BRAIN_C --> SE_B
    BRAIN_C --> L_B

    AGENT --> D_A
    AGENT --> S_A
    AGENT --> SE_A
    AGENT --> L_A

    style D_U fill:#6c6,color:#fff
    style D_B fill:#6c6,color:#fff
    style D_A fill:#6c6,color:#fff
    style S_U fill:#6c6,color:#fff
    style S_B fill:#6c6,color:#fff
    style S_A fill:#f90,color:#fff
    style SE_U fill:#6c6,color:#fff
    style SE_B fill:#f90,color:#fff
    style SE_A fill:#f66,color:#fff
    style L_U fill:#fc0,color:#000
    style L_B fill:#f66,color:#fff
    style L_A fill:#f66,color:#fff
```

---

## 7. Agent Session Lifecycle

Sessions scope access grants. All grants revoked when the session ends.

```mermaid
stateDiagram-v2
    [*] --> Created: POST /v1/session/start<br/>{name: "chair-research"}

    Created --> Active: Session created<br/>ID assigned, grants=[]

    Active --> GrantPending: Agent queries sensitive persona<br/>→ 403 approval_required

    GrantPending --> GrantActive: Admin approves<br/>→ grant added to session

    GrantActive --> Active: Query succeeds (200)<br/>Single-use grant consumed

    GrantActive --> GrantActive: Session-scoped grant<br/>persists across queries

    Active --> Ended: POST /v1/session/end
    GrantActive --> Ended: POST /v1/session/end

    Ended --> [*]: All grants revoked<br/>Grant-opened vaults closed

    note right of GrantPending
        Approval request created
        Notification sent via
        WebSocket + Telegram
    end note

    note right of Ended
        Different agents have
        isolated sessions —
        Agent B cannot use
        Agent A's grants
    end note
```

---

## 8. Vault Write Path (dina remember)

Direct write to default-tier persona — the intentional exception to "agents go through Brain."

```mermaid
sequenceDiagram
    participant CLI as CLI (dina remember)
    participant CORE as Core
    participant PM as PersonaManager
    participant GK as Gatekeeper
    participant VAULT as Vault (SQLCipher)

    CLI->>CORE: POST /v1/vault/store<br/>{persona: general, item: {...}}<br/>[Ed25519 device signature]

    Note over CORE: Auth: CallerType=agent<br/>Authz: /v1/vault/store in device allowlist

    CORE->>PM: AccessPersona("general")
    Note over PM: Tier=default → always allowed
    PM-->>CORE: nil

    CORE->>CORE: IsOpen("general") → true

    CORE->>GK: EvaluateIntent({<br/>  action: vault_write,<br/>  persona: general,<br/>  agentDID: device_id})
    GK-->>CORE: {allowed: true}

    CORE->>VAULT: Store(persona, item)
    VAULT-->>CORE: item_id

    CORE-->>CLI: 201 {id: "item-abc123"}
```

---

## 9. Admin UI Authentication Flow

Browser authenticates via passphrase, Brain proxies to Core with CLIENT_TOKEN.

```mermaid
sequenceDiagram
    participant BR as Browser
    participant CORE as Core
    participant BRAIN as Brain Admin UI

    BR->>CORE: GET /admin/
    Note over CORE: /admin/* bypasses auth,<br/>reverse-proxies to Brain

    CORE->>BRAIN: GET /admin/
    BRAIN-->>BR: Login page

    BR->>BRAIN: POST /admin/login<br/>{passphrase: "..."}
    BRAIN->>BRAIN: Verify passphrase (Argon2id)
    BRAIN-->>BR: Set-Cookie: dina_session=<id><br/>HttpOnly; SameSite=Strict

    BR->>BRAIN: GET /admin/dashboard<br/>Cookie: dina_session=<id>

    Note over BRAIN: Session valid → render dashboard

    BRAIN->>CORE: GET /v1/persona/approvals<br/>Authorization: Bearer <CLIENT_TOKEN>

    Note over CORE: Bearer auth → CallerType=user<br/>Full admin access

    CORE-->>BRAIN: {approvals: [...]}
    BRAIN-->>BR: Dashboard with pending approvals
```

---

## 10. WebSocket Authentication (Ed25519-only)

WebSocket upgrade must be Ed25519-signed. No token handshake — auth happens at the HTTP layer.

```mermaid
sequenceDiagram
    participant DEV as Paired Device
    participant MW as Auth Middleware
    participant WS as WebSocket Handler
    participant HUB as WS Hub

    DEV->>MW: GET /ws<br/>X-DID: did:key:z6Mk...<br/>X-Timestamp: ...<br/>X-Nonce: ...<br/>X-Signature: ...<br/>Upgrade: websocket

    MW->>MW: VerifySignature()
    MW->>MW: Set context:<br/>TokenKind=client<br/>Scope=device

    MW->>WS: HTTP 101 Upgrade

    WS->>WS: Extract PreAuthIdentity<br/>from context (kind=client,<br/>scope=device)

    WS->>WS: MarkAuthenticated(device_id)

    WS-->>DEV: {type: auth_ok,<br/>device_name: device_id}

    WS->>HUB: Register(device_id, conn)

    Note over HUB: Flush buffered messages

    loop Connection lifetime
        HUB-->>DEV: Push: approval notifications,<br/>vault updates, nudges
        DEV->>WS: {type: query, payload: ...}
        WS-->>DEV: {type: whisper, payload: ...}
    end

    Note over DEV: Unsigned upgrade → 401
    Note over DEV: Bearer token upgrade →<br/>PreAuth=nil → ErrAuthFailed
```

---

## 11. Full Request Lifecycle (End-to-End)

Every request passes through these checkpoints in order.

```mermaid
flowchart TB
    REQ["Incoming HTTP Request"] --> CORS["CORS Middleware"]
    CORS --> BODY["Body Size Limit (1MB)"]
    BODY --> RECOVER["Recovery (panic handler)"]
    RECOVER --> LOG["Request Logging"]
    LOG --> RATE["Rate Limiter (per-IP)"]
    RATE --> AUTH["Auth Middleware<br/>(Ed25519 / Bearer)"]

    AUTH -->|"401"| REJECT1["Unauthorized"]
    AUTH -->|"Authenticated"| AUTHZ["Authz Middleware<br/>(per-service allowlist)"]

    AUTHZ -->|"403"| REJECT2["Forbidden"]
    AUTHZ -->|"Allowed"| TIMEOUT["Request Timeout"]
    TIMEOUT --> HANDLER["Route Handler"]

    HANDLER --> PERSONA{"AccessPersona<br/>(tier check)"}
    PERSONA -->|"ErrApprovalRequired"| APPROVAL["Create Approval<br/>→ 403 + approval_id"]
    PERSONA -->|"ErrPersonaLocked"| LOCKED["403 persona locked"]
    PERSONA -->|"nil (allowed)"| VAULT_CHECK{"Vault IsOpen?"}

    VAULT_CHECK -->|"No"| LOCKED
    VAULT_CHECK -->|"Yes"| GATEKEEPER{"Gatekeeper<br/>Intent Check"}

    GATEKEEPER -->|"Denied"| GK_DENY["403 + reason"]
    GATEKEEPER -->|"Allowed"| OPERATION["Execute Operation<br/>(query/store/delete)"]

    OPERATION --> RESPONSE["200/201 Response"]

    style REJECT1 fill:#f66,color:#fff
    style REJECT2 fill:#f66,color:#fff
    style APPROVAL fill:#f90,color:#fff
    style LOCKED fill:#f66,color:#fff
    style GK_DENY fill:#f66,color:#fff
    style RESPONSE fill:#6c6,color:#fff
```
