/**
 * PII-safe embedding for content/queries that may contain vault PII.
 *
 * Law 3 (Absolute Loyalty): real PII must never leave the Home Node. A local
 * (on-device) embedder may embed the text as-is; when the active embedder is
 * cloud — the shipping default, or a local-provider failure fallback — the
 * text is PII-scrubbed FIRST so raw PII is never sent to a third party. This
 * is the single PII-safe embedding entry point; use it for any embedding whose
 * input derives from vault content or user data (enrichment L1, reminder/ask
 * query expansion, …). The raw `generateEmbedding` (which silently falls back
 * local→cloud) must only be used for already-safe text.
 */

import { EntityVault } from '../pii/entity_vault';

import {
  generateLocalEmbedding,
  generateCloudEmbedding,
  hasLocalEmbeddingProvider,
  hasCloudEmbeddingProvider,
  type EmbeddingResult,
} from './generation';

export interface SafeEmbedOutcome {
  /** The embedding, or null when no provider could serve it. */
  result: EmbeddingResult | null;
  /** True when the cloud path was used AND PII was scrubbed before sending. */
  scrubbedForCloud: boolean;
}

/**
 * Embed `text` without ever sending raw PII to a cloud provider.
 *
 *   - Local provider registered → embed the text as-is on-device.
 *   - Local fails, or cloud-only → PII-scrub, then embed via cloud.
 *   - No provider → `{ result: null }` (caller degrades gracefully).
 *
 * The cloud path NEVER receives the unscrubbed text, so a local-failure
 * fallback can't leak. Embedding scrubbed text is fine for semantic search:
 * PII tokens are stable placeholders, and the surrounding context dominates
 * the vector.
 */
export async function embedMaybeSensitive(text: string): Promise<SafeEmbedOutcome> {
  if (hasLocalEmbeddingProvider()) {
    try {
      return { result: await generateLocalEmbedding(text), scrubbedForCloud: false };
    } catch {
      // Local failed — fall through to the scrubbed cloud path below.
      // We deliberately do NOT hand the raw text to the cloud fallback.
    }
  }

  if (hasCloudEmbeddingProvider()) {
    const ev = new EntityVault();
    const scrubbed = ev.scrub(text);
    return {
      result: await generateCloudEmbedding(scrubbed),
      scrubbedForCloud: ev.entries().length > 0,
    };
  }

  return { result: null, scrubbedForCloud: false };
}
