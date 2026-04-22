/**
 * T10.12 — Performance memory: budget tracking tests.
 *
 * Source: ARCHITECTURE.md Task 10.12
 */

import {
  registerEstimator,
  checkBudgets,
  checkComponent,
  getBudgets,
  estimateHNSWMemory,
  resetMemoryBudgets,
} from '../../src/diagnostics/memory_budget';

describe('Memory Budget Tracker (10.12)', () => {
  beforeEach(() => resetMemoryBudgets());

  describe('budget definitions', () => {
    it('defines budgets for all key components', () => {
      const budgets = getBudgets();
      expect(budgets.hnsw_index).toBe(50);
      expect(budgets.app_total).toBe(200);
      expect(budgets.vault_cache).toBe(20);
      expect(budgets.thread_history).toBe(5);
      expect(budgets.staging_inbox).toBe(10);
      expect(budgets.trust_cache).toBe(2);
    });
  });

  describe('checkBudgets', () => {
    it('returns healthy when all under budget', () => {
      registerEstimator('hnsw_index', () => 30);
      registerEstimator('vault_cache', () => 10);
      registerEstimator('thread_history', () => 2);

      const report = checkBudgets();

      expect(report.withinBudget).toBe(true);
      expect(report.totalMB).toBe(42);
      expect(report.totalBudgetMB).toBe(200);
      expect(report.components.length).toBeGreaterThanOrEqual(6);
    });

    it('detects over-budget component', () => {
      registerEstimator('hnsw_index', () => 60); // over 50 MB budget

      const report = checkBudgets();

      expect(report.withinBudget).toBe(false);
      const hnsw = report.components.find((c) => c.name === 'hnsw_index');
      expect(hnsw!.withinBudget).toBe(false);
      expect(hnsw!.usagePercent).toBe(120);
    });

    it('detects over total budget', () => {
      registerEstimator('hnsw_index', () => 50);
      registerEstimator('vault_cache', () => 20);
      registerEstimator('thread_history', () => 5);
      registerEstimator('staging_inbox', () => 10);
      registerEstimator('trust_cache', () => 2);
      // total = 87, well under 200. But if we add 120 more...

      // Register a large hnsw to push total over
      resetMemoryBudgets();
      registerEstimator('hnsw_index', () => 45);
      registerEstimator('vault_cache', () => 160); // over budget

      const report = checkBudgets();
      expect(report.withinBudget).toBe(false);
    });

    it('returns 0 for unregistered estimators', () => {
      const report = checkBudgets();
      const hnsw = report.components.find((c) => c.name === 'hnsw_index');
      expect(hnsw!.currentMB).toBe(0);
      expect(hnsw!.withinBudget).toBe(true);
    });

    it('includes timestamp', () => {
      const before = Date.now();
      const report = checkBudgets();
      expect(report.timestamp).toBeGreaterThanOrEqual(before);
    });
  });

  describe('checkComponent', () => {
    it('checks a single component', () => {
      registerEstimator('hnsw_index', () => 30);
      const result = checkComponent('hnsw_index');

      expect(result).not.toBeNull();
      expect(result!.currentMB).toBe(30);
      expect(result!.budgetMB).toBe(50);
      expect(result!.withinBudget).toBe(true);
      expect(result!.usagePercent).toBe(60);
    });

    it('returns null for unknown component', () => {
      expect(checkComponent('nonexistent')).toBeNull();
    });
  });

  describe('estimateHNSWMemory', () => {
    it('estimates memory for 10K items at 768 dims', () => {
      const mb = estimateHNSWMemory(10_000, 768);

      // 10K × 768 × 4 = 30.72 MB vectors + graph overhead
      expect(mb).toBeGreaterThan(29);
      expect(mb).toBeLessThan(50); // must be under budget
    });

    it('estimates memory for 1K items (small vault)', () => {
      const mb = estimateHNSWMemory(1_000, 768);
      expect(mb).toBeLessThan(10);
    });

    it('estimates memory for 50K items (large vault)', () => {
      const mb = estimateHNSWMemory(50_000, 768);
      expect(mb).toBeGreaterThan(100); // over budget — would need pruning
    });

    it('10K items at 768 dims stays under 50 MB budget', () => {
      const mb = estimateHNSWMemory(10_000, 768, 16);
      expect(mb).toBeLessThanOrEqual(50);
    });
  });

  describe('registerEstimator', () => {
    it('rejects unknown component name', () => {
      expect(() => registerEstimator('unknown', () => 0)).toThrow('unknown component');
    });
  });
});
