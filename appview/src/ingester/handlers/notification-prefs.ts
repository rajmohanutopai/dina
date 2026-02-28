import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { NotificationPrefs } from '@/shared/types/lexicon-types.js'
import { notificationPrefs } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'

/**
 * Handler for com.dina.trust.notificationPrefs records.
 *
 * Notification preferences control which event types generate
 * notifications for a user: mentions, reactions, replies, and flags.
 * Each user has at most one preferences record (authorDid is unique).
 */
export const notificationPrefsHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as NotificationPrefs

    await ctx.db.insert(notificationPrefs).values({
      uri: op.uri,
      authorDid: op.did,
      cid: op.cid!,
      enableMentions: record.enableMentions,
      enableReactions: record.enableReactions,
      enableReplies: record.enableReplies,
      enableFlags: record.enableFlags,
      recordCreatedAt: new Date(record.createdAt),
    }).onConflictDoUpdate({
      target: notificationPrefs.authorDid,
      set: {
        uri: op.uri,
        cid: op.cid!,
        enableMentions: record.enableMentions,
        enableReactions: record.enableReactions,
        enableReplies: record.enableReplies,
        enableFlags: record.enableFlags,
        recordCreatedAt: new Date(record.createdAt),
      },
    })

    ctx.metrics.incr('ingester.notificationPrefs.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await deletionHandler.process(ctx.db, op.uri, op.did, 'notificationPrefs', notificationPrefs)
    ctx.metrics.incr('ingester.notificationPrefs.deleted')
  },
}
