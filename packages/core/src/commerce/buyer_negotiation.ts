/**
 * The buyer's half of negotiation (NEGOTIATION_PLAN §4.4, §4.5).
 *
 *   `sendCounterOffer`      — one counter to one supplier on the head this node
 *                              holds, retained before it is sent (§12.7).
 *   `rankTender`            — the offers a tender holds, filtered and ordered by
 *                              fixed rules; every excluded offer says why.
 *   `runNegotiationTick`    — the loop: counter every quoted supplier above the
 *                              target, one round at a time, until a quote meets
 *                              the target, the rounds run out or the deadline
 *                              passes; then tell the owner once.
 *   `sendNotAwardedNotices` — after the owner awards, tell every other quoted
 *                              supplier its quote was not awarded. Nothing else.
 *
 * FIXED RULES, NO MODEL (§3). The target is the buyer's own ask; the loop never
 * forwards one supplier's price to another, and a notice names no winner and
 * no price. Counters bind nobody: the loop ends at a ready tender, and only
 * the owner's award builds an order.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import {
  commerceRecordDigest,
  moneyMinorUnits,
  validateCounterOffer,
  type CounterOffer,
  type Money,
  type QuoteOutcomeNotice,
  type Sha256Fn,
  type SignedQuote,
} from '@dina/commerce-protocol';

import { appendAudit } from '../audit/service';
import { WorkflowTaskKind, WorkflowTaskState } from '../workflow/domain';
import { getWorkflowService } from '../workflow/service';

import { getCommerceServiceQueryDispatch } from './buyer_sender';
import { TENDER_READY_TYPE } from './negotiation_policy';
import { getCommerceRuntime, type CommerceRuntime } from './runtime';
import { DEFAULT_WORKING_CAPITAL_RATE_BPS, financingBenefitMinor } from './tender';

import type { SentCounter, TenderNegotiation, TenderNotice } from './buyer_negotiation_store';

const hash: Sha256Fn = (data) => sha256(data);

export const COUNTER_OFFER_WIRE_CAPABILITY = 'com.dinakernel.commerce.counter_offer';
export const QUOTE_OUTCOME_WIRE_CAPABILITY = 'com.dinakernel.commerce.quote_outcome';

/** The plan's defaults: three rounds, ninety seconds. */
export const DEFAULT_MAX_ROUNDS = 3;
export const DEFAULT_DEADLINE_SECONDS = 90;
/** A silent counter is sent this many times in all before the supplier is taken as silent. */
const MAX_COUNTER_ATTEMPTS = 2;
/** How many times a not-awarded notice is tried before it is given up. */
const MAX_NOTICE_ATTEMPTS = 5;
const NOTICE_RETRY_MS = 60_000;
/** How long the loop waits on a supplier's owner before asking again. */
const OWNER_WAIT_MS = 20_000;
/** How long a supplier has to answer one counter. */
const COUNTER_RESPOND_WITHIN_MS = 60_000;
const COUNTER_TTL_SECONDS = 120;

export type CounterSendRefusal =
  | 'commerce_unavailable'
  | 'no_dispatch'
  | 'no_such_quote'
  | 'quote_expired'
  | 'target_not_lower'
  | 'currency_mismatch'
  | 'counter_in_flight'
  | 'counter_invalid'
  /** The tender this counter belongs to is no longer negotiating (awarded, ready, closed). */
  | 'tender_closed'
  | 'not_sent';

export type CounterSendOutcome =
  | { kind: 'sent' | 'ambiguous'; counter: CounterOffer }
  | { kind: 'refused'; reason: CounterSendRefusal };

function headOf(
  runtime: CommerceRuntime,
  supplierDid: string,
  quoteId: string,
): SignedQuote | null {
  return runtime.buyerQuotes.chain(supplierDid, quoteId).at(-1) ?? null;
}

