/**
 * QuoteFamily — the supplier-side quote aggregate (§9.8, §9.9, §16.2).
 *
 * WHY THIS EXISTS. The rules below used to live in whoever happened to
 * call the ledger: epoch monotonicity, immutable max_uses, expiry,
 * capacity, permanent voiding, and "valid_until advances with the head"
 * were spread across the admission engine, the revision verifier and two
 * repository methods, owned by none of them. That is shotgun surgery,
 * and it cost us a live defect: restore voided only UNEXPIRED heads, so
 * an expired pre-backup family survived, and a later revision could
 * extend it back to life on top of the backup's stale use counters —
 * capacity resurrected from a backup, the exact outcome §16.2 forbids.
 * Adding a fifth check would have left the same shape. Instead the
 * family now refuses illegal operations itself, and the scattered checks
 * are deleted.
 *
 * REFUSALS VS CORRUPTION. Expired / consumed / superseded / voided /
 * stale-epoch are ordinary business outcomes — they become wire
 * `reason_code`s a buyer must receive — so they are returned as typed
 * values, never thrown. Impossible state (a CAS that cannot fail
 * failing, a head whose retained quote receipt is missing) throws, so
 * the surrounding transaction rolls back rather than committing a half
 * decision.
 *
 * BOUNDARIES. The aggregate performs no SQL of its own beyond the
 * repository it is handed, and no network, signing or PDS work. It owns
 * only the capacity granted by THIS quote — real inventory remains
 * supplier/ERP authority. Cross-aggregate work (deciding an order AND
 * settling its hold) belongs to a transactional application service, not
 * here.
 */

import { isQuoteExpiredAt, type SignedQuote } from '@dina/commerce-protocol';

import type { CommerceQuoteHead, CommerceQuoteLedgerRepository } from './quote_ledger';

/**
 * Ordinary business outcomes. Each maps to a wire rejection reason; none
 * is an error condition for Core.
 */
export type QuoteRefusal =
  | 'quote_unknown'
  | 'quote_voided'
  | 'quote_expired'
  | 'quote_consumed'
  | 'quote_superseded'
  | 'stale_epoch'
  | 'future_epoch'
  | 'foreign_supplier'
  | 'foreign_audience'
  | 'duplicate_use'
  | 'revision_rejected';

/**
 * `detail` carries the precise supplier-facing reason when one exists —
 * the protocol's revision verifier produces sentences far more useful
 * than "revision_rejected", and flattening them into the enum threw away
 * diagnostics an operator needs. It is OPERATOR text: the wire
 * `reason_code` is derived from `refusal` alone, so nothing here leaks to
 * a counterparty.
 */
export type QuoteOutcome<T = void> =
  | { ok: true; value: T }
  | { ok: false; refusal: QuoteRefusal; detail?: string };

const refuse = (refusal: QuoteRefusal, detail?: string): QuoteOutcome<never> =>
  detail === undefined ? { ok: false, refusal } : { ok: false, refusal, detail };
const allow = <T>(value: T): QuoteOutcome<T> => ({ ok: true, value });

export interface QuoteFamilyDeps {
  ledger: CommerceQuoteLedgerRepository;
  /** Core's current commerce epoch; a quote must carry EXACTLY this. */
  currentEpoch: () => string;
  /**
   * The Business DID this Core signs as. A family in this ledger must be
   * this supplier's own quote — the identity check lives here rather than
   * in a caller because a plugin-supplied candidate reaches registration
   * through more than one path (initial, counterproposal, post-restore
   * re-offer) and every one of them must be bound.
   */
  supplierDid: string;
  now: () => number;
}

/**
 * Thrown for impossible state only. Never for a business refusal.
 * Callers run inside a transaction, so this rolls the work back.
 */
export class CommerceIntegrityError extends Error {
  constructor(message: string) {
    super(`commerce integrity: ${message}`);
    this.name = 'CommerceIntegrityError';
  }
}

