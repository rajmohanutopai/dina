/**
 * Curated top-level budget categories (TN-V2-CTX-003).
 *
 * The user sets a per-category budget tier — `$` / `$$` / `$$$` —
 * which drives V2 actionability filtering on subjects in that
 * category. Categories where price doesn't vary meaningfully (or
 * doesn't apply at all) are excluded; the goal is "actionable
 * filter knobs", not "every subject taxonomy node".
 *
 * Categories are slash-delimited paths matching `subjects.category`
 * (Plan §3.6.1). The budget screen uses ONLY the top-level segment;
 * subcategories inherit. (A user setting `electronics: $$` filters
 * `electronics/laptop` AND `electronics/phone` — the inheritance is
 * applied by the ranker, not stored expanded.)
 *
 * The list is curated rather than user-extensible at V1 because:
 *   - Adding "+ custom category" UI is a separate feature.
 *   - The ranker only consumes a fixed set of well-known categories
 *     anyway; arbitrary user-defined tags would no-op.
 *   - 12 categories cover ≥95% of the budget-relevant subject
 *     taxonomy in early-V2 traffic.
 *
 * Order: most-purchased to least, roughly. Keeps the highest-leverage
 * settings near the top of the screen so the median user finds
 * what they care about without scrolling.
 */

export interface BudgetCategory {
  /** The persisted key — matches `subjects.category` top-level segment. */
  readonly key: string;
  /** Display label for the row. */
  readonly label: string;
  /** Optional secondary text — clarifies scope when the label is ambiguous. */
  readonly description?: string;
}

export const BUDGET_CATEGORIES: ReadonlyArray<BudgetCategory> = Object.freeze([
  {
    key: 'food',
    label: 'Food & dining',
    description: 'Restaurants, cafes, food delivery',
  },
  {
    key: 'groceries',
    label: 'Groceries',
    description: 'Supermarkets, produce, pantry',
  },
  {
    key: 'electronics',
    label: 'Electronics',
    description: 'Phones, laptops, accessories',
  },
  {
    key: 'home',
    label: 'Home',
    description: 'Furniture, appliances, decor',
  },
  {
    key: 'clothing',
    label: 'Clothing',
    description: 'Apparel, shoes, accessories',
  },
  {
    key: 'travel',
    label: 'Travel',
    description: 'Lodging, flights, transport',
  },
  {
    key: 'books',
    label: 'Books & media',
    description: 'Books, magazines, courses',
  },
  {
    key: 'health',
    label: 'Health',
    description: 'Supplements, wellness, fitness',
  },
  {
    key: 'beauty',
    label: 'Beauty',
    description: 'Cosmetics, skincare, personal care',
  },
  {
    key: 'services',
    label: 'Services',
    description: 'Professional services, repairs',
  },
]);

/** Lookup map for fast validity checks. */
export const BUDGET_CATEGORY_KEYS: ReadonlySet<string> = new Set(
  BUDGET_CATEGORIES.map((c) => c.key),
);
