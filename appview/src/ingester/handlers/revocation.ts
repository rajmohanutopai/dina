import { eq, and } from 'drizzle-orm'
import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { Revocation } from '@/shared/types/lexicon-types.js'
import type { DrizzleDB } from '@/db/connection.js'
import { revocations, attestations } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'
import { markDirty } from '@/db/queries/dirty-flags.js'

/**
 * Handler for com.dinakernel.peerlens.revocation records.
 *
 * A revocation allows an author to formally retract a previous attestation.
 * In addition to inserting the revocation record, we mark the target
 * attestation as revoked (if it exists and belongs to the same author).
 */
export const revocationHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as Revocation

    // Wrap revocation upsert + attestation isRevoked flip + dirty
    // flags in one transaction. Without it, a crash between the
    // upsert and the attestation update would leave a revocation
    // pointing at an attestation that still reads as active —
    // search/feed surfaces would surface a row the author thought
    // they retracted.
    await ctx.db.transaction(async (tx) => {
      const txDb = tx as unknown as DrizzleDB

      await tx.insert(revocations).values({
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

      // Mark the target attestation as revoked (author can only revoke own records).
      await tx.update(attestations)
        .set({
          isRevoked: true,
          revokedByUri: op.uri,
        })
        .where(and(
          eq(attestations.uri, record.targetUri),
          eq(attestations.authorDid, op.did),
        ))

      // HIGH-12: Mark affected entities dirty for score recalculation.
      // The author lookup runs through `tx` so the read sees the
      // freshly-flipped row (if needed by future logic).
      const att = await tx.select({ authorDid: attestations.authorDid })
        .from(attestations).where(eq(attestations.uri, record.targetUri)).limit(1)
      const dirtyDids: string[] = [op.did]
      if (att[0]?.authorDid) dirtyDids.push(att[0].authorDid)
      for (const did of dirtyDids) {
        await markDirty(txDb, { subjectId: null, authorDid: did })
      }
    })

    ctx.metrics.incr('ingester.revocation.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    // Wrap select-before-delete + delete + isRevoked unflip + dirty
    // flag in one transaction. Without it, a crash between the
    // deletionHandler and the isRevoked recompute would leave an
    // attestation marked revoked despite no active revocation row.
    await ctx.db.transaction(async (tx) => {
      const txDb = tx as unknown as DrizzleDB

      // HIGH-11: Before deleting, find which attestation this revocation targeted.
      const rev = await tx.select({ targetUri: revocations.targetUri })
        .from(revocations).where(eq(revocations.uri, op.uri)).limit(1)

      await deletionHandler.process(txDb, op.uri, op.did, 'revocation', revocations)

      // Recompute isRevoked: check if any OTHER revocations target same attestation.
      if (rev[0]?.targetUri) {
        const remaining = await tx.select({ uri: revocations.uri })
          .from(revocations).where(eq(revocations.targetUri, rev[0].targetUri)).limit(1)
        if (remaining.length === 0) {
          await tx.update(attestations)
            .set({ isRevoked: false, revokedByUri: null })
            .where(eq(attestations.uri, rev[0].targetUri))
        }
      }

      // HIGH-12: Mark dirty for score recalculation.
      await markDirty(txDb, { subjectId: null, authorDid: op.did })
    })

    ctx.metrics.incr('ingester.revocation.deleted')
  },
}
