import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { Reply } from '@/shared/types/lexicon-types.js'
import { replies } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'

/**
 * Handler for com.dina.reputation.reply records.
 *
 * Replies are threaded responses to attestations or other replies.
 * They carry an intent (agree, disagree, dispute, etc.) which
 * influences dispute detection in the deletion handler.
 */
export const replyHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as Reply

    // Upsert the reply record
    await ctx.db.insert(replies).values({
      uri: op.uri,
      authorDid: op.did,
      cid: op.cid!,
      rootUri: record.rootUri,
      parentUri: record.parentUri,
      intent: record.intent,
      text: record.text,
      evidenceJson: record.evidence ?? null,
      recordCreatedAt: new Date(record.createdAt),
    }).onConflictDoUpdate({
      target: replies.uri,
      set: {
        cid: op.cid!,
        rootUri: record.rootUri,
        parentUri: record.parentUri,
        intent: record.intent,
        text: record.text,
        evidenceJson: record.evidence ?? null,
        recordCreatedAt: new Date(record.createdAt),
        indexedAt: new Date(),
      },
    })

    ctx.metrics.incr('ingester.reply.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await deletionHandler.process(ctx.db, op.uri, op.did, 'reply', replies)
    ctx.metrics.incr('ingester.reply.deleted')
  },
}
