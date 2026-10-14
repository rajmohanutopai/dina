/**
 * The term engine (SHELF_SPACE_NEGOTIATION §5.3, §7) — one facade over the
 * seller, buyer and agreement modules, owning the three things they share:
 *
 *   - INGRESS: every inbound term push is routed to its verifier, and every
 *     document with a digest is ANSWERED with a receipt (`stored`, `held`,
 *     `refused`). A resend gets the current answer; a held document that
 *     later settles pushes a fresh receipt; a final answer is never
 *     replaced.
 *   - THE GATE: whether a document may cross between this node and a peer
 *     who is not a contact. Every term document binds to something this
 *     node already holds with that peer — except a first request, which
 *     binds to a listing this node publishes. Nothing wider (§5.3 "First
 *     contact with a stranger").
 *   - THE SWEEP: resends, give-ups, expired holds, lapsed cards and the
 *     brand's loop, all driven by the clock.
 */

import {
  deriveTermSchedule,
  validateAgreementDecision,
  validateAgreementTermination,
  validateSettlementAcknowledgement,
  validateSettlementNote,
  validateTermAgreementProposal,
  validateTermCounter,
  validateTermOffer,
  validateTermReceipt,
  validateTermRequest,
  type AgreementDecision,
  type AgreementTermination,
  type SettlementAcknowledgement,
  type SettlementNote,
  type TermAgreementProposal,
  type Term,
  type TermCounter,
  type TermGeneral,
  type TermListing,
  type TermOffer,
  type TermReceipt,
  type TermReceiptOutcome,
  type TermRequest,
  checkProtocolVersion,
} from '@dina/commerce-protocol';

import {
  endedEarlyAt,
  liveTermSettlements,
  settlementAnswer,
  termAgreementStatus,
} from './term_agreements';
import {
  admitTermOffer,
  decideTermProposalCard,
  negotiationOffer,
  lapseProposalCard,
  rankTermOffers,
  startTermNegotiation,
  stepTermNegotiation,
  TERM_PROPOSAL_CARD,
  type RankedTermOffer,
  type StartTermOutcome,
} from './term_buyer';
import { hash, iso, mintId, TermContext, TERM_TIMINGS, type TermEngineDeps } from './term_context';
import {
  acknowledgeTermSettlement,
  admitTermDecision,
  admitTermSettlement,
  admitTermSettlementAck,
  admitTermTermination,
  issueTermSettlement,
  terminateTermAgreement,
  termAgreementView,
} from './term_followups';
import { validateTermPolicy, type TermListingAccess, type TermPolicy } from './term_policy';
import {
  legacyTermAccess,
  readStoredTermBody,
  readTermCardPayloadJson,
  readTermListingJson,
  readTermProposalRow,
  termPolicyJsonWithoutAccess,
} from './term_rehydrate';
import {
  admitTermCounter,
  admitTermProposal,
  admitTermRequest,
  composeTermListing,
  currentTermPolicy,
  decideFloorCard,
  decideTermProposal,
  lapseDecisionCard,
  publishedListingFor,
  raiseStrangerCard,
  storeTermListing,
  TERM_DECISION_CARD,
  TERM_FLOOR_CARD,
  TERM_STRANGER_CARD,
  withdrawTermListing,
  listingsOutsidePolicy,
  type TermListingInput,
  type TermVerdict,
} from './term_seller';

import type { TermHeldRow, TermOutboxRow } from './term_store';

/** Every `commerce.trade` kind the term engine owns. */
export const TERM_PUSH_KINDS = [
  'term_request',
  'term_offer',
  'term_counter',
  'term_receipt',
  'term_proposal',
  'term_decision',
  'term_termination',
  'term_settlement',
  'term_settlement_ack',
] as const;
export type TermPushKind = (typeof TERM_PUSH_KINDS)[number];

export function isTermPushKind(kind: string): kind is TermPushKind {
  return (TERM_PUSH_KINDS as readonly string[]).includes(kind);
}

/** The informational card raised once when resends run out (§5.3). */
export const TERM_DELIVERY_FAILED_CARD = 'term_delivery_failed';

/** Every card type the engine raises, for the inbox, presence gate and Brain redaction. */
export const TERM_CARD_TYPES: readonly string[] = [
  TERM_STRANGER_CARD,
  TERM_FLOOR_CARD,
  TERM_DECISION_CARD,
  TERM_PROPOSAL_CARD,
  TERM_DELIVERY_FAILED_CARD,
];

/** Documents that follow an agreement; a refusal of one is the owner's to hear about. */
const AGREEMENT_FOLLOW_UPS: ReadonlySet<string> = new Set([
  'term_decision',
  'term_termination',
  'term_settlement',
  'term_settlement_ack',
]);

/** The digest field each push kind's document carries. */
const DIGEST_FIELD: Readonly<Record<TermPushKind, string>> = {
  term_request: 'request_digest',
  term_offer: 'offer_digest',
  term_counter: 'counter_digest',
  term_receipt: 'receipt_digest',
  term_proposal: 'proposal_digest',
  term_decision: 'decision_digest',
  term_termination: 'termination_digest',
  term_settlement: 'settlement_digest',
  term_settlement_ack: 'settlement_ack_digest',
};