/**
 * An instance is a SNAPSHOT of the head row, valid for the transaction
 * that loaded it. Reload after any operation that moves the head; holding
 * one across transactions would judge new work against an old head.
 */
export class QuoteFamily {
  private constructor(
    private readonly head: CommerceQuoteHead,
    private readonly deps: QuoteFamilyDeps,
  ) {}

  static load(deps: QuoteFamilyDeps, quoteId: string): QuoteFamily | null {
    const head = deps.ledger.getHead(quoteId);
    return head === null ? null : new QuoteFamily(head, deps);
  }

  get quoteId(): string {
    return this.head.quoteId;
  }
  get headDigest(): string {
    return this.head.headDigest;
  }
  get buyerDid(): string {
    return this.head.buyerDid;
  }
  /** Exposed so the "window advances with the head" rule is assertable. */
  get validUntil(): number {
    return this.head.validUntil;
  }

  /**
   * §16.2 epoch monotonicity, enforced HERE so no operation anywhere can
   * skip it. A head carrying an epoch below Core's current one belongs to
   * a pre-restore generation: its use counters came from a backup and are
   * untrustworthy, so the family is frozen regardless of whether it was
   * caught by expiry-based voiding.
   */
  private isStale(): boolean {
    return BigInt(this.head.supplierEpoch) < BigInt(this.deps.currentEpoch());
  }

  /**
   * Birth of a family (revision "1"). Binds supplier epoch at creation so
   * a family can never be born already stale.
   */
  /**
   * `expectedBuyerDid` is REQUIRED, not inferred from the quote. A runner
   * supplies the quote; the caller supplies who it is supposed to be for.
   * Making the expectation an argument is the difference between a rule
   * every path must satisfy and a rule every path must remember — the
   * audience check previously lived at call sites and was missed at the
   * second one (counterproposal fixed, re-offer not) and would have been
   * missed at the third.
   */
  static register(
    deps: QuoteFamilyDeps,
    quote: SignedQuote,
    expectedBuyerDid: string,
  ): QuoteOutcome<QuoteFamily> {
    if (quote.buyer_did !== expectedBuyerDid) return refuse('foreign_audience');
    // §9.12 — a quote candidate arrives from an UNTRUSTED runner. Every
    // field it carries that Core will authenticate has to be bound here,
    // because after registration the digest makes it Core's own word.
    if (quote.supplier_did !== deps.supplierDid) {
      return refuse('foreign_supplier');
    }
    // The epoch must be EXACTLY current, not merely "not stale". A
    // candidate that declares a FUTURE epoch outlives the next restore:
    // `isStale()` compares the head against the live epoch, so a head at
    // 999 stays "current" through a restore to 2 and its pre-restore use
    // counters survive — precisely the resurrection §16.2 forbids. Core
    // cannot rewrite the field either, since the digest covers it; the
    // only safe answer is to refuse and let the runner re-sign.
    const epoch = deps.currentEpoch();
    if (BigInt(quote.supplier_epoch) < BigInt(epoch)) return refuse('stale_epoch');
    if (BigInt(quote.supplier_epoch) > BigInt(epoch)) return refuse('future_epoch');
    const created = deps.ledger.registerHead({
      quoteId: quote.quote_id,
      buyerDid: quote.buyer_did,
      headDigest: quote.quote_digest,
      headRevision: quote.quote_revision,
      maxUses: quote.max_uses ?? '1',
      validUntil: Date.parse(quote.valid_until),
      supplierEpoch: quote.supplier_epoch,
      createdAt: deps.now(),
    });
    if (!created) {
      return refuse('revision_rejected', 'quote_id already registered — a family starts once');
    }
    const family = QuoteFamily.load(deps, quote.quote_id);
    if (family === null) {
      throw new CommerceIntegrityError('registered head is not readable back');
    }
    return allow(family);
  }

