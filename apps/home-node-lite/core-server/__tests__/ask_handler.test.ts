/**
 * Tasks 5.17 + 5.18 — ask handler + status handler tests.
 */

import {
  ASK_FAST_PATH_TIMEOUT_MS,
  createAskHandler,
  createAskStatusHandler,
  type AskExecuteFn,
  type AskHandlerEvent,
  type AskStatusHandlerEvent,
  type AskSubmitResult,
  type ExecuteOutcome,
} from '../src/brain/ask_handler';
import {
  AskRegistry,
  InMemoryAskAdapter,
} from '../src/brain/ask_registry';

function mockScheduler() {
  const queue: Array<{ fn: () => void; fireAt: number; handle: number }> = [];
  let nextHandle = 1;
  let now = 0;
  return {
    setTimerFn: (fn: () => void, ms: number): unknown => {
      const handle = nextHandle++;
      queue.push({ fn, fireAt: now + ms, handle });
      return handle;
    },
    clearTimerFn: (h: unknown): void => {
      const idx = queue.findIndex((e) => e.handle === h);
      if (idx !== -1) queue.splice(idx, 1);
    },
    advance: (ms: number): void => {
      now += ms;
      queue.sort((a, b) => a.fireAt - b.fireAt);
      while (queue.length && queue[0]!.fireAt <= now) {
        const entry = queue.shift()!;
        entry.fn();
      }
    },
    nowMsFn: () => now,
    pending: () => queue.length,
  };
}

function buildRegistry(): AskRegistry {
  return new AskRegistry({
    adapter: new InMemoryAskAdapter(),
    nowMsFn: () => Date.now(),
  });
}

