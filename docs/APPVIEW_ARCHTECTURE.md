# Dina Trust AppView — Code Architecture v5 Final

> **Revision history:**
> - v1: Initial architecture (raw relay, precomputed graph, unified Next.js)
> - v2: Jetstream, runtime 2-hop graph, unified Next.js with split path
> - v3: Idempotent upserts, atomic subject resolution, super-node fan-out caps
> - v3-final: Transaction-scoped timeouts, WebSocket backpressure, API promise-coalescing cache
> - v4-final: Low watermark cursor, O(1) LRU cache, incremental dirty-flag scoring
> - v4-final+infra: Full deployment topology — self-hosted Jetstream, relay strategy, requestCrawl automation
> - v4-final+identity: 3-tier subject identity — deterministic hashing, author-scoped isolation, community merge
> - v4-final+adversarial: Ingester rate limiting, EigenTrust convergence, parameterized deletion handler
> - v4-final+writepath: Write path (Brain→Core→PDS), backfill strategy (PDS direct + idempotent replay)

## Overview

The AppView is a TypeScript monorepo containing three runtime processes:

1. **Ingester** — Long-running worker that consumes Jetstream (pre-decoded JSON stream from the AT Proto relay), validates records, and writes to PostgreSQL.
2. **API + Web Server** — Next.js app serving XRPC query endpoints (for Dina agents) and server-rendered public pages (for humans). Unified in v1, splittable to Fastify + Next.js when agent volume demands it.
3. **Scorer** — Periodic background worker that refreshes materialized aggregations, computes trust scores, detects anomalies, and manages tombstones.

All three share the same codebase, database connection library, and TypeScript types. They differ only in entry point.

```
┌──────────────┐     ┌──────────────┐     ┌────────────────┐     ┌──────────────────────────────────┐
│  Dina Core   │     │  AT Proto    │     │   Jetstream    │     │       AppView Monorepo           │
│  PDS nodes   │────▶│  Relay (BGS) │────▶│   (Go binary)  │     │                                  │
│  (Go binary) │     │  Crawls repos│     │   Decodes,     │     │  ┌────────────┐  ┌──────────┐   │
│              │     │  Merges all  │     │   filters,     │────▶│  │  Ingester  │  │  Scorer  │   │
│  requestCrawl│     │  PDS streams │     │   emits JSON   │     │  │  (worker)  │  │  (cron)  │   │
└──────────────┘     └──────────────┘     └────────────────┘     │  └─────┬──────┘  └─────┬────┘   │
      ×N nodes        v1: bgs.bsky.network  Local container      │        │               │        │
                      v2: relay.dina.foundation                  │        ▼               ▼        │
                                                                 │  ┌────────────────────────────┐ │
                                                                 │  │       PostgreSQL           │ │
                                                                 │  └────────────┬───────────────┘ │
                                                                 │               │                 │
                                                                 │       ┌───────┴──────┐          │
                                                                 │       │   Next.js    │          │
                                                                 │       │  XRPC + Web  │          │
                                                                 │       └───────┬──────┘          │
                                                                 │               │                 │
                                                                 └───────────────┼─────────────────┘
                                                                                 │
                                                                         ┌───────┴───────┐
                                                                         │               │
                                                                    JSON API      Server-rendered
                                                                    (agents)      HTML pages (humans)
```

### Data Flow: PDS → Relay → Jetstream → AppView

The AppView does not connect directly to individual Dina PDS nodes. The AT Protocol uses a **relay** (Big Graph Service / BGS) as an intermediary that crawls all federated PDS repositories and merges them into a single firehose. The data flow is:

1. **Dina Core (PDS)** — Each user's node stores trust records in their personal data repository (signed, content-addressed Merkle tree). On first boot, the PDS sends `com.atproto.sync.requestCrawl` to the configured relay URL, registering itself for crawling.

2. **Relay (BGS)** — Crawls all registered PDS repositories, verifies signatures, and merges all commits into a single firehose stream. The relay is lexicon-agnostic — it carries ALL record types from ALL PDS nodes, including custom `com.dina.trust.*` records.

3. **Jetstream (Go binary)** — Self-hosted container that connects to the relay firehose, does the heavy CBOR/MST decoding in Go, and exposes a lightweight JSON WebSocket stream. Subscribes with `wantedCollections` to filter for only trust records.

4. **AppView Ingester** — Connects to the local Jetstream container over the Docker network (`ws://jetstream:6008`). Receives pre-decoded JSON events. Validates, dispatches to handlers, writes to Postgres.

### Relay Strategy: v1 vs v2

**v1 (two-month sprint): Piggyback on Bluesky's global relay.**

Configure the Jetstream binary to connect to `wss://bgs.bsky.network`. Bluesky's relay is lexicon-agnostic — it will crawl any PDS that sends `requestCrawl`, including Dina nodes with custom trust records. Your Jetstream filters out the millions of Bluesky posts and feeds only `com.dina.trust.*` events to the Ingester.

Pros: Zero relay infrastructure. Works immediately. Cons: Dependency on Bluesky's infrastructure.

**v2 (post-validation): Sovereign Dina relay.**

Deploy Bluesky's open-source `indigo` BGS as `relay.dina.foundation`. Dina Core nodes `requestCrawl` to the Dina relay instead of Bluesky's. Full sovereignty — the trust network operates independently of Bluesky.

The swap is a single env var change (`RELAY_URL` in the Jetstream container). Zero code changes to the AppView, the Ingester, or the PDS.

### `requestCrawl` Must Be Automated in Dina Core

This is critical: if a PDS doesn't register with the relay, its records are invisible to the AppView. The `requestCrawl` call must be baked into the Dina Core first-boot sequence, not left as a manual step.

```go
// In dina-core PDS startup sequence (Go)

func registerWithRelay(relayURL string, pdsDID string) error {
    // One-time HTTP POST to register this PDS with the relay.
    // The relay will then begin crawling this PDS's repository.
    body := map[string]string{"hostname": pdsHostname}
    jsonBody, _ := json.Marshal(body)

    resp, err := http.Post(
        relayURL+"/xrpc/com.atproto.sync.requestCrawl",
        "application/json",
        bytes.NewReader(jsonBody),
    )
    if err != nil {
        return fmt.Errorf("failed to register with relay: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != 200 {
        return fmt.Errorf("relay returned %d", resp.StatusCode)
    }

    log.Info().Str("relay", relayURL).Str("did", pdsDID).Msg("Registered with relay")
    return nil
}
```

This is called once on first boot. The relay then crawls the PDS on an ongoing basis, picking up all new trust records as they're created.

### Why Jetstream, Not Raw Relay

The AT Proto relay firehose (`com.atproto.sync.subscribeRepos`) sends CBOR-encoded commits with full Merkle Search Tree diffs. Consuming it requires:
- CBOR decoding
- MST traversal to extract operations
- Ed25519 signature verification per commit
- Filtering (99.9%+ of commits are Bluesky posts, not trust records)

All of this in single-threaded Node.js is a CPU bottleneck at scale. Bluesky built **Jetstream** specifically for AppViews — a Go intermediary that handles the cryptographic heavy lifting and emits a lightweight JSON WebSocket stream. The Ingester subscribes with `wantedCollections` and receives only `com.dina.trust.*` records, already decoded to JSON.

This eliminates: `@atproto/repo` dependency, MST walking code, CBOR decoding, signature verification. The Ingester becomes a JSON validator + Postgres writer.

---

## Directory Structure

```
dina-appview/
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── next.config.ts
├── docker-compose.yml
├── Dockerfile
├── .env.example
│
├── src/
│   │
│   ├── config/
│   │   ├── env.ts                   # Validated env vars (zod schema)
│   │   ├── constants.ts             # Limits, defaults, tuning knobs
│   │   └── lexicons.ts              # Lexicon NSID constants
│   │
│   ├── db/
│   │   ├── connection.ts            # Drizzle + node-postgres pool setup
│   │   ├── schema/
│   │   │   ├── index.ts             # Re-exports all tables
│   │   │   │
│   │   │   │  # ── Raw record tables (populated by Ingester from firehose) ──
│   │   │   ├── attestations.ts
│   │   │   ├── vouches.ts
│   │   │   ├── endorsements.ts
│   │   │   ├── flags.ts
│   │   │   ├── replies.ts
│   │   │   ├── reactions.ts
│   │   │   ├── report-records.ts
│   │   │   ├── revocations.ts
│   │   │   ├── delegations.ts
│   │   │   ├── collections.ts
│   │   │   ├── media.ts
│   │   │   ├── subjects.ts
│   │   │   ├── amendments.ts
│   │   │   ├── verifications.ts
│   │   │   ├── review-requests.ts
│   │   │   ├── comparisons.ts
│   │   │   ├── subject-claims.ts
│   │   │   ├── trust-policies.ts
│   │   │   ├── notification-prefs.ts
│   │   │   ├── mention-edges.ts     # Extracted from mentions in records
│   │   │   │
│   │   │   │  # ── AppView-generated tables ──
│   │   │   ├── tombstones.ts        # Created by deletion handler when disputed record is deleted
│   │   │   ├── trust-edges.ts       # Flattened graph edges (from vouches, delegations, endorsements, cosigns)
│   │   │   ├── anomaly-events.ts    # Detected suspicious patterns
│   │   │   ├── ingester-cursor.ts   # Jetstream cursor (last processed timestamp)
│   │   │   │
│   │   │   │  # ── Materialized tables (refreshed by Scorer) ──
│   │   │   ├── did-profiles.ts      # Aggregated DID trust + reviewer stats
│   │   │   ├── subject-scores.ts    # Aggregated subject trust
│   │   │   └── domain-scores.ts     # Per-DID per-domain trust scores
│   │   │
│   │   ├── migrations/
│   │   │   ├── 0000_initial.sql
│   │   │   └── ...
│   │   │
│   │   └── queries/
│   │       ├── attestations.ts      # Typed query functions for attestations
│   │       ├── profiles.ts          # DID profile lookups
│   │       ├── subjects.ts          # Subject resolution + dedup
│   │       ├── dirty-flags.ts       # Fix 9: Mark entities for incremental recalculation
│   │       ├── graph.ts             # Trust graph: 1-hop, 2-hop, mutual connections
│   │       ├── search.ts            # Full-text search
│   │       ├── reactions.ts         # Reaction counts
│   │       ├── threads.ts           # Reply thread reconstruction
│   │       ├── tombstones.ts        # Tombstone queries
│   │       └── common.ts            # Shared pagination, filtering, sorting
│   │
│   ├── ingester/
│   │   ├── main.ts                  # Entry point: connect to Jetstream, start consuming
│   │   ├── jetstream-consumer.ts    # WebSocket client for Jetstream JSON stream
│   │   ├── bounded-queue.ts         # Fix 5: Bounded producer-consumer queue with backpressure
│   │   ├── rate-limiter.ts          # Fix 11: Per-DID write rate limiting (in-memory, pre-DB)
│   │   ├── record-validator.ts      # Validate records against lexicon schemas (zod)
│   │   ├── handlers/
│   │   │   ├── index.ts             # Router: collection NSID → handler
│   │   │   ├── attestation.ts
│   │   │   ├── vouch.ts
│   │   │   ├── endorsement.ts
│   │   │   ├── flag.ts
│   │   │   ├── reply.ts
│   │   │   ├── reaction.ts
│   │   │   ├── report-record.ts
│   │   │   ├── revocation.ts
│   │   │   ├── delegation.ts
│   │   │   ├── collection.ts
│   │   │   ├── media.ts
│   │   │   ├── subject.ts
│   │   │   ├── amendment.ts
│   │   │   ├── verification.ts
│   │   │   ├── review-request.ts
│   │   │   ├── comparison.ts
│   │   │   ├── subject-claim.ts
│   │   │   ├── trust-policy.ts
│   │   │   └── notification-prefs.ts
│   │   │
│   │   ├── deletion-handler.ts      # Tombstone logic: check disputes before allowing clean delete
│   │   └── trust-edge-sync.ts       # Maintain trust_edges when vouches/delegations/endorsements change
│   │
│   ├── scorer/
│   │   ├── main.ts                  # Entry point: run scoring jobs on schedule
│   │   ├── scheduler.ts             # Cron-like job scheduler
│   │   ├── jobs/
│   │   │   ├── refresh-profiles.ts      # Recompute did_profiles
│   │   │   ├── refresh-reviewer-stats.ts # Recompute reviewer quality metrics within did_profiles
│   │   │   ├── refresh-subject-scores.ts # Recompute subject aggregates
│   │   │   ├── refresh-domain-scores.ts  # Recompute per-DID per-domain scores
│   │   │   ├── detect-coordination.ts    # Find coordinated review campaigns
│   │   │   ├── detect-sybil.ts           # Identify suspected sybil clusters
│   │   │   ├── process-tombstones.ts     # Aggregate tombstone patterns per DID
│   │   │   ├── decay-scores.ts           # Apply time-based freshness decay
│   │   │   └── cleanup-expired.ts        # Clean expired delegations, review requests
│   │   │
│   │   └── algorithms/
│   │       ├── trust-score.ts            # Core trust scoring algorithm
│   │       ├── reviewer-quality.ts       # Corroboration, deletion rate, evidence rate
│   │       ├── sentiment-aggregation.ts  # Weighted sentiment from raw attestations
│   │       ├── anomaly-detection.ts      # Statistical outlier detection
│   │       └── recommendation.ts         # proceed/caution/verify/avoid logic
│   │
│   ├── app/                              # Next.js App Router
│   │   ├── layout.tsx                    # Root layout
│   │   ├── page.tsx                      # Landing page
│   │   │
│   │   │  # ── XRPC API endpoints (agents consume these) ──
│   │   ├── xrpc/
│   │   │   ├── com.dina.trust.resolve/
│   │   │   │   └── route.ts
│   │   │   ├── com.dina.trust.getProfile/
│   │   │   │   └── route.ts
│   │   │   ├── com.dina.trust.getAttestations/
│   │   │   │   └── route.ts
│   │   │   ├── com.dina.trust.getGraph/
│   │   │   │   └── route.ts
│   │   │   └── com.dina.trust.search/
│   │   │       └── route.ts
│   │   │
│   │   │  # ── API middleware ──
│   │   ├── api/
│   │   │   └── middleware/
│   │   │       └── swr-cache.ts         # Fix 6: Promise coalescing + stale-while-revalidate cache
│   │   │
│   │   │  # ── Human-facing web pages ──
│   │   ├── did/
│   │   │   └── [did]/
│   │   │       ├── page.tsx              # DID profile page
│   │   │       ├── reviews/
│   │   │       │   └── page.tsx          # Reviews BY this DID
│   │   │       ├── graph/
│   │   │       │   └── page.tsx          # Trust graph visualization
│   │   │       └── endorsements/
│   │   │           └── page.tsx
│   │   │
│   │   ├── subject/
│   │   │   └── [slug]/
│   │   │       ├── page.tsx              # Subject page (restaurant, product, content, etc.)
│   │   │       └── compare/
│   │   │           └── page.tsx
│   │   │
│   │   ├── attestation/
│   │   │   └── [uri]/
│   │   │       └── page.tsx              # Single attestation with full thread
│   │   │
│   │   ├── search/
│   │   │   └── page.tsx
│   │   │
│   │   ├── collection/
│   │   │   └── [uri]/
│   │   │       └── page.tsx
│   │   │
│   │   ├── explore/
│   │   │   ├── page.tsx                  # Trending subjects, recent activity
│   │   │   ├── domain/
│   │   │   │   └── [domain]/
│   │   │   │       └── page.tsx
│   │   │   └── requests/
│   │   │       └── page.tsx              # Open review requests
│   │   │
│   │   └── components/
│   │       ├── attestation-card.tsx
│   │       ├── subject-header.tsx
│   │       ├── did-profile-header.tsx
│   │       ├── reviewer-badge.tsx
│   │       ├── sentiment-bar.tsx
│   │       ├── dimension-grid.tsx
│   │       ├── trust-graph-viz.tsx        # Client component (D3/vis.js)
│   │       ├── thread-view.tsx
│   │       ├── reaction-bar.tsx
│   │       ├── evidence-gallery.tsx
│   │       ├── verification-badge.tsx
│   │       ├── authenticity-banner.tsx
│   │       ├── search-bar.tsx
│   │       ├── pagination.tsx
│   │       ├── time-ago.tsx
│   │       └── skeleton.tsx
│   │
│   ├── shared/
│   │   ├── types/
│   │   │   ├── lexicon-types.ts          # TypeScript types from lexicon schemas
│   │   │   ├── db-types.ts              # Drizzle inferred types
│   │   │   ├── api-types.ts             # API request/response types
│   │   │   └── jetstream-types.ts       # Jetstream event types
│   │   │
│   │   ├── atproto/
│   │   │   ├── identity.ts              # DID resolution, handle resolution
│   │   │   └── uri.ts                   # AT URI parsing and construction
│   │   │
│   │   ├── utils/
│   │   │   ├── logger.ts                # Structured logging (pino)
│   │   │   ├── metrics.ts               # Prometheus metrics
│   │   │   ├── retry.ts                 # Exponential backoff
│   │   │   ├── batch.ts                 # Batch insert helper
│   │   │   └── id.ts                   # ULID / deterministic hash generation
│   │   │
│   │   └── errors/
│   │       ├── app-error.ts
│   │       ├── validation-error.ts
│   │       └── not-found-error.ts
│   │
│   └── labels/
│       ├── service.ts                   # Label service implementation
│       ├── detectors/
│       │   ├── fake-review.ts
│       │   ├── ai-generated.ts
│       │   ├── self-promotion.ts
│       │   ├── coordinated.ts
│       │   └── conflict-of-interest.ts
│       │
│       └── definitions.ts
│
├── scripts/
│   ├── migrate.ts                       # Run database migrations
│   ├── seed.ts                          # Seed dev database
│   ├── backfill.ts                      # Backfill from PDS repos (bootstrap + outage recovery)
│   └── generate-types.ts               # Generate TS types from lexicon JSON
│
├── tests/
│   ├── unit/
│   │   ├── scorer/
│   │   │   ├── trust-score.test.ts
│   │   │   ├── reviewer-quality.test.ts
│   │   │   └── recommendation.test.ts
│   │   ├── ingester/
│   │   │   └── record-validator.test.ts
│   │   └── shared/
│   │       ├── uri.test.ts
│   │       └── deterministic-id.test.ts
│   │
│   ├── integration/
│   │   ├── ingester/
│   │   │   ├── attestation-handler.test.ts
│   │   │   ├── deletion-handler.test.ts
│   │   │   └── trust-edge-sync.test.ts
│   │   ├── api/
│   │   │   ├── resolve.test.ts
│   │   │   ├── search.test.ts
│   │   │   └── get-profile.test.ts
│   │   └── scorer/
│   │       ├── refresh-profiles.test.ts
│   │       └── detect-coordination.test.ts
│   │
│   ├── e2e/
│   │   ├── subject-page.test.ts
│   │   ├── search-flow.test.ts
│   │   └── ingestion-to-page.test.ts
│   │
│   └── helpers/
│       ├── db.ts                        # Test Postgres (testcontainers)
│       ├── factories.ts                 # Record factories
│       └── mock-jetstream.ts            # Mock Jetstream events
│
└── lexicons/                            # Lexicon JSON schemas (source of truth)
    ├── com/dina/trust/
    │   ├── attestation.json
    │   ├── vouch.json
    │   ├── ... (all 25 lexicons)
    │   └── search.json
    └── README.md
```

---

## Deep Dive: Ingester (Jetstream Consumer)

### Jetstream Event Format

Jetstream emits events as flat JSON over WebSocket. No CBOR, no MST, no signature verification needed at the AppView level.

