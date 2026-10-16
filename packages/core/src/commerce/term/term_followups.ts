/**
 * What follows a term agreement (SHELF_SPACE_NEGOTIATION §5.5–5.6): the
 * decision, terminations, settlements and acknowledgements — the revenue-
 * share documents, pinned to a TERM proposal and checked by the term rules.
 *
 * Inbound verification and authoring call the SAME checks
 * (`checkTermTermination`, `checkTermSettlement`), so this node never
 * authors a document its counterparty will refuse. A document whose
 * prerequisite has not arrived yet — a settlement before the decision, a
 * cut-period settlement before the termination that cut it — is HELD, not
 * refused (§5.3 "Order of arrival").
 */

import {
  computedShareMinor,
  deriveTermSchedule,
  revshareRecordDigest,
  termValues,
  validateAgreementTermination,
  validateSettlementAcknowledgement,
  validateSettlementNote,
  type AgreementDecision,
  type AgreementTermination,
  type SettlementAcknowledgement,
  type SettlementNote,
  type TermFoldResult,
} from '@dina/commerce-protocol';

import { judgeEndingArrival, trialWaiverArrivedLate } from '../../commitment';

import {
  cashHandlerDid,
  checkTermSettlement,
  checkTermTermination,
  liveTermSettlements,
  endedEarlyAt,
  termAgreementStatus,
  termStatement,
  type TermAgreementStatus,
} from './term_agreements';
import { noteTermDecision } from './term_buyer';
import { hash, iso, mintId, TERM_TIMINGS, type TermContext } from './term_context';
import { COMMERCE_PACK_NEEDED, settlesHere } from './term_money';
import { readTermSettlementRow } from './term_rehydrate';

import type { TermVerdict } from './term_seller';

function held(ctx: TermContext, requestId: string, proposalDigest: string): TermVerdict {
  return {
    outcome: 'held',
    reason: 'prerequisite',
    requestId,
    proposalDigest,
    expiresAt: ctx.now() + TERM_TIMINGS.heldForMs,
  };
}

