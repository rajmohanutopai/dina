# The Dina AppView: A Walk Through the Trust Network

## Act I: What This Is — The Missing Layer of the Internet

Every time you buy something online, you're trusting a stranger. The only signal you have is a star rating that can be bought, a review that can be faked, and a platform that profits from both. Dina's AppView is the antidote: a **decentralized trust network** where trust is earned through cryptographic attestations, not purchased through ad spend.

<details>
<summary><strong>Design Decision — Why build reputation on the AT Protocol instead of a custom network?</strong></summary>
<br>

The AT Protocol (used by Bluesky) solves the three hardest problems in decentralized systems: identity (DIDs), data portability (signed records in personal data stores), and discoverability (the Jetstream firehose). Building a custom network would mean reimplementing all of these. By using AT Protocol, every reputation record is a signed, portable, user-owned data object that can be verified by any party without trusting a central server. The user's reputation belongs to them — if they leave Dina's AppView, their attestations travel with them in their PDS (Personal Data Server). The AppView is one possible *view* of this data, not the canonical store. Anyone can build an alternative AppView that reads the same records and computes trust differently.

</details>

The AppView is a TypeScript/Node.js backend consisting of three daemons:

- **Ingester** — Consumes the Jetstream firehose, validates records, and persists them to PostgreSQL.
- **Scorer** — Runs 9 background jobs that compute trust scores, detect anomalies, and decay stale data.
- **Web** — Serves 5 xRPC endpoints for reputation queries.

<details>
<summary><strong>Design Decision — Why TypeScript instead of Go or Python?</strong></summary>
<br>

The AT Protocol ecosystem is JavaScript/TypeScript-native — the reference implementations, SDKs, and tooling are all TypeScript. The AppView's primary job is consuming a WebSocket firehose (Jetstream), validating JSON records (Zod), and querying a relational database (Drizzle ORM) — all tasks where TypeScript's type system and async/await model excel. Go would have been a reasonable choice for the ingester (high-throughput stream processing), but splitting the codebase across languages for one daemon wasn't worth the operational complexity. Python was rejected because the AppView has no ML/NLP requirements — it computes trust scores with arithmetic, not neural networks.

</details>

---

## Act II: Configuration — Zod All the Way Down

Configuration lives in three files that together define the system's DNA.

### Environment Schema (config/env.ts)

Every environment variable is validated through a Zod schema at startup (line 5-26). In production, `DATABASE_URL` and `JETSTREAM_URL` are required — no defaults with weak credentials. In development, defaults are provided for local Docker Compose. The runtime check at lines 33-39 adds a second guard: even if Zod somehow passes, the explicit `throw new Error` catches misconfiguration.

<details>
<summary><strong>Design Decision — Why Zod for environment validation instead of dotenv or manual parsing?</strong></summary>
<br>

`dotenv` loads variables but doesn't validate them. `process.env.DATABASE_POOL_MAX` is always a string — is `"twenty"` valid? Zod's `z.coerce.number()` (line 12-13) parses `"20"` to `20` and rejects `"twenty"` with a clear error at startup. The schema also serves as living documentation: reading `env.ts` tells you every config option, its type, its default, and whether it's required. Manual `parseInt(process.env.FOO || "10")` scattered across the codebase is a maintenance nightmare — Zod centralizes it.

</details>

### Constants (config/constants.ts)

81 lines of numeric truth. Every tunable parameter lives here, not scattered across source files:

- **Scoring weights** (lines 3-6): Sentiment 40%, Vouch 25%, Reviewer Quality 20%, Network 15%.
- **Graph limits** (lines 15-18): Max depth 2, max 500 edges per hop, 100ms query timeout.
- **Trust edge weights** (lines 58-66): Vouch high confidence = 1.0, endorsement observed = 0.4, positive attestation = 0.3.
- **Damping** (lines 68-70): 0.85 damping factor, 0.1 base score — inspired by PageRank.
- **Cache TTLs** (lines 73-76): Resolve 5s, Profile 10s, Search 3s.

### Lexicons (config/lexicons.ts)

