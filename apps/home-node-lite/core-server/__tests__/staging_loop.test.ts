/**
 * staging_loop tests.
 */

import {
  DEFAULT_IDLE_SLEEP_MS,
  StagingLoop,
  type PendingStagingTask,
  type StagingLoopEvent,
  type StagingLoopIO,
} from '../src/brain/staging_loop';
import type { StagingInput } from '../src/brain/staging_processor';

function stagingInput(overrides: Partial<StagingInput> = {}): StagingInput {
  return {
    taskId: 't-1',
    text: 'Monthly review meeting on Friday.',
    source: 'email',
    receivedAt: 1_700_000_000,
    proposedPersona: 'work',
    ...overrides,
  };
}

function pendingTask(overrides: Partial<PendingStagingTask> = {}): PendingStagingTask {
  return {
    taskId: 't-1',
    input: stagingInput(),
    ...overrides,
  };
}

function ioWith(overrides: Partial<StagingLoopIO> = {}): StagingLoopIO {
  const store = jest.fn(async () => ({ ok: true, vaultItemId: 'v-1' }));
  const review = jest.fn(async () => ({ ok: true, reviewId: 'r-1' }));
  const resolve = jest.fn(async () => {});
  const fail = jest.fn(async () => {});
  return {
    claimFn: jest.fn(async () => null),
    storeFn: store,
    enqueueReviewFn: review,
    resolveFn: resolve,
    failFn: fail,
    ...overrides,
  };
}

describe('StagingLoop — construction', () => {
  it.each([
    ['null io', null],
    ['non-object io', 'bogus' as unknown as StagingLoopIO],
    ['missing claimFn', { storeFn: jest.fn(), enqueueReviewFn: jest.fn(), resolveFn: jest.fn(), failFn: jest.fn() }],
    ['missing storeFn', { claimFn: jest.fn(), enqueueReviewFn: jest.fn(), resolveFn: jest.fn(), failFn: jest.fn() }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(
      () =>
        new StagingLoop({ io: bad as unknown as StagingLoopIO }),
    ).toThrow();
  });

  it('rejects negative idleSleepMs', () => {
    expect(
      () =>
        new StagingLoop({ io: ioWith(), idleSleepMs: -1 }),
    ).toThrow(/idleSleepMs/);
  });

  it('DEFAULT_IDLE_SLEEP_MS is 500', () => {
    expect(DEFAULT_IDLE_SLEEP_MS).toBe(500);
  });
});

describe('StagingLoop.tick — idle path', () => {
  it('no task → idle result', async () => {
    const io = ioWith({ claimFn: jest.fn(async () => null) });
    const loop = new StagingLoop({ io });
    const r = await loop.tick();
    expect(r.kind).toBe('idle');
    expect(io.storeFn).not.toHaveBeenCalled();
  });

  it('claim throws → io_error at claim stage', async () => {
    const io = ioWith({
      claimFn: jest.fn(async () => {
        throw new Error('network');
      }),
    });
    const loop = new StagingLoop({ io });
    const r = await loop.tick();
    expect(r.kind).toBe('io_error');
    if (r.kind === 'io_error') {
      expect(r.stage).toBe('claim');
      expect(r.error).toBe('network');
    }
  });
});

describe('StagingLoop.tick — accept path', () => {
  it('general-tier content → accepted + store + resolve', async () => {
    const io = ioWith({
      claimFn: jest.fn(async () => pendingTask()),
    });
    const loop = new StagingLoop({ io });
    const r = await loop.tick();
    expect(r.kind).toBe('accepted');
    if (r.kind === 'accepted') {
      expect(r.vaultItemId).toBe('v-1');
      expect(r.decision.disposition).toBe('accept');
    }
    expect(io.storeFn).toHaveBeenCalledTimes(1);
    expect(io.resolveFn).toHaveBeenCalledWith('t-1', 'accepted');
    expect(io.failFn).not.toHaveBeenCalled();
  });

  it('store fails → io_error store + best-effort failFn', async () => {
    const io = ioWith({
      claimFn: jest.fn(async () => pendingTask()),
      storeFn: jest.fn(async () => ({ ok: false, error: 'db down' })),
    });
    const loop = new StagingLoop({ io });
    const r = await loop.tick();
    expect(r.kind).toBe('io_error');
    if (r.kind === 'io_error') expect(r.stage).toBe('store');
    expect(io.failFn).toHaveBeenCalledWith('t-1', expect.stringContaining('store_failed'));
  });

  it('store throws → io_error store + best-effort failFn', async () => {
    const io = ioWith({
      claimFn: jest.fn(async () => pendingTask()),
      storeFn: jest.fn(async () => {
        throw new Error('kaboom');
      }),
    });
    const loop = new StagingLoop({ io });
    const r = await loop.tick();
    expect(r.kind).toBe('io_error');
    expect(io.failFn).toHaveBeenCalled();
  });

  it('resolve fails after successful store → io_error resolve', async () => {
    const io = ioWith({
      claimFn: jest.fn(async () => pendingTask()),
      resolveFn: jest.fn(async () => {
        throw new Error('resolve failed');
      }),
    });
    const loop = new StagingLoop({ io });
    const r = await loop.tick();
    expect(r.kind).toBe('io_error');
    if (r.kind === 'io_error') expect(r.stage).toBe('resolve');
  });
});

describe('StagingLoop.tick — review path', () => {
  it('sensitive content routed to default persona → review', async () => {
    const io = ioWith({
      claimFn: jest.fn(async () =>
        pendingTask({
          input: stagingInput({
            text: 'I was diagnosed with depression and prescribed fluoxetine.',
            proposedPersona: 'general',
          }),
        }),
      ),
    });
    const loop = new StagingLoop({ io });
    const r = await loop.tick();
    expect(r.kind).toBe('reviewed');
    if (r.kind === 'reviewed') {
      expect(r.reviewId).toBe('r-1');
    }
    expect(io.enqueueReviewFn).toHaveBeenCalledTimes(1);
    expect(io.resolveFn).toHaveBeenCalledWith('t-1', 'reviewed');
  });

  it('enqueueReview fails → io_error review', async () => {
    const io = ioWith({
      claimFn: jest.fn(async () =>
        pendingTask({
          input: stagingInput({
            text: 'I was diagnosed with anxiety.',
            proposedPersona: 'general',
          }),
        }),
      ),
      enqueueReviewFn: jest.fn(async () => ({ ok: false, error: 'queue full' })),
    });
    const loop = new StagingLoop({ io });
    const r = await loop.tick();
    if (r.kind === 'io_error') expect(r.stage).toBe('review');
    else throw new Error('expected io_error');
  });
});

describe('StagingLoop.tick — reject path', () => {
  it('local_only content → rejected + failFn', async () => {
    const io = ioWith({
      claimFn: jest.fn(async () =>
        pendingTask({
          input: stagingInput({
            text: 'API key: sk-ant-abcdefghijklmnop1234567890',
          }),
        }),
      ),
    });
    const loop = new StagingLoop({ io });
    const r = await loop.tick();
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.reason).toBe('reject_local_only');
    expect(io.failFn).toHaveBeenCalledWith('t-1', 'reject_local_only');
    expect(io.storeFn).not.toHaveBeenCalled();
    expect(io.resolveFn).not.toHaveBeenCalled();
  });

  it('failFn throws during reject → io_error fail', async () => {
    const io = ioWith({
      claimFn: jest.fn(async () =>
        pendingTask({
          input: stagingInput({
            text: '-----BEGIN RSA PRIVATE KEY-----\nxyz',
          }),
        }),
      ),
      failFn: jest.fn(async () => {
        throw new Error('cannot reach core');
      }),
    });
    const loop = new StagingLoop({ io });
    const r = await loop.tick();
    if (r.kind === 'io_error') expect(r.stage).toBe('fail');
    else throw new Error('expected io_error');
  });
});

