/**
 * T2B.11 — Embedding generation: local/cloud fallback, provider registry.
 *
 * Category B: contract test.
 *
 * Source: brain/tests/test_embedding.py
 */

import {
  generateEmbedding,
  generateLocalEmbedding,
  generateCloudEmbedding,
  isEmbeddingAvailable,
  resetProviders,
  registerLocalProvider,
  registerCloudProvider,
} from '../../src/embedding/generation';
import type { EmbeddingResult } from '../../src/embedding/generation';

/** Helper: create a mock provider that returns a fixed 768-dim vector. */
function mockProvider(
  model: string,
  source: 'local' | 'cloud',
): (text: string) => Promise<EmbeddingResult> {
  return async (text: string) => ({
    vector: new Float32Array(768).fill(0.1),
    dimensions: 768,
    model,
    source,
  });
}

/** Helper: create a provider that always fails. */
function failingProvider(): (text: string) => Promise<EmbeddingResult> {
  return async () => {
    throw new Error('provider error');
  };
}

describe('Embedding Generation', () => {
  beforeEach(() => resetProviders());

  describe('isEmbeddingAvailable', () => {
    it('returns false when no providers registered', () => {
      expect(isEmbeddingAvailable()).toBe(false);
    });

    it('returns true when local provider registered', () => {
      registerLocalProvider('llama-3n', mockProvider('llama-3n', 'local'));
      expect(isEmbeddingAvailable()).toBe(true);
    });

    it('returns true when cloud provider registered', () => {
      registerCloudProvider(
        'text-embedding-3-small',
        mockProvider('text-embedding-3-small', 'cloud'),
      );
      expect(isEmbeddingAvailable()).toBe(true);
    });

    it('returns true when both providers registered', () => {
      registerLocalProvider('llama-3n', mockProvider('llama-3n', 'local'));
      registerCloudProvider(
        'text-embedding-3-small',
        mockProvider('text-embedding-3-small', 'cloud'),
      );
      expect(isEmbeddingAvailable()).toBe(true);
    });
  });

  describe('generateEmbedding', () => {
    it('generates a 768-dim vector', async () => {
      registerLocalProvider('llama-3n', mockProvider('llama-3n', 'local'));
      const result = await generateEmbedding('test text');
      expect(result.vector).toBeInstanceOf(Float32Array);
      expect(result.dimensions).toBe(768);
    });

    it('returns model name and source', async () => {
      registerLocalProvider('llama-3n', mockProvider('llama-3n', 'local'));
      const result = await generateEmbedding('test');
      expect(result.model).toBe('llama-3n');
      expect(result.source).toBe('local');
    });

    it('prefers local provider', async () => {
      registerLocalProvider('local-model', mockProvider('local-model', 'local'));
      registerCloudProvider('cloud-model', mockProvider('cloud-model', 'cloud'));
      const result = await generateEmbedding('test');
      expect(result.source).toBe('local');
      expect(result.model).toBe('local-model');
    });

    it('throws when no provider available', async () => {
      await expect(generateEmbedding('test')).rejects.toThrow('no provider available');
    });
  });

  describe('generateLocalEmbedding', () => {
    it('uses local LLM (llama.rn)', async () => {
      registerLocalProvider('llama-3n', mockProvider('llama-3n', 'local'));
      const result = await generateLocalEmbedding('test');
      expect(result.source).toBe('local');
    });

    it('throws when no local provider', async () => {
      await expect(generateLocalEmbedding('test')).rejects.toThrow('no local provider');
    });
  });

  describe('generateCloudEmbedding', () => {
    it('uses cloud API (OpenAI/Gemini)', async () => {
      registerCloudProvider(
        'text-embedding-3-small',
        mockProvider('text-embedding-3-small', 'cloud'),
      );
      const result = await generateCloudEmbedding('test');
      expect(result.source).toBe('cloud');
      expect(result.model).toBe('text-embedding-3-small');
    });

    it('throws when no cloud provider', async () => {
      await expect(generateCloudEmbedding('test')).rejects.toThrow('no cloud provider');
    });
  });

  describe('fallback', () => {
    it('local → cloud when local fails', async () => {
      registerLocalProvider('broken-local', failingProvider());
      registerCloudProvider('cloud-backup', mockProvider('cloud-backup', 'cloud'));
      const result = await generateEmbedding('fallback test');
      expect(result.source).toBe('cloud');
      expect(result.model).toBe('cloud-backup');
    });

    it('graceful degradation when no provider available', async () => {
      await expect(generateEmbedding('no provider')).rejects.toThrow('no provider available');
    });

    it('cloud failure is not caught (propagates)', async () => {
      registerCloudProvider('broken-cloud', failingProvider());
      await expect(generateEmbedding('test')).rejects.toThrow('provider error');
    });

    it('local failure + cloud failure propagates cloud error', async () => {
      registerLocalProvider('broken-local', failingProvider());
      registerCloudProvider('broken-cloud', failingProvider());
      await expect(generateEmbedding('test')).rejects.toThrow('provider error');
    });
  });
});
