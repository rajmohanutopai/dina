> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

## Layer 3: Trust Network

Distributed system for verified product reviews, expert attestations, and outcome data. **Built on AT Protocol** — trust data is inherently public and benefits from federation, Merkle tree integrity, and ecosystem discoverability.

### Architecture

The Trust Network is NOT a single database. It's a distributed system built on AT Protocol's federated infrastructure:

```
┌──────────────────────────────────────────────────────────────┐
│               TRUST NETWORK (AT Protocol)                     │
│                                                               │
│  ┌─────────────────┐  ┌──────────────┐  ┌───────────┐       │
│  │ Expert           │  │ Outcome      │  │ Bot       │       │
│  │ Attestations     │  │ Data Store   │  │ Registry  │       │
│  │                  │  │              │  │           │       │
│  │ Signed reviews   │  │ Anonymized   │  │ Bot DIDs  │       │
│  │ from verified    │  │ purchase     │  │ Bot scores│       │
│  │ experts          │  │ outcomes     │  │ Bot APIs  │       │
│  │                  │  │ from Dinas   │  │           │       │
│  └─────────────────┘  └──────────────┘  └───────────┘       │
│                                                               │
│  Storage: AT Protocol PDS (external or bundled — Split         │
│           Sovereignty model, see section below)               │
│           Records stored in signed Merkle repos               │
│           Federated via AT Protocol Relay + AppView           │
│           Custom Lexicons: com.dina.trust.*                   │
│           Signed tombstones for deletion                      │
│           L2 Merkle root anchoring for timestamps (Phase 3)   │
│                                                               │
│  Data flow:                                                   │
│    Home Node → PDS (stores signed records in user's repo)     │
│         ↓                                                     │
│    AT Protocol Relay (aggregates firehose from all PDSes)     │
│         ↓                                                     │
│    Trust AppView (indexes attestations, outcomes, bots)       │
│                                                               │
│  Rule: Only the keyholder can delete their own data.          │
│        Repo is cryptographically signed — operators            │
│        can censor but not forge.                               │
│        Relay replication defeats censorship.                   │
└──────────────────────────────────────────────────────────────┘
```

### Why AT Protocol for Trust

| Property | AT Protocol Fit |
|----------|----------------|
| **Public data** | Trust data is inherently public — AT Protocol repos are public by design |
| **Signed records** | AT Protocol repos are Merkle trees of signed CBOR records — tamper-evident by default |
| **Federation** | Relays aggregate data from all PDSes — no single point of failure or censorship |
| **Custom schemas** | Lexicons let us define `com.dina.trust.attestation`, `com.dina.trust.outcome`, etc. |
| **Identity** | `did:plc` is native to AT Protocol — zero integration work |
| **Deletion** | Users can delete records from their repo. Signed tombstones prevent unauthorized deletion. |
| **Ecosystem** | Any AT Protocol AppView can index Dina's Trust Network. Handles (`alice.dina.host`) provide human-readable discovery. |
| **Implementations** | Go (`bluesky-social/indigo`), Python (`MarshalX/atproto`), Rust (`atrium-rs`), TypeScript (official reference) |

### Custom Lexicons

```json
{
  "lexicon": 1,
  "id": "com.dina.trust.attestation",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["expertDid", "productCategory", "productId", "rating", "verdict"],
        "properties": {
          "expertDid": {"type": "string", "format": "did"},
          "expertTrustRing": {"type": "integer"},
          "productCategory": {"type": "string"},
          "productId": {"type": "string"},
          "rating": {"type": "integer", "minimum": 0, "maximum": 100},
          "verdict": {"type": "ref", "ref": "#verdictDetail"},
          "sourceUrl": {"type": "string", "format": "uri"},
          "deepLink": {"type": "string", "format": "uri"},
          "createdAt": {"type": "string", "format": "datetime"}
        }
      }
    }
  }
}
```

