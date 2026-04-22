/**
 * Prompt budgeter — token-aware section packing for LLM prompts.
 *
 * `vault_context.ts` uses a CHAR budget — cheap + OK when the
 * downstream LLM doesn't really care. For production LLM calls we
 * need a real token budget so a long query doesn't blow past the
 * model's context window. This primitive is the token-aware packer.
 *
 * **Inputs**:
 *
 *   - `maxTokens`  — hard ceiling on the combined prompt.
 *   - `sections`   — ordered list of `{id, text, required?, priority?}`.
 *   - `estimator`  — function `text → estimated tokens`. Injectable
 *                    so callers can swap in a real tokenizer (tiktoken
 *                    via WASM) or a cheap heuristic (chars / 4).
 *
 * **Algorithm**:
 *
 *   1. Keep every `required: true` section — if their combined
 *      estimate exceeds `maxTokens`, return `over_budget_required`.
 *   2. Fit remaining sections in input order (priority desc when tied
 *      on ordering) until we'd exceed `maxTokens`.
 *   3. Return `{included, dropped, totalTokens, truncated}`.
 *
 * **Pure** — no IO. Estimator is deterministic under the caller's
 * control.
 *
 * **Default estimator** — `defaultTokenEstimator(text)` = ceil(len /
 * 4). GPT-family tokens average ~4 chars per token for English. Not
 * accurate but cheap + stable for budgeting heuristics.
 */

export interface PromptSection {
  id: string;
  text: string;
  /** When true, MUST be included (or planner fails). Default false. */
  required?: boolean;
  /**
   * Higher values preferred when discretionary sections compete.
   * Default 0. Ties break by input order.
   */
  priority?: number;
}

export interface PromptBudgetInput {
  maxTokens: number;
  sections: ReadonlyArray<PromptSection>;
  estimator?: (text: string) => number;
  /** Reserve headroom (subtract from maxTokens before packing). Default 0. */
  reserveTokens?: number;
}

export interface PackedSection {
  id: string;
  text: string;
  tokens: number;
  required: boolean;
  priority: number;
}

export interface PromptBudgetSuccess {
  ok: true;
  included: PackedSection[];
  dropped: PackedSection[];
  totalTokens: number;
  /** True when at least one section dropped due to budget. */
  truncated: boolean;
}

export interface PromptBudgetFailure {
  ok: false;
  reason: 'over_budget_required';
  requiredTokens: number;
  effectiveMaxTokens: number;
  /** The required sections that forced the overshoot. */
  required: PackedSection[];
}

export type PromptBudgetOutcome = PromptBudgetSuccess | PromptBudgetFailure;

export class PromptBudgetError extends Error {
  constructor(
    public readonly code:
      | 'invalid_max'
      | 'invalid_reserve'
      | 'invalid_section'
      | 'duplicate_id',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'PromptBudgetError';
  }
}

/** Default estimator: ceil(chars / 4). */
export const defaultTokenEstimator = (text: string): number => {
  if (typeof text !== 'string' || text === '') return 0;
  return Math.ceil(text.length / 4);
};

/**
 * Pack sections within the token budget. Returns a tagged outcome;
 * throws only on structural input errors.
 */
export function packPromptBudget(input: PromptBudgetInput): PromptBudgetOutcome {
  validate(input);
  const estimator = input.estimator ?? defaultTokenEstimator;
  const reserve = input.reserveTokens ?? 0;
  const effectiveMax = Math.max(0, input.maxTokens - reserve);

  // Estimate every section + tag by required/priority.
  const packed: PackedSection[] = input.sections.map((s) => ({
    id: s.id,
    text: s.text,
    tokens: estimator(s.text),
    required: s.required === true,
    priority: s.priority ?? 0,
  }));

  // 1. Required sections — if they overflow alone, fail.
  const required = packed.filter((p) => p.required);
  const requiredTokens = required.reduce((sum, s) => sum + s.tokens, 0);
  if (requiredTokens > effectiveMax) {
    return {
      ok: false,
      reason: 'over_budget_required',
      requiredTokens,
      effectiveMaxTokens: effectiveMax,
      required,
    };
  }

  // 2. Fit discretionary sections in priority-desc order, then by
  // original index ascending for stable tiebreak.
  const discretionary = packed
    .map((p, idx) => ({ p, idx }))
    .filter(({ p }) => !p.required)
    .sort((a, b) => {
      if (b.p.priority !== a.p.priority) return b.p.priority - a.p.priority;
      return a.idx - b.idx;
    });

  const included: PackedSection[] = [...required];
  const dropped: PackedSection[] = [];
  let usedTokens = requiredTokens;

  for (const { p } of discretionary) {
    if (usedTokens + p.tokens <= effectiveMax) {
      included.push(p);
      usedTokens += p.tokens;
    } else {
      dropped.push(p);
    }
  }

  // Sort `included` back into input order so callers get a stable output.
  const idToIndex = new Map(input.sections.map((s, i) => [s.id, i]));
  included.sort((a, b) => (idToIndex.get(a.id) ?? 0) - (idToIndex.get(b.id) ?? 0));

  return {
    ok: true,
    included,
    dropped,
    totalTokens: usedTokens,
    truncated: dropped.length > 0,
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function validate(input: PromptBudgetInput): void {
  if (!Number.isInteger(input.maxTokens) || input.maxTokens < 1) {
    throw new PromptBudgetError('invalid_max', 'maxTokens must be a positive integer');
  }
  if (input.reserveTokens !== undefined) {
    if (!Number.isInteger(input.reserveTokens) || input.reserveTokens < 0) {
      throw new PromptBudgetError('invalid_reserve', 'reserveTokens must be a non-negative integer');
    }
  }
  if (!Array.isArray(input.sections)) {
    throw new PromptBudgetError('invalid_section', 'sections must be an array');
  }
  const seenIds = new Set<string>();
  for (const [i, s] of input.sections.entries()) {
    if (!s || typeof s !== 'object') {
      throw new PromptBudgetError('invalid_section', `section ${i}: object required`);
    }
    if (typeof s.id !== 'string' || s.id === '') {
      throw new PromptBudgetError('invalid_section', `section ${i}: id required`);
    }
    if (typeof s.text !== 'string') {
      throw new PromptBudgetError('invalid_section', `section ${i}: text must be string`);
    }
    if (s.required !== undefined && typeof s.required !== 'boolean') {
      throw new PromptBudgetError('invalid_section', `section ${i}: required must be boolean`);
    }
    if (s.priority !== undefined && (typeof s.priority !== 'number' || !Number.isFinite(s.priority))) {
      throw new PromptBudgetError('invalid_section', `section ${i}: priority must be finite number`);
    }
    if (seenIds.has(s.id)) {
      throw new PromptBudgetError('duplicate_id', `duplicate section id: ${s.id}`);
    }
    seenIds.add(s.id);
  }
}