describe('StagingLoop.tick — event stream', () => {
  it('emits tick_started + tick_completed for each tick', async () => {
    const events: StagingLoopEvent[] = [];
    const io = ioWith({ claimFn: jest.fn(async () => null) });
    const loop = new StagingLoop({ io, onEvent: (e) => events.push(e) });
    await loop.tick();
    expect(events.map((e) => e.kind)).toEqual(['tick_started', 'tick_completed']);
  });
});

describe('StagingLoop.run — loop lifecycle', () => {
  it('stop() halts the loop at the next boundary', async () => {
    let ticked = 0;
    const io = ioWith({
      claimFn: async () => {
        ticked++;
        if (ticked >= 3) loop.stop();
        return null;
      },
    });
    const loop = new StagingLoop({ io, idleSleepMs: 0, sleepFn: async () => {} });
    await loop.run();
    expect(ticked).toBeGreaterThanOrEqual(3);
    expect(loop.isRunning()).toBe(false);
  });

  it('abort signal halts the loop', async () => {
    const controller = new AbortController();
    let ticked = 0;
    const io = ioWith({
      claimFn: async () => {
        ticked++;
        if (ticked === 2) controller.abort();
        return null;
      },
    });
    const loop = new StagingLoop({ io, idleSleepMs: 0, sleepFn: async () => {} });
    await loop.run({ signal: controller.signal });
    expect(ticked).toBeGreaterThanOrEqual(2);
  });

  it('concurrent run() throws — first run must complete first', async () => {
    // Hold the loop open by making claim hang on a promise we control.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const io = ioWith({
      claimFn: async () => {
        await held;
        return null;
      },
    });
    const loop = new StagingLoop({ io, idleSleepMs: 0, sleepFn: async () => {} });
    const first = loop.run();
    // Second call while first is running → throws immediately.
    await expect(loop.run()).rejects.toThrow(/already running/);
    loop.stop();
    release();
    await first;
  });

  it('re-running after a clean stop is allowed', async () => {
    const io = ioWith({
      claimFn: async () => {
        loop.stop();
        return null;
      },
    });
    const loop = new StagingLoop({ io, idleSleepMs: 0, sleepFn: async () => {} });
    await loop.run();
    // Second run after the first completes — no throw.
    await loop.run();
    expect(loop.isRunning()).toBe(false);
  });

  it('loop_started + loop_stopped events fire', async () => {
    const events: StagingLoopEvent[] = [];
    const io = ioWith({
      claimFn: async () => {
        loop.stop();
        return null;
      },
    });
    const loop = new StagingLoop({ io, onEvent: (e) => events.push(e), idleSleepMs: 0, sleepFn: async () => {} });
    await loop.run();
    expect(events[0]!.kind).toBe('loop_started');
    expect(events[events.length - 1]!.kind).toBe('loop_stopped');
    const stopEvent = events[events.length - 1]! as { kind: 'loop_stopped'; reason: string };
    expect(stopEvent.reason).toBe('manual');
  });
});