19 reputation record collection NSIDs — the vocabulary of the trust network. Each maps to a `com.dina.reputation.*` collection in the AT Protocol namespace. These are the 19 record types that the ingester subscribes to on the Jetstream firehose.

---

## Act III: The Ingester — Drinking from the Firehose

The `JetstreamConsumer` in `ingester/jetstream-consumer.ts` is the ingester's heart. It connects to a Jetstream relay via WebSocket, receives every reputation record created or deleted across the entire network, and persists them to PostgreSQL.

### Connection (lines 45-106)

When `start()` is called, the consumer loads the last cursor from the database (line 39), builds a WebSocket URL with `wantedCollections` for all 19 reputation record types (lines 46-52), and connects. The cursor is a microsecond timestamp — Jetstream replays all events since that timestamp on reconnection.

The consumer creates a `BoundedIngestionQueue` (lines 59-63) and wires it to the WebSocket. Every incoming message is parsed and pushed onto the queue (lines 71-92). If parsing fails, the error is logged and counted — never propagated.

### Backpressure (bounded-queue.ts)

The `BoundedIngestionQueue` is the most critical infrastructure component. When events arrive faster than they can be processed (database slow, spike in network activity), the queue fills up. When it hits `maxSize` (1000), it **pauses the WebSocket** (line 67-68):

```
this.ws.pause()
```

This is TCP-level backpressure. `ws.pause()` stops reading from the socket, which causes the TCP receive buffer to fill, which causes the Jetstream relay to stop sending. When the queue drains below the 50% low watermark (line 172-176), the WebSocket is resumed. This prevents memory exhaustion and dropped events.

<details>
<summary><strong>Design Decision — Why TCP-level backpressure instead of dropping events?</strong></summary>
<br>

Dropping events means lost reputation records — a user's review disappears from the graph. The Jetstream relay supports backpressure natively: when a consumer stops reading, the relay buffers events server-side (up to its own limits). By pausing the WebSocket instead of dropping, we push the buffering responsibility upstream to the relay, which has dedicated resources for this. The relay will eventually disconnect us if we pause too long, but that triggers our reconnection logic with the last safe cursor, so we replay from where we left off. The spool-to-disk fallback (lines 80-86) is a last resort for events that arrive after the queue is full but before the WebSocket pause takes effect — a race condition that can happen in the event loop.

</details>

### Safe Cursor Tracking (bounded-queue.ts:94-113)

The cursor must never advance past events that haven't been fully processed. `getSafeCursor()` returns the **minimum timestamp** across all queued items, in-flight items (currently being written to the database), and failed items. This ensures that on crash and reconnect, Jetstream replays all unprocessed events.

<details>
<summary><strong>Design Decision — Why track failed timestamps separately?</strong></summary>
<br>

If event A (timestamp 100) fails and event B (timestamp 200) succeeds, the cursor should stay at 100, not advance to 200. Without tracking failed timestamps, the cursor would jump to the highest completed timestamp, and event A would be permanently lost. The `failedTimestamps` set (line 35) ensures that the cursor never advances past a failure. On reconnect, Jetstream replays from timestamp 100, giving event A another chance.

</details>

### Event Processing Pipeline (jetstream-consumer.ts:108-174)

`processEvent()` handles three event kinds:

1. **Identity events** (line 109) — DID handle changes. Logged for awareness.
2. **Account events** (line 113) — Account takedowns/deletions. Logged for moderation.
3. **Commit events** (line 117) — The main path. Create, update, or delete of reputation records.

For commit events, the pipeline is:

1. **Collection filter** (line 122) — Only process reputation collections (ignore posts, likes, etc.).
2. **Rate limiting** (line 124) — Per-DID write limits (50 records/hour, line 42 of constants). Prevents spam.
3. **Validation** (line 150) — Zod schema validation. Invalid records are logged and dropped — never persisted.
4. **Handler dispatch** (line 157) — Route to the correct handler based on collection NSID.
5. **Upsert** (line 169) — The handler writes to PostgreSQL. All handlers use `onConflictDoUpdate` for idempotent replays.
6. **Cursor save** (lines 137-143) — Every 100 events, the safe cursor is persisted to the database.

