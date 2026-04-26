/**
 * AskApprovalGateway — composes AskRegistry with an external
 * approval source. Tests cover construction validation, the full
 * approve/deny operator paths (including atomicity invariants),
 * reconcile idempotency + per-row error isolation, and listing.
 */

import {
  AskApprovalGateway,
  type ApprovalSource,
  type ApprovalSourceStatus,
  type AskApprovalEvent,
} from '../../src/ask/ask_approval_gateway';
import { AskRegistry, InMemoryAskAdapter, type AskEvent } from '../../src/ask/ask_registry';

const REQ_DID = 'did:plc:alice';

function fixedClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    nowMsFn: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/**
 * Scripted approval source — every method's behaviour is configurable
 * per id. Default is `pending` for unknown ids; tests override to
 * simulate operator decisions out-of-band.
 */
class ScriptedApprovalSource implements ApprovalSource {
  private statuses = new Map<string, ApprovalSourceStatus>();
  private approveErrors = new Map<string, Error>();
  private denyErrors = new Map<string, Error>();
  public readonly approveCalls: string[] = [];
  public readonly denyCalls: string[] = [];

  setStatus(id: string, status: ApprovalSourceStatus): this {
    this.statuses.set(id, status);
    return this;
  }
  setApproveError(id: string, err: Error): this {
    this.approveErrors.set(id, err);
    return this;
  }
  setDenyError(id: string, err: Error): this {
    this.denyErrors.set(id, err);
    return this;
  }

  getStatus(id: string): ApprovalSourceStatus {
    return this.statuses.get(id) ?? 'unknown';
  }

  approve(id: string): void {
    this.approveCalls.push(id);
    const err = this.approveErrors.get(id);
    if (err) throw err;
    this.statuses.set(id, 'approved');
  }

  deny(id: string): void {
    this.denyCalls.push(id);
    const err = this.denyErrors.get(id);
    if (err) throw err;
    this.statuses.set(id, 'denied');
  }
}

async function makeRegistry(opts?: { events?: AskEvent[]; nowMsFn?: () => number }) {
  const adapter = new InMemoryAskAdapter();
  const events = opts?.events ?? [];
  const reg = new AskRegistry({
    adapter,
    nowMsFn: opts?.nowMsFn,
    onEvent: (e) => events.push(e),
  });
  return reg;
}

async function enqueueAndPend(reg: AskRegistry, id: string, approvalId: string): Promise<void> {
  await reg.enqueue({ id, question: `q-${id}`, requesterDid: REQ_DID });
  await reg.markPendingApproval(id, approvalId);
}

describe('AskApprovalGateway construction', () => {
  it('throws when askRegistry missing', () => {
    expect(
      () =>
        new AskApprovalGateway({
          // @ts-expect-error testing runtime guard
          askRegistry: undefined,
          approvalSource: new ScriptedApprovalSource(),
        }),
    ).toThrow(/askRegistry is required/);
  });

  it('throws when approvalSource missing', async () => {
    const reg = await makeRegistry();
    expect(
      () =>
        new AskApprovalGateway({
          askRegistry: reg,
          // @ts-expect-error testing runtime guard
          approvalSource: undefined,
        }),
    ).toThrow(/approvalSource is required/);
  });
});

