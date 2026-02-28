> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

## Layer 4: Dina-to-Dina Communication

The mesh protocol. How your Dina talks to Sancho's Dina.

### Encryption Protocol Decision

**Problem:** There is no actively maintained DIDComm v2.1 library in Go (or any language except Rust and Python). Hyperledger Aries Framework Go was archived in March 2024. DIDComm v2 itself lacks forward secrecy — the 2024 ACM CCS security analysis confirmed this. Building a full DIDComm v2.1 implementation from scratch would cost 2-3 months for marginal interoperability gain (the DIDComm ecosystem is small and concentrated in verifiable credentials, not agent-to-agent messaging).

**Decision: Phased encryption approach.**

| Phase | Encryption | Forward Secrecy | Interop |
|-------|-----------|-----------------|---------|
| **Phase 1** | libsodium `crypto_box_seal` (ephemeral sender keys) + DIDComm-shaped plaintext | Sender FS only (ephemeral key destroyed after send) | Dina-to-Dina only |
| **Phase 2** | Full JWE (ECDH-1PU+A256KW, A256CBC-HS512) | Same as DIDComm v2 (sender FS only) | Wire-compatible with DIDComm v2 libraries |
| **Phase 3** | Noise XX session establishment between Home Nodes | **Full FS** (both sender + receiver, per-session ephemeral keys) | Dina-to-Dina; DIDComm plaintext over Noise channel |

**Why this works:** The plaintext message structure inside the encryption envelope is DIDComm-compatible from day one (`{id, type, from, to, created_time, body}`). Migration between phases means swapping the encryption wrapper — application code and message types don't change.

**Why not full DIDComm v2 in Phase 1:**
1. No Go library exists. Rust FFI adds build complexity.
2. DIDComm's multi-recipient JWE, mediator routing, and ECDH-1PU are unnecessary — Dina-to-Dina is 1:1 between always-on Home Nodes.
3. DIDComm v2 doesn't provide forward secrecy anyway. Noise XX in Phase 3 provides better security than DIDComm ever would.
4. libsodium is available in every language and has a trivial API.

### Connection Establishment

```
Your Dina wants to talk to Sancho's Dina
        ↓
Step 1: You already have Sancho's DID (exchanged when you first connected)
        ↓
Step 2: Resolve DID via PLC Directory
  - Query PLC Directory for did:plc:...(sancho)
  - Returns Sancho's DID Document
  - DID Document contains: public key + Home Node endpoint
  - PLC Directory reveals nothing about Sancho — just how to reach his Dina
        ↓
Step 3: Connect to Sancho's Home Node directly
  - https://sancho-dina.example.com/didcomm  (or IP:port)
  - Home Node is always on — no relay needed, no waiting for phone to wake up
        ↓
Step 4: Mutual authentication
  - Both Dinas present DIDs, verify Ed25519 signatures
  - Both must be in each other's "allowed contacts" list
        ↓
Step 5: Encrypted message sent
  - Ed25519 signing key → X25519 encryption key (crypto_sign_ed25519_sk_to_curve25519)
  - Sender generates ephemeral X25519 keypair per message (crypto_box_seal)
  - Message encrypted with ephemeral key → recipient's static X25519 public key
  - Ephemeral private key destroyed immediately (sender forward secrecy)
  - Even if the VPS provider intercepts traffic, they see only encrypted blobs
```

### Message Types

Dina-to-Dina messages follow a strict schema. The **plaintext** (inside the encryption envelope) uses DIDComm-compatible structure:

```json
{
    "id": "msg_20260215_a1b2c3",
    "type": "dina/social/arrival",
    "from": "did:plc:...(sancho)",
    "to": ["did:plc:...(you)"],
    "created_time": 1739612400,
    "body": {
        "event": "departing_home",
        "eta_minutes": 15,
        "context_flags": ["mother_was_ill"]
    }
}
```

This plaintext is signed (Ed25519) and encrypted (libsodium `crypto_box_seal` in Phase 1) into an envelope:

```json
{
    "typ": "application/dina-encrypted+json",
    "from_kid": "did:plc:...(sancho)#key-1",
    "to_kid": "did:plc:...(you)#key-1",
    "ciphertext": "<base64url-encoded encrypted blob>",
    "sig": "<Ed25519 signature over plaintext>"
}
```

In Phase 2, the envelope becomes standard JWE (`application/didcomm-encrypted+json`) — the plaintext inside stays identical.

