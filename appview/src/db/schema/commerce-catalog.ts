import { pgTable, text, integer, boolean, timestamp, jsonb, index } from 'drizzle-orm/pg-core'

/**
 * The commerce catalog projection (§10.2–§10.4, FR-A1–FR-A7).
 *
 * THREE TABLES, AND THE SPLIT IS THE DESIGN.
 *
 * `commerce_catalog_pointers` is the AUTHORITY: one row per
 * (supplier, catalog) naming the snapshot that is current. Everything a buyer
 * can find hangs off a row here, so retiring a catalog is a single write.
 *
 * `commerce_catalog_snapshots` is EVIDENCE, keyed by content digest. A
 * snapshot may arrive before the pointer that names it (Jetstream orders
 * nothing between collections), and it may arrive and never be named at all —
 * a draft the supplier chose not to publish. Neither is indexed. Storing them
 * separately is what lets both delivery orders reach the same index without
 * either one being able to make a snapshot current on its own.
 *
 * `commerce_catalog_products` is the searchable projection: one row per exact
 * variant per supplier, replaced wholesale when the pointer advances, because
 * a v1 snapshot is full state.
 *
 * GREENFIELD, like `catalog_snapshots` beside it: applied from the schema, no
 * incremental migration maintained.
 */

export const commerceCatalogPointers = pgTable(
  'commerce_catalog_pointers',
  {
    /** `<supplier_did>/<catalog_id>` — one current pointer per catalog. */
    id: text('id').primaryKey(),
    supplierDid: text('supplier_did').notNull(),
    catalogId: text('catalog_id').notNull(),
    snapshotSequence: integer('snapshot_sequence').notNull(),
    protocolVersion: text('protocol_version').notNull(),
    publishedAt: text('published_at').notNull(),
    /** Absent on a tombstone — a withdrawal names no snapshot. */
    snapshotDigest: text('snapshot_digest'),
    previousSnapshotDigest: text('previous_snapshot_digest'),
    /**
     * §10.4 / FR-A6. The row SURVIVES a withdrawal rather than being deleted:
     * it is what makes the chain rule refuse a later publication under the
     * same catalog_id. Deleting it would let a retired identity be relaunched
     * silently, which is exactly the signal a buyer needs to see.
     */
    withdrawn: boolean('withdrawn').notNull().default(false),
    /**
     * True while the pointer is legal but its snapshot has not arrived.
     * Nothing is indexed for a pending pointer; the previous catalog stays
     * queryable, which is the honest fallback.
     */
    awaitingSnapshot: boolean('awaiting_snapshot').notNull().default(false),
    /**
     * The service listing that serves this catalog (§10.5, DR-5). NULL when
     * the supplier did not say, in which case discovery falls back to the
     * `self` convention rather than pretending to know.
     */
    serviceRkey: text('service_rkey'),
    /** The AT-URI this pointer came from, for audit. */
    uri: text('uri').notNull(),
    indexedAt: timestamp('indexed_at').notNull().defaultNow(),
  },
  (table) => [
    index('commerce_catalog_pointers_supplier_idx').on(table.supplierDid),
    index('commerce_catalog_pointers_pending_idx').on(table.snapshotDigest),
  ],
)

export const commerceCatalogSnapshots = pgTable(
  'commerce_catalog_snapshots',
  {
    /** The snapshot's own content digest. Immutable, so it is the key. */
    snapshotDigest: text('snapshot_digest').primaryKey(),
    supplierDid: text('supplier_did').notNull(),
    catalogId: text('catalog_id').notNull(),
    snapshotSequence: integer('snapshot_sequence').notNull(),
    /** The record as published, so verification can be re-run from storage. */
    snapshotJson: jsonb('snapshot_json').notNull(),
    /** The pages, inline. Bounded by the §10.2 caps before this row is written. */
    pagesJson: jsonb('pages_json').notNull(),
    receivedAt: timestamp('received_at').notNull().defaultNow(),
  },
  (table) => [index('commerce_catalog_snapshots_supplier_idx').on(table.supplierDid)],
)

