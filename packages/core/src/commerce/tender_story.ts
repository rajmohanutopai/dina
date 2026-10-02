/**
 * A tender's story, per supplier: what it offered, where it opened, what the
 * buyer's counters asked for and how each was answered (NEGOTIATION_PLAN §4.5).
 *
 * The ranking says who is in the running now; the story says how they got
 * there. It reads only the buyer's own retained records: the verified quote
 * chain (every signed revision) and the counters this node sent. Nothing is
 * recomputed, fetched or inferred beyond one thing: a line's product name,
 * which the supplier's runner states in the signed quote's substitution
 * evidence (`matched "<asked>" to "<item name>"`). A line without that
 * statement is named by its product reference alone.
 */

import { rehydrateCounterTarget } from './rehydrate';
import { getCommerceRuntime } from './runtime';

import type { SentCounterState } from './buyer_negotiation_store';
import type { Money, ProductRef, Quantity, SignedQuoteLine } from '@dina/commerce-protocol';

export interface TenderStoryLine {
  line_id: string;
  product: ProductRef;
  /** The supplier's own name for the item, from its signed evidence; null when it gave none. */
  name: string | null;
  quantity: Quantity;
  unit_price: Money;
  line_subtotal: Money;
}

export interface TenderStoryRevision {
  revision: string;
  total: Money;
  issued_at: string;
}

export interface TenderStoryCounter {
  round: number;
  /** What the buyer asked for; null when the retained counter cannot be read back. */
  target_total: Money | null;
  /** How the supplier answered: revised, held, refused — or not yet (sent, pending, unsent). */
  state: SentCounterState;
  sent_at: number;
  answered_at: number | null;
}

export interface TenderStorySupplier {
  supplier_did: string;
  service_rkey: string;
  /** '' until a quote answered this supplier's request. */
  quote_id: string;
  /** Every signed revision, oldest first: the first is where the supplier opened. */
  revisions: TenderStoryRevision[];
  /**
   * Every counter on the supplier's quote, in the order sent: the loop's and
   * any the owner sent by hand. A quote answers one tender request, so all of
   * them belong to this tender.
   */
  counters: TenderStoryCounter[];
  /** The newest revision's lines. */
  lines: TenderStoryLine[];
}

export type TenderStoryOutcome =
  | { ok: true; suppliers: TenderStorySupplier[] }
  | { ok: false; refusal: 'commerce_unavailable' | 'no_such_tender' };

const EVIDENCE_NAME = /\bto "([^"]{1,120})"/;

/**
 * The supplier's item name from its signed substitution evidence, if it stated
 * one. Also names a placed order's lines (`placed_orders.ts`).
 */
export function offeredName(line: SignedQuoteLine): string | null {
  for (const evidence of line.substitution_evidence ?? []) {
    const match = EVIDENCE_NAME.exec(evidence);
    const name = match?.[1]?.trim() ?? '';
    if (name !== '') return name;
  }
  return null;
}

export function tenderStory(tenderId: string): TenderStoryOutcome {
  const runtime = getCommerceRuntime();
  if (runtime === null) return { ok: false, refusal: 'commerce_unavailable' };
  if (runtime.tenders.getTender(tenderId) === null) return { ok: false, refusal: 'no_such_tender' };
  const suppliers = runtime.tenders.listMembers(tenderId).map((member): TenderStorySupplier => {
    const chain =
      member.quoteId === '' ? [] : runtime.buyerQuotes.chain(member.supplierDid, member.quoteId);
    const head = chain.at(-1);
    const counters =
      member.quoteId === ''
        ? []
        : runtime.buyerNegotiation
            .countersForQuote(member.supplierDid, member.quoteId)
            .sort((a, b) => a.sentAt - b.sentAt || a.round - b.round);
    return {
      supplier_did: member.supplierDid,
      service_rkey: member.serviceRkey,
      quote_id: member.quoteId,
      revisions: chain.map((q) => ({
        revision: q.quote_revision,
        total: q.total,
        issued_at: q.issued_at,
      })),
      counters: counters.map((c) => ({
        round: c.round,
        target_total: rehydrateCounterTarget(c.counterJson),
        state: c.state,
        sent_at: c.sentAt,
        answered_at: c.answeredAt,
      })),
      lines: (head?.lines ?? []).map((line) => ({
        line_id: line.line_id,
        product: line.offered_product,
        name: offeredName(line),
        quantity: line.quantity,
        unit_price: line.unit_price,
        line_subtotal: line.line_subtotal,
      })),
    };
  });
  return { ok: true, suppliers };
}