Additional Lexicons: `com.dina.trust.outcome` (anonymized purchase outcomes), `com.dina.trust.bot` (bot registration and scores), `com.dina.trust.membership` (trust ring public info).

### Expert Attestations

```json
{
    "type": "expert_attestation",
    "expert_did": "did:plc:...",
    "expert_trust_ring": 3,
    "expert_credentials": ["youtube_channel_500k_subs", "verified_engineer"],
    "product_category": "office_chairs",
    "product_id": "herman_miller_aeron_2025",
    "rating": 92,
    "verdict": {
        "build_quality": 95,
        "lumbar_support": 90,
        "value_for_money": 70,
        "durability_estimate": "10+ years"
    },
    "source_url": "https://youtube.com/watch?v=...",
    "timestamp": "2026-01-15T00:00:00Z",
    "signature": "..."
}
```

### Outcome Data

```json
{
    "type": "outcome_report",
    "reporter_trust_ring": 2,
    "reporter_age_days": 730,
    "product_category": "office_chairs",
    "product_id": "herman_miller_aeron_2025",
    "purchase_verified": true,
    "purchase_amount_range": "50000-100000_INR",
    "time_since_purchase_days": 180,
    "outcome": "still_using",
    "satisfaction": "positive",
    "issues": [],
    "timestamp": "2026-07-15T00:00:00Z",
    "signature": "..."
}
```

**No personally identifiable data.** The report contains trust ring level, Dina age, product category, and outcome — not user identity or product specifics.

### Storage Options for the Graph

**Decision: AT Protocol (federated PDS + Relay + AppView) with signed tombstones. From day one.**

We evaluated five options:

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **A: IPFS + IPNS** | Decentralized, content-addressed | Slow queries, pinning economics, no guaranteed deletion | ❌ Rejected |
| **B: DHT (Kademlia)** | No central server, good for key lookup | Can't do complex queries ("all chairs rated > 80") | ❌ Rejected |
| **C: L2 blockchain** | Tamper-proof, auditable timestamps | **Cannot delete.** Immutability violates sovereignty. | ❌ Rejected for data storage |
| **D: Custom federated servers** | Fast queries, simple to build, deletable | Must build federation, sync, discovery from scratch | ❌ Rejected — AT Protocol does this better |
| **E: AT Protocol** | Federation built-in, signed Merkle repos, `did:plc` native, Lexicon schemas, relay infrastructure exists, Go/Python/Rust/TS SDKs | Public by design (fine — trust data IS public) | ✅ Chosen |

**Why AT Protocol wins over custom federation:** AT Protocol provides signed repos (Merkle tree integrity), relay-based federation (replication defeats censorship), custom Lexicons (schema-enforced records), `did:plc` identity (already our DID method), and an existing ecosystem of SDKs and infrastructure. Building custom federation would duplicate what AT Protocol already provides.

**Why blockchain is rejected for data storage:** Immutability violates sovereignty. If you cannot delete data, you are not sovereign.

### PDS Hosting: Split Sovereignty

**Problem:** Trust data must be queryable 24/7 — even when the seller's Home Node is a Raspberry Pi behind CGNAT that's currently offline. If your PDS goes down, your reviews, attestations, and trust score become invisible to the network. AT Protocol relays only crawl live PDSes.

**Principle: Split Sovereignty.** Separate *cryptographic authority* (who signs records) from *infrastructure availability* (who hosts the PDS). You always hold the signing keys. The PDS is a dumb host — it stores your signed Merkle repo and serves it to relays. It cannot forge records because it doesn't have your keys. It can censor (refuse to serve) but cannot fabricate. And if it censors, you move to another PDS — AT Protocol's account portability guarantees this.

This is the same model as email: you own your messages (cryptographic authority via PGP/S-MIME), but Gmail hosts the mailbox (infrastructure availability). You can move to Fastmail without losing your identity.

#### Two PDS Topologies