<details>
<summary><strong>Design Decision — Why upsert (ON CONFLICT DO UPDATE) instead of insert-or-skip?</strong></summary>
<br>

AT Protocol records can be updated. When a user edits their attestation (changes a review from "positive" to "negative"), the Jetstream emits an update event with the same URI but new content. `ON CONFLICT DO UPDATE` ensures the database always reflects the latest version. `ON CONFLICT DO NOTHING` would silently ignore the update, leaving stale data in the graph. The URI serves as the natural primary key (line 66 of attestation handler) — same URI means same record, updated content.

</details>

### Record Validation (record-validator.ts)

298 lines of Zod schemas — one per record type. Each schema enforces:

- **Required fields** (e.g., `attestationSchema` requires `subject`, `category`, `sentiment`, `createdAt`).
- **Enum values** (e.g., sentiment must be `positive | neutral | negative`).
- **Length limits** (e.g., text max 2000 chars, tags max 10 items of max 50 chars each).
- **ISO date validation** via `z.string().datetime({ offset: true })` (line 51).

The `SCHEMA_MAP` at lines 234-254 maps each collection NSID to its Zod schema. `validateRecord()` (line 268) looks up the schema, runs `safeParse`, and returns either the parsed data or the Zod errors. Invalid records are never persisted.

---

## Act IV: The Handler Registry — 19 Record Types, One Pattern

The handler registry in `handlers/index.ts` maps each collection NSID to a `RecordHandler` with two methods: `handleCreate` and `handleDelete`. There are 19 handlers — one per record type. They all follow the same pattern, but the two most important are attestations and vouches.

### Attestation Handler (handlers/attestation.ts)

The most complex handler (137 lines). When a user publishes an attestation (a structured review), the handler:

1. **Resolves the subject** (line 22) — Calls `resolveOrCreateSubject` to get a deterministic subject ID. This is the 3-tier resolution system (more on this in Act VI).
2. **Builds search content** (lines 25-31) — Concatenates text, subject name, tags, category, and domain into a single searchable string capped at 10,000 chars.
3. **Upserts the record** (lines 41-93) — Inserts with `onConflictDoUpdate` on the URI. Every field is updated on conflict.
4. **Creates mention edges** (lines 96-105) — If the attestation mentions other DIDs (e.g., "co-authored with @alice"), graph edges are created.
5. **Creates trust edges** (lines 108-118) — Only for positive attestations of DID subjects. A positive review creates a weighted trust edge (0.3) from the reviewer to the reviewed.
6. **Marks dirty flags** (lines 121-127) — The subject, author, mentioned DIDs, and co-signer are all marked for score recalculation.

<details>
<summary><strong>Design Decision — Why only create trust edges for positive attestations?</strong></summary>
<br>

Trust edges represent "I trust this person" — they're the building blocks of the trust graph used for path computation (shortest path between two DIDs). A negative review doesn't mean "I trust this person negatively" — it means "I had a bad experience." Including negative reviews as negative-weight edges would create complex signed-graph problems (negative cycles, path ambiguity) that make trust computation NP-hard. Instead, negative attestations affect the *subject's score* through the sentiment component (40% weight), not the *graph structure*. Positive attestations create edges because they represent genuine trust signals: "I interacted with this person and it was good."

</details>

### Vouch Handler (handlers/vouch.ts)

A vouch is a pure trust signal — "I vouch for this person." The handler:

1. **Upserts the vouch record** (lines 29-53).
2. **Creates a trust edge** (lines 56-64) with weight derived from confidence: `high` = 1.0, `moderate` = 0.6, `low` = 0.3 (lines 15-22).
3. **Marks dirty flags** (lines 67-71).

### Deletion Handler (deletion-handler.ts)

When a user deletes a record, the handler doesn't just `DELETE FROM table`. It first checks for **dispute signals** (lines 86-119):

- How many reports target this URI?
- How many replies with `intent: "dispute"` reference it?
- How many `suspicious` reactions does it have?

