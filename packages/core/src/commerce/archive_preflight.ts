/**
 * Commerce archive preflight (§16.2, WS-4.2) — prove the archive before a
 * single row is written.
 *
 * WHAT THE FENCE DOES NOT COVER. The restore fence (WS-4.1/4.2) answers the
 * COUNTER question: capacity is never adopted from a backup, because a stale
 * use counter is exactly the number a restore makes untrustworthy. It says
 * nothing about STRUCTURE. An archive whose order references point at quotes
 * it does not contain, or whose status heads name receipts that are missing,
 * imports cleanly today and produces a node that cannot answer for its own
 * orders — the failure surfaces later, as a buyer's reconcile that no local
 * record can satisfy.
 *
 * WHY PREFLIGHT RATHER THAN REPAIR. It is tempting to import what is coherent
 * and drop the rest. That is the same mistake as a partial catalog import, one
 * layer down and worse: a dropped order reference does not merely omit
 * information, it makes this node deny an order a counterparty holds signed
 * evidence for. §16.2 asks for fail-closed reconstruction, and the honest
 * reading is all-or-nothing with a report naming exactly what is wrong.
 *
 * PURE, AND DELIBERATELY SO. It takes rows and returns findings. Reading them
 * out of an archive and deciding what to do belongs to the import path; a
 * validator that also imported would be a validator nobody could run as a
 * dry-run, and a dry-run is what an operator wants before overwriting a node.
 *
 * STRUCTURE IS NOT AUTHENTICITY, WHICH IS WHY THE DIGESTS ARE RECOMPUTED.
 * Everything above checks that the archive AGREES WITH ITSELF: orders point
 * at quotes it carries, status heads name receipts it carries. A
 * self-authored archive agrees with itself perfectly. `archive.ts` already
 * says the payload is attacker-influenced, and the receipts are what every
 * other table is checked against — so a forged receipt is not one bad row,
 * it is a corrupted yardstick. Each receipt's stored record is re-derived
 * under its own domain and must produce the digest it is filed under.
 * Nothing else in the archive is self-proving; this is the anchor the rest
 * hangs from.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  DIGEST_FIELD_BY_DOMAIN,
  commerceRecordDigest,
  type CommerceDigestDomain,
  type Sha256Fn,
} from '@dina/commerce-protocol';

const hash: Sha256Fn = (data) => sha256(data);

const HEX64 = /^[0-9a-f]{64}$/;

/** The commerce tables an archive must carry as a set (§16.2). */
export const REQUIRED_COMMERCE_TABLES = [
  'commerce_receipts',
  'commerce_order_refs',
  'commerce_quote_heads',
  'commerce_quote_uses',
  'commerce_status_heads',
  'commerce_epoch_watermarks',
] as const;

export type PreflightRefusal =
  | 'missing_table'
  | 'bad_row_shape'
  | 'dangling_quote_reference'
  | 'dangling_order_reference'
  | 'dangling_receipt_reference'
  | 'duplicate_key'
  /** A receipt's stored record does not hash to the digest it is filed under. */
  | 'forged_receipt';

export interface PreflightFinding {
  refusal: PreflightRefusal;
  table: string;
  /** Identifies the offending row without reproducing its contents. */
  key: string;
  detail: string;
}

/** The subset of each table this check reads. Extra columns are ignored. */
export interface CommerceArchiveTables {
  commerce_receipts?: { record_digest?: unknown; domain?: unknown; record_json?: unknown }[];
  commerce_order_refs?: {
    buyer_did?: unknown;
    purchase_order_id?: unknown;
    quote_id?: unknown;
    order_digest?: unknown;
  }[];
  commerce_quote_heads?: { quote_id?: unknown; head_digest?: unknown }[];
  commerce_quote_uses?: { quote_id?: unknown; purchase_order_id?: unknown }[];
  commerce_status_heads?: {
    buyer_did?: unknown;
    purchase_order_id?: unknown;
    head_digest?: unknown;
  }[];
  commerce_epoch_watermarks?: { supplier_did?: unknown; epoch?: unknown }[];
}

