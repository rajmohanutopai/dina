/**
 * T1G.2 — Tiered content loading (L0/L1/L2 progressive strategy).
 *
 * Source: core/test/tiered_content_test.go
 */

import { applyTieredLoading } from '../../src/vault/tiered_content';
import type { TieredItem } from '../../src/vault/tiered_content';

describe('Tiered Content Loading', () => {
  function makeItems(n: number): TieredItem[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `item-${i}`,
      content_l0: `L0 summary for item ${i}`,
      content_l1: `L1 paragraph for item ${i}`,
      body: `Full body for item ${i}`,
      score: 1.0 - i * 0.1,
    }));
  }

  it('returns all items with L0', () => {
    const result = applyTieredLoading(makeItems(10));
    expect(result.length).toBe(10);
    for (const item of result) {
      expect(item.content_l0).toBeTruthy();
    }
  });

  it('top 5 items include L1 (default config)', () => {
    const result = applyTieredLoading(makeItems(10));
    for (let i = 0; i < 5; i++) {
      expect(result[i].content_l1).toBeTruthy();
    }
  });

  it('top 1 item includes full body (default config)', () => {
    const result = applyTieredLoading(makeItems(10));
    expect(result[0].body).toBeTruthy();
  });

  it('items beyond top 5 have L1 stripped', () => {
    const result = applyTieredLoading(makeItems(10));
    for (let i = 5; i < 10; i++) {
      expect(result[i].content_l1).toBeUndefined();
    }
  });

  it('items beyond top 1 have body stripped', () => {
    const result = applyTieredLoading(makeItems(10));
    for (let i = 1; i < 10; i++) {
      expect(result[i].body).toBeUndefined();
    }
  });

  it('respects custom topNForL1 config', () => {
    const result = applyTieredLoading(makeItems(10), { topNForL1: 3 });
    expect(result[2].content_l1).toBeTruthy();
    expect(result[3].content_l1).toBeUndefined();
  });

  it('respects custom topNForL2 config', () => {
    const result = applyTieredLoading(makeItems(10), { topNForL2: 2 });
    expect(result[0].body).toBeTruthy();
    expect(result[1].body).toBeTruthy();
    expect(result[2].body).toBeUndefined();
  });

  it('handles empty items list', () => {
    expect(applyTieredLoading([])).toEqual([]);
  });

  it('handles single item (gets all tiers)', () => {
    const result = applyTieredLoading(makeItems(1));
    expect(result[0].content_l0).toBeTruthy();
    expect(result[0].content_l1).toBeTruthy();
    expect(result[0].body).toBeTruthy();
  });

  it('preserves item order (sorted by score)', () => {
    const result = applyTieredLoading(makeItems(5));
    for (let i = 0; i < 4; i++) {
      expect(result[i].score).toBeGreaterThan(result[i + 1].score);
    }
  });
});
