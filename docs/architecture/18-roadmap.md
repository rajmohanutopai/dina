> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

## What's Hard (Honest Assessment)

**1. WhatsApp ingestion.** Still the weakest link. NotificationListener on Android is fragile, and now the captured data has to travel from phone to Home Node. More moving parts, same underlying problem. No real API. May never be fully solved without regulation.

**2. Managed hosting operations.** Running a hosted service requires: regulatory compliance (GDPR, DPDP Act), security operations, incident response, billing. The protocol creator should not be the hosting operator (separation of concerns).

**3. Home Node LLM quality on cheap hardware.** Gemma 3n E2B on a $5 VPS (CPU-only, ~2 vCPU) runs at ~5-10 tok/sec. Adequate for background tasks (ingestion, PII scrubbing, embeddings). Not great for interactive chat. Rich clients with on-device LLMs handle interactive use. Cloud LLM API is the escape valve.

**4. ZKP for government ID.** No government currently offers ZKP-native verification. The first implementation will be a compromise (local verification, attestation stored).

**5. Reputation Graph cold start.** Phase 1 doesn't depend on it — Brain uses web search via OpenClaw. Outcome data needs scale. The Graph activates gradually as the network grows. This is a years-long build.

**6. iOS restrictions.** No NotificationListenerService equivalent. No Accessibility Service. iOS client will always be more limited for device-local ingestion. But with Home Node running API connectors (Gmail, Calendar, Contacts), iOS users still get most functionality. WhatsApp ingestion requires an Android device somewhere in the ecosystem.

**7. Key management UX.** Asking normal people to write down 24 words on paper is a known failure mode in crypto. Most people will lose them. **Phase 2 answer: Shamir's Secret Sharing (3-of-5)** — split the seed into 5 shares distributed to trusted Dina contacts and physical backups, any 3 reconstruct it. Leverages existing Trust Rings and Dina-to-Dina NaCl. See Layer 0: Identity for full design.

**8. Home Node security surface.** An always-on server with your encrypted data is a target. Must be hardened: automatic updates, minimal attack surface (3-4 containers, two external ports: 443 + 2583), fail2ban-style rate limiting, encrypted at rest. If the VPS is compromised, the attacker gets encrypted blobs they can't read — but they can DoS your Dina.

**9. Data corruption in sovereign model.** No SRE team to restore the database. A bug that corrupts a persona vault file means loss of that persona's memory. The 5-level corruption immunity stack (WAL → pre-flight snapshots → ZFS → off-site backup → Tier 5) addresses this, but must be implemented from Day 1.

---

## Current State (v0.4) → Target Architecture

> **Version note:** The README uses phase-based versioning (v0.1 Eyes, v0.2 Voice, v0.3 Identity, v0.4 Memory). This section refers to the entire current monolith as "v0.4" — the state at the end of the Memory phase, before the rewrite into the three-container sidecar architecture.

### What Works Today

| Capability | Implementation | Target Layer |
|-----------|---------------|-------------|
| YouTube product review analysis | Gemini video analysis + transcript extraction → structured verdict (BUY/WAIT/AVOID) | Layer 5 (Bot Interface) |
| Semantic memory | Local vector database at `~/.dina/memory/`, persists across sessions | Layer 1 (Storage) — Tier 2 Index |
| RAG-powered Q&A | Natural language → search memory → contextual answer | Layer 6 (Intelligence) |
| Cryptographic signing | Ed25519 signature on every verdict, `/verify` command | Layer 0 (Identity) |
| Self-sovereign identity | did:key (pure Python) + did:plc (target) | Layer 0 (Identity) |
| Decentralized vault | Dual-write to Ceramic Network (when configured) | Layer 1 (Storage) — will migrate to federated Reputation Graph |
| Multi-provider LLM | Ollama (local) + Gemini (cloud), configurable routing | Layer 6 (Intelligence) |
| REPL interface | `/history`, `/search`, `/identity`, `/verify`, `/vault`, `/quit` | Human Interface |

### Migration Path

v0.4 is a monolithic Python application. The target is the three-container sidecar architecture. The migration is incremental:

1. **Phase 1a (now → 6 weeks):** Extract the agent reasoning logic from v0.4 into dina-brain running on Google ADK. The YouTube analysis, memory search, and RAG become ADK tools. The REPL becomes a thin client that talks to the brain.

2. **Phase 1b (parallel):** Build dina-core in Go. Start with the SQLite vault skeleton, DID key management (porting the Ed25519/did:key logic from Python to Go), and the internal API (`/v1/vault/query`, `/v1/vault/store`, `/v1/did/sign`). Go's standard library `crypto/ed25519` and `crypto/aes` handle the cryptography natively.

3. **Phase 1c (integration):** Wire dina-brain to call dina-core's API instead of managing its own storage. Add PDS container. `docker compose up` runs all three (core, brain, pds). llama available via `--profile local-llm` for local inference.

4. **v0.4 retirement:** Once the sidecar architecture handles everything v0.4 does, the monolithic REPL is deprecated. Its code lives on as reference.

---

## Phase 1 Scope, Build Roadmap & Timeline

> **Moved to [ROADMAP.md](ROADMAP.md)** — the full build roadmap with status tracking, dependency chains, and cross-referenced items from this architecture document.
>
> The roadmap includes 18 items that were described in this architecture but had no explicit roadmap entries (digital estate, rate limiting, brain→core auth, relay, container signing, monitoring, and more). See "Items Added During Architecture Review" in ROADMAP.md for the full list.

---

