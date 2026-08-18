/**
 * The private tender (TRADE_FIRST_STRATEGY §3.2) — ONE buyer-side
 * aggregate over N per-supplier QuoteRequests, and the comparison that
 * ranks the answers.
 *
 * WHY AN AGGREGATE AND NOT A LOOP IN A SCREEN. The shipped request
 * shape embeds `supplier_did` inside its digest, so a tender is
 * necessarily N distinct signed questions; something durable has to
 * remember that they are ONE question to the buyer, or the arriving
 * answers land as N unrelated conversations. The tender row is that
 * memory. Quotes and declines stay in their own verified stores —
 * the member row is correlation, never evidence.
 *
 * THE COMPARISON IS DETERMINISTIC ARITHMETIC (§3.2 step 4): the signed
 * total, freight inside it, and a buyer-local ADVISORY financing
 * adjustment —
 *
 *     benefit = round_half_even(total × rate_bps × credit_days
 *                               / (10_000 × 365))
 *
 * with `rate_bps` an integer from BuyerSettings (default 1800), the
 * §9.1 discipline's one rounding. The adjustment is displayed beside
 * the signed total and never mixed into it. The LAST-PAID badge reads
 * the most recent accepted order's bound quote for the same product —
 * the same retained stores the khata statement walks.
 */

import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import {
  moneyMinorUnits,
  productRefsEqual,
  roundRationalHalfEven,
  type DeliveryProjection,
  type ProductRef,
  type PurchaseOrderProposal,
  type SignedQuote,
} from '@dina/commerce-protocol';

import { requestQuote, type QuoteRequestLineInput } from './buyer_quote_request';
import { getCommerceRuntime } from './runtime';
import { rehydrateTradeDocument } from './trade_ledger';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export const DEFAULT_WORKING_CAPITAL_RATE_BPS = 1800;
/** §3.4 — small by default; the consent card shows the exact list. */
export const DEFAULT_TENDER_FANOUT = 5;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface TenderRecord {
  tenderId: string;
  linesJson: string;
  projectionJson: string;
  requestedTermsJson: string;
  expiresAt: number;
  createdAt: number;
}

export interface TenderMember {
  tenderId: string;
  supplierDid: string;
  requestId: string;
  requestDigest: string;
  /** '' until a quote settles for this member's request. */
  quoteId: string;
}

export interface TenderRepository {
  putTender(tender: TenderRecord): void;
  getTender(tenderId: string): TenderRecord | null;
  /** Every tender, newest first — the §7 inbox walks the open ones. */
  listTenders(): TenderRecord[];
  putMember(member: TenderMember): void;
  listMembers(tenderId: string): TenderMember[];
  memberByRequestId(requestId: string): TenderMember | null;
  setMemberQuote(requestId: string, quoteId: string): void;
}

function tenderFromRow(row: Record<string, unknown>): TenderRecord {
  return {
    tenderId: String(row.tender_id),
    linesJson: String(row.lines_json),
    projectionJson: String(row.projection_json),
    requestedTermsJson: String(row.requested_terms_json),
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
  };
}