/** Compose, retain and send one counter on the head this node holds. */
export async function sendCounterOffer(args: {
  supplierDid: string;
  quoteId: string;
  serviceRkey: string;
  targetTotal: Money;
  tenderId?: string;
  nowMs: number;
}): Promise<CounterSendOutcome> {
  const runtime = getCommerceRuntime();
  if (runtime === null) return { kind: 'refused', reason: 'commerce_unavailable' };
  const dispatch = getCommerceServiceQueryDispatch();
  if (dispatch === null) return { kind: 'refused', reason: 'no_dispatch' };
  // Checked on the same synchronous stretch as the retain below: an award
  // that closes the tender can never slip between this check and the write
  // (the award route's own check-and-close is synchronous too).
  const head = headOf(runtime, args.supplierDid, args.quoteId);
  if (head === null) return { kind: 'refused', reason: 'no_such_quote' };
  if (
    args.tenderId !== undefined &&
    args.tenderId !== '' &&
    runtime.buyerNegotiation.getTender(args.tenderId)?.state !== 'negotiating'
  ) {
    return { kind: 'refused', reason: 'tender_closed' };
  }
  // A manual counter names no tender, but its quote may answer one: a tender
  // that has left negotiation (ready, awarded, closed) takes no counter, or
  // one could revise the quote under a held order.
  const member = runtime.tenders.memberByRequestId(head.request_id);
  if (member !== null && member.supplierDid === args.supplierDid) {
    const state = runtime.buyerNegotiation.getTender(member.tenderId)?.state;
    if (state !== undefined && state !== 'negotiating') {
      return { kind: 'refused', reason: 'tender_closed' };
    }
  }
  if (Date.parse(head.valid_until) <= args.nowMs)
    return { kind: 'refused', reason: 'quote_expired' };
  if (args.targetTotal.currency !== head.total.currency) {
    return { kind: 'refused', reason: 'currency_mismatch' };
  }
  if (moneyMinorUnits(args.targetTotal) >= moneyMinorUnits(head.total)) {
    return { kind: 'refused', reason: 'target_not_lower' };
  }
  const earlier = runtime.buyerNegotiation.countersForQuote(args.supplierDid, args.quoteId);
  if (
    earlier.some((c) => (c.state === 'sent' || c.state === 'unsent') && inFlight(c, args.nowMs))
  ) {
    return { kind: 'refused', reason: 'counter_in_flight' };
  }

  const draft = {
    // §9.13 — the conversation's dialect, fixed by the request.
    protocol_version: head.protocol_version,
    counter_id: `ctr_${bytesToHex(randomBytes(12))}`,
    quote_id: head.quote_id,
    quote_digest: head.quote_digest,
    buyer_did: runtime.nodeDid(),
    supplier_did: args.supplierDid,
    round: String(earlier.length + 1),
    target_total: args.targetTotal,
    issued_at: new Date(args.nowMs).toISOString(),
    respond_by: new Date(args.nowMs + COUNTER_RESPOND_WITHIN_MS).toISOString(),
  };
  const counter = {
    ...draft,
    counter_digest: commerceRecordDigest('counter', draft, hash),
  } as CounterOffer;
  if (validateCounterOffer(counter, hash) !== null)
    return { kind: 'refused', reason: 'counter_invalid' };

  // RETAIN FIRST (§12.7): a sent counter with no record is an answer this
  // node could not recognise.
  const retained: SentCounter = {
    counterId: counter.counter_id,
    tenderId: args.tenderId ?? '',
    supplierDid: args.supplierDid,
    quoteId: head.quote_id,
    round: Number(counter.round),
    state: 'sent',
    counterJson: JSON.stringify(counter),
    answerDigest: '',
    sentAt: args.nowMs,
    answeredAt: null,
    attempts: 1,
  };
  runtime.buyerNegotiation.putCounter(retained);
  try {
    const result = await dispatch({
      toDid: args.supplierDid,
      body: {
        query_id: counter.counter_id,
        capability: COUNTER_OFFER_WIRE_CAPABILITY,
        params: counter,
        ttl_seconds: COUNTER_TTL_SECONDS,
        service_uri: `at://${args.supplierDid}/com.dinakernel.service.profile/${args.serviceRkey}`,
      },
    });
    if (result.deniedAt !== undefined) {
      runtime.buyerNegotiation.answerCounter(counter.counter_id, 'refused', '', args.nowMs);
      return { kind: 'refused', reason: 'not_sent' };
    }
    if (!result.sent && result.error !== undefined) {
      runtime.buyerNegotiation.putCounter({ ...retained, state: 'unsent' });
      return { kind: 'ambiguous', counter };
    }
    return { kind: 'sent', counter };
  } catch {
    runtime.buyerNegotiation.putCounter({ ...retained, state: 'unsent' });
    return { kind: 'ambiguous', counter };
  }
}