If *any* dispute signal exists, a **tombstone** is created (lines 146-186). The tombstone preserves the record's metadata (subject, category, sentiment, domain, duration, evidence status) without preserving the content. This is critical: if a restaurant owner posts a glowing self-review, gets reported for `self-review`, and then deletes the review, the tombstone remembers that a disputed record was deleted. The scorer applies a reputation penalty (×0.4) when tombstones accumulate past the threshold.

<details>
<summary><strong>Design Decision — Why tombstones for disputed deletions instead of just keeping all records?</strong></summary>
<br>

Keeping all records violates the user's right to delete (GDPR, AT Protocol data sovereignty). Deleting everything forgets the signal. Tombstones are the compromise: the *content* is deleted (honoring the deletion), but the *metadata* is preserved (the fact that a disputed review existed and was deleted is itself a reputation signal). A user who repeatedly posts and deletes disputed reviews accumulates tombstones, which the scorer penalizes. A user who deletes an undisputed review leaves no tombstone — their deletion is respected in full. This aligns with real-world norms: withdrawing a court filing after it's been challenged is different from withdrawing one before anyone responds.

</details>

---

## Act V: The Trust Score — Arithmetic of Reputation

The scoring engine in `scorer/algorithms/trust-score.ts` computes a single trust score (0.0-1.0) from four weighted components.

### The Four Components (lines 39-71)

```
overall = 0.85 × (sentiment×0.40 + vouch×0.25 + reviewer×0.20 + network×0.15) + 0.15 × 0.1
```

**Sentiment** (lines 73-101, weight 0.40) — The weighted ratio of positive attestations. Each attestation's contribution is modulated by:
- **Recency decay** (line 82): `e^(-days / 180)` — a 6-month half-life. Recent reviews matter more.
- **Evidence multiplier** (line 83): ×1.3 if the attestation includes evidence (photos, receipts, etc.).
- **Verified multiplier** (line 84): ×1.5 if the attestation has been verified by a third party.
- **Bilateral multiplier** (line 85): ×1.4 if the attestation is co-signed (both parties agree).
- **Author weight** (lines 87-90): The reviewer's own trust score, but **only if they have at least one inbound vouch**. A reviewer with no vouches has zero weight — their attestation doesn't count.

<details>
<summary><strong>Design Decision — Why require an inbound vouch for author weight?</strong></summary>
<br>

Without this gate, a Sybil attacker creates 1000 accounts, each reviews the same product positively, and the product gets a high trust score. With the vouch gate, those 1000 accounts have zero author weight because no one has vouched for them. Only reviewers who are themselves trusted (vouched for by someone in the graph) contribute to sentiment. This makes Sybil attacks expensive: the attacker needs not just many accounts, but many accounts that are vouched for by real people. The cost shifts from "create fake accounts" (cheap) to "earn trust from real humans" (expensive).

</details>

**Vouch** (lines 103-110, weight 0.25) — Logarithmic scaling of vouch count. `log2(count + 1) / log2(11)` normalizes to 0-1 where 10 vouches = 1.0. High-confidence vouches add a bonus (up to 0.2).

**Reviewer Quality** (lines 112-127, weight 0.20) — For DIDs that *author* attestations: how helpful are their reviews? Based on three ratios:
- **Helpful ratio** (line 119): `helpful_reactions / (helpful + unhelpful)`. Community signal.
- **Evidence rate** (line 117): What fraction of their reviews include evidence?
- **Deletion rate** (line 116): Tombstone count / total attestations. Reviewers who repeatedly delete disputed reviews are penalized (×2.0 penalty).

**Network** (lines 129-133, weight 0.15) — Logarithmic scaling of inbound trust edge count plus a delegation bonus. Measures how embedded the DID is in the trust graph.

### Flag Penalties (lines 52-60)

After computing the raw score, flags apply multiplicative penalties:
- **Critical** flag: ×0.3 (70% reduction).
- **Serious** flag: ×0.6 (40% reduction).
- **Warning** flag: ×0.85 (15% reduction).
- **Tombstone threshold** (3+): ×0.4 (60% reduction).

### Damping (line 62)

The final score uses PageRank-style damping: `0.85 × raw + 0.15 × 0.1`. This ensures that even a DID with zero activity gets a base score of 0.015, preventing division-by-zero issues and providing a "minimum floor" for new users.