**Message categories:**
- `dina/social/*` — arrival, departure, mood flags, context sharing
- `dina/commerce/*` — price negotiation, product inquiry, cart handover coordination
- `dina/identity/*` — trust ring verification, peer attestation requests
- `dina/trust/*` — outcome data exchange, bot recommendations

### What Gets Shared (And What Doesn't)

This is controlled by the sending Dina's **Sharing Policy** — the Egress Gatekeeper. Default deny: if a rule doesn't exist for a contact + category combination, the data is blocked.

```
Sharing Policy for "Sancho" (trust_level: trusted):
  presence:      eta_only     ← "Arriving in 15 minutes" (not GPS coords)
  availability:  free_busy    ← "Busy 2-3pm" (not meeting details)
  context:       summary      ← "Working" (not "meeting with Dr. Patel")
  preferences:   full         ← "Chai, no sugar, served warm"
  location:      none         ← blocked
  health:        none         ← blocked

Sharing Policy for "Seller ABC" (trust_level: unknown):
  preferences:   summary      ← "Looking for a chair under ₹15,000"
  (all other categories: absent = none = blocked)
```

#### Sharing Policy Storage

Sharing policies are stored in `identity.sqlite` in the `contacts` table. Contacts are global — they belong to identity, not to a persona. People span contexts (Dr. Patel sends lab results AND cricket chat). Each contact has a `sharing_policy` JSON column defining per-category sharing tiers.

```sql
-- In identity.sqlite (Tier 0) — NO persona column. People are cross-cutting.
CREATE TABLE contacts (
    did              TEXT PRIMARY KEY,
    name             TEXT,
    alias            TEXT,
    trust_level      TEXT DEFAULT 'unknown',  -- 'blocked', 'unknown', 'trusted'
    sharing_policy   TEXT,                    -- JSON blob (the rulebook)
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_contacts_trust ON contacts(trust_level);
```

#### Policy Tier System

Every category uses a consistent tier system. Missing key = `"none"` = denied.

| Tier | Meaning | Example |
|------|---------|---------|
| `"none"` | Nothing shared. Same as key being absent. | — |
| `"summary"` | High-level only. No names, times, or specifics. | "Busy this afternoon" |
| `"full"` | Complete details. | "In meeting with Dr. Patel at Apollo Hospital until 3pm" |

Domain-specific tiers map to base tiers:

| Category | Custom Tiers | Maps To |
|----------|-------------|---------|
| `presence` | `"eta_only"` → summary, `"exact_location"` → full | Arriving ~15min vs GPS coords |
| `availability` | `"free_busy"` → summary, `"full_details"` → full | "Busy 2-3pm" vs "Meeting with Sancho re: quarterly review" |

**Recognized categories (Phase 1):**

| Category | Description | Example Data |
|----------|-------------|-------------|
| `presence` | Home/away/arriving/departing | "Arriving in 15 minutes" |
| `availability` | Calendar-derived free/busy | "Free at 3pm, next meeting at 4:30" |
| `context` | Current activity state | "Working", "In a meeting", "Driving" |
| `preferences` | Food, drink, environment | "Prefers chai, no sugar" |
| `location` | Geographic position | City-level or GPS coordinates |
| `health` | Wellness, medical, fitness | "Recovering from flu" |

New categories can be added over time via chat or admin UI — the system is not limited to this list.

#### Sharing Policy API

**`GET /v1/contacts/:did/policy` — Read policy**

```json
// Request
// GET /v1/contacts/did:plc:sancho.../policy
// Authorization: Bearer <BRAIN_TOKEN>

// Response 200
{
  "did": "did:plc:sancho...",
  "name": "Sancho",
  "trust_level": "trusted",
  "sharing_policy": {
    "presence": "eta_only",
    "availability": "free_busy",
    "context": "summary",
    "preferences": "full",
    "location": "none",
    "health": "none"
  }
}
```

**`PATCH /v1/contacts/:did/policy` — Partial update (only specified keys change)**

```json
// Request
// PATCH /v1/contacts/did:plc:sancho.../policy
// Authorization: Bearer <BRAIN_TOKEN>
{
  "location": "exact_location",
  "health": "summary"
}

// Response 200
{
  "did": "did:plc:sancho...",
  "sharing_policy": {
    "presence": "eta_only",
    "availability": "free_busy",
    "context": "summary",
    "preferences": "full",
    "location": "exact_location",
    "health": "summary"
  }
}
```

**`PATCH /v1/contacts/policy/bulk` — Bulk update by filter**

