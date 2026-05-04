/**
 * Gemini structured-output classification — schema enforcement + parsing
 * + user-message shape.
 *
 * Source of truth: `brain/src/prompts.py` PERSONA_CLASSIFY_RESPONSE_SCHEMA
 * + `brain/src/service/persona_selector.py`. TS port stays byte-identical
 * so drift between the two stacks surfaces here.
 */

import {
  buildClassificationUserMessage,
  createGeminiClassifier,
  createGenericClassifier,
  parseClassificationResponse,
  parseClassificationResponseRich,
} from '../../src/routing/gemini_classify';
import { PERSONA_CLASSIFY_RESPONSE_SCHEMA } from '../../src/llm/prompts';
import type { LLMProvider } from '../../src/llm/adapters/provider';

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

// Resolver stub so the classifier doesn't try to require Core's
// persona service inside Jest where it isn't populated.
const resolveInstalled = (names: string[]) =>
  names.map((name) => ({ name, tier: 'default', description: `${name} vault` }));

describe('Gemini Structured Classification', () => {
  describe('parseClassificationResponse', () => {
    it('parses valid structured JSON', () => {
      const json = JSON.stringify({
        primary: 'health',
        confidence: 0.92,
        reason: 'Medical content',
      });
      const result = parseClassificationResponse(json, AVAILABLE);
      expect(result.persona).toBe('health');
      expect(result.confidence).toBe(0.92);
      expect(result.reason).toBe('Medical content');
    });

    it('rejects old `persona` key without canonical `primary`', () => {
      const json = JSON.stringify({
        persona: 'health',
        confidence: 0.9,
        reason: 'Old shape',
      });
      const result = parseClassificationResponse(json, AVAILABLE);
      expect(result.persona).toBe('general');
      expect(result.reason).toMatch(/primary persona/i);
    });

    it('parses JSON with markdown fences', () => {
      const json = '```json\n{"primary": "financial", "confidence": 0.8, "reason": "Money"}\n```';
      const result = parseClassificationResponse(json, AVAILABLE);
      expect(result.persona).toBe('financial');
    });

    it('rejects unknown persona → falls back to general', () => {
      const json = JSON.stringify({ primary: 'nonexistent', confidence: 0.9, reason: 'test' });
      const result = parseClassificationResponse(json, AVAILABLE);
      expect(result.persona).toBe('general');
      expect(result.reason).toMatch(/not installed/i);
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
      const json = JSON.stringify({ primary: 'health', confidence: 'invalid', reason: 'test' });
      const result = parseClassificationResponse(json, AVAILABLE);
      expect(result.persona).toBe('general');
    });

    it('handles confidence > 1.0 → fallback', () => {
      const json = JSON.stringify({ primary: 'health', confidence: 1.5, reason: 'test' });
      const result = parseClassificationResponse(json, AVAILABLE);
      expect(result.persona).toBe('general');
    });

    it('normalizes persona name to lowercase', () => {
      const json = JSON.stringify({ primary: 'HEALTH', confidence: 0.8, reason: 'test' });
      const result = parseClassificationResponse(json, AVAILABLE);
      expect(result.persona).toBe('health');
    });
  });

  describe('parseClassificationResponseRich', () => {
    it('returns secondary[] filtered to installed personas only, excluding primary', () => {
      const json = JSON.stringify({
        primary: 'health',
        secondary: ['financial', 'bogus', 'health'], // 'bogus' unknown, 'health' is primary
        confidence: 0.9,
        reason: 'Medical bill',
        has_event: false,
      });
      const rich = parseClassificationResponseRich(json, AVAILABLE);
      expect(rich.primary).toBe('health');
      expect(rich.secondary).toEqual(['financial']);
    });

    it('carries has_event + event_hint + attribution_corrections', () => {
      const json = JSON.stringify({
        primary: 'health',
        secondary: [],
        confidence: 0.95,
        reason: 'Appointment',
        has_event: true,
        event_hint: 'vaccination March 27',
        attribution_corrections: [
          { id: 1, corrected_bucket: 'self_explicit', reason: 'allergy is user-owned' },
        ],
      });
      const rich = parseClassificationResponseRich(json, AVAILABLE);
      expect(rich.has_event).toBe(true);
      expect(rich.event_hint).toBe('vaccination March 27');
      expect(rich.attribution_corrections).toHaveLength(1);
      expect(rich.attribution_corrections[0]!.id).toBe(1);
      expect(rich.attribution_corrections[0]!.corrected_bucket).toBe('self_explicit');
    });
  });

  describe('buildClassificationUserMessage', () => {
    it('emits today + available_personas + item_context JSON blob', () => {
      const msg = buildClassificationUserMessage(
        {
          type: 'note',
          source: 'telegram',
          sender: 'owner',
          subject: 'lab result',
          body: 'blood test came back normal',
        },
        resolveInstalled(AVAILABLE),
      );
      const parsed = JSON.parse(msg) as Record<string, unknown>;
      expect(parsed.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Array.isArray(parsed.available_personas)).toBe(true);
      expect(parsed.item_type).toBe('note');
      expect(parsed.source).toBe('telegram');
      expect(parsed.summary).toBe('lab result');
      expect(parsed.body_preview).toBe('blood test came back normal');
    });

    it('includes mentioned_contacts when provided', () => {
      const msg = buildClassificationUserMessage(
        {
          subject: 'peanut allergy',
          mentionedContacts: [
            { name: 'Sancho', relationship: 'friend', data_responsibility: 'external' },
          ],
        },
        resolveInstalled(AVAILABLE),
      );
      const parsed = JSON.parse(msg) as Record<string, unknown>;
      expect(parsed.mentioned_contacts).toEqual([
        { name: 'Sancho', relationship: 'friend', data_responsibility: 'external' },
      ]);
    });

    it('omits mentioned_contacts when absent (Python parity)', () => {
      const msg = buildClassificationUserMessage(
        { subject: 'no contacts here' },
        resolveInstalled(AVAILABLE),
      );
      const parsed = JSON.parse(msg) as Record<string, unknown>;
      expect(parsed).not.toHaveProperty('mentioned_contacts');
    });

    it('truncates summary to 200 chars + body to 300 chars', () => {
      const longSummary = 'a'.repeat(250);
      const longBody = 'b'.repeat(400);
      const msg = buildClassificationUserMessage(
        { subject: longSummary, body: longBody },
        resolveInstalled(AVAILABLE),
      );
      const parsed = JSON.parse(msg) as Record<string, string>;
      expect(parsed.summary).toHaveLength(200);
      expect(parsed.body_preview).toHaveLength(300);
    });
  });

  describe('PERSONA_CLASSIFY_RESPONSE_SCHEMA', () => {
    it('has required fields matching Python', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.required).toContain('primary');
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.required).toContain('confidence');
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.required).toContain('reason');
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.required).toContain('has_event');
    });

    it('defines primary as string', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.primary.type).toBe('string');
    });

    it('defines secondary as array of strings', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.secondary.type).toBe('array');
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.secondary.items?.type).toBe('string');
    });

    it('defines has_event + event_hint', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.has_event.type).toBe('boolean');
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.event_hint.type).toBe('string');
    });
  });

  describe('createGeminiClassifier', () => {
    it('passes responseSchema to provider', async () => {
      const provider = mockProvider(
        JSON.stringify({
          primary: 'health',
          confidence: 0.9,
          reason: 'Blood test',
          has_event: false,
        }),
      );
      const classifier = createGeminiClassifier(provider, {
        resolveInstalledPersonas: resolveInstalled,
      });
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
          primary: 'health',
          confidence: 0.92,
          reason: 'Medical content',
          has_event: false,
        }),
      );
      const classifier = createGeminiClassifier(provider, {
        resolveInstalledPersonas: resolveInstalled,
      });
      const result = await classifier({ subject: 'Lab results' }, AVAILABLE);
      expect(result.persona).toBe('health');
      expect(result.confidence).toBe(0.92);
    });

    it('uses low temperature for deterministic classification', async () => {
      const provider = mockProvider(
        JSON.stringify({
          primary: 'general',
          confidence: 0.5,
          reason: 'test',
          has_event: false,
        }),
      );
      const classifier = createGeminiClassifier(provider, {
        resolveInstalledPersonas: resolveInstalled,
      });
      await classifier({}, AVAILABLE);

      expect(provider.chat).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ temperature: 0.1 }),
      );
    });

    it('sends system + user messages (Python parity — no substitution)', async () => {
      const provider = mockProvider(
        JSON.stringify({
          primary: 'general',
          confidence: 0.9,
          reason: 'ok',
          has_event: false,
        }),
      );
      const classifier = createGeminiClassifier(provider, {
        resolveInstalledPersonas: resolveInstalled,
      });
      await classifier({ subject: 'hi' }, AVAILABLE);

      const [messages] = (provider.chat as jest.Mock).mock.calls[0];
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('system');
      expect(messages[1].role).toBe('user');
      const userBlob = JSON.parse(messages[1].content) as Record<string, unknown>;
      expect(userBlob.available_personas).toBeDefined();
      expect(userBlob.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('createGenericClassifier', () => {
    it('does NOT pass responseSchema', async () => {
      const provider = mockProvider(
        JSON.stringify({
          primary: 'financial',
          confidence: 0.8,
          reason: 'Money topics',
          has_event: false,
        }),
      );
      const classifier = createGenericClassifier(provider, {
        resolveInstalledPersonas: resolveInstalled,
      });
      await classifier({ subject: 'Invoice' }, AVAILABLE);

      const callOptions = (provider.chat as jest.Mock).mock.calls[0][1];
      expect(callOptions.responseSchema).toBeUndefined();
    });

    it('returns parsed result from free-form JSON', async () => {
      const provider = mockProvider(
        JSON.stringify({
          primary: 'financial',
          confidence: 0.85,
          reason: 'Invoice content',
          has_event: false,
        }),
      );
      const classifier = createGenericClassifier(provider, {
        resolveInstalledPersonas: resolveInstalled,
      });
      const result = await classifier({ subject: 'Invoice #123' }, AVAILABLE);
      expect(result.persona).toBe('financial');
    });
  });
});
