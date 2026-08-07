/**
 * The commerce restore fence's durable trigger (§16.2, WS-4.2).
 *
 * THE HOLE THIS CLOSES. The archive carries the commerce operational tables
 * on purpose — order refs with their effect phases, quote heads, USE COUNTERS,
 * status heads — because restoring receipts without them would re-serve quotes
 * against reset counters or re-sign forked heads. The spec is explicit that the
 * residual is fenced by the epoch, not by leaving the tables out.
 *
 * But nothing fenced it. `establishAfterRestore()` — which increments the
 * epoch, voids unexpired capacity, and writes the fence receipt — had no
 * caller anywhere. A restored node booted, adopted the LIVE epoch unchanged,
 * and every restored quote head matched it. The backup's use counters were
 * live again: capacity already spent, spendable a second time. That is the
 * resurrection §16.2 exists to prevent, arriving through the front door.
 *
 * WHY A MARKER RATHER THAN A CHECK. There is nothing in the restored data that
 * distinguishes it from data this node wrote itself — that is what a faithful
 * restore MEANS. The knowledge that a restore happened exists for exactly one
 * moment, inside the import, and has to be written down before it is lost.
 *
 * WHY IN THE IMPORT'S OWN TRANSACTION. If the marker were written after the
 * import committed, a crash in between would leave restored counters with no
 * fence pending — the precise state this prevents, reachable by unlucky
 * timing. Written inside the same transaction, restored capacity and the
 * obligation to void it are one atomic fact.
 *
 * The marker is cleared only after the higher epoch is PUBLISHED. Until then
 * commerce is disabled, so a node that cannot reach its repo never signs
 * against resurrected capacity — it simply does not trade.
 */

import type { DatabaseAdapter } from '../storage/db_adapter';

/**
 * kv_store key. Namespaced under `commerce:` like every other subsystem's
 * keys, and deliberately NOT exported in an archive (it describes THIS
 * node's obligation, not the backup's content — carrying it would make every
 * restore of a restore-pending backup demand a second fence for the same
 * event).
 */
export const COMMERCE_RESTORE_PENDING_KEY = 'commerce:restore_fence_pending';

/**
 * Record that commerce state arrived from an archive and has not yet been
 * fenced. Call INSIDE the import transaction.
 *
 * The value is the import time, which is evidence rather than state: the
 * fence receipt records when the fence ran, and an operator reading both can
 * see how long a restored node sat disabled.
 */
export function markCommerceRestorePending(adapter: DatabaseAdapter, atMs: number): void {
  adapter.execute('INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)', [
    COMMERCE_RESTORE_PENDING_KEY,
    JSON.stringify({ imported_at: new Date(atMs).toISOString() }),
    atMs,
  ]);
}

/**
 * Is a fence owed? Read at boot, before commerce may sign anything.
 *
 * FAILS CLOSED: an unreadable kv_store answers "yes, a fence is owed". The
 * alternative reading — "no marker found, carry on" — is the answer that
 * resurrects capacity, and a database we cannot query is not evidence that
 * this node is safe to trade from.
 */
export function isCommerceRestorePending(adapter: DatabaseAdapter): boolean {
  try {
    const rows = adapter.query<{ key: string }>('SELECT key FROM kv_store WHERE key = ?', [
      COMMERCE_RESTORE_PENDING_KEY,
    ]);
    return rows.length > 0;
  } catch {
    return true;
  }
}

/**
 * Clear the marker. Call ONLY after the higher epoch is published and the
 * capacity void is committed — clearing it earlier would let the next boot
 * skip a fence that never actually ran.
 */
export function clearCommerceRestorePending(adapter: DatabaseAdapter): void {
  adapter.execute('DELETE FROM kv_store WHERE key = ?', [COMMERCE_RESTORE_PENDING_KEY]);
}