/** A counter still waiting for its answer, inside the time the supplier was given. */
function inFlight(counter: SentCounter, nowMs: number): boolean {
  return nowMs - counter.sentAt < COUNTER_RESPOND_WITHIN_MS + COUNTER_TTL_SECONDS * 1000;
}

/**
 * The answer to a counter arrived (the response lane has already verified the
 * quote against the chain this node holds). Bound to the supplier the counter
 * went to; anyone else's answer to it is ignored.
 */
export function recordCounterAnswer(args: {
  supplierDid: string;
  counterId: string;
  state: 'revised' | 'held' | 'pending' | 'refused';
  /** The quote the answer carried ('' for a refusal). */
  quoteId: string;
  quoteDigest: string;
  nowMs: number;
}): boolean {
  const runtime = getCommerceRuntime();
  if (runtime === null) return false;
  const sent = runtime.buyerNegotiation.getCounter(args.counterId);
  if (sent === null || sent.supplierDid !== args.supplierDid) return false;
  // An answer about a DIFFERENT quote does not answer this counter; the loop
  // must not act on a family it did not counter.
  const state = args.state !== 'refused' && args.quoteId !== sent.quoteId ? 'refused' : args.state;
  return runtime.buyerNegotiation.answerCounter(
    args.counterId,
    state,
    state === 'refused' ? '' : args.quoteDigest,
    args.nowMs,
  );
}

/**
 * Is a counter to this quote still waiting for its answer? (the award's guard)
 *
 * A counter is waiting while its window is open. A LOOP counter whose first
 * window closed unanswered is also waiting until it has been asked once more:
 * the supplier may have signed a revision whose reply was lost, and an award
 * in that gap would build the order on a quote the supplier has superseded.
 * The sweeper resends it on a negotiating or ready tender, so the wait ends.
 * A manual counter is never resent, so it waits only while its window is open.
 */
export function counterInFlight(supplierDid: string, quoteId: string, nowMs: number): boolean {
  const runtime = getCommerceRuntime();
  if (runtime === null) return false;
  return runtime.buyerNegotiation
    .countersForQuote(supplierDid, quoteId)
    .some(
      (c) =>
        unanswered(c) &&
        (inFlight(c, nowMs) || (c.tenderId !== '' && c.attempts < MAX_COUNTER_ATTEMPTS)),
    );
}

/**
 * A counter that went out and has no answer yet. After its window it may
 * still have been answered with a revision whose reply was lost, so it is not
 * settled until it has been asked once more (the supplier replays a retained
 * answer) and that window has passed too. Only then is the supplier treated
 * as silent — an older pack with no counter lane.
 */
function unanswered(counter: SentCounter): boolean {
  return counter.state === 'sent' || counter.state === 'unsent';
}

