/**
 * The supplier's half of negotiation (NEGOTIATION_PLAN §4.3, §4.5).
 *
 * THREE SEAMS, and where each runs:
 *
 *   `admitInboundCounter`   — provider ingress, BEFORE any runner. Everything
 *                              Core can decide from its own records is decided
 *                              here: a replayed counter id gets the answer it
 *                              already got; a counter on a head that has moved
 *                              gets the current head; a closed quote, a
 *                              disabled policy, a spent round budget, a lapsed
 *                              window and a buyer past the daily cap are
 *                              refused. What passes reaches the runner with the
 *                              current quote beside the counter.
 *   `settleInboundCounter`  — the result transform, AFTER the runner. The
 *                              runner proposed unit prices; Core clamps each to
 *                              the owner's floors, asks the owner about any
 *                              line the runner wanted below the automatic
 *                              limit, and signs revision N+1 — or answers the
 *                              head unchanged when nothing moved down.
 *   `answerQuoteOutcomeInCore` — a not-awarded notice, answered by Core alone.
 *
 * THE FLOOR NEVER LEAVES CORE (§3 rule 1). No refusal a buyer can read names
 * one, the runner is never told one, and a revision below the hard floor
 * cannot be composed: the clamp runs on every line before signing.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  commerceRecordDigest,
  computeLineSubtotal,
  computeTotal,
  readCounterOffer,
  termsDigestInput,
  validateQuoteOutcomeNotice,
  validateSignedQuote,
  type CounterOffer,
  type Money,
  type Sha256Fn,
  type SignedQuote,
  type SignedQuoteLine,
} from '@dina/commerce-protocol';

import { appendAudit } from '../audit/service';
import { WorkflowTaskKind, WorkflowTaskState } from '../workflow/domain';
import { getWorkflowService } from '../workflow/service';

import {
  clampProposal,
  lineBounds,
  NEGOTIATION_PRICE_APPROVAL_TYPE,
  TENDER_READY_TYPE,
} from './negotiation_policy';
import { rehydrateSignedQuote } from './rehydrate';
import { getCommerceRuntime, type CommerceRuntime } from './runtime';

import type { SupplierNegotiationPolicy } from './negotiation_policy';
import type { ApprovalDecisionHandler, WorkflowHooks, WorkflowService } from '../workflow/service';

const hash: Sha256Fn = (data) => sha256(data);

/** A revision stands this long unless the head already stood longer. */
const REVISION_VALIDITY_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What a buyer is told when a counter is refused. Never a floor. */
export type CounterRefusal =
  | 'commerce_unavailable'
  | 'counter_invalid'
  | 'not_your_quote'
  | 'negotiation_off'
  | 'negotiation_closed'
  | 'counter_expired'
  | 'round_refused'
  | 'window_closed'
  | 'counter_limit'
  | 'terms_unusable'
  | 'revision_refused';

export type CounterAdmission =
  /** Ask the runner, with these params: the counter and the current quote. */
  | { kind: 'dispatch'; params: { counter: CounterOffer; current_quote: SignedQuote } }
  /** Core already has the answer (a replay, or a head that has moved). */
  | { kind: 'answer'; json: string }
  | { kind: 'refused'; refusal: CounterRefusal };

interface CounterContext {
  runtime: CommerceRuntime;
  counter: CounterOffer;
  head: SignedQuote;
  first: SignedQuote;
  policy: SupplierNegotiationPolicy;
}

/** The counter a buyer sent may arrive bare or beside the quote Core added. */
function counterOf(params: unknown): unknown {
  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    const record = params as Record<string, unknown>;
    if ('counter' in record) return record.counter;
  }
  return params;
}

