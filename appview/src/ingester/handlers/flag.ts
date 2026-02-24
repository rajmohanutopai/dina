import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { Flag } from '@/shared/types/lexicon-types.js'
import { flags } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'
import { resolveOrCreateSubject } from '@/db/queries/subjects.js'
import { markDirty } from '@/db/queries/dirty-flags.js'

/**
 * Handler for com.dina.reputation.flag records.
 *
 * A flag is a negative signal against a subject — "something is wrong here."
 * Flags do NOT create trust edges (they are not a trust relationship).
 */
export const flagHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as Flag

    // Resolve or create the subject
    const subjectId = await resolveOrCreateSubject(ctx.db, record.subject, op.did)

    // Upsert the flag record
    await ctx.db.insert(flags).values({
      uri: op.uri,
      authorDid: op.did,
      cid: op.cid!,
      subjectId,
      subjectRefRaw: record.subject,
      flagType: record.flagType,
      severity: record.severity,
      text: record.text ?? null,
      evidenceJson: record.evidence ?? null,
      recordCreatedAt: new Date(record.createdAt),
    }).onConflictDoUpdate({
      target: flags.uri,
      set: {
        cid: op.cid!,
        subjectId,
        subjectRefRaw: record.subject,
        flagType: record.flagType,
        severity: record.severity,
        text: record.text ?? null,
        evidenceJson: record.evidence ?? null,
        recordCreatedAt: new Date(record.createdAt),
        indexedAt: new Date(),
      },
    })

    // No trust edge for flags

    // Mark affected entities for score recalculation
    await markDirty(ctx.db, {
      subjectId,
      authorDid: op.did,
      subjectDid: record.subject.type === 'did' ? record.subject.did : undefined,
    })

    ctx.metrics.incr('ingester.flag.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await deletionHandler.process(ctx.db, op.uri, op.did, 'flag', flags)
    ctx.metrics.incr('ingester.flag.deleted')
  },
}
