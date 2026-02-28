> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

## Architectural Decision: Why Not IPFS / Ceramic / Web3?

**Decision: SQLite for private data. AT Protocol for public data. No IPFS, no Ceramic, no blockchain for storage.**

| Data Type | Requirements | Tech |
|-----------|-------------|------|
| Emails, chats, contacts, health, financials | Private, fast, deletable | SQLite (Home Node) |
| Product reviews, outcome data, bot scores | Public, deletable by author, censorship-resistant | AT Protocol PDS + Reputation AppView |

### Why Not IPFS/Ceramic

1. **Pinning economics.** Data exists only while someone pins it. Paying a pinning service to keep data online reinvents a database with extra latency.
2. **Latency.** SQLite query: ~0.4ms. Ceramic/ComposeDB indexed query: 200-500ms best case. 500-1000x slower — unacceptable for real-time agent context lookups.
3. **Cannot guarantee deletion.** You can unpin from your node, but any other node that pinned your data retains it. GDPR Article 17 and India's DPDP Act require guaranteed deletion. IPFS architecturally cannot fulfill this.
4. **Permanent attack surface.** IPFS encrypted blobs persist indefinitely and are retrievable by anyone with the CID — a permanent target. SQLite on Home Node limits the attack surface to one server.
5. **Complexity.** IPFS daemon + Ceramic node + ComposeDB + PubSub + DID resolver + pinning service vs. Go + SQLite + llama.cpp.

### Where Web3 Does Belong

Blockchain has exactly one role: **timestamp anchoring.** Federated servers report timestamps, but a malicious operator can backdate entries. Periodic Merkle root hash anchoring to an L2 chain provides provable timestamps for dispute resolution. Phase 3 addition, not a dependency. See Layer 3 "Timestamp Anchoring" for full design.

**Boundary: private data → SQLite on Home Node. Public data → AT Protocol. Blockchain → timestamp anchoring only.**

---

## Architectural Decision: AT Protocol — Where It Fits and Where It Doesn't

**Decision: AT Protocol for the Trust Network (public layer). Independent protocol for messaging and vault (private layer).**

Dina uses `did:plc` (Bluesky's DID method) for identity. The question was whether to adopt the full AT Protocol stack (PDS, Relay, AppView, Lexicons) for more than just identity.

### What AT Protocol provides

AT Protocol is a federated protocol for public, signed, replicated data. Each user's data lives in a Personal Data Server (PDS) as a signed Merkle tree of records. Relays aggregate data from many PDSes into a unified firehose. AppViews consume the firehose and build application-specific indexes.

### Where it fits: Trust Network

The Trust Network is inherently public data — expert attestations, anonymized outcome reports, bot scores. AT Protocol is a natural fit:

- **Public data → public protocol.** Reputation records should be visible, discoverable, and verifiable. AT Protocol repos are all of these.
- **Signed Merkle repos.** Every record is part of a cryptographically signed tree. Operators can censor but not forge. Replication defeats censorship.
- **Federation for free.** Relays replicate data across the network. No need to build custom federation, sync, or discovery.
- **`did:plc` native.** Dina's identity method is AT Protocol's identity method. Zero integration work.
- **Custom Lexicons.** Schema-enforced records: `com.dina.reputation.attestation`, `com.dina.reputation.outcome`, `com.dina.reputation.bot`.
- **Ecosystem.** Any AT Protocol AppView can index Dina's Trust Network. Handles (`alice.dina.host`) provide human-readable discovery.

### Where it doesn't fit: Messaging and Vault

AT Protocol is fundamentally a **public data protocol**. All repository records are visible to relays and any consumer. The Bluesky team explicitly says private/encrypted content in repos is "not a good idea" and that private data is "an entire second phase of protocol development" — not built, not specified.

| Dina Requirement | AT Protocol Status |
|-----------------|-------------------|
| E2E encrypted messaging | Not supported. Explicitly discouraged in repos. |
| Private data vault | Not supported. All repo data is public. |
| Persona compartments | Not supported. One DID = one repo. |
| Per-record access control | Not supported. |
| P2P direct messaging | Not the model. Data routes through relays. |

For messaging and vault, Dina uses its own stack: libsodium encryption for Dina-to-Dina messages, SQLCipher for the encrypted vault, persona compartments as separate encrypted databases.

### The Home Node architecture

```
Home Node (default — 3 containers, PDS always bundled):
├── dina-core (Go)      ← Private layer: encrypted vault, keys, NaCl messaging
│                          Port 443 (external), Port 8100 (internal)
├── dina-brain (Python)  ← Private layer: reasoning, admin UI, agent orchestration
│                          Port 8200 (unified: /api/* brain, /admin/* admin UI)
└── dina-pds             ← Public layer: AT Protocol PDS for Trust Network only
                            Port 2583 (external, relay crawling)

Home Node (with local LLM — 4 containers):
├── dina-core (Go)      ← same
├── dina-brain (Python)  ← same, but routes to llama:8080 instead of cloud APIs
├── llama (llama.cpp)    ← Private layer: local LLM inference
│                          Port 8080 (internal), profiles: ["local-llm"]
└── dina-pds             ← same

Type A variation (home hardware behind CGNAT):
├── dina-core, dina-brain ← same private layer
└── (no PDS container — reputation records pushed to external PDS via outbound HTTPS)
```

The PDS container runs alongside the private stack, hosting only reputation data (`com.dina.reputation.*` Lexicons). For Type A users behind CGNAT, the Home Node signs records locally and pushes them to an external PDS (e.g., `pds.dina.host`). In all cases, private data (messages, personal vault, persona compartments) never touches the AT Protocol stack. See Layer 3 "PDS Hosting: Split Sovereignty" for the full design.

### Precedent

This hybrid approach mirrors **Roomy** (Discord-like chat on AT Protocol) — which uses AT Protocol for identity and blob storage but builds its entire messaging/encryption infrastructure independently. It also mirrors **Groundmist Sync** — a local-first sync server linked to AT Protocol identity, using AT Protocol for optional publishing while keeping private data local.

---