/** Walk back from the head to revision 1, through retained receipts only. */
function firstRevision(runtime: CommerceRuntime, head: SignedQuote): SignedQuote | null {
  let current = head;
  for (let step = 0; step < 64; step += 1) {
    if (current.quote_revision === '1') return current;
    const previous = current.previous_quote_digest;
    if (previous === undefined) return null;
    const receipt = runtime.receipts.get(previous);
    if (receipt === null) return null;
    const read = rehydrateSignedQuote(receipt.recordJson, hash);
    if (!read.ok) return null;
    current = read.value;
  }
  return null;
}

function headQuote(runtime: CommerceRuntime, quoteId: string): SignedQuote | null {
  const family = runtime.families.load(quoteId);
  if (family === null) return null;
  const receipt = runtime.receipts.get(family.headDigest);
  if (receipt === null) return null;
  const read = rehydrateSignedQuote(receipt.recordJson, hash);
  return read.ok ? read.value : null;
}

function answerJson(quote: SignedQuote, outcome: 'revised' | 'held', pendingOwner = false): string {
  // `pending_owner` tells the buyer a lower price is before this supplier's
  // owner, so its loop may ask again rather than read the hold as final.
  // It says nothing about what that price is.
  return JSON.stringify(
    pendingOwner ? { quote, outcome, pending_owner: true } : { quote, outcome },
  );
}

/**
 * Everything checked against Core's records, in an order that never discloses
 * more than the caller is owed: identity and ownership first, so a stranger
 * learns only "not your quote", then the policy.
 */
function readCounterContext(
  params: unknown,
  buyerDid: string,
  nowMs: number,
): { ok: true; context: CounterContext } | { ok: false; refusal: CounterRefusal } {
  const runtime = getCommerceRuntime();
  if (runtime === null) return { ok: false, refusal: 'commerce_unavailable' };
  const read = readCounterOffer(counterOf(params), hash);
  if (!read.ok) return { ok: false, refusal: 'counter_invalid' };
  const counter = read.counter;
  let nodeDid: string;
  try {
    nodeDid = runtime.nodeDid();
  } catch {
    return { ok: false, refusal: 'commerce_unavailable' };
  }
  // The body's buyer is a claim; the authenticated sender is the fact.
  if (counter.buyer_did !== buyerDid || counter.supplier_did !== nodeDid) {
    return { ok: false, refusal: 'not_your_quote' };
  }
  const head = headQuote(runtime, counter.quote_id);
  if (head === null || head.buyer_did !== buyerDid) return { ok: false, refusal: 'not_your_quote' };
  const first = firstRevision(runtime, head);
  if (first === null) return { ok: false, refusal: 'not_your_quote' };
  if (counter.target_total.currency !== head.total.currency) {
    return { ok: false, refusal: 'counter_invalid' };
  }
  if (counter.protocol_version !== head.protocol_version)
    return { ok: false, refusal: 'counter_invalid' };
  const settings = runtime.settings.readSupplier();
  const policy = settings.ok ? settings.settings.negotiation : undefined;
  if (policy === undefined || !policy.enabled) return { ok: false, refusal: 'negotiation_off' };
  if (runtime.negotiation.outcomeFor(buyerDid, counter.quote_id) !== null) {
    return { ok: false, refusal: 'negotiation_closed' };
  }
  if (Date.parse(counter.respond_by) <= nowMs) return { ok: false, refusal: 'counter_expired' };
  if (nowMs - Date.parse(first.issued_at) > policy.windowSeconds * 1000) {
    return { ok: false, refusal: 'window_closed' };
  }
  return { ok: true, context: { runtime, counter, head, first, policy } };
}

