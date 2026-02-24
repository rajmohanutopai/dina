import { eq, and } from 'drizzle-orm'
import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { Revocation } from '@/shared/types/lexicon-types.js'
import { revocations, attestations } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'

/**
 * Handler for com.dina.reputation.revocation records.
 *
 * A revocation allows an author to formally retract a previous attestation.
 * In addition to inserting the revocation record, we mark the target
 * attestation as revoked (if it exists and belongs to the same author).
 */
export const revocationHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as Revocation

    // Upsert the revocation record
    await ctx.db.insert(revocations).values({
      uri: op.uri,
      authorDid: op.did,
      cid: op.cid!,
      targetUri: record.targetUri,
      reason: record.reason,
      recordCreatedAt: new Date(record.createdAt),
    }).onConflictDoUpdate({
      target: revocations.uri,
      set: {
        cid: op.cid!,
        targetUri: record.targetUri,
        reason: record.reason,
        recordCreatedAt: new Date(record.createdAt),
        indexedAt: new Date(),
      },
    })

    // Mark the target attestation as revoked (author can only revoke own records)
    await ctx.db.update(attestations)
      .set({
        isRevoked: true,
        revokedByUri: op.uri,
      })
      .where(and(
        eq(attestations.uri, record.targetUri),
        eq(attestations.authorDid, op.did),
      ))

    ctx.metrics.incr('ingester.revocation.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await deletionHandler.process(ctx.db, op.uri, op.did, 'revocation', revocations)
    ctx.metrics.incr('ingester.revocation.deleted')
  },
}
