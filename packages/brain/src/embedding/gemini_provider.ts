/**
 * Gemini cloud embedding provider — produces 768-dim embeddings via
 * `gemini-embedding-001` (the public 768-dim model). Registered via
 * `registerCloudProvider` so the existing fallback chain
 * (local → cloud → throw) in `embedding/generation.ts` picks it up
 * without any call-site changes.
 *
 * Why this exists separately from `GeminiGenaiAdapter` (the chat
 * adapter): the chat adapter throws on `embed()` by design — chat
 * and embeddings are different products with different rate limits,
 * billing tiers, and request shapes. Mixing them on one adapter
 * meant a chat-only quota breach blew up the embed path and vice
 * versa. Two adapters, two registrations.
 *
 * The default model is `gemini-embedding-001` (the GA, 768-dim
 * model). Dimensions returned MUST match what the vault expects
 * (768) — `gatherVaultContext` uses `mode: 'hybrid'` which scores
 * cosine on stored embeddings; a dimensional mismatch returns 0
 * results silently.
 */

import { GoogleGenAI } from '@google/genai';

import type { EmbeddingProvider, EmbeddingResult } from './generation';

export interface GeminiEmbeddingAdapterOptions {
  apiKey: string;
  /** Defaults to `gemini-embedding-001` — 768-dim, GA. */
  model?: string;
}

const DEFAULT_GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';

/**
 * Build an `EmbeddingProvider` suitable for `registerCloudProvider`.
 * Fails closed: rejects on missing API key (caller should skip
 * registration rather than ship a provider that always throws).
 */
export function createGeminiEmbeddingProvider(
  options: GeminiEmbeddingAdapterOptions,
): EmbeddingProvider {
  if (typeof options.apiKey !== 'string' || options.apiKey.length === 0) {
    throw new Error(
      'createGeminiEmbeddingProvider: apiKey is required. Skip registration when no key is available instead of constructing the provider.',
    );
  }
  const client = new GoogleGenAI({ apiKey: options.apiKey });
  const model = options.model ?? DEFAULT_GEMINI_EMBEDDING_MODEL;

  return async (text: string): Promise<EmbeddingResult> => {
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('gemini-embedding: empty input text');
    }
    const response = await client.models.embedContent({
      model,
      contents: text,
    });
    // `@google/genai` returns embeddings under `embeddings[0].values`
    // (array form, even for a single content). Defend against either
    // shape so a future SDK rev that switches to `embedding.values`
    // doesn't silently break us.
    const values =
      response.embeddings?.[0]?.values ??
      (response as { embedding?: { values?: number[] } }).embedding?.values ??
      [];
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(
        `gemini-embedding: empty response from ${model} — check API key + quota`,
      );
    }
    return {
      vector: new Float32Array(values),
      dimensions: values.length,
      model,
      source: 'cloud',
    };
  };
}