/** Before the runner (see the header). */
export function admitInboundCounter(args: {
  params: unknown;
  /** TRANSPORT-authenticated sender. */
  buyerDid: string;
  nowMs: number;
}): CounterAdmission {
  const runtime = getCommerceRuntime();
  if (runtime === null) return { kind: 'refused', refusal: 'commerce_unavailable' };
  // A replay is answered first and from the record, whatever changed since:
  // one counter id, one answer.
  const raw = counterOf(args.params);
  const counterId =
    raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>).counter_id
      : undefined;
  let reserved = false;
  if (typeof counterId === 'string') {
    const held = runtime.negotiation.getCounter(args.buyerDid, counterId);
    // One counter id names ONE counter: a different body under an id already
    // recorded is refused, or a buyer could reserve an id and reuse it on
    // another quote or target without the cap or the rounds seeing it.
    if (held !== null && !sameCounter(held, raw)) {
      return { kind: 'refused', refusal: 'counter_invalid' };
    }
    if (held !== null && held.answerJson !== '') return { kind: 'answer', json: held.answerJson };
    // Reserved and still being answered: a repeat of the same query joins
    // the task already running (the ingress dedups it) and spends nothing.
    reserved = held !== null;
  }
  const read = readCounterContext(args.params, args.buyerDid, args.nowMs);
  if (!read.ok) return { kind: 'refused', refusal: read.refusal };
  const { counter, head, policy } = read.context;
  if (reserved) return { kind: 'dispatch', params: { counter, current_quote: head } };

  // Rule 2 — the per-buyer daily cap, across every quote. A re-ask while
  // this node's owner is still deciding asks nothing new, so it neither
  // meets the cap nor counts toward it.
  if (
    !isWaitingReask(args.params, args.buyerDid) &&
    countedCountersSince(runtime, args.buyerDid, args.nowMs - DAY_MS) >=
      policy.maxCountersPerBuyerPerDay
  ) {
    return { kind: 'refused', refusal: 'counter_limit' };
  }
  // The round limit counts THIS node's records, never the round number the
  // buyer wrote: a buyer that sent "round 1" every time would otherwise
  // negotiate for as long as the daily cap allowed.
  //
  // A round that only WAITED on this node's owner (a hold with the owner
  // still deciding) does not use a round up: the owner's yes must be able
  // to reach the buyer, and a hold moved nothing. The daily cap still bounds
  // how often a buyer may ask.
  const roundsUsed = runtime.negotiation
    .listAnswersForQuote(args.buyerDid, counter.quote_id)
    .filter((json) => !waitedOnOwner(json)).length;
  if (roundsUsed >= policy.maxRounds) {
    return { kind: 'refused', refusal: 'round_refused' };
  }

  // A counter on a head that has since moved answers with the current head:
  // the buyer countered terms that are no longer on the table.
  if (counter.quote_digest !== head.quote_digest) {
    const json = answerJson(head, 'held');
    recordCounter(runtime, counter, json, args.nowMs);
    return { kind: 'answer', json };
  }
  // RESERVE before the runner is asked (rule 2): counters in progress count
  // toward the daily cap and the round limit, so a burst of counters sent at
  // once cannot all pass against the same count.
  recordCounter(runtime, counter, '', args.nowMs);
  return { kind: 'dispatch', params: { counter, current_quote: head } };
}

/**
 * A counter this node already answered, replayed before any gate: one
 * counter id, one answer, and a lost reply must be recoverable even after
 * the buyer's probing budget is spent (the replay asks nothing new).
 */
export function replayedCounterAnswer(args: { params: unknown; buyerDid: string }): string | null {
  const runtime = getCommerceRuntime();
  if (runtime === null) return null;
  const raw = counterOf(args.params);
  const counterId =
    raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>).counter_id
      : undefined;
  if (typeof counterId !== 'string') return null;
  const held = runtime.negotiation.getCounter(args.buyerDid, counterId);
  return held !== null && held.answerJson !== '' && sameCounter(held, raw) ? held.answerJson : null;
}

/**
 * Is this body the counter recorded under its id? The digest and the quote
 * are compared; the full check of the body against its digest runs in
 * `readCounterContext` before anything is dispatched or signed.
 */
function sameCounter(held: { counterDigest: string; quoteId: string }, raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') return false;
  const body = raw as Record<string, unknown>;
  return body.counter_digest === held.counterDigest && body.quote_id === held.quoteId;
}

