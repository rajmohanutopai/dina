/**
 * UCP in the archive (UCP plan §3.14 "Backup and restore", U3.5).
 *
 * Travels: `ucp_checkouts` (each session's history and identity, needed to
 * settle it and to recognise a webhook about it) and `ucp_orders` (each
 * order's kept record, including a webhook-only order's seen ids, its
 * summary and link).
 *
 * Stays behind: the request journal (`ucp_requests`), carts, the webhook
 * inbox and seen ids, searches and guard jobs, link tokens, and every
 * dispatch slot or lease: live work and authority, not history.
 *
 * Each row is put in its restored form twice: when the archive is built,
 * and again when it is read, since an archive is the importer's file and
 * may have been crafted. Restored:
 *  - a session not already ended is `unknown`, and its permit is void, so a
 *    node restored from an old backup never sends a mutation from it. One
 *    the merchant holds is prompted: read once at once (and retried for a
 *    day), since it may have been handed off and paid after the backup;
 *  - no slot, lease, prompt or watch schedule survives; an open order is due
 *    at once, so polling resumes;
 *  - no order keeps the merchant's snapshot (tracking numbers, addresses):
 *    the live node drops it at close (S14), so a backup must not outlast
 *    that; the restored order reads its order again at once.
 * A row whose merchant is not an https origin, or an order whose link is
 * not https, is not restored.
 */

import { merchantOrigin } from './discovery';

import type { DBRow } from '../../storage/db_adapter';

export const UCP_ARCHIVE_TABLES = ['ucp_checkouts', 'ucp_orders'] as const;

/** Session states that are already an end: kept as they are. */
const ENDED = new Set([
  'completed',
  'canceled',
  'not_completed',
  'unknown',
  'declined',
  'create_failed',
  'stale',
  'lapsed',
]);
const ORDER_STATES = new Set(['open', 'not_shared', 'closed']);

const httpsUrl = (v: unknown): boolean => {
  if (typeof v !== 'string') return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
};
const isOrigin = (v: unknown): boolean => typeof v === 'string' && merchantOrigin(v) === v;

/** A session as it is archived and restored; null when it is not restored. */
export function ucpCheckoutForArchive(r: DBRow, now: number): DBRow | null {
  if (!isOrigin(r.merchant_origin)) return null;
  const ended = ENDED.has(String(r.state));
  // Live at backup and held by the merchant: read it once the node is restored. The form is
  // applied on export and again on import, so a row the export pass prompted stays prompted.
  const held = typeof r.merchant_checkout_id === 'string' && r.merchant_checkout_id !== '';
  const ask = held && (!ended || (r.state === 'unknown' && r.prompted_at != null));
  return {
    ...r,
    state: ended ? r.state : 'unknown',
    permit_void_reason: r.permit_void_reason ?? 'restored',
    slot_holder: null,
    slot_lease_until: null,
    watch_next_at: ask ? now : null,
    prompted_at: ask ? now : null,
  };
}

/** An order as it is archived and restored; null when it is not restored. */
export function ucpOrderForArchive(r: DBRow, now: number): DBRow | null {
  if (!isOrigin(r.merchant_origin) || !httpsUrl(r.permalink_url)) return null;
  if (!ORDER_STATES.has(String(r.state))) return null;
  return {
    ...r,
    lease_holder: null,
    lease_until: null,
    prompted_at: null,
    snapshot_json: null,
    // Raw webhook bodies, like the snapshot, never leave in an archive.
    pushed_json: null,
    // An open order is read again at once on the restored node.
    next_poll_at: r.state === 'open' ? now : r.next_poll_at,
  };
}

/** The rows of one UCP table in their archived form. */
export function ucpRowsForArchive(table: string, rows: DBRow[], now: number): DBRow[] {
  const out: DBRow[] = [];
  for (const r of rows) {
    const kept =
      table === 'ucp_checkouts'
        ? ucpCheckoutForArchive(r, now)
        : table === 'ucp_orders'
          ? ucpOrderForArchive(r, now)
          : r;
    if (kept !== null) out.push(kept);
  }
  return out;
}
