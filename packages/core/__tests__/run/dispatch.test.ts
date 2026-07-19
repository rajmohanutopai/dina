/**
 * ISVC-5 — risk gate + atomic outbox claim + completion advancement
 * (INTERACTIVE_SERVICES_ARCHITECTURE.md §6.2/§6.3/§8).
 */

import {
  CompletionService,
  InMemoryCompletionReceiptRepository,
  type IngestCompletionInput,
} from '../../src/run/completion';
import { RunDispatchService, deriveDelegationId } from '../../src/run/dispatch';
import { InMemoryMessageRepository, type MessageRecord } from '../../src/run/message';
import { InMemoryRunRepository } from '../../src/run/repository';

import type { RunRecord } from '../../src/run/domain';

const NOW = 1_700_000_000_000;

function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: 'r1',
    idempotency_key: 'k1',
    service_uri: 'at://x/y/z',
    provider_did: 'did:plc:p',
    persona: 'general',
    transport: 'pull',
    push_grant_ref: null,
    provider_grant_id: null,
    provider_grant_expires_at_sec: null,
    interval_ms: 0,
    next_fetch_at: NOW,
    queue_cap: 4,
    action_risk_ceiling: 'MODERATE',
    priority_ceiling: 'solicited',
    classify_timeout_ms: 15_000,
    muted: false,
    on_stop: 'cancel_pending',
    erasure_mode: 'logical_deletion',
    paused_reason: null,
    stop_on_command: true,
    max_count: null,
    max_count_basis: 'decided',
    stop_on_exhaustion: true,
    expires_at: NOW + 3_600_000,
    drain_deadline_ms: 60_000,
    drain_deadline_at: null,
    drain_cause: null,
    drain_strength: null,
    config_version: 0,
    fetch_cursor: 0,
    last_commit_at: null,
    produced_count: 0,
    decided_count: 0,
    state: 'active',
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function makeMsg(over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    message_id: 'm1',
    run_id: 'r1',
    reservation_id: 'res1',
    dedup_key: 'd1',
    sequence: 1,
    kind: 'action',
    action_type: 'book',
    risk_class: 'SAFE',
    state: 'approved',
    decision: 'approve',
    decision_revision: 7,
    delegation_id: null,
    expires_at: NOW + 60_000,
    payload_ref: 'cid1',
    tier_candidate: null,
    final_tier: 2,
    tier_source: 'action_base',
    reconciliation_evidence: '[]',
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function setup(opts: { run?: Partial<RunRecord>; personaOpen?: boolean } = {}) {
  const messages = new InMemoryMessageRepository();
  const runs = new InMemoryRunRepository();
  const receipts = new InMemoryCompletionReceiptRepository();
  runs.create(makeRun(opts.run));
  const dispatch = new RunDispatchService({
    messageRepo: messages,
    runRepo: runs,
    nowMsFn: () => NOW,
    isPersonaOpen: () => opts.personaOpen ?? true,
  });
  return { messages, runs, receipts, dispatch };
}

describe('risk gate (§6.3)', () => {
  it('SAFE → risk_authorized immediately', () => {
    const { messages, dispatch } = setup();
    messages.create(makeMsg({ risk_class: 'SAFE' }));
    expect(dispatch.evaluateRisk('m1')).toEqual({ state: 'risk_authorized' });
    expect(messages.getById('m1')?.state).toBe('risk_authorized');
  });

  it('MODERATE within ceiling → risk_pending, then owner confirm authorizes', () => {
    const { messages, dispatch } = setup({ run: { action_risk_ceiling: 'HIGH' } });
    messages.create(makeMsg({ risk_class: 'MODERATE' }));
    expect(dispatch.evaluateRisk('m1')).toEqual({ state: 'risk_pending' });
    expect(messages.getById('m1')?.state).toBe('risk_pending');
    expect(dispatch.authorizeRisk('m1')).toBe(true);
    expect(messages.getById('m1')?.state).toBe('risk_authorized');
  });

  it('above the ceiling → policy_refused', () => {
    const { messages, dispatch } = setup({ run: { action_risk_ceiling: 'MODERATE' } });
    messages.create(makeMsg({ risk_class: 'HIGH' }));
    expect(dispatch.evaluateRisk('m1')).toEqual({ state: 'policy_refused', reason: 'above_ceiling' });
    expect(messages.getById('m1')?.state).toBe('policy_refused');
  });

  it('BLOCKED → policy_refused', () => {
    const { messages, dispatch } = setup();
    messages.create(makeMsg({ risk_class: 'BLOCKED' }));
    expect(dispatch.evaluateRisk('m1')).toEqual({ state: 'policy_refused', reason: 'blocked' });
  });

  it('a non-approved message is refused', () => {
    const { messages, dispatch } = setup();
    messages.create(makeMsg({ state: 'classified', decision: null }));
    expect(dispatch.evaluateRisk('m1').state).toBe('policy_refused');
  });

  it('holds (does NOT authorize) a SAFE action while the persona is LOCKED (F6/§18)', () => {
    const { messages, dispatch } = setup({ personaOpen: false });
    messages.create(makeMsg({ risk_class: 'SAFE' }));
    // Even a SAFE action must not advance to risk_authorized under a locked
    // persona — it holds `approved` and re-gates on unlock.
    expect(dispatch.evaluateRisk('m1')).toEqual({ state: 'risk_pending' });
    expect(messages.getById('m1')?.state).toBe('approved');
  });
});

describe('atomic outbox claim (§8)', () => {
  it('claims once, minting a stable delegation id', () => {
    const { messages, dispatch } = setup();
    messages.create(makeMsg({ state: 'risk_authorized', decision_revision: 7 }));
    const out = dispatch.claimDispatch('m1');
    expect(out).toEqual({ claimed: true, delegation_id: deriveDelegationId('r1', 'm1', 7) });
    expect(messages.getById('m1')?.state).toBe('sending');
    expect(messages.getById('m1')?.delegation_id).toBe(deriveDelegationId('r1', 'm1', 7));
    // a second claim (now sending) fails → at most one delegation
    expect(dispatch.claimDispatch('m1')).toEqual({ claimed: false, reason: 'not_authorized' });
  });

  it('the claim guard fails when the persona is locked (row held, not sent)', () => {
    const { messages, dispatch } = setup({ personaOpen: false });
    messages.create(makeMsg({ state: 'risk_authorized' }));
    expect(dispatch.claimDispatch('m1')).toEqual({ claimed: false, reason: 'guard_failed' });
    expect(messages.getById('m1')?.state).toBe('risk_authorized'); // held
  });

  it('the claim guard fails past the run hard TTL', () => {
    const { messages, dispatch } = setup({ run: { expires_at: NOW - 1 } });
    messages.create(makeMsg({ state: 'risk_authorized' }));
    expect(dispatch.claimDispatch('m1').claimed).toBe(false);
  });

  it('a permissive drain before the deadline still dispatches; a fencing drain does not', () => {
    const permissive = setup({
      run: { state: 'draining', drain_strength: 'permissive', drain_cause: 'count', drain_deadline_at: NOW + 10_000 },
    });
    permissive.messages.create(makeMsg({ state: 'risk_authorized' }));
    expect(permissive.dispatch.claimDispatch('m1').claimed).toBe(true);

    const fencing = setup({
      run: { state: 'draining', drain_strength: 'fencing', drain_cause: 'cancel_pending', drain_deadline_at: NOW + 10_000 },
    });
    fencing.messages.create(makeMsg({ state: 'risk_authorized' }));
    expect(fencing.dispatch.claimDispatch('m1').claimed).toBe(false);
  });

  it('deriveDelegationId is deterministic + revision-bound', () => {
    expect(deriveDelegationId('r1', 'm1', 7)).toBe(deriveDelegationId('r1', 'm1', 7));
    expect(deriveDelegationId('r1', 'm1', 7)).not.toBe(deriveDelegationId('r1', 'm1', 8));
  });
});

describe('completion advancement (§6.2)', () => {
  function pipeline(over: { verify?: (i: IngestCompletionInput) => boolean } = {}) {
    const { messages, runs, receipts, dispatch } = setup();
    messages.create(makeMsg({ state: 'risk_authorized', decision_revision: 7 }));
    const claim = dispatch.claimDispatch('m1');
    if (!claim.claimed) throw new Error('claim failed');
    dispatch.markDispatched('m1'); // sending → dispatched
    const completion = new CompletionService({
      messageRepo: messages,
      receiptRepo: receipts,
      nowMsFn: () => NOW,
      // These suites exercise the ADVANCEMENT state machine, so they stand in a
      // validly-signed receipt (verifier passes) unless a case explicitly injects
      // a failing verifier. The verifier is fail-closed by default (an unwired
      // verifier rejects), so a passing stub is required to reach advancement.
      verifyReceipt: over.verify ?? (() => true),
    });
    return { messages, runs, receipts, completion, delegationId: claim.delegation_id };
  }

  function receipt(delegationId: string, status: 'completed' | 'failed' = 'completed'): IngestCompletionInput {
    return { delegation_id: delegationId, message_id: 'm1', run_id: 'r1', status, issued_at: NOW };
  }

  it('verified + CAS-advanced on ingestion; a repeat is a duplicate no-op', () => {
    const { messages, completion, delegationId } = pipeline();
    expect(completion.ingestCompletion(receipt(delegationId))).toBe('advanced');
    expect(messages.getById('m1')?.state).toBe('completed');
    expect(completion.ingestCompletion(receipt(delegationId))).toBe('duplicate');
    expect(messages.getById('m1')?.state).toBe('completed');
  });

  it('a failed completion advances to failed', () => {
    const { messages, completion, delegationId } = pipeline();
    expect(completion.ingestCompletion(receipt(delegationId, 'failed'))).toBe('advanced');
    expect(messages.getById('m1')?.state).toBe('failed');
  });

  it('rejects a forged/unverifiable receipt', () => {
    const { completion, delegationId } = pipeline({ verify: () => false });
    expect(completion.ingestCompletion(receipt(delegationId))).toBe('rejected');
  });

  it('rejects a mismatched delegation id', () => {
    const { completion } = pipeline();
    expect(completion.ingestCompletion(receipt('del-wrong'))).toBe('rejected');
  });

  it('a receipt arriving before dispatch stays verified_pending; recovery advances it once', () => {
    // build a pipeline stuck at `sending` (not yet dispatched)
    const { messages, receipts, dispatch } = setup();
    messages.create(makeMsg({ state: 'risk_authorized', decision_revision: 7 }));
    const claim = dispatch.claimDispatch('m1');
    if (!claim.claimed) throw new Error('claim failed');
    const completion = new CompletionService({
      messageRepo: messages,
      receiptRepo: receipts,
      nowMsFn: () => NOW,
      verifyReceipt: () => true,
    });
    expect(completion.ingestCompletion(receipt(claim.delegation_id))).toBe('verified_pending');
    expect(messages.getById('m1')?.state).toBe('sending');
    // now the send completes; the recovery pass advances the pending receipt
    dispatch.markDispatched('m1');
    expect(completion.recoverAdvance()).toBe(1);
    expect(messages.getById('m1')?.state).toBe('completed');
    // idempotent: a second recovery advances nothing
    expect(completion.recoverAdvance()).toBe(0);
  });

  it('recovery finishes a receipt stranded verified_pending by a crash after the transition (F13)', () => {
    const { messages, receipts, dispatch } = setup();
    messages.create(makeMsg({ state: 'risk_authorized', decision_revision: 7 }));
    const claim = dispatch.claimDispatch('m1');
    if (!claim.claimed) throw new Error('claim failed');
    const completion = new CompletionService({
      messageRepo: messages,
      receiptRepo: receipts,
      nowMsFn: () => NOW,
      verifyReceipt: () => true,
    });
    expect(completion.ingestCompletion(receipt(claim.delegation_id))).toBe('verified_pending');
    dispatch.markDispatched('m1');
    // Simulate the crash: the lifecycle transition (dispatched → completed)
    // committed, but the process died BEFORE markAdvanced — the receipt is left
    // verified_pending, and the plain CAS in the recovery pass can no longer fire.
    messages.transition('m1', 'dispatched', 'completed', NOW);
    expect(receipts.getByDelegationId(claim.delegation_id)?.receipt_state).toBe('verified_pending');
    // Recovery must idempotently FINISH the stranded receipt, not leave it forever
    // occupying the bounded recovery page.
    expect(completion.recoverAdvance()).toBe(1);
    expect(receipts.getByDelegationId(claim.delegation_id)?.receipt_state).toBe('advanced');
    expect(completion.recoverAdvance()).toBe(0);
  });

  it('a late completion (message already outcome_unknown) is append-only evidence', () => {
    const { messages, receipts, dispatch } = setup();
    messages.create(makeMsg({ state: 'risk_authorized', decision_revision: 7 }));
    const claim = dispatch.claimDispatch('m1');
    if (!claim.claimed) throw new Error('claim failed');
    dispatch.markDispatched('m1');
    messages.transition('m1', 'dispatched', 'outcome_unknown', NOW); // deadline hit first
    const completion = new CompletionService({
      messageRepo: messages,
      receiptRepo: receipts,
      nowMsFn: () => NOW,
      verifyReceipt: () => true,
    });
    expect(completion.ingestCompletion(receipt(claim.delegation_id))).toBe('reconciliation_evidence');
    expect(messages.getById('m1')?.state).toBe('outcome_unknown'); // not mutated
    const ev = JSON.parse(String(messages.getById('m1')?.reconciliation_evidence)) as unknown[];
    expect(ev.length).toBe(1);
  });

  it('reconcileAtDeadline: no receipt → outcome_unknown; a verified_pending receipt advances first', () => {
    const noReceipt = pipeline();
    expect(noReceipt.completion.reconcileAtDeadline('m1')).toBe('outcome_unknown');
    expect(noReceipt.messages.getById('m1')?.state).toBe('outcome_unknown');

    // a completion that arrived before the deadline is reconciled, not lost
    const withReceipt = pipeline();
    withReceipt.receipts.upsert({
      delegation_id: withReceipt.delegationId,
      message_id: 'm1',
      run_id: 'r1',
      status: 'completed',
      result_card_ref: null,
      receipt_state: 'verified_pending',
      issued_at: NOW,
      received_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    });
    expect(withReceipt.completion.reconcileAtDeadline('m1')).toBe('advanced');
    expect(withReceipt.messages.getById('m1')?.state).toBe('completed');
  });

  it('reconcileAtDeadline: a SENDING message with a verified_pending receipt advances (VERIF #4)', () => {
    // A message claimed but whose send is unconfirmed rests at `sending`. If a
    // completion arrived before the deadline, reconcile must move sending →
    // dispatched FIRST, then CAS-advance — never mis-record it as outcome_unknown.
    const { messages, receipts, dispatch } = setup();
    messages.create(makeMsg({ state: 'risk_authorized', decision_revision: 7 }));
    const claim = dispatch.claimDispatch('m1');
    if (!claim.claimed) throw new Error('claim failed');
    expect(messages.getById('m1')?.state).toBe('sending'); // NOT markDispatched
    receipts.upsert({
      delegation_id: claim.delegation_id,
      message_id: 'm1',
      run_id: 'r1',
      status: 'completed',
      result_card_ref: null,
      receipt_state: 'verified_pending',
      issued_at: NOW,
      received_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    });
    const completion = new CompletionService({ messageRepo: messages, receiptRepo: receipts, nowMsFn: () => NOW });
    expect(completion.reconcileAtDeadline('m1')).toBe('advanced');
    expect(messages.getById('m1')?.state).toBe('completed');
  });

  it('reconcileAtDeadline: a SENDING message with NO receipt → outcome_unknown (VERIF #4)', () => {
    const { messages, dispatch, receipts } = setup();
    messages.create(makeMsg({ state: 'risk_authorized', decision_revision: 7 }));
    const claim = dispatch.claimDispatch('m1');
    if (!claim.claimed) throw new Error('claim failed');
    expect(messages.getById('m1')?.state).toBe('sending');
    const completion = new CompletionService({ messageRepo: messages, receiptRepo: receipts, nowMsFn: () => NOW });
    expect(completion.reconcileAtDeadline('m1')).toBe('outcome_unknown');
    expect(messages.getById('m1')?.state).toBe('outcome_unknown');
  });
});
