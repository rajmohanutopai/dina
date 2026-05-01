import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, boolean, jsonb, index } from 'drizzle-orm/pg-core'

export const subjects = pgTable('subjects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  subjectType: text('subject_type').notNull(),
  did: text('did'),
  identifiersJson: jsonb('identifiers_json').default(sql`'[]'::jsonb`).notNull(),
  authorScopedDid: text('author_scoped_did'),
  canonicalSubjectId: text('canonical_subject_id'),
  needsRecalc: boolean('needs_recalc').default(true).notNull(),
  // ── Enrichment columns (TN-DB-007 / Plan §3.6 + §4.1) ──────────────
  // The ingester writes these via the deterministic `enrichSubject()`
  // pure-data composer (see `appview/src/util/subject_enrichment.ts`).
  // Publishers don't need to know the taxonomy — enrichment is server-
  // side, so the wire schema stays sparse.
  category: text('category'),
  // `metadata`: type-specific bag per plan §3.6.2 — `host`, `media_type`,
  // `identifier_kind`, `lat`/`lng`, `org_type`, `qid`, `did_method`, etc.
  // NOT NULL with default `'{}'` so the GIN index never sees NULL (also
  // simplifies search xRPC's `metadata->>'lat'` extraction — no null
  // guard needed).
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  // BCP-47 language tag (e.g. `'en'`, `'pt-BR'`). Auto-detected by
  // `franc-min` over name + searchable text. Nullable for legacy rows
  // and content where detection failed.
  language: text('language'),
  // Set to NOW() by the enricher on every recompute. NULL = never
  // enriched (orphan or pre-V1 row); the weekly batch re-enrichment job
  // (TN-ENRICH-006) prioritises NULL/oldest rows.
  // Plain `timestamp` (TIMESTAMP WITHOUT TIME ZONE) matches AppView's
  // codebase convention; Plan §4.1 letter calls for TIMESTAMPTZ but
  // every other timestamp column across the 27 baseline tables is
  // plain TIMESTAMP — a single TIMESTAMPTZ column would be a bug
  // magnet. Same reasoning as `ingest_rejections.rejected_at`.
  enrichedAt: timestamp('enriched_at'),
  // TN-V2-META-011 — server-derived freshness signal. Updated to
  // GREATEST(existing, attestation.recordCreatedAt) on every
  // attestation create. Powers the "stale review" badge in §5
  // (subject hasn't been reviewed in N months → grey banner) and
  // the per-category recency-decay tuning in RANK-006. Distinct
  // from `updatedAt` (any subject row mutation, including
  // enrichment) and `createdAt` (when the subject row itself was
  // first persisted). NULL = no attestation has landed yet, which
  // shouldn't happen in practice (subjects are created by the
  // attestation path) but is permitted for forward-compat with
  // future "subject pre-registration" flows.
  lastActiveAt: timestamp('last_active_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('subjects_did_idx').on(table.did),
  index('subjects_identifiers_idx').using('gin', table.identifiersJson),
  index('subjects_author_scoped_idx').on(table.authorScopedDid).where(sql`${table.authorScopedDid} IS NOT NULL`),
  index('subjects_canonical_idx').on(table.canonicalSubjectId).where(sql`${table.canonicalSubjectId} IS NOT NULL`),
  // Search xRPC: `category=` filter. Partial — most rows will eventually
  // have category, but pre-enrichment rows are NULL, so the partial
  // predicate keeps the b-tree small until backfill completes.
  index('subjects_category_idx').on(table.category).where(sql`${table.category} IS NOT NULL`),
  // Search xRPC: `language=` filter. Same partial-index rationale.
  index('subjects_language_idx').on(table.language).where(sql`${table.language} IS NOT NULL`),
  // Search xRPC: `metadataFilters=` jsonb-contains queries (e.g.
  // `metadata @> '{"host": "amazon.com"}'`). `jsonb_path_ops` opclass
  // is faster + smaller than the default `jsonb_ops` for the @>
  // containment operator that the search xRPC actually uses (per
  // Postgres docs — half the size, often ~5× the lookup speed).
  index('subjects_metadata_idx').using('gin', table.metadata.op('jsonb_path_ops')),
  // Geo radius query for `place` subjects. Two-column expression index
  // — Drizzle's `.on(...args)` is variadic, so each `sql` argument
  // becomes a separate index column (a single combined `sql` would be
  // treated as one column). Generated DDL:
  //   `... ON subjects ((metadata->>'lat'), (metadata->>'lng'))`.
  // Lets the search xRPC use a b-tree range scan for
  // `lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?` bounding-box queries.
  // Partial — only `place` rows with parsed coords have these keys, so
  // the index size is bounded by the place population, not the whole
  // subject corpus.
  index('subjects_geo_idx')
    .on(
      sql`(${table.metadata}->>'lat')`,
      sql`(${table.metadata}->>'lng')`,
    )
    .where(sql`${table.metadata} ? 'lat' AND ${table.metadata} ? 'lng'`),
  // TN-V2-META-011 — partial b-tree index. Powers "stale subjects"
  // queries (`WHERE last_active_at < NOW() - INTERVAL '6 months'`)
  // and per-category recency-decay sort tweaks. Partial WHERE NOT
  // NULL keeps the b-tree small while pre-attestation rows exist
  // (none in V1, but the column is nullable).
  index('subjects_last_active_idx')
    .on(table.lastActiveAt)
    .where(sql`${table.lastActiveAt} IS NOT NULL`),
])
