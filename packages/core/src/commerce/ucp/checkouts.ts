/**
 * Checkout sessions up to the hand-off (UCP plan §3.7, §3.10, §3.12; U2.4):
 * the start card, the permit it mints, and every checkout call behind one
 * gate.
 *
 *  - `propose` builds the checkout intent from handles (the merchant's ids,
 *    each line's unit fetched afresh, the negotiated version, transport,
 *    endpoint and capabilities, the owner-allowed context; no personal data,
 *    D3), and in ONE transaction writes the session (`awaiting_approval`)
 *    and raises the Core-minted `ucp_checkout_start` card bound to the
 *    intent's hash.
 *  - The owner's yes mints a single-use permit (`decide`): in one
 *    transaction it re-checks that the card is approved and still names its
 *    session's intent, mints the permit (six hours) and settles the card. A
 *    no, or a card that lapses, moves the session to `declined`. A crash
 *    after the approval but before the mint is repaired by the sweep.
 *  - Every checkout mutation, first send or resend, passes one gate at the
 *    moment of sending: the permit is live, the session's state admits that
 *    operation, and (for an update) the body fits the permit. The create's
 *    admission moves the session to `creating` in the same transaction that
 *    journals it. Before a first send, the negotiation is read again: a
 *    changed endpoint, transport, version or capability set voids the permit
 *    and the owner is asked again; a key rotation alone changes nothing.
 *  - One mutation at a time per session, through the dispatcher's slot and
 *    journal. A request whose answer was lost is resent with its stored
 *    bytes and key until it settles; past its deadline a create leaves the
 *    session `create_unknown` and an update `unsettled`, the permit void.
 *
 * Nothing here pays or completes: Dina never calls `complete_checkout`.
 * Brain reads none of the merchant's words.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { parseStrictJson } from '@dina/a2a';
import {
  buildCreateCheckoutBody,
  buildUpdateCheckoutBody,
  checkIntentDrift,
  checkoutIntentHash,
  checkSelection,
  checkUpdateFitsIntent,
  handoffUrl,
  isWellKnownTotalType,
  specErrorCode,
  effectiveExpiry,
  intentJson,
  readCheckout,
  validateIntent,
  type Checkout,
  type CheckoutIntent,
  type FulfillmentSelection,
  type IntentContext,
  type IntentLine,
} from '@dina/ucp';

import { canonicalDigest } from '../../a2a/digest';
import { OWNER_TURN_LIVE_MS } from '../../a2a/proposal';
import { WorkflowTaskKind, WorkflowTaskPriority, WorkflowTaskState } from '../../workflow/domain';

import { settleCard } from './card_settle';
import {
  MAX_HANDOFF_URL_BYTES,
  UCP_CHECKOUT_HANDOFF_TYPE,
  buildHandoffCard,
  handoffCardDescription,
  readHandoffCard,
  type HandoffCard,
} from './handoff_card';
import { freshLines, lineTargets, type LineInput, type LineRefusal } from './lines';
import { UCP_TASK_NAMESPACE } from './search_projection';
import {
  START_CARD_TTL_MS,
  UCP_CHECKOUT_START_TYPE,
  readStartCard,
  startCardDescription,
  startCardLines,
  startCardTrust,
  type StartCard,
} from './start_card';
import { watchReadAt } from './watcher';

import type { CheckoutRow, CheckoutState, RequestRow, UcpCheckoutStore } from './checkout_store';
import type {
  AbandonReason,
  Gate,
  MutateResult,
  Mutation,
  Outcome,
  UcpDispatcher,
} from './dispatch';
import type { CallResult, MerchantConnection, UcpMerchantClient } from './merchant_client';
import type { MerchantTrust } from './merchant_trust';
import type { UcpSearchStore } from './search_store';
import type { UcpSettings } from './settings';
import type { WorkflowTask } from '../../workflow/domain';
import type {
  ApprovalDecision,
  ApprovalDecisionHandler,
  WorkflowService,
} from '../../workflow/service';

/** How long a minted permit lasts, at most (§3.7). */
export const PERMIT_TTL_MS = 6 * 60 * 60_000;
/** A checkout mutation's retry deadline, before its permit's lapse cuts it shorter (§3.10). */
export const CHECKOUT_RETRY_MS = 23 * 60 * 60_000;
/** Start cards that may wait on the owner at once in one conversation. */
export const MAX_PENDING_STARTS = 3;
/** How long a change waits for another one on the same session, or for the merchant's Retry-After. */
const WAIT_MS = 30_000;

type CheckoutOperation = 'create_checkout' | 'update_checkout' | 'cancel_checkout';

/** Sessions whose permit may still be used: the states before the hand-off. */
const PERMIT_STATES: readonly CheckoutState[] = ['awaiting_approval', 'creating', 'open'];

export type CheckoutRefusal =
  | LineRefusal
  | 'merchant_not_allowed'
  | 'ucp_not_ready'
  | 'ucp_key_pending'
  | 'merchant_unreachable'
  | 'checkout_unavailable'
  | 'price_unreadable'
  | 'bad_discount_code'
  | 'too_many_starts'
  /** No owner turn in this conversation lately: a checkout comes from the owner's own request. */
  | 'no_owner_turn'
  /** The owner declined a checkout here and has not spoken since: Dina does not ask again. */
  | 'start_declined'
  | 'no_workflow'
  | 'unknown_session'
  /** The session is past what was asked of it (declined, handed off, ended). */
  | 'session_closed'
  /** The change is not one the approved permit covers: a new card is needed. */
  | 'outside_permit'
  /** The checkout changed since Brain read it: read it again before choosing. */
  | 'checkout_changed'
  /** The merchant refused the change (`detail`: the spec's code). */
  | 'refused'
  /** Another change, or the merchant's wait, still holds the session; nothing new was sent. */
  | 'busy';

/** What a caller learns of a session: its state, never the merchant's words or ids. */
export interface SessionView {
  session_id: string;
  state: CheckoutState;
  /** The start card's task id, for the owner's inbox. */
  review_id: string;
}

export type CheckoutResult =
  | { ok: true; session: SessionView; outcome: 'settled' | 'pending' }
  | { ok: false; reason: CheckoutRefusal; detail?: string };

export type HandoffResult =
  | { ok: true; session: SessionView; reviewId: string }
  | {
      ok: false;
      reason:
        | CheckoutRefusal
        /** A mutation is still unsettled: no card until it settles (or its deadline ends the session). */
        | 'not_settled'
        /** The merchant's answer could not be read faithfully; nothing was raised. */
        | 'answer_unreadable';
      detail?: string;
    };

export type ProposeResult =
  | { ok: true; session: SessionView; expiresAtMs: number }
  | { ok: false; reason: CheckoutRefusal; detail?: string };

export interface CheckoutDeps {
  store: UcpCheckoutStore;
  /** A session completed at the merchant: its order to follow. Runs in the completion's transaction. */
  onCompleted?: (row: CheckoutRow, now: number) => void;
  search: UcpSearchStore;
  client: Pick<UcpMerchantClient, 'open' | 'notReady'>;
  dispatcher: UcpDispatcher;
  /** The live workflow service (a server boot replaces its first one). */
  workflow: () => WorkflowService | null;
  settings: () => UcpSettings;
  trust: (origin: string) => Promise<MerchantTrust>;
  /** When the owner last spoke in this conversation (the release log), or null. */
  ownerTurn: (conversation: string) => number | null;
  nowMs: () => number;
  newId: () => string;
  sleep?: (ms: number) => Promise<void>;
}