| | Type A: External PDS | Type B: Bundled PDS |
|---|---|---|
| **Who** | Home users (Raspberry Pi, Mac Mini, NAS behind CGNAT/NAT) | VPS users, advanced self-hosters with static IP |
| **PDS location** | Community-hosted (e.g., `pds.dina.host`) or any AT Protocol PDS provider | Co-located with Home Node in docker-compose |
| **Signing** | Home Node signs records locally → pushes signed commits to external PDS | Home Node signs records locally → writes directly to co-located PDS |
| **Availability** | PDS is always online (cloud/community infrastructure) | PDS is as available as your VPS (99.9%+ uptime typical) |
| **Incoming traffic** | Zero — PDS absorbs all read traffic from relays and AppViews | PDS handles relay crawl requests alongside Home Node traffic |
| **docker-compose** | `docker compose up -d` (3 containers: core, brain, external PDS push) | `docker compose up -d` (3 containers: core, brain, bundled PDS) |
| **Best for** | Home hardware behind CGNAT, unreliable connectivity | Default (Phase 1), VPS, managed hosting, full control |

**Type A flow (External PDS):**
```
Home Node (Raspberry Pi, behind NAT)
    │
    │  Signs attestation/outcome record with user's Ed25519 key
    │  Pushes signed commit to external PDS (outbound HTTPS)
    ▼
External PDS (pds.dina.host or any AT Protocol PDS)
    │
    │  Stores signed Merkle repo
    │  Serves to relay on crawl request
    ▼
AT Protocol Relay (firehose aggregation)
    │
    ▼
Trust AppView (indexes com.dina.trust.* records)
```

The Home Node never receives inbound trust traffic. The external PDS absorbs all read load. The Home Node only makes outbound pushes when it has new records to publish — a few requests per day for a typical user. Your Raspberry Pi is safe.

**Type B flow (Bundled PDS):**
```
Home Node (VPS with static IP)
    │
    ├── dina-core (Go)     ← Private layer
    ├── dina-brain (Python) ← Private layer
    ├── llama        ← Private layer (local-llm profile)
    └── dina-pds            ← Public layer: AT Protocol PDS
            │
            │  Serves signed repo to relay on crawl
            ▼
       AT Protocol Relay → Trust AppView
```

The PDS container runs alongside the private stack but serves only trust data (`com.dina.trust.*` Lexicons). It handles relay crawl requests — infrequent, lightweight, and cacheable.

#### Why Your Machine Isn't Overwhelmed (AT Protocol's Three Layers)

AT Protocol separates read traffic from write traffic across three architectural layers:

```
                Write path                    Read path
                (your PDS)                    (AppView)

User writes    ─────►  PDS  ◄─────  Relay crawls (pull, not push)
review                  │                │
                        │                │
                        ▼                ▼
                    Relay (Firehose)──► AppView (Query Index)
                                            │
                                            ▼
                                    Other Dinas query
                                    trust data here
```

| Layer | Role | Traffic pattern |
|-------|------|----------------|
| **PDS** (yours) | Stores your signed Merkle repo | Low: relay crawls periodically (delta sync via Merkle Search Trees). No end-user queries hit your PDS. |
| **Relay** | Aggregates firehose from all PDSes | High: crawls thousands of PDSes, streams unified firehose to AppViews. Not your problem — relay operators handle this. |
| **AppView** | Builds application-specific query indexes | High: serves all end-user queries ("show me all chairs rated > 80"). Not your problem — AppView operators handle this. |

**Key insight: your PDS only talks to the relay.** It never serves end-user queries. When another Dina asks "what's the trust score of this seller?", that query hits the Trust AppView — not your PDS. Your PDS's only job is to store your signed records and let the relay crawl them.

**Merkle Search Trees make crawling cheap.** The relay doesn't download your entire repo on every crawl. AT Protocol repos use Merkle Search Trees (MSTs) — a self-balancing tree where the structure is determined by record key hashes. The relay stores the last root hash it saw. On the next crawl, it walks only the diff — new records since the last sync. For a typical user publishing a few attestations per week, delta sync transfers a few kilobytes.

