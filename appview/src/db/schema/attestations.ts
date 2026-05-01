import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, boolean, jsonb, bigint, index } from 'drizzle-orm/pg-core'
import { subjects } from './subjects'

export const attestations = pgTable('attestations', {
  uri: text('uri').primaryKey(),
  authorDid: text('author_did').notNull(),
  cid: text('cid').notNull(),
  subjectId: text('subject_id').references(() => subjects.id),
  subjectRefRaw: jsonb('subject_ref_raw').notNull(),
  category: text('category').notNull(),
  sentiment: text('sentiment').notNull(),
  domain: text('domain'),
  confidence: text('confidence'),
  isAgentGenerated: boolean('is_agent_generated').default(false),
  hasCosignature: boolean('has_cosignature').default(false),
  cosignerDid: text('cosigner_did'),
  dimensionsJson: jsonb('dimensions_json'),
  interactionContextJson: jsonb('interaction_context_json'),
  contentContextJson: jsonb('content_context_json'),
  productContextJson: jsonb('product_context_json'),
  evidenceJson: jsonb('evidence_json'),
  mentionsJson: jsonb('mentions_json'),
  relatedAttestationsJson: jsonb('related_attestations_json'),
  bilateralReviewJson: jsonb('bilateral_review_json'),
  tags: text('tags').array(),
  text: text('text'),
  searchContent: text('search_content'),
  // FTS `search_vector tsvector GENERATED ALWAYS AS (...) STORED`
  // is intentionally NOT declared in this Drizzle schema. The
  // `db/fts_columns.ts` migration helper owns the column (Drizzle
  // can't express GENERATED-ALWAYS-AS), and declaring it here as a
  // regular column would make every `db.select().from(attestations)`
  // pull a fat tsvector into the result row. Queries that need it
  // (`api/xrpc/search.ts`) reference it via raw `sql` fragments —
  // see TN-DB-009.
  // BCP-47 language tag (e.g. 'en', 'pt-BR'). Auto-detected by the
  // ingester via `franc-min` on headline + body (TN-DB-008 / Plan §3.6).
  // Nullable for legacy rows + for content where detection failed (mixed
  // languages, very short text). Read by the search xRPC `language=`
  // filter.
  language: text('language'),
  // Pseudonymous namespace fragment (TN-DB-012 / Plan §3.5). The
  // `verificationMethod` id under which this attestation was signed,
  // e.g. `'#namespace_2'`. NULL = signed under the root identity.
  // Reviewer-trust scoring is per-(authorDid, namespace), so namespace
  // partitions the trust graph by pseudonymous compartment without
  // exposing them as separate DIDs.
  namespace: text('namespace'),
  // TN-V2-REV-001 — per-category use-case tags declared by the
  // reviewer (e.g. `['everyday', 'travel']`). Indexed GIN for
  // array-overlap queries from the use-case-aware search filter
  // (RANK-005 family). Nullable: legacy rows + reviews that didn't
  // declare a use case.
  useCases: text('use_cases').array(),
  // TN-V2-REV-003 — when the reviewer last used the subject. Wire
  // is `lastUsedMs` (integer ms; AT Protocol forbids floats in CBOR
  // records); the handler converts to a Postgres `timestamp` so the
  // search and scorer queries can use ordinary date arithmetic
  // (`WHERE last_used_at > NOW() - INTERVAL '6 months'`) and we
  // don't pay the conversion cost on every read. Nullable: most
  // reviews leave it absent.
  lastUsedAt: timestamp('last_used_at'),
  // TN-V2-REV-002 — self-declared reviewer expertise (`novice` /
  // `intermediate` / `expert`). Stored as text + indexed (b-tree)
  // for category-aware ranking ("expert reviews first" filter on
  // tech categories). Nullable: most legacy + casual reviews leave
  // it absent — absence ≠ novice; absence ≠ any tier.
  reviewerExperience: text('reviewer_experience'),
  // TN-V2-REV-004 — disjoint endorsement / warning use-case tags.
  // Indexed GIN (mirrors `tags` and `use_cases`) so search xRPC
  // can answer "subjects recommended for travel" / "warnings
  // against use for travel" via array-overlap queries.
  recommendFor: text('recommend_for').array(),
  notRecommendFor: text('not_recommend_for').array(),
  // TN-V2-REV-005 — other subjects the reviewer also tried.
  // Stored as JSONB (array of SubjectRef objects) — mirrors the
  // `subject_ref_raw` column pattern. The detail-page renderer
  // hydrates these against `subjects` by URI / DID / identifier
  // when present; entries that don't resolve render as plain
  // text. Not GIN-indexed: the access pattern is "given an
  // attestation row, list its alternatives" (the column is in
  // every row already), not "find attestations that mention
  // subject X" (a different feature, served by a separate
  // dedicated edge table if needed). Adding a GIN here for an
  // unrealised query would just be ceremony.
  alternativesJson: jsonb('alternatives_json'),
  // TN-V2-META-005 / META-006 — reviewer-declared compliance and
  // accessibility tags. Indexed GIN (mirrors `tags` / `use_cases`
  // / `recommend_for`) so the future RANK-004 search filter can
  // answer "halal restaurants" / "wheelchair-accessible venues"
  // via array-overlap queries. Subject-level merge across
  // reviewers (union into `subjects.metadata.compliance.tags`)
  // is deferred to META-001's unified pipeline.
  compliance: text('compliance').array(),
  accessibility: text('accessibility').array(),
  // TN-V2-META-003 — reviewer-declared compatibility tags
  // (`ios`, `usb-c`, `110v`, …). Same shape as compliance/
  // accessibility; subject-level merge deferred. Indexed GIN to
  // power RANK-003's array-OVERLAP search filter ("show me
  // anything that supports usb-c OR lightning"); overlap rather
  // than containment because compat is descriptive — a phone
  // doesn't claim universal compatibility just because the
  // search asks for both ports.
  compat: text('compat').array(),
  // TN-V2-META-002 — reviewer-declared price range. Stored as 4
  // separate columns rather than JSONB so the RANK-002 range
  // predicate (`low <= max AND high >= min`) can use ordinary
  // integer comparisons that ride a composite b-tree index. JSONB
  // path traversal would force every range query to extract +
  // cast on the hot path; the columnar split is denormalised but
  // cheap (4 nullable scalars vs. one nullable jsonb document).
  // `bigint` (Postgres `int8`) because the e7-scaled value of an
  // expensive item easily exceeds 2^31 (e.g. a $300 item is
  // 3_000_000_000_e7 — still inside int8 by a wide margin but
  // outside int4). All four columns are nullable + tied together
  // (a row either has the full price object or none of it; the
  // ingester enforces this at write time).
  priceLowE7: bigint('price_low_e7', { mode: 'number' }),
  priceHighE7: bigint('price_high_e7', { mode: 'number' }),
  priceCurrency: text('price_currency'),
  priceLastSeenAt: timestamp('price_last_seen_at'),
  // TN-V2-META-001 — reviewer-declared availability. Three
  // independent text[] columns rather than a single JSONB so each
  // sub-field gets its own GIN array-overlap index — the natural
  // search shape ("subjects sold in GB", "ships to US", "sold at
  // amazon.com") is per-sub-field, not "entire availability
  // matches X". JSONB would force every search to traverse a
  // path expression and skip the index.
  availabilityRegions: text('availability_regions').array(),
  availabilityShipsTo: text('availability_ships_to').array(),
  availabilitySoldAt: text('availability_sold_at').array(),
  // TN-V2-META-004 — reviewer-declared schedule. Heterogeneous
  // shape (per-day open/close map + scalar leadDays + month
  // array) — JSONB keeps the wire shape addressable on read
  // without a denormalised explosion of columns. No search
  // predicate today benefits from a dedicated column; if one
  // emerges (e.g. "places open after 9pm") it gets a functional
  // index over `schedule_json->'hours'->'mon'->>'close'` then.
  scheduleJson: jsonb('schedule_json'),
  // Synthetic correlation id assigned at firehose ingest (TN-OBS-002 /
  // Plan §13.8). Allows post-hoc reconstruction of "where did Sancho's
  // review of the Aeron chair land?" by following one trace through
  // ingester logs → handler logs → scorer batch logs. Generated via
  // `crypto.randomUUID()` at the top of the dispatcher; if a future
  // lexicon change carries `trace_id` on the wire record body, the
  // ingester will preserve that instead. Nullable: legacy rows
  // pre-dating TN-OBS-002 have no trace, and ingest-failure paths
  // never reach the handler that would set it. Stored unindexed —
  // retrieval is by URI (PK) or via log search by trace_id; an index
  // is unnecessary at V1 volumes.
  traceId: text('trace_id'),
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
  isRevoked: boolean('is_revoked').default(false),
  revokedByUri: text('revoked_by_uri'),
  isAmended: boolean('is_amended').default(false),
  latestAmendmentUri: text('latest_amendment_uri'),
  isVerified: boolean('is_verified').default(false),
  verifiedByUri: text('verified_by_uri'),
}, (table) => [
  index('attestations_author_idx').on(table.authorDid),
  index('attestations_subject_idx').on(table.subjectId),
  index('attestations_sentiment_idx').on(table.sentiment),
  index('attestations_domain_idx').on(table.domain),
  index('attestations_category_idx').on(table.category),
  index('attestations_created_idx').on(table.recordCreatedAt),
  index('attestations_tags_idx').using('gin', table.tags),
  index('attestations_cosigner_idx').on(table.cosignerDid),
  index('attestations_subject_sentiment_idx').on(table.subjectId, table.sentiment),
  index('attestations_author_domain_idx').on(table.authorDid, table.domain),
  // Partial index — most rows have language set; indexing only the
  // populated rows keeps the b-tree small. Plan §4.1.
  index('attestations_language_idx').on(table.language).where(sql`${table.language} IS NOT NULL`),
  // Reviewer-trust per (author, namespace) lookup needs both columns
  // indexed together. Partial WHERE namespace IS NOT NULL keeps the
  // b-tree small — the root-identity case (NULL) is by far the
  // largest population at V1 launch and goes through the existing
  // `attestations_author_idx`. TN-DB-012.
  index('attestations_author_namespace_idx')
    .on(table.authorDid, table.namespace)
    .where(sql`${table.namespace} IS NOT NULL`),
  // TN-V2-REV-001 — GIN array-overlap index for use-case-aware
  // search ("show me reviews tagged 'travel'"). Mirrors the
  // existing `attestations_tags_idx` shape.
  index('attestations_use_cases_idx').using('gin', table.useCases),
  // TN-V2-REV-003 — partial index on last_used_at. Most rows leave
  // it NULL (legacy + opt-in field), so the b-tree only carries the
  // populated subset. Powers per-category recency-decay queries
  // (RANK-006) and the "stale" badge.
  index('attestations_last_used_idx')
    .on(table.lastUsedAt)
    .where(sql`${table.lastUsedAt} IS NOT NULL`),
  // TN-V2-REV-002 — partial index on reviewer_experience. Three
  // values + NULL; partial index on non-null only since "any tier"
  // queries don't hit this index. Powers RANK-008 expert weighting.
  index('attestations_reviewer_experience_idx')
    .on(table.reviewerExperience)
    .where(sql`${table.reviewerExperience} IS NOT NULL`),
  // TN-V2-REV-004 — GIN array-overlap indexes for "recommended for
  // travel" / "warned against for travel" search filters. Mirrors
  // `attestations_use_cases_idx` shape.
  index('attestations_recommend_for_idx').using('gin', table.recommendFor),
  index('attestations_not_recommend_for_idx').using('gin', table.notRecommendFor),
  // TN-V2-META-005 / META-006 — GIN array-overlap indexes for
  // dietary / accessibility tag search filters (RANK-004 family).
  index('attestations_compliance_idx').using('gin', table.compliance),
  index('attestations_accessibility_idx').using('gin', table.accessibility),
  // TN-V2-META-003 — GIN index for compat-tag array-overlap
  // search (RANK-003: "things compatible with usb-c").
  index('attestations_compat_idx').using('gin', table.compat),
  // TN-V2-META-002 / RANK-002 — composite b-tree index on the
  // price range, partial WHERE the low-end column is non-NULL
  // (NULL price means "no price declared" and the RANK-002
  // predicate's missing-pass clause `priceLowE7 IS NULL OR …`
  // short-circuits before this index is consulted). Composite
  // ordering (`low_e7, high_e7`) supports the range-overlap
  // predicate's leading column scan — Postgres can range-scan
  // on `priceLowE7 <= max` and refine with `priceHighE7 >= min`
  // from the same index entry.
  index('attestations_price_range_idx')
    .on(table.priceLowE7, table.priceHighE7)
    .where(sql`${table.priceLowE7} IS NOT NULL`),
  // TN-V2-META-001 — GIN array-overlap indexes for the three
  // availability sub-fields. Same shape as compliance / compat —
  // empty arrays collapse to NULL on the ingest path so the GIN
  // stays sparse.
  index('attestations_availability_regions_idx').using('gin', table.availabilityRegions),
  index('attestations_availability_ships_to_idx').using('gin', table.availabilityShipsTo),
  index('attestations_availability_sold_at_idx').using('gin', table.availabilitySoldAt),
])
