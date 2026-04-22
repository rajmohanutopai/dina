/**
 * T10.11 — Startup performance benchmark.
 *
 * Tests the benchmark infrastructure and verifies that a simulated
 * boot sequence completes within budget.
 *
 * Source: ARCHITECTURE.md Task 10.11
 */

import {
  StartupBenchmark,
  benchmarkBootSequence,
  type BenchmarkResult,
} from '../../src/diagnostics/startup_bench';

describe('Startup Performance Benchmark (10.11)', () => {
  describe('StartupBenchmark class', () => {
    it('times individual steps', () => {
      const bench = new StartupBenchmark();
      bench.begin();

      bench.timeSync('step_a', () => {
        let x = 0;
        for (let i = 0; i < 1000; i++) x += i;
        return x;
      });

      bench.timeSync('step_b', () => 42);

      const result = bench.finish();

      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].name).toBe('step_a');
      expect(result.steps[1].name).toBe('step_b');
      expect(result.steps[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(result.totalMs).toBeGreaterThanOrEqual(0);
    });

    it('times async operations', async () => {
      const bench = new StartupBenchmark();
      bench.begin();

      await bench.timeAsync('async_step', async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      const result = bench.finish();
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].name).toBe('async_step');
      expect(result.steps[0].durationMs).toBeGreaterThanOrEqual(5);
    });

    it('returns result value from timeSync', () => {
      const bench = new StartupBenchmark();
      bench.begin();
      const value = bench.timeSync('compute', () => 42);
      expect(value).toBe(42);
    });

    it('returns result value from timeAsync', async () => {
      const bench = new StartupBenchmark();
      bench.begin();
      const value = await bench.timeAsync('compute', async () => 'hello');
      expect(value).toBe('hello');
    });

    it('auto-closes previous step on new step', () => {
      const bench = new StartupBenchmark();
      bench.begin();

      bench.startStep('a');
      bench.startStep('b'); // auto-closes 'a'
      bench.endStep();

      const result = bench.finish();
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].name).toBe('a');
      expect(result.steps[1].name).toBe('b');
    });

    it('reports withinBudget correctly', () => {
      const bench = new StartupBenchmark(10_000); // 10s budget
      bench.begin();
      bench.timeSync('fast', () => {});
      const result = bench.finish();

      expect(result.withinBudget).toBe(true);
      expect(result.budgetMs).toBe(10_000);
    });

    it('detects over-budget', async () => {
      const bench = new StartupBenchmark(1); // 1ms budget — will exceed
      bench.begin();
      await bench.timeAsync('slow', () => new Promise((r) => setTimeout(r, 10)));
      const result = bench.finish();

      expect(result.withinBudget).toBe(false);
    });

    it('getBreakdown returns sorted by duration', () => {
      const bench = new StartupBenchmark();
      bench.begin();
      bench.timeSync('fast', () => {});
      bench.timeSync('slow', () => {
        let x = 0;
        for (let i = 0; i < 100000; i++) x += i;
      });
      bench.timeSync('medium', () => {
        let x = 0;
        for (let i = 0; i < 10000; i++) x += i;
      });

      const breakdown = bench.getBreakdown();
      expect(breakdown).toHaveLength(3);
      // Sorted descending by duration
      expect(breakdown[0].durationMs).toBeGreaterThanOrEqual(breakdown[1].durationMs);
      expect(breakdown[1].durationMs).toBeGreaterThanOrEqual(breakdown[2].durationMs);
      // Percentages should sum to <= 100 (gaps between steps reduce the sum)
      const totalPct = breakdown.reduce((sum, b) => sum + b.percentage, 0);
      expect(totalPct).toBeLessThanOrEqual(101);
      expect(totalPct).toBeGreaterThan(0);
    });

    it('getSlowestStep returns the bottleneck', async () => {
      const bench = new StartupBenchmark();
      bench.begin();
      bench.timeSync('fast', () => {});
      await bench.timeAsync('bottleneck', () => new Promise((r) => setTimeout(r, 15)));
      bench.timeSync('fast2', () => {});

      const slowest = bench.getSlowestStep();
      expect(slowest).not.toBeNull();
      expect(slowest!.name).toBe('bottleneck');
    });

    it('getSlowestStep returns null for empty benchmark', () => {
      const bench = new StartupBenchmark();
      expect(bench.getSlowestStep()).toBeNull();
    });

    it('stepCount tracks number of steps', () => {
      const bench = new StartupBenchmark();
      bench.begin();
      bench.timeSync('a', () => {});
      bench.timeSync('b', () => {});
      bench.timeSync('c', () => {});
      expect(bench.stepCount).toBe(3);
    });
  });

  describe('benchmarkBootSequence', () => {
    it('runs all 7 boot steps and returns timing', async () => {
      const result = await benchmarkBootSequence({
        deriveKEK: async () => {},
        unwrapSeed: async () => {},
        deriveIdentityDEK: () => {},
        derivePersonaDEKs: () => {},
        openVaults: async () => {},
        buildHNSW: async () => {},
        bootPersonas: () => {},
      });

      expect(result.steps).toHaveLength(7);
      expect(result.steps.map((s) => s.name)).toEqual([
        'argon2id_kek',
        'unwrap_seed',
        'identity_dek',
        'persona_deks',
        'open_vaults',
        'build_hnsw',
        'boot_personas',
      ]);
      expect(result.totalMs).toBeGreaterThanOrEqual(0);
      expect(result.withinBudget).toBe(true); // no-op steps are instant
    });

    it('detects when boot exceeds budget', async () => {
      const result = await benchmarkBootSequence(
        {
          deriveKEK: () => new Promise((r) => setTimeout(r, 10)),
          unwrapSeed: async () => {},
          deriveIdentityDEK: () => {},
          derivePersonaDEKs: () => {},
          openVaults: async () => {},
          buildHNSW: async () => {},
          bootPersonas: () => {},
        },
        1,
      ); // 1ms budget — will fail

      expect(result.withinBudget).toBe(false);
    });

    it('identifies the slowest boot step', async () => {
      const result = await benchmarkBootSequence({
        deriveKEK: () => new Promise((r) => setTimeout(r, 20)),
        unwrapSeed: async () => {},
        deriveIdentityDEK: () => {},
        derivePersonaDEKs: () => {},
        openVaults: async () => {},
        buildHNSW: async () => {},
        bootPersonas: () => {},
      });

      const slowest = result.steps.sort((a, b) => b.durationMs - a.durationMs)[0];
      expect(slowest.name).toBe('argon2id_kek');
    });
  });
});
