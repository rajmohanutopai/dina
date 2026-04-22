/**
 * Task 4.81 — allow-list filter for Tier 1 PII matches.
 *
 * `@dina/core`'s `detectPII`/`scrubPII` ship with aggressive regex
 * patterns — the PAN regex catches 5-letter-4-digit-letter; the
 * AADHAAR regex catches any 12-digit span. In real corpora those
 * collide with common non-PII tokens: product SKUs, tracking numbers,
 * test fixtures, internal identifiers. Left unchecked, scrubbing
 * destroys information the user actually wants to keep.
 *
 * The allow-list is the post-filter: a curated set of tokens that
 * must NEVER be scrubbed even if a Tier 1 regex matched them. It
 * mirrors the Python side's `brain/config/pii_allowlist.yaml` +
 * `scrubber_presidio._load_allowlist` logic — medical abbreviations
 * like B12, HbA1c, test IDs, etc.
 *
 * **Normalization**: lookups are case-insensitive. We normalize to
 * lowercase on both the allow-list side and the match-value side so
 * "B12" / "b12" / "B12" all match the same rule.
 *
 * **Scope**: filter operates on full match values only. Partial
 * containment ("B12 is in 'foo B12 bar'") is a detection concern,
 * not an allow-list concern — the regex decides the span, this module
 * decides whether to keep the span's classification.
 *
 * **Type-scoped entries**: a caller can allow-list a token globally
 * (`add('B12')`) or only for a specific type (`add('john@dina.app',
 * { type: 'EMAIL' })`). Type-scoped entries only suppress matches of
 * that exact type — important because the same string can match
 * multiple regex families (e.g. a UPI handle that looks like an
 * email).
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4k task 4.81.
 */

import type { PIIMatch } from '@dina/core';

/** One entry in the allow list. */
interface AllowEntry {
  /** Normalized (lowercased) token. */
  token: string;
  /** When set, only suppress matches of this specific type. Undefined = all types. */
  type?: string;
}

export interface AllowListAddOptions {
  /** When set, the token is only allow-listed for PII matches of this type. */
  type?: string;
}

export interface AllowListFileShape {
  [category: string]: string[];
}

export class AllowList {
  /**
   * Global allowed tokens (type === undefined) keyed by lowercase token.
   * Separate from type-scoped so the `has` checks are O(1) and allocation-free.
   */
  private readonly global = new Set<string>();
  /** Per-type allowed tokens, keyed by `${type}::${lowercase token}`. */
  private readonly typed = new Set<string>();

  /**
   * Add a single token. Tokens are stored lowercased; lookups
   * normalize the match value the same way.
   */
  add(token: string, opts: AllowListAddOptions = {}): this {
    if (typeof token !== 'string') {
      throw new Error('AllowList.add: token must be a string');
    }
    const normalized = token.trim().toLowerCase();
    if (normalized.length === 0) {
      throw new Error('AllowList.add: token must be non-empty');
    }
    if (opts.type !== undefined) {
      this.typed.add(`${opts.type}::${normalized}`);
    } else {
      this.global.add(normalized);
    }
    return this;
  }

  /** Add every token from an iterable. Short-circuits on empty input. */
  addAll(tokens: Iterable<string>, opts?: AllowListAddOptions): this {
    for (const token of tokens) {
      if (typeof token === 'string' && token.trim().length > 0) {
        this.add(token, opts);
      }
    }
    return this;
  }

  /**
   * Merge a YAML-style config object ({ category: [token, ...], ... }).
   * Categories are informational only — every token collapses into a
   * flat set. Mirrors `scrubber_presidio._load_allowlist`.
   */
  loadFromConfig(data: AllowListFileShape): this {
    if (data === null || typeof data !== 'object') {
      throw new Error('AllowList.loadFromConfig: expected an object');
    }
    for (const [, items] of Object.entries(data)) {
      if (!Array.isArray(items)) continue;
      this.addAll(items);
    }
    return this;
  }

  /**
   * Return true when a match of `type` with `value` is allow-listed
   * (and therefore must be dropped from the PII entity list).
   */
  suppresses(type: string, value: string): boolean {
    if (typeof value !== 'string' || value.length === 0) return false;
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) return false;
    if (this.global.has(normalized)) return true;
    if (this.typed.has(`${type}::${normalized}`)) return true;
    return false;
  }

  /** Number of entries in the list (global + type-scoped). */
  size(): number {
    return this.global.size + this.typed.size;
  }
}

/**
 * Apply an allow-list to a set of detected PII matches. Returns a new
 * array containing only the matches NOT suppressed. Input is not
 * mutated.
 *
 * Passing `allowList === undefined` is a deliberate no-op — callers
 * that don't want filtering can omit the arg.
 */
export function filterMatches(
  matches: readonly PIIMatch[],
  allowList: AllowList | undefined,
): PIIMatch[] {
  if (!allowList || allowList.size() === 0) return matches.slice();
  const out: PIIMatch[] = [];
  for (const m of matches) {
    if (!allowList.suppresses(m.type, m.value)) {
      out.push(m);
    }
  }
  return out;
}
