/**
 * Task 4.9 — graceful shutdown tests.
 *
 * Exercises the shutdown orchestration without touching real signal
 * handlers: we inject an `exit` hook + drive the sequence directly.
 * Signal-handler wiring has its own dedicated test at the bottom.
 */

import { pino } from 'pino';
import {
  registerSignalHandlers,
  runShutdown,
  type ShutdownStep,
} from '../src/shutdown';

function silentLogger() {
  return pino({ level: 'silent' });
}

describe('graceful shutdown (task 4.9)', () => {
  describe('runShutdown', () => {
    it('runs steps in declared order — Fastify → MsgBox → DB', async () => {
      const order: string[] = [];
      const steps: ShutdownStep[] = [
        { name: 'fastify', close: () => void order.push('fastify') },
        { name: 'msgbox', close: () => void order.push('msgbox') },
        { name: 'db', close: () => void order.push('db') },
      ];
      await runShutdown({ logger: silentLogger(), steps });
      expect(order).toEqual(['fastify', 'msgbox', 'db']);
    });

    it('awaits async close functions', async () => {
      const order: string[] = [];
      const steps: ShutdownStep[] = [
        {
          name: 'slow',
          close: async () => {
            await new Promise((r) => setTimeout(r, 5));
            order.push('slow');
          },
        },
        { name: 'fast', close: () => void order.push('fast') },
      ];
      await runShutdown({ logger: silentLogger(), steps });
      expect(order).toEqual(['slow', 'fast']);
    });

    it('continues past a throwing step (best-effort drain)', async () => {
      const order: string[] = [];
      const steps: ShutdownStep[] = [
        {
          name: 'fastify',
          close: () => {
            throw new Error('fastify close failed');
          },
        },
        { name: 'msgbox', close: () => void order.push('msgbox') },
        { name: 'db', close: () => void order.push('db') },
      ];
      await runShutdown({ logger: silentLogger(), steps });
      expect(order).toEqual(['msgbox', 'db']);
    });

    it('continues past an async-rejecting step', async () => {
      const order: string[] = [];
      const steps: ShutdownStep[] = [
        { name: 'fastify', close: async () => Promise.reject(new Error('async fail')) },
        { name: 'db', close: () => void order.push('db') },
      ];
      await runShutdown({ logger: silentLogger(), steps });
      expect(order).toEqual(['db']);
    });

    it('enforces per-step timeout so a stuck step does not hang the sequence', async () => {
      const order: string[] = [];
      const steps: ShutdownStep[] = [
        {
          name: 'hung',
          close: () => new Promise<void>(() => undefined), // never resolves
        },
        { name: 'db', close: () => void order.push('db') },
      ];
      await runShutdown({
        logger: silentLogger(),
        steps,
        perStepTimeoutMs: 30,
        overallTimeoutMs: 200,
      });
      expect(order).toEqual(['db']);
    });

    it('stops running more steps once overall budget is exhausted', async () => {
      const order: string[] = [];
      const steps: ShutdownStep[] = [
        {
          name: 'slow1',
          close: () => new Promise<void>((r) => setTimeout(r, 40)),
        },
        {
          name: 'slow2',
          close: () => new Promise<void>((r) => setTimeout(r, 40)),
        },
        {
          name: 'db',
          close: () => {
            order.push('db');
          },
        },
      ];
      await runShutdown({
        logger: silentLogger(),
        steps,
        perStepTimeoutMs: 100,
        overallTimeoutMs: 50, // after slow1 runs, overall is exhausted
      });
      // slow1 runs, then the overall budget check skips the rest.
      expect(order).toEqual([]);
    });
  });

  describe('registerSignalHandlers', () => {
    it('wires SIGINT/SIGTERM and runs the sequence on signal', async () => {
      const exitCodes: number[] = [];
      const closed: string[] = [];
      const steps: ShutdownStep[] = [
        { name: 'fastify', close: () => void closed.push('fastify') },
      ];
      const dereg = registerSignalHandlers({
        logger: silentLogger(),
        steps,
        exit: (code) => void exitCodes.push(code),
      });

      // Emit SIGTERM programmatically.
      process.emit('SIGTERM');
      // Wait a microtask so the async handler runs.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(closed).toEqual(['fastify']);
      expect(exitCodes).toEqual([0]);
      dereg();
    });

    it('second signal during shutdown forces exit(1)', async () => {
      const exitCodes: number[] = [];
      const steps: ShutdownStep[] = [
        { name: 'slow', close: () => new Promise<void>((r) => setTimeout(r, 50)) },
      ];
      const dereg = registerSignalHandlers({
        logger: silentLogger(),
        steps,
        exit: (code) => void exitCodes.push(code),
        perStepTimeoutMs: 200,
      });

      process.emit('SIGINT');
      // Fire a second SIGINT before the first's `slow` step finishes.
      await new Promise((r) => setImmediate(r));
      process.emit('SIGINT');
      // Let both handlers settle.
      await new Promise((r) => setTimeout(r, 80));

      // First emits exit(0) after the slow close; second emits exit(1)
      // immediately. Order is deterministic given the setTimeout above.
      expect(exitCodes).toContain(1);
      dereg();
    });

    it('dereg removes the handlers', () => {
      const steps: ShutdownStep[] = [{ name: 'x', close: () => undefined }];
      const exitCodes: number[] = [];
      const dereg = registerSignalHandlers({
        logger: silentLogger(),
        steps,
        exit: (code) => void exitCodes.push(code),
      });
      dereg();
      process.emit('SIGTERM');
      // No handler left → exit hook not called. (Node's default
      // SIGTERM handler would kill the process, but only if ours has
      // been deregistered AND no other listeners; in jest, the test
      // runner has its own SIGTERM handlers which prevent termination.)
      expect(exitCodes).toEqual([]);
    });
  });
});
