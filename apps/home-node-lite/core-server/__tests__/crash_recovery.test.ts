/**
 * Task 5.55 — CrashRecoveryOrchestrator tests.
 */

import {
  CrashRecoveryOrchestrator,
  DEFAULT_PARTICIPANT_TIMEOUT_MS,
  type CrashRecoveryEvent,
  type RestoreParticipant,
} from '../src/brain/crash_recovery';

function p(
  name: string,
  restore: () => Promise<{ recovered: number; detail: string }>,
): RestoreParticipant {
  return { name, restore };
}

describe('CrashRecoveryOrchestrator (task 5.55)', () => {
  describe('registration', () => {
    it('registers participants in order', () => {
      const o = new CrashRecoveryOrchestrator();
      o.register(p('a', async () => ({ recovered: 0, detail: '' })));
      o.register(p('b', async () => ({ recovered: 0, detail: '' })));
      expect(o.size()).toBe(2);
    });

    it('rejects duplicate names', () => {
      const o = new CrashRecoveryOrchestrator();
      o.register(p('a', async () => ({ recovered: 0, detail: '' })));
      expect(() =>
        o.register(p('a', async () => ({ recovered: 0, detail: '' }))),
      ).toThrow(/duplicate/);
    });

    it('rejects empty name', () => {
      const o = new CrashRecoveryOrchestrator();
      expect(() =>
        o.register({ name: '', restore: async () => ({ recovered: 0, detail: '' }) }),
      ).toThrow(/non-empty/);
    });

    it('rejects missing restore', () => {
      const o = new CrashRecoveryOrchestrator();
      expect(() =>
        o.register({ name: 'x' } as unknown as RestoreParticipant),
      ).toThrow(/restore/);
    });

    it('throws on registration after run()', async () => {
      const o = new CrashRecoveryOrchestrator();
      await o.run();
      expect(() =>
        o.register(p('late', async () => ({ recovered: 0, detail: '' }))),
      ).toThrow(/after run/);
    });
  });

  describe('happy path', () => {
    it('runs every participant + produces a structured report', async () => {
      const o = new CrashRecoveryOrchestrator();
      o.register(p('asks', async () => ({ recovered: 3, detail: '3 asks demoted' })));
      o.register(p('scratchpad', async () => ({ recovered: 1, detail: '1 stale clear' })));
      const report = await o.run();
      expect(report.okCount).toBe(2);
      expect(report.failedCount).toBe(0);
      expect(report.totalRecovered).toBe(4);
      expect(report.participants).toHaveLength(2);
      expect(report.participants[0]!.name).toBe('asks');
      expect(report.participants[0]!.recovered).toBe(3);
      expect(report.participants[1]!.name).toBe('scratchpad');
    });

    it('empty participant list → ok report with zero counts', async () => {
      const o = new CrashRecoveryOrchestrator();
      const report = await o.run();
      expect(report.okCount).toBe(0);
      expect(report.failedCount).toBe(0);
      expect(report.totalRecovered).toBe(0);
      expect(report.participants).toEqual([]);
    });

    it('fires started + participant_ok + finished events', async () => {
      const events: CrashRecoveryEvent[] = [];
      const o = new CrashRecoveryOrchestrator({ onEvent: (e) => events.push(e) });
      o.register(p('x', async () => ({ recovered: 1, detail: 'one' })));
      await o.run();
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(['started', 'participant_ok', 'finished']);
    });

    it('preserves registration order in report', async () => {
      const o = new CrashRecoveryOrchestrator();
      for (const name of ['first', 'second', 'third']) {
        o.register(p(name, async () => ({ recovered: 0, detail: '' })));
      }
      const report = await o.run();
      expect(report.participants.map((r) => r.name)).toEqual([
        'first',
        'second',
        'third',
      ]);
    });
  });

  describe('failure isolation', () => {
    it('one participant throwing does NOT abort the others', async () => {
      const seen: string[] = [];
      const o = new CrashRecoveryOrchestrator();
      o.register(
        p('a', async () => {
          seen.push('a');
          return { recovered: 1, detail: '' };
        }),
      );
      o.register(
        p('bad', async () => {
          seen.push('bad');
          throw new Error('backend unreachable');
        }),
      );
      o.register(
        p('c', async () => {
          seen.push('c');
          return { recovered: 2, detail: '' };
        }),
      );
      const report = await o.run();
      expect(seen).toEqual(['a', 'bad', 'c']);
      expect(report.okCount).toBe(2);
      expect(report.failedCount).toBe(1);
      expect(report.totalRecovered).toBe(3);
      const bad = report.participants.find((r) => r.name === 'bad')!;
      expect(bad.ok).toBe(false);
      expect(bad.detail).toMatch(/backend unreachable/);
    });

    it('failing participant contributes 0 to totalRecovered', async () => {
      const o = new CrashRecoveryOrchestrator();
      o.register(p('a', async () => ({ recovered: 5, detail: '' })));
      o.register(
        p('bad', async () => {
          throw new Error('x');
        }),
      );
      const report = await o.run();
      expect(report.totalRecovered).toBe(5);
    });

    it('fires participant_failed event with error message', async () => {
      const events: CrashRecoveryEvent[] = [];
      const o = new CrashRecoveryOrchestrator({ onEvent: (e) => events.push(e) });
      o.register(
        p('bad', async () => {
          throw new Error('oops');
        }),
      );
      await o.run();
      const failed = events.find(
        (e) => e.kind === 'participant_failed',
      ) as Extract<CrashRecoveryEvent, { kind: 'participant_failed' }>;
      expect(failed.error).toMatch(/oops/);
    });

    it('non-integer recovered count is treated as failure', async () => {
      const o = new CrashRecoveryOrchestrator();
      o.register(
        p('a', async () => ({
          recovered: 3.14 as unknown as number,
          detail: '',
        })),
      );
      const report = await o.run();
      expect(report.failedCount).toBe(1);
    });

    it('negative recovered count is treated as failure', async () => {
      const o = new CrashRecoveryOrchestrator();
      o.register(
        p('a', async () => ({ recovered: -5, detail: '' })),
      );
      const report = await o.run();
      expect(report.failedCount).toBe(1);
    });
  });

  describe('timeouts', () => {
    it('participant that exceeds timeout is marked failed', async () => {
      const o = new CrashRecoveryOrchestrator({ participantTimeoutMs: 20 });
      o.register(
        p('slow', () => new Promise(() => {})), // never resolves
      );
      o.register(p('fast', async () => ({ recovered: 1, detail: '' })));
      const report = await o.run();
      expect(report.failedCount).toBe(1);
      expect(report.okCount).toBe(1);
      const slow = report.participants.find((r) => r.name === 'slow')!;
      expect(slow.ok).toBe(false);
      expect(slow.detail).toMatch(/timed out/);
    });

    it('participantTimeoutMs=0 disables the timeout', async () => {
      const o = new CrashRecoveryOrchestrator({ participantTimeoutMs: 0 });
      o.register(
        p(
          'slow',
          () =>
            new Promise((r) =>
              setTimeout(() => r({ recovered: 1, detail: '' }), 30),
            ),
        ),
      );
      const report = await o.run();
      expect(report.okCount).toBe(1);
    });

    it('DEFAULT_PARTICIPANT_TIMEOUT_MS is 30s', () => {
      expect(DEFAULT_PARTICIPANT_TIMEOUT_MS).toBe(30_000);
    });
  });

  describe('one-shot guarantee', () => {
    it('second run() throws', async () => {
      const o = new CrashRecoveryOrchestrator();
      await o.run();
      await expect(o.run()).rejects.toThrow(/already called/);
    });
  });

  describe('realistic brain boot', () => {
    it('orchestrates ask + scratchpad restore with structured report', async () => {
      const orch = new CrashRecoveryOrchestrator();
      orch.register(
        p('ask-registry', async () => ({
          recovered: 7,
          detail: '7 in-flight asks demoted to pending',
        })),
      );
      orch.register(
        p('scratchpad-sweeper', async () => ({
          recovered: 2,
          detail: '2 expired checkpoints cleared',
        })),
      );
      const report = await orch.run();
      expect(report.okCount).toBe(2);
      expect(report.totalRecovered).toBe(9);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