function counterpartyOf(
  status: Extract<TermAgreementStatus, { state: 'accepted' }>,
  self: string,
): string {
  return status.proposal.host_did === self ? status.proposal.vendor_did : status.proposal.host_did;
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

/** The store's decision on this brand's proposal. */
export function admitTermDecision(
  ctx: TermContext,
  args: { senderDid: string; decision: AgreementDecision; evidenceJson: string },
): TermVerdict {
  const { decision } = args;
  const row = ctx.store.getDocument(decision.proposal_digest);
  if (row === null || row.kind !== 'term_agreement_proposal' || row.direction !== 'outbound') {
    return { outcome: 'refused', detail: 'no proposal of this node for this decision' };
  }
  if (row.counterpartyDid !== args.senderDid)
    return { outcome: 'refused', detail: 'the decision comes from another party' };
  const status = termAgreementStatus(ctx.store, decision.proposal_digest);
  if (status.state === 'none') return { outcome: 'refused', detail: 'the proposal cannot be read' };
  if (decision.protocol_version !== status.proposal.protocol_version) {
    return { outcome: 'refused', detail: '§9.13 — a conversation pins one protocol version' };
  }
  // The first answer stands.
  if (status.state !== 'proposed')
    return { outcome: 'refused', detail: 'the proposal already has a decision' };
  ctx.store.putDocument({
    recordDigest: decision.decision_digest,
    kind: 'agreement_decision',
    counterpartyDid: args.senderDid,
    requestId: row.requestId,
    proposalDigest: decision.proposal_digest,
    answersDigest: decision.proposal_digest,
    direction: 'inbound',
    recordJson: JSON.stringify(decision),
    evidenceJson: args.evidenceJson,
    createdAt: ctx.now(),
  });
  noteTermDecision(ctx, decision);
  return { outcome: 'stored', requestId: row.requestId, proposalDigest: decision.proposal_digest };
}

export function admitTermTermination(
  ctx: TermContext,
  args: {
    senderDid: string;
    termination: AgreementTermination;
    evidenceJson: string;
    /** First arrival at this node (a held termination keeps its own). */
    receivedAt: number;
  },
): TermVerdict {
  const { termination } = args;
  const arrival = judgeEndingArrival({
    signedAtMs: Date.parse(termination.terminated_at),
    receivedAtMs: args.receivedAt,
    windowMs: TERM_TIMINGS.terminationArrivalWindowMs,
    driftMs: TERM_TIMINGS.clockDriftMs,
  });
  if (arrival === 'dated_after_arrival')
    return { outcome: 'refused', detail: 'termination dated after it arrived' };
  if (arrival === 'dated_too_early')
    return { outcome: 'refused', detail: 'termination dated too long before it arrived' };
  const proposalRow = ctx.store.getDocument(termination.proposal_digest);
  if (proposalRow === null || proposalRow.kind !== 'term_agreement_proposal') {
    return { outcome: 'refused', detail: 'no term agreement for this termination' };
  }
  if (proposalRow.counterpartyDid !== args.senderDid)
    return { outcome: 'refused', detail: 'the sender is not a party of this agreement' };
  const status = termAgreementStatus(ctx.store, termination.proposal_digest);
  if (status.state === 'proposed')
    return held(ctx, proposalRow.requestId, termination.proposal_digest);
  const rule = checkTermTermination({ termination, status });
  if (rule !== null) return { outcome: 'refused', detail: rule };
  // The trial waives the notice. Its claim rests on `terminated_at`, which the
  // sender writes, so the receiver grants it only to a termination that reached
  // it before the trial ended: otherwise a party could date one into the trial
  // up to the arrival window later and end the deal with no notice at all. A
  // real one delayed past the end is refused on both sides; the owner ends the
  // deal again, with notice.
  const trialEnd = status.state === 'accepted' ? status.proposal.general.trial?.end : undefined;
  if (
    trialWaiverArrivedLate({
      signedAtMs: Date.parse(termination.terminated_at),
      trialEndMs: trialEnd === undefined ? undefined : Date.parse(trialEnd),
      receivedAtMs: args.receivedAt,
      driftMs: TERM_TIMINGS.clockDriftMs,
    })
  ) {
    return { outcome: 'refused', detail: 'a trial termination arrived after the trial ended' };
  }
  ctx.store.putDocument({
    recordDigest: termination.termination_digest,
    kind: 'agreement_termination',
    counterpartyDid: args.senderDid,
    requestId: proposalRow.requestId,
    proposalDigest: termination.proposal_digest,
    answersDigest: termination.proposal_digest,
    direction: 'inbound',
    recordJson: JSON.stringify(termination),
    evidenceJson: args.evidenceJson,
    createdAt: ctx.now(),
  });
  return {
    outcome: 'stored',
    requestId: proposalRow.requestId,
    proposalDigest: termination.proposal_digest,
  };
}

/**
 * Could this note be a cut period whose termination has not arrived yet? A
 * note that starts on a scheduled boundary and ends before that period's
 * end matches no slot until the termination lands; it waits for it.
 */
function awaitsTermination(
  status: Extract<TermAgreementStatus, { state: 'accepted' }>,
  note: SettlementNote,
): boolean {
  const schedule = deriveTermSchedule({
    general: status.proposal.general,
    terms: status.proposal.terms,
  });
  const from = Date.parse(note.period_start);
  const to = Date.parse(note.period_end);
  return schedule.some(
    (slot) => Date.parse(slot.start) === from && to > from && to < Date.parse(slot.end),
  );
}

export function admitTermSettlement(
  ctx: TermContext,
  args: { senderDid: string; note: SettlementNote; evidenceJson: string },
): TermVerdict {
  const { note } = args;
  const proposalRow = ctx.store.getDocument(note.proposal_digest);
  if (proposalRow === null || proposalRow.kind !== 'term_agreement_proposal') {
    return { outcome: 'refused', detail: 'no term agreement for this settlement' };
  }
  const status = termAgreementStatus(ctx.store, note.proposal_digest);
  if (status.state === 'proposed') return held(ctx, proposalRow.requestId, note.proposal_digest);
  if (status.state !== 'accepted')
    return { outcome: 'refused', detail: `settlement under a ${status.state} agreement` };
  if (args.senderDid !== cashHandlerDid(status.proposal))
    return { outcome: 'refused', detail: 'only the cash handler issues settlements' };
  // Money waits for the Commerce Pack (§12): held, so it lands once the pack
  // is active, or is refused when the hold runs out.
  if (!settlesHere(ctx)) return held(ctx, proposalRow.requestId, note.proposal_digest);
  // A correction that overtook the note it corrects waits for it (§5.3): a
  // note this node has never seen is "not yet arrived". One it holds and has
  // since seen superseded is checked, and refused, below.
  if (
    note.replaces_settlement_digest !== undefined &&
    ctx.store.getDocument(note.replaces_settlement_digest) === null
  )
    return held(ctx, proposalRow.requestId, note.proposal_digest);
  const rule = checkTermSettlement({ store: ctx.store, note, status });
  if (rule !== null) {
    // A note cut at an end this node has not heard of yet waits for that
    // termination — whether or not another one is on record already — as long
    // as its end falls before the agreement's end as this node knows it.
    if (
      awaitsTermination(status, note) &&
      Date.parse(note.period_end) < Date.parse(status.endsAt)
    )
      return held(ctx, proposalRow.requestId, note.proposal_digest);
    return { outcome: 'refused', detail: rule };
  }
  ctx.store.putDocument({
    recordDigest: note.settlement_digest,
    kind: 'settlement_note',
    counterpartyDid: args.senderDid,
    requestId: proposalRow.requestId,
    proposalDigest: note.proposal_digest,
    answersDigest: note.replaces_settlement_digest ?? '',
    direction: 'inbound',
    recordJson: JSON.stringify(note),
    evidenceJson: args.evidenceJson,
    createdAt: ctx.now(),
  });
  return {
    outcome: 'stored',
    requestId: proposalRow.requestId,
    proposalDigest: note.proposal_digest,
  };
}

export function admitTermSettlementAck(
  ctx: TermContext,
  args: { senderDid: string; ack: SettlementAcknowledgement; evidenceJson: string },
): TermVerdict {
  const { ack } = args;
  const noteRow = ctx.store.getDocument(ack.settlement_digest);
  // An acknowledgement answers a note THIS node issued, which this node
  // stored before sending — so a missing note is never "not yet arrived".
  if (noteRow === null || noteRow.kind !== 'settlement_note' || noteRow.direction !== 'outbound') {
    return { outcome: 'refused', detail: 'acknowledges no settlement this node issued' };
  }
  if (noteRow.counterpartyDid !== args.senderDid)
    return { outcome: 'refused', detail: 'only the other party acknowledges' };
  const note = readTermSettlementRow(noteRow);
  if (note === null || ack.protocol_version !== note.protocol_version) {
    return { outcome: 'refused', detail: '§9.13 — a conversation pins one protocol version' };
  }
  if (ctx.store.answersTo(ack.settlement_digest, 'settlement_ack').length > 0) {
    return { outcome: 'refused', detail: 'the settlement already has an acknowledgement' };
  }
  if (!settlesHere(ctx)) return held(ctx, noteRow.requestId, noteRow.proposalDigest);
  ctx.store.putDocument({
    recordDigest: ack.settlement_ack_digest,
    kind: 'settlement_ack',
    counterpartyDid: args.senderDid,
    requestId: noteRow.requestId,
    proposalDigest: noteRow.proposalDigest,
    answersDigest: ack.settlement_digest,
    direction: 'inbound',
    recordJson: JSON.stringify(ack),
    evidenceJson: args.evidenceJson,
    createdAt: ctx.now(),
  });
  return {
    outcome: 'stored',
    requestId: noteRow.requestId,
    proposalDigest: noteRow.proposalDigest,
  };
}

// ---------------------------------------------------------------------------
// Authoring (owner routes)
// ---------------------------------------------------------------------------

export type TermAuthorOutcome<T> = { ok: true; document: T } | { ok: false; refusal: string };

function storeAndSend(
  ctx: TermContext,
  args: {
    kind: 'agreement_termination' | 'settlement_note' | 'settlement_ack';
    pushKind: string;
    digest: string;
    document: unknown;
    to: string;
    requestId: string;
    proposalDigest: string;
    answers: string;
  },
): void {
  ctx.atomically('author', () => {
    ctx.store.putDocument({
      recordDigest: args.digest,
      kind: args.kind,
      counterpartyDid: args.to,
      requestId: args.requestId,
      proposalDigest: args.proposalDigest,
      answersDigest: args.answers,
      direction: 'outbound',
      recordJson: JSON.stringify(args.document),
      evidenceJson: '{}',
      createdAt: ctx.now(),
    });
    ctx.enqueue({
      toDid: args.to,
      kind: args.pushKind,
      digest: args.digest,
      document: args.document,
      stopAtMs: ctx.now() + TERM_TIMINGS.agreementResendForMs,
    });
  });
}

export function terminateTermAgreement(
  ctx: TermContext,
  args: { proposalDigest: string; effectiveAt?: string },
): TermAuthorOutcome<AgreementTermination> {
  const status = termAgreementStatus(ctx.store, args.proposalDigest);
  if (status.state !== 'accepted')
    return { ok: false, refusal: `termination of a ${status.state} agreement` };
  const nowMs = ctx.now();
  const draft = {
    protocol_version: status.proposal.protocol_version,
    termination_id: mintId('tterm'),
    proposal_digest: args.proposalDigest,
    effective_at: args.effectiveAt ?? iso(nowMs),
    terminated_at: iso(nowMs),
  };
  const termination = {
    ...draft,
    termination_digest: revshareRecordDigest('agreement_termination', draft, hash),
  } as AgreementTermination;
  const shape = validateAgreementTermination(termination, hash);
  if (shape !== null) return { ok: false, refusal: shape };
  const rule = checkTermTermination({ termination, status });
  if (rule !== null) return { ok: false, refusal: rule };
  storeAndSend(ctx, {
    kind: 'agreement_termination',
    pushKind: 'term_termination',
    digest: termination.termination_digest,
    document: termination,
    to: counterpartyOf(status, ctx.self()),
    requestId: status.row.requestId,
    proposalDigest: args.proposalDigest,
    answers: args.proposalDigest,
  });
  return { ok: true, document: termination };
}

/**
 * Issue a period's settlement — the cash handler's act. The share and the
 * fee are DERIVED (from `share_bps` and the period schedule), never
 * caller-supplied: a handler cannot round in its own favour by a paisa.
 */
export function issueTermSettlement(
  ctx: TermContext,
  args: {
    proposalDigest: string;
    periodStart: string;
    periodEnd: string;
    grossMinor: string;
    replacesSettlementDigest?: string;
  },
): TermAuthorOutcome<SettlementNote> {
  const status = termAgreementStatus(ctx.store, args.proposalDigest);
  if (status.state !== 'accepted')
    return { ok: false, refusal: `settlement under a ${status.state} agreement` };
  if (ctx.self() !== cashHandlerDid(status.proposal))
    return { ok: false, refusal: 'only the cash handler issues settlements' };
  if (!settlesHere(ctx)) return { ok: false, refusal: COMMERCE_PACK_NEEDED };
  if (!/^(0|[1-9]\d{0,14})$/.test(args.grossMinor))
    return { ok: false, refusal: 'gross must be a minor-unit integer' };
  const currency = status.proposal.general.currency;
  const endedAt = endedEarlyAt(status);
  const schedule = deriveTermSchedule({
    general: status.proposal.general,
    terms: status.proposal.terms,
    ...(endedAt !== undefined ? { endedAt } : {}),
  });
  const slot = schedule.find(
    (s) =>
      Date.parse(s.start) === Date.parse(args.periodStart) &&
      Date.parse(s.end) === Date.parse(args.periodEnd),
  );
  if (slot === undefined)
    return { ok: false, refusal: 'the period is not one the agreement schedules' };
  const shareBps = Number(termValues(status.proposal.terms).share_bps);
  const draft = {
    protocol_version: status.proposal.protocol_version,
    settlement_id: mintId('tstl'),
    proposal_digest: args.proposalDigest,
    period_start: slot.start,
    period_end: slot.end,
    gross_sales: { currency, minor_units: args.grossMinor },
    computed_share: {
      currency,
      minor_units: computedShareMinor(BigInt(args.grossMinor), shareBps).toString(10),
    },
    fee_due: { currency, minor_units: slot.fee_due_minor },
    ...(args.replacesSettlementDigest !== undefined
      ? { replaces_settlement_digest: args.replacesSettlementDigest }
      : {}),
    issued_at: iso(ctx.now()),
  };
  const note = {
    ...draft,
    settlement_digest: revshareRecordDigest('settlement_note', draft, hash),
  } as SettlementNote;
  const shape = validateSettlementNote(note, hash);
  if (shape !== null) return { ok: false, refusal: shape };
  const rule = checkTermSettlement({ store: ctx.store, note, status });
  if (rule !== null) return { ok: false, refusal: rule };
  storeAndSend(ctx, {
    kind: 'settlement_note',
    pushKind: 'term_settlement',
    digest: note.settlement_digest,
    document: note,
    to: counterpartyOf(status, ctx.self()),
    requestId: status.row.requestId,
    proposalDigest: args.proposalDigest,
    answers: note.replaces_settlement_digest ?? '',
  });
  return { ok: true, document: note };
}

/** Accept or dispute a period's figures — never a record of payment (§5.6). */
export function acknowledgeTermSettlement(
  ctx: TermContext,
  args: { settlementDigest: string; kind: 'accepted' | 'disputed' },
): TermAuthorOutcome<SettlementAcknowledgement> {
  const row = ctx.store.getDocument(args.settlementDigest);
  if (row === null || row.kind !== 'settlement_note' || row.direction !== 'inbound') {
    return { ok: false, refusal: 'no received settlement with that digest' };
  }
  const note = readTermSettlementRow(row);
  if (note === null) return { ok: false, refusal: 'the settlement cannot be read' };
  if (ctx.store.answersTo(args.settlementDigest, 'settlement_ack').length > 0) {
    return {
      ok: false,
      refusal: 'the settlement already has an acknowledgement — the first answer stands',
    };
  }
  if (!settlesHere(ctx)) return { ok: false, refusal: COMMERCE_PACK_NEEDED };
  const draft = {
    protocol_version: note.protocol_version,
    settlement_ack_id: mintId('tsack'),
    settlement_digest: args.settlementDigest,
    kind: args.kind,
    acknowledged_at: iso(ctx.now()),
  };
  const ack = {
    ...draft,
    settlement_ack_digest: revshareRecordDigest('settlement_ack', draft, hash),
  } as SettlementAcknowledgement;
  const shape = validateSettlementAcknowledgement(ack, hash);
  if (shape !== null) return { ok: false, refusal: shape };
  storeAndSend(ctx, {
    kind: 'settlement_ack',
    pushKind: 'term_settlement_ack',
    digest: ack.settlement_ack_digest,
    document: ack,
    to: row.counterpartyDid,
    requestId: row.requestId,
    proposalDigest: row.proposalDigest,
    answers: args.settlementDigest,
  });
  return { ok: true, document: ack };
}

/** The agreement's statement and its unanswered settlements, for the owner's screens. */
export function termAgreementView(
  ctx: TermContext,
  proposalDigest: string,
): { status: TermAgreementStatus['state']; statement: TermFoldResult; unanswered: string[] } {
  const status = termAgreementStatus(ctx.store, proposalDigest);
  const unanswered =
    status.state === 'accepted'
      ? liveTermSettlements(ctx.store, proposalDigest)
          .filter(
            (entry) =>
              ctx.store.answersTo(entry.note.settlement_digest, 'settlement_ack').length === 0,
          )
          .map((entry) => entry.note.settlement_digest)
      : [];
  return { status: status.state, statement: termStatement(ctx.store, proposalDigest), unanswered };
}