describe('AskApprovalGateway.approve', () => {
  it('drives source + transitions ask to in_flight on success', async () => {
    const reg = await makeRegistry();
    const source = new ScriptedApprovalSource().setStatus('appr-1', 'pending');
    const events: AskApprovalEvent[] = [];
    const gw = new AskApprovalGateway({
      askRegistry: reg,
      approvalSource: source,
      onEvent: (e) => events.push(e),
    });

    await enqueueAndPend(reg, 'ask-1', 'appr-1');

    const outcome = await gw.approve('appr-1');
    expect(outcome).toEqual({ ok: true, askId: 'ask-1', approvalId: 'appr-1' });
    expect(source.approveCalls).toEqual(['appr-1']);

    const ask = await reg.get('ask-1');
    expect(ask?.status).toBe('in_flight');
    expect(ask?.approvalId).toBeUndefined();

    expect(events).toEqual([{ kind: 'approved', askId: 'ask-1', approvalId: 'appr-1' }]);
  });

  it('rejects empty approvalId with unknown_approval', async () => {
    const reg = await makeRegistry();
    const gw = new AskApprovalGateway({
      askRegistry: reg,
      approvalSource: new ScriptedApprovalSource(),
    });
    const out = await gw.approve('');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.failure.reason).toBe('unknown_approval');
      expect(out.failure.detail).toBe('empty approvalId');
    }
  });

  it('returns unknown_approval for an id not tied to any pending_approval ask', async () => {
    const reg = await makeRegistry();
    const gw = new AskApprovalGateway({
      askRegistry: reg,
      approvalSource: new ScriptedApprovalSource(),
    });
    const out = await gw.approve('ghost');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.reason).toBe('unknown_approval');
  });

  it('registry rejection after source success returns ask_state_invalid + leaves source approved', async () => {
    const reg = await makeRegistry();
    const source = new ScriptedApprovalSource().setStatus('appr-1', 'pending');
    const gw = new AskApprovalGateway({ askRegistry: reg, approvalSource: source });

    await enqueueAndPend(reg, 'ask-1', 'appr-1');
    jest.spyOn(reg, 'resumeAfterApproval').mockRejectedValue(new Error('forced'));

    const out = await gw.approve('appr-1');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.failure.reason).toBe('ask_state_invalid');
      expect(out.failure.detail).toMatch(/forced/);
    }
    // Source IS now approved (we drove it first); reconcile would converge later.
    expect(source.getStatus('appr-1')).toBe('approved');
  });

  it('atomicity: source rejection leaves the ask in pending_approval', async () => {
    const reg = await makeRegistry();
    const source = new ScriptedApprovalSource()
      .setStatus('appr-1', 'pending')
      .setApproveError('appr-1', new Error('upstream already terminal'));
    const gw = new AskApprovalGateway({ askRegistry: reg, approvalSource: source });

    await enqueueAndPend(reg, 'ask-1', 'appr-1');

    const out = await gw.approve('appr-1');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.failure.reason).toBe('source_rejected');
      expect(out.failure.detail).toMatch(/upstream already terminal/);
    }

    const ask = await reg.get('ask-1');
    expect(ask?.status).toBe('pending_approval');
    expect(ask?.approvalId).toBe('appr-1');
  });
});

describe('AskApprovalGateway.deny', () => {
  it('drives source + fails ask with structured error JSON', async () => {
    const reg = await makeRegistry();
    const source = new ScriptedApprovalSource().setStatus('appr-1', 'pending');
    const events: AskApprovalEvent[] = [];
    const gw = new AskApprovalGateway({
      askRegistry: reg,
      approvalSource: source,
      onEvent: (e) => events.push(e),
    });

    await enqueueAndPend(reg, 'ask-1', 'appr-1');

    const out = await gw.deny('appr-1', 'sensitive content');
    expect(out).toEqual({ ok: true, askId: 'ask-1', approvalId: 'appr-1' });
    expect(source.denyCalls).toEqual(['appr-1']);

    const ask = await reg.get('ask-1');
    expect(ask?.status).toBe('failed');
    expect(JSON.parse(ask!.errorJson!)).toEqual({
      reason: 'denied',
      detail: 'sensitive content',
    });
    expect(events).toEqual([
      { kind: 'denied', askId: 'ask-1', approvalId: 'appr-1', reason: 'sensitive content' },
    ]);
  });

  it('uses default reason when caller omits one', async () => {
    const reg = await makeRegistry();
    const source = new ScriptedApprovalSource().setStatus('appr-1', 'pending');
    const gw = new AskApprovalGateway({ askRegistry: reg, approvalSource: source });

    await enqueueAndPend(reg, 'ask-1', 'appr-1');
    await gw.deny('appr-1');

    const ask = await reg.get('ask-1');
    expect(JSON.parse(ask!.errorJson!).detail).toBe('Operator denied approval');
  });

  it('source rejection leaves the ask in pending_approval', async () => {
    const reg = await makeRegistry();
    const source = new ScriptedApprovalSource()
      .setStatus('appr-1', 'pending')
      .setDenyError('appr-1', new Error('source out of sync'));
    const gw = new AskApprovalGateway({ askRegistry: reg, approvalSource: source });

    await enqueueAndPend(reg, 'ask-1', 'appr-1');

    const out = await gw.deny('appr-1');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.reason).toBe('source_rejected');

    const ask = await reg.get('ask-1');
    expect(ask?.status).toBe('pending_approval');
  });

  it('registry rejection after source success returns ask_state_invalid', async () => {
    const reg = await makeRegistry();
    const source = new ScriptedApprovalSource().setStatus('appr-1', 'pending');
    const gw = new AskApprovalGateway({ askRegistry: reg, approvalSource: source });

    await enqueueAndPend(reg, 'ask-1', 'appr-1');
    jest.spyOn(reg, 'markFailed').mockRejectedValue(new Error('state error'));

    const out = await gw.deny('appr-1', 'reason');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.reason).toBe('ask_state_invalid');
    // Source IS now denied.
    expect(source.getStatus('appr-1')).toBe('denied');
  });

  it('rejects empty approvalId', async () => {
    const reg = await makeRegistry();
    const gw = new AskApprovalGateway({
      askRegistry: reg,
      approvalSource: new ScriptedApprovalSource(),
    });
    const out = await gw.deny('');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.detail).toBe('empty approvalId');
  });
});