export interface PreflightVerdict {
  ok: boolean;
  findings: PreflightFinding[];
  /**
   * True when the archive carries no commerce tables at all — a backup taken
   * before this node knew what commerce was. Distinct from `ok` with empty
   * tables, which means "this node had commerce and no orders".
   */
  predatesCommerce: boolean;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Check a commerce archive without writing anything.
 *
 * Returns EVERY finding rather than the first, because an operator deciding
 * whether to restore needs the shape of the damage, not its earliest symptom.
 */
/**
 * Does this receipt's stored record actually hash to the digest it is filed
 * under? Returns null when it does, a reason when it does not.
 *
 * THIS IS THE MODULE THAT RE-DERIVES, which is why it may parse a stored
 * record: the boundary rule forbids reading one WITHOUT re-deriving its
 * digest, and re-deriving is the entire function.
 *
 * `restore_fence_event` is the one domain with no digest field of its own.
 * Its receipt is filed under the EPOCH record's digest and stores
 * `{record, voidedQuotes}`, so it is verified as an epoch record read out of
 * that envelope. Skipping it instead would leave the one receipt kind a
 * restore itself writes as the unchecked way in.
 */
function receiptIsForged(domain: unknown, recordJson: unknown, digest: string): string | null {
  if (typeof domain !== 'string' || domain === '') return 'domain is missing';
  if (typeof recordJson !== 'string' || recordJson === '') return 'record_json is missing';
  let parsed: unknown;
  try {
    parsed = JSON.parse(recordJson);
  } catch {
    return 'record_json is not JSON';
  }
  const { record, digestDomain } = unwrapReceiptRecord(domain, parsed);
  if (record === null) return 'record_json does not carry a record object';
  if (digestDomain === null) {
    // An unknown domain cannot be re-derived, and cannot-derive is a refusal:
    // admitting it would make "verified" mean "verified, or filed under a
    // domain we invented".
    return `domain "${domain}" has no digest rule`;
  }
  const recomputed = commerceRecordDigest(digestDomain, record, hash);
  return recomputed === digest
    ? null
    : 'stored record does not hash to the digest it is filed under';
}

/** The record to digest, and the domain to digest it under. */
function unwrapReceiptRecord(
  domain: string,
  parsed: unknown,
): { record: Record<string, unknown> | null; digestDomain: CommerceDigestDomain | null } {
  const asObject = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (domain === 'restore_fence_event') {
    const outer = asObject(parsed);
    return { record: outer === null ? null : asObject(outer.record), digestDomain: 'epoch' };
  }
  const known = Object.prototype.hasOwnProperty.call(DIGEST_FIELD_BY_DOMAIN, domain);
  return {
    record: asObject(parsed),
    digestDomain: known ? (domain as CommerceDigestDomain) : null,
  };
}

export function preflightCommerceArchive(tables: CommerceArchiveTables): PreflightVerdict {
  const findings: PreflightFinding[] = [];
  const add = (refusal: PreflightRefusal, table: string, key: string, detail: string): void => {
    findings.push({ refusal, table, key, detail });
  };

  // 1. ALL SIX OR NONE.
  //
  //    None is a real and permanent case: the shipped app predates commerce,
  //    and its backups will be restored for years. Refusing those would make
  //    this check a data-loss bug wearing an integrity check's clothes.
  //
  //    A PARTIAL set is the one that cannot be excused. Every archive this
  //    code produces writes all six (empty arrays included), so a torn set
  //    means the archive was assembled by something else — and the tables that
  //    survived are exactly the ones whose cross-references the missing ones
  //    would have satisfied.
  const present = REQUIRED_COMMERCE_TABLES.filter((table) => Array.isArray(tables[table]));
  if (present.length === 0) {
    return { ok: true, findings: [], predatesCommerce: true };
  }
  for (const table of REQUIRED_COMMERCE_TABLES) {
    if (!Array.isArray(tables[table])) {
      add(
        'missing_table',
        table,
        table,
        'the archive carries some commerce tables but not this one',
      );
    }
  }
  if (findings.length > 0) return { ok: false, findings, predatesCommerce: false };

  const receipts = tables.commerce_receipts ?? [];
  const orders = tables.commerce_order_refs ?? [];
  const quotes = tables.commerce_quote_heads ?? [];
  const uses = tables.commerce_quote_uses ?? [];
  const heads = tables.commerce_status_heads ?? [];
  const watermarks = tables.commerce_epoch_watermarks ?? [];

  // 2. Row shapes. A digest column that is not a digest cannot be matched
  //    against anything, so every cross-table check below would silently pass.
  const receiptDigests = new Set<string>();
  receipts.forEach((row, index) => {
    if (!isNonEmptyString(row.record_digest) || !HEX64.test(row.record_digest)) {
      add('bad_row_shape', 'commerce_receipts', `#${String(index)}`, 'record_digest is not hex64');
      return;
    }
    if (receiptDigests.has(row.record_digest)) {
      add('duplicate_key', 'commerce_receipts', row.record_digest, 'digest appears twice');
      return;
    }
    // AUTHENTICITY, not just uniqueness. Every check below compares other
    // tables against this set, so an unverified receipt makes all of them
    // agree with a lie. Recomputed under the row's own domain from the
    // record it stores.
    const forged = receiptIsForged(row.domain, row.record_json, row.record_digest);
    if (forged !== null) {
      add('forged_receipt', 'commerce_receipts', row.record_digest, forged);
      return;
    }
    receiptDigests.add(row.record_digest);
  });

  const quoteIds = new Set<string>();
  quotes.forEach((row, index) => {
    if (!isNonEmptyString(row.quote_id)) {
      add('bad_row_shape', 'commerce_quote_heads', `#${String(index)}`, 'quote_id is missing');
      return;
    }
    if (quoteIds.has(row.quote_id)) {
      add('duplicate_key', 'commerce_quote_heads', row.quote_id, 'quote_id appears twice');
      return;
    }
    quoteIds.add(row.quote_id);
  });

  const orderKeys = new Set<string>();
  orders.forEach((row, index) => {
    const where = `#${String(index)}`;
    if (!isNonEmptyString(row.buyer_did) || !isNonEmptyString(row.purchase_order_id)) {
      add('bad_row_shape', 'commerce_order_refs', where, 'buyer_did / purchase_order_id missing');
      return;
    }
    const key = `${row.buyer_did}:${row.purchase_order_id}`;
    if (orderKeys.has(key)) {
      add('duplicate_key', 'commerce_order_refs', key, 'order appears twice');
      return;
    }
    orderKeys.add(key);
    if (!isNonEmptyString(row.order_digest) || !HEX64.test(row.order_digest)) {
      add('bad_row_shape', 'commerce_order_refs', key, 'order_digest is not hex64');
    }
    // 3. CROSS-TABLE. An order whose quote is not in the archive cannot have
    //    its capacity re-derived, and capacity re-derivation is the whole
    //    point of not adopting the counters (§16.2 / owner decision 6).
    if (!isNonEmptyString(row.quote_id) || !quoteIds.has(row.quote_id)) {
      add(
        'dangling_quote_reference',
        'commerce_order_refs',
        key,
        'the order names a quote this archive does not contain',
      );
    }
  });

  uses.forEach((row, index) => {
    const where = `#${String(index)}`;
    if (!isNonEmptyString(row.quote_id) || !isNonEmptyString(row.purchase_order_id)) {
      add('bad_row_shape', 'commerce_quote_uses', where, 'quote_id / purchase_order_id missing');
      return;
    }
    if (!quoteIds.has(row.quote_id)) {
      add(
        'dangling_quote_reference',
        'commerce_quote_uses',
        `${row.quote_id}:${row.purchase_order_id}`,
        'a use names a quote this archive does not contain',
      );
    }
  });

  heads.forEach((row, index) => {
    const where = `#${String(index)}`;
    if (!isNonEmptyString(row.buyer_did) || !isNonEmptyString(row.purchase_order_id)) {
      add('bad_row_shape', 'commerce_status_heads', where, 'buyer_did / purchase_order_id missing');
      return;
    }
    const key = `${row.buyer_did}:${row.purchase_order_id}`;
    // A chain without its order is a node that can describe a fulfilment it
    // cannot attribute — and §9.11 line checks read the ORDER's accepted
    // lines, so the chain could never legally advance again.
    if (!orderKeys.has(key)) {
      add(
        'dangling_order_reference',
        'commerce_status_heads',
        key,
        'a status chain names an order this archive does not contain',
      );
    }
    // The head names a record. Without it, `loadHeadStatus` fails closed on
    // every future signing attempt, so the chain is frozen from the moment it
    // is restored.
    if (!isNonEmptyString(row.head_digest) || !HEX64.test(row.head_digest)) {
      add('bad_row_shape', 'commerce_status_heads', key, 'head_digest is not hex64');
    } else if (!receiptDigests.has(row.head_digest)) {
      add(
        'dangling_receipt_reference',
        'commerce_status_heads',
        key,
        'the chain head names a receipt this archive does not contain',
      );
    }
  });

  watermarks.forEach((row, index) => {
    // `supplier_did`, matching the schema. An earlier draft read
    // `counterparty_did` — the name the SPEC uses for the concept — and would
    // have refused every real archive carrying a watermark, because the field
    // it looked for is never present. Neither the unit tests nor the
    // export/import test caught it: the tests built fixtures by hand and
    // agreed with the module on the wrong name, and the wiring test seeded no
    // watermark row. The fixture below is now driven by the real table.
    if (!isNonEmptyString(row.supplier_did) || !isNonEmptyString(row.epoch)) {
      add(
        'bad_row_shape',
        'commerce_epoch_watermarks',
        `#${String(index)}`,
        'supplier_did / epoch missing',
      );
    }
  });

  return { ok: findings.length === 0, findings, predatesCommerce: false };
}

/**
 * The one-line refusal an operator sees. Names the tables and counts, never a
 * row's contents — an archive is somebody's ledger, and a restore failure is
 * not a reason to print it.
 */
export function describePreflightRefusal(verdict: PreflightVerdict): string {
  const byRefusal = new Map<PreflightRefusal, number>();
  for (const finding of verdict.findings) {
    byRefusal.set(finding.refusal, (byRefusal.get(finding.refusal) ?? 0) + 1);
  }
  const parts = [...byRefusal.entries()].map(([refusal, count]) => `${refusal}×${String(count)}`);
  return `commerce archive failed preflight: ${parts.join(', ')}`;
}