  /**
   * Advance to revision N+1. `retainedHead` is the quote record this
   * family's current head digest refers to; the caller loads it from the
   * receipt store because the aggregate does no I/O beyond its ledger.
   *
   * `verifyExtends` is the protocol's full revision contract, injected so
   * this aggregate stays free of protocol-package coupling beyond types.
   */
  advance(
    next: SignedQuote,
    retainedHead: SignedQuote,
    verifyExtends: (held: SignedQuote, next: SignedQuote) => string | null,
  ): QuoteOutcome {
    if (this.head.voided) return refuse('quote_voided');
    // Frozen generation: refuse BEFORE anything else so a stale family can
    // never be revived, expired or not. This is the ONE rule the protocol
    // verifier cannot check — it compares a revision to its predecessor
    // and knows nothing about Core's restore history.
    if (this.isStale()) return refuse('stale_epoch');
    // Everything else about "does N+1 extend N" — revision numbering,
    // audience, request binding, epoch regression WITHIN the chain,
    // max_uses immutability — belongs to the protocol verifier and is NOT
    // re-checked here. Re-checking scattered the rule once already, and a
    // local copy would answer with a vaguer message than the real one.
    // A revision is signed NOW, so it too must carry the live epoch
    // exactly — the same future-epoch escape exists on this path.
    if (next.supplier_did !== this.deps.supplierDid) return refuse('foreign_supplier');
    const epoch = this.deps.currentEpoch();
    if (BigInt(next.supplier_epoch) < BigInt(epoch)) return refuse('stale_epoch');
    if (BigInt(next.supplier_epoch) > BigInt(epoch)) return refuse('future_epoch');
    const violation = verifyExtends(retainedHead, next);
    if (violation !== null) return refuse('revision_rejected', violation);

    const advanced = this.deps.ledger.casAdvanceHead(this.head.quoteId, this.head.headDigest, {
      headDigest: next.quote_digest,
      headRevision: next.quote_revision,
      supplierEpoch: next.supplier_epoch,
      // The validity window moves WITH the head. Left behind, restore
      // voiding judges an extended quote by revision 1's deadline.
      validUntil: Date.parse(next.valid_until),
      updatedAt: this.deps.now(),
    });
    // A lost CAS is an ordinary concurrent-signing outcome, not corruption.
    return advanced
      ? allow(undefined)
      : refuse('revision_rejected', 'CAS at signing — concurrent revision won');
  }

  /**
   * The §9.9 admission precedence, in ONE place and in one order:
   * audience, voiding, epoch, supersession, retained record, expiry.
   * Split across a call site these drift — which is how the same order
   * could earn two different reason codes depending on which branch ran
   * first.
   *
   * `loadRetainedQuote` is supplied by the caller because the aggregate
   * does no I/O beyond its ledger; the accepted record is RETURNED so
   * the caller need not look it up twice and cannot accidentally judge
   * one record and then price another.
   *
   * Capacity is deliberately NOT checked here. §9.9 puts order-binding
   * verification between expiry and capacity, and capacity is a
   * check-and-act that belongs with the hold — see `hold`.
   */
  admits(
    order: { buyer_did: string; quote_digest: string },
    loadRetainedQuote: (digest: string) => SignedQuote | null,
    nowIso: string,
    honorSupersededRevisions: boolean,
  ): QuoteOutcome<SignedQuote> {
    // Audience binding (§9.8): non-disclosing, same shape as unknown.
    if (this.head.buyerDid !== order.buyer_did) return refuse('quote_unknown');
    if (this.head.voided) return refuse('quote_voided');
    if (this.isStale()) return refuse('stale_epoch');
    // Load and judge the NAMED revision before applying supersession
    // policy. §9.8 conditions the supersession answer on the revision
    // being "superseded but UNEXPIRED"; deciding supersession first made
    // an expired superseded revision report quote_superseded, so the
    // reason code depended on branch order rather than on the quote.
    const quote = loadRetainedQuote(order.quote_digest);
    if (quote === null) return refuse('quote_unknown');
    if (isQuoteExpiredAt(quote, nowIso)) return refuse('quote_expired');
    if (order.quote_digest !== this.head.headDigest && !honorSupersededRevisions) {
      return refuse('quote_superseded');
    }
    return allow(quote);
  }