/**
 * §4.3 — a counter asking AGAIN on a quote while this node's owner is still
 * deciding a price on it asks nothing new: its answer is the same hold, or
 * the price the owner has just authorised. So it spends no probing budget
 * and does not count toward the daily cap (the round limit already skips it)
 * — otherwise a buyer waiting politely would spend, on waiting, the budget
 * the owner's yes needs to arrive.
 *
 * Only while the owner's question is LIVE: pending on a card still open, or
 * approved and not yet given. A declined, withdrawn or lapsed question ends
 * the exemption, so it can never become a standing free lane.
 */
export function isWaitingReask(params: unknown, buyerDid: string): boolean {
  const runtime = getCommerceRuntime();
  if (runtime === null) return false;
  const raw = counterOf(params);
  const quoteId =
    raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>).quote_id : undefined;
  if (typeof quoteId !== 'string') return false;
  const answers = runtime.negotiation
    .listAnswersForQuote(buyerDid, quoteId)
    .filter((json) => json !== '');
  const last = answers.at(-1);
  if (last === undefined || !waitedOnOwner(last)) return false;
  const workflow = getWorkflowService();
  return runtime.negotiation
    .questionsForQuote(quoteId)
    .some(
      (q) =>
        q.buyerDid === buyerDid &&
        (q.state === 'approved' ||
          (q.state === 'pending' &&
            workflow?.store().getById(q.taskId)?.status === WorkflowTaskState.PendingApproval)),
    );
}

/**
 * The counters that count toward the daily cap: every one since `sinceMs`
 * except a re-ask that followed a hold waiting on this node's owner.
 */
function countedCountersSince(runtime: CommerceRuntime, buyerDid: string, sinceMs: number): number {
  const previous = new Map<string, string>();
  let counted = 0;
  for (const row of runtime.negotiation.listCountersSince(buyerDid, sinceMs)) {
    const before = previous.get(row.quoteId);
    if (before === undefined || !waitedOnOwner(before)) counted += 1;
    if (row.answerJson !== '') previous.set(row.quoteId, row.answerJson);
  }
  return counted;
}

/** A recorded answer that held while this node's owner was still deciding. */
function waitedOnOwner(answerJson: string): boolean {
  try {
    const answer = JSON.parse(answerJson) as { outcome?: unknown; pending_owner?: unknown };
    return answer.outcome === 'held' && answer.pending_owner === true;
  } catch {
    return false;
  }
}

function recordCounter(
  runtime: CommerceRuntime,
  counter: CounterOffer,
  json: string,
  nowMs: number,
): void {
  // A reserved row gets its answer; a fresh one is written whole.
  if (
    json !== '' &&
    runtime.negotiation.answerReserved(counter.buyer_did, counter.counter_id, json)
  ) {
    return;
  }
  runtime.negotiation.putCounter({
    buyerDid: counter.buyer_did,
    counterId: counter.counter_id,
    quoteId: counter.quote_id,
    round: Number(counter.round),
    counterDigest: counter.counter_digest,
    counterJson: JSON.stringify(counter),
    answerJson: json,
    createdAt: nowMs,
  });
}

/** The runner's proposed unit price per line, as far as this module believes it. */
function readRunnerPrices(json: string, currency: string): Map<string, bigint> | 'hold' | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.hold === true) return 'hold';
  if (!Array.isArray(record.lines)) return null;
  const prices = new Map<string, bigint>();
  for (const entry of record.lines) {
    if (entry === null || typeof entry !== 'object') return null;
    const line = entry as Record<string, unknown>;
    const price = line.unit_price as Money | undefined;
    if (typeof line.line_id !== 'string' || price === undefined || price === null) return null;
    if (price.currency !== currency || typeof price.minor_units !== 'string') return null;
    if (!/^(0|[1-9][0-9]{0,17})$/.test(price.minor_units)) return null;
    prices.set(line.line_id, BigInt(price.minor_units));
  }
  return prices;
}

