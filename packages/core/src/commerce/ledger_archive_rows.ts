/**
 * The books in the archive (docs/STATE_MACHINES.md COM-3, USER_BACKUP.md §2).
 *
 * What a business would lose and could not get back: the khata documents, the
 * declines, the revenue-share documents and the order evidence (nobody re-sends
 * them, and the other side refuses what this node forgot), documents spooled
 * while the money line was closed, the invite exchanges behind its
 * relationships, the live catalogue pages (a supplier quotes from them), and
 * the SKU counter that must never issue a number twice.
 *
 * What stays out, and why:
 *   - `commerce_staff_grants`, `commerce_staff_pins`, `commerce_staff_pin_attempts`,
 *     `commerce_staff_clearances`: authority for devices that are re-paired after
 *     a move, the posture of `agent_persona_grants`.
 *   - `commerce_order_approvals`: a live permission to send one order. A restored
 *     tender already reads its award's approval as no longer held.
 *   - `commerce_order_drafts`, `commerce_image_artifacts`,
 *     `commerce_image_egress_authorizations`: work in progress with its photographs.
 *     What was sent lives in the buyer tables; the owner photographs a draft again.
 *   - `commerce_pending_decisions`: a question whose card does not travel. The
 *     order's deadline sweep answers it.
 *   - `commerce_credentials`, `commerce_catalog_source_bindings`,
 *     `commerce_catalog_refresh_commands`, `commerce_idempotency_evidence`: secrets,
 *     and the wiring and probes that hang on them. The owner connects the source again.
 *   - `commerce_attribution_boundary`, `commerce_attribution_grandfather`: rebuilt
 *     from the store at the node's next staff grant.
 *
 * A backup can be older than the last thing the owner did, so on import, whatever
 * the archive says, a restore resumes nothing here either: an exchange still
 * under way comes back revoked (its code may have been withdrawn since), and
 * only published catalogue work returns, because the photographs and the claims
 * of an unfinished draft do not travel. The SKU counter returns whole.
 */

import type { DBRow } from '../storage/db_adapter';

export const LEDGER_ARCHIVE_TABLES = [
  'commerce_trade_documents',
  'commerce_decline_documents',
  'commerce_revshare_documents',
  'commerce_order_attachments',
  'commerce_trade_spool',
  'commerce_invites',
  'commerce_catalog_drafts',
  'commerce_sku_assignments',
  'commerce_sku_highwater',
] as const;

const OPEN_INVITE_STATES: readonly unknown[] = ['offered', 'held', 'redeemed'];

/** One table's rows in their restored form. Any other table passes through unchanged. */
export function ledgerRowsForRestore(table: string, rows: DBRow[], nowMs: number): DBRow[] {
  switch (table) {
    case 'commerce_invites':
      return rows.map((row) =>
        OPEN_INVITE_STATES.includes(row.state)
          ? { ...row, state: 'revoked', updated_at: nowMs }
          : row,
      );
    case 'commerce_catalog_drafts':
      return rows.filter((row) => row.state === 'published');
    case 'commerce_sku_assignments':
      return rows.filter((row) => Number(row.published) === 1);
    default:
      return rows;
  }
}