```typescript
// src/shared/types/jetstream-types.ts

/** Jetstream commit event for a create/update operation */
export interface JetstreamCommitCreate {
  did: string                              // Author DID
  time_us: number                          // Microsecond timestamp
  kind: 'commit'
  commit: {
    rev: string                            // Repo revision
    operation: 'create' | 'update'
    collection: string                     // e.g. "com.dina.trust.attestation"
    rkey: string                           // Record key (TID)
    record: Record<string, unknown>        // The actual record — already JSON
    cid: string                            // Content hash
  }
}

/** Jetstream commit event for a delete operation */
export interface JetstreamCommitDelete {
  did: string
  time_us: number
  kind: 'commit'
  commit: {
    rev: string
    operation: 'delete'
    collection: string
    rkey: string
  }
}

/** Jetstream identity event (handle change, DID tombstone) */
export interface JetstreamIdentityEvent {
  did: string
  time_us: number
  kind: 'identity'
  identity: {
    did: string
    handle: string
    seq: number
    time: string
  }
}

/** Jetstream account event (status changes) */
export interface JetstreamAccountEvent {
  did: string
  time_us: number
  kind: 'account'
  account: {
    active: boolean
    did: string
    seq: number
    time: string
    status?: 'takendown' | 'suspended' | 'deleted' | 'deactivated'
  }
}

export type JetstreamEvent =
  | JetstreamCommitCreate
  | JetstreamCommitDelete
  | JetstreamIdentityEvent
  | JetstreamAccountEvent
```

### Ingester-Side Rate Limiter (Write Abuse Defense)

```typescript
// src/ingester/rate-limiter.ts

import { LRUCache } from 'lru-cache'
import { logger } from '@/shared/utils/logger'
import { metrics } from '@/shared/utils/metrics'

/**
 * In-memory sliding window rate limiter per DID.
 *
 * CRITICAL (Fix 11): Write abuse / Sybil DoS defense.
 *
 * A Sybil attacker can create thousands of attestations from different DIDs,
 * flooding the Ingester and overwhelming the Scorer's dirty-flag queue.
 * Sybil detection runs every 6 hours — the attacker can distort scores
 * for hours before detection. The PDS enforces per-repo limits (~5K/hour)
 * but not per-DID-across-the-network.
 *
 * This rate limiter runs in-memory BEFORE any database I/O. If a DID
 * exceeds MAX_RECORDS_PER_HOUR, records are quarantined (logged for
 * sybil investigation) and dropped. Cost: zero database I/O. An attacker
 * flooding millions of events is stopped at the memory layer.
 *
 * Uses LRU cache so inactive DIDs are evicted — max ~2MB memory for
 * 100K active DIDs.
 */

const MAX_RECORDS_PER_HOUR = 50
const MAX_TRACKED_DIDS = 100_000

interface DidWriteState {
  count: number
  quarantined: boolean    // Once flagged, stays flagged for the TTL window
}

const didWriteCounts = new LRUCache<string, DidWriteState>({
  max: MAX_TRACKED_DIDS,
  ttl: 1000 * 60 * 60,   // 1 hour sliding window
})

/**
 * Check if a DID has exceeded its write rate limit.
 *
 * Returns true if the record should be dropped.
 * Side effect: increments the DID's counter.
 */
export function isRateLimited(did: string): boolean {
  const state = didWriteCounts.get(did) ?? { count: 0, quarantined: false }

  state.count++

  if (state.count > MAX_RECORDS_PER_HOUR) {
    if (!state.quarantined) {
      // First time hitting limit — flag for sybil investigation
      state.quarantined = true
      logger.warn(
        { did, count: state.count, maxPerHour: MAX_RECORDS_PER_HOUR },
        'DID rate limited — flagging for sybil investigation',
      )
      metrics.incr('ingester.rate_limit.new_quarantine')
    }

    didWriteCounts.set(did, state)
    metrics.incr('ingester.rate_limit.dropped')
    return true
  }

  didWriteCounts.set(did, state)
  return false
}

/**
 * Get all currently quarantined DIDs.
 * Called by the sybil detection job to accelerate investigation.
 */
export function getQuarantinedDids(): string[] {
  const quarantined: string[] = []
  for (const [did, state] of didWriteCounts.entries()) {
    if (state.quarantined) quarantined.push(did)
  }
  return quarantined
}
```

### Bounded Ingestion Queue (WebSocket Backpressure)

```typescript
// src/ingester/bounded-queue.ts

import type WebSocket from 'ws'
import { logger } from '@/shared/utils/logger'
import { metrics } from '@/shared/utils/metrics'

/**
 * Bounded Producer-Consumer queue with TCP-level backpressure
 * and low watermark cursor tracking.
 *
 * CRITICAL (Fix 5): WebSocket OOM prevention.
 * See Production Hardening Summary for full explanation.
 *
 * CRITICAL (Fix 7): Low watermark cursor for concurrent workers.
 *
 * With MAX_CONCURRENCY=20 workers processing events concurrently,
 * events complete out of order. If we naively save the cursor as the
 * timestamp of the last completed event, we skip in-flight events:
 *
 *   Worker A starts event time_us=1000 (slow: 50ms subject resolution)
 *   Worker B starts event time_us=1005 (fast: 5ms reaction)
 *   Worker B finishes → cursor saved as 1005
 *   Process crashes before Worker A finishes
 *   Restart from cursor 1005 → event 1000 is PERMANENTLY LOST
 *
 * The fix: track all in-flight event timestamps. The safe cursor is
 * NEVER the highest completed timestamp — it's the LOW WATERMARK:
 * min(all in-flight timestamps) - 1. On restart, we replay from just
 * before the oldest unfinished event, guaranteeing nothing is skipped.
 * Idempotent upserts (Fix 1) ensure replayed events are harmless.
 */

export class BoundedIngestionQueue {
  private queue: { event: unknown; timeUs: number }[] = []
  private activeWorkers = 0
  private isPaused = false
  private readonly MAX_QUEUE_SIZE: number
  private readonly MAX_CONCURRENCY: number

  /**
   * Set of time_us values for events currently being processed.
   * Used to compute the low watermark — the oldest in-flight event.
   * The safe cursor is min(inFlight) - 1.
   */
  private inFlightTimestamps = new Set<number>()

  /**
   * The highest time_us of any event that has been fully processed
   * AND where all earlier events have also completed.
   * This is the actual safe cursor value.
   */
  private safeCursor: number = 0

  constructor(
    private ws: WebSocket,
    private processFn: (event: unknown) => Promise<void>,
    options?: {
      maxQueueSize?: number
      maxConcurrency?: number
    },
  ) {
    this.MAX_QUEUE_SIZE = options?.maxQueueSize ?? 1000
    this.MAX_CONCURRENCY = options?.maxConcurrency ?? 20
  }

  /** Push an event into the queue. Called from ws.on('message'). */
  push(event: unknown, timeUs: number): void {
    this.queue.push({ event, timeUs })
    metrics.gauge('ingester.queue.size', this.queue.length)

    // BACKPRESSURE: Queue full → pause WebSocket → stop reading from TCP
    if (this.queue.length >= this.MAX_QUEUE_SIZE && !this.isPaused) {
      this.ws.pause()
      this.isPaused = true
      logger.warn({ queueSize: this.queue.length }, 'Backpressure: WebSocket paused')
      metrics.incr('ingester.backpressure.paused')
    }

    this.pump()
  }

  /** Try to dequeue and process events up to concurrency limit. */
  private pump(): void {
    while (this.activeWorkers < this.MAX_CONCURRENCY && this.queue.length > 0) {
      this.activeWorkers++
      const { event, timeUs } = this.queue.shift()!

      // Track this event as in-flight
      this.inFlightTimestamps.add(timeUs)

      metrics.gauge('ingester.queue.active_workers', this.activeWorkers)

      this.processFn(event)
        .catch((err) => {
          logger.error({ err, timeUs }, 'Error processing queued event')
          metrics.incr('ingester.errors.processing')
        })
        .finally(() => {
          // Remove from in-flight tracking
          this.inFlightTimestamps.delete(timeUs)
          this.activeWorkers--

          metrics.gauge('ingester.queue.active_workers', this.activeWorkers)
          metrics.gauge('ingester.queue.in_flight', this.inFlightTimestamps.size)

          // HYSTERESIS RESUME: Resume at 50% to prevent oscillation
          if (this.isPaused && this.queue.length < this.MAX_QUEUE_SIZE / 2) {
            this.ws.resume()
            this.isPaused = false
            logger.info({ queueSize: this.queue.length }, 'Backpressure: WebSocket resumed')
            metrics.incr('ingester.backpressure.resumed')
          }

          this.pump()
        })
    }
  }

  /**
   * Get the safe cursor value — the LOW WATERMARK.
   *
   * If there are in-flight events, the safe cursor is min(inFlight) - 1.
   * On restart, Jetstream will replay from this point, re-delivering
   * the oldest in-flight event (which is safe due to idempotent upserts).
   *
   * If there are no in-flight events, the safe cursor is the highest
   * time_us we've seen (all events have completed).
   */
  getSafeCursor(highestSeen: number): number {
    if (this.inFlightTimestamps.size === 0) {
      return highestSeen
    }
    // Return one microsecond before the oldest in-flight event
    return Math.min(...this.inFlightTimestamps) - 1
  }

  get depth(): number { return this.queue.length }
  get active(): number { return this.activeWorkers }
  get inFlight(): number { return this.inFlightTimestamps.size }
}
```

### Consumer Implementation

```typescript
// src/ingester/jetstream-consumer.ts

import WebSocket from 'ws'
import type { DrizzleDB } from '@/db/connection'
import type { JetstreamEvent, JetstreamCommitCreate, JetstreamCommitDelete } from '@/shared/types/jetstream-types'
import { routeHandler } from './handlers'
import { deletionHandler } from './deletion-handler'
import { validateRecord } from './record-validator'
import { BoundedIngestionQueue } from './bounded-queue'
import { isRateLimited } from './rate-limiter'
import { env } from '@/config/env'
import { TRUST_COLLECTIONS } from '@/config/lexicons'
import { logger } from '@/shared/utils/logger'
import { metrics } from '@/shared/utils/metrics'

export class JetstreamConsumer {
  private ws: WebSocket | null = null
  private cursor: number = 0                     // Microsecond timestamp
  private reconnectAttempts = 0
  private readonly MAX_RECONNECT_DELAY_MS = 60_000
  private isShuttingDown = false
  private eventsSinceCursorSave = 0
  private readonly CURSOR_SAVE_INTERVAL = 100    // Save cursor every 100 events
  private queue: BoundedIngestionQueue | null = null
  private highestSeenTimeUs: number = 0          // Fix 7: Track highest seen for low watermark

  constructor(private db: DrizzleDB) {}

  async start(): Promise<void> {
    this.cursor = await this.loadCursor()
    logger.info({ cursor: this.cursor }, 'Starting Jetstream consumer')
    this.connect()
    this.setupGracefulShutdown()
  }

  private connect(): void {
    // Build Jetstream URL with wanted collections filter
    const params = new URLSearchParams()
    for (const collection of TRUST_COLLECTIONS) {
      params.append('wantedCollections', collection)
    }
    if (this.cursor > 0) {
      params.set('cursor', this.cursor.toString())
    }

    const url = `${env.JETSTREAM_URL}/subscribe?${params.toString()}`
    logger.info({ url: env.JETSTREAM_URL, collections: TRUST_COLLECTIONS.length }, 'Connecting to Jetstream')

    this.ws = new WebSocket(url)

    // Initialize bounded queue with this WebSocket.
    // MAX_CONCURRENCY matches DB pool to maximize throughput without overwhelming Postgres.
    this.queue = new BoundedIngestionQueue(
      this.ws,
      (event) => this.processEvent(event as JetstreamEvent),
      {
        maxQueueSize: 1000,
        maxConcurrency: env.DATABASE_POOL_MAX,
      },
    )

    this.ws.on('open', () => {
      logger.info('Jetstream connection established')
      this.reconnectAttempts = 0
      metrics.gauge('ingester.connected', 1)
    })

    // CRITICAL (Fix 5): Do NOT await processEvent here.
    // The bounded queue handles concurrency limiting and backpressure.
    // Without the queue, this handler creates unbounded promises that
    // cause OOM under spike load.
    this.ws.on('message', (data: Buffer) => {
      try {
        const event: JetstreamEvent = JSON.parse(data.toString())

        // Track highest seen timestamp for cursor management
        if (event.time_us > this.highestSeenTimeUs) {
          this.highestSeenTimeUs = event.time_us
        }

        // Push to queue WITH timestamp for low watermark tracking (Fix 7)
        this.queue!.push(event, event.time_us)
      } catch (err) {
        logger.error({ err }, 'Failed to parse Jetstream message')
        metrics.incr('ingester.errors.parse')
      }
    })

    this.ws.on('close', (code, reason) => {
      metrics.gauge('ingester.connected', 0)
      if (!this.isShuttingDown) {
        logger.warn({ code, reason: reason.toString() }, 'Jetstream connection closed')
        this.reconnectWithBackoff()
      }
    })

    this.ws.on('error', (err) => {
      logger.error({ err }, 'Jetstream WebSocket error')
      metrics.incr('ingester.errors.connection')
    })
  }

  private async processEvent(event: JetstreamEvent): Promise<void> {
    // NOTE: cursor is NOT updated here per-event. The cursor is saved
    // periodically using the LOW WATERMARK from the bounded queue (Fix 7).
    // See saveCursor() for the safe cursor computation.

    if (event.kind === 'identity') {
      await this.handleIdentityEvent(event)
      return
    }

    if (event.kind === 'account') {
      await this.handleAccountEvent(event)
      return
    }

    if (event.kind !== 'commit') return

    const { commit, did } = event
    const collection = commit.collection

    // Double-check: should already be filtered by wantedCollections
    if (!TRUST_COLLECTIONS.includes(collection)) return

    // Rate limit check (Fix 11): drop records from abusive DIDs
    // BEFORE any database I/O. Costs zero Postgres resources.
    if (commit.operation === 'create' && isRateLimited(did)) {
      metrics.incr('ingester.rate_limited_drops', { collection })
      return
    }

    metrics.incr('ingester.events.received', { collection, operation: commit.operation })

    if (commit.operation === 'create' || commit.operation === 'update') {
      await this.handleCreateOrUpdate(did, commit as JetstreamCommitCreate['commit'])
    } else if (commit.operation === 'delete') {
      await this.handleDelete(did, commit as JetstreamCommitDelete['commit'])
    }

    // Persist cursor periodically using LOW WATERMARK (Fix 7).
    // The safe cursor is min(in-flight timestamps) - 1, ensuring we never
    // advance past events that haven't completed processing.
    this.eventsSinceCursorSave++
    if (this.eventsSinceCursorSave >= this.CURSOR_SAVE_INTERVAL) {
      this.cursor = this.queue!.getSafeCursor(this.highestSeenTimeUs)
      await this.saveCursor()
      this.eventsSinceCursorSave = 0
    }
  }

  private async handleCreateOrUpdate(
    did: string,
    commit: JetstreamCommitCreate['commit']
  ): Promise<void> {
    const { collection, rkey, record, cid } = commit
    const uri = `at://${did}/${collection}/${rkey}`

    // 1. Validate record against lexicon schema
    const validation = validateRecord(collection, record)
    if (!validation.success) {
      logger.warn({ uri, errors: validation.errors }, 'Record validation failed')
      metrics.incr('ingester.validation.failed', { collection })
      return
    }

    // 2. Dispatch to handler
    const handler = routeHandler(collection)
    if (!handler) {
      logger.warn({ collection }, 'No handler registered')
      return
    }

    const ctx = { db: this.db, logger, metrics }

    if (commit.operation === 'update') {
      // AT Proto update = delete old + create new at same rkey
      await handler.handleDelete(ctx, { uri, did, collection, rkey })
    }

    await handler.handleCreate(ctx, {
      uri,
      did,
      collection,
      rkey,
      cid,
      record: validation.data,           // Validated + typed record
    })

    metrics.incr('ingester.records.processed', { collection, operation: commit.operation })
  }

  private async handleDelete(
    did: string,
    commit: JetstreamCommitDelete['commit']
  ): Promise<void> {
    const { collection, rkey } = commit
    const uri = `at://${did}/${collection}/${rkey}`

    const handler = routeHandler(collection)
    if (!handler) return

    const ctx = { db: this.db, logger, metrics }
    await handler.handleDelete(ctx, { uri, did, collection, rkey })

    metrics.incr('ingester.records.processed', { collection, operation: 'delete' })
  }

  private async handleIdentityEvent(event: JetstreamIdentityEvent): Promise<void> {
    // Handle changes, DID deactivations
    // Update any cached handle → DID mappings
    logger.info({ did: event.did, handle: event.identity.handle }, 'Identity event')
    metrics.incr('ingester.events.identity')
  }

  private async handleAccountEvent(event: JetstreamAccountEvent): Promise<void> {
    // Handle account takedowns, suspensions, deletions
    if (event.account.status === 'takendown' || event.account.status === 'deleted') {
      logger.info({ did: event.did, status: event.account.status }, 'Account status change')
      // Mark all records by this DID as inactive (soft flag, not deletion)
      // The Scorer can factor this into trust scores
    }
    metrics.incr('ingester.events.account', { status: event.account.status ?? 'active' })
  }

  // ── Cursor management ──

  private async loadCursor(): Promise<number> {
    const row = await this.db.select()
      .from(ingesterCursor)
      .where(eq(ingesterCursor.service, env.JETSTREAM_URL))
      .limit(1)

    return row[0]?.cursor ?? 0
  }

  private async saveCursor(): Promise<void> {
    await this.db
      .insert(ingesterCursor)
      .values({
        service: env.JETSTREAM_URL,
        cursor: this.cursor,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: ingesterCursor.service,
        set: { cursor: this.cursor, updatedAt: new Date() },
      })
  }

  // ── Reconnection ──

  private reconnectWithBackoff(): void {
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.MAX_RECONNECT_DELAY_MS
    )
    this.reconnectAttempts++
    logger.info({ delay, attempt: this.reconnectAttempts }, 'Reconnecting to Jetstream')
    setTimeout(() => this.connect(), delay)
  }

  // ── Graceful shutdown ──

  private setupGracefulShutdown(): void {
    const shutdown = async () => {
      this.isShuttingDown = true
      logger.info('Shutting down ingester...')
      this.ws?.close()
      // Save the LOW WATERMARK cursor — ensures no in-flight events are skipped on restart
      this.cursor = this.queue?.getSafeCursor(this.highestSeenTimeUs) ?? this.cursor
      await this.saveCursor()
      logger.info({ cursor: this.cursor, inFlight: this.queue?.inFlight ?? 0 }, 'Final cursor saved (low watermark)')
      process.exit(0)
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
  }
}
```

### Lexicon Configuration

```typescript
// src/config/lexicons.ts

/** All trust record collection NSIDs */
export const TRUST_COLLECTIONS = [
  'com.dina.trust.attestation',
  'com.dina.trust.vouch',
  'com.dina.trust.endorsement',
  'com.dina.trust.flag',
  'com.dina.trust.reply',
  'com.dina.trust.reaction',
  'com.dina.trust.reportRecord',
  'com.dina.trust.revocation',
  'com.dina.trust.delegation',
  'com.dina.trust.collection',
  'com.dina.trust.media',
  'com.dina.trust.subject',
  'com.dina.trust.amendment',
  'com.dina.trust.verification',
  'com.dina.trust.reviewRequest',
  'com.dina.trust.comparison',
  'com.dina.trust.subjectClaim',
  'com.dina.trust.trustPolicy',
  'com.dina.trust.notificationPrefs',
] as const

export type TrustCollection = typeof TRUST_COLLECTIONS[number]
```

### Record Validator

```typescript
// src/ingester/record-validator.ts

import { z } from 'zod'
import type { TrustCollection } from '@/config/lexicons'

// ── Shared schema fragments ──

const subjectRefSchema = z.object({
  type: z.enum(['did', 'content', 'product', 'dataset', 'organization', 'claim']),
  did: z.string().optional(),
  uri: z.string().optional(),
  name: z.string().max(200).optional(),
  identifier: z.string().max(200).optional(),
})

const dimensionRatingSchema = z.object({
  dimension: z.string(),
  value: z.enum(['exceeded', 'met', 'below', 'failed']),
  note: z.string().max(200).optional(),
})

const evidenceItemSchema = z.object({
  type: z.string(),
  uri: z.string().optional(),
  hash: z.string().optional(),
  description: z.string().max(300).optional(),
})

const mentionSchema = z.object({
  did: z.string(),
  role: z.string().optional(),
})

// ── Per-collection schemas ──