#### The Dina Foundation PDS (`pds.dina.host`)

> Planned for Phase 1. Free tier for all Dina users.

The Dina Foundation will operate an AT Protocol PDS at `pds.dina.host` as the default Type A host. Users get a handle like `alice.dina.host` and a PDS that's always online.

- **What it stores:** Only `com.dina.trust.*` records (attestations, outcomes, bot scores). No private data ever touches it.
- **What it can do:** Serve your signed repo to relays. That's it.
- **What it cannot do:** Forge records (no signing keys), read private vault data (different protocol entirely), prevent you from leaving (AT Protocol account portability).
- **If it goes down:** Your records are already replicated to relays. You migrate to another PDS. Zero data loss.
- **If it turns evil:** You rotate your PDS in your `did:plc` document. All existing records remain valid (signed by your key, not the PDS's key).

#### Choosing Your PDS Topology

```
Start here
    │
    ├── Home hardware behind CGNAT (Pi, NAS, no static IP)?
    │       └── Type A: External PDS (pds.dina.host)
    │           Core pushes signed records to external PDS via outbound HTTPS
    │
    └── VPS, Mac Mini with tunnel, or dedicated server?
            └── Type B: Bundled PDS (default)
                docker compose up -d  (PDS container always included)
```

Both topologies produce identical results on the network. A relay crawling `pds.dina.host/alice` and a relay crawling `your-vps:2583` see the same signed Merkle repo format. The choice is purely about infrastructure preference and availability guarantees. **Phase 1 default is Type B** — PDS is always in docker-compose.

### Trust AppView (Aggregation & Query Layer)

Personal data lives on user PDSes, but global queries ("who are the top-rated sellers?", "what's the best laptop under ₹80K?") require an aggregation layer. This is the AppView.

The AppView does not hold user keys or create data. It is a **read-only indexer** that consumes the network firehose, filters for Dina-specific records, and serves a high-speed query API.

#### Phase 1: The Monolith (0–1M users)

**Philosophy: keep it simple.** Dina filters for a specific Lexicon (`com.dina.trust.*`), so the data volume is <1% of the full AT Protocol firehose. A single optimized node handles this for years.

**Stack:**

| Component | Technology | Why |
|-----------|-----------|-----|
| Runtime | Go (single binary) | Matches ecosystem, `indigo` firehose consumer library |
| Database | PostgreSQL 16 + `pg_trgm` | Text search, normalized schema, mature tooling |
| Ingestion | `indigo` library connecting to `bsky.network` Relay | Proven AT Protocol firehose consumer |
| Deployment | 1x VPS (4 vCPU, 8GB RAM, NVMe) | Blue/green zero-downtime updates |
| Resilience | WAL archiving + periodic snapshots (PITR) | Point-in-time recovery |

**Architecture:**

```
AT Protocol Relay (bsky.network)
        │
        │ WebSocket firehose
        ▼
┌─────────────────────────────────────────┐
│  Trust AppView (Single Go Binary)       │
│                                         │
│  1. Firehose Consumer                   │
│     └─ Connects to Relay WebSocket      │
│     └─ Tracks cursor (seq number)       │
│                                         │
│  2. Filter                              │
│     └─ Discards all events except       │
│        com.dina.trust.*                 │
│        com.dina.identity.attestation    │
│                                         │
│  3. Verifier                            │
│     └─ Cryptographically verifies       │
│        signature on every record        │
│     └─ Rejects unsigned/invalid         │
│                                         │
│  4. Indexer                             │
│     └─ Upserts valid records into       │
│        PostgreSQL (sellers, reviews,    │
│        trust_scores, bot_scores)        │
│                                         │
│  5. Query API                           │
│     └─ GET /v1/trust?did=...            │
│     └─ GET /v1/product?id=...           │
│     └─ GET /v1/bot?did=...             │
│     └─ Serves signed payloads for       │
│        client-side verification         │
└─────────────────────────────────────────┘
        │
        │ JSON API
        ▼
   Dina Agents query here
```

**Aggregate scores are computed, not stored in any PDS.** The AppView independently calculates product ratings, seller trust composites, and bot accuracy scores from the signed individual records it holds. Any AppView processing the same firehose computes the same scores — the math is deterministic.

**API contract: signed payloads from day one.** Every query response includes the raw signed record payloads alongside computed scores. This is cheap (the records are already in Postgres) and locks in the right API shape. Agent-side verification of these signatures is deferred — no agent checks them in Phase 1, but when verification lands (Phase 3), the API doesn't need to change.

```json
{
  "product_id": "herman_miller_aeron_2025",
  "score": 92,
  "review_count": 14,
  "reviews": [
    {
      "expert_did": "did:plc:abc...",
      "rating": 95,
      "signed_record": "...",
      "signature": "..."
    }
  ]
}
```

#### Future: Scaling & Verification (deferred until multiple AppViews exist)

> **Not needed for Phase 1.** The sections below document the scaling path and trust model for when the ecosystem grows beyond a single Foundation-operated AppView.

**The Sharded Cluster (10M+ users)**

When write load (new reviews) or read load (agent queries) exceeds a single Postgres instance:

```
Relay firehose
      │
      ▼
Stateless Go workers (Ingestion Layer — The Writer)
      │
      ▼
Kafka / NATS JetStream (event buffer: dina-events topic)
      │
      ▼
Indexer Workers → ScyllaDB (sharded by DID) for high-velocity tables
                  PostgreSQL (read replicas) for metadata/identity
      │
      ▼
Independent API cluster (Query Layer — The Reader)
      └─ Autoscales horizontally (Kubernetes HPA)
      └─ Reads from ScyllaDB + Postgres read replicas
```

**Cursor tracking:** Each worker tracks its `seq` number. Crash → resume exactly where it left off. Zero data loss. **Janitor process:** periodically spot-checks AppView against random PDS samples to detect index drift.

**Three-Layer Verification: Trust but Verify**

The AppView provides speed, but it is **not the ultimate source of truth**. Signed records on PDSes are. When multiple AppViews exist, a Dina agent employs a three-layer verification strategy:

**Layer 1: Cryptographic Proof.** When the AppView returns a trust record ("Alice rated this seller 92"), it includes the raw signed data payload and Alice's signature. The agent verifies the signature against Alice's public key (from her DID Document). The AppView cannot fake a record — it can only serve records actually signed by the author.

**Layer 2: Consensus Check (anti-censorship).** An AppView cannot fake data, but it *can* hide it (e.g., censoring bad reviews for a paying seller). For high-value transactions, the agent queries multiple AppViews. If Provider A returns 5 reviews and Provider B returns 50, the agent detects censorship and alerts the user.

**Layer 3: Direct PDS Spot-Check (the audit).** Randomly (e.g., 1 in 100 queries), or when a score seems suspicious, the agent bypasses the AppView entirely — resolves the target's DID to their PDS URL and fetches records directly via `com.atproto.repo.listRecords`. Discrepancies downgrade the AppView's trust score.

**Why this makes the AppView a commodity:** The AppView has no power to manipulate the market — it only has the power to serve data fast. Agents verify its work, so a dishonest AppView gets caught and abandoned. The network switches to a competitor. **The AppView is infrastructure, not a gatekeeper.** Anyone can run one. Competition is on speed and uptime, not on data access.

### Signed Tombstones (Deletion Protocol)

Handles two threats: (1) Chair Company trying to delete your bad review, (2) you wanting to delete your own review.

**Creation:** When you write a review, you sign it with your private key.
```
Review { content: "Bad Chair", author: "did:plc:abc...", sig: "abc..." }
```

**Deletion:** To delete, you send a Tombstone message signed by the same key.
```
Tombstone { target: "review_id_555", author: "did:plc:abc...", sig: "xyz..." }
```

**Server logic:** Receive deletion request → look up original review → verify signature matches author → if match: delete. If no match: reject. The Chair Company cannot forge a deletion request because they don't have your private key.

**Anti-censorship through replication:** When you post a review, it replicates to servers A, B, and C. If the Chair Company operates Server A and wipes your review from their disk (censorship, not deletion), Servers B and C still have it. Other Dinas see the review on B and C, and may flag Server A as "censoring." When *you* delete via signed tombstone, the tombstone propagates to all servers and the review disappears from the entire network.

**Aggregate scores are computed, not stored.** Bot trust scores and seller trust scores are derived values — any server independently recalculates them from the signed individual entries it holds. You can delete your review (removing your contribution from the aggregate), but you can't delete someone else's contribution or manipulate the aggregate directly.

### Timestamp Anchoring (The One Blockchain Use Case)

Federated servers have one weakness: timestamps are server-reported. A malicious operator can backdate entries or claim data arrived later than it did. For dispute resolution, you need provable "this existed before this date."

**Solution: Periodic Merkle root hash anchoring to an L2 chain.**

```
1000 signed reviews this week
        ↓
Merkle tree (hash of hashes)
        ↓
Single root hash → anchored to L2 (Base/Arbitrum) in one transaction
        ↓
Cost: fractions of a cent per review
        ↓
Verification: "Was this review in this week's batch?"
→ Check the Merkle proof against the on-chain root
```

The hash reveals nothing about the content. Privacy is preserved. When you delete via tombstone, the review disappears from federation — the hash on chain is meaningless without the original data. Deletion right is preserved.

**When this matters:**
- **Dispute resolution.** Seller claims review was revenge-posted after a refund. The timestamp anchor proves otherwise.
- **Anti-gaming.** Coordinated fake reviews are provably clustered in time.
- **Expert Bridge economics.** Creator needs tamper-proof proof of when their attestation was made ("I recommended this before it went viral").
- **Collusion resistance.** If enough servers collude (nation-state pressure, corporate influence), the hash anchors on a public chain are the nuclear option proof.

**Timeline:** Not needed for Phase 1 or 2. Becomes valuable in Phase 3 when real money flows through the system (Expert Bridge, Open Economy) and disputes have economic stakes.

### Cold Start Strategy: Tool First, Network Second

The Trust Network needs scale to be useful. With 10 users, there's no statistically meaningful outcome data. **Phase 1 value must not depend on the Trust Network.**

| Phase | How Dina answers "What's the best office chair?" |
|-------|--------------------------------------------------|
| **Phase 1 (Single Player)** | Brain has no trust data. Delegates to OpenClaw: "search web for best office chair reviews 2026." OpenClaw returns results. Brain synthesizes, applies user context from vault ("You had back pain last month. You sit 10+ hours. Budget was ₹50-80K based on previous purchases.") Nudge: "Based on web reviews and your back issues, the Steelcase Leap or Herman Miller Aeron. The Aeron is within your budget at ₹72,000." |
| **Phase 2 (Multiplayer)** | Brain queries the Trust AppView alongside web search. Nudge now includes: "34 people in the network bought the Aeron, but 5 returned it complaining about the mesh. Your friend Alice recommends the Steelcase Leap instead." |

The transition is gradual and invisible to the user. One day the nudge includes network data alongside web results. No flag day, no "activate trust network" moment.

**There is no "Review Bot" to build.** No scraping infrastructure, no crawlers, no YouTube/Reddit/RTINGS ingestion pipeline. In Phase 1, Dina researches the public web for you using her Brain + OpenClaw — the same way a human would Google things, but with your personal context applied. The Trust Network activates when it activates.

---