describe('AskApprovalGateway.reconcile', () => {
  it('drives resumeAfterApproval when source shows approved', async () => {
    const reg = await makeRegistry();
    const source = new ScriptedApprovalSource().setStatus('appr-1', 'approved');
    const events: AskApprovalEvent[] = [];
    const gw = new AskApprovalGateway({
      askRegistry: reg,
      approvalSource: source,
      onEvent: (e) => events.push(e),
    });

    await enqueueAndPend(reg, 'ask-1', 'appr-1');

    const summary = await gw.reconcile();
    expect(summary).toEqual({
      examined: 1,
      resumed: 1,
      denied: 0,
      expired: 0,
      unchanged: 0,
      errors: 0,
    });
    expect((await reg.get('ask-1'))?.status).toBe('in_flight');
    expect(events).toContainEqual({
      kind: 'reconciled_terminal',
      askId: 'ask-1',
      approvalId: 'appr-1',
      sourceStatus: 'approved',
    });
  });

  it('drives markFailed when source shows denied', async () => {
    const reg = await makeRegistry();
    const source = new ScriptedApprovalSource().setStatus('appr-1', 'denied');
    const gw = new AskApprovalGateway({ askRegistry: reg, approvalSource: source });

    await enqueueAndPend(reg, 'ask-1', 'appr-1');
    const summary = await gw.reconcile();
    expect(summary.denied).toBe(1);

    const ask = await reg.get('ask-1');
    expect(ask?.status).toBe('failed');
    expect(JSON.parse(ask!.errorJson!).reason).toBe('denied');
  });

  it('drives markFailed with approval_expired reason when source shows expired', async () => {
    const reg = await makeRegistry();
    const source = new ScriptedApprovalSource().setStatus('appr-1', 'expired');
    const gw = new AskApprovalGateway({ askRegistry: reg, approvalSource: source });

    await enqueueAndPend(reg, 'ask-1', 'appr-1');
    const summary = await gw.reconcile();
    expect(summary.expired).toBe(1);

    const ask = await reg.get('ask-1');
    expect(JSON.parse(ask!.errorJson!).reason).toBe('approval_expired');
  });

  it('leaves ask alone when source still pending', async () => {
    const reg = await makeRegistry();
    const source = new ScriptedApprovalSource().setStatus('appr-1', 'pending');
    const events: AskApprovalEvent[] = [];
    const gw = new AskApprovalGateway({
      askRegistry: reg,
      approvalSource: source,
      onEvent: (e) => events.push(e),
    });

    await enqueueAndPend(reg, 'ask-1', 'appr-1');
    const summary = await gw.reconcile();
    expect(summary.unchanged).toBe(1);
    expect((await reg.get('ask-1'))?.status).toBe('pending_approval');
    expect(events).toContainEqual({
      kind: 'reconcile_skipped',
      askId: 'ask-1',
      approvalId: 'appr-1',
      sourceStatus: 'pending',
    });
  });

  it('treats unknown source status as unchanged (no transition)', async () => {
    const reg = await makeRegistry();
    const source = new ScriptedApprovalSource(); // no status set → unknown
    const gw = new AskApprovalGateway({ askRegistry: reg, approvalSource: source });

    await enqueueAndPend(reg, 'ask-1', 'appr-1');
    const summary = await gw.reconcile();
    expect(summary.unchanged).toBe(1);
    expect((await reg.get('ask-1'))?.status).toBe('pending_approval');
  });

  it('isolates per-row source.getStatus errors as unchanged + emits diagnostic event', async () => {
    const reg = await makeRegistry();
    const source: ApprovalSource = {
      getStatus(id: string) {
        if (id === 'appr-1') throw new Error('transient');
        return 'approved';
      },
      approve() {},
      deny() {},
    };
    const events: AskApprovalEvent[] = [];
    const gw = new AskApprovalGateway({
      askRegistry: reg,
      approvalSource: source,
      onEvent: (e) => events.push(e),
    });

    await enqueueAndPend(reg, 'ask-1', 'appr-1');
    await enqueueAndPend(reg, 'ask-2', 'appr-2');

    const summary = await gw.reconcile();
    expect(summary.examined).toBe(2);
    expect(summary.resumed).toBe(1);
    expect(summary.unchanged).toBe(1);
    expect((await reg.get('ask-1'))?.status).toBe('pending_approval');
    expect((await reg.get('ask-2'))?.status).toBe('in_flight');

    // Source-error event surfaces the bad row to admin UI.
    expect(events).toContainEqual({
      kind: 'reconcile_source_error',
      askId: 'ask-1',
      approvalId: 'appr-1',
      detail: 'transient',
    });
  });

  it('idempotent — second reconcile when nothing changed reports zero active counts', async () => {
    const reg = await makeRegistry();
    const source = new ScriptedApprovalSource().setStatus('appr-1', 'pending');
    const gw = new AskApprovalGateway({ askRegistry: reg, approvalSource: source });

    await enqueueAndPend(reg, 'ask-1', 'appr-1');
    const first = await gw.reconcile();
    const second = await gw.reconcile();

    expect(first).toEqual(second);
    expect(first.unchanged).toBe(1);
  });

  it('skips asks not in pending_approval (in_flight, complete, failed)', async () => {
    const reg = await makeRegistry();
    const source = new ScriptedApprovalSource().setStatus('appr-1', 'approved');
    const gw = new AskApprovalGateway({ askRegistry: reg, approvalSource: source });

    // 4 asks: only one in pending_approval
    await reg.enqueue({ id: 'in-flight', question: 'q', requesterDid: REQ_DID });
    await reg.enqueue({ id: 'complete', question: 'q', requesterDid: REQ_DID });
    await reg.markComplete('complete', '"answer"');
    await reg.enqueue({ id: 'failed', question: 'q', requesterDid: REQ_DID });
    await reg.markFailed('failed', '"e"');
    await enqueueAndPend(reg, 'pending', 'appr-1');

    const summary = await gw.reconcile();
    expect(summary.examined).toBe(1);
    expect(summary.resumed).toBe(1);
  });

  it('counts errors + emits diagnostic event when AskRegistry transition rejects', async () => {
    // Force an inconsistent state: source says approved but the
    // registry rejects the resume.
    const reg = await makeRegistry();
    const source = new ScriptedApprovalSource().setStatus('appr-1', 'approved');
    const events: AskApprovalEvent[] = [];
    const gw = new AskApprovalGateway({
      askRegistry: reg,
      approvalSource: source,
      onEvent: (e) => events.push(e),
    });

    await enqueueAndPend(reg, 'ask-1', 'appr-1');
    const orig = reg.resumeAfterApproval.bind(reg);
    jest.spyOn(reg, 'resumeAfterApproval').mockImplementation(async (id) => {
      if (id === 'ask-1') throw new Error('forced state error');
      return orig(id);
    });

    const summary = await gw.reconcile();
    expect(summary.errors).toBe(1);
    expect(summary.resumed).toBe(0);

    expect(events).toContainEqual({
      kind: 'reconcile_transition_error',
      askId: 'ask-1',
      approvalId: 'appr-1',
      sourceStatus: 'approved',
      detail: 'forced state error',
    });
  });
});

