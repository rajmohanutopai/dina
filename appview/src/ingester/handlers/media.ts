import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { Media } from '@/shared/types/lexicon-types.js'
import { media } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'

/**
 * Handler for com.dina.trust.media records.
 *
 * Media records attach images, videos, or other files to parent records
 * (attestations, replies, etc.). Simple upsert with no trust edges or
 * dirty flag marking.
 */
export const mediaHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as Media

    await ctx.db.insert(media).values({
      uri: op.uri,
      authorDid: op.did,
      cid: op.cid!,
      parentUri: record.parentUri,
      mediaType: record.mediaType,
      url: record.url,
      alt: record.alt ?? null,
      recordCreatedAt: new Date(record.createdAt),
    }).onConflictDoUpdate({
      target: media.uri,
      set: {
        cid: op.cid!,
        parentUri: record.parentUri,
        mediaType: record.mediaType,
        url: record.url,
        alt: record.alt ?? null,
        recordCreatedAt: new Date(record.createdAt),
      },
    })

    ctx.metrics.incr('ingester.media.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await deletionHandler.process(ctx.db, op.uri, op.did, 'media', media)
    ctx.metrics.incr('ingester.media.deleted')
  },
}
