import { eq, sql } from 'drizzle-orm'
import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { Attestation } from '@/shared/types/lexicon-types.js'
import { attestations, mentionEdges, subjects, trustEdges } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'
import { addTrustEdge } from '../trust-edge-sync.js'
import { detectLanguage } from '../language-detect.js'
import { resolveOrCreateSubject } from '@/db/queries/subjects.js'
import { markDirty } from '@/db/queries/dirty-flags.js'
import { readCachedTrustV1Params } from '@/scorer/trust-v1-params-reader.js'

/**
 * Handler for com.dina.trust.attestation records.
 *
 * Attestations are the core trust primitive — a structured review
 * of a subject (person, product, content, etc.). This is the most complex
 * handler because it touches subjects, mention edges, trust edges,
 * and dirty flags.
 */
export const attestationHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as Attestation

    // Resolve or create the subject
    const subjectId = await resolveOrCreateSubject(ctx.db, record.subject, op.did)

    // Build search content from available text fields
    const searchParts: string[] = []
    if (record.text) searchParts.push(record.text)
    if (record.subject.name) searchParts.push(record.subject.name)
    if (record.tags) searchParts.push(...record.tags)
    if (record.category) searchParts.push(record.category)
    if (record.domain) searchParts.push(record.domain)
    const searchContent = searchParts.join(' ').slice(0, 10_000) || null

    // Extract co-signature info
    const hasCosignature = record.coSignature != null
    const cosignerDid = record.coSignature?.did ?? null

    // Extract mentions for edges
    const mentions = record.mentions ?? []

    // Pseudonymous-namespace fragment (TN-DB-012). Stored verbatim;
    // signature verification against the referenced verificationMethod
    // is the ingester gate's job (TN-ING-003).
    const namespace = record.namespace ?? null

    // TN-V2-REV-001..004 — optional reviewer-declared metadata.
    // Tag-array fields collapse `[]` → NULL so the GIN indexes
    // don't carry zero-length rows. `lastUsedMs` is wire-format
    // integer ms (CBOR-clean); converted once at write time so
    // search/scorer queries use ordinary date arithmetic instead of
    // re-deriving from epoch ms on every read.
    const useCases = record.useCases && record.useCases.length > 0 ? record.useCases : null
    const lastUsedAt = record.lastUsedMs != null ? new Date(record.lastUsedMs) : null
    const reviewerExperience = record.reviewerExperience ?? null
    const recommendFor = record.recommendFor && record.recommendFor.length > 0 ? record.recommendFor : null
    const notRecommendFor = record.notRecommendFor && record.notRecommendFor.length > 0 ? record.notRecommendFor : null
    const alternatives = record.alternatives && record.alternatives.length > 0 ? record.alternatives : null
    const compliance = record.compliance && record.compliance.length > 0 ? record.compliance : null
    const accessibility = record.accessibility && record.accessibility.length > 0 ? record.accessibility : null
    const compat = record.compat && record.compat.length > 0 ? record.compat : null

    // TN-V2-META-002 — reviewer-declared price range. Wire is a
    // single object; storage is 4 columns (denormalised so RANK-002's
    // range predicate uses integer comparisons against a partial
    // composite b-tree, not JSONB path traversal). The 4 columns are
    // tied together: present-as-a-group on insert, NULL-as-a-group
    // when the reviewer didn't declare a price. `lastSeenMs` (CBOR-
    // clean ms integer) converts to a Postgres `timestamp` once at
    // write time, same pattern as `lastUsedMs` → `lastUsedAt`.
    const priceLowE7 = record.price ? record.price.low_e7 : null
    const priceHighE7 = record.price ? record.price.high_e7 : null
    const priceCurrency = record.price ? record.price.currency : null
    const priceLastSeenAt = record.price ? new Date(record.price.lastSeenMs) : null

    // TN-V2-META-001 — availability sub-fields. Each empty array
    // collapses to NULL so the GIN indexes don't carry zero-length
    // rows (mirrors the compliance / compat handler treatment).
    // Each sub-field is independently optional within the
    // `availability` object — a reviewer who only knows regions
    // doesn't have to invent a soldAt list.
    const availabilityRegions = record.availability?.regions && record.availability.regions.length > 0
      ? record.availability.regions
      : null
    const availabilityShipsTo = record.availability?.shipsTo && record.availability.shipsTo.length > 0
      ? record.availability.shipsTo
      : null
    const availabilitySoldAt = record.availability?.soldAt && record.availability.soldAt.length > 0
      ? record.availability.soldAt
      : null

    // TN-V2-META-004 — schedule. Heterogeneous JSONB blob; collapse
    // to NULL when ALL sub-fields are absent (`{}` carries no
    // information and would mask a future "schedule declared?"
    // query). A partially-populated schedule (e.g. only `leadDays`)
    // is preserved as-is.
    const scheduleJson = record.schedule
      && (
        record.schedule.hours !== undefined
        || record.schedule.leadDays !== undefined
        || record.schedule.seasonal !== undefined
      )
      ? record.schedule
      : null

    // Language detection (TN-ING-008 / Plan §3.6). Run on the most
    // signal-rich text first (`record.text`); fall back to the subject
    // name when text is absent OR an empty string (`text: ""` is valid
    // per Zod — `??` would keep the empty value, so use a non-empty
    // chooser). Returns null when input is too short for franc-min to
    // classify reliably; the search xRPC's `language=` filter then
    // leaves these rows out of the bucket. Detection is pure +
    // synchronous (no I/O, ~1–2 ms per call), so we run it
    // unconditionally — caching by record CID would only matter at
    // ingest rates we don't see in practice.
    const detectionInput =
      record.text && record.text.trim().length > 0
        ? record.text
        : (record.subject.name ?? null)
    const language = detectLanguage(detectionInput)

    // Upsert the attestation record. TN-OBS-002: stamp trace_id from
    // the dispatcher so this row is joinable with the ingest log
    // line by trace. Update path deliberately does NOT overwrite an
    // existing trace_id — the original ingest's trace stays canonical
    // for that record's lifecycle.
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
      hasCosignature,
      cosignerDid,
      dimensionsJson: record.dimensions ?? null,
      interactionContextJson: record.interactionContext ?? null,
      contentContextJson: record.contentContext ?? null,
      productContextJson: record.productContext ?? null,
      evidenceJson: record.evidence ?? null,
      mentionsJson: mentions.length > 0 ? mentions : null,
      relatedAttestationsJson: record.relatedAttestations ?? null,
      bilateralReviewJson: record.bilateralReview ?? null,
      tags: record.tags ?? null,
      text: record.text ?? null,
      searchContent,
      language,
      namespace,
      useCases,
      lastUsedAt,
      reviewerExperience,
      recommendFor,
      notRecommendFor,
      alternativesJson: alternatives,
      compliance,
      accessibility,
      compat,
      priceLowE7,
      priceHighE7,
      priceCurrency,
      priceLastSeenAt,
      availabilityRegions,
      availabilityShipsTo,
      availabilitySoldAt,
      scheduleJson,
      traceId: op.traceId ?? null,
      recordCreatedAt: new Date(record.createdAt),
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
        hasCosignature,
        cosignerDid,
        dimensionsJson: record.dimensions ?? null,
        interactionContextJson: record.interactionContext ?? null,
        contentContextJson: record.contentContext ?? null,
        productContextJson: record.productContext ?? null,
        evidenceJson: record.evidence ?? null,
        mentionsJson: mentions.length > 0 ? mentions : null,
        relatedAttestationsJson: record.relatedAttestations ?? null,
        bilateralReviewJson: record.bilateralReview ?? null,
        tags: record.tags ?? null,
        text: record.text ?? null,
        searchContent,
        language,
        namespace,
        useCases,
        lastUsedAt,
        reviewerExperience,
        recommendFor,
        notRecommendFor,
        alternativesJson: alternatives,
        compliance,
        accessibility,
        compat,
        priceLowE7,
        priceHighE7,
        priceCurrency,
        priceLastSeenAt,
        availabilityRegions,
        availabilityShipsTo,
        availabilitySoldAt,
        scheduleJson,
        recordCreatedAt: new Date(record.createdAt),
        indexedAt: new Date(),
      },
    })

    // TN-V2-META-011 — bump the subject's `last_active_at` to the
    // greater of (existing, this attestation's recordCreatedAt).
    // GREATEST skips NULL inputs in Postgres, so a fresh subject
    // (NULL) gets the new value; a backdated replay (older than
    // existing) leaves the column unchanged. Only fires on create
    // — `handleDelete` is a soft signal (someone retracted) and
    // intentionally doesn't reset the freshness clock.
    const recordCreatedAt = new Date(record.createdAt)
    await ctx.db.update(subjects)
      .set({ lastActiveAt: sql`GREATEST(${subjects.lastActiveAt}, ${recordCreatedAt.toISOString()}::timestamp)` })
      .where(eq(subjects.id, subjectId))

    // MED-12: Delete old mention edges before inserting new set (atomic per source URI)
    await ctx.db.delete(mentionEdges).where(eq(mentionEdges.sourceUri, op.uri))
    for (const mention of mentions) {
      await ctx.db.insert(mentionEdges).values({
        sourceUri: op.uri,
        sourceDid: op.did,
        targetDid: mention.did,
        role: mention.role ?? null,
        recordType: 'attestation',
        createdAt: new Date(record.createdAt),
      }).onConflictDoNothing()
    }

    // HIGH-10 fix: Always remove old trust edge for this URI first, then
    // conditionally re-add. Prevents stale edges when sentiment changes
    // from positive to non-positive on update.
    await ctx.db.delete(trustEdges).where(eq(trustEdges.sourceUri, op.uri))

    // Add trust edge only for positive attestations of DID subjects (HIGH-07)
    if (record.sentiment === 'positive' && record.subject.type === 'did' && record.subject.did) {
      await addTrustEdge(ctx, {
        fromDid: op.did,
        toDid: record.subject.did,
        edgeType: 'positive-attestation',
        domain: record.domain ?? null,
        weight: 0.3,
        sourceUri: op.uri,
        createdAt: new Date(record.createdAt),
      })
    }

    // Mark affected entities for score recalculation. TN-SCORE-008
    // (Plan §13.7): pass the operator-tunable HOT_SUBJECT_THRESHOLD
    // so subjects with `total_attestations` exceeding it skip the
    // incremental dirty flip — the nightly batch handles them. The
    // params reader has a 60s cache so this lookup is effectively
    // free on the hot path. Other handlers' markDirty call sites
    // (vouches, reactions, delegations) write to subjects far less
    // frequently than attestation creation, so the gate lives here
    // first; the rest can be added when their fan-in matters.
    const trustParams = await readCachedTrustV1Params(ctx.db)
    await markDirty(ctx.db, {
      subjectId,
      authorDid: op.did,
      mentionedDids: mentions,
      subjectDid: record.subject.type === 'did' ? record.subject.did : undefined,
      cosignerDid,
      hotSubjectThreshold: trustParams.HOT_SUBJECT_THRESHOLD,
    })

    ctx.metrics.incr('ingester.attestation.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await deletionHandler.process(ctx.db, op.uri, op.did, 'attestation', attestations)
    ctx.metrics.incr('ingester.attestation.deleted')
  },
}
