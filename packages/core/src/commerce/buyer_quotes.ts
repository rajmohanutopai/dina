/**
 * The BUYER's copy of a supplier's signed quote chain (§9.8, §25.3).
 *
 * WHY THIS EXISTS. §25.3 asks for "quote revision chains reject forks and
 * unchained revisions (supplier-side CAS at signing; buyer-side detection)" —
 * two halves, and only the first was built. `verifyQuoteRevisionExtends` ran
 * exclusively inside supplier admission, where the party running the check is
 * the party being checked. A buyer had nothing to compare an arriving revision
 * against, so a supplier could hand one buyer revision 3 of a quote and
 * another buyer a different revision 3, or quietly re-price a chain by
 * skipping revisions, and neither would notice.
 *
 * It is the same defect and the same shape as the status chain, one document
 * earlier in the trade — which is why this file mirrors `buyer_status.ts`
 * rather than inventing a second vocabulary for the same idea.
 *
 * SEPARATE FROM THE SUPPLIER'S LEDGER, deliberately. `quote_ledger.ts` carries
 * USE HOLDS: capacity this node is selling. A buyer's received quotes are the
 * other side of the negotiation and hold no capacity here at all; merging them
 * would put offers this node RECEIVED on the owner's "quotes I issued" screen,
 * and would force one row to answer for two parties who are allowed to
 * disagree.
 *
 * A FORK NEVER MOVES THE HEAD. The chain stays where it was and the reason is
 * returned to the caller, which decides what an operator sees. Applying a
 * contradiction would let the contradiction win; dropping it silently would
 * lose the only evidence that the supplier produced one.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { readSignedQuote, verifyQuoteRevisionExtends } from '@dina/commerce-protocol';

import { rehydrateSignedQuote } from './rehydrate';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';
import type { Sha256Fn, SignedQuote } from '@dina/commerce-protocol';

const hash: Sha256Fn = (data) => sha256(data);

export interface BuyerQuoteRepository {
  /** Every accepted revision of one quote, oldest first. */
  chain(supplierDid: string, quoteId: string): SignedQuote[];
  /**
   * Record an accepted revision. Returns false when this revision number is
   * already taken — the primary key IS the compare-and-swap, so a second
   * successor of one head loses here rather than overwriting the first.
   */
  append(args: {
    supplierDid: string;
    quoteId: string;
    quote: SignedQuote;
    acceptedAt: number;
  }): boolean;
}

/** A stored chain that no longer describes itself. Not an ordinary refusal. */
export class BuyerQuoteIntegrityError extends Error {}

function rowToQuote(row: DBRow): SignedQuote {
  // Re-validated, never cast, and through the one module that reads stored
  // commerce records. This record is the yardstick the next revision is
  // measured against: a tampered head would let a real successor be called a
  // fork, or a forged one be called a successor.
  const rehydrated = rehydrateSignedQuote(String(row.record_json), hash);
  if (!rehydrated.ok) {
    throw new BuyerQuoteIntegrityError(`stored quote ${String(row.quote_digest)}: ${rehydrated.error}`);
  }
  if (rehydrated.value.quote_digest !== String(row.quote_digest)) {
    throw new BuyerQuoteIntegrityError(
      `stored quote row ${String(row.quote_digest)} does not match its record`,
    );
  }
  return rehydrated.value;
}

export class SQLiteBuyerQuoteRepository implements BuyerQuoteRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  chain(supplierDid: string, quoteId: string): SignedQuote[] {
    return this.db
      .query(
        `SELECT quote_digest, record_json FROM commerce_buyer_quotes
          WHERE supplier_did = ? AND quote_id = ?
          ORDER BY revision_num`,
        [supplierDid, quoteId],
      )
      .map(rowToQuote);
  }

  append(args: {
    supplierDid: string;
    quoteId: string;
    quote: SignedQuote;
    acceptedAt: number;
  }): boolean {
    return (
      this.db.run(
        `INSERT INTO commerce_buyer_quotes
           (supplier_did, quote_id, quote_revision, revision_num, quote_digest,
            record_json, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(supplier_did, quote_id, revision_num) DO NOTHING`,
        [
          args.supplierDid,
          args.quoteId,
          args.quote.quote_revision,
          Number(args.quote.quote_revision),
          args.quote.quote_digest,
          JSON.stringify(args.quote),
          args.acceptedAt,
        ],
      ) > 0
    );
  }
}

/** Test double. A production caller would be the bug. */
export class InMemoryBuyerQuoteRepository implements BuyerQuoteRepository {
  private readonly rows = new Map<string, SignedQuote[]>();

  private key(supplierDid: string, quoteId: string): string {
    return `${supplierDid} ${quoteId}`;
  }

  chain(supplierDid: string, quoteId: string): SignedQuote[] {
    return [...(this.rows.get(this.key(supplierDid, quoteId)) ?? [])].sort(
      (a, b) => Number(a.quote_revision) - Number(b.quote_revision),
    );
  }

  append(args: { supplierDid: string; quoteId: string; quote: SignedQuote }): boolean {
    const k = this.key(args.supplierDid, args.quoteId);
    const held = this.rows.get(k) ?? [];
    if (held.some((entry) => entry.quote_revision === args.quote.quote_revision)) return false;
    this.rows.set(k, [...held, args.quote]);
    return true;
  }
}

/**
 * What happened to an inbound quote.
 *
 * `fork` and `unreadable` are distinct for the same reason they are on the
 * status chain: a record that fails to parse is a broken supplier or a mangled
 * hop, while a record that parses and contradicts the chain is a supplier
 * saying two different things about one negotiation — and only the second is
 * evidence of anything.
 */
