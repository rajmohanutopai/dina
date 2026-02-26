import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { Attestation } from '@/shared/types/lexicon-types.js'
import { attestations, mentionEdges } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'
import { addTrustEdge } from '../trust-edge-sync.js'
import { resolveOrCreateSubject } from '@/db/queries/subjects.js'
import { markDirty } from '@/db/queries/dirty-flags.js'

/**
 * Handler for com.dina.reputation.attestation records.
 *
 * Attestations are the core reputation primitive — a structured review
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

    // Upsert the attestation record
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
        recordCreatedAt: new Date(record.createdAt),
        indexedAt: new Date(),
      },
    })

    // Upsert mention edges (idempotent via unique constraint)
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

    // Mark affected entities for score recalculation
    await markDirty(ctx.db, {
      subjectId,
      authorDid: op.did,
      mentionedDids: mentions,
      subjectDid: record.subject.type === 'did' ? record.subject.did : undefined,
      cosignerDid,
    })

    ctx.metrics.incr('ingester.attestation.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await deletionHandler.process(ctx.db, op.uri, op.did, 'attestation', attestations)
    ctx.metrics.incr('ingester.attestation.deleted')
  },
}