const attestationSchema = z.object({
  subject: subjectRefSchema,
  category: z.string(),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  dimensions: z.array(dimensionRatingSchema).max(10).optional(),
  text: z.string().max(2000).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
  domain: z.string().optional(),
  interactionContext: z.record(z.unknown()).optional(),
  contentContext: z.record(z.unknown()).optional(),
  productContext: z.record(z.unknown()).optional(),
  evidence: z.array(evidenceItemSchema).max(10).optional(),
  confidence: z.enum(['certain', 'high', 'moderate', 'speculative']).optional(),
  isAgentGenerated: z.boolean().optional(),
  coSignature: z.object({
    did: z.string(),
    sig: z.string(),
    sigCreatedAt: z.string(),
  }).optional(),
  mentions: z.array(mentionSchema).max(10).optional(),
  relatedAttestations: z.array(z.object({
    uri: z.string(),
    relation: z.string(),
  })).max(5).optional(),
  bilateralReview: z.record(z.unknown()).optional(),
  createdAt: z.string(),
})

const vouchSchema = z.object({
  subject: z.string(),
  vouchType: z.string(),
  confidence: z.enum(['high', 'moderate', 'low']),
  relationship: z.string().optional(),
  knownSince: z.string().optional(),
  text: z.string().max(500).optional(),
  createdAt: z.string(),
})

const reactionSchema = z.object({
  targetUri: z.string(),
  reaction: z.enum([
    'helpful', 'unhelpful', 'agree', 'disagree',
    'verified', 'can-confirm', 'suspicious', 'outdated',
  ]),
  createdAt: z.string(),
})

const reportRecordSchema = z.object({
  targetUri: z.string(),
  reportType: z.enum([
    'spam', 'fake-review', 'incentivized-undisclosed', 'self-review',
    'competitor-attack', 'harassment', 'doxxing', 'off-topic',
    'duplicate', 'ai-generated-undisclosed', 'defamation',
    'conflict-of-interest', 'brigading',
  ]),
  text: z.string().max(1000).optional(),
  evidence: z.array(evidenceItemSchema).max(5).optional(),
  relatedRecords: z.array(z.string()).max(10).optional(),
  createdAt: z.string(),
})

// ... (similar schemas for all other record types)

// ── Validator map ──

const schemas: Record<string, z.ZodSchema> = {
  'com.dina.trust.attestation': attestationSchema,
  'com.dina.trust.vouch': vouchSchema,
  'com.dina.trust.reaction': reactionSchema,
  'com.dina.trust.reportRecord': reportRecordSchema,
  // ... all 19 record types
}

export interface ValidationResult {
  success: boolean
  data?: unknown
  errors?: z.ZodError['errors']
}

export function validateRecord(
  collection: string,
  record: Record<string, unknown>
): ValidationResult {
  const schema = schemas[collection]
  if (!schema) {
    return { success: false, errors: [{ message: `Unknown collection: ${collection}`, path: [], code: 'custom' }] }
  }

  const result = schema.safeParse(record)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return { success: false, errors: result.error.errors }
}
```

### Handler Pattern

```typescript
// src/ingester/handlers/index.ts

import type { DrizzleDB } from '@/db/connection'
import type { Logger } from 'pino'
import type { Metrics } from '@/shared/utils/metrics'

export interface HandlerContext {
  db: DrizzleDB
  logger: Logger
  metrics: Metrics
}

export interface RecordOp {
  uri: string             // at://did:plc:abc/com.dina.trust.attestation/tid
  did: string             // Author DID
  collection: string      // com.dina.trust.attestation
  rkey: string            // Record key
  cid?: string            // Content hash (present on create/update, absent on delete)
  record?: unknown        // Validated record (present on create/update, absent on delete)
}

export interface RecordHandler {
  handleCreate(ctx: HandlerContext, op: RecordOp): Promise<void>
  handleDelete(ctx: HandlerContext, op: RecordOp): Promise<void>
}

/**
 * CRITICAL: Idempotency requirement (Fix 1).
 *
 * Jetstream delivers events at-least-once. If the Ingester crashes,
 * it replays from the last saved cursor — potentially re-delivering
 * events that were already processed. Every handleCreate() MUST use
 * upsert semantics (ON CONFLICT DO UPDATE or DO NOTHING) to survive
 * replay without throwing UniqueConstraintViolation errors.
 *
 * Without this, a crash → restart → replay → duplicate insert → crash
 * creates an infinite death loop that brings down the Ingester permanently.
 *
 * CRITICAL: Parameterized deletion (Fix 13).
 *
 * Every handleDelete() MUST pass its own source table to
 * deletionHandler.process(). Use getSourceTable(collection) or pass
 * the table directly. The deletion handler uses this to:
 *   1. Query the correct table for tombstone metadata
 *   2. Delete from the correct table
 * Passing the wrong table (e.g., hardcoded `attestations`) causes
 * silent data loss — tombstones aren't created and records aren't deleted.
 *
 * Pattern for all handlers:
 *
 *   await ctx.db.insert(table)
 *     .values({ ... })
 *     .onConflictDoUpdate({
 *       target: table.uri,
 *       set: { ...updatedFields, indexedAt: new Date() },
 *     })
 *
 * For records where replay should be a no-op (reactions, etc.):
 *
 *   await ctx.db.insert(table)
 *     .values({ ... })
 *     .onConflictDoNothing()
 */

// ── Handler registry ──

import { attestationHandler } from './attestation'
import { vouchHandler } from './vouch'
import { endorsementHandler } from './endorsement'
import { flagHandler } from './flag'
import { replyHandler } from './reply'
import { reactionHandler } from './reaction'
import { reportRecordHandler } from './report-record'
import { revocationHandler } from './revocation'
import { delegationHandler } from './delegation'
import { collectionHandler } from './collection'
import { mediaHandler } from './media'
import { subjectHandler } from './subject'
import { amendmentHandler } from './amendment'
import { verificationHandler } from './verification'
import { reviewRequestHandler } from './review-request'
import { comparisonHandler } from './comparison'
import { subjectClaimHandler } from './subject-claim'
import { trustPolicyHandler } from './trust-policy'
import { notificationPrefsHandler } from './notification-prefs'

const handlers: Record<string, RecordHandler> = {
  'com.dina.trust.attestation': attestationHandler,
  'com.dina.trust.vouch': vouchHandler,
  'com.dina.trust.endorsement': endorsementHandler,
  'com.dina.trust.flag': flagHandler,
  'com.dina.trust.reply': replyHandler,
  'com.dina.trust.reaction': reactionHandler,
  'com.dina.trust.reportRecord': reportRecordHandler,
  'com.dina.trust.revocation': revocationHandler,
  'com.dina.trust.delegation': delegationHandler,
  'com.dina.trust.collection': collectionHandler,
  'com.dina.trust.media': mediaHandler,
  'com.dina.trust.subject': subjectHandler,
  'com.dina.trust.amendment': amendmentHandler,
  'com.dina.trust.verification': verificationHandler,
  'com.dina.trust.reviewRequest': reviewRequestHandler,
  'com.dina.trust.comparison': comparisonHandler,
  'com.dina.trust.subjectClaim': subjectClaimHandler,
  'com.dina.trust.trustPolicy': trustPolicyHandler,
  'com.dina.trust.notificationPrefs': notificationPrefsHandler,
}

export function routeHandler(collection: string): RecordHandler | null {
  return handlers[collection] ?? null
}
```

### Attestation Handler

```typescript
// src/ingester/handlers/attestation.ts

import type { HandlerContext, RecordOp } from './index'
import type { Attestation } from '@/shared/types/lexicon-types'
import { attestations, mentionEdges } from '@/db/schema'
import { resolveOrCreateSubject } from '@/db/queries/subjects'
import { markDirty } from '@/db/queries/dirty-flags'
import { deletionHandler } from '../deletion-handler'

/**
 * CRITICAL: resolveOrCreateSubject uses atomic upsert (Fix 2).
 * See src/db/queries/subjects.ts for implementation.
 */

export const attestationHandler: RecordHandler = {
  async handleCreate(ctx, op) {
    const record = op.record as Attestation

    // 1. Resolve subject to canonical ID
    // Resolve or create the subject — 3-tier identity strategy (Fix 10)
    // Tier 1: DID/URI/identifier → globally deterministic
    // Tier 2: name-only → author-scoped (prevents cross-city collisions)
    const subjectId = await resolveOrCreateSubject(ctx.db, record.subject, op.did)

    // 2. Build tsvector search content
    const searchParts = [
      record.text,
      record.subject.name,
      ...(record.tags ?? []),
      record.category,
      record.domain,
    ].filter(Boolean).join(' ')

    // 3. Upsert attestation (idempotent — safe for Jetstream replay)
    await ctx.db.insert(attestations).values({
      uri: op.uri,
      authorDid: op.did,
      cid: op.cid!,
      subjectId,
      subjectRefRaw: record.subject,
      category: record.category,
      sentiment: record.sentiment,
      domain: record.domain ?? null,
      confidence: record.confidence ?? null,
      isAgentGenerated: record.isAgentGenerated ?? false,
      hasCosignature: !!record.coSignature,
      cosignerDid: record.coSignature?.did ?? null,
      dimensionsJson: record.dimensions ?? null,
      interactionContextJson: record.interactionContext ?? null,
      contentContextJson: record.contentContext ?? null,
      productContextJson: record.productContext ?? null,
      evidenceJson: record.evidence ?? null,
      mentionsJson: record.mentions ?? null,
      relatedAttestationsJson: record.relatedAttestations ?? null,
      bilateralReviewJson: record.bilateralReview ?? null,
      tags: record.tags ?? [],
      text: record.text ?? null,
      searchContent: searchParts,
      recordCreatedAt: new Date(record.createdAt),
      indexedAt: new Date(),
    }).onConflictDoUpdate({
      target: attestations.uri,
      set: {
        cid: op.cid!,
        subjectId,
        subjectRefRaw: record.subject,
        category: record.category,
        sentiment: record.sentiment,
        domain: record.domain ?? null,
        confidence: record.confidence ?? null,
        isAgentGenerated: record.isAgentGenerated ?? false,
        hasCosignature: !!record.coSignature,
        cosignerDid: record.coSignature?.did ?? null,
        dimensionsJson: record.dimensions ?? null,
        interactionContextJson: record.interactionContext ?? null,
        contentContextJson: record.contentContext ?? null,
        productContextJson: record.productContext ?? null,
        evidenceJson: record.evidence ?? null,
        mentionsJson: record.mentions ?? null,
        relatedAttestationsJson: record.relatedAttestations ?? null,
        bilateralReviewJson: record.bilateralReview ?? null,
        tags: record.tags ?? [],
        text: record.text ?? null,
        searchContent: searchParts,
        indexedAt: new Date(),
      },
    })

    // 4. Upsert mention edges (idempotent)
    const mentions = record.mentions ?? []
    if (mentions.length > 0) {
      for (const m of mentions) {
        await ctx.db.insert(mentionEdges).values({
          sourceUri: op.uri,
          sourceDid: op.did,
          targetDid: m.did,
          role: m.role ?? null,
          recordType: 'attestation',
          createdAt: new Date(record.createdAt),
        }).onConflictDoNothing()       // Same mention from same record = no-op
      }
    }

    ctx.metrics.incr('ingester.attestation.created')

    // Mark affected entities for recalculation (Fix 9: incremental scoring)
    await markDirty(ctx.db, {
      subjectId,
      authorDid: op.did,
      mentionedDids: mentions,
      // If subject is a DID, mark that DID's profile too
      subjectDid: record.subject.type === 'did' ? record.subject.did : undefined,
    })
  },

  async handleDelete(ctx, op) {
    await deletionHandler.process(ctx, op.uri, op.did, 'attestation', attestations)
    ctx.metrics.incr('ingester.attestation.deleted')
  },
}
```

### Trust Edge Sync

When vouches, delegations, endorsements, or co-signed attestations are created or deleted, the `trust_edges` table must be updated. This is a simple projection, not a precomputation.

```typescript
// src/ingester/trust-edge-sync.ts

import type { HandlerContext } from './handlers'
import { trustEdges } from '@/db/schema'

/**
 * Maintain the trust_edges table as a flattened projection of
 * vouches, delegations, endorsements, and co-signed attestations.
 *
 * trust_edges is NOT precomputed graph distances.
 * It is a simple denormalization for efficient 1-hop and 2-hop joins.
 * Each row = one directional trust signal from one DID to another.
 */

export async function addTrustEdge(
  ctx: HandlerContext,
  params: {
    fromDid: string
    toDid: string
    edgeType: 'vouch' | 'endorsement' | 'delegation' | 'cosign' | 'positive-attestation'
    domain: string | null
    weight: number
    sourceUri: string
    createdAt: Date
  }
): Promise<void> {
  await ctx.db.insert(trustEdges).values({
    fromDid: params.fromDid,
    toDid: params.toDid,
    edgeType: params.edgeType,
    domain: params.domain,
    weight: params.weight,
    sourceUri: params.sourceUri,
    createdAt: params.createdAt,
  }).onConflictDoNothing()             // Idempotent: same source URI won't create duplicate edges
}

export async function removeTrustEdge(
  ctx: HandlerContext,
  sourceUri: string
): Promise<void> {
  await ctx.db.delete(trustEdges)
    .where(eq(trustEdges.sourceUri, sourceUri))
}

/**
 * Edge weight heuristics:
 *
 * Vouch (high confidence):     1.0
 * Vouch (moderate confidence): 0.6
 * Vouch (low confidence):      0.3
 * Endorsement (worked-together): 0.8
 * Endorsement (observed-output): 0.4
 * Delegation:                  0.9
 * Co-signed attestation:       0.7
 * Positive attestation (DID subject): 0.3
 *
 * Weights are tuning knobs — adjustable in constants.ts
 */
```

### Deletion Handler

```typescript
// src/ingester/deletion-handler.ts

import type { PgTable } from 'drizzle-orm/pg-core'
import type { HandlerContext } from './handlers'
import {
  attestations, vouches, endorsements, flags,
  reportRecords, replies, reactions, tombstones,
  delegations, revocations, comparisons, reviewRequests,
  collections as collectionsTable, amendments, verifications,
  subjectClaims, trustPolicies, notificationPrefs,
} from '@/db/schema'
import { and, eq, inArray, count, sql } from 'drizzle-orm'
import { removeTrustEdge } from './trust-edge-sync'

/**
 * Map from lexicon collection name to its Drizzle table object.
 *
 * CRITICAL (Fix 13): The deletion handler MUST delete from the correct table.
 *
 * The original code hardcoded `attestations` for both tombstone metadata
 * lookup and deletion. If a user deleted a `vouch` or `flag`, the handler
 * queried the `attestations` table, found nothing, skipped the tombstone,
 * and then tried to delete from `attestations` — leaving the original
 * vouch/flag record untouched. Silent data corruption.
 *
 * The fix: every handler passes its source table, and the deletion handler
 * uses that table for both the tombstone metadata query and the delete.
 */
const COLLECTION_TABLE_MAP: Record<string, PgTable> = {
  'com.dina.trust.attestation':       attestations,
  'com.dina.trust.vouch':             vouches,
  'com.dina.trust.endorsement':       endorsements,
  'com.dina.trust.flag':              flags,
  'com.dina.trust.reportRecord':      reportRecords,
  'com.dina.trust.reply':             replies,
  'com.dina.trust.reaction':          reactions,
  'com.dina.trust.revocation':        revocations,
  'com.dina.trust.delegation':        delegations,
  'com.dina.trust.comparison':        comparisons,
  'com.dina.trust.reviewRequest':     reviewRequests,
  'com.dina.trust.collection':        collectionsTable,
  'com.dina.trust.amendment':         amendments,
  'com.dina.trust.verification':      verifications,
  'com.dina.trust.subjectClaim':      subjectClaims,
  'com.dina.trust.trustPolicy':       trustPolicies,
  'com.dina.trust.notificationPrefs': notificationPrefs,
}

/**
 * Get the source table for a collection name.
 * Returns undefined for collections that don't have dedicated tables
 * (e.g., media records stored inline on parent records).
 */
export function getSourceTable(collection: string): PgTable | undefined {
  return COLLECTION_TABLE_MAP[collection]
}

/**
 * CRITICAL: The deletion handler is the ONLY place tombstones are created.
 * It checks for pre-existing disputes (reports, dispute replies, suspicious reactions)
 * BEFORE deleting the record. If disputes exist, a tombstone is created that preserves
 * the metadata shape without the content. This implements the "actions have consequences"
 * principle: undisputed delete = clean erasure, disputed delete = tombstone on author's profile.
 */

export const deletionHandler = {
  async process(
    ctx: HandlerContext,
    uri: string,
    authorDid: string,
    recordType: string,
    sourceTable: PgTable,    // Fix 13: Parameterized — correct table for this record type
  ): Promise<void> {

    // 1. Check if this record was disputed before deletion
    const [reportCount, disputeReplyCount, suspiciousCount] = await Promise.all([
      ctx.db.select({ n: count() })
        .from(reportRecords)
        .where(eq(reportRecords.targetUri, uri))
        .then(r => r[0].n),

      ctx.db.select({ n: count() })
        .from(replies)
        .where(and(
          eq(replies.rootUri, uri),
          inArray(replies.intent, ['dispute', 'disagree', 'correct']),
        ))
        .then(r => r[0].n),

      ctx.db.select({ n: count() })
        .from(reactions)
        .where(and(
          eq(reactions.targetUri, uri),
          eq(reactions.reaction, 'suspicious'),
        ))
        .then(r => r[0].n),
    ])

    const wasDisputed = reportCount > 0 || disputeReplyCount > 0 || suspiciousCount > 0

    // 2. If disputed → create tombstone before deleting.
    //    Query the CORRECT source table (Fix 13), not hardcoded attestations.
    if (wasDisputed) {
      const original = await ctx.db.select()
        .from(sourceTable)
        .where(eq((sourceTable as any).uri, uri))
        .limit(1)
        .then(r => r[0])

      if (original) {
        // Extract common tombstone fields — available on all record types
        const createdAt = (original as any).recordCreatedAt ?? (original as any).createdAt
        const deletedAt = new Date()
        const durationDays = createdAt
          ? Math.floor((deletedAt.getTime() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24))
          : 0

        await ctx.db.insert(tombstones).values({
          originalUri: uri,
          authorDid,
          recordType,
          // Attestation-specific fields are optional on the tombstone
          subjectId: (original as any).subjectId ?? null,
          subjectRefRaw: (original as any).subjectRefRaw ?? null,
          category: (original as any).category ?? null,
          sentiment: (original as any).sentiment ?? null,
          domain: (original as any).domain ?? null,
          originalCreatedAt: createdAt ? new Date(createdAt) : null,
          deletedAt,
          durationDays,
          hadEvidence: Array.isArray((original as any).evidenceJson)
            && (original as any).evidenceJson.length > 0,
          hadCosignature: (original as any).hasCosignature ?? false,
          reportCount,
          disputeReplyCount,
          suspiciousReactionCount: suspiciousCount,
        })

        ctx.logger.info({ uri, authorDid, recordType, reportCount, disputeReplyCount }, 'Tombstone created')
        ctx.metrics.incr('ingester.tombstone.created')
      }
    }

    // 3. Delete from the CORRECT source table (Fix 13)
    await ctx.db.delete(sourceTable).where(eq((sourceTable as any).uri, uri))

    // 4. Remove associated trust edges (if this was a vouch/delegation/endorsement)
    await removeTrustEdge(ctx, uri)

    ctx.metrics.incr(`ingester.deletion.${wasDisputed ? 'tombstoned' : 'clean'}`)
  }
}
```

---

## Deep Dive: Subject Resolution — 3-Tier Identity Strategy (Fix 2 + Fix 10)

### The Problem with Slug-Based Resolution

The original design generated a slug from `name + type` (e.g., `business--darshini-tiffin-center`) and used `ON CONFLICT (slug)` for deduplication. This has two fatal flaws:

1. **False merges (data corruption):** Two different restaurants named "Darshini Tiffin Center" — one in Bangalore, one in Hubli — produce identical slugs. Their reviews merge silently. Once trust scores are computed across the merged entity, the data is corrupted and nearly impossible to untangle.

2. **False splits (fragmentation):** "Darshini Tiffin" and "Darshini Tiffin Center" produce different slugs. Reviews for the same place are split across two subjects. The `ON CONFLICT` merge never fires.

### Design Principle: Optimize for False Negatives

In a decentralized system, **fragmentation is an inconvenience; corruption is fatal.** Two subjects that should be one can be merged later by community consensus. One subject that's actually two different real-world entities is nearly impossible to safely split once scores are aggregated.

Therefore: subjects are always isolated unless there is cryptographic or structural proof of identity.

### The 3-Tier Strategy

```
Tier 1: Deterministic Identity (DID / URI / External Identifier)
  → Globally unique. Same ID from any author. This is the happy path.
  → Dina agents SHOULD resolve identifiers before writing attestations.

