/**
 * Density analysis — trust disclosure caveats for LLM responses.
 *
 * Classifies the data density behind a response into tiers:
 *   zero    — no vault data found for the query
 *   single  — only one source/item contributed
 *   sparse  — 2-3 items, possibly low confidence
 *   moderate — 4-9 items from multiple sources
 *   dense   — 10+ items, high confidence aggregate
 *
 * Based on density tier, appropriate caveats are prepended or appended
 * to the response so the user knows the data backing:
 *   - zero: "I don't have any stored information about this."
 *   - single: "Based on a single entry in your vault..."
 *   - sparse: "Based on limited data (N items)..."
 *   - moderate/dense: no caveat needed
 *
 * Source: brain/src/service/guardian.py — density analysis with trust disclosure
 */

import type { AssembledContext, ContextItem } from '../vault_context/assembly';

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export type DensityTier = 'zero' | 'single' | 'sparse' | 'moderate' | 'dense';

/** Per-entity density breakdown (e.g., "12 items about Emma, 0 about Sancho"). */
export interface EntityDensity {
  entity: string;
  count: number;
  tier: DensityTier;
}

export interface DensityAnalysis {
  tier: DensityTier;
  itemCount: number;
  uniquePersonas: number;
  averageScore: number;
  disclosure: string | null;
  /** Per-entity density breakdown for fine-grained trust assessment. */
  entities: EntityDensity[];
}

// ---------------------------------------------------------------
// Thresholds (matching Python guardian.py)
// ---------------------------------------------------------------

const SPARSE_MAX = 3;
const MODERATE_MAX = 9;

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Analyze the data density of vault context backing a response.
 *
 * Returns a tier classification and optional disclosure text.
 * The disclosure should be added to the response if non-null.
 */
export function analyzeDensity(context: AssembledContext): DensityAnalysis {
  const items = context.items;
  const count = items.length;

  if (count === 0) {
    return {
      tier: 'zero',
      itemCount: 0,
      uniquePersonas: 0,
      averageScore: 0,
      disclosure: null,
      entities: [],
    };
  }

  const uniquePersonas = new Set(items.map((i) => i.persona)).size;
  const averageScore = items.reduce((sum, i) => sum + i.score, 0) / count;
  const tier = classifyTier(count);
  const entities = computeEntityDensity(items);

  return {
    tier,
    itemCount: count,
    uniquePersonas,
    averageScore,
    disclosure: buildDisclosure(tier, count, averageScore),
    entities,
  };
}

/**
 * Compute per-entity density breakdown.
 *
 * Extracts entity names from context items (proper nouns in L0 headlines)
 * and counts how many items reference each entity. This enables disclosures
 * like "12 items about Emma, 0 about Sancho."
 */
export function computeEntityDensity(items: ContextItem[]): EntityDensity[] {
  const entityCounts = new Map<string, number>();

  for (const item of items) {
    const text = item.content_l0 || '';
    const names = extractEntityNames(text);
    for (const name of names) {
      entityCounts.set(name, (entityCounts.get(name) ?? 0) + 1);
    }
  }

  return [...entityCounts.entries()]
    .map(([entity, count]) => ({
      entity,
      count,
      tier: classifyTier(count),
    }))
    .sort((a, b) => b.count - a.count); // most-referenced first
}

/**
 * Extract proper noun entity names from text.
 *
 * Simple heuristic: capitalized words (2+ chars) that aren't sentence-starters.
 * Returns unique names found.
 */
function extractEntityNames(text: string): string[] {
  if (!text) return [];
  const names = new Set<string>();
  // Match capitalized words not at very start of text
  const pattern = /(?<=\s)([A-Z][a-z]{1,20})/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    names.add(match[1]);
  }
  return [...names];
}

/**
 * Classify count into density tier.
 */
export function classifyTier(itemCount: number): DensityTier {
  if (itemCount === 0) return 'zero';
  if (itemCount === 1) return 'single';
  if (itemCount <= SPARSE_MAX) return 'sparse';
  if (itemCount <= MODERATE_MAX) return 'moderate';
  return 'dense';
}

/**
 * Build a disclosure caveat string for the given tier.
 *
 * Returns null for moderate/dense (no caveat needed — sufficient data).
 * Returns a caveat string for zero/single/sparse.
 */
export function buildDisclosure(
  tier: DensityTier,
  itemCount: number,
  averageScore: number,
): string | null {
  switch (tier) {
    case 'zero':
      return null; // handled by the pipeline's "no information" response

    case 'single':
      return 'Note: This is based on a single entry in your vault. The information may be incomplete.';

    case 'sparse': {
      const qualifier = averageScore < 0.5 ? 'limited and loosely matched' : 'limited';
      return `Note: This is based on ${qualifier} data (${itemCount} items). Consider verifying from other sources.`;
    }

    case 'moderate':
    case 'dense':
      return null; // sufficient data — no caveat
  }
}

/**
 * Apply density disclosure to an answer.
 *
 * If disclosure is non-null, appends it after the answer with a separator.
 * Keeps the main answer clean and puts the caveat at the end.
 */
export function applyDisclosure(answer: string, density: DensityAnalysis): string {
  if (!density.disclosure) return answer;
  return `${answer}\n\n${density.disclosure}`;
}