// ------------------------------------------------------------ the stored intent

/**
 * The intent as the session row keeps it: everything a create body needs,
 * the unit's display text included (the hash covers only its identity).
 */
function storeIntent(intent: CheckoutIntent): string {
  return JSON.stringify({
    ...intentJson(intent),
    lines: intent.lines.map((l) => ({
      item_id: l.itemId,
      quantity: l.quantity.toString(),
      ...(l.unit !== undefined
        ? {
            unit: {
              unit: l.unit.unit,
              scale: l.unit.scale,
              display_text: l.unit.displayText,
              increment: l.unit.increment,
            },
          }
        : {}),
    })),
  });
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A session's intent, read back field by field and checked against the hash
 * the card and permit are bound to; null when it does not match.
 */
export function readStoredIntent(
  row: Pick<CheckoutRow, 'intent_json' | 'intent_hash'>,
): CheckoutIntent | null {
  const parsed = parseStrictJson(row.intent_json);
  if (!parsed.ok || !isRecord(parsed.value)) return null;
  const v = parsed.value;
  if (
    typeof v.merchant_origin !== 'string' ||
    typeof v.version !== 'string' ||
    (v.transport !== 'mcp' && v.transport !== 'rest') ||
    typeof v.endpoint !== 'string' ||
    !isRecord(v.capabilities) ||
    !Array.isArray(v.lines) ||
    !Array.isArray(v.discount_codes) ||
    !isRecord(v.context)
  )
    return null;
  const capabilities: Record<string, string> = {};
  for (const [k, ver] of Object.entries(v.capabilities)) {
    if (typeof ver !== 'string') return null;
    capabilities[k] = ver;
  }
  const lines: IntentLine[] = [];
  for (const l of v.lines) {
    if (!isRecord(l) || typeof l.item_id !== 'string' || typeof l.quantity !== 'string')
      return null;
    if (!/^[1-9]\d{0,15}$/.test(l.quantity)) return null;
    let unit: IntentLine['unit'];
    if (l.unit !== undefined) {
      const u = l.unit;
      if (
        !isRecord(u) ||
        typeof u.unit !== 'string' ||
        !Number.isSafeInteger(u.scale) ||
        typeof u.display_text !== 'string' ||
        !Number.isSafeInteger(u.increment)
      )
        return null;
      unit = {
        unit: u.unit,
        scale: u.scale as number,
        displayText: u.display_text,
        increment: u.increment as number,
      };
    }
    lines.push({
      itemId: l.item_id,
      quantity: BigInt(l.quantity),
      ...(unit !== undefined ? { unit } : {}),
    });
  }
  if (!v.discount_codes.every((c) => typeof c === 'string')) return null;
  const context: IntentContext = {};
  for (const [k, value] of Object.entries(v.context)) {
    if (typeof value !== 'string') return null;
    if (
      k === 'address_country' ||
      k === 'address_region' ||
      k === 'postal_code' ||
      k === 'language'
    )
      context[k] = value;
    else return null;
  }
  // Personal data (D3) is not built yet: a stored intent naming it is not one this build wrote.
  if (v.buyer !== undefined || v.shipping_address !== undefined) return null;
  // The linked account the owner approved under (U4, §3.7), when there was one.
  let credential: { ref: string; revision: number } | undefined;
  if (v.credential !== undefined) {
    const c = v.credential as { ref?: unknown; revision?: unknown } | null;
    if (
      c === null ||
      typeof c !== 'object' ||
      typeof c.ref !== 'string' ||
      !Number.isSafeInteger(c.revision) ||
      (c.revision as number) < 1
    )
      return null;
    credential = { ref: c.ref, revision: c.revision as number };
  }
  const intent: CheckoutIntent = {
    merchantOrigin: v.merchant_origin,
    version: v.version,
    transport: v.transport,
    endpoint: v.endpoint,
    capabilities,
    lines,
    discountCodes: v.discount_codes as string[],
    context,
    ...(credential !== undefined ? { credential } : {}),
  };
  return validateIntent(intent).ok && checkoutIntentHash(intent, sha256) === row.intent_hash
    ? intent
    : null;
}

/**
 * How the merchant's negotiation moved since the yes, or null: the intent's
 * version, transport, endpoint and capability set, and the session's own
 * endpoint and transport. A key rotation alone is not drift.
 */
function driftOf(row: CheckoutRow, connection: MerchantConnection): string | null {
  const intent = readStoredIntent(row);
  if (intent === null) return 'intent';
  const now = negotiatedNow(connection);
  const drift = checkIntentDrift(intent, now);
  if (!drift.ok) return drift.reason;
  if (now.endpoint !== row.endpoint) return 'endpoint_changed';
  if (now.transport !== row.transport) return 'transport_changed';
  return null;
}

/** The negotiation a connection speaks now, and the linked account it sends under, as an intent records them. */
function negotiatedNow(connection: MerchantConnection) {
  const { merchant } = connection;
  const capabilities: Record<string, string> = {};
  for (const [name, c] of merchant.negotiated) capabilities[name] = c.version;
  const credential = connection.credential();
  return {
    version: merchant.profile.version,
    transport: merchant.transport,
    endpoint: merchant.endpoint,
    capabilities,
    ...(credential !== null ? { credential } : {}),
  };
}

const isNotFound = (answer: CallResult): boolean =>
  !answer.ok &&
  answer.kind === 'error_response' &&
  answer.messages.messages.some((m) => m.type === 'error' && m.code === 'not_found');

/** The spec's code a refusal names, or `other` (never the merchant's words). */
function refusalCode(answer: CallResult): string {
  if (answer.ok) return '';
  if (answer.kind === 'transport') return specErrorCode(answer.error.code);
  if (answer.kind === 'error_response')
    return specErrorCode(answer.messages.messages.find((m) => m.type === 'error')?.code ?? '');
  return answer.kind;
}

/** A discount code as the owner may give it: printable, short, no spaces at the ends. */
const DISCOUNT_CODE = /^[\x21-\x7e](?:[\x20-\x7e]{0,62}[\x21-\x7e])?$/;
const MAX_DISCOUNT_CODES = 5;

export class UcpCheckoutService {
  constructor(private readonly deps: CheckoutDeps) {}

  // ------------------------------------------------------------ the start card

  /**
   * Build the checkout intent from handles and raise its start card, with
   * the session row, in one transaction. Nothing is sent to the merchant
   * that opens a checkout; only the products are read again.
   */
  async propose(
    conversation: string,
    input: { lines: readonly LineInput[]; discountCodes?: readonly string[] },
  ): Promise<ProposeResult> {
    const { deps } = this;
    // A checkout comes from the owner's own request, and a no stands until they speak again
    // (Silence First): the card is the owner's, never Brain's to press.
    const turn = deps.ownerTurn(conversation);
    if (turn === null || deps.nowMs() - turn > OWNER_TURN_LIVE_MS)
      return { ok: false, reason: 'no_owner_turn' };
    if (this.declinedSince(conversation, turn)) return { ok: false, reason: 'start_declined' };
    const codes = [...(input.discountCodes ?? [])];
    if (codes.length > MAX_DISCOUNT_CODES || !codes.every((c) => DISCOUNT_CODE.test(c)))
      return { ok: false, reason: 'bad_discount_code' };
    const targets = lineTargets(deps.search, conversation, input.lines);
    if (!targets.ok) return targets;
    const settings = deps.settings();
    if (!settings.merchants.includes(targets.merchant))
      return { ok: false, reason: 'merchant_not_allowed' };
    const opened = await this.open(targets.merchant);
    if (!opened.ok) return opened;
    const connection = opened.connection;
    if (!connection.schemas.available('create_checkout'))
      return { ok: false, reason: 'checkout_unavailable' };
    const lines = await freshLines(connection, settings, input.lines, targets.list);
    if (!lines.ok) return lines;
    const shown = startCardLines(lines.shown);
    // A price the card cannot show is not one the owner can approve.
    if (shown.some((l) => !/^(0|[1-9]\d{0,14})$/.test(l.price.amount)))
      return { ok: false, reason: 'price_unreadable' };

    const intent: CheckoutIntent = {
      merchantOrigin: connection.merchant.origin,
      ...negotiatedNow(connection),
      lines: lines.lines,
      discountCodes: codes,
      context: settings.context,
    };
    if (!validateIntent(intent).ok) return { ok: false, reason: 'checkout_unavailable' };
    const trust = await deps.trust(intent.merchantOrigin);
    const workflow = deps.workflow();
    if (workflow === null) return { ok: false, reason: 'no_workflow' };

    const now = deps.nowMs();
    const sessionId = `${UCP_TASK_NAMESPACE}checkout-${deps.newId()}`;
    const reviewId = `${UCP_TASK_NAMESPACE}checkout-start-${deps.newId()}`;
    const hash = checkoutIntentHash(intent, sha256);
    const card: StartCard = {
      type: UCP_CHECKOUT_START_TYPE,
      session_id: sessionId,
      intent_hash: hash,
      merchant: intent.merchantOrigin,
      trust: startCardTrust(trust),
      lines: shown,
      discount_codes: codes,
      personal_data: [],
    };
    const expiresAtMs = now + START_CARD_TTL_MS;
    const raised = deps.store.transaction((): boolean => {
      // Brain asking past the owner: only a few start cards wait at once.
      const waiting = deps.store
        .activeCheckouts()
        .filter(
          (s) =>
            s.conversation === conversation &&
            s.state === 'awaiting_approval' &&
            s.permit_id === null &&
            workflow.store().getById(s.review_id)?.status === WorkflowTaskState.PendingApproval,
        ).length;
      if (waiting >= MAX_PENDING_STARTS) return false;
      deps.store.insertCheckout({
        session_id: sessionId,
        conversation,
        merchant_origin: intent.merchantOrigin,
        leaf_profile_url: connection.merchant.profileUrl,
        version: intent.version,
        transport: intent.transport,
        endpoint: intent.endpoint,
        capabilities_hash: canonicalDigest(intentJson(intent).capabilities),
        // For the record only: a key rotation alone never voids the permit.
        profile_hash: canonicalDigest(
          connection.merchant.profile as unknown as Record<string, unknown>,
        ),
        intent_json: storeIntent(intent),
        intent_hash: hash,
        review_id: reviewId,
        state: 'awaiting_approval',
        created_at: now,
      });
      workflow.create({
        id: reviewId,
        kind: WorkflowTaskKind.Approval,
        description: startCardDescription(card),
        idempotencyKey: `${UCP_TASK_NAMESPACE}checkout-start:${sessionId}`,
        payload: JSON.stringify(card),
        expiresAtSec: Math.floor(expiresAtMs / 1000),
        correlationId: UCP_CHECKOUT_START_TYPE,
        priority: WorkflowTaskPriority.UserBlocking,
        origin: 'system',
        initialState: WorkflowTaskState.PendingApproval,
      });
      return true;
    });
    if (!raised) return { ok: false, reason: 'too_many_starts' };
    deps.search.touchHandles(
      conversation,
      input.lines.map((l) => l.variant),
      now,
    );
    return {
      ok: true,
      session: { session_id: sessionId, state: 'awaiting_approval', review_id: reviewId },
      expiresAtMs,
    };
  }

  /**
   * The owner's decision on a start card. A yes mints the permit and starts
   * the create; a no or a lapse declines the session. Idempotent: the
   * handler and the sweep may both run it.
   */
  decide(
    task: WorkflowTask,
    decision: ApprovalDecision,
  ): 'minted' | 'declined' | 'handed_over' | 'ignored' {
    const handoff = readHandoffCard(task.payload);
    if (handoff !== null) return this.decideHandoff(task, handoff, decision);
    const card = readStartCard(task.payload);
    if (card === null) return 'ignored';
    const outcome =
      decision === 'approved' ? this.mint(task.id, card) : this.decline(task.id, card);
    if (outcome === 'minted') void this.run(card.session_id).catch(() => undefined);
    return outcome;
  }

  /**
   * The owner's yes to the hand-off card: the card completes with the URL
   * its surface opens. Nothing is sent to the merchant either way: a no, or
   * a lapse, leaves the session to expire there (the watcher still reads it).
   */
  private decideHandoff(
    task: WorkflowTask,
    card: HandoffCard,
    decision: ApprovalDecision,
  ): 'handed_over' | 'ignored' {
    const { deps } = this;
    const workflow = deps.workflow();
    if (workflow === null || decision !== 'approved') return 'ignored';
    const row = deps.store.getCheckout(card.session_id);
    if (row === null || task.idempotency_key !== handoffKey(card.session_id)) return 'ignored';
    return deps.store.transaction(() => {
      if (workflow.store().getById(task.id)?.status !== WorkflowTaskState.Queued) return 'ignored';
      settleCard(workflow, task.id, deps.nowMs(), {
        ok: true,
        result: { session_id: card.session_id, handoff_url: card.handoff.url },
      });
      return 'handed_over';
    });
  }

  private mint(reviewId: string, card: StartCard): 'minted' | 'declined' | 'ignored' {
    const { deps } = this;
    const workflow = deps.workflow();
    if (workflow === null) return 'ignored';
    return deps.store.transaction(() => {
      const row = deps.store.checkoutByReview(reviewId);
      if (row === null || row.session_id !== card.session_id) return 'ignored';
      const approval = workflow.store().getById(reviewId);
      if (approval === null || approval.status !== WorkflowTaskState.Queued) return 'ignored';
      const now = deps.nowMs();
      // The card must name exactly the intent its session holds.
      if (card.intent_hash !== row.intent_hash || readStoredIntent(row) === null) {
        deps.store.moveCheckout(row.session_id, ['awaiting_approval'], 'declined', now);
        settleCard(workflow, reviewId, now, { ok: false, reason: 'intent_mismatch' });
        return 'declined';
      }
      const permitId = `${UCP_TASK_NAMESPACE}permit-${deps.newId()}`;
      if (!deps.store.mintPermit(row.session_id, permitId, now + PERMIT_TTL_MS, now))
        return 'ignored';
      settleCard(workflow, reviewId, now, {
        ok: true,
        result: { session_id: row.session_id, permit_id: permitId },
      });
      return 'minted';
    });
  }

  private decline(reviewId: string, card: StartCard): 'declined' | 'ignored' {
    const { store, nowMs } = this.deps;
    const row = store.checkoutByReview(reviewId);
    if (row === null || row.session_id !== card.session_id) return 'ignored';
    return store.moveCheckout(row.session_id, ['awaiting_approval'], 'declined', nowMs())
      ? 'declined'
      : 'ignored';
  }

  // ------------------------------------------------------------ sending

  /**
   * Do whatever a session is owed: resend its open request under that
   * request's own gate, then send the create its permit allows. Safe to run
   * any number of times (the sweep, a restart, the owner's yes).
   */
  async run(sessionId: string): Promise<CheckoutResult> {
    const row = this.deps.store.getCheckout(sessionId);
    if (row === null) return { ok: false, reason: 'unknown_session' };
    if (!PERMIT_STATES.includes(row.state)) return { ok: false, reason: 'session_closed' };
    // Nothing owed, nothing sent: no merchant is asked (the sweep runs every minute).
    const open = this.deps.store.openRequest('checkout', sessionId);
    if (open === null) {
      const now = this.deps.nowMs();
      if (
        row.state === 'open' &&
        row.effective_expires_at !== null &&
        now >= row.effective_expires_at
      ) {
        // Expired at the merchant without a hand-off.
        this.endSession(sessionId, 'not_completed', 'expired');
        return { ok: false, reason: 'session_closed' };
      }
      if (row.state === 'awaiting_approval' && row.permit_id !== null && !this.permitLive(row)) {
        this.endSession(sessionId, 'lapsed', 'permit_lapsed');
        return { ok: false, reason: 'session_closed' };
      }
      if (row.state !== 'awaiting_approval' || !this.permitLive(row))
        return { ok: true, session: view(row), outcome: 'settled' };
    }
    const opened = await this.open(row.merchant_origin);
    if (!opened.ok) return opened;
    const earlier = await this.resumeEarlier(sessionId, opened.connection);
    const now = this.deps.store.getCheckout(sessionId) as CheckoutRow;
    if (earlier !== null && earlier.kind !== 'answered' && earlier.kind !== 'abandoned')
      return { ok: true, session: view(now), outcome: 'pending' };
    if (now.state !== 'awaiting_approval' || !this.permitLive(now))
      return { ok: true, session: view(now), outcome: 'settled' };
    return this.change(sessionId, opened.connection, 'create_checkout', () => {
      const fresh = this.deps.store.getCheckout(sessionId);
      const intent = fresh === null ? null : readStoredIntent(fresh);
      return intent === null ? null : { payload: buildCreateCheckoutBody(intent) };
    });
  }

  /**
   * Send an update the permit covers: the approved lines, codes and context
   * again (a full replacement), with the merchant's own line ids and the
   * owner's fulfillment choice among the merchant's offers.
   */
  async update(
    conversation: string,
    sessionId: string,
    selection?: FulfillmentSelection,
  ): Promise<CheckoutResult> {
    const row = this.owned(conversation, sessionId);
    if (row === null) return { ok: false, reason: 'unknown_session' };
    if (row.state !== 'open') return { ok: false, reason: 'session_closed' };
    const opened = await this.open(row.merchant_origin);
    if (!opened.ok) return opened;
    let outside: string | null = null;
    const result = await this.change(sessionId, opened.connection, 'update_checkout', () => {
      // Under the slot, from the session as it stands now.
      const fresh = this.deps.store.getCheckout(sessionId);
      if (fresh?.state !== 'open' || fresh.merchant_checkout_id === null) return null;
      const intent = readStoredIntent(fresh);
      const last = lastAnswer(fresh);
      if (intent === null || last === null) return null;
      // A choice Brain proposed names only what the merchant offered, or nothing is built.
      const offered =
        selection === undefined
          ? { ok: true as const }
          : checkSelection(intent, last.checkout, selection);
      if (!offered.ok) {
        outside = offered.reason;
        return null;
      }
      const body = buildUpdateCheckoutBody(intent, last.checkout, selection);
      const fits = checkUpdateFitsIntent(intent, last.raw, body);
      if (!fits.ok) {
        outside = fits.reason;
        return null;
      }
      return { id: fresh.merchant_checkout_id, payload: body };
    });
    return outside !== null ? { ok: false, reason: 'outside_permit', detail: outside } : result;
  }

  // ------------------------------------------------------------ the hand-off

  /**
   * The hand-off barrier and card (§3.7, §3.8). Every mutation the session
   * ever sent must have a definite answer: an open one is resent with its
   * stored bytes and key first, and while it stays unsettled no card is
   * raised. Then the checkout is read again, and in one transaction under
   * the session's slot (so no mutation can be admitted in between) the card
   * is raised from that answer, the session moves to `handed_off` and the
   * permit is voided: nothing more is sent on the session, whatever happens
   * to the card. Asked again, it answers with the card already raised.
   */
  async handoff(conversation: string, sessionId: string): Promise<HandoffResult> {
    const { deps } = this;
    const row = this.owned(conversation, sessionId);
    if (row === null) return { ok: false, reason: 'unknown_session' };
    const workflow = deps.workflow();
    if (workflow === null) return { ok: false, reason: 'no_workflow' };
    const key = handoffKey(sessionId);
    if (row.state === 'handed_off') {
      const raised = workflow.store().getActiveByIdempotencyKey(key);
      return raised !== null
        ? { ok: true, session: view(row), reviewId: raised.id }
        : { ok: false, reason: 'session_closed' };
    }
    if (row.state !== 'open') return { ok: false, reason: 'session_closed' };
    const opened = await this.open(row.merchant_origin);
    if (!opened.ok) return opened;
    const { connection } = opened;

    // The barrier: whatever was sent settles first.
    const earlier = await this.resumeEarlier(sessionId, connection);
    if (earlier !== null && earlier.kind !== 'answered')
      return earlier.kind === 'abandoned'
        ? { ok: false, reason: 'session_closed' }
        : { ok: false, reason: 'not_settled' };
    const before = deps.store.getCheckout(sessionId) as CheckoutRow;
    if (before.state !== 'open' || before.merchant_checkout_id === null)
      return { ok: false, reason: 'session_closed' };

    // The checkout as the merchant holds it now (a read: no permit, no key).
    const answer = await connection.call('get_checkout', { id: before.merchant_checkout_id });
    const now = deps.nowMs();
    if (isNotFound(answer)) {
      this.endSession(sessionId, 'unknown', 'not_found');
      return { ok: false, reason: 'session_closed' };
    }
    const read = answer.ok ? readCheckout(answer.value) : null;
    if (read === null) return { ok: false, reason: 'merchant_unreachable' };
    // An answer about another checkout is not this session's.
    if (!read.ok || !answer.ok || read.value.id !== before.merchant_checkout_id)
      return { ok: false, reason: 'answer_unreadable' };
    const checkout = read.value;
    if (checkout.status === 'canceled' || checkout.status === 'completed') {
      // Ended at the merchant before any card (in its browser, say): a completed one's order is followed.
      if (checkout.status === 'completed') this.complete(sessionId, PERMIT_STATES, checkout.order);
      else this.endSession(sessionId, 'canceled', 'canceled');
      return { ok: false, reason: 'session_closed' };
    }
    // The buyer is completing it at the merchant already: no card, and the watcher follows it.
    if (checkout.status === 'complete_in_progress') {
      this.toWatcher(sessionId, JSON.stringify(answer.value));
      return { ok: false, reason: 'session_closed' };
    }
    const answerJson = JSON.stringify(answer.value);
    const expiresAt =
      checkout.expiresAt ??
      before.effective_expires_at ??
      effectiveExpiry(checkout, before.created_at);
    if (expiresAt <= now) {
      this.endSession(sessionId, 'not_completed', 'expired');
      return { ok: false, reason: 'session_closed' };
    }
    if (
      !deps.store.setCheckoutAnswerIfUnchanged(sessionId, before.last_answer_json, now, {
        effective_expires_at: expiresAt,
        last_answer_json: answerJson,
      })
    )
      return { ok: false, reason: 'busy' };

    const intent = readStoredIntent(before);
    if (intent === null) return { ok: false, reason: 'session_closed' };
    const url = handoffUrl({
      merchantOrigin: before.merchant_origin,
      profileHosts: profileHosts(connection),
      now,
      checkout: {
        ...(checkout.continueUrl !== undefined ? { continueUrl: checkout.continueUrl } : {}),
        expiresAt,
      },
      ...permalinkFor(connection, intent),
      // A URL the surfaces cannot carry moves on to the next step of the chain.
      maxBytes: MAX_HANDOFF_URL_BYTES,
    });
    const card = buildHandoffCard(
      sessionId,
      before.merchant_origin,
      checkout,
      expiresAt,
      { url: url.url, source: url.source, off_host: url.offHost },
      specErrorCode,
    );
    const reviewId = `${UCP_TASK_NAMESPACE}checkout-handoff-${deps.newId()}`;
    const fenced = deps.dispatcher.exclusive({ kind: 'checkout', id: sessionId }, () => {
      const current = deps.store.getCheckout(sessionId);
      // Nothing moved since the read: the card shows exactly the answer the merchant holds.
      if (current?.state !== 'open' || current.last_answer_json !== answerJson) return false;
      const at = deps.nowMs();
      workflow.create({
        id: reviewId,
        kind: WorkflowTaskKind.Approval,
        description: handoffCardDescription(card),
        idempotencyKey: key,
        payload: JSON.stringify(card),
        expiresAtSec: Math.floor(expiresAt / 1000),
        correlationId: UCP_CHECKOUT_HANDOFF_TYPE,
        priority: WorkflowTaskPriority.UserBlocking,
        origin: 'system',
        initialState: WorkflowTaskState.PendingApproval,
      });
      deps.store.moveCheckout(sessionId, ['open'], 'handed_off', at, {
        handoff_source: url.source,
        handed_off_at: at,
        // Only a hand-off to the session itself can be followed (§3.12).
        watch_next_at: url.source === 'continue_url' ? watchReadAt(at, 0) : null,
      });
      deps.store.voidPermit(sessionId, 'handed_off', at);
      return true;
    });
    if (fenced.kind === 'open') return { ok: false, reason: 'not_settled' };
    if (fenced.kind === 'busy' || !fenced.value) return { ok: false, reason: 'busy' };
    return {
      ok: true,
      session: view(deps.store.getCheckout(sessionId) as CheckoutRow),
      reviewId,
    };
  }

  /** Read the session back from the merchant and keep its answer (never a send). */
  private async reconcile(sessionId: string, connection: MerchantConnection): Promise<void> {
    const { deps } = this;
    const row = deps.store.getCheckout(sessionId);
    if (row === null || row.merchant_checkout_id === null) return;
    if (row.state !== 'open' && row.state !== 'unsettled') return;
    const answer = await connection.call('get_checkout', { id: row.merchant_checkout_id });
    const now = deps.nowMs();
    const end = (to: CheckoutState, reason: string) =>
      deps.store.transaction(() => {
        deps.store.moveCheckout(sessionId, [...PERMIT_STATES, 'unsettled'], to, now);
        deps.store.voidPermit(sessionId, reason, now);
      });
    if (isNotFound(answer)) {
      end('unknown', 'not_found');
      return;
    }
    const read = answer.ok ? readCheckout(answer.value) : null;
    if (read?.ok !== true || !answer.ok || read.value.id !== row.merchant_checkout_id) return;
    // The merchant's word on how the session stands: ended there, it ends here.
    if (read.value.status === 'completed') {
      this.complete(sessionId, [...PERMIT_STATES, 'unsettled'], read.value.order);
      return;
    }
    if (read.value.status === 'canceled') {
      end('canceled', 'canceled');
      return;
    }
    if (read.value.status === 'complete_in_progress' && row.state === 'open') {
      this.toWatcher(sessionId, JSON.stringify(answer.value));
      return;
    }
    // Otherwise for the record only (an unsettled session never gets a hand-off from it),
    // and only over the answer this read started from: a change admitted meanwhile keeps
    // its newer answer.
    deps.store.setCheckoutAnswerIfUnchanged(
      sessionId,
      row.last_answer_json,
      now,
      {
        effective_expires_at:
          read.value.expiresAt ??
          row.effective_expires_at ??
          effectiveExpiry(read.value, row.created_at),
        last_answer_json: JSON.stringify(answer.value),
      },
      ['open', 'unsettled'],
    );
  }

  /**
   * A session the merchant reports `complete_in_progress`: the buyer is completing it there.
   * The platform MUST NOT start another update meanwhile (checkout/index.md:451), and a
   * hand-off card would mislead, so it leaves Dina's hands as a hand-off does: permit void,
   * and the watcher reads it on its schedule (its expiry rule applies).
   */
  private toWatcher(sessionId: string, answerJson: string): void {
    const now = this.deps.nowMs();
    this.deps.store.transaction(() => {
      const moved = this.deps.store.moveCheckout(sessionId, ['open'], 'handed_off', now, {
        handoff_source: 'continue_url',
        handed_off_at: now,
        watch_next_at: watchReadAt(now, 0),
        last_status: 'complete_in_progress',
        last_answer_json: answerJson,
      });
      if (moved) this.deps.store.voidPermit(sessionId, 'completing', now);
    });
  }

  /** A session the merchant reports completed: recorded with its order, which is then followed (§3.12). */
  private complete(
    sessionId: string,
    from: readonly CheckoutState[],
    order: { id: string; permalinkUrl: string } | undefined,
  ): void {
    const now = this.deps.nowMs();
    this.deps.store.completeCheckout(sessionId, from, order, now, (row) =>
      this.deps.onCompleted?.(row, now),
    );
  }

  /** End a session before any hand-off: its state, and its permit voided. */
  private endSession(sessionId: string, to: CheckoutState, reason: string): void {
    const now = this.deps.nowMs();
    this.deps.store.transaction(() => {
      this.deps.store.moveCheckout(sessionId, PERMIT_STATES, to, now);
      this.deps.store.voidPermit(sessionId, reason, now);
    });
  }

  /** Whether the owner said no to a start card here after their last turn. */
  private declinedSince(conversation: string, turn: number): boolean {
    const workflow = this.deps.workflow();
    if (workflow === null) return false;
    return this.deps.store.checkoutsOf(conversation).some((s) => {
      if (s.state !== 'declined') return false;
      const card = workflow.store().getById(s.review_id);
      return (
        card !== null && card.status === WorkflowTaskState.Cancelled && card.updated_at >= turn
      );
    });
  }

  // ------------------------------------------------------------ Brain's view

  /**
   * A session as Brain may read it (§3.11): its state, the lines by the
   * handles Brain saw, quantities in steps, amounts in minor units, totals by
   * the spec's types (a merchant's own label reads `other`), the merchant's
   * messages by the spec's codes only (their text withheld), and the delivery
   * choices it offered as `c1`, `c2`… with their costs (their titles
   * withheld). `rev` names the answer the view was read from: a choice made
   * against an older one is refused. None of the merchant's words or ids.
   */
  view(conversation: string, sessionId: string): BrainCheckoutView | null {
    const row = this.owned(conversation, sessionId);
    if (row === null) return null;
    const { search, nowMs } = this.deps;
    const last = lastAnswer(row);
    const checkout = last?.checkout;
    const currency = checkout?.currency ?? '';
    return {
      session_id: row.session_id,
      state: row.state,
      merchant: search.handle(
        conversation,
        { kind: 'merchant', merchantOrigin: row.merchant_origin, value: row.merchant_origin },
        nowMs(),
      ),
      ...(row.effective_expires_at !== null ? { expires_at: row.effective_expires_at } : {}),
      ...(checkout !== undefined
        ? {
            status: typeof checkout.status === 'string' ? checkout.status : 'unknown',
            rev: answerRev(row.last_answer_json as string),
            lines: checkout.lineItems.map((l) => {
              const total = l.totals.find((t) => t.type === 'total');
              return {
                // A line Brain never saw (the merchant added it) has no handle.
                variant: search.variantHandle(conversation, row.merchant_origin, l.itemId) ?? '',
                quantity: Number(l.quantity),
                ...(total !== undefined
                  ? { total: { amount: String(total.amount), currency } }
                  : {}),
              };
            }),
            totals: checkout.totals.map((t) => ({
              type: isWellKnownTotalType(t.type) ? t.type : 'other',
              amount: String(t.amount),
              currency,
            })),
            messages: checkout.messages.messages.map((m) => ({
              kind: m.type,
              code: m.code !== undefined ? specErrorCode(m.code) : '',
              text: 'merchant text withheld',
            })),
            choices: deliveryChoices(checkout).map((c, i) => ({
              choice: `c${i + 1}`,
              method: METHOD_TYPES.has(c.methodType) ? c.methodType : 'other',
              chosen: c.chosen,
              ...(c.cost !== undefined ? { cost: { amount: String(c.cost), currency } } : {}),
            })),
          }
        : {}),
    };
  }

  /**
   * Choose one of the delivery choices the view offered, by its `cN` and the
   * `rev` it was read under: an update the permit covers (§3.7).
   */
  async choose(
    conversation: string,
    sessionId: string,
    choice: string,
    rev: string,
  ): Promise<CheckoutResult> {
    const row = this.owned(conversation, sessionId);
    if (row === null) return { ok: false, reason: 'unknown_session' };
    const last = lastAnswer(row);
    if (last === null || row.last_answer_json === null)
      return { ok: false, reason: 'session_closed' };
    if (answerRev(row.last_answer_json) !== rev) return { ok: false, reason: 'checkout_changed' };
    const m = /^c([1-9]\d{0,2})$/.exec(choice);
    const picked = m === null ? undefined : deliveryChoices(last.checkout)[Number(m[1]) - 1];
    if (picked === undefined)
      return { ok: false, reason: 'outside_permit', detail: 'unknown_choice' };
    return this.update(conversation, sessionId, picked.selection);
  }

  /** Cancel a session at the merchant: only while `open`, under its permit. */
  async cancel(conversation: string, sessionId: string): Promise<CheckoutResult> {
    const row = this.owned(conversation, sessionId);
    if (row === null) return { ok: false, reason: 'unknown_session' };
    if (row.state !== 'open') return { ok: false, reason: 'session_closed' };
    const opened = await this.open(row.merchant_origin);
    if (!opened.ok) return opened;
    return this.change(sessionId, opened.connection, 'cancel_checkout', () => {
      const fresh = this.deps.store.getCheckout(sessionId);
      return fresh?.state === 'open' && fresh.merchant_checkout_id !== null
        ? { id: fresh.merchant_checkout_id }
        : null;
    });
  }

  /**
   * Repair what a crash or a missed handler left, and send what is owed: a
   * card approved with no permit is minted for, a card denied or lapsed
   * declines its session, and every session with work is run.
   */
  async sweep(): Promise<void> {
    const { deps } = this;
    const workflow = deps.workflow();
    if (workflow === null) return;
    for (const row of deps.store.activeCheckouts()) {
      if (row.state === 'awaiting_approval' && row.permit_id === null) {
        const card = workflow.store().getById(row.review_id);
        if (card === null) continue;
        if (card.status === WorkflowTaskState.Queued) this.decide(card, 'approved');
        else if (
          card.status === WorkflowTaskState.Cancelled ||
          card.status === WorkflowTaskState.Failed ||
          (card.status === WorkflowTaskState.PendingApproval &&
            (card.expires_at ?? 0) * 1000 <= deps.nowMs())
        )
          this.decide(card, 'denied');
        continue;
      }
      try {
        await this.run(row.session_id);
      } catch {
        /* one session's fault never holds up the others */
      }
    }
  }

  // ------------------------------------------------------------ the gate

  /** A permit that may still be used: minted, not voided, not past its own end or the session's. */
  private permitLive(row: CheckoutRow): boolean {
    const now = this.deps.nowMs();
    return (
      row.permit_id !== null &&
      row.permit_void_reason === null &&
      row.permit_expires_at !== null &&
      now < row.permit_expires_at &&
      (row.effective_expires_at === null || now < row.effective_expires_at) &&
      PERMIT_STATES.includes(row.state)
    );
  }

  /**
   * The one gate (§3.7): the state each operation is sent in, a live permit,
   * and what each answer and each abandoned request does to the session.
   */
  private gateFor(
    sessionId: string,
    operation: CheckoutOperation,
    connection: MerchantConnection,
  ): Gate {
    const { store, nowMs } = this.deps;
    const row = () => store.getCheckout(sessionId);
    const from: CheckoutState = operation === 'create_checkout' ? 'creating' : 'open';
    const live = () => {
      const r = row();
      return r !== null && this.permitLive(r) ? r : null;
    };
    const end = (
      to: CheckoutState,
      reason: string,
      set: Parameters<UcpCheckoutStore['moveCheckout']>[4] = {},
    ) => {
      const now = nowMs();
      store.moveCheckout(sessionId, PERMIT_STATES, to, now, set);
      store.voidPermit(sessionId, reason, now);
    };
    return {
      admitFirst: () => {
        const r = live();
        if (r === null) return false;
        if (r.state !== (operation === 'create_checkout' ? 'awaiting_approval' : 'open'))
          return false;
        // Before any first send: the negotiation the owner approved, still, and the session's
        // own endpoint and transport (§3.7). A change voids the permit; before a create the
        // session is `stale` (the owner is asked again), after it the session stays open with
        // nothing more to send.
        const drifted = driftOf(r, connection);
        if (drifted !== null) {
          const now = nowMs();
          if (r.state === 'awaiting_approval')
            store.moveCheckout(sessionId, ['awaiting_approval'], 'stale', now);
          store.voidPermit(sessionId, `drift:${drifted}`, now);
          return false;
        }
        return operation === 'create_checkout'
          ? store.moveCheckout(sessionId, ['awaiting_approval'], 'creating', nowMs())
          : true;
      },
      // A resend goes to the stored endpoint whatever the profile says now (§3.10), but never
      // under another account than the one approved: that voids the permit.
      admitResend: () => {
        const r = live();
        if (r === null || r.state !== from) return false;
        if (driftOf(r, connection) === 'credential_changed') {
          store.voidPermit(sessionId, 'drift:credential_changed', nowMs());
          return false;
        }
        return true;
      },
      credential: () => {
        const r = row();
        const intent = r === null ? null : readStoredIntent(r);
        return intent?.credential ?? null;
      },
      apply: (_req: RequestRow, answer: CallResult) => {
        const now = nowMs();
        const read = answer.ok ? readCheckout(answer.value) : null;
        // A change answered about another checkout is not this session's: not applied.
        const checkout =
          read?.ok === true &&
          (operation === 'create_checkout' || read.value.id === row()?.merchant_checkout_id)
            ? read.value
            : null;
        const answerJson = answer.ok ? JSON.stringify(answer.value) : null;
        if (operation === 'create_checkout') {
          if (checkout !== null && answerJson !== null) {
            store.moveCheckout(sessionId, ['creating'], 'open', now, {
              merchant_checkout_id: checkout.id,
              effective_expires_at: effectiveExpiry(checkout, now),
              last_answer_json: answerJson,
            });
            if (checkout.status === 'canceled') end('canceled', 'canceled');
            return;
          }
          // A definite refusal (out of stock, say): no session; its answer kept for the
          // `continue_url` the owner may be offered (§3.8 step 3).
          if (!answer.ok) {
            // Only the spec's handover link is kept, never the merchant's words.
            end(
              'create_failed',
              'create_failed',
              answer.kind === 'error_response' && answer.continueUrl !== undefined
                ? { last_answer_json: JSON.stringify({ continue_url: answer.continueUrl }) }
                : {},
            );
            return;
          }
          // A success Dina cannot read: a session may exist that Dina cannot name.
          end('create_unknown', 'create_unreadable');
          return;
        }
        if (operation === 'cancel_checkout') {
          if (isNotFound(answer)) {
            end('unknown', 'canceled');
            return;
          }
          // Only the merchant's own `canceled` ends it so: a cancel can race the buyer's
          // completion (checkout/index.md:484-486), and a completed one is followed.
          if (checkout?.status === 'canceled') end('canceled', 'canceled');
          else if (checkout?.status === 'completed')
            this.complete(sessionId, [...PERMIT_STATES, 'unsettled'], checkout.order);
          else if (checkout?.status === 'complete_in_progress' && answerJson !== null)
            this.toWatcher(sessionId, answerJson);
          else if (checkout !== null && answerJson !== null)
            store.moveCheckout(sessionId, ['open'], 'open', now, { last_answer_json: answerJson });
          return;
        }
        // An update.
        if (checkout?.status === 'completed') {
          this.complete(sessionId, [...PERMIT_STATES, 'unsettled'], checkout.order);
          return;
        }
        if (checkout?.status === 'complete_in_progress' && answerJson !== null) {
          this.toWatcher(sessionId, answerJson);
          return;
        }
        if (checkout !== null && answerJson !== null) {
          store.moveCheckout(sessionId, ['open'], 'open', now, {
            // The merchant's expiry, else the one set when the session was made (§3.12).
            effective_expires_at: checkout.expiresAt ?? row()?.effective_expires_at ?? null,
            last_answer_json: answerJson,
          });
          if (checkout.status === 'canceled') end('canceled', 'canceled');
          return;
        }
        if (isNotFound(answer)) end('unknown', 'not_found');
        // Another refusal leaves the session as it was.
      },
      abandon: (_req, reason: AbandonReason, sent: boolean) => {
        if (operation === 'create_checkout') {
          // A create that may have reached the merchant is a session Dina cannot name;
          // one that never left opened nothing.
          end(sent ? 'create_unknown' : 'lapsed', `create_${reason}`);
          return;
        }
        // An update or cancel that may have reached the merchant and will now never have a
        // definite answer (deadline, three 409s, a defect, or a gate closed on its resend):
        // no hand-off can follow, since a late write could still land (§3.7). It is read back
        // for the record (`change` reconciles). One that never left changed nothing.
        if (sent || reason === 'conflict_limit' || reason === 'conflict_defect')
          end('unsettled', `${operation}_${reason}`);
      },
    };
  }

  // ------------------------------------------------------------ internals

  /**
   * Send one change, waiting (briefly) for another on the session or for the
   * merchant's Retry-After: an earlier change still open is resumed first
   * under its own gate; this one is sent only once that settles.
   */
  private async change(
    sessionId: string,
    connection: MerchantConnection,
    operation: CheckoutOperation,
    build: Mutation['build'],
  ): Promise<CheckoutResult> {
    const { deps } = this;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const until = deps.nowMs() + WAIT_MS;
    let pause = 50;
    for (;;) {
      const row = deps.store.getCheckout(sessionId) as CheckoutRow;
      const deadline = Math.min(
        deps.nowMs() + CHECKOUT_RETRY_MS,
        row.permit_expires_at ?? 0,
        row.effective_expires_at ?? Number.MAX_SAFE_INTEGER,
      );
      const result: MutateResult = await deps.dispatcher.mutate(
        { kind: 'checkout', id: sessionId },
        connection,
        { operation, build, retryDeadline: deadline },
        this.gateFor(sessionId, operation, connection),
      );
      let waitMs: number;
      if (result.kind === 'busy') waitMs = pause;
      else if (result.kind === 'earlier') {
        const earlier = await this.resumeEarlier(sessionId, connection);
        if (earlier === null || earlier.kind === 'answered' || earlier.kind === 'abandoned')
          continue;
        if (earlier.kind === 'busy') waitMs = pause;
        else if (earlier.kind === 'wait') waitMs = earlier.retryAfterMs;
        else if (earlier.kind === 'in_doubt' && earlier.retryAfterMs !== undefined)
          waitMs = earlier.retryAfterMs;
        else return { ok: false, reason: 'busy' };
      } else {
        // A change its gate closed on, which may have reached the merchant: read the session
        // back rather than send it (§3.7).
        // A change its gate closed on that may have left, or one the merchant refused (it may
        // have ended the session itself): read the session back rather than send again (§3.7).
        if (
          operation !== 'create_checkout' &&
          ((result.kind === 'abandoned' && result.sent) ||
            (result.kind === 'answered' && !result.result.ok))
        )
          await this.reconcile(sessionId, connection);
        return this.finish(sessionId, operation, result);
      }
      if (deps.nowMs() + waitMs > until) return { ok: false, reason: 'busy' };
      await sleep(waitMs);
      pause = Math.min(pause * 2, 1_000);
    }
  }

  private async resumeEarlier(
    sessionId: string,
    connection: MerchantConnection,
  ): Promise<Outcome | { kind: 'busy' } | null> {
    const open = this.deps.store.openRequest('checkout', sessionId);
    if (open === null) return null;
    return this.deps.dispatcher.resume(
      { kind: 'checkout', id: sessionId },
      connection,
      this.gateFor(sessionId, open.operation as CheckoutOperation, connection),
    );
  }

  private finish(
    sessionId: string,
    operation: CheckoutOperation,
    result: MutateResult,
  ): CheckoutResult {
    const row = this.deps.store.getCheckout(sessionId) as CheckoutRow;
    if (result.kind === 'busy') return { ok: false, reason: 'busy' };
    if (result.kind === 'not_sent')
      return { ok: false, reason: 'checkout_unavailable', detail: result.reason };
    if (result.kind === 'answered' && !result.result.ok && operation !== 'create_checkout')
      return { ok: false, reason: 'refused', detail: refusalCode(result.result) };
    if (result.kind === 'not_admitted') return { ok: false, reason: 'session_closed' };
    return {
      ok: true,
      session: view(row),
      outcome: result.kind === 'answered' || result.kind === 'abandoned' ? 'settled' : 'pending',
    };
  }

  /** The session, if it belongs to this conversation (another's reads as none). */
  private owned(conversation: string, sessionId: string): CheckoutRow | null {
    const row = this.deps.store.getCheckout(sessionId);
    return row !== null && row.conversation === conversation ? row : null;
  }

  private async open(
    merchant: string,
  ): Promise<
    { ok: true; connection: MerchantConnection } | { ok: false; reason: CheckoutRefusal }
  > {
    const notReady = this.deps.client.notReady();
    if (notReady !== null) return { ok: false, reason: notReady };
    const opened = await this.deps.client.open(merchant);
    return opened.ok
      ? { ok: true, connection: opened.connection }
      : { ok: false, reason: 'merchant_unreachable' };
  }
}

/** One hand-off card per session, ever. */
const handoffKey = (sessionId: string) => `${UCP_TASK_NAMESPACE}checkout-handoff:${sessionId}`;

/** Hosts the merchant's profile names for this connection: its endpoint's, and its permalink endpoint's. */
function profileHosts(connection: MerchantConnection): string[] {
  const hosts = [new URL(connection.merchant.endpoint).hostname];
  const permalink =
    connection.merchant.negotiated.get(PERMALINK_CAPABILITY)?.entry.config?.endpoint;
  if (typeof permalink === 'string') {
    try {
      hosts.push(new URL(permalink).hostname);
    } catch {
      /* not a URL: it names no host */
    }
  }
  return hosts;
}

/** The approved lines as a permalink, when the merchant offers one (§3.8 step 2). */
function permalinkFor(
  connection: MerchantConnection,
  intent: CheckoutIntent,
): { permalink?: { endpoint: string; lines: { itemId: string; quantity: bigint }[] } } {
  const endpoint = connection.merchant.negotiated.get(PERMALINK_CAPABILITY)?.entry.config?.endpoint;
  return typeof endpoint === 'string'
    ? {
        permalink: {
          endpoint,
          lines: intent.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
        },
      }
    : {};
}

const PERMALINK_CAPABILITY = 'dev.ucp.shopping.permalink';

/** What Brain reads of a session (`UcpCheckoutService.view`). */
export interface BrainCheckoutView {
  session_id: string;
  state: CheckoutState;
  merchant: string;
  expires_at?: number;
  status?: string;
  rev?: string;
  lines?: { variant: string; quantity: number; total?: { amount: string; currency: string } }[];
  totals?: { type: string; amount: string; currency: string }[];
  messages?: { kind: string; code: string; text: string }[];
  choices?: {
    choice: string;
    method: string;
    chosen: boolean;
    cost?: { amount: string; currency: string };
  }[];
}

/** Method types Brain may read as they are; a merchant's own reads `other`. */
const METHOD_TYPES: ReadonlySet<string> = new Set(['shipping', 'pickup']);

/** A short name for one stored answer, so a choice is made against the answer it was read from. */
function answerRev(answerJson: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(answerJson))).slice(0, 16);
}

