import { eq, isNull, lt, or, sql } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { subjects } from '@/db/schema/index.js'
import {
  enrichSubject,
  type SubjectEnrichment,
  type SubjectRef,
  type SubjectType,
} from '@/util/subject_enrichment.js'
import { detectLanguage } from '@/ingester/language-detect.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

/**
 * Re-enrich-staleness window. A subject's `category` / `metadata` /
 * `language` are recomputed at least once a week so heuristic-map
 * updates (a new entry in `host_category.ts`, a fresh entry in
 * `category_keywords.ts` lookup) propagate within seven days without
 * a hand-rolled backfill. Plan §3.6.4 documents this cadence.
 *
 * Tunable as a constant rather than a flag — operators rarely need
 * to change it, and a single source of truth makes "did the weekly
 * tick run today?" debugging trivial.
 */
const REENRICH_AGE_DAYS = 7

/**
 * Per-run cap on the number of subjects re-enriched. The composer
 * itself is pure (~µs per call), but the per-row UPDATE is the cost
 * — at ~1 ms each, 10k rows is ~10 s of DB time per tick. Plenty
 * of headroom under a weekly cadence; if the corpus grows past 10k
 * stale rows per week the warn-log will surface it and ops can
 * either tune the cadence or run multiple manual passes.
 */
const MAX_REENRICH_PER_RUN = 10_000

/**
 * `subject_enrich_recompute` — weekly batch job (TN-ENRICH-006 / Plan §3.6.4).
 *
 * Re-runs `enrichSubject()` (TN-ENRICH-005) + `detectLanguage()`
 * (TN-ING-008) over subjects whose `enriched_at` is NULL or older
 * than `REENRICH_AGE_DAYS`. Updates `category`, `metadata`,
 * `language`, `enriched_at` per row in a single UPDATE. Idempotent
 * — running twice in a row leaves the table at the same state plus
 * an advanced `enriched_at`.
 *
 * **Why a weekly batch in addition to inline enrichment** (TN-ING-007
 * runs the composer on every new subject create): heuristic maps
 * evolve. When the curator adds `etsy.com → product` to
 * `host_category.ts` and ships, every existing subject that was
 * referencing `etsy.com` was created BEFORE the entry existed and
 * therefore has the wrong `category`. Without the weekly recompute,
 * those subjects stay incorrectly categorised forever. The weekly
 * batch closes the staleness window at one week, post-deploy.
 *
 * **Schedule**: Sunday 02:00 UTC — off-peak, before the daily
 * decay (03:00), cleanup (04:00), and orphan-GC (05:00). Three
 * hours of headroom in either direction, no scheduler collision.
 *
 * **Per-run cap = 10k** bounds tick load; with the ~1 ms per UPDATE
 * cost, an upper bound of ~10 s per tick stays well under the
 * scheduler's per-job timeout.
 *
 * **Pure-data composer + small per-row UPDATE** — the composer
 * runs without I/O on the JSON shape, so we don't batch reads with
 * a transaction; each subject's UPDATE is independent. Failure of
 * one row's UPDATE doesn't block others. The per-row try/catch
 * surfaces failures via `metrics.counter('scorer.enrich_recompute.errors')`
 * without aborting the batch.
 */
export async function subjectEnrichRecompute(db: DrizzleDB): Promise<void> {
  const cutoff = new Date(Date.now() - REENRICH_AGE_DAYS * 24 * 60 * 60 * 1000)

  // Phase 1 — select stale rows. NULL `enriched_at` means "never
  // enriched" (legacy row pre-dating TN-ENRICH-006 OR a future failed
  // ingest path that didn't set the column). We treat both as stale.
  const staleRows = await db
    .select({
      id: subjects.id,
      name: subjects.name,
      subjectType: subjects.subjectType,
      did: subjects.did,
      identifiersJson: subjects.identifiersJson,
    })
    .from(subjects)
    .where(or(isNull(subjects.enrichedAt), lt(subjects.enrichedAt, cutoff)))
    .limit(MAX_REENRICH_PER_RUN)

  if (staleRows.length === 0) {
    logger.debug('subject-enrich-recompute: no stale subjects')
    metrics.counter('scorer.enrich_recompute.updated', 0)
    return
  }

  let updated = 0
  let errors = 0
  for (const row of staleRows) {
    try {
      await enrichRow(db, row)
      updated++
    } catch (err) {
      errors++
      logger.error(
        { err, subjectId: row.id },
        'subject-enrich-recompute: failed to re-enrich subject',
      )
    }
  }

  logger.info(
    { updated, errors, total: staleRows.length },
    'subject-enrich-recompute: batch complete',
  )
  metrics.counter('scorer.enrich_recompute.updated', updated)
  if (errors > 0) {
    metrics.counter('scorer.enrich_recompute.errors', errors)
  }

  if (staleRows.length >= MAX_REENRICH_PER_RUN) {
    logger.warn(
      { cap: MAX_REENRICH_PER_RUN },
      'subject-enrich-recompute: hit per-run cap, more stale subjects pending',
    )
    metrics.counter('scorer.enrich_recompute.cap_hit', 1)
  }
}

