import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, boolean, jsonb, index } from 'drizzle-orm/pg-core'
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
])
