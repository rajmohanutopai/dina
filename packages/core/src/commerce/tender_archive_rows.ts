/**
 * Tender tables in the archive (USER_BACKUP.md §4.2, §5).
 *
 * Tenders, their members, the buyer's counters, the award notices and the
 * drafts travel, so a restored Dina still shows what it asked for and what
 * came back. But a backup can be older than the last thing the owner did: a
 * tender open in the backup may have been awarded since. So a restore resumes
 * nothing. Every tender comes back closed, with no notice owed and no counter
 * left to send; a pending draft comes back dismissed. The owner sees the
 * history and starts again if they still want the goods.
 *
 * Why no not-awarded notices on restore: the normal close of an expired
 * tender tells each supplier that quoted it was not awarded
 * (`closeExpiredTender`). After a restore that may be false — the award may
 * have happened after the backup — so the restored tender is closed here
 * directly, and every notice still pending is abandoned.
 *
 * The supplier side travels as it is: the answers this node gave to counters
 * (a restored supplier must answer a resend as it did before) and the
 * not-awarded outcomes it was told. A negotiation question to its owner that
 * was still open is withdrawn: its approval card is not in the archive.
 *
 * Applied on import, whatever the archive says: the archive is the
 * importer's file, not proof of what this node wrote.
 */

import type { DBRow } from '../storage/db_adapter';

export const TENDER_ARCHIVE_TABLES = [
  'commerce_tenders',
  'commerce_tender_members',
  'commerce_tender_not_asked',
  'commerce_tender_negotiation',
  'commerce_buyer_counters',
  'commerce_tender_notices',
  'commerce_tender_drafts',
  'commerce_owner_suppliers',
  'commerce_negotiation_counters',
  'commerce_negotiation_approvals',
  'commerce_quote_outcomes',
] as const;

/**
 * The tender tables in their restored form. Takes every table at once,
 * because a tender with no negotiation row needs one written closed (the
 * sweeper would otherwise close it the normal way and send notices).
 * Tables the archive does not carry stay absent.
 */
export function tenderTablesForRestore(
  tables: Readonly<Record<string, DBRow[] | undefined>>,
  nowMs: number,
): Partial<Record<(typeof TENDER_ARCHIVE_TABLES)[number], DBRow[]>> {
  const out: Partial<Record<(typeof TENDER_ARCHIVE_TABLES)[number], DBRow[]>> = {};
  for (const t of TENDER_ARCHIVE_TABLES) {
    const rows = tables[t];
    if (rows !== undefined) out[t] = rows.map((r) => ({ ...r }));
  }

  const tenders = out.commerce_tenders;
  if (tenders !== undefined) {
    for (const r of tenders) r.expires_at = Math.min(Number(r.expires_at), nowMs);
    const negotiation = (out.commerce_tender_negotiation ??= []);
    const withPolicy = new Set(negotiation.map((r) => String(r.tender_id)));
    for (const r of tenders) {
      const tenderId = String(r.tender_id);
      if (withPolicy.has(tenderId)) continue;
      negotiation.push({
        tender_id: tenderId,
        currency: '',
        target_total_minor: '',
        budget_ceiling_minor: '',
        max_rounds: 0,
        deadline_at: nowMs,
        state: 'closed',
        awarded_supplier_did: '',
        approval_id: '',
        updated_at: nowMs,
      });
    }
  }
  for (const r of out.commerce_tender_negotiation ?? []) {
    if (r.state === 'negotiating' || r.state === 'ready') {
      r.state = 'closed';
      r.approval_id = '';
      r.deadline_at = Math.min(Number(r.deadline_at), nowMs);
      r.updated_at = nowMs;
    }
  }
  for (const r of out.commerce_tender_notices ?? []) {
    if (r.state === 'pending') {
      r.state = 'abandoned';
      r.updated_at = nowMs;
    }
  }
  for (const r of out.commerce_tender_drafts ?? []) {
    if (r.state === 'pending') r.state = 'dismissed';
  }
  for (const r of out.commerce_negotiation_approvals ?? []) {
    if (r.state === 'pending') {
      r.state = 'withdrawn';
      r.decided_at = nowMs;
    }
  }
  return out;
}
