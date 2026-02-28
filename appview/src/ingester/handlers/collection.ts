import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { Collection } from '@/shared/types/lexicon-types.js'
import { collections as collectionsTable } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'

/**
 * Handler for com.dina.trust.collection records.
 *
 * Collections are user-curated lists of AT Protocol URIs (attestations,
 * subjects, etc.). They can be public or private. The table import is
 * aliased to avoid conflict with the lexicon type name.
 */
export const collectionHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as Collection

    // Upsert the collection record
    await ctx.db.insert(collectionsTable).values({
      uri: op.uri,
      authorDid: op.did,
      cid: op.cid!,
      name: record.name,
      description: record.description ?? null,
      itemsJson: record.items,
      isPublic: record.isPublic,
      recordCreatedAt: new Date(record.createdAt),
    }).onConflictDoUpdate({
      target: collectionsTable.uri,
      set: {
        cid: op.cid!,
        name: record.name,
        description: record.description ?? null,
        itemsJson: record.items,
        isPublic: record.isPublic,
        recordCreatedAt: new Date(record.createdAt),
        indexedAt: new Date(),
      },
    })

    ctx.metrics.incr('ingester.collection.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await deletionHandler.process(ctx.db, op.uri, op.did, 'collection', collectionsTable)
    ctx.metrics.incr('ingester.collection.deleted')
  },
}