```json
// Request — turn off location sharing for all trusted contacts
{
  "filter": { "trust_level": "trusted" },
  "policy": { "location": "none" }
}

// Response 200
{ "updated": 12 }
```

#### Egress Enforcement (Go Core)

**Enforcement is at egress, not ingress.** Core inspects outbound data payloads, not inbound questions. This eliminates the risk of LLM misclassification causing data leaks — a crafted incoming message cannot trick the system into sharing more than the policy allows.

```
Brain prepares response payload for Sancho
  → Brain calls POST /v1/dina/send with payload
  → Core intercepts
  → Core inspects payload: what categories of data are present?
  → Core queries: SELECT sharing_policy FROM contacts WHERE did = ?
  → For each data category in payload:
       policy tier >= required tier?  → allow
       policy tier < required tier?   → strip from payload
       policy key missing?            → strip (default deny)
  → Core sends sanitized payload via NaCl
  → Core logs egress decision to audit_log
```

**Brain payload convention:** Brain always provides maximum detail in a tiered structure. Core strips down based on policy. Brain never needs to know the policy.

```json
// Brain sends this to core:
{
  "to": "did:plc:sancho...",
  "data": {
    "availability": {
      "summary": "Busy from 2-3pm",
      "full": "Meeting with Dr. Patel at Apollo Hospital, 2-3pm, quarterly review"
    },
    "preferences": {
      "summary": "Prefers hot beverages",
      "full": "Chai, no sugar, served warm. Allergic to dairy."
    },
    "presence": {
      "summary": "Arriving in about 15 minutes",
      "full": "Currently at 12.9716° N, 77.5946° E, ETA 14 min via MG Road"
    }
  }
}

// Core picks "summary" or "full" per category based on sharing_policy.
// If tier is "none" or missing, the entire category is dropped.
```

**Security invariants:**
1. **Default deny.** Missing key = `"none"` = blocked. No exceptions.
2. **Egress, not ingress.** Policy is checked on outbound data, not inbound questions.
3. **Core enforces, Brain suggests.** Brain can recommend policy changes. Only Core enforces them.
4. **Strict typing.** Malformed payload (raw string instead of `{"summary": "...", "full": "..."}`) → category dropped entirely. Malformed = denied.
5. **Prompt injection irrelevant.** Enforcement is in compiled Go code checking a SQL table — not in LLM reasoning.
6. **Trust level ≠ sharing.** A contact being "trusted" doesn't auto-share anything. Trust and policy are independent.
7. **Audit everything.** Every egress decision is logged with timestamp, contact, category, decision, and reason. 90-day rolling retention.

8. **No implicit sharing.** A contact being "trusted" doesn't auto-share anything beyond the defaults. Trust level and sharing policy are independent.

#### User Configuration (UX)

Users manage sharing rules through three interfaces. All three call the same Core API.

**1. Chat (primary — natural language):**

```
User: "Let Sancho see when I'm arriving"
Brain: PATCH /v1/contacts/did:plc:sancho/policy → {"presence": "eta_only"}
Brain: "Done. Sancho can see your estimated arrival time,
        but not your exact location."

User: "Stop sharing my location with everyone"
Brain: PATCH /v1/contacts/policy/bulk → {"filter": {}, "policy": {"location": "none"}}
Brain: "Location sharing turned off for all contacts."

User: "What can Sancho see about me?"
Brain: GET /v1/contacts/did:plc:sancho/policy
Brain: "Sancho can see:
        ✓ Arrival ETA (but not exact location)
        ✓ Whether you're free or busy (but not meeting details)
        ✓ General context (working/relaxing)
        ✓ All preferences (food, drinks, environment)
        ✗ Exact location
        ✗ Health information"
```

**2. Admin Web UI:** `/admin/contacts/:did` — toggle switches and dropdown selectors per category. Maps directly to `PATCH /v1/contacts/:did/policy`.

**3. Defaults for new contacts** (applied when a contact is first added):

```json
// config.json
{
  "sharing_defaults": {
    "presence": "eta_only",
    "availability": "free_busy",
    "context": "summary",
    "preferences": "full",
    "location": "none",
    "health": "none"
  }
}
```

Safe defaults: harmless context shared (arrival ETA, free/busy, preferences). Sensitive data off (exact location, health). User can override per-contact at any time.

#### Sharing Audit Trail

Every egress decision is logged:

```sql
INSERT INTO audit_log (timestamp, action, contact_did, category, decision, reason)
VALUES (datetime('now'), 'egress_check', 'did:plc:sancho...', 'location', 'denied', 'tier_none');
```

