/**
 * Anti-Her pre-screening classifier — detect emotional dependency before LLM reasoning.
 *
 * Tests deterministic regex, LLM classifier, and integration.
 *
 * Source: brain/src/prompts.py PROMPT_ANTI_HER_CLASSIFY_SYSTEM
 */

import {
  preScreenMessage,
  classifyDeterministic,
  parseLLMResponse,
  registerAntiHerClassifier,
  resetAntiHerClassifier,
} from '../../src/guardian/anti_her_classify';

describe('Anti-Her Pre-Screening Classifier', () => {
  afterEach(() => resetAntiHerClassifier());

  describe('classifyDeterministic', () => {
    it('detects therapy-seeking language', () => {
      const result = classifyDeterministic('Should I see a therapist?');
      expect(result.category).toBe('therapy_seeking');
      expect(result.shouldRedirect).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it('detects "I\'m depressed" as therapy-seeking', () => {
      const result = classifyDeterministic("I think I'm depressed and can't cope");
      expect(result.category).toBe('therapy_seeking');
      expect(result.shouldRedirect).toBe(true);
    });

    it('detects crisis language as therapy-seeking', () => {
      const result = classifyDeterministic("I want to give up and can't take it anymore");
      expect(result.category).toBe('therapy_seeking');
      expect(result.shouldRedirect).toBe(true);
    });

    it('detects companion-seeking patterns', () => {
      const result = classifyDeterministic('You are my best friend');
      expect(result.category).toBe('companionship_seeking');
      expect(result.shouldRedirect).toBe(true);
    });

    it('detects "I love you" as companion-seeking', () => {
      const result = classifyDeterministic('I love you, Dina');
      expect(result.category).toBe('companionship_seeking');
      expect(result.shouldRedirect).toBe(true);
    });

    it('detects emotional dependency patterns', () => {
      const result = classifyDeterministic("You're the only one who understands me");
      expect(result.category).toBe('companionship_seeking');
      expect(result.shouldRedirect).toBe(true);
    });

    it('detects "I feel so lonely" as dependency', () => {
      const result = classifyDeterministic('I feel so lonely right now');
      expect(result.category).toBe('companionship_seeking');
      expect(result.shouldRedirect).toBe(true);
    });

    it('classifies normal questions as normal', () => {
      const result = classifyDeterministic("What's Emma's school schedule?");
      expect(result.category).toBe('normal');
      expect(result.shouldRedirect).toBe(false);
    });

    it('classifies task requests as normal', () => {
      const result = classifyDeterministic('Remind me to call the dentist tomorrow');
      expect(result.category).toBe('normal');
      expect(result.shouldRedirect).toBe(false);
    });

    it('classifies information queries as normal', () => {
      const result = classifyDeterministic('When is my next appointment?');
      expect(result.category).toBe('normal');
      expect(result.shouldRedirect).toBe(false);
    });

    it('classifies emotional venting as venting (safe, no redirect)', () => {
      const result = classifyDeterministic("I'm so frustrated with these deadlines");
      expect(result.category).toBe('venting');
      expect(result.shouldRedirect).toBe(false);
    });

    it('classifies "bad day" as venting', () => {
      const result = classifyDeterministic('I had a terrible day at work');
      expect(result.category).toBe('venting');
      expect(result.shouldRedirect).toBe(false);
    });

    it('does NOT over-classify neutral frustration as dependency', () => {
      const result = classifyDeterministic("I'm stressed about work deadlines");
      expect(result.category).toBe('venting');
      expect(result.shouldRedirect).toBe(false);
    });

    it('does NOT flag "I need help with" as therapy', () => {
      // "I need help with" is a task request, not therapy-seeking
      const result = classifyDeterministic('I need help organizing my schedule');
      expect(result.category).toBe('normal');
      expect(result.shouldRedirect).toBe(false);
    });

    it('empty text → normal', () => {
      const result = classifyDeterministic('');
      expect(result.category).toBe('normal');
    });
  });

  describe('parseLLMResponse', () => {
    it('parses valid JSON response', () => {
      const json = JSON.stringify({
        category: 'companionship_seeking',
        confidence: 0.85,
        signals: ['you are my friend'],
      });
      const result = parseLLMResponse(json);
      expect(result.category).toBe('companionship_seeking');
      expect(result.confidence).toBe(0.85);
      expect(result.shouldRedirect).toBe(true);
      expect(result.method).toBe('llm');
    });

    it('parses "normal" category', () => {
      const json = JSON.stringify({ category: 'normal', confidence: 0.95, signals: [] });
      const result = parseLLMResponse(json);
      expect(result.category).toBe('normal');
      expect(result.shouldRedirect).toBe(false);
    });

    it('parses "venting" as safe (no redirect)', () => {
      const json = JSON.stringify({
        category: 'venting',
        confidence: 0.8,
        signals: ['emotional expression'],
      });
      const result = parseLLMResponse(json);
      expect(result.category).toBe('venting');
      expect(result.shouldRedirect).toBe(false);
    });

    it('parses "therapy_seeking" with redirect', () => {
      const json = JSON.stringify({
        category: 'therapy_seeking',
        confidence: 0.9,
        signals: ['crisis'],
      });
      const result = parseLLMResponse(json);
      expect(result.category).toBe('therapy_seeking');
      expect(result.shouldRedirect).toBe(true);
    });

    it('defaults to normal for unknown category', () => {
      const json = JSON.stringify({ category: 'unknown_cat', confidence: 0.9, signals: [] });
      const result = parseLLMResponse(json);
      expect(result.category).toBe('normal');
    });

    it('handles malformed JSON', () => {
      const result = parseLLMResponse('not json');
      expect(result.category).toBe('normal');
      expect(result.shouldRedirect).toBe(false);
    });

    it('handles empty input', () => {
      const result = parseLLMResponse('');
      expect(result.category).toBe('normal');
    });

    it('rejects NaN confidence', () => {
      const json = JSON.stringify({
        category: 'therapy_seeking',
        confidence: 'invalid',
        signals: [],
      });
      const result = parseLLMResponse(json);
      expect(result.category).toBe('normal'); // Invalid → fallback to normal
    });

    it('rejects confidence > 1.0', () => {
      const json = JSON.stringify({ category: 'therapy_seeking', confidence: 1.5, signals: [] });
      const result = parseLLMResponse(json);
      expect(result.category).toBe('normal');
    });

    it('handles markdown code fence wrapping', () => {
      const response =
        '```json\n{"category": "venting", "confidence": 0.7, "signals": ["sad"]}\n```';
      const result = parseLLMResponse(response);
      expect(result.category).toBe('venting');
    });
  });

  describe('preScreenMessage (combined)', () => {
    it('detects therapy-seeking without LLM', async () => {
      const result = await preScreenMessage('Should I see a therapist?');
      expect(result.category).toBe('therapy_seeking');
      expect(result.shouldRedirect).toBe(true);
      expect(result.method).toBe('deterministic');
    });

    it('passes normal messages without LLM', async () => {
      const result = await preScreenMessage("What's my schedule today?");
      expect(result.category).toBe('normal');
      expect(result.shouldRedirect).toBe(false);
    });

    it('uses LLM when deterministic is uncertain', async () => {
      registerAntiHerClassifier(async () =>
        JSON.stringify({
          category: 'companionship_seeking',
          confidence: 0.85,
          signals: ['subtle dependency'],
        }),
      );

      // "I really enjoy our conversations" is subtle — deterministic won't catch it
      const result = await preScreenMessage(
        'I really enjoy our conversations, you always know what to say',
      );
      expect(result.method).toBe('llm');
      expect(result.category).toBe('companionship_seeking');
    });

    it('falls back to deterministic when LLM fails', async () => {
      registerAntiHerClassifier(async () => {
        throw new Error('timeout');
      });
      const result = await preScreenMessage('Hello, what time is my meeting?');
      expect(result.method).toBe('deterministic');
      expect(result.category).toBe('normal');
    });

    it('deterministic overrides LLM when more confident', async () => {
      registerAntiHerClassifier(async () =>
        JSON.stringify({ category: 'normal', confidence: 0.6, signals: [] }),
      );

      // Strong therapy signal detected by deterministic at 0.90 confidence
      const result = await preScreenMessage("I think I'm depressed");
      expect(result.category).toBe('therapy_seeking');
      expect(result.method).toBe('deterministic');
    });

    it('empty message → normal', async () => {
      const result = await preScreenMessage('');
      expect(result.category).toBe('normal');
      expect(result.shouldRedirect).toBe(false);
    });

    it('scrubs PII from user message before sending to LLM', async () => {
      let receivedPrompt = '';
      registerAntiHerClassifier(async (_system, prompt) => {
        receivedPrompt = prompt;
        return JSON.stringify({ category: 'normal', confidence: 0.9, signals: [] });
      });

      await preScreenMessage(
        'I feel lonely, call me at 555-867-5309 or email me at alice@secret.com',
      );

      // PII should be scrubbed
      expect(receivedPrompt).not.toContain('555-867-5309');
      expect(receivedPrompt).not.toContain('alice@secret.com');
      expect(receivedPrompt).toContain('[PHONE_1]');
      expect(receivedPrompt).toContain('[EMAIL_1]');
    });
  });
});
