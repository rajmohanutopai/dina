/**
 * Evidence wired to this node (COMMITMENT_KERNEL §13, §15 step 8): the store
 * on the identity database; the facts of a run that ended without fault
 * recorded on both nodes; a "did it happen?" card for each promise the other
 * side owed and each run it took up, the owner's answer recorded as
 * evidence; and the per-relationship consent both owners give before a
 * summary may be shared. The record and the summary are `evidence.ts`.
 */

import { appendAudit } from '../audit/service';
import { deliveryDayOf } from '../commerce/deal_kinds';
import { getCommerceRuntime } from '../commerce/runtime';
import { getD2DSender, sendOutcomeOf } from '../server/routes/d2d_msg';
import { getOwnerTimeZone } from '../settings/owner_settings';
import { WorkflowTaskKind, WorkflowTaskState } from '../workflow/domain';
import { getWorkflowService } from '../workflow/service';

import {
  describePromise,
  EvidenceStore,
  evidenceId,
  occurrencesDue,
  type EvidenceSubject,
} from './evidence';
import { getSellerOptionStore, getShipperOptionStore } from './option_handler';
import { localDateOf, type OptionLink } from './options';

import type { DatabaseAdapter } from '../storage/db_adapter';
import type { ApprovalDecisionHandler, WorkflowHooks } from '../workflow/service';

export const CONSENT_MESSAGE = 'commitment.consent';
export const EVIDENCE_ASK_TYPE = 'evidence_ask';

let store: EvidenceStore | null = null;

/** Storage boot installs it on the identity database; null in tests that do not. */
export function installEvidenceStore(db: DatabaseAdapter | null): void {
  store = db === null ? null : new EvidenceStore(db);
}

export function getEvidenceStore(): EvidenceStore | null {
  return store;
}

/**
 * A run that ended without fault after binding (§6 step 6): recorded with no
 * party at fault, with the facts this node kept — on the seller's node its
 * acceptance time, last send and the shipper's answer; on the shipper's, the
 * answer it gave.
 */
export function recordRunLapse(args: {
  counterpartyDid: string;
  dealRef: string;
  optionId: string;
  occurrence: string;
  facts: Record<string, string>;
  nowMs: number;
}): void {
  store?.record({
    counterpartyDid: args.counterpartyDid,
    dealRef: args.dealRef,
    subject: 'run',
    item: args.optionId,
    occurrence: args.occurrence,
    outcome: 'no_fault',
    fault: 'none',
    source: 'protocol',
    note: '',
    facts: args.facts,
    recordedAt: args.nowMs,
  });
}

/** The seller's side of a lapse, from its link. */
export function recordLinkLapse(link: OptionLink, nowMs: number): void {
  if (link.option === null) return;
  recordRunLapse({
    counterpartyDid: link.shipperDid,
    dealRef: link.dealRef,
    optionId: link.option.option_id,
    occurrence: link.option.service_at.slice(0, 10),
    facts: {
      accepted_at: link.acceptedAt === null ? '' : new Date(link.acceptedAt).toISOString(),
      last_sent_at: link.lastSentAt === null ? '' : new Date(link.lastSentAt).toISOString(),
      answer: link.answer?.answer ?? '',
      answered_at: link.answer === null ? '' : new Date(link.answer.atMs).toISOString(),
    },
    nowMs,
  });
}

interface AskPayload {
  type: typeof EVIDENCE_ASK_TYPE;
  counterparty_did: string;
  deal_ref: string;
  subject: EvidenceSubject;
  item: string;
  occurrence: string;
}

/** Raise the card; true only when this call made it. */
function askCard(payload: AskPayload, description: string, nowMs: number): boolean {
  const workflow = getWorkflowService();
  const id = `evidence-${evidenceId({
    counterpartyDid: payload.counterparty_did,
    dealRef: payload.deal_ref,
    subject: payload.subject,
    item: payload.item,
    occurrence: payload.occurrence,
  })}`;
  if (workflow === null) return false;
  // Asked before and answered, but a crash came before the answer was kept:
  // a yes leaves the card queued, running or completed; a no cancels it (only
  // the owner's no cancels these cards). A card left to lapse records nothing.
  const card = workflow.store().getById(id);
  if (card !== null) {
    if (
      card.status === WorkflowTaskState.Queued ||
      card.status === WorkflowTaskState.Running ||
      card.status === WorkflowTaskState.Completed
    )
      recordAnswer(payload, id, true, nowMs);
    else if (card.status === WorkflowTaskState.Cancelled) recordAnswer(payload, id, false, nowMs);
    return false;
  }
  // Listed before the card is made: a crash between the two leaves a listed
  // ask with no card, which the tick drops and the next pass asks again; never
  // a card nobody follows up.
  store?.noteAsked(id, JSON.stringify(payload), nowMs);
  try {
    workflow.create({
      id,
      kind: WorkflowTaskKind.Approval,
      description,
      payload: JSON.stringify(payload),
      idempotencyKey: id,
      correlationId: payload.deal_ref,
      origin: 'system',
      initialState: WorkflowTaskState.PendingApproval,
    });
    return true;
  } catch {
    return false; // already asked
  }
}

