import { eq } from 'drizzle-orm'
import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { Reaction } from '@/shared/types/lexicon-types.js'
import { reactions, attestations } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'
import { markDirty } from '@/db/queries/dirty-flags.js'

/**
 * Handler for com.dina.reputation.reaction records.
 *
 * Reactions are lightweight signals on attestations (helpful, suspicious, etc.).
 * Uses onConflictDoNothing for idempotent replay — if the same reaction URI
 * already exists, the insert is silently skipped.
 */
export const reactionHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as Reaction

    // MED-14: Use onConflictDoUpdate so reaction updates propagate
    await ctx.db.insert(reactions).values({
      uri: op.uri,
      authorDid: op.did,
      cid: op.cid!,
      targetUri: record.targetUri,
      reaction: record.reaction,
      recordCreatedAt: new Date(record.createdAt),
    }).onConflictDoUpdate({
      target: reactions.uri,
      set: {
        cid: op.cid!,
        reaction: record.reaction,
        targetUri: record.targetUri,
        recordCreatedAt: new Date(record.createdAt),
      },
    })

    // HIGH-12 fix: Mark reaction author + target attestation's author and subject dirty
    const targetAtt = await ctx.db.select({
      authorDid: attestations.authorDid,
      subjectId: attestations.subjectId,
    }).from(attestations).where(eq(attestations.uri, record.targetUri)).limit(1)

    await markDirty(ctx.db, {
      subjectId: targetAtt[0]?.subjectId ?? null,
      authorDid: op.did,
    })
    if (targetAtt[0]?.authorDid && targetAtt[0].authorDid !== op.did) {
      await markDirty(ctx.db, { subjectId: null, authorDid: targetAtt[0].authorDid })
    }

    ctx.metrics.incr('ingester.reaction.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    // HIGH-12 fix: Look up target before deletion so we can mark its author dirty
    const reactionRow = await ctx.db.select({ targetUri: reactions.targetUri })
      .from(reactions).where(eq(reactions.uri, op.uri)).limit(1)

    await deletionHandler.process(ctx.db, op.uri, op.did, 'reaction', reactions)

    // Mark reactor + target attestation author dirty
    await markDirty(ctx.db, { subjectId: null, authorDid: op.did })
    if (reactionRow[0]?.targetUri) {
      const targetAtt = await ctx.db.select({ authorDid: attestations.authorDid, subjectId: attestations.subjectId })
        .from(attestations).where(eq(attestations.uri, reactionRow[0].targetUri)).limit(1)
      if (targetAtt[0]?.authorDid && targetAtt[0].authorDid !== op.did) {
        await markDirty(ctx.db, { subjectId: targetAtt[0].subjectId, authorDid: targetAtt[0].authorDid })
      }
    }
    ctx.metrics.incr('ingester.reaction.deleted')
  },
}