/** After the runner (see the header). Returns the wire answer or a refusal. */
/** What a buyer hears when Core refuses a counter after the runner: no reason, no number. */
export const COUNTER_REFUSED_ANSWER = JSON.stringify({ outcome: 'refused' });

/**
 * After the runner. ALWAYS an answer: a refusal here (the window closed, the
 * quote was closed, the terms were unusable) is sent as a non-disclosing
 * `refused` rather than withheld, so the buyer's loop hears it at once
 * instead of waiting out the counter's window, and a replay repeats it.
 */
export function settleInboundCounter(args: {
  params: unknown;
  buyerDid: string;
  runnerResultJson: string;
  nowMs: number;
}): { ok: true; json: string } {
  const settled = settleCounterTerms(args);
  if (settled.ok) return settled;
  const runtime = getCommerceRuntime();
  const read = readCounterOffer(counterOf(args.params), hash);
  if (runtime !== null && read.ok && read.counter.buyer_did === args.buyerDid) {
    // A different body under a recorded id leaves that record as it is.
    const held = runtime.negotiation.getCounter(args.buyerDid, read.counter.counter_id);
    if (held === null || sameCounter(held, read.counter)) {
      recordCounter(runtime, read.counter, COUNTER_REFUSED_ANSWER, args.nowMs);
    }
  }
  appendAudit('negotiation', 'counter_refused', '', `reason=${settled.refusal}`);
  return { ok: true, json: COUNTER_REFUSED_ANSWER };
}