<details>
<summary><strong>Design Decision — Why PageRank-style damping instead of raw scores?</strong></summary>
<br>

Raw scores are unstable at the extremes. A DID with one positive attestation has a score of 1.0; a DID with one negative attestation has 0.0. Damping pulls extreme values toward the base score, which has two effects: (1) new users with limited data get a non-zero baseline ("benefit of the doubt"), and (2) the scoring system is more robust against manipulation — a single attestation can't push a score to 1.0 or 0.0. The 0.85 damping factor is the same as the original PageRank paper — it represents an 85% chance that the "random surfer" follows a trust link, and a 15% chance they teleport to a random node.

</details>

### Confidence (lines 136-149)

A separate confidence score (0.0-0.95) based on total signal count: 0 signals = 0.0, <3 = 0.2, <10 = 0.4, <30 = 0.6, <100 = 0.8, 100+ = 0.95. Never 1.0 — there's always uncertainty. The recommendation engine uses confidence to distinguish "this is trustworthy" from "we don't have enough data."

### Recommendation Engine (recommendation.ts)

Translates scores into actionable advice (lines 37-124):

- **Trust level**: `high` (≥0.8), `moderate` (≥0.5), `low` (≥0.3), `very-low` (<0.3), `unknown` (no data).
- **Action**: `proceed` (score ≥0.7 AND confidence ≥0.4), `caution` (≥0.4), `verify` (≥0.2), `avoid` (<0.2).
- **Context adjustment** (lines 97-100): `before-transaction` context applies a 10% penalty — the bar is higher when money is involved.
- **Graph proximity** (lines 83-93): Direct trust connection (1-hop) boosts score by 15%. 2-hop boosts by 5%. If trusted attestors exist in your graph, that's noted in the reasoning.

<details>
<summary><strong>Design Decision — Why require both score AND confidence for "proceed"?</strong></summary>
<br>

A high score with low confidence is dangerous. A new restaurant with one 5-star review has score 1.0 but confidence 0.2. Recommending "proceed" would be irresponsible. By requiring both `score ≥ 0.7` AND `confidence ≥ 0.4`, the system ensures that "proceed" is only recommended when there's both positive signal *and* enough data to trust it. Low confidence always downgrades to "caution" or "verify" regardless of score.

</details>

---

## Act VI: Subject Identity Resolution — The Three Tiers

The `db/queries/subjects.ts` module solves one of the hardest problems in reputation: *what is the subject?* When Alice reviews "Dr. Sharma at Apollo Hospital" and Bob reviews "Dr. R. Sharma, Apollo Chennai," are they reviewing the same person?

### Tier 1: Global Identifiers (lines 24-35)

If the subject has a DID, URI, or external identifier, the subject ID is a deterministic SHA-256 hash: `sub_${sha256("did:" + did)}`. Same DID = same subject, regardless of who references it. This is author-independent — anyone can reference the same DID subject.

### Tier 2: Author-Scoped Names (lines 37-39)

If the subject only has a name (no DID, no URI), the subject ID is scoped to the author: `sub_${sha256("name:" + type + ":" + name + ":" + authorDid)}`. This means Alice's "Dr. Sharma" and Bob's "Dr. Sharma" create *separate* subjects by default. This prevents false merges — two different "Dr. Sharma"s in two different cities shouldn't share a reputation.

### Tier 3: Canonical Chains (lines 120-145)

Subject Claims (`com.dina.reputation.subjectClaim`) allow users to assert that two subjects are the same entity. When approved, a `canonical_subject_id` pointer is set, creating a merge chain. `resolveCanonicalChain()` follows these pointers (with cycle detection at line 128 and depth limiting at line 127) to find the root canonical subject. All future attestations resolve to the canonical subject.

<details>
<summary><strong>Design Decision — Why three tiers instead of fuzzy name matching?</strong></summary>
<br>

