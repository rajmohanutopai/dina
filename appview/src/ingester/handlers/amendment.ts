import { eq, and } from 'drizzle-orm'
import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { Amendment } from '@/shared/types/lexicon-types.js'
import { amendments, attestations } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'

/**
 * Handler for com.dina.reputation.amendment records.
 *
 * Amendments modify existing attestations (corrections, updates, retractions).
 * On create, the handler upserts the amendment record and also marks the
 * target attestation as amended with a back-reference to this amendment URI.
 */
export const amendmentHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as Amendment

    // Upsert the amendment record
    await ctx.db.insert(amendments).values({
      uri: op.uri,
      authorDid: op.did,
      cid: op.cid!,
      targetUri: record.targetUri,
      amendmentType: record.amendmentType,
      text: record.text ?? null,
      newValuesJson: record.newValues ?? null,
      recordCreatedAt: new Date(record.createdAt),
    }).onConflictDoUpdate({
      target: amendments.uri,
      set: {
        cid: op.cid!,
        targetUri: record.targetUri,
        amendmentType: record.amendmentType,
        text: record.text ?? null,
        newValuesJson: record.newValues ?? null,
        recordCreatedAt: new Date(record.createdAt),
      },
    })

    // Mark the target attestation as amended (only if authored by same DID)
    await ctx.db.update(attestations)
      .set({
        isAmended: true,
        latestAmendmentUri: op.uri,
      })
      .where(and(
        eq(attestations.uri, record.targetUri),
        eq(attestations.authorDid, op.did),
      ))

    ctx.metrics.incr('ingester.amendment.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await deletionHandler.process(ctx.db, op.uri, op.did, 'amendment', amendments)
    ctx.metrics.incr('ingester.amendment.deleted')
  },
}
