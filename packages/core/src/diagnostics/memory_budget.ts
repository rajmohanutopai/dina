/**
 * Memory budget tracker — enforce RAM budgets for key components.
 *
 * Budgets:
 *   - HNSW index: < 50 MB for 10K items
 *   - Total app: < 200 MB
 *   - Vault cache per persona: < 20 MB
 *   - Thread history: < 5 MB
 *
 * The tracker collects size estimates from each component and
 * compares against budgets. In production, actual sizes come from
 * the native memory profiler; this module provides the budget
 * definitions and comparison logic.
 *
 * Source: ARCHITECTURE.md Task 10.12
 */

export interface MemoryBudget {
  name: string;
  budgetMB: number;
  currentMB: number;
  withinBudget: boolean;
  usagePercent: number;
}

export interface MemoryReport {
  totalMB: number;
  totalBudgetMB: number;
  withinBudget: boolean;
  components: MemoryBudget[];
  timestamp: number;
}

/** Budget definitions in MB. */
const BUDGETS: Record<string, number> = {
  hnsw_index: 50,
  app_total: 200,
  vault_cache: 20,
  thread_history: 5,
  staging_inbox: 10,
  trust_cache: 2,
};

/** Injectable size estimators — each returns current usage in MB. */
const estimators = new Map<string, () => number>();

/**
 * Register a memory size estimator for a component.
 */
export function registerEstimator(name: string, estimator: () => number): void {
  if (!(name in BUDGETS)) {
    throw new Error(`memory_budget: unknown component "${name}" — add to BUDGETS first`);
  }
  estimators.set(name, estimator);
}

/**
 * Run a memory budget check across all registered components.
 */
export function checkBudgets(): MemoryReport {
  const components: MemoryBudget[] = [];
  let totalMB = 0;

  for (const [name, budgetMB] of Object.entries(BUDGETS)) {
    const estimator = estimators.get(name);
    const currentMB = estimator ? estimator() : 0;
    totalMB += currentMB;

    components.push({
      name,
      budgetMB,
      currentMB,
      withinBudget: currentMB <= budgetMB,
      usagePercent: budgetMB > 0 ? Math.round((currentMB / budgetMB) * 100) : 0,
    });
  }

  return {
    totalMB,
    totalBudgetMB: BUDGETS.app_total,
    withinBudget: totalMB <= BUDGETS.app_total && components.every((c) => c.withinBudget),
    components,
    timestamp: Date.now(),
  };
}

/**
 * Check a single component's budget.
 */
export function checkComponent(name: string): MemoryBudget | null {
  const budgetMB = BUDGETS[name];
  if (budgetMB === undefined) return null;

  const estimator = estimators.get(name);
  const currentMB = estimator ? estimator() : 0;

  return {
    name,
    budgetMB,
    currentMB,
    withinBudget: currentMB <= budgetMB,
    usagePercent: budgetMB > 0 ? Math.round((currentMB / budgetMB) * 100) : 0,
  };
}

/**
 * Get budget definitions for display.
 */
export function getBudgets(): Record<string, number> {
  return { ...BUDGETS };
}

/**
 * Estimate HNSW index memory usage.
 *
 * Formula: items × dimensions × 4 bytes × overhead_factor (graph links)
 * For M=16, overhead ≈ 1.5x (each node stores M neighbor pointers per layer)
 */
export function estimateHNSWMemory(itemCount: number, dimensions: number, M: number = 16): number {
  const vectorBytes = itemCount * dimensions * 4;
  const graphOverhead = itemCount * M * 2 * 8; // 2 layers avg, 8 bytes per pointer
  const totalBytes = vectorBytes + graphOverhead;
  return totalBytes / (1024 * 1024); // convert to MB
}

/**
 * Reset (for testing).
 */
export function resetMemoryBudgets(): void {
  estimators.clear();
}
