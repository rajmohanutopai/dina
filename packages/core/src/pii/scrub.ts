/**
 * PII scrub/rehydrate integration — wraps Tier 1 regex patterns with
 * the entity vault pattern for cloud LLM calls.
 *
 * Tier 1 (this module): regex patterns from Go core.
 * Tier 2 (Brain): Presidio-equivalent pattern recognizers (separate module).
 *
 * Source: core/test/pii_handler_test.go
 */

import { scrubPII, rehydratePII, type ScrubResult } from './patterns';

/**
 * Full Tier 1 scrub pipeline: detect → resolve overlaps → scrub → return.
 */
export function scrubTier1(text: string): ScrubResult {
  return scrubPII(text);
}

/**
 * Rehydrate scrubbed text — restore PII from a previous scrub result.
 */
export function rehydrate(
  scrubbed: string,
  entities: Array<{ token: string; value: string }>,
): string {
  return rehydratePII(scrubbed, entities);
}

/**
 * Full scrub → process → rehydrate cycle for cloud LLM calls.
 *
 * 1. Scrub PII from prompt
 * 2. Call processor (LLM) with scrubbed text
 * 3. Rehydrate LLM response
 */
export async function scrubProcessRehydrate(
  text: string,
  processor: (scrubbed: string) => Promise<string>,
): Promise<string> {
  const { scrubbed, entities } = scrubTier1(text);
  const processed = await processor(scrubbed);
  return rehydrate(processed, entities);
}