Fuzzy matching ("Dr. Sharma" ≈ "Dr. R. Sharma" at 85% similarity) produces false merges. In a reputation system, a false merge is catastrophic: a bad actor's reputation gets mixed with a legitimate person's. The three-tier approach is conservative by design: Tier 1 merges are deterministic and correct (same DID = same entity). Tier 2 keeps name-based subjects separate by default (safe). Tier 3 allows explicit human-initiated merges via Subject Claims, which can be disputed and revoked. False merges are correctable; false non-merges just mean fragmented data, which is inconvenient but not harmful.

</details>

---

## Act VII: The Trust Graph — BFS with Safety Rails

The `db/queries/graph.ts` module computes the trust graph around a DID using breadth-first traversal with three safety mechanisms.

### Statement Timeout (lines 44-64)

Every graph query runs inside a PostgreSQL transaction with `SET LOCAL statement_timeout = '100ms'` (line 52). If the BFS takes longer than 100ms, PostgreSQL cancels it (error code 57014) and the function returns a fallback (just the root node). This prevents a single expensive graph query from blocking the connection pool.

<details>
<summary><strong>Design Decision — Why a database-level timeout instead of an application-level timeout?</strong></summary>
<br>

An application-level timeout (e.g., `Promise.race` with a 100ms timer) stops the Node.js code but leaves the PostgreSQL query running. A long-running query holds locks, consumes a connection from the pool, and may compete with the ingester's writes. `SET LOCAL statement_timeout` cancels the query *inside PostgreSQL* — the database itself stops the work, releases locks, and frees the connection. This is the only reliable way to bound query execution in a connection-pooled environment.

</details>

### Fan-Out Limiting (lines 103-114, 138-149)

Each hop of the BFS fetches at most `MAX_EDGES_PER_HOP` (500) edges. A popular DID with 10,000 incoming vouches would otherwise explode the graph. The limit ensures bounded memory usage and predictable response times.

### Node Cap (lines 176-179)

If the graph accumulates more than `MAX_GRAPH_NODES_RESPONSE` (500) nodes, traversal stops regardless of depth. This prevents pathological graphs (e.g., a cluster of mutually-vouching accounts) from generating unbounded responses.

---

## Act VIII: The Scorer Daemon — 9 Jobs, One Scheduler

The scorer daemon runs 9 background jobs on cron schedules (`scorer/scheduler.ts:21-31`):

| Job | Schedule | Purpose |
|-----|----------|---------|
| `refresh-profiles` | Every 5 min | Recompute DID trust scores for dirty profiles |
| `refresh-subject-scores` | Every 5 min | Recompute subject scores for dirty subjects |
| `refresh-reviewer-stats` | Every 15 min | Update reviewer quality metrics |
| `refresh-domain-scores` | Every hour | Update domain-specific trust scores |
| `detect-coordination` | Every 30 min | Detect coordinated inauthentic behavior |
| `detect-sybil` | Every 6 hours | Detect Sybil attack clusters |
| `process-tombstones` | Every 10 min | Apply reputation penalties for tombstones |
| `decay-scores` | 3:00 AM daily | Apply temporal decay to scores |
| `cleanup-expired` | 4:00 AM daily | Remove expired records |

### Dirty Flag Architecture

The ingester doesn't compute scores at write time — it just marks affected entities as "dirty" (via `markDirty` in `db/queries/dirty-flags.ts`). The scorer picks up dirty entities in batches of 5000 and recomputes their scores. This decouples write throughput from scoring complexity: the ingester can process thousands of events per second while scoring runs at its own pace.

<details>
<summary><strong>Design Decision — Why incremental dirty-flag scoring instead of real-time computation?</strong></summary>
<br>

Computing a trust score requires gathering attestations, vouches, flags, reactions, trust edges, tombstones, and reviewer stats — at least 7 database queries per DID. Running this at ingestion time (every Jetstream event) would multiply write latency by 7-10x and couple ingestion throughput to scoring complexity. With dirty flags, the ingester does one `INSERT` + one `markDirty` (two fast writes). The scorer then batch-processes dirty entities every 5 minutes, amortizing the 7-query cost across thousands of entities at once. The tradeoff is up to 5 minutes of score staleness — acceptable for a reputation system where trust changes slowly.

</details>

### Anomaly Detection

Two jobs specifically target manipulation:

- **Coordination detection** (every 30 min) — Looks for clusters of accounts that review the same subjects within a 48-hour window. If ≥3 accounts create similar attestations for the same subject in quick succession, an `anomaly_event` is logged.
- **Sybil detection** (every 6 hours) — Looks for clusters of accounts with suspiciously similar behavior patterns. `SYBIL_MIN_CLUSTER_SIZE` is 3 — a cluster of 3+ accounts with correlated activity triggers investigation.

---

## Act IX: The API Layer — Five xRPC Endpoints

The web server in `web/server.ts` is a plain Node.js `http.createServer` with xRPC dispatch (69 lines). No Express, no Fastify — just a routing table (lines 14-20) mapping method IDs to handlers.

<details>
<summary><strong>Design Decision — Why a bare http.createServer instead of Express or Fastify?</strong></summary>
<br>

The AppView serves 5 read-only endpoints. Express adds 30+ middleware layers, template engines, and URL parsers that aren't needed. Fastify is faster but adds dependency weight. The xRPC protocol already defines the dispatch pattern: `GET /xrpc/{methodId}?params`. Implementing this with `http.createServer` is 47 lines of code (lines 22-64). The parameter validation is handled by Zod (one `parse` call), the response serialization is `JSON.stringify`, and error handling is a try/catch. There's nothing a framework would add except dependency surface and complexity.

</details>

### The Five Endpoints

1. **com.dina.reputation.resolve** (`api/xrpc/resolve.ts`) — The primary endpoint. Given a subject reference (DID, URI, or name), returns: trust level, confidence, attestation summary, active flags, authenticity assessment, graph context (if requester DID is provided), and a recommendation (proceed/caution/verify/avoid) with reasoning.

2. **com.dina.reputation.getProfile** — DID reputation profile with trust scores, vouch count, flag count, and component breakdown.

3. **com.dina.reputation.getGraph** — Trust graph visualization data (nodes and edges) around a DID.

4. **com.dina.reputation.search** — Full-text search across attestations with filters for sentiment, domain, tags, and confidence.

5. **com.dina.reputation.getAttestations** — Paginated attestation list for a subject or author.

### SWR Caching (api/middleware/swr-cache.ts)

Every API endpoint is wrapped in a **Stale-While-Revalidate** cache (92 lines). The pattern:

1. **Cache hit** (line 25-28) — Return immediately. Fastest path.
2. **In-flight coalescing** (line 30-33) — If another request for the same key is already fetching, wait for it instead of making a duplicate database query.
3. **Stale entry** (line 35-49) — Return the stale data immediately, but trigger a background refresh. The user gets fast (stale) data, and the next request gets fresh data.
4. **Cache miss** (line 51-64) — Fetch from database, cache, and return.

<details>
<summary><strong>Design Decision — Why SWR instead of simple TTL caching?</strong></summary>
<br>

Simple TTL caching has a "thundering herd" problem: when a popular cache entry expires, all concurrent requests hit the database simultaneously. SWR solves this by serving stale data to all-but-one request while one request refreshes the cache in the background. The `inFlight` map (line 15) ensures that at most one database query runs per cache key at any time. For a reputation API where data changes every 5 minutes (scorer interval) but queries arrive every second, SWR gives the best of both worlds: fresh-enough data and predictable database load.

</details>

---

## Act X: The Data Model — 19 Record Types + 6 System Tables

### Record Tables

Each of the 19 AT Protocol record types has a corresponding PostgreSQL table:

- **Attestations** — The core primitive. Structured reviews with subject, category, sentiment, dimensions, evidence, co-signatures, mentions.
- **Vouches** — Trust signals between DIDs. Confidence: high/moderate/low.
- **Endorsements** — Skill endorsements with endorsement type and relationship.
- **Flags** — Negative signals with severity: critical/serious/warning/informational.
- **Replies** — Comments on records with intent: agree/disagree/dispute/correct/clarify/add-context/thank.
- **Reactions** — Lightweight signals: helpful/unhelpful/agree/disagree/verified/can-confirm/suspicious/outdated.
- **Report Records** — Abuse reports with 13 report types (spam, fake-review, incentivized-undisclosed, self-review, competitor-attack, harassment, doxxing, off-topic, duplicate, ai-generated-undisclosed, defamation, conflict-of-interest, brigading).
- **Revocations** — Explicit withdrawal of a previously published record.
- **Delegations** — Authority delegations (e.g., "I authorize this bot to review on my behalf").
- **Collections** — Curated lists of records (public or private).
- **Media** — Attached media (photos, receipts, etc.).
- **Subject Records** — Explicit subject definitions with name, type, description, identifiers.
- **Amendments** — Corrections to existing records.
- **Verifications** — Third-party verification results: confirmed/denied/inconclusive.
- **Review Requests** — Requests for others to review a subject.
- **Comparisons** — Side-by-side comparisons of two or more subjects.
- **Subject Claims** — Assertions that two subjects are the same entity (triggers Tier 3 merge).
- **Trust Policies** — User-defined trust parameters (max graph depth, blocked DIDs, etc.).
- **Notification Preferences** — Per-user notification settings.

### System Tables

- **Subjects** — 3-tier identity resolution with canonical merge chains.
- **Trust Edges** — Graph edges between DIDs with type, domain, weight, and source URI.
- **Mention Edges** — Graph edges for attestation mentions.
- **Tombstones** — Preserved metadata from disputed deletions.
- **Anomaly Events** — Sybil and coordination detection results.
- **DID Profiles** — Computed trust scores per DID.
- **Subject Scores** — Computed reputation scores per subject.
- **Domain Scores** — Domain-specific trust scores.
- **Ingester Cursor** — Jetstream cursor tracking.

---

## Act XI: Deployment — Six Docker Services

The `docker-compose.yml` orchestrates six services:

1. **postgres** — PostgreSQL 17 with persistent volume.
2. **jetstream** — Bluesky Jetstream relay, subscribed to all 19 reputation collections.
3. **migrate** — One-shot migration runner (Drizzle ORM).
4. **ingester** — Jetstream consumer daemon.
5. **scorer** — Background scoring scheduler.
6. **web** — xRPC API server on port 3000.

Services have health checks and dependency ordering: migrate depends on postgres, ingester/scorer/web depend on migrate. The Jetstream relay is external — it connects to the Bluesky network and feeds events to the ingester.

<details>
<summary><strong>Design Decision — Why three separate daemons instead of one monolith?</strong></summary>
<br>

The ingester, scorer, and web server have fundamentally different scaling characteristics. The ingester is I/O-bound (WebSocket + database writes) and needs exactly one instance (Jetstream cursors aren't designed for multi-consumer). The scorer is CPU-bound (trust score computation) and can be scaled independently. The web server is stateless and can be horizontally scaled behind a load balancer. Splitting them means you can scale web servers to handle API traffic without running extra ingesters (which would fight over the cursor) or extra scorers (which would compute duplicate scores). Each daemon can also be restarted independently — a scorer crash doesn't affect API availability.

</details>

---

## Epilogue: The Trust Network in Context

The AppView is the third pillar of Dina's architecture:

| Component | Role | Technology |
|-----------|------|------------|
| **Core** | Sovereign identity + encrypted storage | Go |
| **Brain** | LLM reasoning + PII protection | Python |
| **AppView** | Decentralized trust network | TypeScript |

Core gives Dina her identity. Brain gives her judgment. AppView gives her memory of who to trust.

When Dina advises you before a purchase ("This seller has a trust score of 0.72 from 47 attestations, 3 of which are from people in your trust graph"), the data comes from the AppView. When an autonomous agent submits an intent to buy something, the Brain checks the seller's reputation via the AppView before approving the transaction. When Core receives a D2D message from an unknown Dina, it queries the AppView to determine whether to accept or quarantine it.

The trust network replaces ad-funded ranking with trust-funded ranking. A product with 10 genuine reviews from trusted reviewers outranks a product with 1000 fake reviews from anonymous accounts. An expert's attestation (high reviewer quality, evidence included, co-signed) carries more weight than a drive-by rating. And because the data lives on the AT Protocol, no single company can suppress, manipulate, or delete it.

This is Verified Truth — the second of Dina's Four Laws — implemented as arithmetic.