function settleCounterTerms(args: {
  params: unknown;
  buyerDid: string;
  runnerResultJson: string;
  nowMs: number;
}): { ok: true; json: string } | { ok: false; refusal: CounterRefusal } {
  const read = readCounterContext(args.params, args.buyerDid, args.nowMs);
  if (!read.ok) return read;
  const { runtime, counter, head, first, policy } = read.context;
  const held = runtime.negotiation.getCounter(args.buyerDid, counter.counter_id);
  if (held !== null && !sameCounter(held, counter))
    return { ok: false, refusal: 'counter_invalid' };
  if (held !== null && held.answerJson !== '') return { ok: true, json: held.answerJson };
  if (counter.quote_digest !== head.quote_digest) {
    const json = answerJson(head, 'held');
    recordCounter(runtime, counter, json, args.nowMs);
    return { ok: true, json };
  }

  const proposals = readRunnerPrices(args.runnerResultJson, head.total.currency);
  if (proposals === null) return { ok: false, refusal: 'terms_unusable' };

  const firstPrices = new Map(
    first.lines.map((line) => [line.line_id, BigInt(line.unit_price.minor_units)]),
  );
  const authorised = new Map<string, bigint>();
  for (const question of runtime.negotiation.questionsForQuote(counter.quote_id)) {
    if (question.state === 'approved')
      authorised.set(question.lineId, BigInt(question.askedMinorUnits));
  }

  const toAsk: { lineId: string; asked: bigint; signed: bigint; current: bigint }[] = [];
  const lines: SignedQuoteLine[] = [];
  let moved = false;
  // A line whose kept price is under the CURRENT hard floor (the owner raised
  // it since the head was signed) must not be re-signed in a new revision.
  let belowFloor = false;
  for (const line of head.lines) {
    const current = BigInt(line.unit_price.minor_units);
    const firstPrice = firstPrices.get(line.line_id) ?? current;
    const proposal = proposals === 'hold' ? current : (proposals.get(line.line_id) ?? current);
    // Never raise a price the buyer holds.
    const wanted = proposal > current ? current : proposal;
    const bounds = lineBounds(policy, line.offered_product, firstPrice);
    const clamped = clampProposal(wanted, bounds, authorised.get(line.line_id) ?? null);
    const price = clamped.price > current ? current : clamped.price;
    if (clamped.needsOwner)
      toAsk.push({ lineId: line.line_id, asked: clamped.asked, signed: price, current });
    if (price < current) moved = true;
    if (price < bounds.hardFloor) belowFloor = true;
    const unitPrice: Money = {
      currency: line.unit_price.currency,
      minor_units: price.toString(10),
    };
    const subtotal = computeLineSubtotal(unitPrice, line.quantity, line.price_basis);
    if (subtotal.error || !subtotal.value) return { ok: false, refusal: 'terms_unusable' };
    lines.push({ ...line, unit_price: unitPrice, line_subtotal: subtotal.value });
  }

  if (toAsk.length > 0) askOwner(runtime, counter, head, toAsk, args.nowMs);
  const ownerPending = runtime.negotiation
    .questionsForQuote(counter.quote_id)
    .some((question) => question.state === 'pending');

  if (!moved || belowFloor) {
    const json = answerJson(head, 'held', ownerPending);
    recordCounter(runtime, counter, json, args.nowMs);
    return { ok: true, json };
  }

  let epoch: string;
  try {
    epoch = runtime.currentEpoch();
  } catch {
    return { ok: false, refusal: 'commerce_unavailable' };
  }
  const total = computeTotal(
    head.total.currency,
    lines.map((line) => line.line_subtotal),
    head.charges,
  );
  if (total.error || !total.value) return { ok: false, refusal: 'terms_unusable' };
  // A revision stands as long as the head it replaces stood, measured from
  // now: a runner that quoted a one-hour price for perishables does not get a
  // day-long revision the owner never chose.
  const headValidity = Date.parse(head.valid_until) - Date.parse(head.issued_at);
  const validUntil = args.nowMs + (headValidity > 0 ? headValidity : REVISION_VALIDITY_MS);
  const {
    quote_digest: _headDigest,
    terms_digest: _headTerms,
    replaces_quote_digest: _replaces,
    ...headFields
  } = head;
  const draft = {
    ...headFields,
    quote_revision: (BigInt(head.quote_revision) + 1n).toString(10),
    previous_quote_digest: head.quote_digest,
    lines,
    total: total.value,
    issued_at: new Date(args.nowMs).toISOString(),
    valid_until: new Date(validUntil).toISOString(),
    supplier_epoch: epoch,
  };
  const terms_digest = commerceRecordDigest('terms', termsDigestInput(draft), hash);
  const withTerms = { ...draft, terms_digest };
  const revision: SignedQuote = {
    ...withTerms,
    quote_digest: commerceRecordDigest(
      'quote',
      withTerms as unknown as Record<string, unknown>,
      hash,
    ),
  };
  if (validateSignedQuote(revision, hash) !== null)
    return { ok: false, refusal: 'revision_refused' };
  // The revision and the answer the buyer may replay are written together:
  // a head that moved with no retained answer could never be recovered.
  const json = answerJson(revision, 'revised', ownerPending);
  if (
    runtime.admission.registerRevisionWithAnswer(revision, args.buyerDid, () =>
      recordCounter(runtime, counter, json, args.nowMs),
    ) !== null
  ) {
    return { ok: false, refusal: 'revision_refused' };
  }
  appendAudit(
    'negotiation',
    'counter_revised',
    counter.quote_id,
    `round=${counter.round} revision=${revision.quote_revision}`,
  );
  return { ok: true, json };
}

// ---------------------------------------------------------------------------
// The owner's question
// ---------------------------------------------------------------------------

export interface NegotiationPriceCardPayload {
  type: typeof NEGOTIATION_PRICE_APPROVAL_TYPE;
  quote_id: string;
  buyer_did: string;
  currency: string;
  lines: {
    line_id: string;
    asked_minor_units: string;
    signed_minor_units: string;
    quoted_minor_units: string;
  }[];
}

/**
 * One card per counter whose runner wanted a line below the automatic limit.
 * A line already asked about and still pending is not asked twice; a new ask
 * on a decided line replaces the old answer only by a new card.
 */