describe('AskApprovalGateway.listOpenApprovals', () => {
  it('returns each pending_approval ask paired with its source status', async () => {
    const reg = await makeRegistry();
    const source = new ScriptedApprovalSource()
      .setStatus('appr-1', 'pending')
      .setStatus('appr-2', 'approved');
    const gw = new AskApprovalGateway({ askRegistry: reg, approvalSource: source });

    await enqueueAndPend(reg, 'ask-1', 'appr-1');
    await enqueueAndPend(reg, 'ask-2', 'appr-2');
    await reg.enqueue({ id: 'in-flight', question: 'q', requesterDid: REQ_DID });

    const list = await gw.listOpenApprovals();
    expect(list.map((e) => e.ask.id).sort()).toEqual(['ask-1', 'ask-2']);
    const a1 = list.find((e) => e.ask.id === 'ask-1');
    expect(a1?.sourceStatus).toBe('pending');
    const a2 = list.find((e) => e.ask.id === 'ask-2');
    expect(a2?.sourceStatus).toBe('approved');
  });

  it('per-row status fetch failure degrades to unknown', async () => {
    const reg = await makeRegistry();
    const source: ApprovalSource = {
      getStatus(id: string) {
        if (id === 'appr-1') throw new Error('boom');
        return 'pending';
      },
      approve() {},
      deny() {},
    };
    const gw = new AskApprovalGateway({ askRegistry: reg, approvalSource: source });

    await enqueueAndPend(reg, 'ask-1', 'appr-1');
    const list = await gw.listOpenApprovals();
    expect(list).toHaveLength(1);
    expect(list[0]!.sourceStatus).toBe('unknown');
  });

  it('returns empty when no asks in pending_approval', async () => {
    const reg = await makeRegistry();
    const gw = new AskApprovalGateway({
      askRegistry: reg,
      approvalSource: new ScriptedApprovalSource(),
    });
    await reg.enqueue({ id: 'a', question: 'q', requesterDid: REQ_DID });
    expect(await gw.listOpenApprovals()).toEqual([]);
  });
});

