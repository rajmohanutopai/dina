/**
 * Task 4.87 — signal-safe DB close tests.
 */

import {
  DEFAULT_CHECKPOINT_TIMEOUT_MS,
  DEFAULT_CLOSE_TIMEOUT_MS,
  safeDbClose,
  type DatabaseHandle,
  type DbCloseEvent,
} from '../src/storage/db_close_guard';

class FakeDb implements DatabaseHandle {
  checkpointCalls = 0;
  closeCalls = 0;
  checkpointFn: () => Promise<void> = async () => undefined;
  closeFn: () => Promise<void> = async () => undefined;
  async checkpoint(): Promise<void> {
    this.checkpointCalls++;
    return this.checkpointFn();
  }
  async close(): Promise<void> {
    this.closeCalls++;
    return this.closeFn();
  }
}

describe('safeDbClose (task 4.87)', () => {
  describe('happy path', () => {
    it('runs checkpoint then close; returns both ok', async () => {
      const events: DbCloseEvent[] = [];
      const db = new FakeDb();
      const result = await safeDbClose({ handle: db, onEvent: (e) => events.push(e) });
      expect(result).toEqual({ checkpointOk: true, closeOk: true, errors: {} });
      expect(db.checkpointCalls).toBe(1);
      expect(db.closeCalls).toBe(1);
      expect(events.map((e) => e.kind)).toEqual([
        'stage_start',
        'stage_ok',
        'stage_start',
        'stage_ok',
      ]);
      const stages = events
        .filter((e) => e.kind === 'stage_start')
        .map((e) => (e as Extract<DbCloseEvent, { kind: 'stage_start' }>).stage);
      expect(stages).toEqual(['checkpoint', 'close']);
    });
  });

  describe('checkpoint failure', () => {
    it('checkpoint throws → close still runs (default closeOnCheckpointFail)', async () => {
      const db = new FakeDb();
      db.checkpointFn = async () => {
        throw new Error('WAL busy');
      };
      const events: DbCloseEvent[] = [];
      const result = await safeDbClose({ handle: db, onEvent: (e) => events.push(e) });
      expect(result.checkpointOk).toBe(false);
      expect(result.closeOk).toBe(true);
      expect(result.errors.checkpoint).toBe('WAL busy');
      expect(db.closeCalls).toBe(1);
      expect(events.some((e) => e.kind === 'stage_failed')).toBe(true);
    });

    it('closeOnCheckpointFail=false skips close after checkpoint failure', async () => {
      const db = new FakeDb();
      db.checkpointFn = async () => {
        throw new Error('WAL busy');
      };
      const result = await safeDbClose({
        handle: db,
        closeOnCheckpointFail: false,
      });
      expect(result.checkpointOk).toBe(false);
      expect(result.closeOk).toBe(false);
      expect(db.closeCalls).toBe(0);
    });
  });

  describe('close failure', () => {
    it('close throws → result.closeOk=false, checkpoint still succeeded', async () => {
      const db = new FakeDb();
      db.closeFn = async () => {
        throw new Error('file locked');
      };
      const result = await safeDbClose({ handle: db });
      expect(result.checkpointOk).toBe(true);
      expect(result.closeOk).toBe(false);
      expect(result.errors.close).toBe('file locked');
    });
  });

  describe('timeouts', () => {
    it('checkpoint timeout fires and close still runs', async () => {
      const db = new FakeDb();
      // Never-resolving checkpoint.
      db.checkpointFn = () => new Promise<void>(() => undefined);
      // Tiny timeouts + real setTimeout — test completes in <50ms either way.
      const events: DbCloseEvent[] = [];
      const result = await safeDbClose({
        handle: db,
        checkpointTimeoutMs: 10,
        closeTimeoutMs: 10,
        onEvent: (e) => events.push(e),
      });
      expect(result.checkpointOk).toBe(false);
      expect(result.closeOk).toBe(true);
      expect(result.errors.checkpoint).toMatch(/timeout after 10ms/);
      expect(
        events.some(
          (e) => e.kind === 'stage_timeout' && e.stage === 'checkpoint',
        ),
      ).toBe(true);
    });

    it('close timeout fires without blocking', async () => {
      const db = new FakeDb();
      db.closeFn = () => new Promise<void>(() => undefined);
      const result = await safeDbClose({
        handle: db,
        checkpointTimeoutMs: 10,
        closeTimeoutMs: 10,
      });
      expect(result.checkpointOk).toBe(true);
      expect(result.closeOk).toBe(false);
      expect(result.errors.close).toMatch(/timeout after 10ms/);
    });
  });

  describe('default budgets', () => {
    it('DEFAULT_CHECKPOINT_TIMEOUT_MS = 5000', () => {
      expect(DEFAULT_CHECKPOINT_TIMEOUT_MS).toBe(5_000);
    });
    it('DEFAULT_CLOSE_TIMEOUT_MS = 2000', () => {
      expect(DEFAULT_CLOSE_TIMEOUT_MS).toBe(2_000);
    });
  });

  describe('event stream ordering', () => {
    it('emits stage_start before stage_ok / stage_failed / stage_timeout', async () => {
      const events: DbCloseEvent[] = [];
      await safeDbClose({ handle: new FakeDb(), onEvent: (e) => events.push(e) });
      // stage_start → stage_ok → stage_start → stage_ok
      expect(events[0]).toMatchObject({ kind: 'stage_start', stage: 'checkpoint' });
      expect(events[1]).toMatchObject({ kind: 'stage_ok', stage: 'checkpoint' });
      expect(events[2]).toMatchObject({ kind: 'stage_start', stage: 'close' });
      expect(events[3]).toMatchObject({ kind: 'stage_ok', stage: 'close' });
    });
  });

  describe('validation', () => {
    it('rejects missing handle', async () => {
      await expect(
        safeDbClose({ handle: undefined as unknown as DatabaseHandle }),
      ).rejects.toThrow(/handle is required/);
    });
  });

  describe('injected clock', () => {
    it('stage_ok durationMs reflects nowMsFn', async () => {
      let now = 1_000_000;
      const events: DbCloseEvent[] = [];
      const db = new FakeDb();
      db.checkpointFn = async () => {
        now += 50; // simulate 50ms checkpoint
      };
      db.closeFn = async () => {
        now += 10; // simulate 10ms close
      };
      await safeDbClose({
        handle: db,
        nowMsFn: () => now,
        onEvent: (e) => events.push(e),
      });
      const cpOk = events.find(
        (e) => e.kind === 'stage_ok' && e.stage === 'checkpoint',
      ) as Extract<DbCloseEvent, { kind: 'stage_ok' }>;
      expect(cpOk.durationMs).toBe(50);
    });
  });
});