/**
 * Single-subject re-enrich path — called by the
 * `dina-admin trust enrich --subject-id <id>` CLI (TN-ENRICH-007) and
 * available as a library function for the API to call when an admin
 * forces a recompute outside the weekly cadence.
 *
 * Returns `{updated: true}` when the row was found + updated;
 * `{updated: false, reason: 'not_found'}` when no row matches.
 */
export async function enrichSingleSubject(
  db: DrizzleDB,
  subjectId: string,
): Promise<{ updated: boolean; reason?: 'not_found' }> {
  const rows = await db
    .select({
      id: subjects.id,
      name: subjects.name,
      subjectType: subjects.subjectType,
      did: subjects.did,
      identifiersJson: subjects.identifiersJson,
    })
    .from(subjects)
    .where(eq(subjects.id, subjectId))
    .limit(1)

  const row = rows[0]
  if (!row) {
    return { updated: false, reason: 'not_found' }
  }

  await enrichRow(db, row)
  return { updated: true }
}

/**
 * Shared per-row enrich path used by both `subjectEnrichRecompute`
 * (batch) and `enrichSingleSubject` (CLI / on-demand). Builds the
 * `SubjectRef` from the row, runs the heuristic composer + language
 * detector, and applies the UPDATE. Throws on DB error so the batch
 * caller can record per-row failures without aborting the loop.
 */
async function enrichRow(db: DrizzleDB, row: StaleSubjectRow): Promise<void> {
  const ref = subjectRefFromRow(row)
  const enrichment = enrichSubject(ref)
  const language = detectLanguage(row.name)
  await applyEnrichment(db, row.id, enrichment, language)
}

interface StaleSubjectRow {
  id: string
  name: string
  subjectType: string
  did: string | null
  identifiersJson: unknown
}

/**
 * Build a `SubjectRef` (the input shape `enrichSubject` expects)
 * from a persisted subject row. The DB stores identifiers in a
 * normalised `identifiers_json` array of `[{uri: ...}, {id: ...}]`
 * shape; we extract the first `uri` and first `id` entries to feed
 * back to the heuristic enricher.
 *
 * **Why we don't trust `subjectType` blindly**: the column is
 * declared `text`, not a closed enum, so older rows could in theory
 * carry an unmapped value. We narrow defensively — anything outside
 * the documented `SubjectType` set falls through to `'claim'` (the
 * catch-all bucket whose enricher does nothing harmful and just
 * keeps `category = 'claim'`). Better than throwing inside the
 * job and aborting the batch.
 */
function subjectRefFromRow(row: StaleSubjectRow): SubjectRef {
  const identifiers = Array.isArray(row.identifiersJson)
    ? (row.identifiersJson as Array<Record<string, string>>)
    : []
  const uri = identifiers.find((e) => 'uri' in e)?.uri
  const identifier = identifiers.find((e) => 'id' in e)?.id

  return {
    type: narrowSubjectType(row.subjectType),
    did: row.did ?? undefined,
    uri,
    name: row.name,
    identifier,
  }
}

const KNOWN_SUBJECT_TYPES: ReadonlySet<SubjectType> = new Set([
  'did',
  'content',
  'product',
  'dataset',
  'organization',
  'claim',
  'place',
])

function narrowSubjectType(t: string): SubjectType {
  return KNOWN_SUBJECT_TYPES.has(t as SubjectType) ? (t as SubjectType) : 'claim'
}

/**
 * Apply an enrichment result to a subject row. Bumps `enriched_at`
 * to NOW() so the next weekly tick will skip this row until the
 * staleness window elapses again.
 *
 * `metadata` is JSONB-cast at the wire boundary so Drizzle binds it
 * correctly; pre-stringifying matches the inline-enrich path in
 * `db/queries/subjects.ts:resolveOrCreateSubject`.
 */
async function applyEnrichment(
  db: DrizzleDB,
  subjectId: string,
  enrichment: SubjectEnrichment,
  language: string | null,
): Promise<void> {
  // Single timestamp shared across `enriched_at` + `updated_at` so
  // the wire payload reflects one logical "row enriched at T" event
  // — pollers comparing `max(updated_at)` against snapshot times see
  // a coherent value.
  const now = new Date()
  await db
    .update(subjects)
    .set({
      category: enrichment.category,
      metadata: sql`${JSON.stringify(enrichment.metadata)}::jsonb`,
      language,
      enrichedAt: now,
      updatedAt: now,
    })
    .where(eq(subjects.id, subjectId))
}

/**
 * Test-only helper exposing the row → ref translator so the unit
 * test can pin its contract without driving the full job. Not
 * exported in production code paths — keeps the callable API
 * narrow.
 */
export const __testInternals = { subjectRefFromRow, narrowSubjectType }