describe('AskApprovalGateway end-to-end', () => {
  it('full operator flow: enqueue → pending → operator approves → ask in_flight', async () => {
    const reg = await makeRegistry();
    const source = new ScriptedApprovalSource().setStatus('appr-1', 'pending');
    const events: AskApprovalEvent[] = [];
    const gw = new AskApprovalGateway({
      askRegistry: reg,
      approvalSource: source,
      onEvent: (e) => events.push(e),
    });

    // Brain enqueues an ask + flips it to pending_approval
    await reg.enqueue({ id: 'ask-1', question: 'q', requesterDid: REQ_DID });
    await reg.markPendingApproval('ask-1', 'appr-1');

    // Admin queue surfaces it
    expect((await gw.listOpenApprovals())[0]!.ask.id).toBe('ask-1');

    // Operator approves
    const out = await gw.approve('appr-1');
    expect(out.ok).toBe(true);

    // Source now reflects approved + ask is in_flight
    expect(source.getStatus('appr-1')).toBe('approved');
    expect((await reg.get('ask-1'))?.status).toBe('in_flight');

    // Queue is empty
    expect(await gw.listOpenApprovals()).toEqual([]);
  });

  it('full operator flow: enqueue → pending → operator denies → ask failed with reason', async () => {
    const reg = await makeRegistry();
    const source = new ScriptedApprovalSource().setStatus('appr-1', 'pending');
    const gw = new AskApprovalGateway({ askRegistry: reg, approvalSource: source });

    await reg.enqueue({ id: 'ask-1', question: 'q', requesterDid: REQ_DID });
    await reg.markPendingApproval('ask-1', 'appr-1');

    const out = await gw.deny('appr-1', 'leaks customer data');
    expect(out.ok).toBe(true);

    const ask = await reg.get('ask-1');
    expect(ask?.status).toBe('failed');
    expect(JSON.parse(ask!.errorJson!).detail).toBe('leaks customer data');
  });

  it('out-of-band approval (operator approves via Telegram) → reconcile picks it up', async () => {
    const reg = await makeRegistry();
    const source = new ScriptedApprovalSource().setStatus('appr-1', 'pending');
    const gw = new AskApprovalGateway({ askRegistry: reg, approvalSource: source });

    await enqueueAndPend(reg, 'ask-1', 'appr-1');

    // Operator approves out-of-band — directly on the source, not through the gateway
    source.setStatus('appr-1', 'approved');

    // Brain's periodic reconcile picks it up
    const summary = await gw.reconcile();
    expect(summary.resumed).toBe(1);
    expect((await reg.get('ask-1'))?.status).toBe('in_flight');
  });
});
