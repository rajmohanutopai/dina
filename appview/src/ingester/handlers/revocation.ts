import { eq, and } from 'drizzle-orm'
import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { Revocation } from '@/shared/types/lexicon-types.js'
import { revocations, attestations } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'
import { markDirty } from '@/db/queries/dirty-flags.js'

/**
 * Handler for com.dina.trust.revocation records.
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

    // HIGH-12: Mark affected entities dirty for score recalculation
    // Fetch attestation author to mark them dirty too
    const att = await ctx.db.select({ authorDid: attestations.authorDid })
      .from(attestations).where(eq(attestations.uri, record.targetUri)).limit(1)
    const dirtyDids: string[] = [op.did]
    if (att[0]?.authorDid) dirtyDids.push(att[0].authorDid)
    for (const did of dirtyDids) {
      await markDirty(ctx.db, { subjectId: null, authorDid: did })
    }

    ctx.metrics.incr('ingester.revocation.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    // HIGH-11: Before deleting, find which attestation this revocation targeted
    const rev = await ctx.db.select({ targetUri: revocations.targetUri })
      .from(revocations).where(eq(revocations.uri, op.uri)).limit(1)

    await deletionHandler.process(ctx.db, op.uri, op.did, 'revocation', revocations)

    // Recompute isRevoked: check if any OTHER revocations target same attestation
    if (rev[0]?.targetUri) {
      const remaining = await ctx.db.select({ uri: revocations.uri })
        .from(revocations).where(eq(revocations.targetUri, rev[0].targetUri)).limit(1)
      if (remaining.length === 0) {
        await ctx.db.update(attestations)
          .set({ isRevoked: false, revokedByUri: null })
          .where(eq(attestations.uri, rev[0].targetUri))
      }
    }

    // HIGH-12: Mark dirty for score recalculation
    await markDirty(ctx.db, { subjectId: null, authorDid: op.did })

    ctx.metrics.incr('ingester.revocation.deleted')
  },
}
