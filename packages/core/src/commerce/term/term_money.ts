/**
 * Shelf money after agreement goes through the Commerce Pack
 * (COMMITMENT_KERNEL §12, §15 step 1). The kernel binds a shelf deal; the
 * pack runs its settlements and acknowledgements, so both wait on
 * `money()`: an active first-party Commerce Pack on this node.
 *
 * A DEAL needs the pack before it binds. A Slot-only brand starts no
 * negotiation and, if it loses the pack midway, sends no counter and raises
 * no card until the pack is back. A Slot-only store may negotiate; its
 * decision card says the pack must be installed first, a yes without it is
 * refused, and the brand gets the usual rejection.
 *
 * The owner may remove the pack at any time (the two sides may settle a month
 * between themselves). The records stay; what arrives meanwhile is held for
 * 30 days, lands if the pack is back by then, and is refused after.
 */

import { liveTermSettlements, termAgreementStatus } from './term_agreements';
import { TERM_TIMINGS, type TermContext } from './term_context';

/** May money documents move on this node now? */
export function settlesHere(ctx: TermContext): boolean {
  return ctx.deps.moneyAvailable();
}

export const COMMERCE_PACK_NEEDED = 'the Commerce Pack is not active on this node';

/**
 * Shelf deals with settlement work still open on this node, for the warning
 * before the owner removes the Commerce Pack. Information, never a block. A
 * deal counts while it is proposed and still decidable (the store's card is
 * up, or the brand's proposal is still being resent), has not ended or ended
 * less than the hold window ago (its last settlement may still come), or has
 * a settlement received and not yet answered; and a settlement or
 * acknowledgement held for the pack counts until its hold ends.
 */
export function openShelfDeals(ctx: TermContext): number {
  const nowMs = ctx.now();
  const open = new Set<string>();
  for (const held of ctx.store.listHeld('prerequisite')) {
    if (held.kind !== 'term_settlement' && held.kind !== 'term_settlement_ack') continue;
    if (held.expiresAt > nowMs) open.add(held.proposalDigest);
  }
  for (const row of ctx.store.listByKind('term_agreement_proposal')) {
    const status = termAgreementStatus(ctx.store, row.recordDigest);
    if (status.state === 'proposed') {
      const decidable =
        row.direction === 'inbound'
          ? ctx.store
              .cardsForRequest(row.requestId)
              .some(
                (card) =>
                  card.refDigest === row.recordDigest &&
                  card.state === 'pending' &&
                  card.decideBy > nowMs,
              )
          : ctx.store.getOutbox(row.recordDigest)?.receiptOutcome !== 'refused' &&
            row.createdAt + TERM_TIMINGS.agreementResendForMs > nowMs;
      if (decidable) open.add(row.recordDigest);
      continue;
    }
    if (status.state !== 'accepted') continue;
    const unanswered = liveTermSettlements(ctx.store, row.recordDigest).some(
      (entry) =>
        entry.row.direction === 'inbound' &&
        ctx.store.answersTo(entry.note.settlement_digest, 'settlement_ack').length === 0,
    );
    if (unanswered || Date.parse(status.endsAt) + TERM_TIMINGS.heldForMs > nowMs)
      open.add(row.recordDigest);
  }
  return open.size;
}
