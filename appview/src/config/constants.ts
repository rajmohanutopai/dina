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
  /**
   * D4 — the fixed weight an IMPORTED review carries in a subject's rating.
   *
   * Fixed, and deliberately not derived from anything: a feed publisher's own
   * trust score must never flow into the reviews it imports, or an operator
   * could vouch for their own feed and have somebody else's stars speak with
   * a peer's authority. Small enough that a handful of peer reviews outweigh
   * a corpus of imports; large enough that a market with nothing else has
   * something to rank by, which is the whole point of the cold start.
   */
  IMPORTED_REVIEW_WEIGHT: 0.2,
  /**
   * D4 — the most weighted mass every imported review for ONE subject may
   * contribute, together.
   *
   * A per-review weight alone bounds nothing: a feed that publishes ten
   * thousand reviews of one supplier would swamp any number of people who
   * actually dealt with them, and a rating nobody's testimony can move is
   * the Dead Internet with a citation. The ceiling is about five vouched
   * peer reviews' worth — enough to answer a market with nothing, never
   * enough to bury the market once it has someone.
   *
   * Applied by SCALING, not by dropping rows: the imports keep their
   * internal balance of positive and negative, and the result does not
   * depend on which order the rows came back in.
   */
  MAX_IMPORTED_WEIGHT: 4.0,

  // Graph
  MAX_GRAPH_DEPTH: 2,
  MAX_GRAPH_NODES_RESPONSE: 500,
  MAX_EDGES_PER_HOP: 500,
  GRAPH_QUERY_TIMEOUT_MS: 100,

  // Pagination
  DEFAULT_PAGE_SIZE: 25,
  MAX_PAGE_SIZE: 100,

  // Tombstones
  COORDINATION_TOMBSTONE_THRESHOLD: 3,

  // Vouch strength thresholds
  VOUCH_LIGHTLY: 1,
  VOUCH_WELL: 3,
  VOUCH_STRONGLY: 10,

  // ISR revalidation (seconds)
  SUBJECT_PAGE_REVALIDATE_S: 60,
  PROFILE_PAGE_REVALIDATE_S: 120,
  SEARCH_PAGE_REVALIDATE_S: 30,

  // Scorer
  SYBIL_MIN_CLUSTER_SIZE: 3,
  COORDINATION_WINDOW_HOURS: 48,

  // Rate limiter
  MAX_RECORDS_PER_HOUR: 50,
  MAX_TRACKED_DIDS: 100_000,

  // Bounded queue
  MAX_QUEUE_SIZE: 1000,
  MAX_CONCURRENCY: 20,

  // Cursor
  CURSOR_SAVE_INTERVAL: 100,

  // Subject resolution
  MAX_CHAIN_DEPTH: 5,

  // SubjectRef wire-format bounds. Single source of truth for the
  // resolver (`db/queries/subjects.ts`) AND the lexicon validators
  // (`ingester/record-validator.ts`, `api/xrpc/test-inject.ts`). If
  // they ever drift, names a publisher can submit might fail to
  // hash, or hash-able names might be rejected by the lexicon —
  // either way, asymmetric behavior. Pinned here so a single edit
  // moves all three layers in lockstep.
  SUBJECT_REF_MAX_NAME_LEN: 200,
  SUBJECT_REF_MAX_IDENTIFIER_LEN: 500,
  SUBJECT_REF_MAX_URI_LEN: 2048,
  SUBJECT_REF_MAX_DID_LEN: 2048,

  // Scorer batch
  SCORER_BATCH_SIZE: 5000,

  // Trust edge weights
  EDGE_WEIGHT_VOUCH_HIGH: 1.0,
  EDGE_WEIGHT_VOUCH_MODERATE: 0.6,
  EDGE_WEIGHT_VOUCH_LOW: 0.3,
  EDGE_WEIGHT_ENDORSEMENT_WORKED: 0.8,
  EDGE_WEIGHT_ENDORSEMENT_OBSERVED: 0.4,
  EDGE_WEIGHT_DELEGATION: 0.9,
  EDGE_WEIGHT_COSIGN: 0.7,
  EDGE_WEIGHT_POSITIVE_ATTESTATION: 0.3,

  // Damping
  DAMPING_FACTOR: 0.85,
  BASE_SCORE: 0.1,

  // Cache
  MAX_CACHE_SIZE: 10_000,
  CACHE_TTL_RESOLVE: 5_000,
  CACHE_TTL_GET_PROFILE: 10_000,
  CACHE_TTL_SEARCH: 3_000,
  // XR2: Graph BFS is the most expensive query (up to 500 nodes, 100 queries).
  // 30s TTL prevents abuse while keeping data reasonably fresh.
  CACHE_TTL_GET_GRAPH: 30_000,

  // Reconnection
  MAX_RECONNECT_DELAY_MS: 60_000,
} as const