/**
 * Ask the owner about what fell due: each run this node took up whose day is
 * past, and each promise the other side owed under a live shelf agreement on
 * a recent day. One card per thing due, never twice, none for what already
 * has a record.
 */
export async function runEvidenceTick(nowMs: number): Promise<number> {
  const evidence = store;
  if (evidence === null) return 0;
  let asked = 0;
  await tellConsents(nowMs);
  // Runs that ended without fault, on both sides: recorded with the facts
  // kept (first record wins, so a crash between steps loses nothing).
  for (const link of getSellerOptionStore()?.forState(['lapsed_no_fault']) ?? [])
    recordLinkLapse(link, nowMs);
  for (const issued of getShipperOptionStore()?.lateAnswers() ?? [])
    recordRunLapse({
      counterpartyDid: issued.sellerDid,
      dealRef: issued.option.request_id,
      optionId: issued.option.option_id,
      occurrence: issued.option.service_at.slice(0, 10),
      facts: {
        answer: issued.answer?.answer ?? '',
        answered_at: issued.answer === null ? '' : new Date(issued.answer.atMs).toISOString(),
      },
      nowMs,
    });
  const has = (p: Omit<AskPayload, 'type'>): boolean =>
    evidence.get(
      evidenceId({
        counterpartyDid: p.counterparty_did,
        dealRef: p.deal_ref,
        subject: p.subject,
        item: p.item,
        occurrence: p.occurrence,
      }),
    ) !== null;
  // Answers a crash kept from being recorded, settled from this family's own
  // list of the cards it raised (every one, whatever else the node holds, and
  // whatever the look-back window says of their day): a yes leaves a card
  // queued, running or completed; a no cancels it; a card gone or lapsed
  // records nothing.
  const workflow = getWorkflowService();
  if (workflow !== null)
    for (const ask of evidence.openAsks()) {
      const p = readAsk(ask.payloadJson);
      const card = workflow.store().getById(ask.cardId);
      if (p === null || card === null) {
        evidence.settleAsk(ask.cardId);
        continue;
      }
      if (card.status === WorkflowTaskState.PendingApproval) continue;
      if (has(p)) {
        // Recorded already; a yes whose card a crash left open is closed now.
        if (card.status === WorkflowTaskState.Queued || card.status === WorkflowTaskState.Running)
          recordAnswer(p, ask.cardId, true, nowMs);
        if (stillOpen(ask.cardId)) continue; // closing failed: tried again next tick
        evidence.settleAsk(ask.cardId);
        continue;
      }
      if (
        card.status === WorkflowTaskState.Queued ||
        card.status === WorkflowTaskState.Running ||
        card.status === WorkflowTaskState.Completed
      )
        recordAnswer(p, ask.cardId, true, nowMs);
      else if (card.status === WorkflowTaskState.Cancelled)
        recordAnswer(p, ask.cardId, false, nowMs);
      // Dropped only once both hold: the answer is kept, and the card is
      // closed. A card left to lapse (or ended otherwise) records nothing and
      // is dropped as it is.
      const answered =
        card.status === WorkflowTaskState.Queued ||
        card.status === WorkflowTaskState.Running ||
        card.status === WorkflowTaskState.Completed ||
        card.status === WorkflowTaskState.Cancelled;
      if (answered && (!has(p) || stillOpen(ask.cardId))) continue;
      evidence.settleAsk(ask.cardId);
    }
  // Runs the seller took up, a day after the run.
  for (const link of getSellerOptionStore()?.forState(['bound']) ?? []) {
    if (link.option === null) continue;
    if (nowMs < Date.parse(link.option.service_at) + 24 * 3600_000) continue;
    const p = {
      counterparty_did: link.shipperDid,
      deal_ref: link.dealRef,
      subject: 'run' as const,
      item: link.option.option_id,
      occurrence: link.option.service_at.slice(0, 10),
    };
    if (has(p)) continue;
    if (
      askCard(
        { type: EVIDENCE_ASK_TYPE, ...p },
        `Did your shipper run the delivery they promised for ${p.occurrence}? Yes records it kept; no records it broken.`,
        nowMs,
      )
    )
      asked += 1;
  }
  // Promises the other side owes under a live shelf agreement.
  const runtime = getCommerceRuntime();
  if (runtime !== null) {
    const zone = (await getOwnerTimeZone()).timezone;
    for (const agreement of runtime.terms.agreements()) {
      if (agreement.state !== 'accepted') continue;
      // A vendor is the buyer; a host, the seller. The other side's promises are those by its role.
      const theirs = agreement.role === 'host' ? 'buyer' : 'seller';
      const startMs = Date.parse(agreement.general.start);
      const endMs = Date.parse(agreement.endsAt ?? agreement.general.end);
      for (const promise of agreement.promises) {
        if (promise.by !== theirs) continue;
        const due = occurrencesDue({
          dimensions: promise.dimensions,
          startMs,
          endMs,
          nowMs,
          dayOf: (at) => deliveryDayOf(at, zone),
          dateOf: (at) => localDateOf(at, zone),
        });
        for (const occurrence of due) {
          const p = {
            counterparty_did: agreement.counterpartyDid,
            deal_ref: agreement.proposalDigest,
            subject: 'promise' as const,
            item: promise.name,
            occurrence,
          };
          if (has(p)) continue;
          if (
            askCard(
              { type: EVIDENCE_ASK_TYPE, ...p },
              occurrence === 'whole'
                ? `Did the other side keep their promise over your shelf deal: ${describePromise(promise)}? Yes records it kept; no records it broken.`
                : `Did the other side keep their promise on ${occurrence}: ${describePromise(promise)}? Yes records it kept; no records it broken.`,
              nowMs,
            )
          )
            asked += 1;
        }
      }
    }
  }
  return asked;
}