Tier 2: Author-Scoped Isolation (Name-only fallback)
  → Hash includes author DID. No global collision possible.
  → Safe but fragmented — each author's name-only review is an island.

Tier 3: Community Merge (Graph healing)
  → Trusted users/labelers assert "Subject A = Subject B"
  → canonicalSubjectId pointer redirects transparently.
  → Resolver follows the chain with cycle detection.
```

### Database Schema

```typescript
// src/db/schema/subjects.ts

import { pgTable, text, timestamp, jsonb, index, boolean } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const subjects = pgTable('subjects', {
  // Deterministic SHA-256 hash — NOT a random ULID.
  // Tier 1: hash of DID/URI/identifier (globally unique)
  // Tier 2: hash of name + type + authorDid (author-scoped)
  id: text('id').primaryKey(),

  name: text('name').notNull(),
  subjectType: text('subject_type').notNull(),

  // ── Deterministic Identity Fields ──
  did: text('did'),                                    // For DID-type subjects
  identifiersJson: jsonb('identifiers_json')           // [{uri: "..."}, {google_maps: "..."}, ...]
    .default(sql`'[]'::jsonb`)
    .notNull(),

  // ── Author Scope (Tier 2 only) ──
  // Non-null only for name-only subjects. Indicates this subject
  // is scoped to a specific author and may need community merging.
  authorScopedDid: text('author_scoped_did'),

  // ── Merge Pointer (Tier 3) ──
  // If this subject has been merged into a canonical subject by
  // community consensus, this points to the canonical ID.
  // The resolver follows this chain (with cycle detection).
  canonicalSubjectId: text('canonical_subject_id'),

  // ── Dirty flag for incremental scoring (Fix 9) ──
  needsRecalc: boolean('needs_recalc').default(true).notNull(),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  didIdx: index('idx_subjects_did').on(table.did),
  // GIN index for fast JSONB containment queries on identifiers
  identifiersIdx: index('idx_subjects_identifiers')
    .using('gin', table.identifiersJson),
  // Partial index: only author-scoped subjects (for merge candidate discovery)
  authorScopedIdx: index('idx_subjects_author_scoped')
    .on(table.authorScopedDid)
    .where(sql`author_scoped_did IS NOT NULL`),
  // Partial index: only merged subjects (for chain resolution)
  canonicalIdx: index('idx_subjects_canonical')
    .on(table.canonicalSubjectId)
    .where(sql`canonical_subject_id IS NOT NULL`),
}))
```

### The Resolver

```typescript
// src/db/queries/subjects.ts

import { createHash } from 'crypto'
import { sql, eq } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection'
import type { SubjectRef } from '@/shared/types/lexicon-types'
import { subjects } from '@/db/schema'

/**
 * Deterministic ID generation based on the strongest available evidence.
 *
 * Tier 1 (global): DID, URI, or external identifier → same hash regardless
 * of who writes the attestation. Two people reviewing the same Google Maps
 * place produce the same subject ID.
 *
 * Tier 2 (author-scoped): Name + type + authorDid → unique per author.
 * Alice reviewing "Darshini Tiffin Center" and Bob reviewing "Darshini Tiffin
 * Center" get DIFFERENT subject IDs. No global collision possible.
 *
 * The priority order matches the resolution order: DID beats URI beats
 * identifier beats name-only. If an attestation provides a Google Maps
 * Place ID, the name is just a display label — not an identity signal.
 */
function generateDeterministicId(
  ref: SubjectRef,
  authorDid: string,
): { id: string; isAuthorScoped: boolean } {
  const hash = createHash('sha256')

  // Tier 1: Cryptographic / structural identity
  if (ref.did) {
    hash.update(`did:${ref.did}`)
    return { id: `sub_${hash.digest('hex').slice(0, 32)}`, isAuthorScoped: false }
  }

  if (ref.uri) {
    hash.update(`uri:${ref.uri}`)
    return { id: `sub_${hash.digest('hex').slice(0, 32)}`, isAuthorScoped: false }
  }

  if (ref.identifier) {
    // External identifiers: Google Maps Place ID, ASIN, ISBN, UPC, etc.
    hash.update(`id:${ref.identifier}`)
    return { id: `sub_${hash.digest('hex').slice(0, 32)}`, isAuthorScoped: false }
  }

  // Tier 2: Name-only — scope to author to prevent global collisions.
  // "Darshini Tiffin Center" from Alice ≠ "Darshini Tiffin Center" from Bob
  hash.update(`name:${ref.type}:${ref.name?.toLowerCase().trim()}:${authorDid}`)
  return { id: `sub_${hash.digest('hex').slice(0, 32)}`, isAuthorScoped: true }
}

/**
 * Resolve a subjectRef to a canonical subject ID, creating if needed.
 *
 * CRITICAL (Fix 2): Atomic upsert — no SELECT-then-INSERT race.
 * CRITICAL (Fix 10): 3-tier identity — no slug-based global collisions.
 *
 * The function:
 * 1. Generates a deterministic ID from the strongest available evidence
 * 2. Atomically inserts or updates the subject (ON CONFLICT on primary key)
 * 3. Follows the canonical merge chain if the subject was merged
 * 4. Returns the final canonical subject ID
 */
export async function resolveOrCreateSubject(
  db: DrizzleDB,
  ref: SubjectRef,
  authorDid: string,
): Promise<string> {

  const { id: deterministicId, isAuthorScoped } = generateDeterministicId(ref, authorDid)

  // Build identifiers array from what we have
  const identifiers: Record<string, string>[] = []
  if (ref.uri) identifiers.push({ uri: ref.uri })
  if (ref.identifier) identifiers.push({ id: ref.identifier })

  const name = ref.name || ref.uri || ref.did || 'Unknown Subject'

  // Atomic upsert on PRIMARY KEY (id).
  // Because the ID is a deterministic hash, concurrent handlers with
  // the same input produce the same ID, hitting ON CONFLICT correctly.
  // No slug. No TOCTOU race. The database handles concurrency.
  const result = await db.execute(sql`
    INSERT INTO subjects (
      id, name, subject_type, did, identifiers_json,
      author_scoped_did, created_at, updated_at
    )
    VALUES (
      ${deterministicId},
      ${name},
      ${ref.type},
      ${ref.did ?? null},
      ${JSON.stringify(identifiers)}::jsonb,
      ${isAuthorScoped ? authorDid : null},
      NOW(),
      NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      updated_at = NOW(),
      -- Progressively merge identifiers: Google Maps from one attestation
      -- + Zomato from another → both accumulated on the canonical record
      identifiers_json = subjects.identifiers_json || EXCLUDED.identifiers_json
    RETURNING id, canonical_subject_id
  `)

  const row = result.rows[0]
  const canonicalId = row.canonical_subject_id as string | null

  // If this subject was merged into another, follow the chain
  if (canonicalId) {
    return resolveCanonicalChain(db, canonicalId)
  }

  return row.id as string
}

/**
 * Follow the canonical merge chain to find the root subject.
 *
 * If Subject A → B → C, resolving A returns C.
 *
 * CRITICAL: Cycle detection. If a bad merge creates A → B → A,
 * we must not loop forever. Cap at MAX_CHAIN_DEPTH and return
 * the last valid ID if a cycle is detected.
 */
const MAX_CHAIN_DEPTH = 5

async function resolveCanonicalChain(
  db: DrizzleDB,
  startId: string,
): Promise<string> {
  const visited = new Set<string>()
  let currentId = startId

  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    // Cycle detection
    if (visited.has(currentId)) {
      // Log warning — a merge cycle exists and should be investigated
      console.warn(`[Subjects] Merge cycle detected at ${currentId}, visited: ${[...visited]}`)
      return currentId
    }
    visited.add(currentId)

    const result = await db.execute(sql`
      SELECT canonical_subject_id FROM subjects WHERE id = ${currentId}
    `)

    const nextId = result.rows[0]?.canonical_subject_id as string | null
    if (!nextId) {
      return currentId  // Reached the root — no further pointer
    }

    currentId = nextId
  }

  // Exceeded max depth — return what we have
  console.warn(`[Subjects] Merge chain exceeded ${MAX_CHAIN_DEPTH} hops from ${startId}`)
  return currentId
}
```

### Why Dina Agents Must Populate Tier 1

The 3-tier strategy is correct, but the *default experience* should be Tier 1 — not Tier 2. If most attestations arrive as name-only, the trust network becomes a forest of disconnected author-scoped islands. That's safe but useless.

The fix isn't to weaken Tier 2 isolation — it's to make Tier 1 the overwhelmingly common path. **Dina agents should be doing the resolution work:**

1. User says "review Darshini Tiffin Center on Indiranagar 100ft Road"
2. Agent looks up the Google Maps Place ID (`ChIJ_abc123...`)
3. Agent queries the AppView's `/search` endpoint for existing subjects matching that Place ID
4. Agent populates the attestation with `identifier: "google-maps:ChIJ_abc123..."` before writing to the PDS

Now the attestation hits Tier 1 deterministically — same hash as every other attestation with that Place ID. Name-only Tier 2 attestations should be the rare exception (offline users, API-only clients without agent assistance), not the default path.

This means the `com.dina.trust.attestation` lexicon's `subject` field should **strongly prefer** structured identifiers. The agent documentation should emphasize that providing a bare name is a degraded experience.

### Community Merge (Tier 3)

When orphaned Tier 2 subjects accumulate around the same real-world entity, they can be merged using the existing `com.dina.trust.amendment` lexicon (or a future `subjectMerge` lexicon). A trusted labeler or community moderator asserts "Subject A is the same as Subject B."

The Scorer processes the merge:

```typescript
// src/scorer/jobs/process-merges.ts

/**
 * Process community-asserted subject merges.
 *
 * When a trusted labeler asserts that Subject A = Subject B,
 * this job:
 * 1. Sets A.canonical_subject_id = B.id
 * 2. Marks both A and B as needs_recalc = true
 * 3. Future attestations referencing A transparently resolve to B
 * 4. Existing attestations on A remain linked to A but resolve
 *    through the chain to B at query time
 *
 * Merge direction: the subject with MORE attestations becomes
 * the canonical target. Fewer attestations get redirected.
 */
export async function processMerge(
  db: DrizzleDB,
  sourceId: string,       // Subject being merged away
  targetId: string,       // Subject being merged into (canonical)
  asserterDid: string,    // Who asserted the merge
): Promise<void> {

  // Prevent self-merge
  if (sourceId === targetId) return

  // Prevent cycles: ensure target doesn't already point back to source
  const targetCanonical = await resolveCanonicalChain(db, targetId)
  if (targetCanonical === sourceId) {
    console.warn(`[Merge] Rejecting merge ${sourceId} → ${targetId}: would create cycle`)
    return
  }

  // Set the merge pointer
  await db
    .update(subjects)
    .set({
      canonicalSubjectId: targetId,
      updatedAt: new Date(),
    })
    .where(eq(subjects.id, sourceId))

  // Mark both for score recalculation
  await markDirty(db, { subjectId: sourceId, authorDid: asserterDid })
  await markDirty(db, { subjectId: targetId, authorDid: asserterDid })

  logger.info({ sourceId, targetId, asserterDid }, 'Subject merge processed')
}
```

### Handling Canonical Chains in the Resolve Endpoint

The `/resolve` XRPC endpoint must follow the canonical chain when looking up subject scores:

```typescript
// In computeResolveResponse (src/app/xrpc/com.dina.trust.resolve/route.ts)

// 1. Parse the subject reference
const subjectRef = JSON.parse(subjectJson)

// 2. Resolve to canonical subject (follows merge chain)
const subject = await resolveSubject(db, subjectRef)
if (!subject) {
  return { error: 'SubjectNotFound', message: 'No matching subject found' }
}

// subject.id is already the canonical ID (merge chain resolved)
// All score lookups use this canonical ID
const scores = await db.select()
  .from(subjectScores)
  .where(eq(subjectScores.subjectId, subject.id))
  .limit(1)
```

### Why This Is Mathematically Sound

1. **Zero data corruption:** A generic "Darshini Tiffin Center" review from Alice in Bangalore will NEVER silently merge with Bob's review of a different place in Hubli. The author-scoped hash guarantees isolation.

2. **Deterministic upserts preserved:** No random UUIDs during ingestion. The `id` is a SHA-256 hash of the input parameters — concurrent handlers with the same input produce the same ID, hitting `ON CONFLICT` correctly. Fix 2's concurrency guarantee is maintained.

3. **Progressive enrichment preserved:** The `identifiers_json || EXCLUDED.identifiers_json` merge still works. If one attestation adds a Google Maps URL and another adds a Zomato URL, both accumulate on the canonical record.

4. **Graph healing:** The `canonicalSubjectId` pointer gives trusted labelers a safe merge mechanism. The chain is followed transparently at query time, with cycle detection capped at 5 hops.

---

## Deep Dive: Incremental Dirty-Flag Scoring (Fix 9)

```typescript
// src/db/queries/dirty-flags.ts

import { sql, eq, inArray } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection'
import { didProfiles, subjectScores } from '@/db/schema'

/**
 * Mark entities for incremental recalculation by the Scorer.
 *
 * CRITICAL (Fix 9): MVCC thrashing prevention.
 *
 * PostgreSQL uses MVCC — every UPDATE creates a new row tuple and marks the
 * old one as dead. If the Scorer rewrites ALL 1M did_profiles rows every 5
 * minutes, that's 288M dead tuples per day. Autovacuum can't keep up. Table
 * bloat grows unbounded, indexes degrade, query performance collapses in days.
 *
 * The fix: the Ingester marks only the affected entities as dirty. The Scorer
 * processes only dirty rows (SELECT WHERE needs_recalc = true LIMIT 5000),
 * then flips the flag back to false. If 50 attestations come in during a
 * 5-minute window, the Scorer touches ~50-200 rows, not 1M.
 *
 * This is called from every handler (attestation, vouch, flag, etc.) after
 * the record is written.
 */

interface DirtyMarkParams {
  /** Subject that was attested about */
  subjectId: string | null
  /** Author who wrote the record */
  authorDid: string
  /** DIDs mentioned in the record */
  mentionedDids?: { did: string }[]
  /** If the subject is a DID, mark their profile too */
  subjectDid?: string | null
  /** Co-signer DID, if any */
  cosignerDid?: string | null
}

export async function markDirty(
  db: DrizzleDB,
  params: DirtyMarkParams,
): Promise<void> {

  // ── Mark subject_scores as dirty ──
  if (params.subjectId) {
    await db
      .insert(subjectScores)
      .values({
        subjectId: params.subjectId,
        needsRecalc: true,
        computedAt: new Date(0),     // Epoch — signals "never computed"
      })
      .onConflictDoUpdate({
        target: subjectScores.subjectId,
        set: { needsRecalc: true },
      })
  }

  // ── Mark did_profiles as dirty ──
  // Collect all DIDs affected by this record
  const affectedDids = new Set<string>()
  affectedDids.add(params.authorDid)

  if (params.subjectDid) affectedDids.add(params.subjectDid)
  if (params.cosignerDid) affectedDids.add(params.cosignerDid)

  if (params.mentionedDids) {
    for (const m of params.mentionedDids) {
      affectedDids.add(m.did)
    }
  }

  // Upsert all affected profiles as needing recalculation
  for (const did of affectedDids) {
    await db
      .insert(didProfiles)
      .values({
        did,
        needsRecalc: true,
        computedAt: new Date(0),
      })
      .onConflictDoUpdate({
        target: didProfiles.did,
        set: { needsRecalc: true },
      })
  }
}
```

The Scorer jobs then process only dirty rows:

```typescript
// src/scorer/jobs/refresh-profiles.ts (incremental pattern)

import { eq, sql } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection'
import { didProfiles } from '@/db/schema'
import { computeTrustScore } from '../algorithms/trust-score'
import { logger } from '@/shared/utils/logger'
import { metrics } from '@/shared/utils/metrics'

/**
 * Incremental profile refresh.
 *
 * Instead of rewriting ALL did_profiles every 5 minutes (which generates
 * millions of MVCC dead tuples), this job only touches rows where
 * needs_recalc = true — i.e., rows whose underlying data actually changed
 * since the last run.
 *
 * The partial index (WHERE needs_recalc = true) makes the SELECT instant
 * regardless of total table size. At steady state, this job touches
 * tens to hundreds of rows, not millions.
 *
 * BATCH_SIZE prevents a single run from hogging the DB connection for too
 * long. If more than BATCH_SIZE rows are dirty, they'll be picked up in
 * the next scheduled run (5 minutes later).
 */

const BATCH_SIZE = 5000

export async function refreshProfiles(db: DrizzleDB): Promise<void> {
  // 1. Fetch dirty profiles
  const dirtyProfiles = await db
    .select({ did: didProfiles.did })
    .from(didProfiles)
    .where(eq(didProfiles.needsRecalc, true))
    .limit(BATCH_SIZE)

  if (dirtyProfiles.length === 0) {
    logger.debug('No dirty profiles to refresh')
    return
  }

  logger.info({ count: dirtyProfiles.length }, 'Refreshing dirty profiles')
  let updated = 0

  for (const { did } of dirtyProfiles) {
    try {
      // 2. Gather inputs from raw tables
      const inputs = await gatherTrustScoreInputs(db, did)

      // 3. Compute new scores
      const result = computeTrustScore(inputs)

      // 4. Update ONLY this row, flip needsRecalc = false
      await db
        .update(didProfiles)
        .set({
          overallTrustScore: result.overallScore,
          totalAttestationsAbout: inputs.attestationsAbout.length,
          positiveAbout: inputs.attestationsAbout.filter(a => a.sentiment === 'positive').length,
          neutralAbout: inputs.attestationsAbout.filter(a => a.sentiment === 'neutral').length,
          negativeAbout: inputs.attestationsAbout.filter(a => a.sentiment === 'negative').length,
          vouchCount: inputs.vouchCount,
          highConfidenceVouches: inputs.highConfidenceVouches,
          // ... all other aggregated fields ...
          needsRecalc: false,
          computedAt: new Date(),
        })
        .where(eq(didProfiles.did, did))

      updated++
    } catch (err) {
      logger.error({ err, did }, 'Failed to refresh profile')
      metrics.incr('scorer.profile.errors')
    }
  }

  logger.info({ updated, total: dirtyProfiles.length }, 'Profile refresh complete')
  metrics.counter('scorer.profiles.updated', updated)
  metrics.gauge('scorer.profiles.dirty_remaining',
    dirtyProfiles.length === BATCH_SIZE ? 'overflow' : 0)
}

/**
 * Gather raw data for trust score computation.
 * Queries attestations, vouches, endorsements, flags, etc. for a single DID.
 */
async function gatherTrustScoreInputs(db: DrizzleDB, did: string) {
  // ... queries against raw record tables to build TrustScoreInput ...
  // This is per-DID so it's efficient — indexed lookups, not table scans.
}
```

```typescript
// src/scorer/jobs/refresh-subject-scores.ts (same incremental pattern)

const BATCH_SIZE = 5000