  /**
   * Reserve one unit of THIS quote's capacity for one order.
   *
   * Check-and-act in a single method on purpose: a caller that reads
   * `activeUseCount` and then holds has a window between them, and the
   * two halves drifted apart once already. `max_uses` is read from the
   * head rather than from a caller-supplied record because the family
   * enforces its immutability across revisions — the head IS the
   * authority.
   */
  hold(purchaseOrderId: string): QuoteOutcome {
    if (this.head.voided) return refuse('quote_voided');
    if (this.isStale()) return refuse('stale_epoch');
    // Expiry is judged against the HEAD's window, which the family keeps
    // current. `admits` judges the record the order names, which may be an
    // honored superseded revision with a different deadline; capacity
    // belongs to the family, so the family's own deadline governs it. A
    // caller that skipped `admits` cannot reserve capacity on a dead quote.
    if (this.deps.now() > this.head.validUntil) return refuse('quote_expired');
    // "You already hold this" is checked BEFORE capacity, otherwise a
    // retry of the caller's OWN order reports quote_consumed once the
    // quote is single-use — blaming a competitor for capacity the caller
    // itself is holding.
    if (this.deps.ledger.getUse(this.head.quoteId, purchaseOrderId) !== null) {
      return refuse('duplicate_use');
    }
    if (BigInt(this.deps.ledger.activeUseCount(this.head.quoteId)) >= BigInt(this.head.maxUses)) {
      return refuse('quote_consumed');
    }
    const held = this.deps.ledger.holdUse(this.head.quoteId, purchaseOrderId, this.deps.now());
    // The ledger is the final authority: a hold that loses the race
    // between the check above and this insert is still a duplicate.
    return held ? allow(undefined) : refuse('duplicate_use');
  }

  /**
   * Settle a hold. A failed CAS here is IMPOSSIBLE STATE, not a business
   * outcome: the caller has already established the hold exists and is
   * inside the same transaction. Silently continuing is how an order gets
   * decided while its capacity stays held forever.
   */
  settle(purchaseOrderId: string, state: 'committed' | 'refunded'): void {
    const settled = this.deps.ledger.settleUse(
      this.head.quoteId,
      purchaseOrderId,
      state,
      this.deps.now(),
    );
    if (!settled) {
      throw new CommerceIntegrityError(
        `settlement CAS failed for ${this.head.quoteId} / ${purchaseOrderId} -> ${state}`,
      );
    }
  }
}

/**
 * The only production entry point to quote state. Handing out aggregates
 * rather than the repository is what stops a future call site reaching
 * past the rules — `QuoteFamily.advance()` is worthless if
 * `casAdvanceHead()` stays callable.
 */
export class QuoteFamilyStore {
  constructor(private readonly deps: QuoteFamilyDeps) {}

  /** The live commerce epoch, for callers that must stamp it durably. */
  currentEpoch(): string {
    return this.deps.currentEpoch();
  }

  load(quoteId: string): QuoteFamily | null {
    return QuoteFamily.load(this.deps, quoteId);
  }

  register(quote: SignedQuote, expectedBuyerDid: string): QuoteOutcome<QuoteFamily> {
    return QuoteFamily.register(this.deps, quote, expectedBuyerDid);
  }

  /**
   * §16.2 restore: mark the pre-restore families, and report how many, so
   * the restore-fence receipt records a real number.
   *
   * This marks by EXPIRY WINDOW, so it cannot see a family that had
   * already expired — which is exactly how an expired pre-backup family
   * once survived a restore and was revived by a later revision. The
   * durable guard is epoch monotonicity inside the aggregate, which needs
   * no sweep and cannot miss a row. This call remains because the restore
   * is an EVENT that must leave evidence, not because it is the fence.
   */
  voidPreRestore(nowMs: number): number {
    return this.deps.ledger.voidUnexpired(nowMs, nowMs);
  }
}
