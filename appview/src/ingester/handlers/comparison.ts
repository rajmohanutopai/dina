import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { Comparison } from '@/shared/types/lexicon-types.js'
import { comparisons } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'

/**
 * Handler for com.dina.reputation.comparison records.
 *
 * Comparisons are side-by-side evaluations of multiple subjects across
 * shared dimensions (e.g., comparing two laptops on battery, performance).
 * The subjects array and dimensions are stored as JSON.
 */
export const comparisonHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as Comparison

    await ctx.db.insert(comparisons).values({
      uri: op.uri,
      authorDid: op.did,
      cid: op.cid!,
      subjectsJson: record.subjects,
      category: record.category,
      dimensionsJson: record.dimensions ?? null,
      text: record.text ?? null,
      recordCreatedAt: new Date(record.createdAt),
    }).onConflictDoUpdate({
      target: comparisons.uri,
      set: {
        cid: op.cid!,
        subjectsJson: record.subjects,
        category: record.category,
        dimensionsJson: record.dimensions ?? null,
        text: record.text ?? null,
        recordCreatedAt: new Date(record.createdAt),
      },
    })

    ctx.metrics.incr('ingester.comparison.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await deletionHandler.process(ctx.db, op.uri, op.did, 'comparison', comparisons)
    ctx.metrics.incr('ingester.comparison.deleted')
  },
}