export async function refreshSubjectScores(db: DrizzleDB): Promise<void> {
  const dirtySubjects = await db
    .select({ subjectId: subjectScores.subjectId })
    .from(subjectScores)
    .where(eq(subjectScores.needsRecalc, true))
    .limit(BATCH_SIZE)

  if (dirtySubjects.length === 0) return

  logger.info({ count: dirtySubjects.length }, 'Refreshing dirty subject scores')

  for (const { subjectId } of dirtySubjects) {
    try {
      const aggregated = await aggregateSubjectAttestations(db, subjectId)

      await db
        .update(subjectScores)
        .set({
          totalAttestations: aggregated.total,
          positive: aggregated.positive,
          neutral: aggregated.neutral,
          negative: aggregated.negative,
          weightedScore: aggregated.weightedScore,
          confidence: aggregated.confidence,
          dimensionSummaryJson: aggregated.dimensionSummary,
          authenticityConsensus: aggregated.authenticityConsensus,
          authenticityConfidence: aggregated.authenticityConfidence,
          wouldRecommendRate: aggregated.wouldRecommendRate,
          verifiedAttestationCount: aggregated.verifiedCount,
          lastAttestationAt: aggregated.lastAttestationAt,
          attestationVelocity: aggregated.velocity,
          needsRecalc: false,
          computedAt: new Date(),
        })
        .where(eq(subjectScores.subjectId, subjectId))
    } catch (err) {
      logger.error({ err, subjectId }, 'Failed to refresh subject score')
    }
  }
}
```

**Why this eliminates MVCC thrashing:**

At steady state with moderate activity (say 500 attestations per 5-minute window), the Scorer touches ~500-2000 rows across `did_profiles` and `subject_scores` — not the full 1M+ rows in each table. Dead tuple generation drops from 288M/day to ~500K/day. Autovacuum has no trouble keeping up. Table bloat stays flat. Indexes stay compact.

The partial index `WHERE needs_recalc = true` ensures the dirty-row lookup is instant even at 10M total profiles — Postgres only indexes the (typically small) set of rows where the flag is true.

---

## Deep Dive: Database Schema

### Core Record Tables

```typescript
// src/db/schema/attestations.ts

import { pgTable, text, timestamp, boolean, jsonb, real, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { subjects } from './subjects'

export const attestations = pgTable('attestations', {
  uri: text('uri').primaryKey(),
  authorDid: text('author_did').notNull(),
  cid: text('cid').notNull(),

  // Subject
  subjectId: text('subject_id').references(() => subjects.id),
  subjectRefRaw: jsonb('subject_ref_raw').notNull(),

  // Core
  category: text('category').notNull(),
  sentiment: text('sentiment').notNull(),
  domain: text('domain'),
  confidence: text('confidence'),
  isAgentGenerated: boolean('is_agent_generated').default(false),

  // Bilateral
  hasCosignature: boolean('has_cosignature').default(false),
  cosignerDid: text('cosigner_did'),

  // JSONB context
  dimensionsJson: jsonb('dimensions_json'),
  interactionContextJson: jsonb('interaction_context_json'),
  contentContextJson: jsonb('content_context_json'),
  productContextJson: jsonb('product_context_json'),
  evidenceJson: jsonb('evidence_json'),
  mentionsJson: jsonb('mentions_json'),
  relatedAttestationsJson: jsonb('related_attestations_json'),
  bilateralReviewJson: jsonb('bilateral_review_json'),

  // Searchable
  tags: text('tags').array(),
  text: text('text'),
  searchContent: text('search_content'),             // Raw text; tsvector generated column below

  // Timestamps
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),

  // Status (set by revocation/amendment handlers)
  isRevoked: boolean('is_revoked').default(false),
  revokedByUri: text('revoked_by_uri'),
  isAmended: boolean('is_amended').default(false),
  latestAmendmentUri: text('latest_amendment_uri'),

}, (table) => ({
  authorIdx: index('idx_att_author').on(table.authorDid),
  subjectIdx: index('idx_att_subject').on(table.subjectId),
  sentimentIdx: index('idx_att_sentiment').on(table.sentiment),
  domainIdx: index('idx_att_domain').on(table.domain),
  categoryIdx: index('idx_att_category').on(table.category),
  createdIdx: index('idx_att_created').on(table.recordCreatedAt),
  tagsIdx: index('idx_att_tags').using('gin', table.tags),
  cosignerIdx: index('idx_att_cosigner').on(table.cosignerDid),
  subjectSentimentIdx: index('idx_att_subject_sentiment').on(table.subjectId, table.sentiment),
  authorDomainIdx: index('idx_att_author_domain').on(table.authorDid, table.domain),
}))

// Generated tsvector column + GIN index added via raw migration:
//
// ALTER TABLE attestations ADD COLUMN search_vector tsvector
//   GENERATED ALWAYS AS (to_tsvector('english', coalesce(search_content, ''))) STORED;
// CREATE INDEX idx_att_search ON attestations USING gin(search_vector);
```

```typescript
// src/db/schema/trust-edges.ts

export const trustEdges = pgTable('trust_edges', {
  id: text('id').primaryKey().$defaultFn(() => generateUlid()),
  fromDid: text('from_did').notNull(),
  toDid: text('to_did').notNull(),
  edgeType: text('edge_type').notNull(),     // vouch | endorsement | delegation | cosign | positive-attestation
  domain: text('domain'),
  weight: real('weight').notNull(),
  sourceUri: text('source_uri').notNull().unique(),   // Record that created this edge
  createdAt: timestamp('created_at').notNull(),

}, (table) => ({
  fromIdx: index('idx_te_from').on(table.fromDid),
  toIdx: index('idx_te_to').on(table.toDid),
  fromToIdx: index('idx_te_from_to').on(table.fromDid, table.toDid),
  typeIdx: index('idx_te_type').on(table.edgeType),
}))
```

```typescript
// src/db/schema/tombstones.ts

export const tombstones = pgTable('tombstones', {
  id: text('id').primaryKey().$defaultFn(() => generateUlid()),
  originalUri: text('original_uri').notNull().unique(),
  authorDid: text('author_did').notNull(),
  recordType: text('record_type').notNull(),

  subjectId: text('subject_id'),
  subjectRefRaw: jsonb('subject_ref_raw'),
  category: text('category'),
  sentiment: text('sentiment'),
  domain: text('domain'),

  originalCreatedAt: timestamp('original_created_at'),
  deletedAt: timestamp('deleted_at').notNull(),
  durationDays: integer('duration_days'),
  hadEvidence: boolean('had_evidence').default(false),
  hadCosignature: boolean('had_cosignature').default(false),

  reportCount: integer('report_count').default(0),
  disputeReplyCount: integer('dispute_reply_count').default(0),
  suspiciousReactionCount: integer('suspicious_reaction_count').default(0),

}, (table) => ({
  authorIdx: index('idx_tomb_author').on(table.authorDid),
  subjectIdx: index('idx_tomb_subject').on(table.subjectId),
  deletedIdx: index('idx_tomb_deleted').on(table.deletedAt),
}))
```

### Materialized Tables

```typescript
// src/db/schema/did-profiles.ts
// Refreshed INCREMENTALLY by Scorer — only rows where needsRecalc = true

export const didProfiles = pgTable('did_profiles', {
  did: text('did').primaryKey(),

  // ── Dirty flag (Fix 9) ──
  // Set to true by the Ingester whenever a record affecting this DID is created/deleted.
  // The Scorer processes only needsRecalc=true rows, then flips back to false.
  // This prevents full-table rewrites that generate millions of MVCC dead tuples.
  needsRecalc: boolean('needs_recalc').default(true).notNull(),

  // As subject
  totalAttestationsAbout: integer('total_attestations_about').default(0),
  positiveAbout: integer('positive_about').default(0),
  neutralAbout: integer('neutral_about').default(0),
  negativeAbout: integer('negative_about').default(0),

  vouchCount: integer('vouch_count').default(0),
  vouchStrength: text('vouch_strength').default('unvouched'),
  highConfidenceVouches: integer('high_confidence_vouches').default(0),

  endorsementCount: integer('endorsement_count').default(0),
  topSkillsJson: jsonb('top_skills_json'),

  activeFlagCount: integer('active_flag_count').default(0),

  // As reviewer
  totalAttestationsBy: integer('total_attestations_by').default(0),
  revocationCount: integer('revocation_count').default(0),
  deletionCount: integer('deletion_count').default(0),
  disputedThenDeletedCount: integer('disputed_then_deleted_count').default(0),
  revocationRate: real('revocation_rate').default(0),
  deletionRate: real('deletion_rate').default(0),
  corroborationRate: real('corroboration_rate').default(0),
  evidenceRate: real('evidence_rate').default(0),
  averageHelpfulRatio: real('average_helpful_ratio').default(0),

  // Activity
  activeDomains: text('active_domains').array(),
  isAgent: boolean('is_agent').default(false),
  accountFirstSeen: timestamp('account_first_seen'),
  lastActive: timestamp('last_active'),

  coordinationFlagCount: integer('coordination_flag_count').default(0),

  overallTrustScore: real('overall_trust_score'),

  computedAt: timestamp('computed_at').notNull(),
}, (table) => ({
  // Partial index: only index rows that need recalculation.
  // The Scorer queries: SELECT ... WHERE needs_recalc = true LIMIT 5000
  // This index makes that query instant regardless of total table size.
  needsRecalcIdx: index('idx_did_profiles_needs_recalc')
    .on(table.needsRecalc)
    .where(sql`needs_recalc = true`),
}))
```

```typescript
// src/db/schema/subject-scores.ts
// Refreshed INCREMENTALLY by Scorer — only rows where needsRecalc = true

export const subjectScores = pgTable('subject_scores', {
  subjectId: text('subject_id').primaryKey().references(() => subjects.id),

  // ── Dirty flag (Fix 9) ──
  needsRecalc: boolean('needs_recalc').default(true).notNull(),

  totalAttestations: integer('total_attestations').default(0),
  positive: integer('positive').default(0),
  neutral: integer('neutral').default(0),
  negative: integer('negative').default(0),

  weightedScore: real('weighted_score'),
  confidence: real('confidence'),

  dimensionSummaryJson: jsonb('dimension_summary_json'),

  authenticityConsensus: text('authenticity_consensus'),
  authenticityConfidence: real('authenticity_confidence'),

  wouldRecommendRate: real('would_recommend_rate'),
  verifiedAttestationCount: integer('verified_attestation_count').default(0),

  lastAttestationAt: timestamp('last_attestation_at'),
  attestationVelocity: real('attestation_velocity'),

  computedAt: timestamp('computed_at').notNull(),
}, (table) => ({
  needsRecalcIdx: index('idx_subject_scores_needs_recalc')
    .on(table.needsRecalc)
    .where(sql`needs_recalc = true`),
}))
```

---

## Deep Dive: Graph Queries (Runtime, Not Precomputed)

```typescript
// src/db/queries/graph.ts

import { sql } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection'

/**
 * Graph traversal at runtime.
 *
 * DESIGN DECISION: 1-hop and 2-hop queries run at request time.
 * No precomputed trust_distances table. No write amplification.
 *
 * At 500K trust_edges with composite index on (from_did, to_did),
 * these queries return in <1ms.
 *
 * 3+ hops: not supported in v1. If a user's trustPolicy requests
 * deeper traversal, the API returns what it can (2 hops) and notes
 * the limitation. Deeper traversal deferred to dedicated graph engine.
 *
 * HARDENING (Fix 3): Super-node protection.
 * A "super-node" is a DID with thousands of outbound trust edges
 * (e.g., a global moderator, an automated labeler). Joining through
 * a super-node creates massive fan-out that can spike query latency
 * from <1ms to seconds. All graph queries apply:
 *
 * 1. Fan-out caps: LIMIT on intermediate result sets (max 500 edges
 *    per hop). Mutual connections become approximate for super-nodes,
 *    which is acceptable — these are soft signals, not precise counts.
 *
 * 2. Statement timeout: Every graph query runs within a 100ms timeout.
 *    If exceeded, the query is cancelled and the field returns null.
 *    The rest of the resolve response proceeds normally.
 *
 * 3. Graceful degradation: The API never blocks or errors due to
 *    graph complexity. It returns whatever it can compute in time.
 */

/** Maximum edges to scan per hop to prevent super-node fan-out */
const MAX_EDGES_PER_HOP = 500

/** Maximum time for any graph query before graceful degradation */
const GRAPH_QUERY_TIMEOUT_MS = 100

export interface GraphContext {
  shortestPath: number | null
  mutualConnections: number | null       // null = timed out or exceeded fan-out cap
  trustedAttestors: string[]
}

/**
 * Execute a graph query with a transaction-scoped statement timeout.
 *
 * CRITICAL (Fix 4): Connection pool poisoning prevention.
 *
 * The naive approach — `SET LOCAL statement_timeout` outside a transaction —
 * is dangerous in a pooled environment. Sequential `db.execute()` calls are
 * NOT guaranteed to use the same underlying connection. If the query times out
 * and throws before `RESET statement_timeout` runs, the connection is returned
 * to the pool with a 100ms kill switch still active. Any future query on that
 * connection — including critical writes — will be killed if it exceeds 100ms.
 * This is "connection pool poisoning" — a silent corruption that manifests as
 * random failures hours later.
 *
 * The fix: wrap in db.transaction(). PostgreSQL guarantees that SET LOCAL
 * applies ONLY to the current transaction. When the transaction ends (commit
 * or rollback), the setting is automatically discarded. No leak possible.
 *
 * The transaction also guarantees we hold a single connection from checkout
 * to completion — no mid-query connection switching.
 */
async function withGraphTimeout<T>(
  db: DrizzleDB,
  queryFn: (tx: DrizzleTransaction) => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      // SET LOCAL is scoped to this transaction. Automatically discarded
      // when the transaction ends. Zero chance of pool poisoning.
      await tx.execute(sql`SET LOCAL statement_timeout = ${GRAPH_QUERY_TIMEOUT_MS}`)
      return await queryFn(tx)
    })
  } catch (err: any) {
    // 57014 = query_canceled (Postgres protocol error for statement timeout)
    if (err?.code === '57014' || err?.message?.includes('statement timeout')) {
      return fallback
    }
    throw err
  }
}

export async function computeGraphContext(
  db: DrizzleDB,
  requesterDid: string,
  subjectDid: string,
  subjectId: string | null,
): Promise<GraphContext> {

  // ── 1-hop: direct trust edge? ──
  const directEdge = await db.execute(sql`
    SELECT 1 FROM trust_edges
    WHERE from_did = ${requesterDid}
      AND to_did = ${subjectDid}
    LIMIT 1
  `)

  if (directEdge.rows.length > 0) {
    const [mutual, attestors] = await Promise.all([
      computeMutualConnections(db, requesterDid, subjectDid),
      computeTrustedAttestors(db, requesterDid, subjectId),
    ])
    return { shortestPath: 1, mutualConnections: mutual, trustedAttestors: attestors }
  }

  // ── 2-hop: one intermediate DID? ──
  // Fan-out cap: only consider first 500 outbound edges from requester
  const twoHop = await db.execute(sql`
    SELECT e2.from_did AS via_did
    FROM (
      SELECT to_did FROM trust_edges
      WHERE from_did = ${requesterDid}
      ORDER BY weight DESC
      LIMIT ${MAX_EDGES_PER_HOP}
    ) e1
    JOIN trust_edges e2 ON e1.to_did = e2.from_did
    WHERE e2.to_did = ${subjectDid}
    LIMIT 1
  `)

  const shortestPath = twoHop.rows.length > 0 ? 2 : null

  const [mutual, attestors] = await Promise.all([
    computeMutualConnections(db, requesterDid, subjectDid),
    computeTrustedAttestors(db, requesterDid, subjectId),
  ])

  return { shortestPath, mutualConnections: mutual, trustedAttestors: attestors }
}

async function computeMutualConnections(
  db: DrizzleDB,
  requesterDid: string,
  subjectDid: string,
): Promise<number | null> {
  // Fan-out cap + transaction-scoped timeout to handle super-nodes gracefully.
  return withGraphTimeout(db, async (tx) => {
    const result = await tx.execute(sql`
      SELECT COUNT(DISTINCT e1.to_did) AS count
      FROM (
        SELECT to_did FROM trust_edges
        WHERE from_did = ${requesterDid}
        ORDER BY weight DESC
        LIMIT ${MAX_EDGES_PER_HOP}
      ) e1
      JOIN trust_edges e2 ON e1.to_did = e2.from_did
      WHERE e2.to_did = ${subjectDid}
    `)
    return Number(result.rows[0]?.count ?? 0)
  }, null)
}

async function computeTrustedAttestors(
  db: DrizzleDB,
  requesterDid: string,
  subjectId: string | null,
): Promise<string[]> {
  if (!subjectId) return []

  return withGraphTimeout(db, async () => {
    const result = await db.execute(sql`
      SELECT DISTINCT a.author_did
      FROM attestations a
      JOIN (
        SELECT to_did FROM trust_edges
        WHERE from_did = ${requesterDid}
        ORDER BY weight DESC
        LIMIT ${MAX_EDGES_PER_HOP}
      ) e ON a.author_did = e.to_did
      WHERE a.subject_id = ${subjectId}
        AND a.is_revoked = false
      LIMIT 10
    `)
    return result.rows.map(r => r.author_did as string)
  }, [])      // empty array = "couldn't compute within budget"
}

/**
 * Get trust graph for visualization (getGraph query).
 * Returns nodes and edges within N hops of center DID.
 * Capped at 2 hops for Postgres. Fan-out capped per hop.
 */