Creates a complete record of what was shared, with whom, and when. Subject to the 90-day rolling retention policy.

### Transport Layer

How do messages physically travel between Dinas?

**Phase 1: Direct Home Node to Home Node**
- Your DID Document (via PLC Directory) points to your Home Node's endpoint
- Messages go directly: Your Home Node → Sancho's Home Node
- Both are always-on servers — no relay needed for the common case
- End-to-end encrypted (libsodium `crypto_box_seal`). Even if traffic is intercepted, content is unreadable.
- Sender forward secrecy: ephemeral key destroyed after send. Compromise of sender's static key doesn't expose past messages.
- If a Home Node is temporarily down, the sending Dina queues the message in an outbox and retries with exponential backoff (see retry spec below).

**Outbound message retry specification:**

```sql
-- In identity.sqlite — outbound message queue
CREATE TABLE outbox (
    id          TEXT PRIMARY KEY,     -- ULID
    to_did      TEXT NOT NULL,
    payload     BLOB NOT NULL,        -- NaCl encrypted, ready to send
    created_at  INTEGER NOT NULL,     -- unix timestamp
    next_retry  INTEGER NOT NULL,     -- unix timestamp
    retries     INTEGER DEFAULT 0,
    status      TEXT DEFAULT 'pending' -- pending / sending / failed / delivered
);
```

| Parameter | Value |
|-----------|-------|
| **Max retries** | 5 |
| **Backoff schedule** | 30s → 1m → 5m → 30m → 2h (exponential with jitter) |
| **Message TTL** | 24 hours (messages older than this are dropped, not retried) |
| **Queue persistence** | Outbox is in identity.sqlite — survives reboot |
| **Queue size limit** | 100 pending messages (reject new sends if full) |
| **After exhaustion** | Mark `status = 'failed'`, notify user via Tier 2 nudge |
| **Scheduler** | Core checks outbox every 30s: `next_retry < now() AND status = 'pending'` |
| **Cleanup** | Delivered messages deleted after 1 hour. Failed messages after 24 hours. |

After 5 retries (~3 hours): nudge to user: *"I couldn't reach Sancho's Dina. His node may be offline. Want me to try again later?"* User can approve (requeue with fresh count), decline (archived), or ignore (expires at 24h TTL).

**Phase 1 fallback: Relay for NAT/firewall situations**
- Some home servers (Raspberry Pi behind a router) can't accept inbound connections
- For these cases, the DID Document points to a relay endpoint instead
- Relay receives a simple forward envelope: `{type: "dina/forward", to: "did:plc:...", payload: "<encrypted blob>"}`. Relay peels the outer layer, forwards the inner blob. ~100 lines of code.
- Relay sees only: encrypted blob + recipient DID. Cannot read content.
- Community-run or self-hosted relays. User chooses which — and can switch by updating their DID Document.

**Phase 2: Full DIDComm v2 wire compatibility + direct peer-to-peer**
- Encryption envelope upgraded to standard JWE (ECDH-1PU+A256KW). Plaintext messages unchanged.
- Wire-compatible with any DIDComm v2 library (Rust, Python, WASM).
- When user is actively interacting on phone, latency-sensitive messages route directly via WebRTC.
- Falls back to Home Node path if peer unreachable.

**Phase 3: Noise XX sessions + mesh routing**
- Noise XX handshake between always-on Home Nodes establishes sessions with **full forward secrecy** (both sender and receiver). DIDComm plaintext flows over the Noise channel.
- Messages can hop through other Dinas (like Tor but for agent messages) — maximum privacy.

### The Sancho Moment — Complete Flow

```
1. Sancho picks up his keys → his phone detects "leaving home" (geofence)
2. Sancho's phone pushes event to his Home Node: "Sancho is departing"
3. Sancho's Home Node checks sharing rules → you're in "close friends" → arrival notification approved
4. Sancho's Home Node resolves your DID → connects to your Home Node directly
5. Message sent: {type: "arrival", eta: 15min, context: ["mother_ill"]}
6. Your Home Node receives → decrypts → processes
7. Your Home Node checks Vault:
   - Last interaction with Sancho: 3 weeks ago
   - His mother was ill (from previous Dina-to-Dina context flag)
   - His tea preference: strong chai, less sugar
8. Your Home Node pushes notification to your phone:
   - Nudge: "Sancho is 15 minutes away. His mother was ill. He likes strong chai."
   - Draft action: Clear calendar for next 2 hours (you approve on phone)
9. You put the kettle on. You open the door. You ask about his mother.
```

---