const SHAPE: Readonly<Record<TermPushKind, (value: unknown) => string | null>> = {
  term_request: (v) => validateTermRequest(v, hash),
  term_offer: (v) => validateTermOffer(v, hash),
  term_counter: (v) => validateTermCounter(v, hash),
  term_receipt: (v) => validateTermReceipt(v, hash),
  term_proposal: (v) => validateTermAgreementProposal(v, hash),
  term_decision: (v) => validateAgreementDecision(v, hash),
  term_termination: (v) => validateAgreementTermination(v, hash),
  term_settlement: (v) => validateSettlementNote(v, hash),
  term_settlement_ack: (v) => validateSettlementAcknowledgement(v, hash),
};

function claimedDigest(kind: TermPushKind, document: unknown): string | null {
  if (document === null || typeof document !== 'object') return null;
  const value = (document as Record<string, unknown>)[DIGEST_FIELD[kind]];
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function protocolVersionOf(document: unknown): string {
  const value =
    document !== null && typeof document === 'object'
      ? (document as { protocol_version?: unknown }).protocol_version
      : undefined;
  return typeof value === 'string' && /^\d+\.\d+$/.test(value) ? value : '1.0';
}

export interface TermIngressResult {
  outcome: 'applied' | 'duplicate' | 'held' | 'refused' | 'unreadable' | 'unavailable';
  kind: string;
  detail?: string;
}

/**
 * Where a document this node sent stands (§5.3 "Cards"): sent and not yet
 * answered; held by the other side ("waiting on the other side"); delivered;
 * refused; or not delivered once resends ran out without a final receipt.
 */
export type TermDelivery = 'sent' | 'waiting' | 'delivered' | 'refused' | 'not_delivered';

export function termDelivery(row: TermOutboxRow | null): TermDelivery | null {
  if (row === null) return null;
  if (row.receiptOutcome === 'stored') return 'delivered';
  if (row.receiptOutcome === 'refused') return 'refused';
  if (row.gaveUpAt !== null) return 'not_delivered';
  return row.receiptOutcome === 'held' ? 'waiting' : 'sent';
}

export type TermCardDecision = { ok: true } | { ok: false; refusal: string };

/** A listing this store made, and whether the directory may still hold its record. */
export interface TermListingView {
  listing: TermListing;
  state: 'published' | 'withdrawn';
  recordPublic: boolean;
  /** Who may ask about it (§6.2); the owner's own setting, never published. */
  access: TermListingAccess;
}

export class TermEngine {
  readonly ctx: TermContext;

  constructor(deps: TermEngineDeps) {
    this.ctx = new TermContext(deps);
  }

  // -------------------------------------------------------------------------
  // Ingress
  // -------------------------------------------------------------------------

  /** One inbound term push from a transport-authenticated sender. */
  ingest(args: {
    senderDid: string;
    kind: TermPushKind;
    document: unknown;
    evidenceJson: string;
  }): TermIngressResult {
    const { kind, document } = args;
    if (kind === 'term_receipt') return this.ingestReceipt(args.senderDid, document);
    const digest = claimedDigest(kind, document);
    // §9.13: a document at a major this build does not speak is refused,
    // whatever its shape — its digest may be named, but not its meaning.
    const shape =
      SHAPE[kind](document) ??
      (checkProtocolVersion(protocolVersionOf(document)) === null
        ? null
        : `unsupported protocol version ${protocolVersionOf(document)}`);
    if (shape !== null) {
      // A document whose digest field reads is answered `refused`; one with no
      // readable digest cannot be named, so it is only dropped. A digest that
      // already has an answer keeps it: a body that fails here (a corrupted
      // resend, another major) never changes what was decided, and the
      // current answer goes back as for any resend.
      if (digest !== null) {
        this.ctx.atomically('refuse_shape', () => {
          const existing = this.ctx.store.getAnswer(digest);
          if (existing !== null) {
            this.ctx.sendReceipt({
              toDid: args.senderDid,
              ofDigest: digest,
              outcome: existing.outcome,
              protocolVersion: protocolVersionOf(document),
            });
          } else {
            this.answer(args.senderDid, kind, digest, 'refused', protocolVersionOf(document));
          }
        });
      }
      return { outcome: 'unreadable', kind, detail: shape };
    }
    // One transaction from the replay check to the answer: a crash part-way
    // leaves nothing, so the resend that follows is decided afresh rather than
    // meeting a stored request with no answer and minting a second offer.
    return this.ctx.atomically('ingest', () => {
      const existing = this.ctx.store.getAnswer(digest as string);
      if (existing !== null) {
        // A resend: the current answer, nothing re-decided.
        this.ctx.sendReceipt({
          toDid: args.senderDid,
          ofDigest: digest as string,
          outcome: existing.outcome,
          protocolVersion: protocolVersionOf(document),
        });
        return { outcome: 'duplicate', kind };
      }
      const receivedAt = this.ctx.now();
      const verdict = this.verify(
        args.senderDid,
        kind,
        document,
        args.evidenceJson,
        false,
        receivedAt,
      );
      return this.settle({
        senderDid: args.senderDid,
        kind,
        digest: digest as string,
        document,
        evidenceJson: args.evidenceJson,
        verdict,
        receivedAt,
      });
    });
  }

  private verify(
    senderDid: string,
    kind: TermPushKind,
    document: unknown,
    evidenceJson: string,
    ownerApproved: boolean,
    /** When the document first reached this node; a held one keeps its first arrival. */
    receivedAt: number,
  ): TermVerdict {
    const ctx = this.ctx;
    const base = { senderDid, evidenceJson, receivedAt };
    switch (kind) {
      case 'term_request':
        return admitTermRequest(ctx, { ...base, request: document as TermRequest, ownerApproved });
      case 'term_offer':
        return admitTermOffer(ctx, { ...base, offer: document as TermOffer });
      case 'term_counter':
        return admitTermCounter(ctx, { ...base, counter: document as TermCounter });
      case 'term_proposal':
        return admitTermProposal(ctx, { ...base, proposal: document as TermAgreementProposal });
      case 'term_decision':
        return admitTermDecision(ctx, { ...base, decision: document as AgreementDecision });
      case 'term_termination':
        return admitTermTermination(ctx, {
          ...base,
          termination: document as AgreementTermination,
        });
      case 'term_settlement':
        return admitTermSettlement(ctx, { ...base, note: document as SettlementNote });
      case 'term_settlement_ack':
        return admitTermSettlementAck(ctx, { ...base, ack: document as SettlementAcknowledgement });
      case 'term_receipt':
        return { outcome: 'refused', detail: 'receipts are not verified here' };
    }
  }

  /** Record a verdict: store or hold, answer, and let what it unblocks run. */
  private settle(args: {
    senderDid: string;
    kind: TermPushKind;
    digest: string;
    document: unknown;
    evidenceJson: string;
    verdict: TermVerdict;
    receivedAt: number;
  }): TermIngressResult {
    const { verdict } = args;
    const version = protocolVersionOf(args.document);
    if (verdict.outcome === 'held') {
      this.ctx.store.putHeld({
        recordDigest: args.digest,
        senderDid: args.senderDid,
        kind: args.kind,
        requestId: verdict.requestId,
        proposalDigest: verdict.proposalDigest,
        reason: verdict.reason,
        bodyJson: JSON.stringify(args.document),
        evidenceJson: args.evidenceJson,
        receivedAt: args.receivedAt,
        expiresAt: verdict.expiresAt,
      });
      if (verdict.reason === 'owner_card')
        raiseStrangerCard(this.ctx, args.document as TermRequest);
      this.answer(args.senderDid, args.kind, args.digest, 'held', version);
      return { outcome: 'held', kind: args.kind };
    }
    if (verdict.outcome === 'refused') {
      this.answer(args.senderDid, args.kind, args.digest, 'refused', version);
      this.afterRefusal(args.kind, args.document);
      return { outcome: 'refused', kind: args.kind, detail: verdict.detail };
    }
    this.answer(args.senderDid, args.kind, args.digest, 'stored', version);
    this.releaseHeld(verdict.requestId, verdict.proposalDigest);
    return { outcome: 'applied', kind: args.kind };
  }

  /** What every refusal of a document releases, whichever path refused it. */
  private afterRefusal(kind: string, document: unknown): void {
    if (kind === 'term_termination' && document !== null && typeof document === 'object')
      this.refuseNotesCutBy(document as AgreementTermination);
  }

  /**
   * A refused termination never comes: the settlements held for the cut it
   * would have made (ending at its `effective_at`) are refused now, not after
   * the 30-day hold, so their sender can issue the full period instead.
   */
  private refuseNotesCutBy(termination: AgreementTermination): void {
    for (const row of this.ctx.store.listHeld()) {
      if (row.kind !== 'term_settlement' || row.proposalDigest !== termination.proposal_digest)
        continue;
      const note = readStoredTermBody(row.bodyJson) as Partial<SettlementNote> | null;
      if (note === null || note.period_end === undefined) continue;
      if (Date.parse(note.period_end) !== Date.parse(termination.effective_at)) continue;
      this.ctx.store.removeHeld(row.recordDigest);
      this.answer(row.senderDid, row.kind, row.recordDigest, 'refused', protocolVersionOf(note));
    }
  }

  /** Record and send this node's answer; a held→final change pushes a fresh receipt. */
  private answer(
    senderDid: string,
    kind: string,
    digest: string,
    outcome: TermReceiptOutcome,
    protocolVersion: string,
  ): void {
    const changed = this.ctx.store.setAnswer({
      ofDigest: digest,
      senderDid,
      kind,
      outcome,
      nowMs: this.ctx.now(),
    });
    if (changed)
      this.ctx.sendReceipt({ toDid: senderDid, ofDigest: digest, outcome, protocolVersion });
  }

  /** Re-run documents held for a prerequisite that just arrived (§5.3). */
  private releaseHeld(requestId: string, proposalDigest: string): void {
    const queue: TermHeldRow[] = this.ctx.store.heldRelatedTo(requestId, proposalDigest);
    const seen = new Set<string>();
    while (queue.length > 0) {
      const row = queue.shift() as TermHeldRow;
      if (seen.has(row.recordDigest)) continue;
      seen.add(row.recordDigest);
      const released = this.retryHeld(row, false);
      if (released !== null)
        queue.push(...this.ctx.store.heldRelatedTo(released.requestId, released.proposalDigest));
    }
  }

  /** Try one held document again. Returns the stored verdict's keys when it settled as stored. */
  private retryHeld(
    row: TermHeldRow,
    ownerApproved: boolean,
  ): { requestId: string; proposalDigest: string } | null {
    const kind = row.kind;
    if (!isTermPushKindRow(kind)) return null;
    return this.ctx.atomically('held', () => {
      // A digest answered for good meanwhile is not re-decided: drop the hold.
      const answered = this.ctx.store.getAnswer(row.recordDigest);
      if (answered !== null && answered.outcome !== 'held') {
        this.ctx.store.removeHeld(row.recordDigest);
        return null;
      }
      const document = readStoredTermBody(row.bodyJson);
      const verdict = this.verify(
        row.senderDid,
        kind,
        document,
        row.evidenceJson,
        ownerApproved,
        row.receivedAt,
      );
      if (verdict.outcome === 'held') return null;
      this.ctx.store.removeHeld(row.recordDigest);
      const version = protocolVersionOf(document);
      if (verdict.outcome === 'refused') {
        this.answer(row.senderDid, kind, row.recordDigest, 'refused', version);
        this.afterRefusal(kind, document);
        return null;
      }
      this.answer(row.senderDid, kind, row.recordDigest, 'stored', version);
      return { requestId: verdict.requestId, proposalDigest: verdict.proposalDigest };
    });
  }

  private ingestReceipt(senderDid: string, document: unknown): TermIngressResult {
    const shape = validateTermReceipt(document, hash);
    if (shape !== null) return { outcome: 'unreadable', kind: 'term_receipt', detail: shape };
    const receipt = document as TermReceipt;
    const sent = this.ctx.store.getOutbox(receipt.of_digest);
    if (sent === null || sent.toDid !== senderDid) {
      return {
        outcome: 'refused',
        kind: 'term_receipt',
        detail: 'a receipt for nothing this node sent that peer',
      };
    }
    const nowMs = this.ctx.now();
    const next =
      receipt.outcome === 'held' ? nowMs + TERM_TIMINGS.heldResendEveryMs : sent.nextAttemptAt;
    // The receipt and what a refusal closes land together.
    this.ctx.atomically('receipt', () => {
      const row = this.ctx.store.recordReceipt(receipt.of_digest, receipt.outcome, nowMs, next);
      if (row !== null && row.receiptOutcome === 'refused')
        this.onRefused(row.kind, receipt.of_digest);
    });
    return { outcome: 'applied', kind: 'term_receipt' };
  }

  /** The other side refused something this node sent: close what waited on it. */
  private onRefused(kind: string, digest: string): void {
    const row = this.ctx.store.getDocument(digest);
    if (row === null) return;
    const nowMs = this.ctx.now();
    if (kind === 'term_request') {
      this.ctx.store.moveNegotiation({
        requestId: row.requestId,
        from: ['negotiating'],
        to: 'closed',
        nowMs,
        closeReason: 'refused',
      });
    } else if (kind === 'term_proposal') {
      this.ctx.store.moveNegotiation({
        requestId: row.requestId,
        from: ['proposed'],
        to: 'closed',
        nowMs,
        closeReason: 'refused',
      });
    } else if (AGREEMENT_FOLLOW_UPS.has(kind)) {
      // A refused decision, termination, settlement or acknowledgement took
      // effect on neither side (`refusedByPeer`): the owner who sent it is told,
      // or a deal they ended, or figures they sent, would quietly not count.
      this.raiseDeliveryFailed(digest, kind, 'refused');
    }
  }

  // -------------------------------------------------------------------------
  // Owner acts (each reached through an owner-only route)
  // -------------------------------------------------------------------------

  /** Replace the store's term policy (§5.4). Owner-only and presence-gated at the route. */
  setPolicy(policy: unknown): { ok: true; revision: number } | { ok: false; refusal: string } {
    const bad = validateTermPolicy(policy);
    if (bad !== null) return { ok: false, refusal: bad };
    return { ok: true, revision: this.ctx.store.putPolicy(JSON.stringify(policy), this.ctx.now()) };
  }

  policy(): TermPolicy {
    return currentTermPolicy(this.ctx);
  }

  withdrawListing(listingId: string): boolean {
    return withdrawTermListing(this.ctx, listingId);
  }

  /**
   * Published listings the policy or pack no longer backs (`listingsOutsidePolicy`).
   * Withdrawing them is the caller's, through `withdrawEverywhere`, so each runs
   * in its listing's write queue.
   */
  listingIdsOutsidePolicy(): string[] {
    return listingsOutsidePolicy(this.ctx);
  }

  /** Withdrawn listings whose public record may still stand. */
  listingsAwaitingRemoval(): { listingId: string; listingDigest: string }[] {
    return this.ctx.store
      .listListings()
      .filter((row) => row.state === 'withdrawn' && row.recordPublic)
      .map((row) => ({ listingId: row.listingId, listingDigest: row.listingDigest }));
  }

  startNegotiation(args: Parameters<typeof startTermNegotiation>[1]): StartTermOutcome {
    return startTermNegotiation(this.ctx, args);
  }

  terminate(args: {
    proposalDigest: string;
    effectiveAt?: string;
  }): ReturnType<typeof terminateTermAgreement> {
    return terminateTermAgreement(this.ctx, args);
  }

  issueSettlement(
    args: Parameters<typeof issueTermSettlement>[1],
  ): ReturnType<typeof issueTermSettlement> {
    return issueTermSettlement(this.ctx, args);
  }

  acknowledgeSettlement(args: {
    settlementDigest: string;
    kind: 'accepted' | 'disputed';
  }): ReturnType<typeof acknowledgeTermSettlement> {
    return acknowledgeTermSettlement(this.ctx, args);
  }

  agreement(proposalDigest: string): ReturnType<typeof termAgreementView> {
    return termAgreementView(this.ctx, proposalDigest);
  }

  ranked(): RankedTermOffer[] {
    return rankTermOffers(this.ctx);
  }

  composeListing(args: TermListingInput): ReturnType<typeof composeTermListing> {
    return composeTermListing(this.ctx, args);
  }

  storeListing(listing: TermListing, access: TermListingAccess): void {
    storeTermListing(this.ctx, listing, access);
  }

  // -------------------------------------------------------------------------
  // Read views for the owner's screens
  // -------------------------------------------------------------------------

  listings(): TermListingView[] {
    const out: TermListingView[] = [];
    for (const row of this.ctx.store.listListings()) {
      const listing = readTermListingJson(row.recordJson);
      if (listing !== null)
        out.push({ listing, state: row.state, recordPublic: row.recordPublic, access: row.access });
    }
    return out;
  }

  /**
   * Written before a publish sends its record, for a listing not published
   * here: withdrawn, with its record possibly public. Success overwrites it
   * (`storeListing`); a failed write — which may have landed all the same — or
   * a crash mid-write leaves it, and the sweeper removes whatever landed
   * (removing a record that never landed is harmless). A listing already
   * published keeps its row: its record is tracked, and a failed republish
   * answers the owner with an error.
   */
  markRecordMayStand(listing: TermListing): void {
    const existing = this.ctx.store.getListing(listing.listing_id);
    if (existing?.state === 'published') return;
    this.ctx.store.putListing({
      listingId: listing.listing_id,
      resourceRef: listing.resource_ref,
      recordJson: JSON.stringify(listing),
      listingDigest: listing.listing_digest,
      state: 'withdrawn',
      recordPublic: true,
      // A withdrawn row answers no request, so this only keeps what was set.
      access: existing?.access ?? 'contacts_or_card',
      updatedAt: this.ctx.now(),
    });
  }

  /**
   * A policy saved before schema v72 (or restored from such an archive)
   * carries one store-wide `access`. Move it onto every listing this store
   * has — `anyone` stays `anyone` — and save the policy without it. Run by
   * the sweep, so the first boot after an upgrade or a restore does it; a
   * no-op once done.
   */
  adoptLegacyAccess(): void {
    const stored = this.ctx.store.getPolicy();
    if (stored === null) return;
    const legacy = legacyTermAccess(stored.policyJson);
    if (legacy === null) return;
    this.ctx.atomically('adopt_access', () => {
      for (const row of this.ctx.store.listListings())
        this.ctx.store.putListing({ ...row, access: legacy });
      this.ctx.store.putPolicy(termPolicyJsonWithoutAccess(stored.policyJson), this.ctx.now());
    });
  }

  /** The directory confirmed this withdrawn listing's public record is gone. */
  listingRecordRemoved(listingId: string, listingDigest: string): void {
    this.ctx.store.markListingRecordRemoved(listingId, listingDigest, this.ctx.now());
  }

  negotiations(): {
    requestId: string;
    sellerDid: string;
    state: string;
    closeReason: string;
    deadlineAt: string;
    head: {
      offerDigest: string;
      revision: number;
      terms: Term[];
      general: TermGeneral;
      validUntil: string;
    } | null;
    pendingCardId: string | null;
    /** The brand's proposal, once the owner said yes (§5.3 "sent" → "delivered"). */
    proposalDelivery: TermDelivery | null;
  }[] {
    return this.ctx.store.listNegotiations().map((row) => {
      const proposal = this.ctx.store.listByRequest(row.requestId, 'term_agreement_proposal')[0];
      const head = negotiationOffer(this.ctx, row.requestId);
      const pending = this.ctx.store
        .cardsForRequest(row.requestId)
        .find((c) => c.state === 'pending');
      return {
        requestId: row.requestId,
        sellerDid: row.sellerDid,
        state: row.state,
        closeReason: row.closeReason,
        deadlineAt: iso(row.deadlineAt),
        head:
          head === null
            ? null
            : {
                offerDigest: head.offer_digest,
                revision: head.revision,
                terms: head.terms,
                general: head.general,
                validUntil: head.valid_until,
              },
        pendingCardId: pending?.cardId ?? null,
        proposalDelivery:
          proposal === undefined
            ? null
            : termDelivery(this.ctx.store.getOutbox(proposal.recordDigest)),
      };
    });
  }

  /** Every agreement this node is a party to, either side. */
  agreements(): {
    proposalDigest: string;
    role: 'host' | 'vendor';
    counterpartyDid: string;
    state: string;
    resourceRef: string;
    general: TermGeneral;
    terms: Term[];
    endsAt: string | null;
    /**
     * The document this side's yes sent: the vendor's proposal, or the host's
     * decision. Null when this side sent none (a host still deciding).
     */
    delivery: TermDelivery | null;
  }[] {
    const self = this.ctx.self();
    const out: ReturnType<TermEngine['agreements']> = [];
    for (const row of this.ctx.store.listByKind('term_agreement_proposal')) {
      const status = termAgreementStatus(this.ctx.store, row.recordDigest);
      if (status.state === 'none') continue;
      const role = status.proposal.host_did === self ? 'host' : 'vendor';
      const sent =
        role === 'vendor'
          ? row.recordDigest
          : this.ctx.store.answersTo(row.recordDigest, 'agreement_decision')[0]?.recordDigest;
      out.push({
        proposalDigest: row.recordDigest,
        role,
        counterpartyDid: role === 'host' ? status.proposal.vendor_did : status.proposal.host_did,
        state: status.state,
        resourceRef: status.proposal.resource_ref,
        general: status.proposal.general,
        terms: status.proposal.terms,
        endsAt: status.state === 'accepted' ? status.endsAt : null,
        delivery: sent === undefined ? null : termDelivery(this.ctx.store.getOutbox(sent)),
      });
    }
    return out;
  }

  /** The agreement's period schedule, with the live settlement of each period, if any (§5.6). */
  schedule(proposalDigest: string): {
    start: string;
    end: string;
    kind: string;
    feeDueMinor: string;
    settlementDigest: string | null;
    /**
     * That note's own figures — what the owner accepts or disputes, so they
     * are shown before either (owner-only, like the rest of this view).
     */
    figures: {
      grossSalesMinor: string;
      computedShareMinor: string;
      feeDueMinor: string | null;
      /**
       * The note's own end. Later than the period's `end` when a termination
       * cut the period after the note was sent: the note then needs a
       * correction to the cut instant (§5.6), whether or not it was accepted.
       */
      periodEnd: string;
    } | null;
    /** How the other side answered that note; a disputed one may be corrected. */
    answer: 'accepted' | 'disputed' | null;
  }[] {
    const status = termAgreementStatus(this.ctx.store, proposalDigest);
    if (status.state !== 'accepted') return [];
    const endedAt = endedEarlyAt(status);
    const live = liveTermSettlements(this.ctx.store, proposalDigest);
    return deriveTermSchedule({
      general: status.proposal.general,
      terms: status.proposal.terms,
      ...(endedAt !== undefined ? { endedAt } : {}),
    }).map((slot) => {
      const note =
        live.find((e) => Date.parse(e.note.period_start) === Date.parse(slot.start))?.note ?? null;
      const digest = note?.settlement_digest ?? null;
      return {
        start: slot.start,
        end: slot.end,
        kind: slot.kind,
        feeDueMinor: slot.fee_due_minor,
        settlementDigest: digest,
        figures:
          note === null
            ? null
            : {
                grossSalesMinor: note.gross_sales.minor_units,
                computedShareMinor: note.computed_share.minor_units,
                feeDueMinor: note.fee_due?.minor_units ?? null,
                periodEnd: note.period_end,
              },
        answer: digest === null ? null : settlementAnswer(this.ctx.store, digest),
      };
    });
  }

  // -------------------------------------------------------------------------
  // The gate (§5.3 first contact)
  // -------------------------------------------------------------------------

  /**
   * May this term document cross between this node and `peerDid`, who is not
   * a contact? Inbound: it must bind to a request, offer, proposal or note
   * this node holds WITH THAT PEER — or be a first request naming a listing
   * this node publishes, while no other request from that stranger waits on
   * the owner's card. Outbound: what this node sends it stored first, with
   * that peer as counterparty; a receipt answers something that peer sent.
   */
  gateAllows(args: {
    peerDid: string;
    kind: string;
    document: unknown;
    direction: 'inbound' | 'outbound';
  }): boolean {
    if (!isTermPushKind(args.kind) || args.document === null || typeof args.document !== 'object')
      return false;
    // A blocked peer is not a counterparty, whatever it can name: blocking
    // takes a DID off the contact list only, so this waiver must ask itself.
    if (this.ctx.deps.isBlocked(args.peerDid)) return false;
    const doc = args.document as Record<string, unknown>;
    const store = this.ctx.store;
    const str = (key: string): string => (typeof doc[key] === 'string' ? (doc[key] as string) : '');
    const heldWith = (digest: string): boolean => {
      const row = store.getDocument(digest);
      return row !== null && row.counterpartyDid === args.peerDid;
    };
    if (args.direction === 'outbound') {
      if (args.kind === 'term_receipt')
        return store.getAnswer(str('of_digest'))?.senderDid === args.peerDid;
      const own = claimedDigest(args.kind, doc);
      return own !== null && heldWith(own);
    }
    switch (args.kind) {
      case 'term_request': {
        if (str('buyer_did') !== args.peerDid) return false;
        // A resend of a request this node already answered for that peer only
        // replays the stored receipt (§5.3), whatever became of the listing
        // since: a lost receipt must not turn into "not delivered".
        if (store.getAnswer(str('request_digest'))?.senderDid === args.peerDid) return true;
        if (
          publishedListingFor(this.ctx, {
            listing_uri: str('listing_uri'),
            listing_digest: str('listing_digest'),
          }) === null
        )
          return false;
        const waiting = store.pendingStrangerRequest(args.peerDid);
        return waiting === null || waiting.recordDigest === str('request_digest');
      }
      case 'term_receipt':
        return store.sentTo(str('of_digest'), args.peerDid);
      case 'term_offer': {
        const request = store
          .listByRequest(str('request_id'), 'term_request')
          .find((r) => r.direction === 'outbound');
        return request !== undefined && request.counterpartyDid === args.peerDid;
      }
      case 'term_counter':
      case 'term_proposal': {
        const offer = store.getDocument(str('offer_digest'));
        return (
          offer !== null &&
          offer.kind === 'term_offer' &&
          offer.direction === 'outbound' &&
          offer.counterpartyDid === args.peerDid
        );
      }
      case 'term_decision': {
        const proposal = store.getDocument(str('proposal_digest'));
        return (
          proposal !== null &&
          proposal.direction === 'outbound' &&
          proposal.counterpartyDid === args.peerDid
        );
      }
      case 'term_termination':
      case 'term_settlement': {
        const proposal = store.getDocument(str('proposal_digest'));
        return (
          proposal !== null &&
          proposal.kind === 'term_agreement_proposal' &&
          proposal.counterpartyDid === args.peerDid
        );
      }
      case 'term_settlement_ack':
        return heldWith(str('settlement_digest'));
    }
  }

  // -------------------------------------------------------------------------
  // Owner cards
  // -------------------------------------------------------------------------

  /**
   * The owner's answer on a card, and what came of it. `ok: false` means the
   * answer did not do what the owner asked — the deal was no longer available,
   * the offer had expired, the card had lapsed — and says why, so the inbox
   * can show it rather than a plain "decided".
   *
   * One transaction from the decision to the record of what a yes came to
   * (`yes_outcome`): a crash before the inbox task is closed leaves the sweep
   * that outcome to close it with, never a "decided" card left to expire.
   */
  decideCard(cardId: string, approve: boolean): TermCardDecision {
    return this.ctx.atomically('decide_card', () => {
      const outcome = this.decideCardNow(cardId, approve);
      const recordable =
        outcome.ok || (outcome.refusal !== 'already_decided' && outcome.refusal !== 'unknown_card');
      if (approve && recordable)
        this.ctx.store.setCardYesOutcome(cardId, outcome.ok ? 'ok' : outcome.refusal);
      return outcome;
    });
  }

  private decideCardNow(cardId: string, approve: boolean): TermCardDecision {
    const card = this.ctx.store.getCard(cardId);
    if (card === null) return { ok: false, refusal: 'unknown_card' };
    switch (card.cardType) {
      case TERM_STRANGER_CARD:
        return this.decideStranger(cardId, approve);
      case TERM_FLOOR_CARD:
        return decideFloorCard(this.ctx, cardId, approve)
          ? { ok: true }
          : { ok: false, refusal: 'already_decided' };
      case TERM_DECISION_CARD: {
        const outcome = decideTermProposal(this.ctx, { cardId, approve });
        return outcome.ok ? { ok: true } : { ok: false, refusal: outcome.refusal };
      }
      case TERM_PROPOSAL_CARD: {
        const outcome = decideTermProposalCard(this.ctx, { cardId, approve });
        return outcome.ok ? { ok: true } : { ok: false, refusal: outcome.refusal };
      }
      case TERM_DELIVERY_FAILED_CARD:
        return this.ctx.store.decideCard(cardId, approve ? 'approved' : 'declined', this.ctx.now())
          ? { ok: true }
          : { ok: false, refusal: 'already_decided' };
      default:
        return { ok: false, refusal: 'unknown_card' };
    }
  }

  /**
   * A card that ran past its decide-by with no answer — from the sweep or the
   * workflow's own expiry, whichever sees it first; the second is a no-op.
   */
  lapseCard(cardId: string): void {
    const card = this.ctx.store.getCard(cardId);
    if (card === null || card.state !== 'pending') return;
    if (card.cardType === TERM_DECISION_CARD) lapseDecisionCard(this.ctx, cardId);
    else if (card.cardType === TERM_PROPOSAL_CARD) lapseProposalCard(this.ctx, cardId);
    // A stranger the owner never answered is refused (§6.2).
    else if (card.cardType === TERM_STRANGER_CARD) this.decideStranger(cardId, false);
    else this.ctx.store.decideCard(cardId, 'lapsed', this.ctx.now());
  }

  /**
   * The owner's answer and what it lets happen land together: a yes that was
   * recorded while its held request was never re-run would leave the request
   * waiting for a card nobody shows again.
   */
  private decideStranger(cardId: string, approve: boolean): TermCardDecision {
    return this.ctx.atomically('stranger', (): TermCardDecision => {
      const card = this.ctx.store.getCard(cardId);
      if (
        card === null ||
        !this.ctx.store.decideCard(cardId, approve ? 'approved' : 'declined', this.ctx.now())
      )
        return { ok: false, refusal: 'already_decided' };
      const held = this.ctx.store.getHeld(card.refDigest);
      if (held === null) return { ok: true };
      if (approve) {
        const released = this.retryHeld(held, true);
        if (released !== null) {
          this.releaseHeld(released.requestId, released.proposalDigest);
          return { ok: true };
        }
        // The yes let the request run, and it was refused all the same (the
        // slot taken meanwhile, the cap reached, renting off): not "decided".
        return this.ctx.store.getAnswer(held.recordDigest)?.outcome === 'refused'
          ? { ok: false, refusal: 'no_longer_available' }
          : { ok: true };
      }
      this.ctx.store.removeHeld(held.recordDigest);
      this.answer(
        held.senderDid,
        held.kind,
        held.recordDigest,
        'refused',
        protocolVersionOf(readStoredTermBody(held.bodyJson)),
      );
      return { ok: true };
    });
  }

  // -------------------------------------------------------------------------
  // The sweep
  // -------------------------------------------------------------------------

  /** One pass of everything the clock drives. Safe to run at any time, and at every start. */
  sweep(): { resent: number; gaveUp: number; released: number; lapsed: number; stepped: number } {
    this.adoptLegacyAccess();
    const nowMs = this.ctx.now();
    let resent = 0;
    let gaveUp = 0;
    for (const row of this.ctx.store.dueOutbox(nowMs, 100)) {
      if (nowMs > row.stopAt) {
        this.ctx.atomically('give_up', () => {
          this.ctx.store.giveUp(row.recordDigest, nowMs);
          this.raiseDeliveryFailed(row.recordDigest, row.kind, 'unanswered');
        });
        gaveUp += 1;
        continue;
      }
      const document = readStoredTermBody(row.documentJson);
      // Re-checked before it leaves again: a queued body edited after writing
      // is given up on, never resent.
      if (!isTermPushKind(row.kind) || SHAPE[row.kind](document) !== null) {
        this.ctx.store.giveUp(row.recordDigest, nowMs);
        continue;
      }
      const every =
        row.receiptOutcome === 'held' ? TERM_TIMINGS.heldResendEveryMs : TERM_TIMINGS.resendEveryMs;
      this.ctx.store.markAttempt(row.recordDigest, nowMs + every);
      this.ctx.resend(row.toDid, row.kind, document, row.recordDigest);
      resent += 1;
    }
    let released = 0;
    for (const row of this.ctx.store.listHeld()) {
      if (row.expiresAt <= nowMs) {
        this.ctx.atomically('hold_expired', () => {
          this.ctx.store.removeHeld(row.recordDigest);
          const body = readStoredTermBody(row.bodyJson);
          this.answer(row.senderDid, row.kind, row.recordDigest, 'refused', protocolVersionOf(body));
          this.afterRefusal(row.kind, body);
        });
        continue;
      }
      // At every start (and every sweep) a prerequisite or an active pack may
      // have appeared since: try once more.
      if (row.reason === 'prerequisite') {
        const settled = this.retryHeld(row, false);
        if (settled !== null) {
          released += 1;
          this.releaseHeld(settled.requestId, settled.proposalDigest);
        }
      }
    }
    // A card raised while the inbox was not there yet (early in a boot) is
    // raised now; raising one that exists is a no-op.
    for (const card of this.ctx.store.pendingCards()) {
      if (card.decideBy <= nowMs) continue;
      // An answer the inbox committed and the engine never heard (a crash
      // between the two): act on it now, then close the inbox task.
      const answered = this.ctx.deps.cards.answer?.(card.cardId) ?? null;
      if (answered !== null) {
        const outcome = this.decideCard(card.cardId, answered === 'approved');
        if (answered === 'approved')
          this.ctx.deps.cards.finish?.(card.cardId, outcome, this.ctx.now());
        continue;
      }
      const payload = readTermCardPayloadJson(card.payloadJson);
      if (payload !== null) {
        this.ctx.deps.cards.raise({
          cardId: card.cardId,
          type: card.cardType,
          description: card.description,
          payload,
          expiresAtMs: card.decideBy,
        });
      }
    }
    // A yes the engine acted on whose inbox task was never closed (a crash
    // between the two): close it now with what the yes came to.
    for (const card of this.ctx.store.cardsWithYesSince(nowMs - TERM_TIMINGS.heldForMs)) {
      if (this.ctx.deps.cards.answer?.(card.cardId) !== 'approved') continue;
      const outcome: TermCardDecision =
        card.yesOutcome === 'ok' ? { ok: true } : { ok: false, refusal: card.yesOutcome };
      this.ctx.deps.cards.finish?.(card.cardId, outcome, this.ctx.now());
    }
    let lapsed = 0;
    for (const card of this.ctx.store.lapsedCards(nowMs)) {
      lapsed += 1;
      this.lapseCard(card.cardId);
      this.ctx.deps.cards.close(card.cardId, 'lapsed');
    }
    let stepped = 0;
    for (const negotiation of this.ctx.store.dueNegotiations(nowMs)) {
      // A step that moves the loop to `ready` keeps the owner's card with it.
      this.ctx.atomically('step', () => stepTermNegotiation(this.ctx, negotiation.requestId));
      stepped += 1;
    }
    return { resent, gaveUp, released, lapsed, stepped };
  }

  private raiseDeliveryFailed(digest: string, kind: string, why: 'unanswered' | 'refused'): void {
    const row = this.ctx.store.getDocument(digest);
    const cardId = `term-undelivered-${digest.slice(0, 32)}`;
    const requestId = row?.requestId ?? '';
    const proposal =
      row === null ? null : readTermProposalRow(this.ctx.store.getDocument(row.proposalDigest));
    const payload = {
      type: TERM_DELIVERY_FAILED_CARD,
      card_id: cardId,
      request_id: requestId,
      kind,
      why,
      counterparty_did: row?.counterpartyDid ?? '',
      ...(proposal !== null ? { resource_ref: proposal.resource_ref } : {}),
    };
    this.ctx.raiseCard({
      cardId,
      type: TERM_DELIVERY_FAILED_CARD,
      requestId,
      refDigest: digest,
      description:
        why === 'refused'
          ? 'The other side refused a shelf-space message, so it did not take effect.'
          : 'A shelf-space message could not be delivered: the other side did not answer.',
      payload,
      decideBy: this.ctx.now() + TERM_TIMINGS.heldForMs,
    });
  }

  /** A fresh id, for routes that need one. */
  static mintListingId(): string {
    return mintId('slot');
  }
}

function isTermPushKindRow(kind: string): kind is Exclude<TermPushKind, 'term_receipt'> {
  return isTermPushKind(kind) && kind !== 'term_receipt';
}
