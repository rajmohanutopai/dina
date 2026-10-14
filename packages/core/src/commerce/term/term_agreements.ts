/**
 * Term agreements (SHELF_SPACE_NEGOTIATION §5.5–5.6) — ONE definition of
 * where an agreement stands, what counts as a holding, and which
 * settlements, terminations and acknowledgements it admits. Both the inbound
 * verifiers and the authoring paths call these, the revenue-share ledger's
 * discipline: a node never authors what its counterparty will refuse.
 *
 * STATES (§5.5). *Accepted* once a decision exists; *in force* from `start`;
 * *ended* at `end`, or at a termination's `effective_at` if earlier. An
 * accepted agreement counts as a holding from acceptance until it ends —
 * before it starts too, so two future deals cannot both slip under a cap.
 *
 * RENEWAL (§5.5) differs from revenue-share supersession on purpose: the
 * renewed agreement stays in force until its own `end`, and the renewal and
 * the agreement it replaces count as ONE holding.
 */

import {
  computeTermAgreementFold,
  deriveTermSchedule,
  findTermPeriod,
  verifyTermSettlement,
  verifyTermTerminationNotice,
  type AgreementTermination,
  type SettlementNote,
  type TermAgreementProposal,
  type TermFoldResult,
} from '@dina/commerce-protocol';

import {
  readTermAckRow,
  readTermDecisionRow,
  readTermProposalRow,
  readTermSettlementRow,
  readTermTerminationRow,
} from './term_rehydrate';

import type { TermManualHolding } from './term_policy';
import type { TermDocumentRow, TermStore } from './term_store';

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type TermAgreementStatus =
  | { state: 'none' }
  | { state: 'proposed'; proposal: TermAgreementProposal; row: TermDocumentRow }
  | { state: 'rejected'; proposal: TermAgreementProposal; row: TermDocumentRow }
  | {
      state: 'accepted';
      proposal: TermAgreementProposal;
      row: TermDocumentRow;
      acceptedAt: string;
      /** When it ends, or ended: `end`, or an earlier termination's effect. */
      endsAt: string;
      /**
       * Until when it holds the slot for new deals: as `endsAt`, except that a
       * termination this node sent counts only once the other side stored it.
       * Until then a refusal could still restore the deal, so the slot stays
       * taken and no second agreement can overlap it (§7.1).
       */
      heldUntil: string;
      /** A termination is on record (it may take effect later). */
      terminated: boolean;
    };

/**
 * A document this node sent that the other side refused (§5.3): it never took
 * effect there, so it takes none here either, or the two sides' folds part —
 * a refused termination would end the deal on one side only.
 */
function refusedByPeer(store: TermStore, row: TermDocumentRow): boolean {
  return (
    row.direction === 'outbound' && store.getOutbox(row.recordDigest)?.receiptOutcome === 'refused'
  );
}

/**
 * Where an agreement stands, from this node's own rows. The decider is never
 * the proposer: an inbound proposal pairs with an outbound decision and the
 * reverse, enforced by direction, so a party cannot accept its own proposal.
 */
export function termAgreementStatus(store: TermStore, proposalDigest: string): TermAgreementStatus {
  const row = store.getDocument(proposalDigest);
  const proposal = readTermProposalRow(row);
  if (row === null || proposal === null) return { state: 'none' };
  const decisionRow = store
    .answersTo(proposalDigest, 'agreement_decision')
    .find((d) => d.direction !== row.direction && !refusedByPeer(store, d));
  const decision = decisionRow === undefined ? null : readTermDecisionRow(decisionRow);
  if (decision === null) return { state: 'proposed', proposal, row };
  if (decision.kind === 'rejected') return { state: 'rejected', proposal, row };
  let endsAt = Date.parse(proposal.general.end);
  let heldUntil = endsAt;
  let terminated = false;
  for (const tRow of store.answersTo(proposalDigest, 'agreement_termination')) {
    const termination = readTermTerminationRow(tRow);
    if (termination === null || refusedByPeer(store, tRow)) continue;
    terminated = true;
    const effective = Date.parse(termination.effective_at);
    endsAt = Math.min(endsAt, effective);
    const confirmed =
      tRow.direction === 'inbound' ||
      store.getOutbox(tRow.recordDigest)?.receiptOutcome === 'stored';
    if (confirmed) heldUntil = Math.min(heldUntil, effective);
  }
  return {
    state: 'accepted',
    proposal,
    row,
    acceptedAt: decision.decided_at,
    endsAt: new Date(endsAt).toISOString(),
    heldUntil: new Date(heldUntil).toISOString(),
    terminated,
  };
}

/** The instant an accepted agreement ends earlier than its `end`, if it does. */
export function endedEarlyAt(
  status: Extract<TermAgreementStatus, { state: 'accepted' }>,
): string | undefined {
  return Date.parse(status.endsAt) < Date.parse(status.proposal.general.end)
    ? status.endsAt
    : undefined;
}