export const commerceCatalogProducts = pgTable(
  'commerce_catalog_products',
  {
    /** Supplier plus product identity, length-prefixed so it cannot splice. */
    rowKey: text('row_key').primaryKey(),
    /** Identity, from the identifier. NEVER derived from the name (FR-A3). */
    productKey: text('product_key').notNull(),
    supplierDid: text('supplier_did').notNull(),
    catalogId: text('catalog_id').notNull(),
    snapshotSequence: integer('snapshot_sequence').notNull(),
    /** Source evidence: which snapshot this row came from (FR-A5). */
    snapshotDigest: text('snapshot_digest').notNull(),
    /**
     * Denormalized from the pointer, the way `snapshotDigest` already is, so
     * search does not join to answer "where do I send the quote request".
     * NULL means the supplier never said; discovery then uses `self`.
     */
    serviceRkey: text('service_rkey'),
    itemRevision: text('item_revision').notNull(),
    name: text('name').notNull(),
    brand: text('brand'),
    description: text('description'),
    categoryIds: jsonb('category_ids').notNull(),
    /** Every identifier the item claims, so any of them finds it. */
    identifierKeys: jsonb('identifier_keys').notNull(),
    fulfilmentRegions: jsonb('fulfilment_regions').notNull(),
    /**
     * §10.4 permits an indicative price and forbids presenting it as a current
     * contractual offer. There is deliberately NO column for live stock or
     * buyer authorization (FR-A7) — a field that does not exist cannot leak.
     */
    indicativePrice: jsonb('indicative_price'),
    generatedAt: text('generated_at').notNull(),
    validUntil: text('valid_until'),
    indexedAt: timestamp('indexed_at').notNull().defaultNow(),
  },
  (table) => [
    index('commerce_catalog_products_catalog_idx').on(table.supplierDid, table.catalogId),
    index('commerce_catalog_products_product_idx').on(table.productKey),
  ],
)

/**
 * Product relationship claims and the edges derived from them (§10.7, FR-A8).
 *
 * TWO TABLES, AND THE SPLIT IS THE POINT. `commerce_relationship_claims` holds
 * what people SAID, verbatim and durably. `commerce_product_relationships`
 * holds what AppView currently BELIEVES, derived from all the claims about one
 * subject. Deriving rather than mutating is what makes a claim's withdrawal
 * work: a dispute has to be able to disappear when the claim that caused it is
 * deleted, and an edge table mutated in place cannot do that without keeping
 * the claims anyway.
 */
export const commerceRelationshipClaims = pgTable(
  'commerce_relationship_claims',
  {
    /** The AT-URI the claim was published at. One claim per record. */
    uri: text('uri').primaryKey(),
    claimId: text('claim_id').notNull(),
    issuerDid: text('issuer_did').notNull(),
    subjectKey: text('subject_key').notNull(),
    relationship: text('relationship').notNull(),
    /** Product key, or `did:…` when the object is an operator. */
    objectKey: text('object_key').notNull(),
    /** `first_party_claim` | `third_party_claim` | `inferred`. */
    source: text('source').notNull(),
    confidenceBp: integer('confidence_bp').notNull(),
    /** Required for an `inferred` claim; §10.7 wants inferences versioned. */
    inferenceVersion: text('inference_version'),
    claimJson: jsonb('claim_json').notNull(),
    assertedAt: text('asserted_at').notNull(),
  },
  (table) => [index('commerce_relationship_claims_subject_idx').on(table.subjectKey)],
)

export const commerceProductRelationships = pgTable(
  'commerce_product_relationships',
  {
    /** Subject + relationship (+ object, when many-to-many). */
    edgeKey: text('edge_key').primaryKey(),
    subjectKey: text('subject_key').notNull(),
    relationship: text('relationship').notNull(),
    objectKey: text('object_key').notNull(),
    /** Strongest single claim, never a sum. */
    confidenceBp: integer('confidence_bp').notNull(),
    /** §10.7: exposed, not resolved. */
    disputed: boolean('disputed').notNull().default(false),
    /** Every claim behind the edge — source, issuer, time, confidence. */
    evidenceJson: jsonb('evidence_json').notNull(),
    indexedAt: timestamp('indexed_at').notNull().defaultNow(),
  },
  (table) => [
    index('commerce_product_relationships_subject_idx').on(table.subjectKey),
    index('commerce_product_relationships_object_idx').on(table.objectKey),
  ],
)
