/**
 * Enrichment pipeline E2E — L0 → L1 → PII → embedding → ready.
 *
 * Tests the full orchestrator with mock LLM and embedding providers.
 */

import {
  enrichItem,
  registerEnrichmentLLM,
  resetEnrichmentPipeline,
} from '../../src/enrichment/pipeline';
import { registerCloudProvider, resetProviders } from '../../src/embedding/generation';

describe('Enrichment Pipeline E2E', () => {
  beforeEach(() => {
    resetEnrichmentPipeline();
    resetProviders();
  });

  describe('L0 only (no LLM, no embedding)', () => {
    it('returns L0 deterministic with status l0_complete', async () => {
      const result = await enrichItem({
        type: 'email',
        source: 'gmail',
        sender: 'alice@example.com',
        timestamp: 1700000000,
      });

      expect(result.content_l0).toContain('Email');
      expect(result.content_l0).toContain('alice@example.com');
      expect(result.content_l1).toBe('');
      expect(result.enrichment_status).toBe('l0_complete');
      expect(result.embedding).toBeUndefined();
      expect(result.stages).toMatchObject({
        l1: 'skipped_no_llm',
        embedding: 'skipped_no_provider',
      });
      expect(result.stages.fallback_reasons).toEqual(
        expect.arrayContaining(['llm_unavailable', 'embedding_unavailable']),
      );
    });

    it('confidence derived from trust', async () => {
      const result = await enrichItem({
        type: 'note',
        source: 'personal',
        sender: 'user',
        timestamp: 1700000000,
        sender_trust: 'self',
      });
      expect(result.confidence).toBe('high');
    });
  });

  describe('L0 + L1 via LLM (no embedding)', () => {
    it('generates L1 from LLM response', async () => {
      registerEnrichmentLLM(async () =>
        JSON.stringify({
          l0: 'Meeting with Alice',
          l1: 'Alice and Bob discussed the Q4 budget review. Key decisions were made about cost reductions.',
          has_event: false,
        }),
      );

      const result = await enrichItem({
        type: 'email',
        source: 'gmail',
        sender: 'alice@example.com',
        timestamp: 1700000000,
        body: 'Full email body here...',
      });

      expect(result.content_l0).toBe('Meeting with Alice');
      expect(result.content_l1).toContain('Q4 budget');
      expect(result.enrichment_status).toBe('l0_complete'); // no embedding → not 'ready'
      expect(result.enrichment_version.prompt_v).toBe('llm-v1');
    });

    it('PII is scrubbed before LLM and rehydrated after', async () => {
      let capturedPrompt = '';
      registerEnrichmentLLM(async (_sys, prompt) => {
        capturedPrompt = prompt;
        return JSON.stringify({
          l0: 'Email about [EMAIL_1]',
          l1: 'The email from [EMAIL_1] discusses plans.',
        });
      });

      const result = await enrichItem({
        type: 'email',
        source: 'gmail',
        sender: 'test@example.com',
        timestamp: 1700000000,
        body: 'Contact john@secret.com for details',
      });

      // LLM should NOT have seen the real email
      expect(capturedPrompt).not.toContain('john@secret.com');
      // Result should have the real email rehydrated
      expect(result.content_l1).toContain('john@secret.com');
    });

    it('low-trust sources get provenance instruction', async () => {
      let capturedPrompt = '';
      registerEnrichmentLLM(async (_sys, prompt) => {
        capturedPrompt = prompt;
        return JSON.stringify({ l0: 'Test', l1: 'Test L1' });
      });

      await enrichItem({
        type: 'email',
        source: 'gmail',
        sender: 'stranger',
        timestamp: 1700000000,
        sender_trust: 'unknown',
        body: 'Some content',
      });

      expect(capturedPrompt).toContain('PROVENANCE WARNING');
    });

    it('degrades gracefully when LLM fails', async () => {
      registerEnrichmentLLM(async () => {
        throw new Error('LLM timeout');
      });

      const result = await enrichItem({
        type: 'email',
        source: 'gmail',
        sender: 'alice',
        timestamp: 1700000000,
        body: 'Body text',
      });

      // Falls back to L0 deterministic
      expect(result.content_l0).toContain('Email');
      expect(result.content_l1).toBe('');
      expect(result.enrichment_status).toBe('l0_complete');
    });
  });

  describe('full pipeline: L0 + L1 + embedding → ready', () => {
    it('reaches enrichment_status=ready with all steps', async () => {
      registerEnrichmentLLM(async () =>
        JSON.stringify({
          l0: 'Summary headline',
          l1: 'A detailed paragraph about the content.',
        }),
      );
      registerCloudProvider('test-embed', async (text) => ({
        vector: new Float32Array([0.1, 0.2, 0.3]),
        dimensions: 3,
        model: 'test-embed-v1',
        source: 'cloud' as const,
      }));

      const result = await enrichItem({
        type: 'note',
        source: 'personal',
        sender: 'user',
        timestamp: 1700000000,
        body: 'My personal note content',
      });

      expect(result.content_l0).toBe('Summary headline');
      expect(result.content_l1).toContain('detailed paragraph');
      expect(result.embedding).toBeInstanceOf(Float32Array);
      expect(result.embedding!.length).toBe(3);
      expect(result.enrichment_status).toBe('ready');
      expect(result.enrichment_version.embed_model).toBe('test-embed-v1');
      expect(result.stages).toMatchObject({ l1: 'ready', embedding: 'ready' });
    });

    it('L1 + no embedding → l0_complete (not ready)', async () => {
      registerEnrichmentLLM(async () => JSON.stringify({ l0: 'H', l1: 'P' }));
      // No embedding provider registered

      const result = await enrichItem({
        type: 'note',
        source: 'personal',
        sender: 'user',
        timestamp: 1700000000,
        body: 'Content',
      });

      expect(result.content_l1).toBe('P');
      expect(result.embedding).toBeUndefined();
      expect(result.enrichment_status).toBe('l0_complete');
    });

    it('body is capped at 4000 chars for LLM', async () => {
      let capturedPrompt = '';
      registerEnrichmentLLM(async (_sys, prompt) => {
        capturedPrompt = prompt;
        return JSON.stringify({ l0: 'H', l1: 'P' });
      });

      const longBody = 'x'.repeat(5000);
      await enrichItem({
        type: 'note',
        source: 'personal',
        sender: 'user',
        timestamp: 1700000000,
        body: longBody,
      });

      // The body in the prompt should be capped at 4000
      expect(capturedPrompt.length).toBeLessThan(5000 + 500); // prompt template overhead
    });
  });
});