export class SQLiteTenderRepository implements TenderRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  putTender(tender: TenderRecord): void {
    this.db.run(
      `INSERT OR REPLACE INTO commerce_tenders
         (tender_id, lines_json, projection_json, requested_terms_json, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        tender.tenderId,
        tender.linesJson,
        tender.projectionJson,
        tender.requestedTermsJson,
        tender.expiresAt,
        tender.createdAt,
      ],
    );
  }

  getTender(tenderId: string): TenderRecord | null {
    const rows = this.db.query(`SELECT * FROM commerce_tenders WHERE tender_id = ?`, [tenderId]);
    const row = rows[0];
    return row === undefined ? null : tenderFromRow(row);
  }

  listTenders(): TenderRecord[] {
    return this.db
      .query(`SELECT * FROM commerce_tenders ORDER BY created_at DESC`)
      .map(tenderFromRow);
  }

  putMember(member: TenderMember): void {
    this.db.run(
      `INSERT OR REPLACE INTO commerce_tender_members
         (tender_id, supplier_did, request_id, request_digest, quote_id)
       VALUES (?, ?, ?, ?, ?)`,
      [member.tenderId, member.supplierDid, member.requestId, member.requestDigest, member.quoteId],
    );
  }

  listMembers(tenderId: string): TenderMember[] {
    return this.db
      .query(
        `SELECT * FROM commerce_tender_members WHERE tender_id = ? ORDER BY supplier_did`,
        [tenderId],
      )
      .map(memberFromRow);
  }

  memberByRequestId(requestId: string): TenderMember | null {
    const rows = this.db.query(`SELECT * FROM commerce_tender_members WHERE request_id = ?`, [
      requestId,
    ]);
    return rows[0] === undefined ? null : memberFromRow(rows[0]);
  }

  setMemberQuote(requestId: string, quoteId: string): void {
    this.db.run(`UPDATE commerce_tender_members SET quote_id = ? WHERE request_id = ?`, [
      quoteId,
      requestId,
    ]);
  }
}

function memberFromRow(row: DBRow): TenderMember {
  return {
    tenderId: String(row.tender_id),
    supplierDid: String(row.supplier_did),
    requestId: String(row.request_id),
    requestDigest: String(row.request_digest),
    quoteId: String(row.quote_id),
  };
}

/** Test double. A production caller would be the bug. */
export class InMemoryTenderRepository implements TenderRepository {
  private readonly tenders = new Map<string, TenderRecord>();
  private readonly members = new Map<string, TenderMember>();

  putTender(tender: TenderRecord): void {
    this.tenders.set(tender.tenderId, { ...tender });
  }

  getTender(tenderId: string): TenderRecord | null {
    const tender = this.tenders.get(tenderId);
    return tender === undefined ? null : { ...tender };
  }

  listTenders(): TenderRecord[] {
    return [...this.tenders.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => ({ ...t }));
  }

  putMember(member: TenderMember): void {
    this.members.set(member.requestId, { ...member });
  }

  listMembers(tenderId: string): TenderMember[] {
    return [...this.members.values()]
      .filter((m) => m.tenderId === tenderId)
      .sort((a, b) => a.supplierDid.localeCompare(b.supplierDid))
      .map((m) => ({ ...m }));
  }

  memberByRequestId(requestId: string): TenderMember | null {
    const member = this.members.get(requestId);
    return member === undefined ? null : { ...member };
  }

  setMemberQuote(requestId: string, quoteId: string): void {
    const member = this.members.get(requestId);
    if (member !== undefined) this.members.set(requestId, { ...member, quoteId });
  }
}

// ---------------------------------------------------------------------------
// Correlation hook — called by the quote lane when a quote settles
// ---------------------------------------------------------------------------

/**
 * A quote applied for `requestId`. Correlation only: the quote itself
 * is already in the verified buyer store, and a request that belongs
 * to no tender is simply not tender traffic.
 */
export function noteTenderQuoteSettled(requestId: string, quoteId: string): void {
  const runtime = getCommerceRuntime();
  if (runtime === null) return;
  if (runtime.tenders.memberByRequestId(requestId) === null) return;
  runtime.tenders.setMemberQuote(requestId, quoteId);
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

export interface CreateTenderInput {
  suppliers: { supplierDid: string; serviceRkey: string }[];
  lines: QuoteRequestLineInput[];
  projection: DeliveryProjection;
  currency?: string;
  requiredBy?: string;
  nowMs: number;
}

export type CreateTenderOutcome =
  | {
      ok: true;
      tenderId: string;
      members: { supplierDid: string; requestId: string; sent: boolean; reason?: string }[];
    }
  | { ok: false; refusal: string };

/**
 * Build ONE tender and issue N per-supplier requests through the
 * SHIPPED sender (`requestQuote` retains each request and dispatches
 * it, §12.7 ambiguity rules included). A member exists for every
 * request that was RETAINED — an ambiguous send may still be answered,
 * and that answer must correlate.
 */
export async function createTender(input: CreateTenderInput): Promise<CreateTenderOutcome> {
  const runtime = getCommerceRuntime();
  if (runtime === null) return { ok: false, refusal: 'commerce_unavailable' };
  if (input.suppliers.length === 0) return { ok: false, refusal: 'no_suppliers' };
  if (input.suppliers.length > DEFAULT_TENDER_FANOUT) {
    return { ok: false, refusal: `fanout_exceeds_${String(DEFAULT_TENDER_FANOUT)}` };
  }
  const seen = new Set(input.suppliers.map((s) => s.supplierDid));
  if (seen.size !== input.suppliers.length) return { ok: false, refusal: 'duplicate_supplier' };

  const tenderId = `tnd_${bytesToHex(randomBytes(12))}`;
  const members: { supplierDid: string; requestId: string; sent: boolean; reason?: string }[] = [];
  let expiresAt = input.nowMs;

  for (const supplier of input.suppliers) {
    const requestId = `req_${bytesToHex(randomBytes(12))}`;
    const outcome = await requestQuote({
      supplierDid: supplier.supplierDid,
      serviceRkey: supplier.serviceRkey,
      requestId,
      idempotencyKey: `${tenderId}:${supplier.supplierDid}`,
      lines: input.lines,
      projection: input.projection,
      ...(input.currency === undefined ? {} : { currency: input.currency }),
      ...(input.requiredBy === undefined ? {} : { requiredBy: input.requiredBy }),
      nowMs: input.nowMs,
    });
    if (outcome.kind === 'refused') {
      members.push({ supplierDid: supplier.supplierDid, requestId, sent: false, reason: outcome.reason });
      continue;
    }
    const request = outcome.request;
    expiresAt = Math.max(expiresAt, Date.parse(request.expires_at));
    runtime.tenders.putMember({
      tenderId,
      supplierDid: supplier.supplierDid,
      requestId: request.request_id,
      requestDigest: request.request_digest,
      quoteId: '',
    });
    members.push({
      supplierDid: supplier.supplierDid,
      requestId: request.request_id,
      sent: outcome.kind === 'sent',
      ...(outcome.kind === 'ambiguous' ? { reason: outcome.reason } : {}),
    });
  }

  if (!members.some((m) => runtime.tenders.memberByRequestId(m.requestId) !== null)) {
    return { ok: false, refusal: 'nothing_retained' };
  }

  runtime.tenders.putTender({
    tenderId,
    linesJson: JSON.stringify(input.lines),
    projectionJson: JSON.stringify(input.projection),
    requestedTermsJson: JSON.stringify(
      input.currency === undefined ? {} : { currency: input.currency },
    ),
    expiresAt,
    createdAt: input.nowMs,
  });
  return { ok: true, tenderId, members };
}

// ---------------------------------------------------------------------------
// The comparison (§3.2 step 4)
// ---------------------------------------------------------------------------

export interface LastPaidBadge {
  line_id: string;
  last_unit_price_minor: string;
  quoted_unit_price_minor: string;
}

export type TenderMemberComparison =
  | { supplier_did: string; state: 'pending' | 'expired' }
  | { supplier_did: string; state: 'declined'; reason_code: string }
  | {
      supplier_did: string;
      state: 'quoted';
      quote_id: string;
      total_minor: string;
      currency: string;
      credit_days: number;
      /** total − advisory financing benefit. NEVER a signed number. */
      comparison_cost_minor: string;
      valid_until: string;
      last_paid: LastPaidBadge[];
    };

export interface TenderComparisonDeps {
  /** BuyerSettings' rate; absent means the default. */
  workingCapitalRateBps?: number;
  /** The khata statement's own readers — the last-paid badge walks them. */
  readOrder: (counterpartyDid: string, purchaseOrderId: string) => PurchaseOrderProposal | null;
  readBoundQuote: (counterpartyDid: string, purchaseOrderId: string) => SignedQuote | null;
  listAcceptedOrderIds: (counterpartyDid: string) => string[];
}

/** §3.2.4's advisory adjustment: integer arithmetic, one half-even rounding. */
export function financingBenefitMinor(
  totalMinor: bigint,
  rateBps: number,
  creditDays: number,
): bigint {
  if (creditDays <= 0 || rateBps <= 0) return 0n;
  return roundRationalHalfEven(
    totalMinor * BigInt(rateBps) * BigInt(creditDays),
    10_000n * 365n,
  );
}

/**
 * The most recent accepted order's bound unit price for `product` from
 * `supplierDid` — the number a distributor actually acts on.
 */
function lastPaidUnitPrice(
  deps: TenderComparisonDeps,
  supplierDid: string,
  product: ProductRef,
): string | null {
  let latest: { atMs: number; minor: string } | null = null;
  for (const purchaseOrderId of deps.listAcceptedOrderIds(supplierDid)) {
    const order = deps.readOrder(supplierDid, purchaseOrderId);
    const quote = deps.readBoundQuote(supplierDid, purchaseOrderId);
    if (order === null || quote === null) continue;
    const atMs = Date.parse(order.submitted_at);
    for (const line of quote.lines) {
      if (!productRefsEqual(line.offered_product, product)) continue;
      if (latest === null || atMs > latest.atMs) {
        latest = { atMs, minor: line.unit_price.minor_units };
      }
    }
  }
  return latest === null ? null : latest.minor;
}

/**
 * Compare a tender's members. Deterministic given the stores and the
 * rate: the same inputs rank identically on any conforming build.
 */
export function compareTender(args: {
  tenderId: string;
  deps: TenderComparisonDeps;
  nowMs: number;
}): { ok: true; members: TenderMemberComparison[] } | { ok: false; refusal: string } {
  const runtime = getCommerceRuntime();
  if (runtime === null) return { ok: false, refusal: 'commerce_unavailable' };
  const tender = runtime.tenders.getTender(args.tenderId);
  if (tender === null) return { ok: false, refusal: 'no_such_tender' };
  const rateBps = args.deps.workingCapitalRateBps ?? DEFAULT_WORKING_CAPITAL_RATE_BPS;

  const members: TenderMemberComparison[] = [];
  for (const member of runtime.tenders.listMembers(args.tenderId)) {
    // Declined? The ledger holds the verified answer.
    const declines = runtime.tradeDocuments.answersTo(member.requestDigest, 'quote_decline');
    const declineRow = declines[0];
    if (declineRow !== undefined) {
      // Through the one stored-record reader, never a bare parse.
      const decline = rehydrateTradeDocument(declineRow);
      members.push({
        supplier_did: member.supplierDid,
        state: 'declined',
        reason_code: decline.kind === 'quote_decline' ? decline.document.reason_code : 'policy',
      });
      continue;
    }
    if (member.quoteId === '') {
      members.push({
        supplier_did: member.supplierDid,
        state: args.nowMs > tender.expiresAt ? 'expired' : 'pending',
      });
      continue;
    }
    const chain = runtime.buyerQuotes.chain(member.supplierDid, member.quoteId);
    const head = chain.at(-1);
    if (head === undefined) {
      members.push({ supplier_did: member.supplierDid, state: 'pending' });
      continue;
    }
    const creditDays = head.payment_terms?.credit_days ?? 0;
    const total = moneyMinorUnits(head.total);
    const benefit = financingBenefitMinor(total, rateBps, creditDays);
    const lastPaid: LastPaidBadge[] = [];
    for (const line of head.lines) {
      const last = lastPaidUnitPrice(args.deps, member.supplierDid, line.offered_product);
      if (last !== null) {
        lastPaid.push({
          line_id: line.line_id,
          last_unit_price_minor: last,
          quoted_unit_price_minor: line.unit_price.minor_units,
        });
      }
    }
    members.push({
      supplier_did: member.supplierDid,
      state: 'quoted',
      quote_id: member.quoteId,
      total_minor: head.total.minor_units,
      currency: head.total.currency,
      credit_days: creditDays,
      comparison_cost_minor: (total - benefit).toString(10),
      valid_until: head.valid_until,
      last_paid: lastPaid,
    });
  }
  return { ok: true, members };
}
