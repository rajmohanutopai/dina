import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { SubjectRecord, SubjectRef } from '@/shared/types/lexicon-types.js'
import { resolveOrCreateSubject } from '@/db/queries/subjects.js'

/**
 * Handler for com.dina.trust.subject records.
 *
 * Subject records define canonical entities (products, organizations,
 * datasets, etc.) that attestations reference. The handler constructs
 * a SubjectRef from the record and delegates to resolveOrCreateSubject,
 * which handles deterministic ID generation and upsert logic.
 *
 * Subjects are canonical and never deleted via the normal flow --
 * the delete handler is intentionally a no-op.
 */
export const subjectHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as SubjectRecord

    // Construct a SubjectRef from the subject record fields
    const ref: SubjectRef = {
      type: (record.subjectType as SubjectRef['type']) ?? 'product',
      name: record.name,
    }

    // If the record carries identifiers, attach the first relevant ones
    if (record.identifiers && record.identifiers.length > 0) {
      for (const ident of record.identifiers) {
        if (ident.did) ref.did = ident.did
        if (ident.uri) ref.uri = ident.uri
        if (ident.id) ref.identifier = ident.id
      }
    }

    await resolveOrCreateSubject(ctx.db, ref, op.did)

    ctx.metrics.incr('ingester.subject.created')
  },

  async handleDelete(_ctx: HandlerContext, _op: RecordOp) {
    // No-op: subjects are canonical entities and are never deleted
    // via the normal record deletion flow.
  },
}
