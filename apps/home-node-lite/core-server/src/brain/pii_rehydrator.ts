/**
 * PII rehydrator — inverse of `pii_redaction_planner.ts`'s tokenize mode.
 *
 * When Brain sends PII-scrubbed text to a cloud LLM, it retains the
 * `entityMap` so the LLM's response can be re-hydrated on Brain's
 * side before surfacing to the user. This primitive does that
 * reverse transform:
 *
 *   `"Hello <ENTITY:MINOR:0>!"` + `{"<ENTITY:MINOR:0>": "Alice"}`
 *     → `"Hello Alice!"`
 *
 * **Pure** — no IO, no state. Deterministic given `{text, entityMap}`.
 *
 * **Strict vs. lenient mode**:
 *
 *   - `strict: false` (default) — unknown tokens in the text (e.g.
 *     `<ENTITY:HEALTH:3>` when the map only has `MINOR:0`) are left
 *     in place. Callers see them and can decide whether to flag.
 *   - `strict: true` — unknown tokens cause the function to return
 *     `{ok: false, reason: 'unknown_token', token}`. Use when
 *     correctness requires every token to hydrate.
 *
 * **Token format**: must match the one `pii_redaction_planner` emits
 * — `<ENTITY:<TYPE>:<INT>>`. Any text outside that pattern is passed
 * through untouched.
 *
 * **Stats**: every call returns `{hydrated, leftovers, replacements}`
 * so callers can audit how many tokens the map covered.
 */

const TOKEN_PATTERN = /<ENTITY:([A-Z_]+):(\d+)>/g;

export interface RehydrateOptions {
  /** When true, unknown tokens in text fail fast. Default false. */
  strict?: boolean;
}

export interface RehydrateStats {
  /** Tokens successfully replaced. */
  hydrated: number;
  /** Tokens found in text but absent from entityMap. */
  leftovers: number;
  /** Per-token-string count — useful for audit. */
  replacements: Record<string, number>;
}

export type RehydrateOutcome =
  | { ok: true; text: string; stats: RehydrateStats }
  | { ok: false; reason: 'unknown_token'; token: string; stats: RehydrateStats };

/**
 * Rehydrate PII tokens in `text` using `entityMap`.
 */
export function rehydratePii(
  text: string,
  entityMap: Record<string, string>,
  opts: RehydrateOptions = {},
): RehydrateOutcome {
  if (typeof text !== 'string') {
    throw new TypeError('rehydratePii: text must be a string');
  }
  if (!entityMap || typeof entityMap !== 'object' || Array.isArray(entityMap)) {
    throw new TypeError('rehydratePii: entityMap must be a plain object');
  }
  const strict = opts.strict ?? false;
  const stats: RehydrateStats = {
    hydrated: 0,
    leftovers: 0,
    replacements: {},
  };

  // Replace via regex with a function so we visit each token.
  // Non-global regex would only match once; we use a fresh `g`-flag
  // RegExp per call so state doesn't bleed across invocations.
  const pattern = new RegExp(TOKEN_PATTERN.source, 'g');

  let firstUnknown: string | null = null;
  const output = text.replace(pattern, (match) => {
    const original = entityMap[match];
    if (original === undefined) {
      stats.leftovers += 1;
      if (firstUnknown === null) firstUnknown = match;
      return match;
    }
    stats.hydrated += 1;
    stats.replacements[match] = (stats.replacements[match] ?? 0) + 1;
    return original;
  });

  if (strict && firstUnknown !== null) {
    return { ok: false, reason: 'unknown_token', token: firstUnknown, stats };
  }
  return { ok: true, text: output, stats };
}

/**
 * Sanity check: does the `entityMap` cover every token in `text`?
 * Pure inspection — does not rehydrate. Returns `{allCovered, leftovers}`.
 */
export function checkRehydrationCoverage(
  text: string,
  entityMap: Record<string, string>,
): { allCovered: boolean; leftovers: string[]; tokensSeen: string[] } {
  if (typeof text !== 'string') {
    throw new TypeError('checkRehydrationCoverage: text must be a string');
  }
  if (!entityMap || typeof entityMap !== 'object' || Array.isArray(entityMap)) {
    throw new TypeError('checkRehydrationCoverage: entityMap must be a plain object');
  }
  const seen = new Set<string>();
  const leftovers = new Set<string>();
  const pattern = new RegExp(TOKEN_PATTERN.source, 'g');
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    seen.add(token);
    if (!(token in entityMap)) leftovers.add(token);
  }
  return {
    allCovered: leftovers.size === 0,
    leftovers: Array.from(leftovers).sort(),
    tokensSeen: Array.from(seen).sort(),
  };
}
