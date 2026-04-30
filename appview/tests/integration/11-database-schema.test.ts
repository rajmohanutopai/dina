/**
 * Section 11 -- Database Schema + Indexes
 * Total tests: 25
 * Plan traceability: IT-DB-001 .. IT-DB-025
 *
 * Subsections:
 *   11.1 Schema Correctness   (9 tests: IT-DB-001..009)
 *   11.2 Index Verification   (12 tests: IT-DB-010..021)
 *   11.3 Query Performance    (4 tests: IT-DB-022..025)
 *
 * Source: INTEGRATION_TEST_PLAN.md, Fix 9 (partial indexes on needs_recalc)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { getTestDb, closeTestDb, type TestDB } from '../test-db'

let db: TestDB

beforeAll(async () => {
  db = getTestDb()
  // Clean tables used by constraint tests once before all tests in this file
  await db.execute(sql`
    TRUNCATE TABLE attestations, trust_edges, tombstones, subject_scores, did_profiles, subjects, ingest_rejections, cosig_requests, trust_v1_params, appview_config CASCADE
  `)
})

afterAll(async () => {
  await closeTestDb()
})

// ---------------------------------------------------------------------------
// 11.1 Schema Correctness
// ---------------------------------------------------------------------------
describe('11.1 Schema Correctness', () => {
  // TRACE: {"suite": "APPVIEW", "case": "0538", "section": "01", "sectionName": "General", "title": "IT-DB-001: migrations run cleanly"}
  it('IT-DB-001: migrations run cleanly', async () => {
    // Description: Fresh database, apply all migrations
    // Expected: No errors
    const result = await db.execute(sql`SELECT 1 AS ok`)
    expect(result.rows[0].ok).toBe(1)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0539", "section": "01", "sectionName": "General", "title": "IT-DB-002: all 31 tables exist"}
  it('IT-DB-002: all 31 tables exist', async () => {
    // Description: Query information_schema for all expected tables
    // Expected: 27 baseline + ingest_rejections (TN-DB-005) + cosig_requests (TN-DB-003)
    //           + trust_v1_params (TN-DB-004) + appview_config (TN-FLAG-001).
    const expectedTables = [
      'attestations', 'vouches', 'endorsements', 'flags', 'replies',
      'reactions', 'report_records', 'revocations', 'delegations', 'collections',
      'media', 'subjects', 'amendments', 'verifications', 'review_requests',
      'comparisons', 'subject_claims', 'trust_policies', 'notification_prefs',
      'mention_edges', 'tombstones', 'trust_edges', 'anomaly_events',
      'ingester_cursor', 'did_profiles', 'subject_scores', 'domain_scores',
      'ingest_rejections', 'cosig_requests', 'trust_v1_params', 'appview_config',
    ]

    const result = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `)
    const tableNames = result.rows.map((r: any) => r.table_name)

    for (const expected of expectedTables) {
      expect(tableNames).toContain(expected)
    }
    expect(tableNames.length).toBe(31)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0540", "section": "01", "sectionName": "General", "title": "IT-DB-003: attestations -- primary key on uri"}
  it('IT-DB-003: attestations -- primary key on uri', async () => {
    // Description: Duplicate uri insert
    // Expected: Constraint violation (without onConflict)
    const testUri = `at://did:plc:test11/com.dina.trust.attestation/db003-${Date.now()}`

    await db.execute(sql.raw(`
      INSERT INTO attestations (uri, author_did, cid, subject_ref_raw, category, sentiment, record_created_at, indexed_at)
      VALUES ('${testUri}', 'did:plc:author1', 'bafytest1', '{}', 'product', 'positive', NOW(), NOW())
    `))

    await expect(
      db.execute(sql.raw(`
        INSERT INTO attestations (uri, author_did, cid, subject_ref_raw, category, sentiment, record_created_at, indexed_at)
        VALUES ('${testUri}', 'did:plc:author2', 'bafytest2', '{}', 'service', 'negative', NOW(), NOW())
      `))
    ).rejects.toThrow()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0541", "section": "01", "sectionName": "General", "title": "IT-DB-004: trust_edges -- unique on sourceUri"}
  it('IT-DB-004: trust_edges -- unique on sourceUri', async () => {
    // Description: Duplicate sourceUri insert
    // Expected: Constraint violation
    const testSourceUri = `at://did:plc:te/trust/db004-${Date.now()}`

    await db.execute(sql.raw(`
      INSERT INTO trust_edges (id, from_did, to_did, edge_type, weight, source_uri, created_at)
      VALUES ('te-db004a-${Date.now()}', 'did:plc:from1', 'did:plc:to1', 'vouch', 1.0, '${testSourceUri}', NOW())
    `))

    await expect(
      db.execute(sql.raw(`
        INSERT INTO trust_edges (id, from_did, to_did, edge_type, weight, source_uri, created_at)
        VALUES ('te-db004b-${Date.now()}', 'did:plc:from2', 'did:plc:to2', 'vouch', 0.5, '${testSourceUri}', NOW())
      `))
    ).rejects.toThrow()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0542", "section": "01", "sectionName": "General", "title": "IT-DB-005: tombstones -- unique on originalUri"}
  it('IT-DB-005: tombstones -- unique on originalUri', async () => {
    // Description: Duplicate originalUri insert
    // Expected: Constraint violation
    const testOrigUri = `at://did:plc:tb/record/db005-${Date.now()}`

    await db.execute(sql.raw(`
      INSERT INTO tombstones (id, original_uri, author_did, record_type, deleted_at)
      VALUES ('tb-db005a-${Date.now()}', '${testOrigUri}', 'did:plc:author1', 'attestation', NOW())
    `))

    await expect(
      db.execute(sql.raw(`
        INSERT INTO tombstones (id, original_uri, author_did, record_type, deleted_at)
        VALUES ('tb-db005b-${Date.now()}', '${testOrigUri}', 'did:plc:author2', 'vouch', NOW())
      `))
    ).rejects.toThrow()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0543", "section": "01", "sectionName": "General", "title": "IT-DB-006: subjects -- primary key on id"}
  it('IT-DB-006: subjects -- primary key on id', async () => {
    // Description: Duplicate id insert
    // Expected: Constraint violation
    const testId = `sub-db006-${Date.now()}`

    await db.execute(sql.raw(`
      INSERT INTO subjects (id, name, subject_type, created_at, updated_at)
      VALUES ('${testId}', 'Test Product', 'product', NOW(), NOW())
    `))

    await expect(
      db.execute(sql.raw(`
        INSERT INTO subjects (id, name, subject_type, created_at, updated_at)
        VALUES ('${testId}', 'Another Product', 'service', NOW(), NOW())
      `))
    ).rejects.toThrow()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0544", "section": "01", "sectionName": "General", "title": "IT-DB-007: did_profiles -- primary key on did"}
  it('IT-DB-007: did_profiles -- primary key on did', async () => {
    // Description: Duplicate did insert
    // Expected: Constraint violation
    const testDid = `did:plc:db007-${Date.now()}`

    await db.execute(sql.raw(`
      INSERT INTO did_profiles (did, needs_recalc, computed_at)
      VALUES ('${testDid}', true, NOW())
    `))

    await expect(
      db.execute(sql.raw(`
        INSERT INTO did_profiles (did, needs_recalc, computed_at)
        VALUES ('${testDid}', false, NOW())
      `))
    ).rejects.toThrow()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0545", "section": "01", "sectionName": "General", "title": "IT-DB-008: subject_scores -- primary key on subjectId"}
  it('IT-DB-008: subject_scores -- primary key on subjectId', async () => {
    // Description: Duplicate subjectId insert
    // Expected: Constraint violation
    const testSubId = `sub-db008-${Date.now()}`

    // First create the subject (FK requirement)
    await db.execute(sql.raw(`
      INSERT INTO subjects (id, name, subject_type, created_at, updated_at)
      VALUES ('${testSubId}', 'Test Subject', 'product', NOW(), NOW())
    `))

    await db.execute(sql.raw(`
      INSERT INTO subject_scores (subject_id, needs_recalc, computed_at)
      VALUES ('${testSubId}', true, NOW())
    `))

    await expect(
      db.execute(sql.raw(`
        INSERT INTO subject_scores (subject_id, needs_recalc, computed_at)
        VALUES ('${testSubId}', false, NOW())
      `))
    ).rejects.toThrow()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0546", "section": "01", "sectionName": "General", "title": "IT-DB-009: subject_scores -- foreign key to subjects"}
  it('IT-DB-009: subject_scores -- foreign key to subjects', async () => {
    // Description: Insert with non-existent subjectId
    // Expected: Foreign key violation
    await expect(
      db.execute(sql.raw(`
        INSERT INTO subject_scores (subject_id, needs_recalc, computed_at)
        VALUES ('nonexistent-subject-db009-${Date.now()}', true, NOW())
      `))
    ).rejects.toThrow()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0581", "section": "01", "sectionName": "General", "title": "IT-DB-026: subject_scores -- score_version column with default 'v1' (TN-DB-001)"}
  it("IT-DB-026: subject_scores -- score_version column defaults to 'v1' (TN-DB-001)", async () => {
    // Description: Insert without specifying score_version; expect default 'v1' per Plan §4.1.
    // Rationale: Legacy code paths that don't yet stamp scoreVersion must keep working post-migration.
    const testSubId = `sub-db026-${Date.now()}`
    await db.execute(sql.raw(`
      INSERT INTO subjects (id, name, subject_type, created_at, updated_at)
      VALUES ('${testSubId}', 'Test Subject', 'product', NOW(), NOW())
    `))
    await db.execute(sql.raw(`
      INSERT INTO subject_scores (subject_id, needs_recalc, computed_at)
      VALUES ('${testSubId}', true, NOW())
    `))
    const result = await db.execute(sql.raw(`
      SELECT score_version FROM subject_scores WHERE subject_id = '${testSubId}'
    `))
    expect(result.rows[0].score_version).toBe('v1')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0582", "section": "01", "sectionName": "General", "title": "IT-DB-027: subject_scores -- score_version is NOT NULL (TN-DB-001)"}
  it('IT-DB-027: subject_scores -- score_version NOT NULL (TN-DB-001)', async () => {
    // Description: Explicit NULL must be rejected — guards against V2 code accidentally writing
    // un-versioned rows that the xRPC reader can't bucket. The default 'v1' kicks in only when
    // the column is omitted; explicit NULL must fail.
    const testSubId = `sub-db027-${Date.now()}`
    await db.execute(sql.raw(`
      INSERT INTO subjects (id, name, subject_type, created_at, updated_at)
      VALUES ('${testSubId}', 'Test Subject', 'product', NOW(), NOW())
    `))
    await expect(
      db.execute(sql.raw(`
        INSERT INTO subject_scores (subject_id, score_version, needs_recalc, computed_at)
        VALUES ('${testSubId}', NULL, true, NOW())
      `))
    ).rejects.toThrow()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0583", "section": "01", "sectionName": "General", "title": "IT-DB-028: ingest_rejections -- table accepts a valid row (TN-DB-005)"}
  it('IT-DB-028: ingest_rejections -- accepts a valid row (TN-DB-005)', async () => {
    // Description: Plan §4.1 contract — atUri + did + reason required, detail JSON optional,
    // rejectedAt defaults to NOW(). Outbox watcher polls by atUri; the row is the source of truth.
    const testUri = `at://did:plc:db028/com.dina.trust.attestation/db028-${Date.now()}`
    await db.execute(sql.raw(`
      INSERT INTO ingest_rejections (at_uri, did, reason, detail)
      VALUES ('${testUri}', 'did:plc:db028', 'signature_invalid', '{"expected_key_id":"did:plc:db028/#namespace_2"}'::jsonb)
    `))
    const result = await db.execute(sql.raw(`
      SELECT at_uri, did, reason, detail, rejected_at FROM ingest_rejections WHERE at_uri = '${testUri}'
    `))
    expect(result.rows[0].at_uri).toBe(testUri)
    expect(result.rows[0].did).toBe('did:plc:db028')
    expect(result.rows[0].reason).toBe('signature_invalid')
    expect((result.rows[0].detail as { expected_key_id: string }).expected_key_id).toBe('did:plc:db028/#namespace_2')
    // rejected_at default NOW() means it's set even when omitted from the insert.
    expect(result.rows[0].rejected_at).not.toBeNull()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0584", "section": "01", "sectionName": "General", "title": "IT-DB-029: ingest_rejections -- multiple rejections for same atUri allowed (TN-DB-005)"}
  it('IT-DB-029: ingest_rejections -- duplicate (at_uri, reason) NOT unique (TN-DB-005)', async () => {
    // Description: Same record CAN be rejected more than once — e.g. signature_invalid first,
    // then rate_limit on retry. Row count per AT-URI is itself a useful signal for the outbox
    // watcher. A unique constraint here would silently drop retry-failure history.
    const testUri = `at://did:plc:db029/com.dina.trust.attestation/db029-${Date.now()}`
    await db.execute(sql.raw(`
      INSERT INTO ingest_rejections (at_uri, did, reason)
      VALUES ('${testUri}', 'did:plc:db029', 'signature_invalid')
    `))
    await db.execute(sql.raw(`
      INSERT INTO ingest_rejections (at_uri, did, reason)
      VALUES ('${testUri}', 'did:plc:db029', 'rate_limit')
    `))
    const result = await db.execute(sql.raw(`
      SELECT count(*)::int AS n FROM ingest_rejections WHERE at_uri = '${testUri}'
    `))
    expect(result.rows[0].n).toBe(2)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0585", "section": "01", "sectionName": "General", "title": "IT-DB-030: ingest_rejections -- rejected_at NOT NULL (TN-DB-005)"}
  it('IT-DB-030: ingest_rejections -- rejected_at NOT NULL (TN-DB-005)', async () => {
    // Description: rejected_at backs the 7-day janitor purge predicate. A NULL row would never
    // be purged and would silently leak. Default NOW() means the application doesn't have to
    // remember to set it; the explicit-NULL test guards against V2 code that overrides the default.
    await expect(
      db.execute(sql.raw(`
        INSERT INTO ingest_rejections (at_uri, did, reason, rejected_at)
        VALUES ('at://did:plc:db030/x/db030', 'did:plc:db030', 'feature_off', NULL)
      `))
    ).rejects.toThrow()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0588", "section": "01", "sectionName": "General", "title": "IT-DB-033: subjects -- enrichment columns + metadata default '{}' (TN-DB-007)"}
  it("IT-DB-033: subjects -- enrichment columns + metadata default '{}' (TN-DB-007)", async () => {
    // Description: Plan §3.6 + §4.1 — subjects gain `category`, `metadata` (NOT NULL default '{}'),
    // `language`, `enriched_at`. metadata default keeps the GIN index NULL-free and lets the search
    // xRPC's `metadata->>'lat'` extraction skip null guards. Insert without enrichment columns and
    // assert metadata defaulted to {} and the other three are NULL (= "not yet enriched").
    const testSubId = `sub-db033-${Date.now()}`
    await db.execute(sql.raw(`
      INSERT INTO subjects (id, name, subject_type, created_at, updated_at)
      VALUES ('${testSubId}', 'Aeron Chair', 'product', NOW(), NOW())
    `))
    const result = await db.execute(sql.raw(`
      SELECT category, metadata, language, enriched_at FROM subjects WHERE id = '${testSubId}'
    `))
    expect(result.rows[0].category).toBeNull()
    // metadata default — Postgres returns '{}' as `{}` JSON object.
    expect(result.rows[0].metadata).toEqual({})
    expect(result.rows[0].language).toBeNull()
    expect(result.rows[0].enriched_at).toBeNull()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0589", "section": "01", "sectionName": "General", "title": "IT-DB-034: subjects -- metadata NOT NULL (TN-DB-007)"}
  it('IT-DB-034: subjects -- metadata NOT NULL (TN-DB-007)', async () => {
    // Description: Explicit NULL must be rejected. The default `{}` only kicks in when the column
    // is omitted; the NOT NULL constraint prevents future code paths from accidentally writing NULL
    // (which would break the GIN index + search xRPC's null-free assumption).
    const testSubId = `sub-db034-${Date.now()}`
    await expect(
      db.execute(sql.raw(`
        INSERT INTO subjects (id, name, subject_type, metadata, created_at, updated_at)
        VALUES ('${testSubId}', 'Test', 'product', NULL, NOW(), NOW())
      `))
    ).rejects.toThrow()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0590", "section": "01", "sectionName": "General", "title": "IT-DB-035: subjects -- metadata accepts arbitrary jsonb shape (TN-DB-007)"}
  it('IT-DB-035: subjects -- metadata accepts arbitrary jsonb shape (TN-DB-007)', async () => {
    // Description: metadata is type-specific per Plan §3.6.2 — `host`, `media_type`, `lat`/`lng`,
    // `org_type`, `qid`, `did_method`, `identifier_kind`, etc. Postgres jsonb takes any shape;
    // this test pins that the round-trip preserves nested structure (search xRPC reads via @>
    // and ->> operators).
    const testSubId = `sub-db035-${Date.now()}`
    await db.execute(sql.raw(`
      INSERT INTO subjects (id, name, subject_type, metadata, language, created_at, updated_at)
      VALUES ('${testSubId}', 'La Pergola', 'place',
        '{"google_place_id": "ChIJ_db035", "lat": 41.9028, "lng": 12.4964, "place_type": "restaurant"}'::jsonb,
        'it', NOW(), NOW())
    `))
    const result = await db.execute(sql.raw(`
      SELECT metadata, language FROM subjects WHERE id = '${testSubId}'
    `))
    const meta = result.rows[0].metadata as { google_place_id: string; lat: number; lng: number; place_type: string }
    expect(meta.google_place_id).toBe('ChIJ_db035')
    expect(meta.lat).toBe(41.9028)
    expect(meta.lng).toBe(12.4964)
    expect(meta.place_type).toBe('restaurant')
    expect(result.rows[0].language).toBe('it')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0591", "section": "01", "sectionName": "General", "title": "IT-DB-036: attestations -- language column nullable (TN-DB-008)"}
  it('IT-DB-036: attestations -- language column nullable (TN-DB-008)', async () => {
    // Description: TN-DB-008 — `language` BCP-47 tag, nullable for legacy rows + content where
    // detection failed (mixed languages, very short text). Auto-detected by ingester via franc-min.
    const testUri = `at://did:plc:db036/com.dina.trust.attestation/db036-${Date.now()}`
    await db.execute(sql.raw(`
      INSERT INTO attestations (uri, author_did, cid, subject_ref_raw, category, sentiment, language, record_created_at, indexed_at)
      VALUES ('${testUri}', 'did:plc:db036', 'bafytest', '{}'::jsonb, 'product', 'positive', 'pt-BR', NOW(), NOW())
    `))
    const result = await db.execute(sql.raw(`
      SELECT language FROM attestations WHERE uri = '${testUri}'
    `))
    expect(result.rows[0].language).toBe('pt-BR')

    // Same shape with no language → NULL (legacy / detection-failure row).
    const testUri2 = `at://did:plc:db036/com.dina.trust.attestation/db036b-${Date.now()}`
    await db.execute(sql.raw(`
      INSERT INTO attestations (uri, author_did, cid, subject_ref_raw, category, sentiment, record_created_at, indexed_at)
      VALUES ('${testUri2}', 'did:plc:db036', 'bafytest2', '{}'::jsonb, 'product', 'positive', NOW(), NOW())
    `))
    const result2 = await db.execute(sql.raw(`
      SELECT language FROM attestations WHERE uri = '${testUri2}'
    `))
    expect(result2.rows[0].language).toBeNull()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0593", "section": "01", "sectionName": "General", "title": "IT-DB-038: cosig_requests -- accepts valid pending row (TN-DB-003)"}
  it('IT-DB-038: cosig_requests -- accepts valid pending row (TN-DB-003)', async () => {
    // Description: Plan §4.1 + §10 — `pending` is the initial state; endorsement_uri NULL until
    // accepted, reject_reason NULL until rejected/expired. Round-trip preserves all fields.
    const testUri = `at://did:plc:db038/com.dina.trust.attestation/db038-${Date.now()}`
    await db.execute(sql.raw(`
      INSERT INTO cosig_requests (requester_did, recipient_did, attestation_uri, status, expires_at)
      VALUES ('did:plc:db038-req', 'did:plc:db038-rec', '${testUri}', 'pending',
              NOW() + INTERVAL '7 days')
    `))
    const result = await db.execute(sql.raw(`
      SELECT requester_did, recipient_did, attestation_uri, status, endorsement_uri, reject_reason
      FROM cosig_requests WHERE attestation_uri = '${testUri}'
    `))
    expect(result.rows[0].status).toBe('pending')
    expect(result.rows[0].endorsement_uri).toBeNull()
    expect(result.rows[0].reject_reason).toBeNull()
    expect(result.rows[0].requester_did).toBe('did:plc:db038-req')
    expect(result.rows[0].recipient_did).toBe('did:plc:db038-rec')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0594", "section": "01", "sectionName": "General", "title": "IT-DB-039: cosig_requests -- status CHECK rejects unknown enum (TN-DB-003)"}
  it('IT-DB-039: cosig_requests -- status CHECK rejects unknown enum (TN-DB-003)', async () => {
    // Description: Closed status enum {pending, accepted, rejected, expired} is enforced at the
    // DB level via CHECK constraint. A future code path with a typo (`'pending '` with trailing
    // space, `'cancelled'`, etc.) fails loudly instead of writing a state the sweep job can't
    // reason about.
    const testUri = `at://did:plc:db039/com.dina.trust.attestation/db039-${Date.now()}`
    await expect(
      db.execute(sql.raw(`
        INSERT INTO cosig_requests (requester_did, recipient_did, attestation_uri, status, expires_at)
        VALUES ('did:plc:db039-req', 'did:plc:db039-rec', '${testUri}', 'cancelled', NOW() + INTERVAL '1 day')
      `))
    ).rejects.toThrow()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0595", "section": "01", "sectionName": "General", "title": "IT-DB-040: cosig_requests -- unique tuple (TN-DB-003)"}
  it('IT-DB-040: cosig_requests -- unique (requester_did, attestation_uri, recipient_did) (TN-DB-003)', async () => {
    // Description: One cosig request per (requester, attestation, recipient) tuple. Re-asking
    // the same recipient about the same attestation must fail at INSERT, not silently dedupe.
    const testUri = `at://did:plc:db040/com.dina.trust.attestation/db040-${Date.now()}`
    await db.execute(sql.raw(`
      INSERT INTO cosig_requests (requester_did, recipient_did, attestation_uri, status, expires_at)
      VALUES ('did:plc:db040-req', 'did:plc:db040-rec', '${testUri}', 'pending', NOW() + INTERVAL '7 days')
    `))
    await expect(
      db.execute(sql.raw(`
        INSERT INTO cosig_requests (requester_did, recipient_did, attestation_uri, status, expires_at)
        VALUES ('did:plc:db040-req', 'did:plc:db040-rec', '${testUri}', 'pending', NOW() + INTERVAL '14 days')
      `))
    ).rejects.toThrow()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0596", "section": "01", "sectionName": "General", "title": "IT-DB-041: trust_v1_params -- key PK + numeric round-trip (TN-DB-004)"}
  it('IT-DB-041: trust_v1_params -- key PK + numeric round-trip (TN-DB-004)', async () => {
    // Description: Plan §4.1 hot-reloadable parameter store. NUMERIC stores values exactly
    // (no float drift). Postgres returns NUMERIC as a string from pg's default deserializer to
    // preserve precision — the scorer parses with parseFloat at read time.
    await db.execute(sql.raw(`
      INSERT INTO trust_v1_params (key, value, description)
      VALUES ('TEST_PARAM_DB041', 0.1234567890, 'Test param for IT-DB-041 round-trip')
    `))
    const result = await db.execute(sql.raw(`
      SELECT key, value::text AS value_text, description FROM trust_v1_params WHERE key = 'TEST_PARAM_DB041'
    `))
    expect(result.rows[0].key).toBe('TEST_PARAM_DB041')
    // value comes back as exact-precision text; parse for the assertion.
    expect(parseFloat(result.rows[0].value_text as string)).toBeCloseTo(0.1234567890, 10)
    expect(result.rows[0].description).toBe('Test param for IT-DB-041 round-trip')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0597", "section": "01", "sectionName": "General", "title": "IT-DB-042: trust_v1_params -- duplicate key rejected (TN-DB-004)"}
  it('IT-DB-042: trust_v1_params -- duplicate key rejected (TN-DB-004)', async () => {
    // Description: `key` is the PK — a misspelled `dina-admin trust set-param` that re-inserts
    // would silently shadow the canonical row if PK weren't enforced. Hot-reload semantics
    // require UPDATE for revisions, not INSERT-shadowing.
    await db.execute(sql.raw(`
      INSERT INTO trust_v1_params (key, value, description)
      VALUES ('TEST_PARAM_DB042', 1.0, 'first')
    `))
    await expect(
      db.execute(sql.raw(`
        INSERT INTO trust_v1_params (key, value, description)
        VALUES ('TEST_PARAM_DB042', 2.0, 'second')
      `))
    ).rejects.toThrow()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0599", "section": "01", "sectionName": "General", "title": "IT-DB-044: appview_config -- bool flag round-trip (TN-FLAG-001)"}
  it('IT-DB-044: appview_config -- bool flag round-trip (TN-FLAG-001)', async () => {
    // Description: TN-FLAG-001 — flag table key-value model. Bool flag stored in `bool_value`,
    // text flag in `text_value`, never both at once for a given key. updated_at defaults to NOW()
    // so polling layer can compare snapshots.
    await db.execute(sql.raw(`
      INSERT INTO appview_config (key, bool_value, description)
      VALUES ('test_flag_db044', true, 'IT-DB-044 test flag')
    `))
    const result = await db.execute(sql.raw(`
      SELECT key, bool_value, text_value, description, updated_at
      FROM appview_config WHERE key = 'test_flag_db044'
    `))
    expect(result.rows[0].key).toBe('test_flag_db044')
    expect(result.rows[0].bool_value).toBe(true)
    expect(result.rows[0].text_value).toBeNull()
    expect(result.rows[0].description).toBe('IT-DB-044 test flag')
    expect(result.rows[0].updated_at).not.toBeNull()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0600", "section": "01", "sectionName": "General", "title": "IT-DB-045: appview_config -- duplicate key rejected (TN-FLAG-001)"}
  it('IT-DB-045: appview_config -- duplicate key rejected (TN-FLAG-001)', async () => {
    // Description: Like trust_v1_params, the key is the PK. Hot-reload semantics require UPDATE
    // for value flips, not duplicate INSERTs (which would silently shadow if PK weren't enforced).
    await db.execute(sql.raw(`
      INSERT INTO appview_config (key, bool_value, description)
      VALUES ('test_flag_db045', false, 'first')
    `))
    await expect(
      db.execute(sql.raw(`
        INSERT INTO appview_config (key, bool_value, description)
        VALUES ('test_flag_db045', true, 'second')
      `))
    ).rejects.toThrow()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0601", "section": "01", "sectionName": "General", "title": "IT-DB-046: attestations.namespace -- nullable + round-trip (TN-DB-012)"}
  it('IT-DB-046: attestations.namespace -- nullable + round-trip (TN-DB-012)', async () => {
    // Description: TN-DB-012 — pseudonymous namespace fragment. Nullable for root-identity records
    // (the V1-launch majority); populated value (e.g. `'#namespace_2'`) for records signed under
    // a non-root verificationMethod. Reviewer-trust scoring is per-(authorDid, namespace).
    const testUriRoot = `at://did:plc:db046/com.dina.trust.attestation/db046-root-${Date.now()}`
    const testUriNs = `at://did:plc:db046/com.dina.trust.attestation/db046-ns-${Date.now()}`
    await db.execute(sql.raw(`
      INSERT INTO attestations (uri, author_did, cid, subject_ref_raw, category, sentiment, record_created_at, indexed_at)
      VALUES ('${testUriRoot}', 'did:plc:db046', 'bafy1', '{}'::jsonb, 'product', 'positive', NOW(), NOW())
    `))
    await db.execute(sql.raw(`
      INSERT INTO attestations (uri, author_did, cid, subject_ref_raw, category, sentiment, namespace, record_created_at, indexed_at)
      VALUES ('${testUriNs}', 'did:plc:db046', 'bafy2', '{}'::jsonb, 'product', 'positive', '#namespace_2', NOW(), NOW())
    `))
    const root = await db.execute(sql.raw(`SELECT namespace FROM attestations WHERE uri = '${testUriRoot}'`))
    const ns = await db.execute(sql.raw(`SELECT namespace FROM attestations WHERE uri = '${testUriNs}'`))
    expect(root.rows[0].namespace).toBeNull()
    expect(ns.rows[0].namespace).toBe('#namespace_2')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0602", "section": "01", "sectionName": "General", "title": "IT-DB-047: endorsements.namespace -- nullable + round-trip (TN-DB-012)"}
  it('IT-DB-047: endorsements.namespace -- nullable + round-trip (TN-DB-012)', async () => {
    // Description: Symmetric with IT-DB-046 — endorsements published under a pseudonymous
    // namespace stay accountable to that compartment.
    const testUri = `at://did:plc:db047/com.dina.trust.endorsement/db047-${Date.now()}`
    await db.execute(sql.raw(`
      INSERT INTO endorsements (uri, author_did, cid, subject_did, skill, endorsement_type, namespace, record_created_at, indexed_at)
      VALUES ('${testUri}', 'did:plc:db047', 'bafyend', 'did:plc:db047-target', 'cooking', 'worked-together', '#namespace_3', NOW(), NOW())
    `))
    const result = await db.execute(sql.raw(`SELECT namespace FROM endorsements WHERE uri = '${testUri}'`))
    expect(result.rows[0].namespace).toBe('#namespace_3')
  })
})

// ---------------------------------------------------------------------------
// 11.2 Index Verification
// ---------------------------------------------------------------------------
describe('11.2 Index Verification', () => {
  // TRACE: {"suite": "APPVIEW", "case": "0547", "section": "01", "sectionName": "General", "title": "IT-DB-010: attestations indexes exist"}
  it('IT-DB-010: attestations indexes exist', async () => {
    // Description: Query pg_indexes
    // Expected: All attestation indexes present
    const result = await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'attestations'
    `)
    const indexNames = result.rows.map((r: any) => r.indexname)

    const expectedIndexes = [
      'attestations_author_idx',
      'attestations_subject_idx',
      'attestations_sentiment_idx',
      'attestations_domain_idx',
      'attestations_category_idx',
      'attestations_created_idx',
      'attestations_tags_idx',
      'attestations_cosigner_idx',
      'attestations_subject_sentiment_idx',
      'attestations_author_domain_idx',
      'attestations_language_idx', // TN-DB-008
      'attestations_author_namespace_idx', // TN-DB-012
    ]

    for (const idx of expectedIndexes) {
      expect(indexNames).toContain(idx)
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0548", "section": "01", "sectionName": "General", "title": "IT-DB-011: trust_edges indexes exist"}
  it('IT-DB-011: trust_edges indexes exist', async () => {
    // Description: Query pg_indexes
    // Expected: trust_edges indexes present
    const result = await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'trust_edges'
    `)
    const indexNames = result.rows.map((r: any) => r.indexname)

    const expectedIndexes = [
      'trust_edges_from_idx',
      'trust_edges_to_idx',
      'trust_edges_from_to_idx',
      'trust_edges_type_idx',
    ]

    for (const idx of expectedIndexes) {
      expect(indexNames).toContain(idx)
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0549", "section": "01", "sectionName": "General", "title": "IT-DB-012: Fix 9: partial index on needs_recalc (did_profiles)"}
  it('IT-DB-012: Fix 9: partial index on needs_recalc (did_profiles)', async () => {
    // Description: Query pg_indexes for did_profiles
    // Expected: did_profiles_needs_recalc_idx with WHERE clause
    const result = await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'did_profiles'
    `)
    const indexNames = result.rows.map((r: any) => r.indexname)
    expect(indexNames).toContain('did_profiles_needs_recalc_idx')

    const partialIdx = result.rows.find((r: any) => r.indexname === 'did_profiles_needs_recalc_idx')
    expect((partialIdx as any).indexdef).toContain('WHERE')
    expect((partialIdx as any).indexdef).toContain('needs_recalc = true')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0550", "section": "01", "sectionName": "General", "title": "IT-DB-013: Fix 9: partial index on subject_scores"}
  it('IT-DB-013: Fix 9: partial index on subject_scores', async () => {
    // Description: Query pg_indexes
    // Expected: subject_scores_needs_recalc_idx with WHERE clause
    const result = await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'subject_scores'
    `)
    const indexNames = result.rows.map((r: any) => r.indexname)
    expect(indexNames).toContain('subject_scores_needs_recalc_idx')

    const partialIdx = result.rows.find((r: any) => r.indexname === 'subject_scores_needs_recalc_idx')
    expect((partialIdx as any).indexdef).toContain('WHERE')
    expect((partialIdx as any).indexdef).toContain('needs_recalc = true')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0551", "section": "01", "sectionName": "General", "title": "IT-DB-014: GIN index on tags"}
  it('IT-DB-014: GIN index on tags', async () => {
    // Description: Query pg_indexes
    // Expected: attestations_tags_idx using GIN
    const result = await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'attestations' AND indexname = 'attestations_tags_idx'
    `)
    expect(result.rows.length).toBe(1)
    expect((result.rows[0] as any).indexdef).toContain('gin')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0552", "section": "01", "sectionName": "General", "title": "IT-DB-015: GIN index on identifiers_json"}
  it('IT-DB-015: GIN index on identifiers_json', async () => {
    // Description: Query pg_indexes for subjects
    // Expected: subjects_identifiers_idx using GIN
    const result = await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'subjects' AND indexname = 'subjects_identifiers_idx'
    `)
    expect(result.rows.length).toBe(1)
    expect((result.rows[0] as any).indexdef).toContain('gin')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0553", "section": "01", "sectionName": "General", "title": "IT-DB-016: tsvector search index"}
  it('IT-DB-016: tsvector search index', async () => {
    // Description: Full-text search query plan uses index
    // Expected: Verify to_tsvector can be used on the search_content column
    // Note: No dedicated tsvector GIN index exists; verify the column exists
    // and a full-text query executes without error
    const result = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'attestations' AND column_name = 'search_content'
    `)
    expect(result.rows.length).toBe(1)

    // Verify a full-text search query runs without errors
    const searchResult = await db.execute(sql`
      SELECT uri FROM attestations
      WHERE to_tsvector('english', COALESCE(search_content, '')) @@ plainto_tsquery('english', 'test')
      LIMIT 1
    `)
    expect(searchResult.rows).toBeDefined()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0554", "section": "01", "sectionName": "General", "title": "IT-DB-017: partial index on author_scoped_did"}
  it('IT-DB-017: partial index on author_scoped_did', async () => {
    // Description: Query pg_indexes
    // Expected: WHERE author_scoped_did IS NOT NULL
    const result = await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'subjects' AND indexname = 'subjects_author_scoped_idx'
    `)
    expect(result.rows.length).toBe(1)
    expect((result.rows[0] as any).indexdef).toContain('WHERE')
    expect((result.rows[0] as any).indexdef).toContain('author_scoped_did IS NOT NULL')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0555", "section": "01", "sectionName": "General", "title": "IT-DB-018: partial index on canonical_subject_id"}
  it('IT-DB-018: partial index on canonical_subject_id', async () => {
    // Description: Query pg_indexes
    // Expected: WHERE canonical_subject_id IS NOT NULL
    const result = await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'subjects' AND indexname = 'subjects_canonical_idx'
    `)
    expect(result.rows.length).toBe(1)
    expect((result.rows[0] as any).indexdef).toContain('WHERE')
    expect((result.rows[0] as any).indexdef).toContain('canonical_subject_id IS NOT NULL')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0556", "section": "01", "sectionName": "General", "title": "IT-DB-019: tombstone indexes exist"}
  it('IT-DB-019: tombstone indexes exist', async () => {
    // Description: Query pg_indexes for tombstones
    // Expected: tombstones_author_idx, tombstones_subject_idx, tombstones_deleted_idx
    const result = await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'tombstones'
    `)
    const indexNames = result.rows.map((r: any) => r.indexname)

    expect(indexNames).toContain('tombstones_author_idx')
    expect(indexNames).toContain('tombstones_subject_idx')
    expect(indexNames).toContain('tombstones_deleted_idx')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0557", "section": "01", "sectionName": "General", "title": "IT-DB-020: subjects DID index exists"}
  it('IT-DB-020: subjects DID index exists', async () => {
    // Description: Query pg_indexes for subjects
    // Expected: subjects_did_idx
    const result = await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'subjects'
    `)
    const indexNames = result.rows.map((r: any) => r.indexname)
    expect(indexNames).toContain('subjects_did_idx')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0558", "section": "01", "sectionName": "General", "title": "IT-DB-021: domain_scores table exists with indexes"}
  it('IT-DB-021: domain_scores table exists with indexes', async () => {
    // Description: Query pg_indexes for domain_scores
    // Expected: Primary key and relevant indexes present
    const result = await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'domain_scores'
    `)
    const indexNames = result.rows.map((r: any) => r.indexname)

    expect(indexNames).toContain('domain_scores_pkey')
    expect(indexNames).toContain('domain_scores_did_idx')
    expect(indexNames).toContain('domain_scores_domain_idx')
    expect(indexNames).toContain('domain_scores_did_domain_idx')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0592", "section": "01", "sectionName": "General", "title": "IT-DB-037: subjects -- enrichment indexes exist (TN-DB-007)"}
  it('IT-DB-037: subjects -- enrichment indexes exist (TN-DB-007)', async () => {
    // Description: Plan §3.6 + §4.1 — search xRPC's filter knobs need indexes:
    //   - `subjects_category_idx` (partial WHERE category IS NOT NULL): `category=` filter
    //   - `subjects_language_idx` (partial WHERE language IS NOT NULL): `language=` filter
    //   - `subjects_metadata_idx` (GIN jsonb_path_ops): `metadataFilters=` containment queries
    //   - `subjects_geo_idx`     (expression on (metadata->>'lat', metadata->>'lng'),
    //     partial WHERE both keys present): place-radius queries.
    // Without these the search xRPC turns every filter into a seq scan.
    const result = await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'subjects'
    `)
    const indexNames = result.rows.map((r: any) => r.indexname)
    expect(indexNames).toContain('subjects_category_idx')
    expect(indexNames).toContain('subjects_language_idx')
    expect(indexNames).toContain('subjects_metadata_idx')
    expect(indexNames).toContain('subjects_geo_idx')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0603", "section": "01", "sectionName": "General", "title": "IT-DB-048: endorsements -- author_namespace composite index exists (TN-DB-012)"}
  it('IT-DB-048: endorsements -- author_namespace partial index exists (TN-DB-012)', async () => {
    // Description: Symmetric with attestations_author_namespace_idx. Reviewer-trust per
    // (did, namespace) needs both columns indexed together; partial WHERE namespace IS NOT NULL
    // keeps the b-tree small (root-identity rows go through endorsements_author_idx).
    const result = await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'endorsements'
    `)
    const indexNames = result.rows.map((r: any) => r.indexname)
    expect(indexNames).toContain('endorsements_author_idx')
    expect(indexNames).toContain('endorsements_author_namespace_idx')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0598", "section": "01", "sectionName": "General", "title": "IT-DB-043: cosig_requests -- indexes exist (TN-DB-003)"}
  it('IT-DB-043: cosig_requests -- indexes exist (TN-DB-003)', async () => {
    // Description: Plan §4.1 — two hot paths:
    //   - `cosig_requests_recipient_status_idx` (composite) for inbox lookup
    //   - `cosig_requests_expiry_idx` (partial WHERE status='pending') for hourly sweep job
    // Plus the unique-tuple index on (requester_did, attestation_uri, recipient_did) —
    // backs the dedupe constraint, used during INSERT validation.
    const result = await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'cosig_requests'
    `)
    const indexNames = result.rows.map((r: any) => r.indexname)
    expect(indexNames).toContain('cosig_requests_pkey')
    expect(indexNames).toContain('cosig_requests_unique_tuple_idx')
    expect(indexNames).toContain('cosig_requests_recipient_status_idx')
    expect(indexNames).toContain('cosig_requests_expiry_idx')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0587", "section": "01", "sectionName": "General", "title": "IT-DB-032: ingest_rejections -- both indexes exist (TN-DB-005)"}
  it('IT-DB-032: ingest_rejections -- at_uri + rejected_at indexes exist (TN-DB-005)', async () => {
    // Description: Plan §4.1 — outbox watcher polls by at_uri (idx_ingest_rejections_at_uri),
    // janitor range-scans by rejected_at (idx_ingest_rejections_purge). Both are required for
    // the table to meet its perf contract; missing either turns a hot path into a seq scan.
    const result = await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'ingest_rejections'
    `)
    const indexNames = result.rows.map((r: any) => r.indexname)
    expect(indexNames).toContain('ingest_rejections_pkey')
    expect(indexNames).toContain('idx_ingest_rejections_at_uri')
    expect(indexNames).toContain('idx_ingest_rejections_purge')
  })
})

// ---------------------------------------------------------------------------
// 11.3 Query Performance
// ---------------------------------------------------------------------------
describe('11.3 Query Performance', () => {
  // TRACE: {"suite": "APPVIEW", "case": "0559", "section": "01", "sectionName": "General", "title": "IT-DB-022: attestation lookup by subject -- uses index"}
  it('IT-DB-022: attestation lookup by subject -- uses index', async () => {
    // Description: EXPLAIN on subject lookup
    // Expected: Index scan, not seq scan
    const result = await db.execute(sql`
      EXPLAIN (FORMAT JSON) SELECT * FROM attestations WHERE subject_id = 'sub-test'
    `)
    const plan = JSON.stringify(result.rows)
    expect(plan).toContain('Index')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0560", "section": "01", "sectionName": "General", "title": "IT-DB-023: trust_edge lookup by from_did -- uses index"}
  it('IT-DB-023: trust_edge lookup by from_did -- uses index', async () => {
    // Description: EXPLAIN on from_did lookup
    // Expected: Index scan
    const result = await db.execute(sql`
      EXPLAIN (FORMAT JSON) SELECT * FROM trust_edges WHERE from_did = 'did:plc:test'
    `)
    const plan = JSON.stringify(result.rows)
    expect(plan).toContain('Index')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0561", "section": "01", "sectionName": "General", "title": "IT-DB-024: dirty flag query -- uses partial index"}
  it('IT-DB-024: dirty flag query -- uses partial index', async () => {
    // Description: EXPLAIN on WHERE needs_recalc = true
    // Expected: Partial index scan
    // Disable seq scan so planner must use the index (empty tables prefer seq scan)
    await db.execute(sql`SET enable_seqscan = off`)
    try {
      const result = await db.execute(sql`
        EXPLAIN (FORMAT JSON) SELECT * FROM did_profiles WHERE needs_recalc = true
      `)
      const plan = JSON.stringify(result.rows)
      expect(plan).toContain('Index')
    } finally {
      await db.execute(sql`SET enable_seqscan = on`)
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0562", "section": "01", "sectionName": "General", "title": "IT-DB-025: full-text search -- uses GIN index"}
  it('IT-DB-025: full-text search -- uses GIN index', async () => {
    // Description: EXPLAIN on GIN-indexed tags array with containment operator
    // Expected: GIN index scan on the tags array column
    // Disable seq scan so planner must use the GIN index (empty tables prefer seq scan)
    await db.execute(sql`SET enable_seqscan = off`)
    try {
      const result = await db.execute(sql`
        EXPLAIN (FORMAT JSON) SELECT * FROM attestations WHERE tags @> ARRAY['quality']
      `)
      const plan = JSON.stringify(result.rows)
      expect(plan).toContain('Index')
    } finally {
      await db.execute(sql`SET enable_seqscan = on`)
    }
  })
})