describe('createAskHandler (task 5.17)', () => {
  describe('construction', () => {
    it('throws without registry', () => {
      expect(() =>
        createAskHandler({
          registry: undefined as unknown as AskRegistry,
          executeFn: async () => ({ kind: 'answer', answer: {} }),
        }),
      ).toThrow(/registry/);
    });

    it('throws without executeFn', () => {
      expect(() =>
        createAskHandler({
          registry: buildRegistry(),
          executeFn: undefined as unknown as AskExecuteFn,
        }),
      ).toThrow(/executeFn/);
    });

    it('ASK_FAST_PATH_TIMEOUT_MS is 3 000', () => {
      expect(ASK_FAST_PATH_TIMEOUT_MS).toBe(3_000);
    });
  });

  describe('fast path (execution wins the race)', () => {
    it('execution resolves with answer → 200 + complete status', async () => {
      const registry = buildRegistry();
      const handler = createAskHandler({
        registry,
        executeFn: async () => ({ kind: 'answer', answer: { text: 'hello' } }),
      });
      const res = await handler({
        question: 'what time is it?',
        requesterDid: 'did:plc:user',
      });
      expect(res.status).toBe(200);
      expect(res.kind).toBe('fast_path');
      if (res.kind === 'fast_path') {
        expect(res.body.status).toBe('complete');
        expect(res.body.answer).toEqual({ text: 'hello' });
      }
    });

    it('registry state is `complete` after fast-path answer', async () => {
      const registry = buildRegistry();
      const handler = createAskHandler({
        registry,
        executeFn: async () => ({ kind: 'answer', answer: { x: 1 } }),
      });
      const res = await handler({ question: 'q', requesterDid: 'did:plc:u' });
      const rec = await registry.get(res.body.request_id);
      expect(rec?.status).toBe('complete');
      expect(JSON.parse(rec!.answerJson!)).toEqual({ x: 1 });
    });

    it('failure outcome → 200 + failed status + error in body', async () => {
      const registry = buildRegistry();
      const handler = createAskHandler({
        registry,
        executeFn: async () => ({
          kind: 'failure',
          failure: { kind: 'provider_error', message: '503 upstream' },
        }),
      });
      const res = await handler({ question: 'q', requesterDid: 'did:plc:u' });
      if (res.kind === 'fast_path') {
        expect(res.body.status).toBe('failed');
        expect(res.body.error).toEqual({
          kind: 'provider_error',
          message: '503 upstream',
        });
      }
    });

    it('approval outcome → 200 + pending_approval + approval_id', async () => {
      const registry = buildRegistry();
      const handler = createAskHandler({
        registry,
        executeFn: async () => ({ kind: 'approval', approvalId: 'appr-1' }),
      });
      const res = await handler({ question: 'q', requesterDid: 'did:plc:u' });
      if (res.kind === 'fast_path') {
        expect(res.body.status).toBe('pending_approval');
        expect(res.body.approval_id).toBe('appr-1');
      }
    });

    it('executeFn throw → treated as failure with kind=execute_crashed', async () => {
      const registry = buildRegistry();
      const handler = createAskHandler({
        registry,
        executeFn: async () => {
          throw new Error('boom');
        },
      });
      const res = await handler({ question: 'q', requesterDid: 'did:plc:u' });
      if (res.kind === 'fast_path') {
        const err = res.body.error as { kind: string; message: string };
        expect(err.kind).toBe('execute_crashed');
        expect(err.message).toMatch(/boom/);
      }
    });
  });

  describe('async / 202 path (timer wins the race)', () => {
    it('slow execution → 202 + in_flight + request_id', async () => {
      const sched = mockScheduler();
      const registry = buildRegistry();
      let released!: (o: ExecuteOutcome) => void;
      const executePromise = new Promise<ExecuteOutcome>((r) => {
        released = r;
      });
      const handler = createAskHandler({
        registry,
        executeFn: () => executePromise,
        fastPathMs: 100,
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
      });
      const resPromise = handler({
        question: 'q',
        requesterDid: 'did:plc:u',
      });
      // Let the handler enqueue + set the timer, then fire the timer.
      await new Promise((r) => setImmediate(r));
      sched.advance(200);
      const res = await resPromise;
      expect(res.status).toBe(202);
      expect(res.body.status).toBe('in_flight');
      expect(typeof res.body.request_id).toBe('string');
      // Complete the background execution to avoid unhandled-promise warnings.
      released({ kind: 'answer', answer: { text: 'late' } });
      await new Promise((r) => setImmediate(r));
    });

    it('background execution eventually lands in registry', async () => {
      const sched = mockScheduler();
      const registry = buildRegistry();
      let released!: (o: ExecuteOutcome) => void;
      const handler = createAskHandler({
        registry,
        executeFn: () =>
          new Promise<ExecuteOutcome>((r) => {
            released = r;
          }),
        fastPathMs: 50,
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
      });
      const resPromise = handler({
        question: 'q',
        requesterDid: 'did:plc:u',
      });
      await new Promise((r) => setImmediate(r));
      sched.advance(100);
      const res = await resPromise;
      // Still in_flight initially.
      const early = await registry.get(res.body.request_id);
      expect(early?.status).toBe('in_flight');
      // Resolve the background — status flips to complete.
      released({ kind: 'answer', answer: { ok: true } });
      await new Promise((r) => setImmediate(r));
      const final = await registry.get(res.body.request_id);
      expect(final?.status).toBe('complete');
    });

    it('background execution crash → registry marked failed', async () => {
      const sched = mockScheduler();
      const registry = buildRegistry();
      let reject!: (err: Error) => void;
      const handler = createAskHandler({
        registry,
        executeFn: () =>
          new Promise<ExecuteOutcome>((_, rej) => {
            reject = rej;
          }),
        fastPathMs: 50,
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
      });
      const resPromise = handler({
        question: 'q',
        requesterDid: 'did:plc:u',
      });
      await new Promise((r) => setImmediate(r));
      sched.advance(100);
      const res = await resPromise;
      expect(res.status).toBe(202);
      reject(new Error('background crash'));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      const final = await registry.get(res.body.request_id);
      // executeFn throw gets caught + converted to failure outcome → registry marked failed.
      expect(final?.status).toBe('failed');
    });
  });

  describe('request id handling', () => {
    it('uses valid X-Request-Id header verbatim', async () => {
      const registry = buildRegistry();
      const handler = createAskHandler({
        registry,
        executeFn: async () => ({ kind: 'answer', answer: {} }),
      });
      const id = 'abcdef1234567890abcdef12';
      const res = await handler({
        question: 'q',
        requesterDid: 'did:plc:u',
        requestIdHeader: id,
      });
      expect(res.body.request_id).toBe(id);
    });

    it('generates a fresh id when header is invalid', async () => {
      const registry = buildRegistry();
      const handler = createAskHandler({
        registry,
        executeFn: async () => ({ kind: 'answer', answer: {} }),
      });
      const res = await handler({
        question: 'q',
        requesterDid: 'did:plc:u',
        requestIdHeader: 'x', // too short
      });
      expect(res.body.request_id).toMatch(/^[0-9a-f]{32}$/);
    });

    it('generates a fresh id when no header', async () => {
      const registry = buildRegistry();
      const handler = createAskHandler({
        registry,
        executeFn: async () => ({ kind: 'answer', answer: {} }),
      });
      const res = await handler({ question: 'q', requesterDid: 'did:plc:u' });
      expect(res.body.request_id).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('input validation', () => {
    it('empty question rejects', async () => {
      const registry = buildRegistry();
      const handler = createAskHandler({
        registry,
        executeFn: async () => ({ kind: 'answer', answer: {} }),
      });
      await expect(
        handler({ question: '', requesterDid: 'did:plc:u' }),
      ).rejects.toThrow(/question/);
    });

    it('empty requesterDid rejects', async () => {
      const registry = buildRegistry();
      const handler = createAskHandler({
        registry,
        executeFn: async () => ({ kind: 'answer', answer: {} }),
      });
      await expect(
        handler({ question: 'q', requesterDid: '' }),
      ).rejects.toThrow(/requesterDid/);
    });
  });

  describe('events', () => {
    it('fast-path emits submitted(fastPath=true) + fast_path_complete', async () => {
      const events: AskHandlerEvent[] = [];
      const handler = createAskHandler({
        registry: buildRegistry(),
        executeFn: async () => ({ kind: 'answer', answer: {} }),
        onEvent: (e) => events.push(e),
      });
      await handler({ question: 'q', requesterDid: 'did:plc:u' });
      const submitted = events.find(
        (e) => e.kind === 'submitted',
      ) as Extract<AskHandlerEvent, { kind: 'submitted' }>;
      expect(submitted.fastPath).toBe(true);
      expect(events.some((e) => e.kind === 'fast_path_complete')).toBe(true);
    });

    it('async path emits submitted(fastPath=false) + async_timeout + background_complete', async () => {
      const sched = mockScheduler();
      const events: AskHandlerEvent[] = [];
      let released!: (o: ExecuteOutcome) => void;
      const handler = createAskHandler({
        registry: buildRegistry(),
        executeFn: () =>
          new Promise<ExecuteOutcome>((r) => {
            released = r;
          }),
        fastPathMs: 50,
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
        onEvent: (e) => events.push(e),
      });
      const p = handler({ question: 'q', requesterDid: 'did:plc:u' });
      await new Promise((r) => setImmediate(r));
      sched.advance(100);
      await p;
      released({ kind: 'answer', answer: {} });
      await new Promise((r) => setImmediate(r));
      expect(events.some((e) => e.kind === 'async_timeout')).toBe(true);
      expect(events.some((e) => e.kind === 'background_complete')).toBe(true);
    });
  });
});

describe('createAskStatusHandler (task 5.18)', () => {
  it('returns 200 + full status view for known id', async () => {
    const registry = buildRegistry();
    const record = await registry.enqueue({
      id: 'abcdef1234567890abcdef12',
      question: 'q',
      requesterDid: 'did:plc:u',
    });
    await registry.markComplete(record.id, JSON.stringify({ text: 'answer' }));
    const handler = createAskStatusHandler({ registry });
    const res = await handler(record.id);
    expect(res.status).toBe(200);
    if (res.kind === 'found') {
      expect(res.body.request_id).toBe(record.id);
      expect(res.body.status).toBe('complete');
      expect(res.body.answer).toEqual({ text: 'answer' });
      expect(res.body.created_at_ms).toBe(record.createdAtMs);
    }
  });

  it('returns 404 for unknown id', async () => {
    const handler = createAskStatusHandler({ registry: buildRegistry() });
    const res = await handler('nonexistent');
    expect(res.status).toBe(404);
    if (res.kind === 'not_found') {
      expect(res.body.error).toBe('not_found');
      expect(res.body.request_id).toBe('nonexistent');
    }
  });

  it('returns 404 for empty id', async () => {
    const handler = createAskStatusHandler({ registry: buildRegistry() });
    const res = await handler('');
    expect(res.status).toBe(404);
  });

  it('renders failed status with decoded error', async () => {
    const registry = buildRegistry();
    const rec = await registry.enqueue({
      id: 'abcdef1234567890abcdef12',
      question: 'q',
      requesterDid: 'did:plc:u',
    });
    await registry.markFailed(
      rec.id,
      JSON.stringify({ kind: 'provider_error', message: '503' }),
    );
    const handler = createAskStatusHandler({ registry });
    const res = await handler(rec.id);
    if (res.kind === 'found') {
      expect(res.body.status).toBe('failed');
      expect(res.body.error).toEqual({
        kind: 'provider_error',
        message: '503',
      });
    }
  });

  it('renders pending_approval with approval_id', async () => {
    const registry = buildRegistry();
    const rec = await registry.enqueue({
      id: 'abcdef1234567890abcdef12',
      question: 'q',
      requesterDid: 'did:plc:u',
    });
    await registry.markPendingApproval(rec.id, 'appr-7');
    const handler = createAskStatusHandler({ registry });
    const res = await handler(rec.id);
    if (res.kind === 'found') {
      expect(res.body.status).toBe('pending_approval');
      expect(res.body.approval_id).toBe('appr-7');
    }
  });

  it('answerJson with malformed JSON falls back to raw string', async () => {
    const registry = buildRegistry();
    const rec = await registry.enqueue({
      id: 'abcdef1234567890abcdef12',
      question: 'q',
      requesterDid: 'did:plc:u',
    });
    // Bypass the registry's JSON-string contract to simulate corruption.
    // We do this by marking complete with invalid JSON — the registry
    // stores it verbatim; the status handler must not crash.
    await registry.markComplete(rec.id, 'not-valid-json');
    const handler = createAskStatusHandler({ registry });
    const res = await handler(rec.id);
    if (res.kind === 'found') {
      expect(res.body.answer).toBe('not-valid-json');
    }
  });

  it('events emitted for served + not_found', async () => {
    const events: AskStatusHandlerEvent[] = [];
    const registry = buildRegistry();
    const rec = await registry.enqueue({
      id: 'abcdef1234567890abcdef12',
      question: 'q',
      requesterDid: 'did:plc:u',
    });
    const handler = createAskStatusHandler({
      registry,
      onEvent: (e) => events.push(e),
    });
    await handler(rec.id);
    await handler('unknown');
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('status_served');
    expect(kinds).toContain('status_not_found');
  });

  it('construction throws without registry', () => {
    expect(() =>
      createAskStatusHandler({ registry: undefined as unknown as AskRegistry }),
    ).toThrow(/registry/);
  });
});

describe('end-to-end: fast path + status', () => {
  it('fast-path answer then GET status returns 200 with the answer', async () => {
    const registry = buildRegistry();
    const ask = createAskHandler({
      registry,
      executeFn: async () => ({ kind: 'answer', answer: { text: 'e2e' } }),
    });
    const status = createAskStatusHandler({ registry });
    const submitRes = (await ask({
      question: 'hello',
      requesterDid: 'did:plc:u',
    })) as Extract<AskSubmitResult, { kind: 'fast_path' }>;
    expect(submitRes.body.status).toBe('complete');
    const statusRes = await status(submitRes.body.request_id);
    if (statusRes.kind === 'found') {
      expect(statusRes.body.status).toBe('complete');
      expect(statusRes.body.answer).toEqual({ text: 'e2e' });
    }
  });

  it('async path → polling sees in_flight then complete', async () => {
    const sched = mockScheduler();
    const registry = buildRegistry();
    let released!: (o: ExecuteOutcome) => void;
    const ask = createAskHandler({
      registry,
      executeFn: () =>
        new Promise<ExecuteOutcome>((r) => {
          released = r;
        }),
      fastPathMs: 50,
      setTimerFn: sched.setTimerFn,
      clearTimerFn: sched.clearTimerFn,
    });
    const status = createAskStatusHandler({ registry });
    const p = ask({ question: 'q', requesterDid: 'did:plc:u' });
    await new Promise((r) => setImmediate(r));
    sched.advance(100);
    const submitRes = await p;

    const first = await status(submitRes.body.request_id);
    if (first.kind === 'found') {
      expect(first.body.status).toBe('in_flight');
    }

    released({ kind: 'answer', answer: { text: 'done' } });
    await new Promise((r) => setImmediate(r));

    const second = await status(submitRes.body.request_id);
    if (second.kind === 'found') {
      expect(second.body.status).toBe('complete');
      expect(second.body.answer).toEqual({ text: 'done' });
    }
  });
});
