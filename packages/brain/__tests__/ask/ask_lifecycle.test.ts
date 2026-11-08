/**
 * REQ-03, REQ-05, REQ-16, REQ-17, REQ-19: the ask machine's edges, and the two
 * hosts' timers that drive them.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { AskApprovalGateway } from '../../src/ask/ask_approval_gateway';
import { AskApprovalResumer } from '../../src/ask/ask_approval_resumer';
import { createAskHandler } from '../../src/ask/ask_handler';
import { AskRegistry, InMemoryAskAdapter, type AskEvent } from '../../src/ask/ask_registry';
import { workflowTaskAsSource } from '../../src/composition/ask_coordinator';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r));
};

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return { now: () => at, advance: (ms) => (at += ms) };
}

const REQUESTER = 'did:plc:requester';

describe('REQ-05: asks end', () => {
  it('restart inside the TTL: an in_flight ask expires, its executor is gone', async () => {
    const adapter = new InMemoryAskAdapter();
    const c = clock();
    const before = new AskRegistry({ adapter, nowMsFn: c.now });
    await before.enqueue({ id: 'dead-exec', question: 'q', requesterDid: REQUESTER });
    await before.enqueue({ id: 'waiting', question: 'q', requesterDid: REQUESTER });
    await before.markPendingApproval('waiting', 'appr-1');
    c.advance(5_000);

    const after = new AskRegistry({ adapter, nowMsFn: c.now });
    const summary = await after.restoreOnStartup();

    expect(summary).toMatchObject({ expiredOnRestore: 1, stillInFlight: 0, stillPendingApproval: 1 });
    expect((await after.get('dead-exec'))?.status).toBe('expired');
    expect((await after.get('waiting'))?.status).toBe('pending_approval');
  });

  it('a sweep never overwrites a fresh answer with its stale snapshot', async () => {
    const adapter = new InMemoryAskAdapter();
    const c = clock();
    const registry = new AskRegistry({ adapter, nowMsFn: c.now, defaultTtlMs: 1_000 });
    await registry.enqueue({ id: 'a', question: 'q', requesterDid: REQUESTER });
    c.advance(2_000);

    // The answer lands while the sweep holds its snapshot of the row.
    const loadAll = adapter.loadAll.bind(adapter);
    adapter.loadAll = async () => {
      const rows = await loadAll();
      await registry.markComplete('a', '{"text":"answer"}');
      return rows;
    };

    expect(await registry.sweepExpired()).toBe(0);
    const row = await registry.get('a');
    expect(row?.status).toBe('complete');
    expect(row?.answerJson).toBe('{"text":"answer"}');
  });

  it('a card outlives the 60 s ask deadline: pending_approval waits for it', async () => {
    const c = clock();
    const registry = new AskRegistry({ adapter: new InMemoryAskAdapter(), nowMsFn: c.now, defaultTtlMs: 60_000 });
    await registry.enqueue({ id: 'a', question: 'q', requesterDid: REQUESTER });
    await registry.markPendingApproval('a', 'appr', '{"paused":1}');
    c.advance(14 * 60_000);

    expect(await registry.sweepExpired()).toBe(0);
    expect((await registry.get('a'))?.status).toBe('pending_approval');
    expect((await registry.get('a'))?.pausedStateJson).toBe('{"paused":1}');
  });

  it('a pending ask whose card can no longer be read still ends, after a day', async () => {
    const c = clock();
    const registry = new AskRegistry({ adapter: new InMemoryAskAdapter(), nowMsFn: c.now });
    await registry.enqueue({ id: 'a', question: 'q', requesterDid: REQUESTER });
    await registry.markPendingApproval('a', 'appr');
    c.advance(24 * 3_600_000 + 1);
    expect(await registry.sweepExpired()).toBe(1);
    expect((await registry.get('a'))?.status).toBe('expired');
  });

  it('a resume gets a new deadline, so the sweep does not kill it at once', async () => {
    const c = clock();
    const registry = new AskRegistry({ adapter: new InMemoryAskAdapter(), nowMsFn: c.now, defaultTtlMs: 60_000 });
    await registry.enqueue({ id: 'a', question: 'q', requesterDid: REQUESTER });
    await registry.markPendingApproval('a', 'appr');
    c.advance(14 * 60_000);
    await registry.resumeAfterApproval('a');

    expect(await registry.sweepExpired()).toBe(0);
    expect((await registry.get('a'))?.status).toBe('in_flight');

    c.advance(60_001);
    expect(await registry.sweepExpired()).toBe(1);
  });

  it('the grace gives a slow live run time before the sweep ends it', async () => {
    const c = clock();
    const registry = new AskRegistry({
      adapter: new InMemoryAskAdapter(),
      nowMsFn: c.now,
      defaultTtlMs: 1_000,
      inFlightGraceMs: 5_000,
    });
    await registry.enqueue({ id: 'a', question: 'q', requesterDid: REQUESTER });
    c.advance(4_000);
    expect(await registry.sweepExpired()).toBe(0);
    c.advance(2_001);
    expect(await registry.sweepExpired()).toBe(1);
  });

  it.each([
    ['server', ['apps', 'home-node-lite', 'brain-server', 'src', 'boot.ts']],
    ['phone', ['apps', 'mobile', 'src', 'services', 'bootstrap.ts']],
  ])('the %s boot schedules the ask sweep', (_host, parts) => {
    const source = readFileSync(path.join(__dirname, '..', '..', '..', '..', ...parts), 'utf8');
    expect(source.replace(/^\s*\/\/.*$/gm, '')).toMatch(/registry\.sweepExpired\(\)/);
  });
});

describe('REQ-16: a repeated request id', () => {
  const id = 'retry-id-0000000000000001';

  it('from the same requester returns the first ask and runs nothing new', async () => {
    const registry = new AskRegistry({ adapter: new InMemoryAskAdapter() });
    let calls = 0;
    const handle = createAskHandler({
      registry,
      executeFn: async () => {
        calls += 1;
        return { kind: 'answer', answer: { text: 'hi' } };
      },
    });
    const first = await handle({ question: 'q', requesterDid: REQUESTER, requestIdHeader: id });
    const again = await handle({ question: 'q', requesterDid: REQUESTER, requestIdHeader: id });
    expect(first.status).toBe(200);
    expect(again).toMatchObject({ status: 200, body: { request_id: id, status: 'complete', content: 'hi' } });
    expect(calls).toBe(1);
  });

  it('while the first runs, answers 202 with the same id', async () => {
    const registry = new AskRegistry({ adapter: new InMemoryAskAdapter() });
    let release: () => void = () => undefined;
    const handle = createAskHandler({
      registry,
      fastPathMs: 1,
      executeFn: () =>
        new Promise((r) => {
          release = () => r({ kind: 'answer', answer: { text: 'hi' } });
        }),
    });
    await handle({ question: 'q', requesterDid: REQUESTER, requestIdHeader: id });
    const again = await handle({ question: 'q', requesterDid: REQUESTER, requestIdHeader: id });
    expect(again).toMatchObject({ status: 202, body: { request_id: id, status: 'in_flight' } });
    release();
    await flush();
  });

  it('from someone else runs as a new ask and gives nothing away', async () => {
    const registry = new AskRegistry({ adapter: new InMemoryAskAdapter() });
    const handle = createAskHandler({
      registry,
      executeFn: async (input) => ({ kind: 'answer', answer: { text: input.requesterDid } }),
    });
    await handle({ question: 'q', requesterDid: REQUESTER, requestIdHeader: id });
    const other = await handle({ question: 'q', requesterDid: 'did:plc:other', requestIdHeader: id });
    expect(other.status).toBe(200);
    if (other.kind !== 'fast_path') throw new Error(other.kind);
    expect(other.body.request_id).not.toBe(id);
    expect(other.body.content).toBe('did:plc:other');
  });
});

describe('REQ-17: a second approval on the re-run path', () => {
  it('keeps the paused state it was given', async () => {
    let resumer: AskApprovalResumer | null = null;
    const registry = new AskRegistry({
      adapter: new InMemoryAskAdapter(),
      onEvent: (e: AskEvent) => void resumer?.handle(e),
    });
    resumer = new AskApprovalResumer({
      registry,
      executeFn: async () => ({ kind: 'approval', approvalId: 'appr-2', pausedStateJson: '{"at":"second"}' }),
    });
    await registry.enqueue({ id: 'a', question: 'q', requesterDid: REQUESTER });
    await registry.markPendingApproval('a', 'appr-1');
    await registry.resumeAfterApproval('a');
    await flush();
    const row = await registry.get('a');
    expect(row).toMatchObject({ status: 'pending_approval', approvalId: 'appr-2', pausedStateJson: '{"at":"second"}' });
  });
});

describe('REQ-19 + REQ-03: what a card means to the ask waiting on it', () => {
  const sourceFor = (task: Record<string, unknown> | null) =>
    workflowTaskAsSource({ getWorkflowTask: async () => task } as never);

  it('a lapsed card reads expired, not denied', async () => {
    expect(await sourceFor({ status: 'failed', error: 'expired' }).getStatus('x')).toBe('expired');
  });

  it('a card that failed for another reason, or was cancelled, reads denied', async () => {
    expect(await sourceFor({ status: 'failed', error: 'boom' }).getStatus('x')).toBe('denied');
    expect(await sourceFor({ status: 'cancelled' }).getStatus('x')).toBe('denied');
  });

  it('a settled card reads approved, so the ask it was raised for resumes', async () => {
    expect(await sourceFor({ status: 'completed' }).getStatus('x')).toBe('approved');
  });

  it('a lapsed card fails the ask with approval_expired', async () => {
    const registry = new AskRegistry({ adapter: new InMemoryAskAdapter() });
    await registry.enqueue({ id: 'a', question: 'q', requesterDid: REQUESTER });
    await registry.markPendingApproval('a', 'card');
    const gateway = new AskApprovalGateway({
      askRegistry: registry,
      approvalSource: sourceFor({ status: 'failed', error: 'expired' }),
    });
    await gateway.reconcile();
    expect(JSON.parse((await registry.get('a'))?.errorJson ?? '{}').reason).toBe('approval_expired');
  });

  it('an ask never resumes twice on one approval with no owner action between', async () => {
    let runs = 0;
    let resumer: AskApprovalResumer | null = null;
    const registry = new AskRegistry({
      adapter: new InMemoryAskAdapter(),
      onEvent: (e: AskEvent) => void resumer?.handle(e),
    });
    resumer = new AskApprovalResumer({
      registry,
      executeFn: async () => {
        runs += 1;
        return { kind: 'approval', approvalId: 'card' }; // the gate hands back the same card
      },
    });
    const gateway = new AskApprovalGateway({
      askRegistry: registry,
      approvalSource: sourceFor({ status: 'queued' }),
    });
    await registry.enqueue({ id: 'a', question: 'q', requesterDid: REQUESTER });
    await registry.markPendingApproval('a', 'card');

    for (let i = 0; i < 5; i += 1) {
      await gateway.reconcile();
      await flush();
    }

    expect(runs).toBe(1);
    const row = await registry.get('a');
    expect(row?.status).toBe('failed');
    expect(JSON.parse(row?.errorJson ?? '{}').reason).toBe('approval_not_effective');
  });

  it('a new approval id after a resume is an ordinary wait', async () => {
    const registry = new AskRegistry({ adapter: new InMemoryAskAdapter() });
    await registry.enqueue({ id: 'a', question: 'q', requesterDid: REQUESTER });
    await registry.markPendingApproval('a', 'one');
    await registry.resumeAfterApproval('a');
    await registry.markPendingApproval('a', 'two');
    const gateway = new AskApprovalGateway({
      askRegistry: registry,
      approvalSource: sourceFor({ status: 'queued' }),
    });
    await gateway.reconcile();
    expect((await registry.get('a'))?.status).toBe('in_flight');
  });
});