// ---------------------------------------------------------------------------
// Holdings (§5.4)
// ---------------------------------------------------------------------------

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Every agreement THIS store accepted as host, with its status. */
export function hostAgreements(
  store: TermStore,
  selfDid: string,
): Extract<TermAgreementStatus, { state: 'accepted' }>[] {
  const out: Extract<TermAgreementStatus, { state: 'accepted' }>[] = [];
  for (const row of store.listByKind('term_agreement_proposal')) {
    const status = termAgreementStatus(store, row.recordDigest);
    if (status.state === 'accepted' && status.proposal.host_did === selfDid) out.push(status);
  }
  return out;
}

/**
 * The first agreement in a renewal chain: follow `replaces_proposal_digest`
 * back while the agreement it names is on record. Bounded by the chain's
 * length (each step is a distinct stored digest), so a cycle cannot loop.
 */
export function lineageRoot(store: TermStore, proposalDigest: string): string {
  let current = proposalDigest;
  const seen = new Set<string>([current]);
  for (;;) {
    const proposal = readTermProposalRow(store.getDocument(current));
    const previous = proposal?.replaces_proposal_digest;
    if (previous === undefined || seen.has(previous) || store.getDocument(previous) === null)
      return current;
    seen.add(previous);
    current = previous;
  }
}

/**
 * The holding count for a deal with tag `tag` over [start, end) (§5.4): the
 * other commitments with that tag whose term overlaps it — agreements this
 * store accepted and has not ended (started or not), plus manual holdings.
 * A renewal and the agreement it replaces count once: `renews` names the
 * agreement a renewal replaces, which is then not counted against it.
 */
export function termHoldingCount(args: {
  store: TermStore;
  selfDid: string;
  manualHoldings: readonly TermManualHolding[];
  tag: string;
  start: string;
  end: string;
  nowMs: number;
  renews?: string;
}): number {
  const start = Date.parse(args.start);
  const end = Date.parse(args.end);
  // A renewal chain is ONE holding: count distinct chains, each named by the
  // first agreement in it. The chain the new deal renews is not counted.
  const excluded = args.renews === undefined ? null : lineageRoot(args.store, args.renews);
  const chains = new Set<string>();
  for (const status of hostAgreements(args.store, args.selfDid)) {
    if (status.proposal.general.tag !== args.tag) continue;
    if (Date.parse(status.heldUntil) <= args.nowMs) continue; // ended
    if (!overlaps(Date.parse(status.proposal.general.start), Date.parse(status.heldUntil), start, end))
      continue;
    const root = lineageRoot(args.store, status.proposal.proposal_digest);
    if (root !== excluded) chains.add(root);
  }
  let count = chains.size;
  for (const holding of args.manualHoldings) {
    if (holding.tag !== args.tag) continue;
    if (Date.parse(holding.end) <= args.nowMs) continue;
    if (overlaps(Date.parse(holding.start), Date.parse(holding.end), start, end)) count += 1;
  }
  return count;
}

/**
 * Is the resource free over [start, end) (§7.1 step 6)? No accepted, unended
 * agreement and no manual holding that names it may overlap. The agreement
 * a renewal replaces is ignored: it ends exactly where the renewal starts.
 */
