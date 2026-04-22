/**
 * Gemini structured output classification — schema enforcement + parsing.
 *
 * Source: brain/src/prompts.py PERSONA_CLASSIFY_RESPONSE_SCHEMA
 */

import {
  createGeminiClassifier,
  createGenericClassifier,
  parseClassificationResponse,
} from '../../src/routing/gemini_classify';
import { PERSONA_CLASSIFY_RESPONSE_SCHEMA } from '../../src/llm/prompts';
import type { LLMProvider, ChatResponse } from '../../src/llm/adapters/provider';

function mockProvider(content: string): LLMProvider {
  return {
    name: 'mock',
    supportsStreaming: false,
    supportsToolCalling: false,
    supportsEmbedding: false,
    chat: jest.fn(async () => ({
      content,
      toolCalls: [],
      model: 'mock',
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: 'end' as const,
    })),
    stream: jest.fn(),
    embed: jest.fn(),
  };
}

const AVAILABLE = ['general', 'health', 'financial', 'work'];

describe('Gemini Structured Classification', () => {
  describe('parseClassificationResponse', () => {
    it('parses valid structured JSON', () => {
      const json = JSON.stringify({
        persona: 'health',
        confidence: 0.92,
        reason: 'Medical content',
      });
      const result = parseClassificationResponse(json, AVAILABLE);
      expect(result.persona).toBe('health');
      expect(result.confidence).toBe(0.92);
      expect(result.reason).toBe('Medical content');
    });

    it('parses JSON with markdown fences', () => {
      const json = '```json\n{"persona": "financial", "confidence": 0.8, "reason": "Money"}\n```';
      const result = parseClassificationResponse(json, AVAILABLE);
      expect(result.persona).toBe('financial');
    });

    it('rejects unknown persona → falls back to general with reduced confidence', () => {
      const json = JSON.stringify({ persona: 'nonexistent', confidence: 0.9, reason: 'test' });
      const result = parseClassificationResponse(json, AVAILABLE);
      expect(result.persona).toBe('general');
      expect(result.confidence).toBeLessThan(0.9);
    });

    it('handles malformed JSON → fallback', () => {
      const result = parseClassificationResponse('not json at all', AVAILABLE);
      expect(result.persona).toBe('general');
      expect(result.confidence).toBe(0.3);
    });

    it('handles empty content → fallback', () => {
      const result = parseClassificationResponse('', AVAILABLE);
      expect(result.persona).toBe('general');
    });

    it('handles NaN confidence → fallback', () => {
      const json = JSON.stringify({ persona: 'health', confidence: 'invalid', reason: 'test' });
      const result = parseClassificationResponse(json, AVAILABLE);
      expect(result.persona).toBe('general');
    });

    it('handles confidence > 1.0 → fallback', () => {
      const json = JSON.stringify({ persona: 'health', confidence: 1.5, reason: 'test' });
      const result = parseClassificationResponse(json, AVAILABLE);
      expect(result.persona).toBe('general');
    });

    it('normalizes persona name to lowercase', () => {
      const json = JSON.stringify({ persona: 'HEALTH', confidence: 0.8, reason: 'test' });
      const result = parseClassificationResponse(json, AVAILABLE);
      expect(result.persona).toBe('health');
    });

    it('handles extra fields from schema (secondary, has_event)', () => {
      const json = JSON.stringify({
        persona: 'health',
        confidence: 0.95,
        reason: 'Medical',
        secondary: 'financial',
        has_event: true,
        event_hint: 'Appointment March 15',
      });
      const result = parseClassificationResponse(json, AVAILABLE);
      expect(result.persona).toBe('health');
      expect(result.confidence).toBe(0.95);
    });
  });

  describe('PERSONA_CLASSIFY_RESPONSE_SCHEMA', () => {
    it('has required fields', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.required).toContain('persona');
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.required).toContain('confidence');
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.required).toContain('reason');
    });

    it('defines persona as string', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.persona.type).toBe('string');
    });

    it('defines confidence as number', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.confidence.type).toBe('number');
    });

    it('defines optional secondary field', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.secondary.type).toBe('string');
    });

    it('defines has_event and event_hint', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.has_event.type).toBe('boolean');
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.event_hint.type).toBe('string');
    });
  });

  describe('createGeminiClassifier', () => {
    it('passes responseSchema to provider', async () => {
      const provider = mockProvider(
        JSON.stringify({
          persona: 'health',
          confidence: 0.9,
          reason: 'Blood test',
        }),
      );
      const classifier = createGeminiClassifier(provider);
      await classifier({ subject: 'Blood test results' }, AVAILABLE);

      expect(provider.chat).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          responseSchema: PERSONA_CLASSIFY_RESPONSE_SCHEMA,
        }),
      );
    });

    it('returns parsed classification result', async () => {
      const provider = mockProvider(
        JSON.stringify({
          persona: 'health',
          confidence: 0.92,
          reason: 'Medical content',
        }),
      );
      const classifier = createGeminiClassifier(provider);
      const result = await classifier({ subject: 'Lab results' }, AVAILABLE);
      expect(result.persona).toBe('health');
      expect(result.confidence).toBe(0.92);
    });

    it('uses low temperature for deterministic classification', async () => {
      const provider = mockProvider(
        JSON.stringify({ persona: 'general', confidence: 0.5, reason: 'test' }),
      );
      const classifier = createGeminiClassifier(provider);
      await classifier({}, AVAILABLE);

      expect(provider.chat).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ temperature: 0.1 }),
      );
    });
  });

  describe('createGenericClassifier', () => {
    it('does NOT pass responseSchema', async () => {
      const provider = mockProvider(
        JSON.stringify({
          persona: 'financial',
          confidence: 0.8,
          reason: 'Money topics',
        }),
      );
      const classifier = createGenericClassifier(provider);
      await classifier({ subject: 'Invoice' }, AVAILABLE);

      const callOptions = (provider.chat as jest.Mock).mock.calls[0][1];
      expect(callOptions.responseSchema).toBeUndefined();
    });

    it('returns parsed result from free-form JSON', async () => {
      const provider = mockProvider(
        JSON.stringify({
          persona: 'financial',
          confidence: 0.85,
          reason: 'Invoice content',
        }),
      );
      const classifier = createGenericClassifier(provider);
      const result = await classifier({ subject: 'Invoice #123' }, AVAILABLE);
      expect(result.persona).toBe('financial');
    });
  });
});
