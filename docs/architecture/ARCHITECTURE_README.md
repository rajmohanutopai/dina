# Architecture Reference (Split Sections)

> **Primary document:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) (5 026 lines)
>
> This folder contains the same content split into smaller files for easier
> navigation during development. **`ARCHITECTURE.md` remains the source of
> truth.** When you modify the primary document, update the corresponding
> section file here as well.

## Table of Contents

### System Overview (sections 01–04)

| # | File | Lines | Topics |
|---|------|------:|--------|
| 01 | [System Overview](01-system-overview.md) | 90 | Core philosophy, deployment model, hosting levels |
| 02 | [Home Node Operations](02-home-node-operations.md) | 352 | Unattended reboot, dead drop ingress, portability, serverless, connectivity, tenancy |
| 03 | [Sidecar Architecture](03-sidecar-architecture.md) | 397 | Go+Python sidecar, security model, admin UI, browser auth gateway, onboarding |
| 04 | [Data Flow & Recovery](04-data-flow-and-recovery.md) | 557 | Data flow diagrams, brain crash recovery, observability, eight layers summary |

### Layers 0–7 (sections 05–12)

| # | File | Lines | Layer |
|---|------|------:|-------|
| 05 | [Layer 0: Identity](05-layer0-identity.md) | 238 | Root identity, personas, key derivation, ZK credentials |
| 06 | [Layer 1: Storage](06-layer1-storage.md) | 468 | Vault tiers (0–5), encryption architecture, key wrapping, backup |
| 07 | [Layer 2: Ingestion](07-layer2-ingestion.md) | 415 | Connectors, MCP delegation, memory strategy, ingestion security |
| 08 | [Layer 3: Trust Network](08-layer3-trust-network.md) | 452 | AT Protocol PDS, custom lexicons, attestations, outcome data, cold start |
| 09 | [Layer 4: Dina-to-Dina](09-layer4-dina-to-dina.md) | 413 | Encryption protocol, connection establishment, message types, sharing policy, transport |
| 10 | [Layer 5: Bot Interface](10-layer5-bot-interface.md) | 100 | Query sanitization, bot communication protocol, trust scoring, discovery |
| 11 | [Layer 6: Intelligence](11-layer6-intelligence.md) | 284 | PII scrubber, entity vault pattern, LLM routing, context injection, silence protocol |
| 12 | [Layer 7: Action Layer](12-layer7-action-layer.md) | 165 | Draft-don't-send, cart handover, agent delegation (MCP), scheduling |

### Cross-Cutting Concerns (sections 13–19)

| # | File | Lines | Topics |
|---|------|------:|--------|
| 13 | [Client Sync](13-client-sync.md) | 76 | Home node ↔ client sync model, sync protocol, failure handling |
| 14 | [Digital Estate](14-digital-estate.md) | 54 | Pre-configuration, SSS custodian recovery, estate instructions |
| 15 | [Architecture Decisions](15-architecture-decisions.md) | 91 | Why not IPFS/Ceramic/Web3, AT Protocol fit analysis |
| 16 | [Technology Stack](16-technology-stack.md) | 74 | Full stack summary table |
| 17 | [Infrastructure](17-infrastructure.md) | 733 | Docker deployment, LLM inference, client auth, WebSocket protocol, push notifications, HSM |
| 18 | [Roadmap](18-roadmap.md) | 61 | Honest challenges, current state → target, Phase 1 scope & timeline |
| 19 | [Prompt Injection Defense](19-prompt-injection-defense.md) | ~400 | 7-layer blast radius containment, split brain, tool isolation, egress gatekeeper |

## Keeping in Sync

When you edit `ARCHITECTURE.md`:

1. Identify which `##` / `###` section changed
2. Find the corresponding file above
3. Copy the updated content into that file
4. The sync note at the top of each file links back to the primary document
