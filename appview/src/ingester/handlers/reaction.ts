import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { Reaction } from '@/shared/types/lexicon-types.js'
import { reactions } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'

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

    // Insert with idempotent no-op on replay
    await ctx.db.insert(reactions).values({
      uri: op.uri,
      authorDid: op.did,
      cid: op.cid!,
      targetUri: record.targetUri,
      reaction: record.reaction,
      recordCreatedAt: new Date(record.createdAt),
    }).onConflictDoNothing()

    ctx.metrics.incr('ingester.reaction.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await deletionHandler.process(ctx.db, op.uri, op.did, 'reaction', reactions)
    ctx.metrics.incr('ingester.reaction.deleted')
  },
}