/** The owner's answer on a "did it happen?" card is the evidence; a card left to lapse records nothing. */
/** Is this card still left queued or running (a yes not yet closed)? */
function stillOpen(cardId: string): boolean {
  const status = getWorkflowService()?.store().getById(cardId)?.status;
  return status === WorkflowTaskState.Queued || status === WorkflowTaskState.Running;
}

/** A "did it happen?" card's payload, checked; null for any other card. */
function readAsk(payload: string): AskPayload | null {
  let p: Partial<AskPayload>;
  try {
    p = JSON.parse(payload) as Partial<AskPayload>;
  } catch {
    return null;
  }
  if (
    p.type !== EVIDENCE_ASK_TYPE ||
    typeof p.counterparty_did !== 'string' ||
    typeof p.deal_ref !== 'string' ||
    (p.subject !== 'promise' && p.subject !== 'run') ||
    typeof p.item !== 'string' ||
    typeof p.occurrence !== 'string'
  )
    return null;
  return p as AskPayload;
}

export const makeEvidenceDecisionHandler =
  (deps: { nowMs: () => number }): ApprovalDecisionHandler =>
  ({ task, decision }) => {
    let p: Partial<AskPayload>;
    try {
      p = JSON.parse(task.payload) as Partial<AskPayload>;
    } catch {
      return;
    }
    if (p.type !== EVIDENCE_ASK_TYPE || decision === 'lapsed') return;
    if (
      typeof p.counterparty_did !== 'string' ||
      typeof p.deal_ref !== 'string' ||
      (p.subject !== 'promise' && p.subject !== 'run') ||
      typeof p.item !== 'string' ||
      typeof p.occurrence !== 'string'
    )
      return;
    recordAnswer(p as AskPayload, task.id, decision === 'approved', deps.nowMs());
  };

/**
 * The owner's answer becomes the record, and a yes closes its card. First
 * record wins, so recording again after a crash is safe.
 */
function recordAnswer(p: AskPayload, taskId: string, kept: boolean, nowMs: number): void {
  store?.record({
    counterpartyDid: p.counterparty_did,
    dealRef: p.deal_ref,
    subject: p.subject,
    item: p.item,
    occurrence: p.occurrence,
    outcome: kept ? 'kept' : 'broken',
    fault: kept ? 'none' : 'counterparty',
    source: 'owner',
    note: '',
    facts: { answered_by: 'owner' },
    recordedAt: nowMs,
  });
  appendAudit('owner', 'evidence_recorded', p.deal_ref, `outcome=${kept ? 'kept' : 'broken'}`);
  if (!kept) return;
  const workflow = getWorkflowService();
  const task = workflow?.store().getById(taskId);
  try {
    if (task?.status === WorkflowTaskState.Queued)
      workflow
        ?.store()
        .transition(taskId, WorkflowTaskState.Queued, WorkflowTaskState.Running, nowMs);
    if (task?.status !== WorkflowTaskState.Completed)
      workflow?.complete(taskId, JSON.stringify({ recorded: 'kept' }), 'evidence recorded');
  } catch {
    /* already closed */
  }
}