function askOwner(
  runtime: CommerceRuntime,
  counter: CounterOffer,
  head: SignedQuote,
  lines: { lineId: string; asked: bigint; signed: bigint; current: bigint }[],
  nowMs: number,
): void {
  const workflow = getWorkflowService();
  if (workflow === null) return;
  const open = new Set(
    runtime.negotiation
      .questionsForQuote(counter.quote_id)
      // An owner who already answered — yes or no — is not asked again.
      .filter((q) => q.state !== 'withdrawn')
      .map((q) => q.lineId),
  );
  const fresh = lines.filter((line) => !open.has(line.lineId));
  if (fresh.length === 0) return;
  const taskId = `negotiation-price-${counter.counter_digest.slice(0, 32)}`;
  const payload: NegotiationPriceCardPayload = {
    type: NEGOTIATION_PRICE_APPROVAL_TYPE,
    quote_id: counter.quote_id,
    buyer_did: counter.buyer_did,
    currency: head.total.currency,
    lines: fresh.map((line) => ({
      line_id: line.lineId,
      asked_minor_units: line.asked.toString(10),
      signed_minor_units: line.signed.toString(10),
      quoted_minor_units: line.current.toString(10),
    })),
  };
  try {
    workflow.create({
      id: taskId,
      kind: WorkflowTaskKind.Approval,
      description: `A buyer asks for a lower price on quote ${counter.quote_id} (${String(fresh.length)} line(s)) below your automatic limit. Offer it?`,
      payload: JSON.stringify(payload),
      idempotencyKey: `negotiation_price:${counter.counter_digest}`,
      correlationId: counter.quote_id,
      origin: 'd2d',
      initialState: WorkflowTaskState.PendingApproval,
      expiresAtSec: Math.floor(Date.parse(counter.respond_by) / 1000) + 24 * 60 * 60,
    });
  } catch {
    return; // an existing card for this counter already asks
  }
  for (const line of fresh) {
    runtime.negotiation.askOwner({
      quoteId: counter.quote_id,
      lineId: line.lineId,
      buyerDid: counter.buyer_did,
      askedMinorUnits: line.asked.toString(10),
      state: 'pending',
      taskId,
      createdAt: nowMs,
      decidedAt: null,
    });
  }
  appendAudit(
    'negotiation',
    'owner_price_asked',
    counter.quote_id,
    `lines=${String(fresh.length)}`,
  );
}

export function parseNegotiationPriceCard(text: string): NegotiationPriceCardPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const p = value as Partial<NegotiationPriceCardPayload>;
  if (p.type !== NEGOTIATION_PRICE_APPROVAL_TYPE || typeof p.quote_id !== 'string') return null;
  if (typeof p.buyer_did !== 'string' || !Array.isArray(p.lines)) return null;
  return p as NegotiationPriceCardPayload;
}

/**
 * The owner decided. A yes authorises the asked prices for the buyer's NEXT
 * counter (no unsolicited revision is pushed); a no or a lapse closes the
 * question. The card completes either way so it never sits queued.
 */
export function makeNegotiationPriceDecisionHandler(deps: {
  runtime: () => Pick<CommerceRuntime, 'negotiation'> | null;
  workflow: () => WorkflowService | null;
  nowMs: () => number;
}): ApprovalDecisionHandler {
  return ({ task, decision }) => {
    const payload = parseNegotiationPriceCard(task.payload);
    if (payload === null) {
      closeTenderReadyCard(task, decision, deps);
      return;
    }
    const runtime = deps.runtime();
    if (runtime === null) return;
    const state = decision === 'approved' ? 'approved' : 'declined';
    runtime.negotiation.decideQuestion(task.id, state, deps.nowMs());
    appendAudit(
      'negotiation',
      `owner_price_${decision}`,
      payload.quote_id,
      `lines=${String(payload.lines.length)}`,
    );
    if (decision !== 'approved') return;
    const workflow = deps.workflow();
    if (workflow === null) return;
    try {
      workflow
        .store()
        .transition(task.id, WorkflowTaskState.Queued, WorkflowTaskState.Running, deps.nowMs());
      workflow.complete(
        task.id,
        JSON.stringify({ authorised: true }),
        'price authorised for the next counter',
      );
    } catch {
      /* a raced transition changes nothing the owner decided */
    }
  };
}