export type BuyerQuoteOutcome =
  | 'applied'
  /** Already held at this revision with this digest. An idempotent repeat. */
  | 'duplicate'
  | 'unreadable'
  /** The quote names another supplier or another buyer than the one asked. */
  | 'not_our_quote'
  /** Contradicts the held chain. Head unchanged; the reason is returned. */
  | 'fork';

export interface BuyerQuoteIngest {
  outcome: BuyerQuoteOutcome;
  /** Present on `fork` and `unreadable`: why, in protocol terms. */
  detail?: string;
  /** The chain's head revision after this record; unchanged on any refusal. */
  revision?: string;
}

/**
 * Verify one inbound quote against what the buyer already holds, and record it
 * only if it survives.
 *
 * `supplierDid` is the TRANSPORT-authenticated sender. The quote's own
 * `supplier_did` is checked against it rather than trusted, because a field
 * inside a body a counterparty wrote cannot establish who wrote it.
 *
 * `buyerDid` is THIS node. §9.8's audience binding is what stops a supplier
 * handing one buyer a quote addressed to another — the same rule admission
 * enforces on the far side, applied here where the quote first arrives.
 */
export function verifyInboundQuote(args: {
  supplierDid: string;
  buyerDid: string;
  quote: unknown;
  repository: BuyerQuoteRepository;
  nowMs: number;
}): BuyerQuoteIngest {
  const read = readSignedQuote(args.quote, hash);
  if (!read.ok) return { outcome: 'unreadable', detail: read.error };
  const quote = read.quote;

  // BINDING FIRST, before any chain reasoning. A quote belonging to another
  // negotiation must never reach the revision check: that check compares
  // against the held head, and a mismatch there reads as a fork by this
  // supplier rather than as an answer about somebody else's quote.
  if (quote.supplier_did !== args.supplierDid) {
    return { outcome: 'not_our_quote', detail: 'quote.supplier_did is not the authenticated sender' };
  }
  if (quote.buyer_did !== args.buyerDid) {
    return { outcome: 'not_our_quote', detail: 'quote.buyer_did is not this node (§9.8)' };
  }

  const held = args.repository.chain(args.supplierDid, quote.quote_id);

  if (held.length === 0) {
    // §9.8: a chain opens at revision "1" — NOT "0". Quotes and statuses
    // number differently (a status genesis is sequence "0") and assuming one
    // convention for both is a mistake the validator catches only by accident:
    // `readSignedQuote` forbids a predecessor on revision 1, so a wrong first
    // number here would read as "unreadable" for the wrong reason.
    //
    // A supplier handing a buyer revision 4 out of nowhere is asking to be
    // believed about three revisions that buyer has never seen, every one of
    // which could have carried a different price. `previous_quote_digest` is
    // already required past revision 1 by the validator, so the only check
    // this layer owes is that the chain STARTS where the buyer can see it.
    if (BigInt(quote.quote_revision) !== 1n) {
      return {
        outcome: 'fork',
        detail: `quote: first revision seen is ${quote.quote_revision}, expected 1 — the chain before it was never presented`,
      };
    }
    const applied = args.repository.append({
      supplierDid: args.supplierDid,
      quoteId: quote.quote_id,
      quote,
      acceptedAt: args.nowMs,
    });
    return applied
      ? { outcome: 'applied', revision: quote.quote_revision }
      : duplicateOrFork(args.repository, args.supplierDid, quote);
  }

  // `at(-1)`, not an indexed cast. The cast would be a true statement about a
  // non-empty array and an untrue one to a reader, who cannot tell it from the
  // casts WS-0.7 forbids — the ones that assert a wire shape nobody checked.
  const head = held.at(-1);
  if (head === undefined) {
    throw new BuyerQuoteIntegrityError('quote chain reported rows and returned none');
  }
  if (quote.quote_digest === head.quote_digest) {
    return { outcome: 'duplicate', revision: head.quote_revision };
  }

  const succession = verifyQuoteRevisionExtends(head, quote);
  if (succession !== null) {
    return { outcome: 'fork', detail: succession, revision: head.quote_revision };
  }

  const applied = args.repository.append({
    supplierDid: args.supplierDid,
    quoteId: quote.quote_id,
    quote,
    acceptedAt: args.nowMs,
  });
  return applied
    ? { outcome: 'applied', revision: quote.quote_revision }
    : duplicateOrFork(args.repository, args.supplierDid, quote);
}

/**
 * An append that lost its insert. Either the same revision arrived twice, or
 * the supplier emitted a SECOND revision at that number — and those are
 * exactly the two cases a receiver must tell apart.
 */
function duplicateOrFork(
  repository: BuyerQuoteRepository,
  supplierDid: string,
  quote: SignedQuote,
): BuyerQuoteIngest {
  const reread = repository.chain(supplierDid, quote.quote_id);
  const atRevision = reread.find((entry) => entry.quote_revision === quote.quote_revision);
  if (atRevision !== undefined && atRevision.quote_digest === quote.quote_digest) {
    return { outcome: 'duplicate', revision: atRevision.quote_revision };
  }
  return {
    outcome: 'fork',
    detail: `quote: revision ${quote.quote_revision} is already held with a different digest — supplier fork (§9.8)`,
    ...(reread.at(-1) === undefined ? {} : { revision: String(reread.at(-1)?.quote_revision) }),
  };
}
