/**
 * NEGOTIATION_PLAN §4.5 / §4.7 — what the tender screen reads and what its two
 * buttons answer, shared by the owner's in-process client and the clerk's
 * relay client so both surfaces render one shape.
 *
 * The parsers read Core's answers and add nothing: an award or a send that
 * crossed a clerk's cap answers 202 with the owner's card, and that is a
 * normal outcome ("waiting for the owner"), not an error.
 */

export interface TenderOfferView {
  supplier_did: string;
  quote_id: string;
  service_rkey: string;
  total_minor: string;
  currency: string;
  comparison_cost_minor: string;
  credit_days: number;
  valid_until: string;
  revision: string;
}

export type TenderExclusionReason =
  | 'no_quote'
  | 'declined'
  | 'expired'
  | 'currency_mismatch'
  | 'over_budget';

export interface TenderRankingView {
  tender_id: string;
  /** `no_policy`: a tender opened without negotiation. */
  state: 'negotiating' | 'ready' | 'awarded' | 'closed' | 'no_policy';
  target_total?: string;
  budget_ceiling?: string;
  currency?: string;
  deadline_at?: number;
  awarded_supplier_did?: string;
  /** Present once awarded: the held order the send uses. */
  approval_id?: string;
  /** Present once awarded: whether that order is still held, sent, or lapsed unsent. */
  held_order?: 'held' | 'sent' | 'lapsed';
  ranked: TenderOfferView[];
  excluded: {
    supplier_did: string;
    reason: TenderExclusionReason;
    /** The listing the request went to (absent from a Core before 2026-09-29). */
    service_rkey?: string;
  }[];
  /**
   * Suppliers the owner's surface set aside and never asked, with why
   * (absent from a Core before 2026-09-29).
   */
  not_asked?: TenderNotAskedView[];
}

/** A supplier a tender deliberately left out, and why. */
export interface TenderNotAskedView {
  supplier_did: string;
  service_rkey: string;
  reason: 'own_poor_review' | 'low_peerlens_trust';
  /** The owner's review, or the score in words; '' when there was none. */
  note: string;
  /** The lowest price the supplier listed for what was asked, when the surface saw one. */
  listed_from?: { currency: string; minor_units: string };
}

/**
 * `GET /v1/commerce/trade/tender/story` — how each supplier got where the
 * ranking shows it (absent from a Core before 2026-09-30).
 */
export interface TenderStoryView {
  tender_id: string;
  suppliers: TenderStorySupplierView[];
}

export interface TenderStorySupplierView {
  supplier_did: string;
  service_rkey: string;
  /** '' until a quote answered the supplier's request. */
  quote_id: string;
  /** Every signed revision, oldest first: the first is where the supplier opened. */
  revisions: {
    revision: string;
    total: { currency: string; minor_units: string };
    issued_at: string;
  }[];
  /** The tender's counters to this supplier, in the order they were sent. */
  counters: {
    round: number;
    target_total: { currency: string; minor_units: string } | null;
    state: 'sent' | 'revised' | 'held' | 'pending' | 'refused' | 'unsent';
    sent_at: number;
    answered_at: number | null;
  }[];
  /** The newest revision's lines; `name` is the supplier's own item name, when it stated one. */
  lines: {
    line_id: string;
    product: { scheme: string; value: string };
    name: string | null;
    quantity: { value: string; unit_code: string };
    unit_price: { currency: string; minor_units: string };
    line_subtotal: { currency: string; minor_units: string };
  }[];
}

export type TenderAwardOutcome =
  | {
      kind: 'awarded';
      approvalId: string;
      supplierDid: string;
      /** An earlier award returned again (a retry after a lost answer). */
      replayed: boolean;
    }
  /** A clerk over the cap: the owner has a card; retry once they approve. */
  | { kind: 'pending_approval'; taskId: string };

export type OrderSendOutcome =
  | { kind: 'sent'; headline: string; state: string }
  | { kind: 'pending_approval'; taskId: string };

/** The route's answer as the award button reads it; null when it is not one. */
export function readTenderAward(status: number, body: unknown): TenderAwardOutcome | null {
  const record = (body ?? {}) as Record<string, unknown>;
  if (status === 202) return { kind: 'pending_approval', taskId: String(record.task_id ?? '') };
  if (status !== 200 || typeof record.approval_id !== 'string') return null;
  const awarded = record.awarded as { supplier_did?: unknown } | undefined;
  const supplierDid =
    typeof awarded?.supplier_did === 'string'
      ? awarded.supplier_did
      : typeof record.awarded_supplier_did === 'string'
        ? record.awarded_supplier_did
        : '';
  return {
    kind: 'awarded',
    approvalId: record.approval_id,
    supplierDid,
    replayed: record.replayed === true,
  };
}

/** The send route's answer as the send button reads it; null when it is not one. */
export function readOrderSend(status: number, body: unknown): OrderSendOutcome | null {
  const record = (body ?? {}) as Record<string, unknown>;
  if (status === 202) return { kind: 'pending_approval', taskId: String(record.task_id ?? '') };
  if (status !== 200) return null;
  return {
    kind: 'sent',
    headline: typeof record.headline === 'string' ? record.headline : 'Sent.',
    state: typeof record.state === 'string' ? record.state : '',
  };
}