/** Send a silent counter once more, with the same id, so the answer is replayed if there was one. */
async function resendCounter(
  runtime: CommerceRuntime,
  counter: SentCounter,
  serviceRkey: string,
  nowMs: number,
): Promise<boolean> {
  const dispatch = getCommerceServiceQueryDispatch();
  if (dispatch === null) return false;
  // The attempt is spent before the check, so a row that fails it ends as a
  // silent supplier rather than a loop that waits on it until the deadline.
  runtime.buyerNegotiation.putCounter({
    ...counter,
    sentAt: nowMs,
    attempts: counter.attempts + 1,
  });
  // The retained counter is re-checked, digest included, before it goes out
  // again: a row edited after writing is not sent under this node's name.
  let params: unknown;
  try {
    params = JSON.parse(counter.counterJson);
  } catch {
    return false;
  }
  if (
    validateCounterOffer(params, hash) !== null ||
    (params as { counter_id: string }).counter_id !== counter.counterId
  ) {
    return false;
  }
  try {
    const result = await dispatch({
      toDid: counter.supplierDid,
      body: {
        query_id: counter.counterId,
        capability: COUNTER_OFFER_WIRE_CAPABILITY,
        params,
        ttl_seconds: COUNTER_TTL_SECONDS,
        service_uri: `at://${counter.supplierDid}/com.dinakernel.service.profile/${serviceRkey}`,
      },
    });
    return result.sent;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tender policy and ranking
// ---------------------------------------------------------------------------

export interface TenderPolicyInput {
  currency: string;
  targetTotalMinor: string;
  budgetCeilingMinor: string;
  maxRounds?: number;
  deadlineSeconds?: number;
}

const MINOR = /^(0|[1-9][0-9]{0,17})$/;

export function tenderPolicyError(policy: TenderPolicyInput): string | null {
  if (!/^[A-Z]{3}$/.test(policy.currency)) return 'currency must be a three-letter code';
  if (!MINOR.test(policy.targetTotalMinor) || BigInt(policy.targetTotalMinor) <= 0n) {
    return 'target_total must be a positive whole number of minor units';
  }
  if (!MINOR.test(policy.budgetCeilingMinor)) {
    return 'budget_ceiling must be a whole number of minor units';
  }
  if (BigInt(policy.budgetCeilingMinor) < BigInt(policy.targetTotalMinor)) {
    return 'budget_ceiling cannot be below target_total';
  }
  const rounds = policy.maxRounds ?? DEFAULT_MAX_ROUNDS;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) return 'max_rounds must be 1 to 10';
  const deadline = policy.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS;
  if (!Number.isInteger(deadline) || deadline < 10 || deadline > 86_400) {
    return 'deadline_seconds must be 10 to 86400';
  }
  return null;
}

export function startTenderNegotiation(
  tenderId: string,
  policy: TenderPolicyInput,
  nowMs: number,
): void {
  const runtime = getCommerceRuntime();
  if (runtime === null) return;
  runtime.buyerNegotiation.putTender({
    tenderId,
    currency: policy.currency,
    targetTotalMinor: policy.targetTotalMinor,
    budgetCeilingMinor: policy.budgetCeilingMinor,
    maxRounds: policy.maxRounds ?? DEFAULT_MAX_ROUNDS,
    deadlineAt: nowMs + (policy.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS) * 1000,
    state: 'negotiating',
    awardedSupplierDid: '',
    approvalId: '',
    updatedAt: nowMs,
  });
}

export interface RankedTenderOffer {
  supplier_did: string;
  quote_id: string;
  service_rkey: string;
  total_minor: string;
  comparison_cost_minor: string;
  credit_days: number;
  valid_until: string;
  revision: string;
}

export type ExclusionReason =
  | 'no_quote'
  | 'declined'
  | 'expired'
  | 'currency_mismatch'
  | 'over_budget';

export interface TenderRanking {
  ranked: RankedTenderOffer[];
  excluded: { supplier_did: string; reason: ExclusionReason }[];
}

/**
 * Filter, then order (§13.2's rule: a requirement never takes part in a
 * score). Kept offers are ordered by comparison cost — the signed total less
 * the advisory financing benefit — then by the signed total, then by DID, so
 * the same stores rank the same way on any build.
 */
export function rankTender(args: {
  tenderId: string;
  nowMs: number;
  /** Absent: the tender's own policy ceiling, else no ceiling. */
  budgetCeilingMinor?: string;
  currency?: string;
}): { ok: true; ranking: TenderRanking } | { ok: false; refusal: string } {
  const runtime = getCommerceRuntime();
  if (runtime === null) return { ok: false, refusal: 'commerce_unavailable' };
  if (runtime.tenders.getTender(args.tenderId) === null)
    return { ok: false, refusal: 'no_such_tender' };
  const policy = runtime.buyerNegotiation.getTender(args.tenderId);
  const ceilingText = args.budgetCeilingMinor ?? policy?.budgetCeilingMinor;
  const ceiling = ceilingText === undefined ? null : BigInt(ceilingText);
  const currency = args.currency ?? policy?.currency;
  // No policy names a currency: rank only offers that share one, never a mix
  // compared minor unit for minor unit.
  if (currency === undefined) {
    const currencies = new Set(
      runtime.tenders
        .listMembers(args.tenderId)
        .map((m) => (m.quoteId === '' ? null : headOf(runtime, m.supplierDid, m.quoteId)))
        .filter((head): head is SignedQuote => head !== null)
        .map((head) => head.total.currency),
    );
    if (currencies.size > 1) return { ok: false, refusal: 'mixed_currencies' };
  }
  const buyer = runtime.settings.readBuyer();
  const rateBps =
    buyer.ok && buyer.settings.workingCapitalRateBps !== undefined
      ? buyer.settings.workingCapitalRateBps
      : DEFAULT_WORKING_CAPITAL_RATE_BPS;

  const ranked: RankedTenderOffer[] = [];
  const excluded: TenderRanking['excluded'] = [];
  for (const member of runtime.tenders.listMembers(args.tenderId)) {
    if (runtime.declineDocuments.answersTo(member.requestDigest).length > 0) {
      excluded.push({ supplier_did: member.supplierDid, reason: 'declined' });
      continue;
    }
    const head = member.quoteId === '' ? null : headOf(runtime, member.supplierDid, member.quoteId);
    if (head === null) {
      excluded.push({ supplier_did: member.supplierDid, reason: 'no_quote' });
      continue;
    }
    if (Date.parse(head.valid_until) <= args.nowMs) {
      excluded.push({ supplier_did: member.supplierDid, reason: 'expired' });
      continue;
    }
    if (currency !== undefined && head.total.currency !== currency) {
      excluded.push({ supplier_did: member.supplierDid, reason: 'currency_mismatch' });
      continue;
    }
    const total = moneyMinorUnits(head.total);
    if (ceiling !== null && total > ceiling) {
      excluded.push({ supplier_did: member.supplierDid, reason: 'over_budget' });
      continue;
    }
    const creditDays = head.payment_terms?.credit_days ?? 0;
    const benefit = financingBenefitMinor(total, rateBps, creditDays);
    ranked.push({
      supplier_did: member.supplierDid,
      quote_id: head.quote_id,
      service_rkey: member.serviceRkey,
      total_minor: total.toString(10),
      comparison_cost_minor: (total - benefit).toString(10),
      credit_days: creditDays,
      valid_until: head.valid_until,
      revision: head.quote_revision,
    });
  }
  ranked.sort((a, b) => {
    const cost = BigInt(a.comparison_cost_minor) - BigInt(b.comparison_cost_minor);
    if (cost !== 0n) return cost < 0n ? -1 : 1;
    const total = BigInt(a.total_minor) - BigInt(b.total_minor);
    if (total !== 0n) return total < 0n ? -1 : 1;
    return a.supplier_did.localeCompare(b.supplier_did);
  });
  return { ok: true, ranking: { ranked, excluded } };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** One pass over every negotiating tender. Returns the counters sent. */
export async function runNegotiationTick(nowMs: number): Promise<number> {
  const runtime = getCommerceRuntime();
  if (runtime === null) return 0;
  // ONE clock for the whole tick: time spent awaiting a send, in any tender,
  // moves it on, so every deadline and window is judged at the moment the
  // next message would leave, not when the tick began.
  const tickStart = runtime.now();
  const clock = (): number => nowMs + Math.max(0, runtime.now() - tickStart);
  let sent = 0;
  for (const tender of runtime.buyerNegotiation.listTenders('negotiating')) {
    sent += await negotiateOnce(runtime, tender, clock);
  }
  // A tender that reached ready (its deadline, say) with a counter still
  // unanswered: that counter is still asked once more, so a reply lost on
  // the way is recovered before the owner awards. An awarded or closed
  // tender is left alone — a counter now could revise the quote under a held
  // order. A manual counter is not resent; after its window the owner may
  // counter again.
  for (const tender of runtime.buyerNegotiation.listTenders('ready')) {
    for (const member of runtime.tenders.listMembers(tender.tenderId)) {
      if (member.quoteId === '') continue;
      const now = clock();
      const counters = runtime.buyerNegotiation.countersForQuote(
        member.supplierDid,
        member.quoteId,
      );
      const mine = ownLatest(counters, tender.tenderId);
      if (mine === undefined || !unanswered(mine) || inFlight(mine, now)) continue;
      if (mine.attempts >= MAX_COUNTER_ATTEMPTS) continue;
      // Re-read: the award may have closed the tender during an earlier send.
      if (runtime.buyerNegotiation.getTender(tender.tenderId)?.state !== 'ready') break;
      await resendCounter(runtime, mine, member.serviceRkey, now);
    }
  }
  // Notices written with an award and not yet taken by the transport.
  for (const notice of runtime.buyerNegotiation.listNotices('pending')) {
    const now = clock();
    if (notice.attempts > 0 && now - notice.updatedAt < NOTICE_RETRY_MS) continue;
    await deliverNotice(runtime, notice, now);
  }
  return sent;
}

/**
 * This tender's own latest counter on a quote. The sweeps resend THIS one,
 * never merely the newest: a manual counter sent after it must not strand a
 * resend the award guard (`counterInFlight`) is still waiting on.
 */
function ownLatest(counters: SentCounter[], tenderId: string): SentCounter | undefined {
  return counters.filter((c) => c.tenderId === tenderId).at(-1);
}

async function negotiateOnce(
  runtime: CommerceRuntime,
  tender: TenderNegotiation,
  /** The tick's clock, read again before each member (see `runNegotiationTick`). */
  clock: () => number,
): Promise<number> {
  const members = runtime.tenders.listMembers(tender.tenderId);
  let sent = 0;
  let waiting = false;
  let open = false;
  let nowMs = clock();
  for (const member of members) {
    nowMs = clock();
    // The award may have closed the tender while an earlier send awaited.
    if (runtime.buyerNegotiation.getTender(tender.tenderId)?.state !== 'negotiating') return sent;
    if (nowMs >= tender.deadlineAt) {
      markReady(runtime, tender, nowMs, 'deadline');
      return sent;
    }
    // An offer at or under the target ends the loop before another counter
    // goes out (§4.5) — checked over EVERY member before each one, since a
    // revision can arrive while an earlier send awaits.
    if (targetMet(runtime, tender, nowMs)) {
      markReady(runtime, tender, nowMs, 'target_met');
      return sent;
    }
    if (member.quoteId === '') {
      // Still to answer the request itself; the tender is not settled yet.
      if (runtime.declineDocuments.answersTo(member.requestDigest).length === 0) waiting = true;
      continue;
    }
    const head = headOf(runtime, member.supplierDid, member.quoteId);
    if (head === null || Date.parse(head.valid_until) <= nowMs) continue;
    if (head.total.currency !== tender.currency) continue;
    const counters = runtime.buyerNegotiation.countersForQuote(member.supplierDid, member.quoteId);
    const last = counters.at(-1);
    // This tender's own latest counter, unanswered: waiting while its window
    // is open; once it closes, asked ONCE more with the same id (a supplier
    // that answered and lost the reply replays its answer) — even when a
    // manual counter came after it.
    const mine = ownLatest(counters, tender.tenderId);
    if (mine !== undefined && unanswered(mine)) {
      if (inFlight(mine, nowMs)) {
        waiting = true;
        continue;
      }
      if (mine.attempts < MAX_COUNTER_ATTEMPTS) {
        await resendCounter(runtime, mine, member.serviceRkey, nowMs);
        waiting = true;
        continue;
      }
    }
    if (last !== undefined && unanswered(last)) {
      if (inFlight(last, nowMs)) {
        waiting = true;
        continue;
      }
      // This tender's own counter with its tries spent: the supplier is
      // silent (an older pack with no counter lane). A manual counter past
      // its window is left as the owner sent it, and the loop goes on below.
      if (last.tenderId === tender.tenderId) continue;
    }
    // A supplier that held or refused has given its answer; asking again
    // at the same target would only probe.
    if (last !== undefined && (last.state === 'held' || last.state === 'refused')) continue;
    // A hold with the owner still to decide: give the owner a moment, then
    // ask again (within the rounds), so a "yes" reaches this tender.
    if (
      last !== undefined &&
      last.state === 'pending' &&
      nowMs - (last.answeredAt ?? last.sentAt) < OWNER_WAIT_MS
    ) {
      waiting = true;
      continue;
    }
    // A round the supplier spent waiting on its owner does not count; the
    // supplier counts the same way, and the tender deadline bounds the wait.
    if (counters.filter((c) => c.state !== 'pending').length >= tender.maxRounds) continue;
    open = true;
    const outcome = await sendCounterOffer({
      supplierDid: member.supplierDid,
      quoteId: member.quoteId,
      serviceRkey: member.serviceRkey,
      targetTotal: { currency: tender.currency, minor_units: tender.targetTotalMinor },
      tenderId: tender.tenderId,
      nowMs,
    });
    if (outcome.kind !== 'refused') {
      sent += 1;
      waiting = true;
    }
  }
  // Nothing more to ask and nothing on its way: the tender is as good as it gets.
  if (!waiting && !open) markReady(runtime, tender, nowMs, 'settled');
  return sent;
}

/** Does any current offer in the tender's currency sit at or under its target? */
function targetMet(runtime: CommerceRuntime, tender: TenderNegotiation, nowMs: number): boolean {
  const target = BigInt(tender.targetTotalMinor);
  for (const member of runtime.tenders.listMembers(tender.tenderId)) {
    if (member.quoteId === '') continue;
    const head = headOf(runtime, member.supplierDid, member.quoteId);
    if (head === null || Date.parse(head.valid_until) <= nowMs) continue;
    if (head.total.currency === tender.currency && moneyMinorUnits(head.total) <= target) {
      return true;
    }
  }
  return false;
}

export interface TenderReadyCardPayload {
  type: typeof TENDER_READY_TYPE;
  tender_id: string;
  reason: 'deadline' | 'target_met' | 'settled';
  offers: number;
  best_total_minor: string | null;
  currency: string;
}

/** Silence first: the owner hears ONCE, when there is something to award. */
function markReady(
  runtime: CommerceRuntime,
  tender: TenderNegotiation,
  nowMs: number,
  reason: TenderReadyCardPayload['reason'],
): void {
  if (!runtime.buyerNegotiation.moveTender(tender.tenderId, 'negotiating', 'ready', nowMs)) return;
  const ranking = rankTender({ tenderId: tender.tenderId, nowMs });
  const ranked = ranking.ok ? ranking.ranking.ranked : [];
  appendAudit(
    'negotiation',
    'tender_ready',
    tender.tenderId,
    `reason=${reason} offers=${String(ranked.length)}`,
  );
  const workflow = getWorkflowService();
  if (workflow === null) return;
  const best = ranked[0];
  const payload: TenderReadyCardPayload = {
    type: TENDER_READY_TYPE,
    tender_id: tender.tenderId,
    reason,
    offers: ranked.length,
    best_total_minor: best === undefined ? null : best.total_minor,
    currency: tender.currency,
  };
  try {
    workflow.create({
      id: `tender-ready-${tender.tenderId}`,
      kind: WorkflowTaskKind.Approval,
      description:
        best === undefined
          ? `Tender ${tender.tenderId} closed with no offer within budget.`
          : `Tender ${tender.tenderId} is ready: ${String(ranked.length)} offer(s) within budget, best ${tender.currency} ${best.total_minor} minor units. Award it from the tender screen.`,
      payload: JSON.stringify(payload),
      idempotencyKey: `tender_ready:${tender.tenderId}`,
      correlationId: tender.tenderId,
      origin: 'system',
      initialState: WorkflowTaskState.PendingApproval,
    });
  } catch {
    /* already raised */
  }
}

// ---------------------------------------------------------------------------
// The not-awarded notice
// ---------------------------------------------------------------------------

/**
 * Tell every other quoted supplier its quote was not awarded. DURABLE: one
 * notice record per loser is written first (with the award), then tried; the
 * sweeper retries what the transport did not take, a few times, and gives up
 * without ever changing what the notice says.
 */
export async function sendNotAwardedNotices(args: {
  tenderId: string;
  winnerDid: string;
  nowMs: number;
}): Promise<{ supplier_did: string; sent: boolean }[]> {
  const runtime = getCommerceRuntime();
  if (runtime === null) return [];
  recordNotAwardedNotices(runtime, args.tenderId, args.winnerDid, args.nowMs);
  const results: { supplier_did: string; sent: boolean }[] = [];
  for (const notice of runtime.buyerNegotiation.listNotices('pending')) {
    if (notice.tenderId !== args.tenderId) continue;
    results.push({
      supplier_did: notice.supplierDid,
      sent: await deliverNotice(runtime, notice, args.nowMs),
    });
  }
  return results;
}

/** The notice intents for an award — written before anything is sent. */
export function recordNotAwardedNotices(
  runtime: CommerceRuntime,
  tenderId: string,
  winnerDid: string,
  nowMs: number,
): void {
  for (const member of runtime.tenders.listMembers(tenderId)) {
    if (member.supplierDid === winnerDid || member.quoteId === '') continue;
    runtime.buyerNegotiation.putNotice({
      tenderId,
      supplierDid: member.supplierDid,
      requestId: member.requestId,
      quoteId: member.quoteId,
      serviceRkey: member.serviceRkey,
      state: 'pending',
      attempts: 0,
      updatedAt: nowMs,
    });
  }
}

async function deliverNotice(
  runtime: CommerceRuntime,
  notice: TenderNotice,
  nowMs: number,
): Promise<boolean> {
  const dispatch = getCommerceServiceQueryDispatch();
  const attempts = notice.attempts + 1;
  let sent = false;
  if (dispatch !== null) {
    const params: QuoteOutcomeNotice = {
      request_id: notice.requestId,
      quote_id: notice.quoteId,
      outcome: 'not_awarded',
    };
    try {
      const result = await dispatch({
        toDid: notice.supplierDid,
        body: {
          query_id: `out_${notice.requestId}`,
          capability: QUOTE_OUTCOME_WIRE_CAPABILITY,
          params,
          ttl_seconds: COUNTER_TTL_SECONDS,
          service_uri: `at://${notice.supplierDid}/com.dinakernel.service.profile/${notice.serviceRkey}`,
        },
      });
      sent = result.sent;
    } catch {
      sent = false;
    }
  }
  runtime.buyerNegotiation.updateNotice(
    notice.tenderId,
    notice.supplierDid,
    sent ? 'sent' : attempts >= MAX_NOTICE_ATTEMPTS ? 'abandoned' : 'pending',
    attempts,
    nowMs,
  );
  return sent;
}

// ---------------------------------------------------------------------------
// The sweeper
// ---------------------------------------------------------------------------

export interface NegotiationSweeperOptions {
  intervalMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** Runs the loop on a timer. Idle on a node with no negotiating tender. */
export class NegotiationSweeper {
  private handle: unknown = null;
  private running = false;

  constructor(private readonly options: NegotiationSweeperOptions = {}) {}

  start(): void {
    if (this.handle !== null) return;
    const every = this.options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.handle = every(() => {
      void this.runTick().catch((err: unknown) => this.options.onError?.(err));
    }, this.options.intervalMs ?? 5_000);
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
      return await runNegotiationTick((this.options.now ?? Date.now)());
    } finally {
      this.running = false;
    }
  }
}
