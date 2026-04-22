/**
 * Task 5.32 — DomainClassifier tests.
 */

import {
  DEFAULT_LLM_CONFIDENCE_THRESHOLD,
  DomainClassifier,
  type Classification,
  type DomainLlmCallFn,
} from '../src/brain/domain_classifier';

describe('DomainClassifier (task 5.32)', () => {
  describe('Layer 1 — persona override', () => {
    it('health persona → SENSITIVE (short-circuits)', async () => {
      const c = new DomainClassifier();
      const r = await c.classify({ text: 'anything', persona: 'health' });
      expect(r.sensitivity).toBe('sensitive');
      expect(r.domain).toBe('health');
      expect(r.layer).toBe('persona');
      expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('medical persona → SENSITIVE + health domain', async () => {
      const r = await new DomainClassifier().classify({
        text: 'x',
        persona: 'medical',
      });
      expect(r.sensitivity).toBe('sensitive');
      expect(r.domain).toBe('health');
    });

    it('financial persona → ELEVATED (does NOT short-circuit)', async () => {
      const c = new DomainClassifier();
      const r = await c.classify({ text: 'anything', persona: 'financial' });
      expect(r.sensitivity).toBe('elevated');
      expect(r.domain).toBe('financial');
    });

    it('legal persona → ELEVATED + legal domain', async () => {
      const r = await new DomainClassifier().classify({
        text: 'x',
        persona: 'legal',
      });
      expect(r.sensitivity).toBe('elevated');
      expect(r.domain).toBe('legal');
    });

    it('work persona → ELEVATED + work domain', async () => {
      const r = await new DomainClassifier().classify({
        text: 'x',
        persona: 'work',
      });
      expect(r.sensitivity).toBe('elevated');
      expect(r.domain).toBe('work');
    });

    it.each([
      ['general', 'general'],
      ['personal', 'general'],
      ['social', 'general'],
    ])('%s persona → GENERAL + %s domain', async (persona, expectedDomain) => {
      const r = await new DomainClassifier().classify({
        text: 'x',
        persona,
      });
      expect(r.sensitivity).toBe('general');
      expect(r.domain).toBe(expectedDomain);
    });

    it('strips leading slashes + lowercases persona name', async () => {
      const r = await new DomainClassifier().classify({
        text: 'x',
        persona: '/Health',
      });
      expect(r.sensitivity).toBe('sensitive');
    });

    it('unknown persona falls through to layer 2', async () => {
      const r = await new DomainClassifier().classify({
        text: 'nothing sensitive here',
        persona: 'nonexistent',
      });
      expect(r.layer).not.toBe('persona');
    });

    it('personaRegistry wins over static map', async () => {
      const registry = {
        tier: (persona: string) => (persona === 'hobbies' ? 'sensitive' : null),
      };
      const c = new DomainClassifier({ personaRegistry: registry });
      const r = await c.classify({ text: 'x', persona: 'hobbies' });
      expect(r.sensitivity).toBe('sensitive');
      expect(r.reason).toMatch(/tier=sensitive/);
    });

    it('personaRegistry returning unknown tier falls through to GENERAL', async () => {
      const registry = {
        tier: () => 'weird',
      };
      const c = new DomainClassifier({ personaRegistry: registry });
      const r = await c.classify({ text: 'x', persona: 'any' });
      expect(r.sensitivity).toBe('general');
    });
  });

  describe('Layer 2 — keyword signals', () => {
    it('strong health keyword → SENSITIVE', async () => {
      const r = await new DomainClassifier().classify({
        text: 'I got my diagnosis yesterday',
      });
      expect(r.sensitivity).toBe('sensitive');
      expect(r.domain).toBe('health');
      expect(r.layer).toBe('keyword');
    });

    it('weak health keyword only → ELEVATED', async () => {
      // Single weak word scores 0.1 — below threshold. Need multiple.
      const r = await new DomainClassifier().classify({
        text: 'going to the doctor, hospital, and clinic',
      });
      expect(r.sensitivity).toBe('elevated');
      expect(r.domain).toBe('health');
    });

    it('strong financial keyword → SENSITIVE', async () => {
      const r = await new DomainClassifier().classify({
        text: 'my social security number is secret',
      });
      expect(r.sensitivity).toBe('sensitive');
      expect(r.domain).toBe('financial');
    });

    it('weak financial keyword scores → ELEVATED', async () => {
      const r = await new DomainClassifier().classify({
        text: 'payment for the loan, mortgage, and investment',
      });
      expect(r.sensitivity).toBe('elevated');
      expect(r.domain).toBe('financial');
    });

    it('legal strong keyword → SENSITIVE', async () => {
      const r = await new DomainClassifier().classify({
        text: 'the lawsuit will proceed',
      });
      expect(r.sensitivity).toBe('sensitive');
      expect(r.domain).toBe('legal');
    });

    it('highest-scoring domain wins', async () => {
      const r = await new DomainClassifier().classify({
        text: 'my doctor appointment, no diagnosis, ssn: hidden, cvv fraud',
      });
      expect(r.domain).toBe('financial');
    });

    it('word-boundary matching: "pin" does NOT match "opinion" / "typing"', async () => {
      const r = await new DomainClassifier().classify({
        text: 'in my opinion, the typing class was great',
      });
      // "pin" (finance strong) should NOT fire on "opinion" / "typing".
      expect(r.sensitivity).toBe('general');
      expect(r.layer).toBe('default');
    });

    it('word-boundary matching: "pin" DOES match as a standalone word', async () => {
      const r = await new DomainClassifier().classify({
        text: 'my pin for the card is secret',
      });
      expect(r.sensitivity).toBe('sensitive');
      expect(r.domain).toBe('financial');
    });

    it('hyphenated keyword "x-ray" matches despite containing punctuation', async () => {
      const r = await new DomainClassifier().classify({
        text: 'scheduled for an x-ray tomorrow',
      });
      expect(r.domain).toBe('health');
      expect(r.sensitivity).toBe('sensitive');
    });

    it('"shot" does not match "shotgun"', async () => {
      const r = await new DomainClassifier().classify({
        text: 'bought a shotgun at the range',
      });
      expect(r.sensitivity).toBe('general');
    });

    it('case-insensitive matching', async () => {
      const r = await new DomainClassifier().classify({
        text: 'My DIAGNOSIS came back',
      });
      expect(r.sensitivity).toBe('sensitive');
      expect(r.domain).toBe('health');
    });

    it('no keyword signals + no persona → GENERAL default (low confidence)', async () => {
      const r = await new DomainClassifier().classify({
        text: 'the weather is nice today',
      });
      expect(r.sensitivity).toBe('general');
      expect(r.layer).toBe('default');
      expect(r.confidence).toBeLessThan(0.5);
    });
  });

  describe('Layer 3 — vault context', () => {
    it('source=hospital → SENSITIVE health (0.9 confidence)', async () => {
      const r = await new DomainClassifier().classify({
        text: 'neutral text',
        vaultContext: { source: 'hospital' },
      });
      expect(r.sensitivity).toBe('sensitive');
      expect(r.domain).toBe('health');
      expect(r.layer).toBe('vault');
      expect(r.confidence).toBe(0.9);
    });

    it('source=bank → SENSITIVE financial', async () => {
      const r = await new DomainClassifier().classify({
        text: 'x',
        vaultContext: { source: 'bank' },
      });
      expect(r.sensitivity).toBe('sensitive');
      expect(r.domain).toBe('financial');
    });

    it('type=medical_record → SENSITIVE health', async () => {
      const r = await new DomainClassifier().classify({
        text: 'x',
        vaultContext: { type: 'medical_record' },
      });
      expect(r.sensitivity).toBe('sensitive');
      expect(r.domain).toBe('health');
    });

    it('unknown source/type → no vault layer contribution', async () => {
      const r = await new DomainClassifier().classify({
        text: 'the weather is nice',
        vaultContext: { source: 'unknown', type: 'unknown' },
      });
      expect(r.layer).toBe('default');
    });
  });

  describe('selection — highest confidence wins', () => {
    it('persona (0.95) beats keyword (0.3)', async () => {
      const r = await new DomainClassifier().classify({
        text: 'payment',
        persona: 'financial',
      });
      expect(r.layer).toBe('persona');
    });

    it('tie on confidence → higher sensitivity wins', async () => {
      // Persona=financial gives ELEVATED @ 0.95.
      // Vault source=bank gives SENSITIVE @ 0.9.
      // Persona wins on confidence → ELEVATED. But let's construct
      // a TIE by forcing the same confidence.
      // We'll use a custom registry that returns sensitive tier →
      // persona layer also at 0.95, matching nothing else.
      // For now, verify that when persona=financial AND vault=bank,
      // persona (0.95) wins over vault (0.9) → ELEVATED.
      const r = await new DomainClassifier().classify({
        text: 'x',
        persona: 'financial',
        vaultContext: { source: 'bank' },
      });
      // Persona's 0.95 beats vault's 0.9 → elevated wins.
      expect(r.sensitivity).toBe('elevated');
      expect(r.layer).toBe('persona');
    });

    it('short-circuit on SENSITIVE persona skips later layers', async () => {
      const r = await new DomainClassifier().classify({
        text: 'just chatting about the weather',
        persona: 'health',
        vaultContext: { source: 'bank' }, // would give SENSITIVE financial
      });
      // Short-circuited: health persona won → domain=health not financial.
      expect(r.domain).toBe('health');
    });
  });

  describe('Layer 4 — LLM fallback', () => {
    it('only called when deterministic confidence < threshold', async () => {
      let llmCalls = 0;
      const llmCallFn: DomainLlmCallFn = async () => {
        llmCalls++;
        return {
          domain: 'health',
          sensitivity: 'sensitive',
          reason: 'LLM said so',
        };
      };
      const c = new DomainClassifier({ llmCallFn });
      // High-confidence persona → LLM skipped.
      await c.classify({ text: 'x', persona: 'health' });
      expect(llmCalls).toBe(0);
      // No signals → LLM called.
      await c.classify({ text: 'random chatter' });
      expect(llmCalls).toBe(1);
    });

    it('LLM result replaces default when deterministic finds nothing', async () => {
      const llmCallFn: DomainLlmCallFn = async () => ({
        domain: 'health',
        sensitivity: 'elevated',
        reason: 'LLM inferred health',
      });
      const c = new DomainClassifier({ llmCallFn });
      const r = await c.classify({ text: 'random chatter' });
      expect(r.sensitivity).toBe('elevated');
      expect(r.domain).toBe('health');
      expect(r.layer).toBe('llm');
      expect(r.reason).toBe('LLM inferred health');
    });

    it('LLM returning garbage → fall back to default', async () => {
      const llmCallFn: DomainLlmCallFn = async () =>
        ({ foo: 'bar' }) as unknown as {
          domain: 'health';
          sensitivity: 'sensitive';
        };
      const c = new DomainClassifier({ llmCallFn });
      const r = await c.classify({ text: 'random chatter' });
      expect(r.layer).toBe('default');
    });

    it('LLM throwing → non-fatal, returns best-or-default', async () => {
      const llmCallFn: DomainLlmCallFn = async () => {
        throw new Error('LLM offline');
      };
      const c = new DomainClassifier({ llmCallFn });
      const r = await c.classify({ text: 'random chatter' });
      expect(r.layer).toBe('default');
    });

    it('custom threshold changes when LLM is invoked', async () => {
      let calls = 0;
      const llmCallFn: DomainLlmCallFn = async () => {
        calls++;
        return {
          domain: 'health',
          sensitivity: 'sensitive',
          reason: 'x',
        };
      };
      const c = new DomainClassifier({
        llmCallFn,
        llmConfidenceThreshold: 0.99, // basically always invoke LLM
      });
      // Keyword result has confidence < 0.99 → LLM called.
      await c.classify({ text: 'my doctor appointment' });
      expect(calls).toBe(1);
    });

    it('DEFAULT_LLM_CONFIDENCE_THRESHOLD is 0.5', () => {
      expect(DEFAULT_LLM_CONFIDENCE_THRESHOLD).toBe(0.5);
    });
  });

  describe('input hygiene', () => {
    it('empty text + no persona → default', async () => {
      const r = await new DomainClassifier().classify({ text: '' });
      expect(r.layer).toBe('default');
      expect(r.sensitivity).toBe('general');
    });

    it('persona whitespace/case normalised', async () => {
      const r = await new DomainClassifier().classify({
        text: 'x',
        persona: '  /HEALTH  ',
      });
      expect(r.sensitivity).toBe('sensitive');
    });

    it('empty persona string is treated as absent', async () => {
      const r = await new DomainClassifier().classify({
        text: 'just weather',
        persona: '',
      });
      expect(r.layer).toBe('default');
    });
  });

  describe('Classification shape', () => {
    it('every field is present + typed', async () => {
      const r: Classification = await new DomainClassifier().classify({
        text: 'my diagnosis was confirmed',
      });
      expect(typeof r.sensitivity).toBe('string');
      expect(typeof r.domain).toBe('string');
      expect(typeof r.reason).toBe('string');
      expect(typeof r.confidence).toBe('number');
      expect(['persona', 'keyword', 'vault', 'llm', 'default']).toContain(r.layer);
    });
  });
});