export async function getGraphAroundDid(
  db: DrizzleDB,
  centerDid: string,
  maxDepth: number = 2,
  domain?: string,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {

  const depthLimit = Math.min(maxDepth, 2)

  const nodesMap = new Map<string, { did: string; depth: number }>()
  nodesMap.set(centerDid, { did: centerDid, depth: 0 })

  // Depth 1 (capped at MAX_EDGES_PER_HOP)
  const depth1 = await db.execute(sql`
    SELECT to_did, edge_type, weight, domain
    FROM trust_edges
    WHERE from_did = ${centerDid}
    ${domain ? sql`AND (domain = ${domain} OR domain IS NULL)` : sql``}
    ORDER BY weight DESC
    LIMIT ${MAX_EDGES_PER_HOP}
  `)

  const edges: GraphEdge[] = []
  for (const row of depth1.rows) {
    const toDid = row.to_did as string
    nodesMap.set(toDid, { did: toDid, depth: 1 })
    edges.push({
      from: centerDid,
      to: toDid,
      type: row.edge_type as string,
      weight: row.weight as number,
    })
  }

  // Depth 2 (capped per source node)
  if (depthLimit >= 2 && depth1.rows.length > 0) {
    const depth1Dids = depth1.rows.map(r => r.to_did as string)

    // Cap total depth-2 results to prevent explosion
    const depth2 = await db.execute(sql`
      SELECT from_did, to_did, edge_type, weight, domain
      FROM trust_edges
      WHERE from_did = ANY(${depth1Dids})
        AND to_did != ${centerDid}
        ${domain ? sql`AND (domain = ${domain} OR domain IS NULL)` : sql``}
      ORDER BY weight DESC
      LIMIT ${MAX_EDGES_PER_HOP}
    `)

    for (const row of depth2.rows) {
      const toDid = row.to_did as string
      if (!nodesMap.has(toDid)) {
        nodesMap.set(toDid, { did: toDid, depth: 2 })
      }
      edges.push({
        from: row.from_did as string,
        to: toDid,
        type: row.edge_type as string,
        weight: row.weight as number,
      })
    }
  }

  const nodes = Array.from(nodesMap.values()).map(n => ({
    did: n.did,
    depth: n.depth,
  }))

  return { nodes, edges }
}

interface GraphNode {
  did: string
  depth: number
}

interface GraphEdge {
  from: string
  to: string
  type: string
  weight: number
}
```

---

## Deep Dive: Scorer

### Job Schedule

```typescript
// src/scorer/scheduler.ts

import cron from 'node-cron'
import { refreshProfiles } from './jobs/refresh-profiles'
import { refreshSubjectScores } from './jobs/refresh-subject-scores'
import { refreshReviewerStats } from './jobs/refresh-reviewer-stats'
import { refreshDomainScores } from './jobs/refresh-domain-scores'
import { detectCoordination } from './jobs/detect-coordination'
import { detectSybil } from './jobs/detect-sybil'
import { processTombstones } from './jobs/process-tombstones'
import { decayScores } from './jobs/decay-scores'
import { cleanupExpired } from './jobs/cleanup-expired'
import type { DrizzleDB } from '@/db/connection'
import { logger } from '@/shared/utils/logger'
import { metrics } from '@/shared/utils/metrics'

interface ScorerJob {
  name: string
  schedule: string
  handler: (db: DrizzleDB) => Promise<void>
}

const jobs: ScorerJob[] = [
  // Incremental jobs — only process dirty rows (Fix 9)
  { name: 'refresh-profiles',       schedule: '*/5 * * * *',    handler: refreshProfiles },
  { name: 'refresh-subject-scores', schedule: '*/5 * * * *',    handler: refreshSubjectScores },
  { name: 'refresh-reviewer-stats', schedule: '*/15 * * * *',   handler: refreshReviewerStats },
  { name: 'refresh-domain-scores',  schedule: '0 * * * *',      handler: refreshDomainScores },
  // Full-scan jobs — run less frequently, scan limited windows
  { name: 'detect-coordination',    schedule: '*/30 * * * *',   handler: detectCoordination },
  { name: 'detect-sybil',           schedule: '0 */6 * * *',    handler: detectSybil },
  { name: 'process-tombstones',     schedule: '*/10 * * * *',   handler: processTombstones },
  { name: 'decay-scores',           schedule: '0 3 * * *',      handler: decayScores },
  { name: 'cleanup-expired',        schedule: '0 4 * * *',      handler: cleanupExpired },
]

export function startScheduler(db: DrizzleDB): void {
  for (const job of jobs) {
    cron.schedule(job.schedule, async () => {
      const start = Date.now()
      logger.info({ job: job.name }, 'Scorer job starting')

      try {
        await job.handler(db)
        const durationMs = Date.now() - start
        logger.info({ job: job.name, durationMs }, 'Scorer job completed')
        metrics.histogram('scorer.job.duration_ms', durationMs, { job: job.name })
      } catch (err) {
        logger.error({ err, job: job.name }, 'Scorer job failed')
        metrics.incr('scorer.job.errors', { job: job.name })
      }
    })

    logger.info({ job: job.name, schedule: job.schedule }, 'Scorer job registered')
  }
}
```

### Trust Score Algorithm

```typescript
// src/scorer/algorithms/trust-score.ts

import { CONSTANTS } from '@/config/constants'

export interface TrustScoreInput {
  // As subject
  attestationsAbout: {
    sentiment: string
    recordCreatedAt: Date
    evidenceJson: unknown[] | null
    hasCosignature: boolean
    isVerified: boolean              // Has a verification record
    authorTrustScore: number | null  // Author's own trust score (for weighting)
    authorHasInboundVouch: boolean   // Fix 12: Does the author have ≥1 vouch from scored DID?
  }[]
  vouchCount: number
  highConfidenceVouches: number
  endorsementCount: number
  activeFlagCount: number
  flagSeverities: string[]

  // As reviewer
  totalAttestationsBy: number
  revocationCount: number
  tombstoneCount: number             // Disputed deletions
  helpfulReactions: number
  unhelpfulReactions: number
  withEvidenceCount: number

  // Network
  inboundEdgeCount: number
  delegationInboundCount: number
}

export interface TrustScoreOutput {
  overallScore: number
  components: {
    sentiment: number
    vouch: number
    reviewer: number
    network: number
  }
  confidence: number
}

/**
 * DAMPING FACTOR (Fix 12): Guarantees convergence of iterative scoring.
 *
 * Trust scores have a circular dependency: computeSentiment() weights
 * attestations by authorTrustScore, which is itself computed by
 * computeTrustScore(). With the dirty-flag pattern (Fix 9), this forms
 * an asynchronous relaxation algorithm:
 *
 *   Alice vouches for Bob → Alice marked dirty → Scorer updates Alice →
 *   Alice's score changes → Bob marked dirty → Scorer updates Bob →
 *   Bob's score changes → ...
 *
 * The damping factor (0.85, same as PageRank) guarantees this iterative
 * process converges to a stable state. Without it, scores can oscillate
 * indefinitely as DIDs mark each other dirty in an infinite loop.
 *
 * Score = DAMPING * computed + (1 - DAMPING) * BASE
 *
 * The (1-DAMPING) * BASE term ensures every DID has a minimum score
 * floor that doesn't depend on the network, preventing score collapse.
 */
const DAMPING_FACTOR = 0.85
const BASE_SCORE = 0.1    // Minimum floor for any DID in the network

export function computeTrustScore(input: TrustScoreInput): TrustScoreOutput {
  const sentiment = computeSentiment(input)
  const vouch = computeVouch(input)
  const reviewer = computeReviewer(input)
  const network = computeNetwork(input)

  let raw = (
    sentiment * CONSTANTS.SENTIMENT_WEIGHT +    // 0.40
    vouch * CONSTANTS.VOUCH_WEIGHT +             // 0.25
    reviewer * CONSTANTS.REVIEWER_WEIGHT +       // 0.20
    network * CONSTANTS.NETWORK_WEIGHT           // 0.15
  )

  // Flag penalties
  for (const severity of input.flagSeverities) {
    if (severity === 'critical')    raw *= 0.3
    else if (severity === 'serious') raw *= 0.6
    else if (severity === 'warning') raw *= 0.85
  }

  // Disputed deletion penalty
  if (input.tombstoneCount >= CONSTANTS.COORDINATION_TOMBSTONE_THRESHOLD) {
    raw *= 0.4
  }

  // Apply damping factor for convergence guarantee
  const overall = DAMPING_FACTOR * raw + (1 - DAMPING_FACTOR) * BASE_SCORE

  const confidence = computeConfidence(input)

  return {
    overallScore: clamp(overall, 0, 1),
    components: { sentiment, vouch, reviewer, network },
    confidence,
  }
}

/**
 * Compute sentiment component from attestations about this DID/subject.
 *
 * CRITICAL (Fix 12): Untrusted-by-default.
 *
 * The old code used `authorTrustScore ?? 0.5` — giving unscored authors
 * the same weight as moderately trusted ones. An attacker could spin up
 * 1,000 sybils, each with default 0.5 weight, and instantly shift a
 * subject's trust score.
 *
 * The fix has two layers:
 *
 * 1. ZERO-TRUST DEFAULT: Unscored authors get weight 0.0, not 0.5.
 *    Their attestations contribute nothing until the Scorer computes
 *    their trust score.
 *
 * 2. VOUCH-GATING: Even if a DID has been scored, their attestations
 *    carry zero weight unless they have at least one inbound vouch from
 *    a DID with score > 0.5. This prevents sybils from bootstrapping
 *    each other — at least one real human in the chain must vouch.
 */
function computeSentiment(input: TrustScoreInput): number {
  const atts = input.attestationsAbout
  if (atts.length === 0) return 0.5    // No data = neutral (not untrusted)

  let weightedPositive = 0
  let weightedTotal = 0

  for (const a of atts) {
    const ageDays = daysSince(a.recordCreatedAt)
    const recency = Math.exp(-ageDays / CONSTANTS.SENTIMENT_HALFLIFE_DAYS)
    const evidence = a.evidenceJson?.length ? CONSTANTS.EVIDENCE_MULTIPLIER : 1.0
    const verified = a.isVerified ? CONSTANTS.VERIFIED_MULTIPLIER : 1.0
    const bilateral = a.hasCosignature ? CONSTANTS.BILATERAL_MULTIPLIER : 1.0

    // Fix 12: ZERO-TRUST DEFAULT + VOUCH-GATING
    // Unscored authors: weight = 0.0 (not 0.5)
    // Scored authors without inbound vouch: weight = 0.0
    // This means sybils contribute nothing regardless of volume.
    let authorWeight = a.authorTrustScore ?? 0.0

    if (!a.authorHasInboundVouch) {
      authorWeight = 0.0
    }

    const weight = recency * evidence * verified * bilateral * authorWeight

    if (a.sentiment === 'positive')     weightedPositive += weight
    else if (a.sentiment === 'neutral') weightedPositive += weight * 0.5

    weightedTotal += weight
  }

  return weightedTotal > 0 ? weightedPositive / weightedTotal : 0.5
}

function computeVouch(input: TrustScoreInput): number {
  if (input.vouchCount === 0) return 0.1

  // Logarithmic — diminishing returns past 10 vouches
  const vouchSignal = Math.min(1.0, Math.log2(input.vouchCount + 1) / Math.log2(11))
  const highConfidenceBonus = Math.min(0.2, input.highConfidenceVouches * 0.05)

  return clamp(vouchSignal + highConfidenceBonus, 0, 1)
}

function computeReviewer(input: TrustScoreInput): number {
  if (input.totalAttestationsBy === 0) return 0.0   // Fix 12: Zero-trust default (was 0.5)

  const total = input.totalAttestationsBy
  const deletionRate = input.tombstoneCount / total
  const evidenceRate = input.withEvidenceCount / total
  const helpfulTotal = input.helpfulReactions + input.unhelpfulReactions
  const helpfulRatio = helpfulTotal > 0 ? input.helpfulReactions / helpfulTotal : 0.5

  let score = 0.3     // Lower starting point than 0.5 — must earn through evidence + helpfulness
  score += helpfulRatio * 0.35
  score += evidenceRate * 0.25
  score -= deletionRate * 2.0         // Harsh penalty

  return clamp(score, 0, 1)
}

function computeNetwork(input: TrustScoreInput): number {
  // Inbound edges = other DIDs trusting this one
  const edgeSignal = Math.min(1.0, Math.log2(input.inboundEdgeCount + 1) / Math.log2(51))
  const delegationBonus = Math.min(0.2, input.delegationInboundCount * 0.04)

  return clamp(edgeSignal + delegationBonus, 0, 1)
}

function computeConfidence(input: TrustScoreInput): number {
  // More data = more confidence
  const totalSignals =
    input.attestationsAbout.length +
    input.vouchCount +
    input.endorsementCount +
    input.totalAttestationsBy

  if (totalSignals === 0)  return 0.0
  if (totalSignals < 3)    return 0.2
  if (totalSignals < 10)   return 0.4
  if (totalSignals < 30)   return 0.6
  if (totalSignals < 100)  return 0.8
  return 0.95
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function daysSince(date: Date): number {
  return (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24)
}
```

---

## Deep Dive: API Cache (Promise Coalescing + Stale-While-Revalidate)

```typescript
// src/api/middleware/swr-cache.ts

import { LRUCache } from 'lru-cache'
import { logger } from '@/shared/utils/logger'
import { metrics } from '@/shared/utils/metrics'

/**
 * SWR cache with promise coalescing for XRPC endpoints.
 *
 * CRITICAL (Fix 6): Cache stampede prevention.
 * See Production Hardening Summary for full explanation.
 *
 * CRITICAL (Fix 8): O(1) LRU eviction.
 *
 * The original implementation used a custom array-based LRU where every
 * cache hit called `Array.indexOf()` + `Array.splice()` on a 10,000-element
 * array. Both operations are O(N) — indexOf scans the entire array, splice
 * shifts all subsequent memory addresses. Under 5,000 RPS, this O(N) work
 * on EVERY HIT blocks the single-threaded Node.js event loop, delaying
 * Jetstream ingestion and failing health checks.
 *
 * The fix: use the `lru-cache` npm package (by Isaac Schlueter, npm core
 * maintainer). It uses a doubly-linked list + Map for O(1) get/set/evict.
 * Battle-tested at billions of operations across the npm ecosystem.
 */

interface CacheEntry<T> {
  data: T
  expiresAt: number         // When data becomes stale (serve but refresh)
}

// O(1) LRU cache — no array scanning, no event loop blocking
const cache = new LRUCache<string, CacheEntry<unknown>>({
  max: 10_000,               // Maximum entries
  // No TTL here — we manage staleness ourselves for SWR semantics
})

// In-flight promise deduplication map
const inFlight = new Map<string, Promise<unknown>>()

export async function withSWR<T>(
  key: string,
  ttlMs: number,
  fetchData: () => Promise<T>,
): Promise<T> {
  const now = Date.now()
  const cached = cache.get(key) as CacheEntry<T> | undefined

  // 1. FRESH HIT: Data is within TTL. Serve immediately.
  if (cached && cached.expiresAt > now) {
    metrics.incr('api.cache.hit')
    return cached.data
  }

  // 2. PROMISE COALESCING: Another request is already fetching this key.
  //    Await the existing promise — don't hit the database again.
  if (inFlight.has(key)) {
    metrics.incr('api.cache.coalesced')
    return inFlight.get(key) as Promise<T>
  }

  // 3. STALE-WHILE-REVALIDATE: Data is stale but exists.
  //    Serve stale data immediately. Trigger background refresh.
  if (cached) {
    metrics.incr('api.cache.stale')

    // Background refresh — don't await, don't block the response
    const bgFetch = fetchData()
      .then((data) => {
        cache.set(key, {
          data,
          expiresAt: Date.now() + ttlMs,
        })
        inFlight.delete(key)
      })
      .catch((err) => {
        inFlight.delete(key)
        logger.error({ err, key }, 'SWR background refresh failed')
        metrics.incr('api.cache.bg_refresh_failed')
      })

    inFlight.set(key, bgFetch)

    return cached.data     // Instant response with stale data
  }

  // 4. TOTAL MISS: No data at all. Must block and fetch.
  metrics.incr('api.cache.miss')

  const fetchPromise = fetchData()
    .then((data) => {
      cache.set(key, {
        data,
        expiresAt: Date.now() + ttlMs,
      })
      inFlight.delete(key)
      return data
    })
    .catch((err) => {
      inFlight.delete(key)
      throw err
    })

  inFlight.set(key, fetchPromise)
  return fetchPromise
}

/**
 * Cache key generation for /resolve endpoint.
 * Includes all parameters that affect the output.
 */
export function resolveKey(
  subjectJson: string,
  requesterDid?: string,
  domain?: string,
  context?: string,
): string {
  return `resolve:${subjectJson}:${requesterDid ?? ''}:${domain ?? ''}:${context ?? ''}`
}

/**
 * Cache TTLs by endpoint.
 * Short TTLs — trust data should never be more than a few seconds stale.
 */
export const CACHE_TTLS = {
  RESOLVE: 5_000,           // 5 seconds — most critical, most queried
  GET_PROFILE: 10_000,      // 10 seconds — profile aggregations change slowly
  SEARCH: 3_000,            // 3 seconds — search results should be fresh
} as const
```

---

## Deep Dive: XRPC API Endpoints

### Resolve (The Money Endpoint)

```typescript
// src/app/xrpc/com.dina.trust.resolve/route.ts

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/db/connection'
import { subjectScores, didProfiles, flags as flagsTable } from '@/db/schema'
import { computeGraphContext } from '@/db/queries/graph'
import { resolveSubject } from '@/db/queries/subjects'
import { computeRecommendation } from '@/scorer/algorithms/recommendation'
import { withSWR, resolveKey, CACHE_TTLS } from '@/api/middleware/swr-cache'
import { eq } from 'drizzle-orm'

const ResolveParams = z.object({
  subject: z.string(),
  requesterDid: z.string().optional(),
  domain: z.string().optional(),
  context: z.enum([
    'before-transaction', 'before-interaction',
    'content-verification', 'product-evaluation', 'general-lookup',
  ]).optional(),
})

export async function GET(req: NextRequest) {
  const params = ResolveParams.safeParse(
    Object.fromEntries(req.nextUrl.searchParams)
  )

  if (!params.success) {
    return NextResponse.json(
      { error: 'InvalidRequest', message: params.error.message },
      { status: 400 }
    )
  }

  const { subject: subjectJson, requesterDid, domain, context } = params.data

  // SWR cache with promise coalescing (Fix 6).
  // If 100 agents call /resolve for the same subject simultaneously,
  // only ONE database query executes. The other 99 await the same Promise.
  const cacheKey = resolveKey(subjectJson, requesterDid, domain, context)

  const result = await withSWR(cacheKey, CACHE_TTLS.RESOLVE, async () => {
    return computeResolveResponse(subjectJson, requesterDid, domain, context)
  })

  return NextResponse.json(result)
}

/** Core resolve logic, separated for caching. */
async function computeResolveResponse(
  subjectJson: string,
  requesterDid?: string,
  domain?: string,
  context?: string,
) {
  const subjectRef = JSON.parse(subjectJson)

  // 1. Resolve to canonical subject
  const subjectId = await resolveSubject(db, subjectRef)

  // 2. Precomputed subject score
  const scores = subjectId
    ? await db.select().from(subjectScores)
        .where(eq(subjectScores.subjectId, subjectId))
        .limit(1).then(r => r[0] ?? null)
    : null

  // 3. DID profile (if subject is a DID)
  let didProfile = null
  if (subjectRef.type === 'did' && subjectRef.did) {
    didProfile = await db.select().from(didProfiles)
      .where(eq(didProfiles.did, subjectRef.did))
      .limit(1).then(r => r[0] ?? null)
  }

  // 4. Active flags
  const flags = subjectId
    ? await db.select().from(flagsTable)
        .where(eq(flagsTable.subjectId, subjectId))
        .limit(10)
    : []

  // 5. Graph context (runtime 2-hop, with super-node protection)
  //    Graph fields may be null if query timed out — resolve proceeds anyway
  let graphContext = null
  if (requesterDid && subjectRef.type === 'did' && subjectRef.did) {
    graphContext = await computeGraphContext(db, requesterDid, subjectRef.did, subjectId)
  }

  // 6. Authenticity consensus (content subjects)
  let authenticity = null
  if (scores?.authenticityConsensus) {
    authenticity = {
      predominantAssessment: scores.authenticityConsensus,
      confidence: scores.authenticityConfidence,
    }
  }

  // 7. Recommendation
  const rec = computeRecommendation({ scores, didProfile, flags, graphContext, authenticity, context, domain })

  return {
    subjectType: subjectRef.type,
    trustLevel: rec.trustLevel,
    confidence: rec.confidence,
    attestationSummary: scores ? {
      total: scores.totalAttestations,
      positive: scores.positive,
      neutral: scores.neutral,
      negative: scores.negative,
      averageDimensions: scores.dimensionSummaryJson,
    } : null,
    flags: flags.map(f => ({ flagType: f.flagType, severity: f.severity })),
    authenticity,
    graphContext,
    recommendation: rec.action,
    reasoning: rec.reasoning,
  }
}
```

### Search

```typescript
// src/app/xrpc/com.dina.trust.search/route.ts

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/db/connection'
import { attestations, subjects } from '@/db/schema'
import { sql, and, eq, gte, lte, inArray, desc, asc } from 'drizzle-orm'

const SearchParams = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  domain: z.string().optional(),
  subjectType: z.enum(['did', 'content', 'product', 'dataset', 'organization', 'claim']).optional(),
  sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
  tags: z.string().optional(),           // Comma-separated
  authorDid: z.string().optional(),
  minConfidence: z.enum(['speculative', 'moderate', 'high', 'certain']).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  sort: z.enum(['recent', 'relevant', 'most-attested']).default('relevant'),
  limit: z.coerce.number().min(1).max(100).default(25),
  cursor: z.string().optional(),
})

export async function GET(req: NextRequest) {
  const params = SearchParams.safeParse(
    Object.fromEntries(req.nextUrl.searchParams)
  )
  if (!params.success) {
    return NextResponse.json({ error: 'InvalidRequest' }, { status: 400 })
  }

  const { q, category, domain, sentiment, tags, authorDid, since, until, sort, limit, cursor } = params.data

  // Build WHERE conditions
  const conditions = [eq(attestations.isRevoked, false)]

  if (category)  conditions.push(eq(attestations.category, category))
  if (domain)    conditions.push(eq(attestations.domain, domain))
  if (sentiment) conditions.push(eq(attestations.sentiment, sentiment))
  if (authorDid) conditions.push(eq(attestations.authorDid, authorDid))

  if (tags) {
    const tagList = tags.split(',').map(t => t.trim())
    conditions.push(sql`${attestations.tags} @> ${tagList}`)
  }

  if (since) conditions.push(gte(attestations.recordCreatedAt, new Date(since)))
  if (until) conditions.push(lte(attestations.recordCreatedAt, new Date(until)))

  if (cursor) {
    conditions.push(lte(attestations.recordCreatedAt, new Date(cursor)))
  }

  // Full-text search
  let orderClause
  if (q && sort === 'relevant') {
    const tsQuery = sql`plainto_tsquery('english', ${q})`
    conditions.push(sql`search_vector @@ ${tsQuery}`)
    orderClause = sql`ts_rank(search_vector, ${tsQuery}) DESC`
  } else {
    orderClause = desc(attestations.recordCreatedAt)
  }

  const results = await db.select()
    .from(attestations)
    .where(and(...conditions))
    .orderBy(orderClause)
    .limit(limit + 1)                    // Fetch one extra for cursor

  const hasMore = results.length > limit
  const page = hasMore ? results.slice(0, limit) : results
  const nextCursor = hasMore
    ? page[page.length - 1].recordCreatedAt.toISOString()
    : undefined

  return NextResponse.json({
    results: page,
    cursor: nextCursor,
    totalEstimate: null,                 // Expensive; omit unless needed
  })
}
```

---

## Docker Setup

Five containers: Postgres, Jetstream (Go binary), Ingester, Scorer, Web.

The Jetstream container is the bridge between the AT Protocol relay network and the TypeScript AppView. It connects to the relay, decodes CBOR/MST in Go, and exposes a filtered JSON WebSocket stream on the Docker network. The Ingester connects to it locally — no external WebSocket dependency at runtime.

```yaml
# docker-compose.yml