/**
 * The delivery choices an answer offers, in a fixed order: each method with
 * each of its offered business locations (or none), and each option of its
 * first group (or none). Shipping to an address is not offered: Dina sends no
 * address yet (D3).
 */
function deliveryChoices(checkout: Checkout): {
  methodType: string;
  chosen: boolean;
  cost?: bigint;
  selection: FulfillmentSelection;
}[] {
  const out: ReturnType<typeof deliveryChoices> = [];
  for (const m of checkout.fulfillment) {
    if (m.type === 'shipping') continue;
    const destinations = m.destinations.filter((d) => d.type === 'business_location');
    const group = m.groups[0];
    for (const dest of destinations.length > 0 ? destinations : [undefined]) {
      for (const option of group !== undefined && group.options.length > 0
        ? group.options
        : [undefined]) {
        out.push({
          methodType: m.type,
          chosen:
            (dest === undefined || m.selectedDestinationId === dest.id) &&
            (option === undefined || group?.selectedOptionId === option.id) &&
            (dest !== undefined || option !== undefined),
          ...(option?.totals.find((t) => t.type === 'total') !== undefined
            ? { cost: option.totals.find((t) => t.type === 'total')?.amount as bigint }
            : {}),
          selection: {
            methodId: m.id,
            ...(dest !== undefined ? { destinationId: dest.id } : {}),
            ...(option !== undefined && group !== undefined
              ? { options: { [group.id]: option.id } }
              : {}),
          },
        });
      }
    }
  }
  return out;
}

function view(row: CheckoutRow): SessionView {
  return { session_id: row.session_id, state: row.state, review_id: row.review_id };
}

/** The session's last checkout answer, read back through the same reader as a live one. */
function lastAnswer(row: CheckoutRow): { checkout: Checkout; raw: Record<string, unknown> } | null {
  if (row.last_answer_json === null) return null;
  const json = parseStrictJson(row.last_answer_json);
  if (!json.ok || !isRecord(json.value)) return null;
  const read = readCheckout(json.value);
  return read.ok ? { checkout: read.value, raw: json.value } : null;
}

/** UCP checkout's part of the workflow service: the start card's decision. */
export function makeUcpCheckoutDecisionHandler(
  service: () => UcpCheckoutService | null,
): ApprovalDecisionHandler {
  return ({ task, decision }) => {
    if (readStartCard(task.payload) === null && readHandoffCard(task.payload) === null) return;
    service()?.decide(task, decision);
  };
}
