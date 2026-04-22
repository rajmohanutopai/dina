/**
 * Startup performance benchmark — measure boot time components.
 *
 * Target: passphrase entry → chat ready in < 3 seconds.
 *
 * Breakdown:
 *   1. Argon2id KEK derivation (passphrase → KEK)
 *   2. Seed unwrap (AES-256-GCM decrypt)
 *   3. Identity DEK derivation (HKDF-SHA256)
 *   4. Persona DEK derivation (HKDF per persona)
 *   5. Vault open (SQLCipher per persona)
 *   6. HNSW index build (per persona with embeddings)
 *   7. Boot persona auto-open (default + standard)
 *
 * Each step is timed independently. The total is the critical metric.
 *
 * Source: ARCHITECTURE.md Task 10.11
 */

export interface TimingEntry {
  name: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface BenchmarkResult {
  totalMs: number;
  steps: TimingEntry[];
  withinBudget: boolean;
  budgetMs: number;
}

const DEFAULT_BUDGET_MS = 3000; // 3 seconds

export class StartupBenchmark {
  private readonly steps: TimingEntry[] = [];
  private readonly budgetMs: number;
  private startTime: number = 0;
  private currentStep: { name: string; startMs: number } | null = null;

  constructor(budgetMs?: number) {
    this.budgetMs = budgetMs ?? DEFAULT_BUDGET_MS;
  }

  /** Begin the overall benchmark. */
  begin(): void {
    this.startTime = now();
    this.steps.length = 0;
    this.currentStep = null;
  }

  /** Start timing a named step. */
  startStep(name: string): void {
    if (this.currentStep) {
      this.endStep(); // auto-close previous
    }
    this.currentStep = { name, startMs: now() };
  }

  /** End the current step. */
  endStep(): void {
    if (!this.currentStep) return;
    const endMs = now();
    this.steps.push({
      name: this.currentStep.name,
      startMs: this.currentStep.startMs,
      endMs,
      durationMs: endMs - this.currentStep.startMs,
    });
    this.currentStep = null;
  }

  /** Time an async operation as a named step. */
  async timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    this.startStep(name);
    try {
      return await fn();
    } finally {
      this.endStep();
    }
  }

  /** Time a sync operation as a named step. */
  timeSync<T>(name: string, fn: () => T): T {
    this.startStep(name);
    try {
      return fn();
    } finally {
      this.endStep();
    }
  }

  /** Finalize and return the result. */
  finish(): BenchmarkResult {
    if (this.currentStep) this.endStep();

    const totalMs = now() - this.startTime;
    return {
      totalMs,
      steps: [...this.steps],
      withinBudget: totalMs <= this.budgetMs,
      budgetMs: this.budgetMs,
    };
  }

  /** Get step durations as a sorted breakdown. */
  getBreakdown(): Array<{ name: string; durationMs: number; percentage: number }> {
    const result = this.finish();
    return result.steps
      .map((s) => ({
        name: s.name,
        durationMs: s.durationMs,
        percentage: result.totalMs > 0 ? (s.durationMs / result.totalMs) * 100 : 0,
      }))
      .sort((a, b) => b.durationMs - a.durationMs);
  }

  /** Get the slowest step. */
  getSlowestStep(): TimingEntry | null {
    if (this.steps.length === 0) return null;
    return [...this.steps].sort((a, b) => b.durationMs - a.durationMs)[0];
  }

  /** Get total step count. */
  get stepCount(): number {
    return this.steps.length;
  }
}

/**
 * Run a standard boot sequence benchmark.
 *
 * Uses injectable functions for each step so it works in tests
 * without native modules.
 */
export async function benchmarkBootSequence(
  steps: {
    deriveKEK: () => Promise<void>;
    unwrapSeed: () => Promise<void>;
    deriveIdentityDEK: () => void;
    derivePersonaDEKs: () => void;
    openVaults: () => Promise<void>;
    buildHNSW: () => Promise<void>;
    bootPersonas: () => void;
  },
  budgetMs?: number,
): Promise<BenchmarkResult> {
  const bench = new StartupBenchmark(budgetMs);
  bench.begin();

  await bench.timeAsync('argon2id_kek', steps.deriveKEK);
  await bench.timeAsync('unwrap_seed', steps.unwrapSeed);
  bench.timeSync('identity_dek', steps.deriveIdentityDEK);
  bench.timeSync('persona_deks', steps.derivePersonaDEKs);
  await bench.timeAsync('open_vaults', steps.openVaults);
  await bench.timeAsync('build_hnsw', steps.buildHNSW);
  bench.timeSync('boot_personas', steps.bootPersonas);

  return bench.finish();
}

/** High-resolution timestamp in milliseconds. */
function now(): number {
  return performance.now();
}
