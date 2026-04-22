/**
 * Task 5.56 — BrainLoopRegistry tests.
 */

import {
  BrainLoopRegistry,
  type BrainLoopRegistryEvent,
  type ManagedLoop,
} from '../src/brain/brain_loop_registry';

/** Stub loop for tests — tracks calls + lets tests control responses. */
class StubLoop implements ManagedLoop {
  startCalls = 0;
  stopCalls = 0;
  running = false;
  startShouldThrow: Error | null = null;
  stopShouldThrow: Error | null = null;

  async start(): Promise<void> {
    this.startCalls++;
    if (this.startShouldThrow) throw this.startShouldThrow;
    this.running = true;
  }

  async stop(): Promise<void> {
    this.stopCalls++;
    if (this.stopShouldThrow) throw this.stopShouldThrow;
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }
}

describe('BrainLoopRegistry (task 5.56)', () => {
  describe('add', () => {
    it('registers a loop under a name', () => {
      const reg = new BrainLoopRegistry();
      reg.add('guardian', new StubLoop());
      expect(reg.has('guardian')).toBe(true);
      expect(reg.size()).toBe(1);
    });

    it('rejects duplicate names', () => {
      const reg = new BrainLoopRegistry();
      reg.add('guardian', new StubLoop());
      expect(() => reg.add('guardian', new StubLoop())).toThrow(/already/);
    });

    it('rejects empty name', () => {
      const reg = new BrainLoopRegistry();
      expect(() => reg.add('', new StubLoop())).toThrow(/non-empty/);
      expect(() => reg.add('   ', new StubLoop())).toThrow(/non-empty/);
    });

    it('rejects loop missing required methods', () => {
      const reg = new BrainLoopRegistry();
      expect(() =>
        reg.add('bad', { start: () => {} } as unknown as ManagedLoop),
      ).toThrow(/start.*stop.*isRunning/);
    });

    it('registration does NOT start the loop — caller calls startAll() / start()', async () => {
      const loop = new StubLoop();
      const reg = new BrainLoopRegistry();
      reg.add('guardian', loop);
      await new Promise((r) => setImmediate(r));
      expect(loop.startCalls).toBe(0);
    });

    it('fires added event', () => {
      const events: BrainLoopRegistryEvent[] = [];
      const reg = new BrainLoopRegistry({ onEvent: (e) => events.push(e) });
      reg.add('guardian', new StubLoop());
      expect(events.some((e) => e.kind === 'added')).toBe(true);
    });
  });

  describe('start / stop individual', () => {
    it('start(name) calls the loop\'s start()', async () => {
      const loop = new StubLoop();
      const reg = new BrainLoopRegistry();
      reg.add('guardian', loop);
      await reg.start('guardian');
      expect(loop.startCalls).toBe(1);
      expect(loop.running).toBe(true);
    });

    it('stop(name) calls the loop\'s stop()', async () => {
      const loop = new StubLoop();
      const reg = new BrainLoopRegistry();
      reg.add('guardian', loop);
      await reg.start('guardian');
      await reg.stop('guardian');
      expect(loop.stopCalls).toBe(1);
      expect(loop.running).toBe(false);
    });

    it('unknown name throws', async () => {
      const reg = new BrainLoopRegistry();
      await expect(reg.start('nope')).rejects.toThrow(/no loop/);
      await expect(reg.stop('nope')).rejects.toThrow(/no loop/);
    });

    it('start() propagates underlying errors', async () => {
      const loop = new StubLoop();
      loop.startShouldThrow = new Error('boot failed');
      const reg = new BrainLoopRegistry();
      reg.add('x', loop);
      await expect(reg.start('x')).rejects.toThrow(/boot failed/);
    });

    it('stop() propagates underlying errors + emits stopped with error', async () => {
      const events: BrainLoopRegistryEvent[] = [];
      const loop = new StubLoop();
      loop.stopShouldThrow = new Error('stop failed');
      const reg = new BrainLoopRegistry({ onEvent: (e) => events.push(e) });
      reg.add('x', loop);
      await expect(reg.stop('x')).rejects.toThrow(/stop failed/);
      const stopped = events.find((e) => e.kind === 'stopped') as Extract<
        BrainLoopRegistryEvent,
        { kind: 'stopped' }
      >;
      expect(stopped.error).toMatch(/stop failed/);
    });
  });

  describe('startAll', () => {
    it('starts every loop in registration order', async () => {
      const order: string[] = [];
      const reg = new BrainLoopRegistry();
      for (const name of ['a', 'b', 'c']) {
        const loop: ManagedLoop = {
          start: async () => {
            order.push(name);
          },
          stop: async () => {},
          isRunning: () => false,
        };
        reg.add(name, loop);
      }
      await reg.startAll();
      expect(order).toEqual(['a', 'b', 'c']);
    });

    it('one loop failing does NOT abort the fleet', async () => {
      const reg = new BrainLoopRegistry();
      const good = new StubLoop();
      const bad = new StubLoop();
      bad.startShouldThrow = new Error('boom');
      reg.add('good-1', good);
      reg.add('bad', bad);
      reg.add('good-2', good);
      const result = await reg.startAll();
      expect(result.started).toEqual(['good-1', 'good-2']);
      expect(result.failed).toEqual([{ name: 'bad', error: 'boom' }]);
    });

    it('fires fleet_started event', async () => {
      const events: BrainLoopRegistryEvent[] = [];
      const reg = new BrainLoopRegistry({ onEvent: (e) => events.push(e) });
      reg.add('a', new StubLoop());
      await reg.startAll();
      expect(events.some((e) => e.kind === 'fleet_started')).toBe(true);
    });
  });

  describe('stopAll', () => {
    it('stops every loop in REVERSE registration order', async () => {
      const order: string[] = [];
      const reg = new BrainLoopRegistry();
      for (const name of ['a', 'b', 'c']) {
        const loop: ManagedLoop = {
          start: async () => {},
          stop: async () => {
            order.push(name);
          },
          isRunning: () => false,
        };
        reg.add(name, loop);
      }
      await reg.stopAll();
      expect(order).toEqual(['c', 'b', 'a']);
    });

    it('continues stopping when one loop fails (fail-safe)', async () => {
      const reg = new BrainLoopRegistry();
      const a = new StubLoop();
      const bad = new StubLoop();
      bad.stopShouldThrow = new Error('stuck');
      const c = new StubLoop();
      reg.add('a', a);
      reg.add('bad', bad);
      reg.add('c', c);
      const result = await reg.stopAll();
      // Reverse order: c then bad (fails) then a.
      expect(result.stopped.sort()).toEqual(['a', 'c']);
      expect(result.failed).toEqual([{ name: 'bad', error: 'stuck' }]);
      // Critically: `a` still stopped even though `bad` failed before it.
      expect(a.stopCalls).toBe(1);
      expect(c.stopCalls).toBe(1);
    });

    it('empty registry → no-op', async () => {
      const reg = new BrainLoopRegistry();
      const result = await reg.stopAll();
      expect(result.stopped).toEqual([]);
      expect(result.failed).toEqual([]);
    });

    it('fires fleet_stopped event', async () => {
      const events: BrainLoopRegistryEvent[] = [];
      const reg = new BrainLoopRegistry({ onEvent: (e) => events.push(e) });
      reg.add('a', new StubLoop());
      await reg.stopAll();
      expect(events.some((e) => e.kind === 'fleet_stopped')).toBe(true);
    });
  });

  describe('stats', () => {
    it('reports running loops', async () => {
      const reg = new BrainLoopRegistry();
      const a = new StubLoop();
      const b = new StubLoop();
      const c = new StubLoop();
      reg.add('a', a);
      reg.add('b', b);
      reg.add('c', c);
      await reg.start('a');
      await reg.start('c');
      const s = reg.stats();
      expect(s.total).toBe(3);
      expect(s.running.sort()).toEqual(['a', 'c']);
    });

    it('empty registry stats', () => {
      const reg = new BrainLoopRegistry();
      expect(reg.stats()).toEqual({ running: [], total: 0 });
    });
  });

  describe('names', () => {
    it('returns names in registration order', () => {
      const reg = new BrainLoopRegistry();
      reg.add('guardian', new StubLoop());
      reg.add('scratchpad', new StubLoop());
      reg.add('msgbox', new StubLoop());
      expect(reg.names()).toEqual(['guardian', 'scratchpad', 'msgbox']);
    });
  });

  describe('realistic fleet', () => {
    it('boot + shutdown cycle', async () => {
      const reg = new BrainLoopRegistry();
      const guardian = new StubLoop();
      const scratchpad = new StubLoop();
      const msgbox = new StubLoop();
      reg.add('guardian', guardian);
      reg.add('scratchpad', scratchpad);
      reg.add('msgbox', msgbox);

      // Boot: start everyone.
      await reg.startAll();
      expect(reg.stats().running.sort()).toEqual(['guardian', 'msgbox', 'scratchpad']);

      // Graceful shutdown: stop everyone in reverse order.
      await reg.stopAll();
      expect(reg.stats().running).toEqual([]);
      expect(guardian.stopCalls).toBe(1);
      expect(scratchpad.stopCalls).toBe(1);
      expect(msgbox.stopCalls).toBe(1);
    });
  });
});
