/**
 * Bootstrap-layer staging enrichment wiring (GAP-RT-02 / PC-BRAIN-13).
 */

import {
  buildStagingEnrichment,
  providerToExtractorLLM,
  defaultContactResolver,
} from '../../src/services/staging_enrichment';
import type { LLMProvider } from '../../../brain/src/llm/adapters/provider';
import type { CoreClient } from '@dina/core';
import {
  resetContactDirectory,
  addContact,
  setPreferredFor,
} from '../../../core/src/contacts/directory';

function fakeProvider(response: string): LLMProvider {
  return {
    name: 'fake',
    supportsStreaming: false,
    supportsToolCalling: false,
    supportsEmbedding: false,
    chat: async () => ({
      content: response,
      model: 'fake',
      tokensIn: 0,
      tokensOut: 0,
      finishReason: 'stop',
    }),
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        /* unused */
      },
    }),
    embed: async () => ({ embedding: new Float64Array([0]), model: 'fake', dimensions: 1 }),
  } as unknown as LLMProvider;
}

function fakeCore(): Pick<CoreClient, 'memoryTouch' | 'updateContact'> {
  return {
    async memoryTouch() {
      return { status: 'ok', canonical: 'x' };
    },
    async updateContact() {
      /* noop */
    },
  } as Pick<CoreClient, 'memoryTouch' | 'updateContact'>;
}

describe('providerToExtractorLLM', () => {
  it('adapts LLMProvider.chat into the (system, prompt) => string shape', async () => {
    const captured: Array<{ system?: string; content: string }> = [];
    const provider = {
      ...fakeProvider('{"entities":["Dr Carl"],"themes":[]}'),
      chat: async (messages: Array<{ content: string }>, options?: { systemPrompt?: string }) => {
        captured.push({
          system: options?.systemPrompt,
          content: messages[0].content,
        });
        return {
          content: '{"entities":["Dr Carl"],"themes":[]}',
          model: 'fake',
          tokensIn: 0,
          tokensOut: 0,
          finishReason: 'stop' as const,
        };
      },
    } as unknown as LLMProvider;
    const llm = providerToExtractorLLM(provider);
    const result = await llm('SYS', 'USER');
    expect(result).toBe('{"entities":["Dr Carl"],"themes":[]}');
    expect(captured[0]).toEqual({ system: 'SYS', content: 'USER' });
  });
});

describe('defaultContactResolver', () => {
  afterEach(() => resetContactDirectory());

  it('finds a contact by exact display name (case-insensitive)', () => {
    addContact('did:plc:drcarl', 'Dr Carl', 'trusted', 'summary', 'acquaintance');
    setPreferredFor('did:plc:drcarl', ['dental']);
    const resolved = defaultContactResolver('dr carl');
    expect(resolved).toEqual({ did: 'did:plc:drcarl', preferredFor: ['dental'] });
  });

  it('returns null when the name does not match any contact', () => {
    expect(defaultContactResolver('nobody')).toBeNull();
  });

  it('handles contacts with no preferredFor field (undefined → [])', () => {
    addContact('did:plc:alice', 'Alice', 'unknown', 'summary', 'acquaintance');
    const resolved = defaultContactResolver('Alice');
    expect(resolved).toEqual({ did: 'did:plc:alice', preferredFor: [] });
  });
});

describe('buildStagingEnrichment', () => {
  it('returns a complete TopicTouchPipelineOptions bundle when llm is supplied', () => {
    const core = fakeCore();
    const provider = fakeProvider('{"entities":[],"themes":[]}');
    const opts = buildStagingEnrichment({ core, llm: provider });
    expect(opts.extractor).toBeDefined();
    expect(opts.core).toBe(core);
    expect(opts.preferenceExtractor).toBeDefined();
    expect(opts.resolveContact).toBe(defaultContactResolver);
  });

  it('still returns a pipeline when llm is omitted (topic extractor becomes a no-op)', async () => {
    const core = fakeCore();
    const opts = buildStagingEnrichment({ core });
    expect(opts.extractor).toBeDefined();
    // The stub extractor returns empty entities / themes so the
    // preference binder stays functional without incurring LLM cost.
    const result = await opts.extractor.extract({ summary: 'My dentist Dr Carl' });
    expect(result).toEqual({ entities: [], themes: [] });
  });

  it('accepts a resolveContact override for tests', () => {
    const core = fakeCore();
    const customResolver = jest.fn(() => null);
    const opts = buildStagingEnrichment({ core, resolveContact: customResolver });
    expect(opts.resolveContact).toBe(customResolver);
  });

  it('forwards the logger through to the pipeline options', () => {
    const core = fakeCore();
    const logger = jest.fn();
    const opts = buildStagingEnrichment({ core, logger });
    expect(opts.logger).toBe(logger);
  });
});
