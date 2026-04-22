/**
 * Persona classifier factory — creates the right classifier for each LLM provider.
 *
 * Source: brain/src/prompts.py PERSONA_CLASSIFY_RESPONSE_SCHEMA
 */

import {
  createClassifierForProvider,
  configureClassification,
} from '../../src/routing/classify_factory';
import { PERSONA_CLASSIFY_RESPONSE_SCHEMA } from '../../src/llm/prompts';
import type { LLMProvider, ChatResponse } from '../../src/llm/adapters/provider';
import { createPersona, resetPersonaState } from '../../../core/src/persona/service';

function mockProvider(name: string, content: string): LLMProvider {
  return {
    name,
    supportsStreaming: false,
    supportsToolCalling: false,
    supportsEmbedding: false,
    chat: jest.fn(async () => ({
      content,
      toolCalls: [],
      model: name,
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: 'end' as const,
    })),
    stream: jest.fn(),
    embed: jest.fn(),
  };
}

const AVAILABLE = ['general', 'health', 'financial', 'work'];

describe('Persona Classifier Factory', () => {
  beforeEach(() => {
    resetPersonaState();
    createPersona('general', 'default');
    createPersona('health', 'sensitive');
    createPersona('financial', 'sensitive');
    createPersona('work', 'standard');
  });

  describe('createClassifierForProvider', () => {
    it('creates classifier for Gemini with schema enforcement', async () => {
      const provider = mockProvider(
        'gemini',
        JSON.stringify({
          persona: 'health',
          confidence: 0.92,
          reason: 'Medical content',
        }),
      );

      const classifier = createClassifierForProvider(provider);
      const result = await classifier({ subject: 'Lab results' }, AVAILABLE);

      expect(result.persona).toBe('health');
      expect(result.confidence).toBe(0.92);
      // Gemini adapter should receive responseSchema
      expect(provider.chat).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ responseSchema: PERSONA_CLASSIFY_RESPONSE_SCHEMA }),
      );
    });

    it('creates generic classifier for OpenAI (no schema enforcement)', async () => {
      const provider = mockProvider(
        'openai',
        JSON.stringify({
          persona: 'financial',
          confidence: 0.85,
          reason: 'Money topics',
        }),
      );

      const classifier = createClassifierForProvider(provider);
      const result = await classifier({ subject: 'Invoice' }, AVAILABLE);

      expect(result.persona).toBe('financial');
      // OpenAI should NOT get responseSchema (only Gemini does)
      const callOptions = (provider.chat as jest.Mock).mock.calls[0][1];
      expect(callOptions.responseSchema).toBeUndefined();
    });

    it('creates classifier for Claude', async () => {
      const provider = mockProvider(
        'claude',
        JSON.stringify({
          persona: 'work',
          confidence: 0.88,
          reason: 'Professional',
        }),
      );

      const classifier = createClassifierForProvider(provider);
      const result = await classifier({ subject: 'Meeting notes' }, AVAILABLE);

      expect(result.persona).toBe('work');
    });

    it('creates generic classifier for unknown providers', async () => {
      const provider = mockProvider(
        'local-llama',
        JSON.stringify({
          persona: 'general',
          confidence: 0.7,
          reason: 'Generic',
        }),
      );

      const classifier = createClassifierForProvider(provider);
      const result = await classifier({ body: 'Hello world' }, AVAILABLE);

      expect(result.persona).toBe('general');
      // Generic classifier should NOT pass responseSchema
      expect(provider.chat).toHaveBeenCalledWith(
        expect.any(Array),
        expect.not.objectContaining({ responseSchema: expect.anything() }),
      );
    });

    it('falls back to general on parse failure', async () => {
      const provider = mockProvider('gemini', 'not json at all');

      const classifier = createClassifierForProvider(provider);
      const result = await classifier({ subject: 'test' }, AVAILABLE);

      expect(result.persona).toBe('general');
      expect(result.confidence).toBeLessThan(0.5);
    });
  });

  describe('configureClassification', () => {
    it('registers classifier with the provided function', async () => {
      const provider = mockProvider(
        'gemini',
        JSON.stringify({
          persona: 'health',
          confidence: 0.9,
          reason: 'Medical',
        }),
      );

      let registeredClassifier: any = null;
      configureClassification(provider, (cls) => {
        registeredClassifier = cls;
      });

      expect(registeredClassifier).not.toBeNull();
      expect(typeof registeredClassifier).toBe('function');

      // Verify the registered classifier works
      const result = await registeredClassifier({ subject: 'Lab results' }, AVAILABLE);
      expect(result.persona).toBe('health');
    });
  });
});
