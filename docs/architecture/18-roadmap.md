> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

## What's Hard (Honest Assessment)

**1. Messaging beyond Telegram.** Telegram is the primary messaging connector — official Bot API, full access, cross-platform. For WhatsApp, iMessage, Signal, and other closed platforms, Dina delegates to MCP agents which handle each platform's integration. No single fragile connector — Dina's plugin architecture means each messaging platform is an independent agent.

**2. Managed hosting operations.** Running a hosted service requires: regulatory compliance (GDPR, DPDP Act), security operations, incident response, billing. The protocol creator should not be the hosting operator (separation of concerns).

**3. Home Node LLM quality on cheap hardware.** Gemma 3n E2B on a $5 VPS (CPU-only, ~2 vCPU) runs at ~5-10 tok/sec. Adequate for background tasks (ingestion, PII scrubbing, embeddings). Not great for interactive chat. Rich clients with on-device LLMs handle interactive use. Cloud LLM API is the escape valve.

**4. ZKP for government ID.** No government currently offers ZKP-native verification. The first implementation will be a compromise (local verification, attestation stored).

**5. Trust Network cold start.** Phase 1 doesn't depend on it — Brain uses web search via OpenClaw. Outcome data needs scale. The Graph activates gradually as the network grows. This is a years-long build.

**6. iOS restrictions.** No Accessibility Service equivalent for on-screen context injection. iOS client will always be more limited for device-local context features. But with Home Node running API connectors (Gmail, Calendar, Contacts, Telegram), iOS users get full ingestion functionality.

**7. Key management UX.** Asking normal people to write down 24 words on paper is a known failure mode in crypto. Most people will lose them. **Phase 2 answer: Shamir's Secret Sharing (3-of-5)** — split the seed into 5 shares distributed to trusted Dina contacts and physical backups, any 3 reconstruct it. Leverages existing Trust Rings and Dina-to-Dina NaCl. See Layer 0: Identity for full design.

**8. Home Node security surface.** An always-on server with your encrypted data is a target. Must be hardened: automatic updates, minimal attack surface (3-4 containers, two external ports: 443 + 2583), fail2ban-style rate limiting, encrypted at rest. If the VPS is compromised, the attacker gets encrypted blobs they can't read — but they can DoS your Dina.

**9. Data corruption in sovereign model.** No SRE team to restore the database. A bug that corrupts a persona vault file means loss of that persona's memory. The 5-level corruption immunity stack (WAL → pre-flight snapshots → ZFS → off-site backup → Tier 5) addresses this, but must be implemented from Day 1.

---

## Current State (Implemented Sidecar Architecture)

The architecture described above is now the active implementation in this repository.

### Implementation Snapshot

| Component | Path | Role |
|-----------|------|------|
| dina-core | `core/` | Go sovereign kernel: vault, keys, auth, gatekeeper, transport |
| dina-brain | `brain/` | Python intelligence/orchestration: reasoning, sync, admin API/UI |
| dina-pds | `docker-compose*.yml`, `data/pds/` | AT Protocol PDS for trust network records |
| appview | `appview/` | Trust AppView implementation |
| cli | `cli/` | Client interface for interacting with running services |

### Legacy Note (v0.4)

The earlier v0.4 monolithic Python REPL was the pre-sidecar prototype and is no longer the active architecture. Any remaining v0.4 references should be treated as historical context only.

---

## Phase 1 Scope, Build Roadmap & Timeline

> **Moved to [ROADMAP.md](ROADMAP.md)** — the full build roadmap with status tracking, dependency chains, and cross-referenced items from this architecture document.
>
> The roadmap includes 18 items that were described in this architecture but had no explicit roadmap entries (digital estate, rate limiting, brain→core auth, relay, container signing, monitoring, and more). See "Items Added During Architecture Review" in ROADMAP.md for the full list.

---