services:
  # ── Database ──
  postgres:
    image: postgres:17
    environment:
      POSTGRES_DB: dina_trust
      POSTGRES_USER: dina
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U dina -d dina_trust"]
      interval: 5s
      timeout: 3s
      retries: 5

  # ── Jetstream (Go binary) ──
  # Bridges the AT Proto relay firehose to lightweight JSON WebSocket.
  # Handles CBOR decoding, MST traversal, signature verification in Go.
  # Filters for only com.dina.trust.* collections.
  #
  # v1: Connects to Bluesky's global relay (bgs.bsky.network).
  #     Switch RELAY_URL to relay.dina.foundation for sovereign operation.
  #
  # Source: https://github.com/bluesky-social/jetstream
  jetstream:
    image: ghcr.io/bluesky-social/jetstream:latest
    environment:
      # Relay to consume from.
      # v1: Bluesky's global relay (carries all PDS records including custom lexicons)
      # v2: relay.dina.foundation (sovereign Dina relay)
      JETSTREAM_RELAY_URL: ${RELAY_URL:-wss://bgs.bsky.network}

      # Only emit events for trust records — filters out
      # millions of Bluesky posts, likes, follows, etc.
      JETSTREAM_WANTED_COLLECTIONS: >-
        com.dina.trust.attestation,
        com.dina.trust.vouch,
        com.dina.trust.endorsement,
        com.dina.trust.flag,
        com.dina.trust.reply,
        com.dina.trust.reaction,
        com.dina.trust.reportRecord,
        com.dina.trust.revocation,
        com.dina.trust.delegation,
        com.dina.trust.collection,
        com.dina.trust.media,
        com.dina.trust.subject,
        com.dina.trust.amendment,
        com.dina.trust.verification,
        com.dina.trust.reviewRequest,
        com.dina.trust.comparison,
        com.dina.trust.subjectClaim,
        com.dina.trust.trustPolicy,
        com.dina.trust.notificationPrefs

      # WebSocket listen port (internal to Docker network)
      JETSTREAM_PORT: 6008
    ports:
      - "6008:6008"    # Expose for debugging; remove in production
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:6008/health"]
      interval: 10s
      timeout: 5s
      retries: 3
    restart: unless-stopped

  # ── TypeScript AppView processes (all from same image) ──

  ingester:
    build: .
    command: ["node", "dist/ingester/main.js"]
    environment:
      DATABASE_URL: postgresql://dina:${POSTGRES_PASSWORD}@postgres:5432/dina_trust
      DATABASE_POOL_MAX: 20
      # Connect to LOCAL Jetstream container — not an external URL.
      # All CBOR/MST work happens in the Go binary above.
      JETSTREAM_URL: ws://jetstream:6008
      LOG_LEVEL: info
    depends_on:
      postgres: { condition: service_healthy }
      jetstream: { condition: service_healthy }
    restart: unless-stopped

  scorer:
    build: .
    command: ["node", "dist/scorer/main.js"]
    environment:
      DATABASE_URL: postgresql://dina:${POSTGRES_PASSWORD}@postgres:5432/dina_trust
      LOG_LEVEL: info
    depends_on:
      postgres: { condition: service_healthy }
    restart: unless-stopped

  web:
    build: .
    command: ["node", "dist/web/server.js"]
    environment:
      DATABASE_URL: postgresql://dina:${POSTGRES_PASSWORD}@postgres:5432/dina_trust
      NEXT_PUBLIC_BASE_URL: https://trust.dina.foundation
      PORT: 3000
    ports:
      - "3000:3000"
    depends_on:
      postgres: { condition: service_healthy }
    restart: unless-stopped

volumes:
  pgdata:
```

### Relay Swap (v1 → v2)

To switch from Bluesky's relay to a sovereign Dina relay, change one env var:

```bash
# .env

# v1: Bluesky's global relay (default)
RELAY_URL=wss://bgs.bsky.network

# v2: Sovereign Dina relay (uncomment when ready)
# RELAY_URL=wss://relay.dina.foundation
```

Zero code changes. Zero AppView changes. The Jetstream container reconnects to the new relay on restart.

### Local Development Without Relay

For local dev and testing, you can bypass the entire relay/Jetstream pipeline and inject events directly into the Ingester using the mock Jetstream in `tests/helpers/mock-jetstream.ts`. The test helper emits the same JSON WebSocket format, so the Ingester code doesn't know the difference.

For integration testing with real AT Proto records:

```bash
# Start a local PDS (dina-core) + local relay (indigo) + local Jetstream
# All on the Docker network, no external dependencies
docker compose -f docker-compose.dev.yml up
```

```yaml
# docker-compose.dev.yml (extends docker-compose.yml)
# Adds a local PDS and a local relay for fully offline development.

services:
  # Local Dina Core PDS for testing
  dina-core-dev:
    build: ../dina-core
    environment:
      PDS_HOSTNAME: localhost:3001
      RELAY_URL: http://relay-dev:2470
    ports:
      - "3001:3001"

  # Local relay (Bluesky's open-source indigo BGS)
  relay-dev:
    image: ghcr.io/bluesky-social/indigo:latest
    environment:
      BGS_ADMIN_KEY: dev-only-key
    ports:
      - "2470:2470"
    volumes:
      - relay-dev-data:/data

  # Override Jetstream to point at local relay
  jetstream:
    environment:
      JETSTREAM_RELAY_URL: ws://relay-dev:2470

volumes:
  relay-dev-data:
```

---

## Environment & Configuration

```typescript
// src/config/env.ts

import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MIN: z.coerce.number().default(2),
  DATABASE_POOL_MAX: z.coerce.number().default(20),

  // Jetstream URL — defaults to local container on Docker network.
  // In production, the Jetstream Go binary runs alongside the AppView
  // and connects to the relay. The Ingester connects to it locally.
  JETSTREAM_URL: z.string().default('ws://jetstream:6008'),

  NEXT_PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  PORT: z.coerce.number().default(3000),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  RATE_LIMIT_RPM: z.coerce.number().default(60),
})

export const env = envSchema.parse(process.env)
```

```typescript
// src/config/constants.ts

export const CONSTANTS = {
  // Scoring weights
  SENTIMENT_WEIGHT: 0.40,
  VOUCH_WEIGHT: 0.25,
  REVIEWER_WEIGHT: 0.20,
  NETWORK_WEIGHT: 0.15,

  // Scoring multipliers
  SENTIMENT_HALFLIFE_DAYS: 180,
  EVIDENCE_MULTIPLIER: 1.3,
  VERIFIED_MULTIPLIER: 1.5,
  BILATERAL_MULTIPLIER: 1.4,

  // Graph
  MAX_GRAPH_DEPTH: 2,              // Hard cap for Postgres runtime queries
  MAX_GRAPH_NODES_RESPONSE: 500,

  // Pagination
  DEFAULT_PAGE_SIZE: 25,
  MAX_PAGE_SIZE: 100,

  // Tombstones
  COORDINATION_TOMBSTONE_THRESHOLD: 3,

  // Vouch strength
  VOUCH_LIGHTLY: 1,
  VOUCH_WELL: 3,
  VOUCH_STRONGLY: 10,

  // ISR
  SUBJECT_PAGE_REVALIDATE_S: 60,
  PROFILE_PAGE_REVALIDATE_S: 120,
  SEARCH_PAGE_REVALIDATE_S: 30,

  // Scorer
  SYBIL_MIN_CLUSTER_SIZE: 3,
  COORDINATION_WINDOW_HOURS: 48,
} as const
```

---

## Observability

```
# Prometheus metrics at /metrics

# Ingester
ingester_connected                                     gauge
ingester_events_received_total{collection,operation}   counter
ingester_records_processed_total{collection,operation} counter
ingester_errors_processing_total                       counter
ingester_errors_connection_total                       counter
ingester_errors_parse_total                            counter
ingester_validation_failed_total{collection}            counter
ingester_tombstone_created_total                       counter
ingester_deletion_clean_total                          counter
ingester_deletion_tombstoned_total                     counter
ingester_cursor_age_seconds                            gauge

# Ingester Backpressure (Fix 5)
ingester_queue_size                                    gauge
ingester_queue_active_workers                          gauge
ingester_backpressure_paused_total                     counter
ingester_backpressure_resumed_total                    counter

# Ingester Rate Limiting (Fix 11)
ingester_rate_limit_dropped_total{collection}          counter
ingester_rate_limit_new_quarantine_total               counter

# Scorer
scorer_job_duration_ms{job}                            histogram
scorer_job_errors_total{job}                           counter
scorer_profiles_updated_total                          counter
scorer_anomalies_detected_total{type}                  counter

# API
api_requests_total{endpoint,status}                    counter
api_request_duration_ms{endpoint}                      histogram

# API Cache (Fix 6)
api_cache_hit_total{endpoint}                          counter
api_cache_stale_total{endpoint}                        counter
api_cache_miss_total{endpoint}                         counter
api_cache_coalesced_total{endpoint}                    counter
api_cache_bg_refresh_failed_total{endpoint}            counter
api_cache_entries                                      gauge

# Graph Queries (Fix 3 + Fix 4)
api_graph_timeout_total{field}                         counter
api_graph_duration_ms{field}                           histogram

# Database
db_pool_active                                         gauge
db_pool_idle                                           gauge
db_query_duration_ms{query}                            histogram
```

---

## Production Hardening Summary

Thirteen issues — nine runtime fault lines, one data model flaw, and three security/correctness bugs — were identified through adversarial review and fixed before deployment:

### Fix 1: Jetstream Idempotency (Crash-Replay Survival)

**Problem:** Jetstream delivers events at-least-once. If the Ingester crashes, it replays from the last saved cursor — potentially re-delivering ~100 events. A plain `INSERT` on the `uri` primary key throws `UniqueConstraintViolation`, crashing the process again. Cursor reloads, same event replays, same crash — infinite death loop.

**Fix:** Every `handleCreate` across all 19 handlers uses `onConflictDoUpdate` (for records where replay should refresh the data) or `onConflictDoNothing` (for records where replay is a no-op, like reactions). No `INSERT` in the entire Ingester codebase is plain — all are upserts.

**Additional:** Cursor save changed from `Math.random() < 0.01` (probabilistic) to a deterministic counter that saves every 100 events. Predictable replay window.

### Fix 2: Atomic Subject Resolution (Concurrent Creation Race)

**Problem:** When a viral piece of content generates 50 attestations in the same second, all arriving on the Jetstream simultaneously, each handler calls `resolveOrCreateSubject`. A naive SELECT-then-INSERT has a TOCTOU race: multiple handlers see "subject doesn't exist" and all try to insert, causing either duplicates or constraint errors.

**Fix:** `resolveOrCreateSubject` uses a single atomic statement: `INSERT ... ON CONFLICT (id) DO UPDATE SET ... RETURNING id, canonical_subject_id`. The `id` is a deterministic SHA-256 hash (see Fix 10), so concurrent handlers with the same input produce the same ID, hitting `ON CONFLICT` correctly. One round-trip, one statement, no race. The database handles concurrency, not the application. The `ON CONFLICT` merge also progressively enriches identifiers — if one attestation references a Google Maps URL and another references a Zomato URL, both get merged into the canonical subject record.

### Fix 3: Super-Node Fan-Out Protection (Graph Query Latency)

**Problem:** The 2-hop graph queries (`mutualConnections`, `trustedAttestors`) join through intermediate DIDs. If the requester trusts a "super-node" (global moderator, automated labeler with 500K outbound edges), the join fan-out explodes. A `COUNT(DISTINCT)` over 500K intermediate results blocks the API thread for seconds.

**Fix:** Three-layer protection:

1. **Fan-out cap:** Every graph query limits intermediate result sets to `MAX_EDGES_PER_HOP = 500` rows, ordered by weight descending (strongest edges first). This makes mutual connection counts approximate for super-nodes, but these are soft signals — approximation is acceptable.

2. **Statement timeout:** The `withGraphTimeout` wrapper runs within a transaction with `SET LOCAL statement_timeout = 100` (100ms). If Postgres can't finish in time, the query is cancelled (error code 57014) and the field returns `null`. The rest of the `resolve` response proceeds normally.

3. **Graceful degradation:** `GraphContext.mutualConnections` is `number | null`. The `resolve` endpoint, the `computeRecommendation` algorithm, and the web UI all handle null graph fields — they display "unavailable" or weight the recommendation without graph context rather than erroring.

### Fix 4: Transaction-Scoped Timeouts (Connection Pool Poisoning)

**Problem:** The original `withGraphTimeout` (pre-fix) used `SET LOCAL statement_timeout` followed by `RESET statement_timeout` as separate `db.execute()` calls. In a pooled environment, sequential executes are not guaranteed to use the same connection. If the query times out and throws before `RESET` runs, the connection returns to the pool with a 100ms kill switch still active. Any future query on that connection — including critical Scorer writes — dies if it exceeds 100ms. This is "connection pool poisoning" — silent, delayed, catastrophic.

**Fix:** `withGraphTimeout` wraps the entire operation in `db.transaction()`. PostgreSQL guarantees `SET LOCAL` applies only within the transaction and is automatically discarded on commit or rollback. The transaction also guarantees a single connection is held throughout. Zero chance of settings leaking to the pool. No manual `RESET` needed — the database engine handles cleanup.

### Fix 5: WebSocket Backpressure (Event Loop OOM)

**Problem:** The `ws.on('message', async ...)` handler creates a new Promise for every Jetstream event. Node.js `ws` does not await the handler before firing the next event. During a spike (5,000 events/second from a viral subject or network backfill), the event loop queues thousands of unresolved Promises, each holding a parsed JSON event in memory. Memory balloons, GC thrashes, container gets OOM-killed. On restart, cursor replays into the same spike — infinite OOM death spiral.

**Fix:** `BoundedIngestionQueue` implements a bounded producer-consumer pattern:

1. **Bounded buffer:** Events queue in a fixed-size array (`MAX_QUEUE_SIZE = 1000`). When full, `ws.pause()` stops reading from the TCP socket — backpressure propagates all the way to the Jetstream Go binary.

2. **Concurrency limit:** Active Postgres writes capped at `MAX_CONCURRENCY` (matched to `DATABASE_POOL_MAX`). No more in-flight promises than available connections.

3. **Hysteresis resume:** WebSocket resumes when queue drains to 50%, preventing pause/resume oscillation under sustained load.

Memory usage is bounded regardless of inbound event rate. Postgres utilization is maximized. Upstream buffers the overflow.

### Fix 6: API Cache Stampede Prevention (Promise Coalescing + SWR)

**Problem:** The `/resolve` XRPC endpoint hits Postgres on every request — subject score lookup, DID profile lookup, flag query, and potentially a 2-hop graph traversal. When a subject goes viral and 100 Dina agents poll `/resolve` simultaneously, that's 100 identical query sets hitting the database. Even with super-node protection (Fix 3), 100× concurrent 2-hop joins will saturate the connection pool.

A naive TTL cache helps for repeated reads but creates periodic "stampedes" — when the TTL expires, all concurrent requests miss the cache and slam the database at once.

**Fix:** `withSWR` cache implements three mechanisms:

1. **Promise coalescing:** If a fetch is already in-flight for a cache key, subsequent requests await the existing Promise instead of starting a new one. 100 concurrent requests for the same subject = 1 database query.

2. **Stale-While-Revalidate:** When a cache entry expires, the first request triggers a background refresh. Meanwhile, stale data is served instantly. Zero-latency reads during revalidation.

3. **LRU eviction:** Cache is bounded to `MAX_CACHE_SIZE = 10,000` entries (~50MB). Oldest entries evicted when full.

Result: For any given subject, Postgres sees at most one query every 5 seconds regardless of request volume. Under 10,000 RPS to the same subject, database load is constant.

### Fix 7: Low Watermark Cursor (Concurrent Worker Data Loss)

**Problem:** With `MAX_CONCURRENCY = 20` workers processing events concurrently, events complete out of order. If the cursor is saved as the `time_us` of the last completed event, faster events advance the cursor past slower in-flight events. On crash + restart, Jetstream resumes from the saved cursor, permanently skipping any events that were still in-flight. This is silent data loss — no error, no retry, the record simply never appears in the database.

**Example:** Worker A starts event `time_us=1000` (complex, 50ms). Worker B starts event `time_us=1005` (simple, 5ms). Worker B finishes, cursor saved as 1005. Process crashes. Restart from 1005. Event 1000 is gone forever.

**Fix:** `BoundedIngestionQueue` tracks an `inFlightTimestamps` Set — every event's `time_us` is added on dequeue and removed on completion. The `getSafeCursor()` method returns `min(inFlightTimestamps) - 1`, which is the LOW WATERMARK: the highest timestamp where all earlier events are guaranteed complete. On restart, Jetstream replays from just before the oldest in-flight event. Idempotent upserts (Fix 1) ensure replayed events are harmless. The consumer saves `queue.getSafeCursor()` both on periodic flush and graceful shutdown.

### Fix 8: O(1) LRU Cache (Event Loop Blocking)

**Problem:** The original SWR cache used a custom array-based LRU where every cache hit called `Array.indexOf()` + `Array.splice()` on a 10,000-element array. `indexOf` is O(N) scan. `splice` is O(N) memory shift. Under 5,000 RPS during a spike, this O(N) work on every hit blocks the single-threaded Node.js event loop, starving Jetstream ingestion and failing health checks.

**Fix:** Replaced with the `lru-cache` npm package (by Isaac Schlueter, npm core maintainer). Uses a doubly-linked list + Map for O(1) get/set/evict. Battle-tested at billions of operations across the npm ecosystem. The custom `touchKey`/`accessOrder`/`indexOf`/`splice` code is deleted entirely. Zero event loop blocking regardless of cache size or request rate.

### Fix 9: Incremental Dirty-Flag Scoring (MVCC Thrashing)

**Problem:** The Scorer's 5-minute cron jobs originally recomputed ALL rows in `did_profiles` and `subject_scores`. PostgreSQL MVCC means every UPDATE creates a new tuple and marks the old one as dead. With 1M profiles, that's 1M dead tuples every 5 minutes — 288M dead tuples per day. Autovacuum can't keep up. Table bloat grows unbounded, disk usage explodes, index performance degrades. The database becomes unusable within days.

**Fix:** Incremental dirty-flag pattern:

1. **Schema change:** `needs_recalc BOOLEAN DEFAULT true` added to `did_profiles` and `subject_scores`, with partial indexes (`WHERE needs_recalc = true`) for instant dirty-row lookup.

2. **Ingester marks dirty:** `markDirty()` called from every handler after writing a record. Sets `needs_recalc = true` on the affected subject and all affected DIDs (author, subject-if-DID, co-signer, mentioned DIDs). Uses upsert to create the profile/score row if it doesn't exist yet.

3. **Scorer processes only dirty rows:** `SELECT ... WHERE needs_recalc = true LIMIT 5000`. Recomputes scores for only those entities, flips flag to `false`. At steady state with 500 attestations per 5-minute window, the Scorer touches ~500-2000 rows instead of 1M+.

Dead tuple generation drops from 288M/day to ~500K/day. Autovacuum has no trouble. Table bloat stays flat. Indexes stay compact.

### Fix 10: 3-Tier Subject Identity (Slug Collision Prevention)

**Problem:** The original design generated a slug from `name + type` (e.g., `business--darshini-tiffin-center`) and used `ON CONFLICT (slug)` for deduplication. This causes silent data corruption: two different restaurants named "Darshini Tiffin Center" in different cities produce identical slugs and get their reviews merged. Conversely, "Darshini Tiffin" and "Darshini Tiffin Center" produce different slugs for the same place, splitting reviews across two subjects. Corruption is nearly impossible to untangle once scores are aggregated.

**Design principle:** Optimize for false negatives (fragmentation) over false positives (corruption). Two subjects that should be one can be merged later. One subject that's actually two different entities is catastrophic.

**Fix:** 3-tier identity strategy with deterministic SHA-256 hashing:

1. **Tier 1 (global):** If the attestation provides a DID, URI, or external identifier (Google Maps Place ID, ASIN, ISBN), the hash is computed from that identifier alone. Same Place ID from any author → same subject. This is the target default path — Dina agents should resolve identifiers before writing attestations.

2. **Tier 2 (author-scoped isolation):** If the attestation provides only a name, the hash includes `authorDid`. Alice's "Darshini Tiffin Center" and Bob's "Darshini Tiffin Center" get DIFFERENT subject IDs. No global collision possible. Safe but fragmented.

3. **Tier 3 (community merge):** Trusted labelers assert "Subject A = Subject B" via amendments. The Scorer sets `canonicalSubjectId` on the source subject. The resolver follows the chain transparently, with cycle detection capped at 5 hops.

The atomic upsert (Fix 2) is preserved — `ON CONFLICT (id)` on the deterministic hash instead of `ON CONFLICT (slug)`. Concurrency safety is maintained.

### Fix 11: Ingester-Side Rate Limiting (Write Abuse DoS)

**Problem:** A Sybil attacker can flood the Jetstream with thousands of attestations from different DIDs. The PDS enforces per-repo limits (~5K creates/hour) but not per-DID-across-the-network. Sybil detection runs every 6 hours — the attacker can saturate the Scorer's dirty-flag queue and distort scores for hours before detection.

**Fix:** In-memory LRU-based sliding window rate limiter (`src/ingester/rate-limiter.ts`), checked BEFORE any database I/O in `processEvent()`. If a DID exceeds 50 records per hour, subsequent records are dropped at the memory layer. The DID is flagged as `quarantined` — the Sybil detection job can call `getQuarantinedDids()` to accelerate investigation. Cost: zero Postgres I/O per dropped record. An attacker flooding millions of events is stopped in nanoseconds.

### Fix 12: Trust Score — Untrusted-by-Default + Convergence (Circular Dependency)

**Problem:** `computeSentiment()` weights attestations by `authorTrustScore`, which is computed by `computeTrustScore()`, which calls `computeSentiment()` on the author's attestations — a circular dependency. The original code defaulted unscored authors to `0.5`, giving new accounts (including Sybils) the same weight as moderately trusted DIDs. An attacker could spin up 1,000 Sybils with default 0.5 weight and shift global scores. Additionally, the incremental dirty-flag pattern processes each DID independently without guaranteeing convergence.

**Fix:** Three changes:

1. **Zero-trust default:** Unscored authors get weight `0.0` (not `0.5`). Their attestations contribute nothing until the Scorer computes their trust score.

2. **Vouch-gating:** Even if a DID has been scored, their attestations carry zero weight unless they have at least one inbound vouch from a DID with score > 0.5. Sybils can't bootstrap each other — at least one real human in the chain must vouch.

3. **Damping factor (0.85):** `computeTrustScore()` applies `DAMPING_FACTOR * raw + (1 - DAMPING) * BASE_SCORE`. This mathematically guarantees convergence of the iterative scoring loop (identical to PageRank/EigenTrust). The dirty-flag pattern (Fix 9) already implements asynchronous relaxation — Alice's score change marks Bob dirty, Bob's score change marks Carol dirty — the damping factor ensures this chain settles into a stable state rather than oscillating.

### Fix 13: Parameterized Deletion Handler (Multi-Table Tombstones)

**Problem:** `deletionHandler.process()` hardcoded the `attestations` table for both tombstone metadata lookup and record deletion. If a user deleted a `vouch`, `flag`, or any non-attestation record, the handler queried `attestations`, found nothing, skipped tombstone creation, and then tried to delete from `attestations` — leaving the original record intact. Silent data loss: no tombstone created even though the record was disputed, and the record itself was never actually deleted.

**Fix:** The deletion handler now takes a `sourceTable: PgTable` parameter. Each handler passes its own table (e.g., `vouches`, `flags`, `endorsements`). A centralized `COLLECTION_TABLE_MAP` maps collection names to Drizzle table objects for consistent lookup. The handler uses the correct table for both the metadata query and the delete statement.

---

## The Write Path: How Records Enter the System

The AppView is strictly a **read-indexer**. It consumes records from the relay firehose and materializes them into queryable state. It never writes to any PDS.

Writing trust records is the exclusive domain of the **Dina Core** (the Go binary running on each user's personal infrastructure). The data flow for creating a new attestation is:

```
┌────────────────┐     ┌──────────────────┐     ┌──────────────┐     ┌──────────────┐     ┌───────────┐
│  Python Brain  │────▶│  Go Core API     │────▶│  Local PDS   │────▶│  Relay (BGS) │────▶│  AppView  │
│  (Agent logic) │     │  /v1/trust       │     │  (AT Proto)  │     │  Firehose    │     │  Ingester │
│  Decides what  │     │  Policy check +  │     │  Signs, hashes│    │  Broadcasts  │     │  Indexes  │
│  to attest     │     │  record assembly │     │  into MST    │     │  to network  │     │           │
└────────────────┘     └──────────────────┘     └──────────────┘     └──────────────┘     └───────────┘
```

### Step 1: Brain Formats the Intent

The Python Brain decides an attestation is needed (e.g., the user had a good experience with a restaurant) and constructs the intent payload:

```python
# In dina-brain (Python)

