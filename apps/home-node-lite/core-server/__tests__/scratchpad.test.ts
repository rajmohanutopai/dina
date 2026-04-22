/**
 * Task 5.42 — Scratchpad tests.
 */

import {
  DEFAULT_MAX_CONTEXT_BYTES,
  InMemoryScratchpadBackend,
  Scratchpad,
  type ScratchpadBackend,
  type ScratchpadEvent,
} from '../src/brain/scratchpad';

describe('Scratchpad (task 5.42)', () => {
  describe('construction validation', () => {
    it('rejects missing backend', () => {
      expect(
        () => new Scratchpad({ backend: undefined as unknown as ScratchpadBackend }),
      ).toThrow(/backend is required/);
    });
  });

  describe('checkpoint happy path', () => {
    it('writes a checkpoint + fires checkpoint_written', async () => {
      const events: ScratchpadEvent[] = [];
      const backend = new InMemoryScratchpadBackend();
      const s = new Scratchpad({ backend, onEvent: (e) => events.push(e) });
      const res = await s.checkpoint('task-1', 1, { relationship: 'close' });
      expect(res).toEqual({ ok: true, step: 1 });
      expect(backend.size()).toBe(1);
      const written = events.find((e) => e.kind === 'checkpoint_written') as Extract<
        ScratchpadEvent,
        { kind: 'checkpoint_written' }
      >;
      expect(written.taskId).toBe('task-1');
      expect(written.step).toBe(1);
      expect(written.keys).toEqual(['relationship']);
    });

    it('accepts monotonically increasing steps for same task', async () => {
      const s = new Scratchpad({ backend: new InMemoryScratchpadBackend() });
      expect((await s.checkpoint('t', 1, { a: 1 })).ok).toBe(true);
      expect((await s.checkpoint('t', 2, { a: 1, b: 2 })).ok).toBe(true);
      expect((await s.checkpoint('t', 5, { a: 1, b: 2, c: 3 })).ok).toBe(true);
    });
  });

  describe('checkpoint rejections', () => {
    it('rejects empty task id', async () => {
      const s = new Scratchpad({ backend: new InMemoryScratchpadBackend() });
      const r = await s.checkpoint('', 1, {});
      expect(r).toEqual({ ok: false, reason: 'empty_task_id' });
    });

    it('rejects non-positive step', async () => {
      const s = new Scratchpad({ backend: new InMemoryScratchpadBackend() });
      expect((await s.checkpoint('t', 0, {})).ok).toBe(false);
      expect((await s.checkpoint('t', -1, {})).ok).toBe(false);
      expect((await s.checkpoint('t', 1.5, {})).ok).toBe(false);
    });

    it('rejects out-of-order step (<=) + preserves prior state', async () => {
      const backend = new InMemoryScratchpadBackend();
      const s = new Scratchpad({ backend });
      await s.checkpoint('t', 3, { from: 'step-3' });
      const bad = await s.checkpoint('t', 2, { from: 'step-2' });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.reason).toBe('bad_step_order');
      // Buffer is unchanged — prior step-3 still in the backend.
      const resumed = await s.resume('t');
      expect(resumed?.step).toBe(3);
      expect((resumed?.context as { from: string }).from).toBe('step-3');
    });

    it('rejects re-writing same step', async () => {
      const s = new Scratchpad({ backend: new InMemoryScratchpadBackend() });
      await s.checkpoint('t', 1, {});
      const dup = await s.checkpoint('t', 1, {});
      expect(dup.ok).toBe(false);
      if (!dup.ok) expect(dup.reason).toBe('bad_step_order');
    });

    it('rejects oversized context', async () => {
      const backend = new InMemoryScratchpadBackend();
      const s = new Scratchpad({ backend, maxContextBytes: 64 });
      const big = { payload: 'x'.repeat(200) };
      const r = await s.checkpoint('t', 1, big);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('context_too_large');
      // Nothing was written.
      expect(backend.size()).toBe(0);
    });

    it('DEFAULT_MAX_CONTEXT_BYTES is 64KB', () => {
      expect(DEFAULT_MAX_CONTEXT_BYTES).toBe(64 * 1024);
    });
  });

  describe('resume', () => {
    it('returns null for unknown task + fires resume_miss', async () => {
      const events: ScratchpadEvent[] = [];
      const s = new Scratchpad({
        backend: new InMemoryScratchpadBackend(),
        onEvent: (e) => events.push(e),
      });
      const r = await s.resume('unknown');
      expect(r).toBeNull();
      expect(events.some((e) => e.kind === 'resume_miss')).toBe(true);
    });

    it('returns stored step + context + primes step cache', async () => {
      const events: ScratchpadEvent[] = [];
      const backend = new InMemoryScratchpadBackend();
      const s1 = new Scratchpad({ backend, onEvent: (e) => events.push(e) });
      await s1.checkpoint('t', 4, { done: 'step-4' });
      // Pretend restart — fresh Scratchpad, same backend.
      const s2 = new Scratchpad({ backend });
      const r = await s2.resume('t');
      expect(r?.step).toBe(4);
      expect((r?.context as { done: string }).done).toBe('step-4');
      // Post-resume, step-cache is primed: a step-<=4 write is rejected.
      const bad = await s2.checkpoint('t', 4, {});
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.reason).toBe('bad_step_order');
      // Step 5 goes through.
      expect((await s2.checkpoint('t', 5, {})).ok).toBe(true);
    });

    it('returns a defensive copy — callers cannot mutate the backend', async () => {
      const backend = new InMemoryScratchpadBackend();
      const s = new Scratchpad({ backend });
      await s.checkpoint('t', 1, { nested: { tag: 'orig' } });
      const first = await s.resume('t');
      expect(first).not.toBeNull();
      (first!.context as { nested: { tag: string } }).nested.tag = 'MUTATED';
      const second = await s.resume('t');
      expect(
        (second!.context as { nested: { tag: string } }).nested.tag,
      ).toBe('orig');
    });

    it('empty task id returns null', async () => {
      const s = new Scratchpad({ backend: new InMemoryScratchpadBackend() });
      expect(await s.resume('')).toBeNull();
    });
  });

  describe('clear', () => {
    it('clears the backend + fires cleared event', async () => {
      const events: ScratchpadEvent[] = [];
      const backend = new InMemoryScratchpadBackend();
      const s = new Scratchpad({ backend, onEvent: (e) => events.push(e) });
      await s.checkpoint('t', 1, {});
      expect(backend.size()).toBe(1);
      await s.clear('t');
      expect(backend.size()).toBe(0);
      expect(events.some((e) => e.kind === 'cleared')).toBe(true);
    });

    it('is idempotent for unknown task', async () => {
      const s = new Scratchpad({ backend: new InMemoryScratchpadBackend() });
      await expect(s.clear('never-written')).resolves.toBeUndefined();
    });

    it('clears the step-cache so a future write can start at step 1', async () => {
      const s = new Scratchpad({ backend: new InMemoryScratchpadBackend() });
      await s.checkpoint('t', 5, {});
      await s.clear('t');
      // After clear, the same task id can start over at step 1.
      expect((await s.checkpoint('t', 1, {})).ok).toBe(true);
    });

    it('propagates backend failure + leaves step-cache intact', async () => {
      // When the backend throws on clear, we should NOT demote the
      // step-cache — the task is still semantically in flight until
      // the caller confirms the clear succeeded.
      const realBackend = new InMemoryScratchpadBackend();
      const throwingBackend: ScratchpadBackend = {
        write: (id, step, ctx) => realBackend.write(id, step, ctx),
        read: (id) => realBackend.read(id),
        clear: async () => {
          throw new Error('backend offline');
        },
      };
      const s = new Scratchpad({ backend: throwingBackend });
      await s.checkpoint('t', 7, {});
      await expect(s.clear('t')).rejects.toThrow(/backend offline/);
      // Cache still has step 7 → writing step 5 must still be rejected.
      const bad = await s.checkpoint('t', 5, {});
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.reason).toBe('bad_step_order');
    });
  });

  describe('tasksInFlight', () => {
    it('counts distinct task ids that have been written', async () => {
      const s = new Scratchpad({ backend: new InMemoryScratchpadBackend() });
      expect(s.tasksInFlight()).toBe(0);
      await s.checkpoint('a', 1, {});
      await s.checkpoint('b', 1, {});
      await s.checkpoint('a', 2, {});
      expect(s.tasksInFlight()).toBe(2);
      await s.clear('a');
      expect(s.tasksInFlight()).toBe(1);
    });
  });

  describe('InMemoryScratchpadBackend', () => {
    it('write/read round-trip + structuredClone isolation', async () => {
      const b = new InMemoryScratchpadBackend();
      const ctx = { nested: { v: 1 } };
      await b.write('t', 1, ctx);
      // Mutate caller's copy after write.
      ctx.nested.v = 999;
      const out = await b.read('t');
      expect((out?.context as { nested: { v: number } }).nested.v).toBe(1);
    });

    it('clear is idempotent', async () => {
      const b = new InMemoryScratchpadBackend();
      await expect(b.clear('x')).resolves.toBeUndefined();
      await expect(b.clear('x')).resolves.toBeUndefined();
    });
  });
});