/**
 * The buyer's "tender ready" notice asks nothing: the award is its own act,
 * with presence, on the tender screen. A yes or a no only clears the card.
 */
function closeTenderReadyCard(
  task: { id: string; payload: string },
  decision: string,
  deps: { workflow: () => WorkflowService | null; nowMs: () => number },
): void {
  let type: unknown;
  try {
    type = (JSON.parse(task.payload) as { type?: unknown }).type;
  } catch {
    return;
  }
  if (type !== TENDER_READY_TYPE || decision !== 'approved') return;
  const workflow = deps.workflow();
  try {
    workflow
      ?.store()
      .transition(task.id, WorkflowTaskState.Queued, WorkflowTaskState.Running, deps.nowMs());
    workflow?.complete(task.id, JSON.stringify({ seen: true }), 'tender notice seen');
  } catch {
    /* already closed */
  }
}

export function negotiationWorkflowHooks(over: { nowMs?: () => number } = {}): WorkflowHooks {
  return {
    responseEgressGate: () => ({ kind: 'passthrough' }),
    approvalDecisionHandler: makeNegotiationPriceDecisionHandler({
      runtime: getCommerceRuntime,
      workflow: getWorkflowService,
      nowMs: over.nowMs ?? Date.now,
    }),
  };
}

// ---------------------------------------------------------------------------
// The not-awarded notice
// ---------------------------------------------------------------------------

/**
 * Answered by Core alone: a buyer tells this supplier a quote it holds was
 * not awarded. Bound to a quote the authenticated sender actually holds; the
 * answer is the same whether or not it was, so the lane is no oracle.
 */
export function answerQuoteOutcomeInCore(args: {
  params: unknown;
  buyerDid: string;
  nowMs: number;
}):
  | { ok: true; json: string }
  | { ok: false; code: 'commerce_unavailable' | 'outcome_invalid'; error: string } {
  const runtime = getCommerceRuntime();
  if (runtime === null) {
    return { ok: false, code: 'commerce_unavailable', error: 'this node cannot record an outcome' };
  }
  if (validateQuoteOutcomeNotice(args.params) !== null) {
    return { ok: false, code: 'outcome_invalid', error: 'not a quote outcome notice' };
  }
  const notice = args.params as { request_id: string; quote_id: string; outcome: 'not_awarded' };
  const head = headQuote(runtime, notice.quote_id);
  if (head !== null && head.buyer_did === args.buyerDid && head.request_id === notice.request_id) {
    runtime.negotiation.putOutcome({
      buyerDid: args.buyerDid,
      quoteId: notice.quote_id,
      requestId: notice.request_id,
      outcome: notice.outcome,
      receivedAt: args.nowMs,
    });
    withdrawOwnerQuestions(runtime, notice.quote_id, args.nowMs);
    appendAudit('negotiation', 'quote_not_awarded', notice.quote_id, 'closed');
  }
  return { ok: true, json: JSON.stringify({ recorded: true }) };
}

/** A closed quote needs no answer from the owner any more. */
function withdrawOwnerQuestions(runtime: CommerceRuntime, quoteId: string, nowMs: number): void {
  const workflow = getWorkflowService();
  const tasks = new Set<string>();
  for (const question of runtime.negotiation.questionsForQuote(quoteId)) {
    if (question.state === 'pending') tasks.add(question.taskId);
  }
  for (const taskId of tasks) {
    runtime.negotiation.decideQuestion(taskId, 'withdrawn', nowMs);
    try {
      workflow?.cancel(taskId, 'quote_not_awarded');
    } catch {
      /* already decided */
    }
  }
}
