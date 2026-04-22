/**
 * Embedding generation — local LLM or cloud API, 768-dim vectors.
 *
 * Fallback: local → cloud → throw (no embedding available).
 * Generated from rehydrated L1 (not raw L2) for cleaner semantics.
 * Stored as BLOB in vault_items + provenance in embedding_meta.
 *
 * Provider registration: call registerLocalProvider or registerCloudProvider
 * before generating embeddings. isEmbeddingAvailable checks if at least
 * one provider is registered.
 *
 * Source: brain/tests/test_embedding.py
 */

export interface EmbeddingResult {
  vector: Float32Array;
  dimensions: number;
  model: string;
  source: 'local' | 'cloud';
}

export type EmbeddingProvider = (text: string) => Promise<EmbeddingResult>;

/** Provider registry. */
let localProvider: { name: string; generate: EmbeddingProvider } | null = null;
let cloudProvider: { name: string; generate: EmbeddingProvider } | null = null;

/** Reset providers (for testing). */
export function resetProviders(): void {
  localProvider = null;
  cloudProvider = null;
}

/** Register a local embedding provider (e.g., llama.rn). */
export function registerLocalProvider(name: string, generate: EmbeddingProvider): void {
  localProvider = { name, generate };
}

/** Register a cloud embedding provider (e.g., OpenAI, Gemini). */
export function registerCloudProvider(name: string, generate: EmbeddingProvider): void {
  cloudProvider = { name, generate };
}

/**
 * Check if any embedding provider is available.
 *
 * Returns true if at least one provider (local or cloud) is registered.
 */
export function isEmbeddingAvailable(): boolean {
  return localProvider !== null || cloudProvider !== null;
}

/**
 * Generate a 768-dim embedding from text.
 *
 * Fallback order: local → cloud → throw.
 * Local is preferred because: no PII scrubbing needed, no network,
 * faster for real-time search.
 */
export async function generateEmbedding(text: string): Promise<EmbeddingResult> {
  if (localProvider) {
    try {
      return await localProvider.generate(text);
    } catch {
      // Fall through to cloud
    }
  }

  if (cloudProvider) {
    return await cloudProvider.generate(text);
  }

  throw new Error('embedding: no provider available');
}

/**
 * Generate embedding via local LLM (llama.rn).
 *
 * Throws if no local provider is registered.
 */
export async function generateLocalEmbedding(text: string): Promise<EmbeddingResult> {
  if (!localProvider) {
    throw new Error('embedding: no local provider registered');
  }
  return await localProvider.generate(text);
}

/**
 * Generate embedding via cloud API (OpenAI, Gemini).
 *
 * Throws if no cloud provider is registered.
 */
export async function generateCloudEmbedding(text: string): Promise<EmbeddingResult> {
  if (!cloudProvider) {
    throw new Error('embedding: no cloud provider registered');
  }
  return await cloudProvider.generate(text);
}
