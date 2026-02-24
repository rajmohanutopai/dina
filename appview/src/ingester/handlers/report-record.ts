import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { ReportRecord } from '@/shared/types/lexicon-types.js'
import { reportRecords } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'

/**
 * Handler for com.dina.reputation.reportRecord records.
 *
 * Reports flag content for moderation review (spam, fake review,
 * competitor attack, etc.). They feed into the dispute detection
 * system used by the deletion handler for tombstone creation.
 */
export const reportRecordHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as ReportRecord

    // Upsert the report record
    await ctx.db.insert(reportRecords).values({
      uri: op.uri,
      authorDid: op.did,
      cid: op.cid!,
      targetUri: record.targetUri,
      reportType: record.reportType,
      text: record.text ?? null,
      evidenceJson: record.evidence ?? null,
      relatedRecordsJson: record.relatedRecords ?? null,
      recordCreatedAt: new Date(record.createdAt),
    }).onConflictDoUpdate({
      target: reportRecords.uri,
      set: {
        cid: op.cid!,
        targetUri: record.targetUri,
        reportType: record.reportType,
        text: record.text ?? null,
        evidenceJson: record.evidence ?? null,
        relatedRecordsJson: record.relatedRecords ?? null,
        recordCreatedAt: new Date(record.createdAt),
        indexedAt: new Date(),
      },
    })

    ctx.metrics.incr('ingester.report_record.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await deletionHandler.process(ctx.db, op.uri, op.did, 'reportRecord', reportRecords)
    ctx.metrics.incr('ingester.report_record.deleted')
  },
}