export function termResourceFree(args: {
  store: TermStore;
  selfDid: string;
  manualHoldings: readonly TermManualHolding[];
  resourceRef: string;
  start: string;
  end: string;
  nowMs: number;
  renews?: string;
}): boolean {
  const start = Date.parse(args.start);
  const end = Date.parse(args.end);
  for (const status of hostAgreements(args.store, args.selfDid)) {
    if (status.proposal.resource_ref !== args.resourceRef) continue;
    if (status.proposal.proposal_digest === args.renews) continue;
    if (Date.parse(status.heldUntil) <= args.nowMs) continue;
    if (overlaps(Date.parse(status.proposal.general.start), Date.parse(status.heldUntil), start, end))
      return false;
  }
  for (const holding of args.manualHoldings) {
    if (holding.resource_ref !== args.resourceRef) continue;
    if (overlaps(Date.parse(holding.start), Date.parse(holding.end), start, end)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Settlements (§5.6)
// ---------------------------------------------------------------------------

/** The live note per period: those no revision has replaced. */
export function liveTermSettlements(
  store: TermStore,
  proposalDigest: string,
): { row: TermDocumentRow; note: SettlementNote }[] {
  const replaced = new Set<string>();
  const notes: { row: TermDocumentRow; note: SettlementNote }[] = [];
  for (const row of store.listByProposal(proposalDigest, 'settlement_note')) {
    const note = readTermSettlementRow(row);
    if (note === null || refusedByPeer(store, row)) continue;
    if (note.replaces_settlement_digest !== undefined)
      replaced.add(note.replaces_settlement_digest);
    notes.push({ row, note });
  }
  return notes.filter((entry) => !replaced.has(entry.note.settlement_digest));
}

/**
 * The rules a settlement note owes a term agreement, shared by inbound
 * verification and authoring. Ending is not forgetting (§5.5): a note for a
 * period inside the agreement's lifetime is still accepted after it ends; a
 * period outside it is refused because the schedule does not contain it.
 *
 * A correction supersedes by revision and covers the same period — except
 * that, for a period a termination cut, a correction may move the note's
 * end back to the ended instant (§5.6).
 */
export function checkTermSettlement(args: {
  store: TermStore;
  note: SettlementNote;
  status: Extract<TermAgreementStatus, { state: 'accepted' }>;
}): string | null {
  const { note, status, store } = args;
  const endedAt = endedEarlyAt(status);
  const pair = verifyTermSettlement({
    note,
    proposal: status.proposal,
    ...(endedAt !== undefined ? { endedAt } : {}),
  });
  if (pair !== null) return pair;
  const live = liveTermSettlements(store, note.proposal_digest);
  if (note.replaces_settlement_digest !== undefined) {
    const replaced = live.find(
      (entry) => entry.note.settlement_digest === note.replaces_settlement_digest,
    );
    if (replaced === undefined) return 'the revision replaces a settlement that is not live';
    if (replaced.note.period_start !== note.period_start)
      return 'a revision must cover the period it corrects';
    if (replaced.note.period_end === note.period_end) return null;
    // The one permitted move: back to the cut instant of a termination.
    return endedAt !== undefined &&
      Date.parse(note.period_end) === Date.parse(endedAt) &&
      Date.parse(replaced.note.period_end) > Date.parse(endedAt)
      ? null
      : 'a revision must cover the period it corrects';
  }
  const from = Date.parse(note.period_start);
  const to = Date.parse(note.period_end);
  const clash = live.some((entry) =>
    overlaps(Date.parse(entry.note.period_start), Date.parse(entry.note.period_end), from, to),
  );
  return clash ? 'the period overlaps a live settlement — supersede it by revision' : null;
}

/** Who issues settlements: the cash handler. */
export function cashHandlerDid(proposal: TermAgreementProposal): string {
  return proposal.general.cash_handler === 'host' ? proposal.host_did : proposal.vendor_did;
}

/** How the other side answered a settlement note, if it has (§5.6). */
export function settlementAnswer(
  store: TermStore,
  settlementDigest: string,
): 'accepted' | 'disputed' | null {
  const ackRow = store.answersTo(settlementDigest, 'settlement_ack')[0];
  const ack = ackRow === undefined ? null : readTermAckRow(ackRow);
  return ack === null ? null : ack.kind;
}

/**
 * The agreement's statement (§5.6): the signed fold over ACCEPTED live
 * notes. For a period a termination cut, the fee that counts is the cut
 * fee even while the old note is still live (until its correction lands); a
 * note for a period the termination removed counts for nothing.
 */
export function termStatement(store: TermStore, proposalDigest: string): TermFoldResult {
  const status = termAgreementStatus(store, proposalDigest);
  if (status.state !== 'accepted')
    return { ok: false, error: `no settled agreement: ${status.state}` };
  const settlements: { gross_minor: string; share_minor: string; fee_minor: string }[] = [];
  for (const entry of liveTermSettlements(store, proposalDigest)) {
    if (settlementAnswer(store, entry.note.settlement_digest) !== 'accepted') continue;
    const fee = countedFee(status, entry.note);
    if (fee === null) continue;
    settlements.push({
      gross_minor: entry.note.gross_sales.minor_units,
      share_minor: entry.note.computed_share.minor_units,
      fee_minor: fee,
    });
  }
  return computeTermAgreementFold({
    cash_handler: status.proposal.general.cash_handler,
    currency: status.proposal.general.currency,
    settlements,
  });
}

/**
 * The fee a live note counts for in the statement, or null when its period is
 * not in the schedule as it now stands. A note accepted before a termination
 * arrived may name a period the termination removed (it starts at or after
 * the end): that period no longer exists, so its rent is not owed. A note
 * that spans the end counts the cut period's fee (§5.6).
 */
function countedFee(
  status: Extract<TermAgreementStatus, { state: 'accepted' }>,
  note: SettlementNote,
): string | null {
  const fee = note.fee_due?.minor_units ?? '0';
  const endedAt = endedEarlyAt(status);
  if (endedAt === undefined || Date.parse(note.period_end) <= Date.parse(endedAt)) return fee;
  if (Date.parse(note.period_start) >= Date.parse(endedAt)) return null;
  const schedule = deriveTermSchedule({
    general: status.proposal.general,
    terms: status.proposal.terms,
    endedAt,
  });
  return findTermPeriod(schedule, note.period_start, endedAt)?.fee_due_minor ?? null;
}

// ---------------------------------------------------------------------------
// Terminations (§5.5)
// ---------------------------------------------------------------------------

export function checkTermTermination(args: {
  termination: AgreementTermination;
  status: TermAgreementStatus;
}): string | null {
  const { termination, status } = args;
  if (status.state !== 'accepted') return `termination of a ${status.state} agreement`;
  if (termination.protocol_version !== status.proposal.protocol_version) {
    return '§9.13 — a conversation pins one protocol version';
  }
  if (Date.parse(status.endsAt) <= Date.parse(termination.terminated_at))
    return 'the agreement has already ended';
  return verifyTermTerminationNotice({
    general: status.proposal.general,
    terminatedAt: termination.terminated_at,
    effectiveAt: termination.effective_at,
  });
}
