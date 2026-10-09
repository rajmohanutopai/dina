import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import { notePresence, notePresenceDelete } from '../service-liveness-ingest.js'

/**
 * Handler for `com.dinakernel.service.presence` (docs/REAL_LIFE_FIXES.md §14):
 * a node's daily "still here" record. Only the `self` record counts. Its
 * renewal time is AppView's observation time (`op.observedUs`), and a newer
 * repository revision always replaces the listing set.
 */
export const servicePresenceHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    if (op.rkey !== 'self') {
      ctx.metrics.incr('ingester.service_presence.bad_rkey')
      return
    }
    const record = op.record as { listings: { rkey: string; cid: string }[]; complete: boolean }
    const observed = op.observedUs ?? Date.now() * 1000
    const out = await notePresence(ctx.db, op.did, record, op.repoRev, observed, op.reconciled !== true)
    ctx.metrics.incr('ingester.service_presence.renewed', { outcome: out })
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    if (op.rkey !== 'self') return
    await notePresenceDelete(ctx.db, op.did, op.repoRev, op.reconciled === true)
    ctx.metrics.incr('ingester.service_presence.withdrawn')
  },
}