/** Evidence's contribution to the workflow service, composed at every host. */
export function evidenceWorkflowHooks(over: { nowMs?: () => number } = {}): WorkflowHooks {
  return {
    responseEgressGate: () => ({ kind: 'passthrough' }),
    approvalDecisionHandler: makeEvidenceDecisionHandler({ nowMs: over.nowMs ?? Date.now }),
  };
}

/**
 * The owner turns sharing a summary on or off for one relationship, and the
 * other side is told. Nothing is shared until both have said yes.
 */
export async function setOwnerConsent(
  counterpartyDid: string,
  on: boolean,
  nowMs: number,
): Promise<boolean> {
  if (store === null) return false;
  store.setOwnConsent(counterpartyDid, on, nowMs);
  appendAudit('owner', 'evidence_consent', counterpartyDid, `on=${String(on)}`);
  await tellConsents(nowMs);
  return true;
}

/**
 * Tell each other side this node's current switch, until the sender takes it
 * (delivered, buffered or queued; no outcome and no throw counts as taken).
 * Run on each change and on the evidence tick.
 */
async function tellConsents(nowMs: number): Promise<void> {
  const sender = getD2DSender();
  if (store === null || sender === null) return;
  for (const { counterpartyDid, on, rev, ask, echo } of store.untold()) {
    try {
      const outcome = sendOutcomeOf(
        await sender(counterpartyDid, CONSENT_MESSAGE, {
          v: 1,
          on,
          rev,
          ...(ask !== '' ? { ask } : {}),
          ...(echo !== '' ? { reply_to: echo } : {}),
          at: new Date(nowMs).toISOString(),
        }),
      );
      if (outcome === undefined || outcome.delivered || outcome.buffered || outcome.queued)
        store.told(counterpartyDid, rev);
    } catch {
      /* sent again on the next tick */
    }
  }
}

/**
 * The other side's word on its own switch, kept only when newer than the last
 * kept (a delayed or replayed older word never undoes a newer one). Data,
 * never an instruction.
 */
export function handleConsentMessage(
  fromDid: string,
  raw: unknown,
  nowMs: number,
): 'kept' | 'refused' {
  const body = raw as {
    v?: unknown;
    on?: unknown;
    rev?: unknown;
    ask?: unknown;
    reply_to?: unknown;
  } | null;
  if (
    store === null ||
    body === null ||
    typeof body !== 'object' ||
    body.v !== 1 ||
    typeof body.on !== 'boolean' ||
    typeof body.rev !== 'number' ||
    !Number.isSafeInteger(body.rev) ||
    body.rev < 1
  )
    return 'refused';
  const NONCE = /^[0-9a-f]{32}$/;
  if (body.ask !== undefined && !(typeof body.ask === 'string' && NONCE.test(body.ask)))
    return 'refused';
  if (
    body.reply_to !== undefined &&
    !(typeof body.reply_to === 'string' && NONCE.test(body.reply_to))
  )
    return 'refused';
  // The other side restored from a backup and asks for this node's switch,
  // with a challenge: it is sent again on the next tick, echoing it.
  if (typeof body.ask === 'string') store.markAsked(fromDid, body.ask, nowMs);
  const replyTo = typeof body.reply_to === 'string' ? body.reply_to : '';
  return store.setPeerConsent(fromDid, body.on, body.rev, replyTo, nowMs) ? 'kept' : 'refused';
}

export interface EvidenceSweeperOptions {
  intervalMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** Asks about what fell due; started with the commerce ticks, on both hosts. */
export class EvidenceSweeper {
  private handle: unknown = null;
  private running = false;

  constructor(private readonly options: EvidenceSweeperOptions = {}) {}

  start(): void {
    if (this.handle !== null) return;
    const every = this.options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.handle = every(() => {
      void this.runTick().catch((err: unknown) => this.options.onError?.(err));
    }, this.options.intervalMs ?? 3_600_000);
    (this.handle as { unref?: () => void } | null)?.unref?.();
  }

  stop(): void {
    if (this.handle === null) return;
    const clear =
      this.options.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    clear(this.handle);
    this.handle = null;
  }

  async runTick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await runEvidenceTick((this.options.now ?? Date.now)());
    } finally {
      this.running = false;
    }
  }
}
