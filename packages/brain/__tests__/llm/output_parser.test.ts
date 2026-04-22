/**
 * T3.9 — Structured output parser: LLM JSON validation with fallback.
 *
 * Source: ARCHITECTURE.md Task 3.9
 */

import {
  extractJSON,
  parseClassification,
  parseEnrichment,
  parseReminderPlan,
  parseSilence,
} from '../../src/llm/output_parser';

describe('Structured Output Parser', () => {
  describe('extractJSON', () => {
    it('parses clean JSON', () => {
      const obj = extractJSON('{"key":"value"}');
      expect(obj).toEqual({ key: 'value' });
    });

    it('strips markdown fences', () => {
      const obj = extractJSON('```json\n{"key":"value"}\n```');
      expect(obj).toEqual({ key: 'value' });
    });

    it('strips fences without language tag', () => {
      const obj = extractJSON('```\n{"key":"value"}\n```');
      expect(obj).toEqual({ key: 'value' });
    });

    it('extracts JSON from surrounding text', () => {
      const obj = extractJSON(
        'Here is my answer: {"persona":"health","confidence":0.9} Hope this helps!',
      );
      expect(obj).toEqual({ persona: 'health', confidence: 0.9 });
    });

    it('returns null for invalid JSON', () => {
      expect(extractJSON('not json at all')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(extractJSON('')).toBeNull();
    });

    it('returns null for array (not object)', () => {
      expect(extractJSON('[1,2,3]')).toBeNull();
    });

    it('handles nested objects', () => {
      const obj = extractJSON('{"outer":{"inner":"value"}}');
      expect(obj).toEqual({ outer: { inner: 'value' } });
    });
  });

  describe('parseClassification', () => {
    it('parses valid classification', () => {
      const result = parseClassification(
        '{"persona":"health","confidence":0.92,"reason":"medical keywords"}',
      );
      expect(result.persona).toBe('health');
      expect(result.confidence).toBe(0.92);
      expect(result.reason).toBe('medical keywords');
    });

    it('defaults missing fields', () => {
      const result = parseClassification('{"persona":"work"}');
      expect(result.persona).toBe('work');
      expect(result.confidence).toBe(0);
      expect(result.reason).toBe('parse_fallback');
    });

    it('falls back entirely for invalid JSON', () => {
      const result = parseClassification('totally broken');
      expect(result.persona).toBe('general');
      expect(result.confidence).toBe(0);
    });

    it('rejects out-of-range confidence', () => {
      const result = parseClassification('{"persona":"general","confidence":5.0}');
      expect(result.confidence).toBe(0); // default
    });

    it('handles markdown-fenced output', () => {
      const result = parseClassification(
        '```json\n{"persona":"financial","confidence":0.85,"reason":"invoice"}\n```',
      );
      expect(result.persona).toBe('financial');
      expect(result.confidence).toBe(0.85);
    });
  });

  describe('parseEnrichment', () => {
    it('parses valid enrichment', () => {
      const result = parseEnrichment(
        '{"content_l1":"Detailed summary of the email","tags":["meeting","urgent"],"has_event":true}',
      );
      expect(result.content_l1).toBe('Detailed summary of the email');
      expect(result.tags).toEqual(['meeting', 'urgent']);
      expect(result.has_event).toBe(true);
    });

    it('defaults missing fields', () => {
      const result = parseEnrichment('{"content_l1":"Summary only"}');
      expect(result.content_l1).toBe('Summary only');
      expect(result.tags).toEqual([]);
      expect(result.has_event).toBe(false);
    });

    it('falls back for invalid JSON', () => {
      const result = parseEnrichment('broken');
      expect(result.content_l1).toBe('');
      expect(result.tags).toEqual([]);
    });

    it('rejects non-string tags', () => {
      const result = parseEnrichment('{"tags":[1,2,3]}');
      expect(result.tags).toEqual([]); // falls back to default
    });
  });

  describe('parseReminderPlan', () => {
    it('parses valid reminder plan', () => {
      const result = parseReminderPlan(
        '{"reminders":[{"message":"Birthday party","due_at":1700000000,"kind":"birthday"}]}',
      );
      expect(result.reminders).toHaveLength(1);
      expect(result.reminders[0].message).toBe('Birthday party');
      expect(result.reminders[0].kind).toBe('birthday');
    });

    it('filters out invalid reminders', () => {
      const result = parseReminderPlan(
        '{"reminders":[{"message":"Valid","due_at":100,"kind":"x"},{"message":"","due_at":0}]}',
      );
      expect(result.reminders).toHaveLength(1); // second filtered out
    });

    it('defaults kind to manual', () => {
      const result = parseReminderPlan('{"reminders":[{"message":"Test","due_at":100}]}');
      expect(result.reminders[0].kind).toBe('manual');
    });

    it('falls back for invalid JSON', () => {
      const result = parseReminderPlan('not json');
      expect(result.reminders).toEqual([]);
    });

    it('handles missing reminders key', () => {
      const result = parseReminderPlan('{"other":"data"}');
      expect(result.reminders).toEqual([]);
    });
  });

  describe('parseSilence', () => {
    it('parses valid silence classification', () => {
      const result = parseSilence(
        '{"priority":1,"reason":"security alert detected","confidence":0.95}',
      );
      expect(result.priority).toBe(1);
      expect(result.reason).toBe('security alert detected');
      expect(result.confidence).toBe(0.95);
    });

    it('defaults to Tier 3 (Silence First)', () => {
      const result = parseSilence('broken');
      expect(result.priority).toBe(3);
    });

    it('rejects invalid priority values', () => {
      const result = parseSilence('{"priority":5}');
      expect(result.priority).toBe(3); // default
    });

    it('clamps confidence to [0,1]', () => {
      const result = parseSilence('{"priority":1,"confidence":2.5}');
      expect(result.confidence).toBe(0); // default because out of range
    });
  });
});
