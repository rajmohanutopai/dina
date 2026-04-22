/**
 * Task 5.30 — GuardianLoop tests.
 */

import {
  DEFAULT_EVENT_TIMEOUT_MS,
  GuardianLoop,
  type GuardianClassifyFn,
  type GuardianEvent,
  type GuardianEventSourceFn,
  type GuardianLoopEvent,
  type GuardianProcessFn,
} from '../src/brain/guardian_loop';

/** Finite event source — yields each event then null. */
function scripted(events: GuardianEvent[]): GuardianEventSourceFn {
  let i = 0;
  return async () => {
    if (i >= events.length) return null;
    return events[i++]!;
  };
}

const ev = (id: string, source = 'gmail'): GuardianEvent => ({
  id,
  payload: { demo: true },
  source,
});

describe('GuardianLoop (task 5.30)', () => {
  describe('construction validation', () => {
    it('throws on missing eventSourceFn', () => {
      expect(
        () =>
          new GuardianLoop({
            eventSourceFn: undefined as unknown as GuardianEventSourceFn,
            classifyFn: async () => 'engagement',
            processFn: async () => {},
          }),
      ).toThrow(/eventSourceFn/);
    });

    it('throws on missing classifyFn', () => {
      expect(
        () =>
          new GuardianLoop({
            eventSourceFn: async () => null,
            classifyFn: undefined as unknown as GuardianClassifyFn,
            processFn: async () => {},
          }),
      ).toThrow(/classifyFn/);
    });

    it('throws on missing processFn', () => {
      expect(
        () =>
          new GuardianLoop({
            eventSourceFn: async () => null,
            classifyFn: async () => 'engagement',
            processFn: undefined as unknown as GuardianProcessFn,
          }),
      ).toThrow(/processFn/);
    });
  });

  describe('happy path', () => {
    it('drains all events + processes each with its classified priority', async () => {
      const seen: Array<{ id: string; priority: string }> = [];
      const classifyFn: GuardianClassifyFn = async (e) =>
        e.id === 'e1' ? 'fiduciary' : 'engagement';
      const processFn: GuardianProcessFn = async (e, p) => {
        seen.push({ id: e.id, priority: p });
      };
      const loop = new GuardianLoop({
        eventSourceFn: scripted([ev('e1'), ev('e2')]),
        classifyFn,
        processFn,
      });
      await loop.start();
      expect(seen).toEqual([
        { id: 'e1', priority: 'fiduciary' },
        { id: 'e2', priority: 'engagement' },
      ]);
      expect(loop.stats().processed).toBe(2);
      expect(loop.stats().failed).toBe(0);
    });

    it('empty event source → loop exits immediately', async () => {
      const loop = new GuardianLoop({
        eventSourceFn: async () => null,
        classifyFn: async () => 'engagement',
        processFn: async () => {},
      });
      await loop.start();
      expect(loop.stats().processed).toBe(0);
      expect(loop.isRunning()).toBe(false);
    });

    it('fires the full event sequence per event', async () => {
      const events: GuardianLoopEvent[] = [];
      const loop = new GuardianLoop({
        eventSourceFn: scripted([ev('e1')]),
        classifyFn: async () => 'solicited',
        processFn: async () => {},
        onEvent: (e) => events.push(e),
      });
      await loop.start();
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual([
        'event_received',
        'classified',
        'processed',
        'loop_stopped',
      ]);
    });
  });

  describe('error isolation', () => {
    it('handler throw does NOT kill the loop', async () => {
      const seen: string[] = [];
      const processFn: GuardianProcessFn = async (e) => {
        if (e.id === 'bad') throw new Error('boom');
        seen.push(e.id);
      };
      const loop = new GuardianLoop({
        eventSourceFn: scripted([ev('a'), ev('bad'), ev('b')]),
        classifyFn: async () => 'engagement',
        processFn,
      });
      await loop.start();
      expect(seen).toEqual(['a', 'b']);
      expect(loop.stats().processed).toBe(2);
      expect(loop.stats().failed).toBe(1);
    });

    it('process_failed event carries the error message', async () => {
      const events: GuardianLoopEvent[] = [];
      const loop = new GuardianLoop({
        eventSourceFn: scripted([ev('x')]),
        classifyFn: async () => 'engagement',
        processFn: async () => {
          throw new Error('downstream-failure');
        },
        onEvent: (e) => events.push(e),
      });
      await loop.start();
      const fail = events.find((e) => e.kind === 'process_failed') as Extract<
        GuardianLoopEvent,
        { kind: 'process_failed' }
      >;
      expect(fail.error).toMatch(/downstream-failure/);
    });
  });

  describe('classifier silence-first default', () => {
    it('classifier throws → treated as engagement (Silence First)', async () => {
      const seen: Array<{ id: string; priority: string }> = [];
      const loop = new GuardianLoop({
        eventSourceFn: scripted([ev('e1')]),
        classifyFn: async () => {
          throw new Error('LLM down');
        },
        processFn: async (e, p) => {
          seen.push({ id: e.id, priority: p });
        },
      });
      await loop.start();
      expect(seen[0]!.priority).toBe('engagement');
      expect(loop.stats().silenced).toBe(1);
    });

    it('classifier returns null → treated as engagement', async () => {
      const seen: string[] = [];
      const loop = new GuardianLoop({
        eventSourceFn: scripted([ev('e1')]),
        classifyFn: async () => null,
        processFn: async (_, p) => {
          seen.push(p);
        },
      });
      await loop.start();
      expect(seen).toEqual(['engagement']);
      expect(loop.stats().silenced).toBe(1);
    });

    it('classified event with classifierFailed=true is flagged in the event stream', async () => {
      const events: GuardianLoopEvent[] = [];
      const loop = new GuardianLoop({
        eventSourceFn: scripted([ev('e1')]),
        classifyFn: async () => null,
        processFn: async () => {},
        onEvent: (e) => events.push(e),
      });
      await loop.start();
      const classified = events.find(
        (e) => e.kind === 'classified',
      ) as Extract<GuardianLoopEvent, { kind: 'classified' }>;
      expect(classified.classifierFailed).toBe(true);
    });
  });

  describe('timeouts', () => {
    it('handler exceeding eventTimeoutMs fires event_timeout', async () => {
      const events: GuardianLoopEvent[] = [];
      const loop = new GuardianLoop({
        eventSourceFn: scripted([ev('e1')]),
        classifyFn: async () => 'fiduciary',
        processFn: () => new Promise(() => {}), // never resolves
        eventTimeoutMs: 20,
        onEvent: (e) => events.push(e),
      });
      await loop.start();
      expect(loop.stats().timedOut).toBe(1);
      expect(loop.stats().failed).toBe(0);
      expect(events.some((e) => e.kind === 'event_timeout')).toBe(true);
    });

    it('eventTimeoutMs=0 disables the timeout', async () => {
      const loop = new GuardianLoop({
        eventSourceFn: scripted([ev('e1')]),
        classifyFn: async () => 'engagement',
        processFn: async () => new Promise<void>((r) => setTimeout(r, 30)),
        eventTimeoutMs: 0,
      });
      await loop.start();
      expect(loop.stats().processed).toBe(1);
      expect(loop.stats().timedOut).toBe(0);
    });

    it('DEFAULT_EVENT_TIMEOUT_MS is 30s', () => {
      expect(DEFAULT_EVENT_TIMEOUT_MS).toBe(30_000);
    });
  });

  describe('graceful shutdown', () => {
    it('stop() after start() resolves when drain completes', async () => {
      const loop = new GuardianLoop({
        eventSourceFn: scripted([ev('a'), ev('b')]),
        classifyFn: async () => 'engagement',
        processFn: async () => {},
      });
      const done = loop.start();
      await loop.stop();
      await done;
      expect(loop.isRunning()).toBe(false);
    });

    it('stop() mid-stream prevents pulling further events', async () => {
      let pulled = 0;
      const eventSourceFn: GuardianEventSourceFn = async () => {
        pulled++;
        if (pulled > 10) return null;
        return ev(`e${pulled}`);
      };
      const processedIds: string[] = [];
      const loop = new GuardianLoop({
        eventSourceFn,
        classifyFn: async () => 'engagement',
        processFn: async (e) => {
          processedIds.push(e.id);
          if (e.id === 'e1') {
            // Stop right after the first event processes. Intentional
            // fire-and-forget — the loop should observe stopRequested
            // on the next while-check.
            void loop.stop();
          }
        },
      });
      await loop.start();
      // Per the drain contract: `stop()` sets a flag that the while
      // loop checks after the current processOne completes. So e1
      // processes (stop called inside it), then the loop exits
      // before pulling e2. Exact: processedIds === ['e1'].
      expect(processedIds).toEqual(['e1']);
      expect(pulled).toBe(1);
    });

    it('start() called while running returns the same drain promise', () => {
      const loop = new GuardianLoop({
        eventSourceFn: async () => null,
        classifyFn: async () => 'engagement',
        processFn: async () => {},
      });
      const p1 = loop.start();
      const p2 = loop.start();
      expect(p1).toBe(p2);
    });
  });

  describe('stats', () => {
    it('snapshots current counters', async () => {
      const loop = new GuardianLoop({
        eventSourceFn: scripted([ev('a'), ev('b'), ev('c')]),
        classifyFn: async () => 'engagement',
        processFn: async (e) => {
          if (e.id === 'b') throw new Error('fail');
        },
      });
      await loop.start();
      const s = loop.stats();
      expect(s.processed).toBe(2);
      expect(s.failed).toBe(1);
      expect(s.running).toBe(false);
    });

    it('is a copy — mutating does not leak back into the loop', async () => {
      const loop = new GuardianLoop({
        eventSourceFn: scripted([ev('a')]),
        classifyFn: async () => 'engagement',
        processFn: async () => {},
      });
      await loop.start();
      const s = loop.stats();
      s.processed = 99999;
      expect(loop.stats().processed).toBe(1);
    });
  });

  describe('loop_stopped event', () => {
    it('reports totals when the loop exits', async () => {
      const events: GuardianLoopEvent[] = [];
      const loop = new GuardianLoop({
        eventSourceFn: scripted([ev('a'), ev('b'), ev('c')]),
        classifyFn: async () => 'engagement',
        processFn: async (e) => {
          if (e.id === 'c') throw new Error('x');
        },
        onEvent: (e) => events.push(e),
      });
      await loop.start();
      const done = events.find(
        (e) => e.kind === 'loop_stopped',
      ) as Extract<GuardianLoopEvent, { kind: 'loop_stopped' }>;
      expect(done.processed).toBe(2);
      expect(done.failed).toBe(1);
      expect(done.timedOut).toBe(0);
    });
  });
});
