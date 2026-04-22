/**
 * Tiered content loading — L0/L1/L2 progressive strategy.
 *
 * All results: L0 only (headline, low token cost)
 * Top N:       L0 + L1 (paragraph overview)
 * Top 1:       L0 + L1 + L2 (full body)
 *
 * Reduces prompt tokens from ~50K to ~5K for typical queries.
 *
 * Source: core/test/tiered_content_test.go
 */

export interface TieredItem {
  id: string;
  content_l0: string;
  content_l1?: string;
  body?: string;
  score: number;
}

export interface TieredLoadConfig {
  topNForL1: number;
  topNForL2: number;
}

const DEFAULT_CONFIG: TieredLoadConfig = { topNForL1: 5, topNForL2: 1 };

/**
 * Apply tiered loading to a ranked list of items.
 * Items should be pre-sorted by relevance (highest score first).
 */
export function applyTieredLoading(
  items: TieredItem[],
  config?: Partial<TieredLoadConfig>,
): TieredItem[] {
  const cfg: TieredLoadConfig = {
    topNForL1: config?.topNForL1 ?? DEFAULT_CONFIG.topNForL1,
    topNForL2: config?.topNForL2 ?? DEFAULT_CONFIG.topNForL2,
  };

  return items.map((item, index) => {
    const result: TieredItem = { id: item.id, content_l0: item.content_l0, score: item.score };
    if (index < cfg.topNForL1) result.content_l1 = item.content_l1;
    if (index < cfg.topNForL2) result.body = item.body;
    return result;
  });
}
