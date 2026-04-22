/**
 * Task 4.11 — crash-log writer tests.
 *
 * Exercises `installCrashLogHandlers` by emitting the top-level
 * process events programmatically. Exit is injected so the test
 * runner doesn't actually terminate.
 */

import { pino } from 'pino';
import {
  InMemoryCrashLogWriter,
  installCrashLogHandlers,
  type CrashEntry,
} from '../src/crash_log';

function silentLogger() {
  return pino({ level: 'silent' });
}

async function settle(): Promise<void> {
  // Two microtask flushes + one macrotask to let `setTimeout(..., 0).unref()`
  // resolve even with flushMs=0 in tests.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 10));
}

describe('crash-log writer (task 4.11)', () => {
  describe('InMemoryCrashLogWriter', () => {
    it('records entries in order', () => {
      const w = new InMemoryCrashLogWriter();
      w.write({
        at: '2026-04-21T00:00:00Z',
        kind: 'uncaughtException',
        message: 'a',
        processStartMs: 0,
      });
      w.write({
        at: '2026-04-21T00:00:01Z',
        kind: 'unhandledRejection',
        message: 'b',
        processStartMs: 0,
      });
      expect(w.entries.map((e) => e.message)).toEqual(['a', 'b']);
    });
  });

  describe('installCrashLogHandlers', () => {
    it('uncaughtException → writes entry + calls exit(2)', async () => {
      const w = new InMemoryCrashLogWriter();
      const exits: number[] = [];
      const dereg = installCrashLogHandlers({
        logger: silentLogger(),
        writer: w,
        exit: (code) => void exits.push(code),
        flushTimeoutMs: 0,
      });

      process.emit('uncaughtException', new Error('boom'));
      await settle();

      expect(w.entries.length).toBe(1);
      const entry = w.entries[0] as CrashEntry;
      expect(entry.kind).toBe('uncaughtException');
      expect(entry.message).toBe('boom');
      expect(entry.stack).toBeDefined();
      expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(exits).toEqual([2]);

      dereg();
    });

    it('unhandledRejection with Error reason → writes + exits', async () => {
      const w = new InMemoryCrashLogWriter();
      const exits: number[] = [];
      const dereg = installCrashLogHandlers({
        logger: silentLogger(),
        writer: w,
        exit: (code) => void exits.push(code),
        flushTimeoutMs: 0,
      });

      // Simulate an unhandled rejection via the emitter (same signature).
      process.emit('unhandledRejection', new Error('async fail'), Promise.resolve());
      await settle();

      expect(w.entries.length).toBe(1);
      expect(w.entries[0]?.kind).toBe('unhandledRejection');
      expect(w.entries[0]?.message).toBe('async fail');
      expect(exits).toEqual([2]);

      dereg();
    });

    it('handles non-Error rejection reason (string)', async () => {
      const w = new InMemoryCrashLogWriter();
      const dereg = installCrashLogHandlers({
        logger: silentLogger(),
        writer: w,
        exit: () => undefined,
        flushTimeoutMs: 0,
      });

      process.emit(
        'unhandledRejection',
        'raw string reason',
        Promise.resolve(),
      );
      await settle();

      expect(w.entries[0]?.message).toBe('raw string reason');
      expect(w.entries[0]?.stack).toBeUndefined();
      dereg();
    });

    it('handles non-Error rejection reason (plain object, JSON-able)', async () => {
      const w = new InMemoryCrashLogWriter();
      const dereg = installCrashLogHandlers({
        logger: silentLogger(),
        writer: w,
        exit: () => undefined,
        flushTimeoutMs: 0,
      });

      process.emit('unhandledRejection', { foo: 'bar' }, Promise.resolve());
      await settle();

      expect(w.entries[0]?.message).toBe('{"foo":"bar"}');
      dereg();
    });

    it('extracts err.code (e.g. ENOTFOUND) into the entry', async () => {
      const w = new InMemoryCrashLogWriter();
      const dereg = installCrashLogHandlers({
        logger: silentLogger(),
        writer: w,
        exit: () => undefined,
        flushTimeoutMs: 0,
      });

      const err = new Error('resolve failed') as Error & { code?: string };
      err.code = 'ENOTFOUND';
      process.emit('uncaughtException', err);
      await settle();

      expect(w.entries[0]?.code).toBe('ENOTFOUND');
      dereg();
    });

    it('still exits even if the writer throws', async () => {
      const failingWriter = {
        write: () => {
          throw new Error('disk full');
        },
      };
      const exits: number[] = [];
      const dereg = installCrashLogHandlers({
        logger: silentLogger(),
        writer: failingWriter,
        exit: (code) => void exits.push(code),
        flushTimeoutMs: 0,
      });

      process.emit('uncaughtException', new Error('original'));
      await settle();

      expect(exits).toEqual([2]);
      dereg();
    });

    it('dereg removes both trap handlers', async () => {
      const w = new InMemoryCrashLogWriter();
      const dereg = installCrashLogHandlers({
        logger: silentLogger(),
        writer: w,
        exit: () => undefined,
        flushTimeoutMs: 0,
      });
      dereg();

      // After dereg, a trap no longer writes.
      process.emit('uncaughtException', new Error('post-dereg'));
      await settle();
      expect(w.entries.length).toBe(0);
    });

    it('entry.processStartMs is consistent across traps', async () => {
      const w = new InMemoryCrashLogWriter();
      const dereg = installCrashLogHandlers({
        logger: silentLogger(),
        writer: w,
        exit: () => undefined,
        flushTimeoutMs: 0,
      });

      process.emit('uncaughtException', new Error('first'));
      await settle();
      process.emit('uncaughtException', new Error('second'));
      await settle();

      expect(w.entries.length).toBe(2);
      expect(w.entries[0]?.processStartMs).toBe(w.entries[1]?.processStartMs);
      dereg();
    });
  });
});