intent = {
    "action": "create_attestation",
    "subject": {
        "type": "business",
        "name": "Darshini Tiffin Center",
        "identifier": "google-maps:ChIJ_abc123xyz"  # Agent resolves this
    },
    "category": "service",
    "sentiment": "positive",
    "domain": "food",
    "content": "Excellent dosa, consistent quality over 3 visits"
}

# Send to Go Core via internal API
response = core_client.post("/v1/trust/publish", json=intent)
```

### Step 2: Core Gatekeeps and Assembles

The Go Core verifies the action against the user's sovereign policy (spending limits, content filters, rate limits) and assembles the full AT Protocol record:

```go
// In dina-core (Go) — internal handler for /v1/trust/publish

func (s *TrustService) Publish(ctx context.Context, intent Intent) error {
    // 1. Policy check: does the user's trust policy allow this?
    if err := s.policyEngine.Check(ctx, intent); err != nil {
        return fmt.Errorf("policy rejected: %w", err)
    }

    // 2. Assemble the full AT Protocol record with required fields
    record := map[string]interface{}{
        "$type":     "com.dina.trust.attestation",  // Lexicon type identifier
        "subject":   intent.Subject,
        "category":  intent.Category,
        "sentiment": intent.Sentiment,
        "domain":    intent.Domain,
        "content":   intent.Content,
        "createdAt": time.Now().UTC().Format(time.RFC3339),
    }

    // 3. Write to the local PDS via standard AT Protocol XRPC
    // The PDS hashes the record into the user's Merkle Search Tree,
    // signs it with the user's key, and broadcasts to the relay.
    _, err := s.pdsClient.CreateRecord(ctx, &atproto.RepoCreateRecord_Input{
        Repo:       s.userDID,                              // User's DID
        Collection: "com.dina.trust.attestation",      // Lexicon NSID
        Record:     &lexutil.LexiconTypeDecoder{Val: record},
    })
    if err != nil {
        return fmt.Errorf("PDS write failed: %w", err)
    }

    return nil
}
```

### Step 3: PDS Signs, Relay Broadcasts, AppView Indexes

Once `createRecord` succeeds:

1. **PDS** hashes the record into the user's personal Merkle Search Tree, creating a new commit signed with the user's Ed25519 key
2. **Relay** (which was registered via `requestCrawl` on first boot) picks up the new commit during its next crawl cycle
3. **Jetstream** receives the commit from the relay, decodes CBOR/MST in Go, and emits a JSON event on the WebSocket
4. **AppView Ingester** receives the event, validates against the lexicon schema, dispatches to the attestation handler, and writes to Postgres

The AppView never needs to know about the Brain, the Core, or the PDS. It only sees the final, signed, validated record arriving on the Jetstream. This is the fundamental AT Protocol separation: **PDS is the write layer, AppView is the read layer.**

### PDS Compatibility with Custom Lexicons

AT Protocol PDS implementations accept ANY collection NSID in `createRecord` — they do not validate against a known set of lexicons. The PDS stores the record as an opaque CBOR blob in the user's repository. Validation is the AppView's responsibility, not the PDS's.

This means Dina's custom `com.dina.trust.*` collections work on any AT Protocol PDS (including Bluesky's hosted PDS) without any PDS modifications. The PDS doesn't need to "know about" Dina's lexicons.

---

## Bootstrap & Backfill Strategy

### The Problem

Jetstream is a live firehose with a limited rolling buffer — typically 24-72 hours of history depending on the Jetstream instance's configuration. If a new AppView instance boots from scratch, or if an existing instance has been offline for more than 72 hours, the Ingester cannot replay from the beginning of time via Jetstream alone. Historical records are missing.

### The Solution: `scripts/backfill.ts`

The backfill script connects directly to PDS repositories (bypassing the relay/Jetstream entirely) and replays historical records through the same ingestion pipeline.

```typescript
// scripts/backfill.ts

import { BoundedIngestionQueue } from '@/ingester/bounded-queue'
import { createHandlerContext } from '@/ingester/handlers'
import { validateRecord } from '@/ingester/record-validator'
import { routeHandler } from '@/ingester/handler-router'
import { isRateLimited } from '@/ingester/rate-limiter'
import { createDb } from '@/db/connection'
import { logger } from '@/shared/utils/logger'

const TRUST_COLLECTIONS = [
  'com.dina.trust.attestation',
  'com.dina.trust.vouch',
  'com.dina.trust.endorsement',
  'com.dina.trust.flag',
  'com.dina.trust.reply',
  'com.dina.trust.reaction',
  'com.dina.trust.reportRecord',
  'com.dina.trust.revocation',
  'com.dina.trust.delegation',
  'com.dina.trust.collection',
  'com.dina.trust.media',
  'com.dina.trust.subject',
  'com.dina.trust.amendment',
  'com.dina.trust.verification',
  'com.dina.trust.reviewRequest',
  'com.dina.trust.comparison',
  'com.dina.trust.subjectClaim',
  'com.dina.trust.trustPolicy',
  'com.dina.trust.notificationPrefs',
]

/**
 * Backfill historical records from PDS repositories.
 *
 * This script is used to:
 * 1. Bootstrap a brand-new AppView from scratch
 * 2. Recover from an outage longer than Jetstream's buffer (~72 hours)
 * 3. Add records from a newly discovered PDS that was missing from the relay
 *
 * It connects directly to each PDS and reads records via the standard
 * AT Protocol XRPC endpoints. Records are pushed through the same
 * validation → handler → DB pipeline as live Jetstream events.
 *
 * Because all handlers use idempotent upserts (Fix 1), re-ingesting
 * a record that already exists is a harmless no-op.
 */

interface BackfillConfig {
  // List of PDS URLs to backfill from.
  // Can be populated from:
  //   - A known list of Dina federation nodes
  //   - The did:plc directory (query for DIDs with Dina collections)
  //   - The relay's admin API (list known PDS instances)
  pdsUrls: string[]
  
  // Optionally filter to specific DIDs
  filterDids?: string[]
  
  // Rate limit: max concurrent PDS connections
  maxConcurrentPds: number  // default: 5
}

async function backfill(config: BackfillConfig): Promise<void> {
  const db = createDb()
  const ctx = createHandlerContext(db)

  logger.info({ pdsCount: config.pdsUrls.length }, 'Starting backfill')

  // Process PDS instances with bounded concurrency
  const semaphore = new Semaphore(config.maxConcurrentPds)

  await Promise.all(config.pdsUrls.map(async (pdsUrl) => {
    await semaphore.acquire()
    try {
      await backfillFromPds(pdsUrl, ctx, config.filterDids)
    } catch (err) {
      logger.error({ pdsUrl, err }, 'Failed to backfill PDS')
    } finally {
      semaphore.release()
    }
  }))

  logger.info('Backfill complete')
}

async function backfillFromPds(
  pdsUrl: string,
  ctx: ReturnType<typeof createHandlerContext>,
  filterDids?: string[],
): Promise<void> {

  // 1. List all repos on this PDS (or filter to specific DIDs)
  const repos = await listRepos(pdsUrl, filterDids)

  for (const repo of repos) {
    const did = repo.did

    // 2. For each trust collection, list all records
    for (const collection of TRUST_COLLECTIONS) {
      let cursor: string | undefined

      do {
        // Standard AT Protocol XRPC endpoint — works on any PDS
        const response = await fetch(
          `${pdsUrl}/xrpc/com.atproto.repo.listRecords?` +
          `repo=${did}&collection=${collection}&limit=100` +
          (cursor ? `&cursor=${cursor}` : ''),
        )

        if (!response.ok) {
          logger.warn({ pdsUrl, did, collection, status: response.status }, 'listRecords failed')
          break
        }

        const data = await response.json()
        const records = data.records ?? []

        // 3. Process each record through the standard pipeline
        for (const item of records) {
          const uri = item.uri as string
          const cid = item.cid as string
          const record = item.value as Record<string, unknown>

          // Rate limit check (Fix 11)
          if (isRateLimited(did)) {
            logger.warn({ did }, 'Backfill: DID rate limited, skipping remaining records')
            break
          }

          // Validate against lexicon schema
          const validation = validateRecord(collection, record)
          if (!validation.success) continue

          // Dispatch to the same handler as live ingestion
          const handler = routeHandler(collection)
          if (!handler) continue

          const rkey = uri.split('/').pop()!
          await handler.handleCreate(ctx, {
            uri,
            did,
            collection,
            rkey,
            cid,
            record: validation.data,
          })
        }

        cursor = data.cursor
      } while (cursor)
    }

    logger.info({ did, pdsUrl }, 'Backfilled DID')
  }
}

async function listRepos(
  pdsUrl: string,
  filterDids?: string[],
): Promise<{ did: string }[]> {
  // If specific DIDs are requested, return them directly
  if (filterDids?.length) {
    return filterDids.map(did => ({ did }))
  }

  // Otherwise, list all repos on the PDS
  const repos: { did: string }[] = []
  let cursor: string | undefined

  do {
    const response = await fetch(
      `${pdsUrl}/xrpc/com.atproto.sync.listRepos?limit=1000` +
      (cursor ? `&cursor=${cursor}` : ''),
    )
    if (!response.ok) break

    const data = await response.json()
    repos.push(...(data.repos ?? []))
    cursor = data.cursor
  } while (cursor)

  return repos
}
```

### Backfill → Live Transition

The transition from backfill mode to live Jetstream consumption is seamless:

1. **Run backfill first:** `npx tsx scripts/backfill.ts --pds-urls=...` This populates the database with all historical records. Because handlers use idempotent upserts (Fix 1), running backfill against an already-populated database is safe — duplicate records are silently merged.

2. **Start the Ingester normally:** The Ingester connects to Jetstream. If it has no saved cursor, it starts from the live edge (`cursor = 0`). If it has a saved cursor from a previous run, it replays from that point.

3. **Overlap is safe:** There will be a window where both the backfill and the live Ingester process the same records (the backfill's final records overlap with Jetstream's buffer). Idempotent upserts ensure this is harmless — the same record ingested twice produces the same database state.

### When to Run Backfill

- **New deployment:** Always run backfill before starting the Ingester for the first time
- **Outage > 72 hours:** Run backfill for the gap period, then start the Ingester normally
- **New PDS joins federation:** Run backfill for just that PDS URL to catch up on its historical records
- **Periodic audit:** Run backfill weekly as a consistency check — idempotent upserts mean it's always safe

### Discovery: Finding PDS URLs

The backfill script needs a list of PDS URLs to connect to. Three discovery methods:

1. **Known federation list:** A static config file listing all Dina federation PDS URLs. Simplest for v1.
2. **did:plc directory:** Query the `plc.directory` for DIDs that have declared a Dina PDS as their service endpoint. This discovers nodes that joined the federation without being manually registered.
3. **Relay admin API:** If running a sovereign relay (v2), query its admin endpoint for all known PDS instances it has crawled.

For the two-month sprint, option 1 (static list) is sufficient. The federation will have a small number of test nodes.

---

## Testing Strategy

```
tests/
├── unit/                           # No database, pure functions
│   ├── scorer/
│   │   ├── trust-score.test.ts     # Known inputs → expected scores
│   │   ├── reviewer-quality.test.ts
│   │   └── recommendation.test.ts
│   ├── ingester/
│   │   └── record-validator.test.ts
│   └── shared/
│       ├── uri.test.ts
│       └── deterministic-id.test.ts
│
├── integration/                    # Real Postgres (testcontainers)
│   ├── ingester/
│   │   ├── attestation-handler.test.ts
│   │   ├── deletion-handler.test.ts     # Tombstone creation
│   │   ├── deletion-multi-table.test.ts # Fix 13: vouch/flag deletion → correct table queried + deleted
│   │   ├── trust-edge-sync.test.ts
│   │   ├── idempotency.test.ts          # Fix 1: replay same event N times → no error, no duplicates
│   │   ├── concurrent-subjects.test.ts  # Fix 2: 50 concurrent resolveOrCreateSubject → exactly 1 row
│   │   ├── subject-identity.test.ts     # Fix 10: same name different authors → different subjects
│   │   ├── subject-merge-chain.test.ts  # Fix 10: canonical chain resolution + cycle detection
│   │   ├── backpressure.test.ts         # Fix 5: 5000 events burst → queue bounded, no OOM
│   │   ├── low-watermark.test.ts       # Fix 7: concurrent completion → cursor = min(in-flight) - 1
│   │   └── rate-limiter.test.ts        # Fix 11: DID exceeding 50/hr → records dropped, quarantine flagged
│   ├── api/
│   │   ├── resolve.test.ts
│   │   ├── resolve-supernode.test.ts    # Fix 3: resolve with super-node → response in <200ms
│   │   ├── resolve-cache.test.ts        # Fix 6: 100 concurrent resolve calls → 1 DB query
│   │   ├── swr-cache.test.ts            # Fix 6: stale-while-revalidate serves stale during refresh
│   │   ├── search.test.ts
│   │   └── get-profile.test.ts
│   ├── graph/
│   │   ├── one-hop.test.ts
│   │   ├── two-hop.test.ts
│   │   ├── mutual-connections.test.ts
│   │   ├── supernode-timeout.test.ts    # Fix 3: graph query with 10K fan-out → graceful null
│   │   └── pool-poisoning.test.ts       # Fix 4: timeout → verify next connection has no timeout set
│   ├── scorer/
│       ├── refresh-profiles.test.ts
│       ├── refresh-profiles-incremental.test.ts  # Fix 9: only dirty rows updated, clean rows untouched
│       ├── trust-score-convergence.test.ts       # Fix 12: iterative scoring converges within 5 ticks
│       ├── sybil-zero-weight.test.ts             # Fix 12: unvouched DIDs contribute 0 weight
│       └── detect-coordination.test.ts
│
├── e2e/                            # Full stack
│   ├── subject-page.test.ts
│   ├── search-flow.test.ts
│   └── ingest-to-page.test.ts
│
└── helpers/
    ├── db.ts                       # testcontainers Postgres
    ├── factories.ts                # Realistic test records
    └── mock-jetstream.ts           # Controlled event feed
```

---

## Future Split Path (v2)

When agent volume demands it, the XRPC endpoints split from Next.js:

```
Before (v1):
  web container: Next.js (XRPC routes + HTML pages)

After (v2):
  api container: Fastify (XRPC routes only, max perf)
  web container: Next.js (HTML pages only, ISR)

Both read from same Postgres.
Shared code stays in src/db/, src/shared/, src/scorer/algorithms/.
The split is moving files + changing imports, not a rewrite.
```

The directory structure already separates `src/app/xrpc/` from `src/app/did/`, `src/app/subject/`, etc. When splitting, the XRPC route handlers move into a Fastify app that imports the same query functions from `src/db/queries/`.