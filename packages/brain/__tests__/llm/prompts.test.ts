/**
 * T3.8 — Prompt registry: all LLM prompts defined and renderable.
 *
 * Category A: fixture-based. Verifies all 8 prompts exist, have
 * correct placeholders, and renderPrompt substitutes correctly.
 *
 * Source: brain/src/prompts.py
 */

import {
  PROMPT_REGISTRY,
  PROMPT_NAMES,
  getPrompt,
  renderPrompt,
  PERSONA_CLASSIFY,
  PERSONA_CLASSIFY_RESPONSE_SCHEMA,
  CONTENT_ENRICH,
  SILENCE_CLASSIFY,
  GUARD_SCAN,
  ANTI_HER,
  ANTI_HER_CLASSIFY,
  REMINDER_PLAN,
  PERSON_IDENTITY_EXTRACTION,
  NUDGE_ASSEMBLE,
  CHAT_SYSTEM,
  PII_PRESERVE_INSTRUCTION,
  ENRICHMENT_LOW_TRUST_INSTRUCTION,
} from '../../src/llm/prompts';

describe('Prompt Registry', () => {
  describe('completeness', () => {
    it('has exactly 12 prompts', () => {
      expect(PROMPT_NAMES.length).toBe(12);
    });

    const expectedNames = [
      'PERSONA_CLASSIFY',
      'CONTENT_ENRICH',
      'SILENCE_CLASSIFY',
      'GUARD_SCAN',
      'ANTI_HER',
      'ANTI_HER_CLASSIFY',
      'REMINDER_PLAN',
      'NUDGE_ASSEMBLE',
      'PERSON_IDENTITY_EXTRACTION',
      'CHAT_SYSTEM',
      'PII_PRESERVE_INSTRUCTION',
      'ENRICHMENT_LOW_TRUST_INSTRUCTION',
    ];

    for (const name of expectedNames) {
      it(`includes "${name}"`, () => {
        expect(PROMPT_NAMES).toContain(name);
        expect(PROMPT_REGISTRY[name]).toBeTruthy();
      });
    }
  });

  describe('getPrompt', () => {
    it('returns prompt by name', () => {
      const prompt = getPrompt('PERSONA_CLASSIFY');
      expect(prompt).toBe(PERSONA_CLASSIFY);
    });

    it('throws for unknown prompt name', () => {
      expect(() => getPrompt('NONEXISTENT')).toThrow('unknown prompt');
    });
  });

  describe('renderPrompt', () => {
    it('substitutes single variable', () => {
      const result = renderPrompt('Hello {{name}}!', { name: 'Alice' });
      expect(result).toBe('Hello Alice!');
    });

    it('substitutes multiple variables', () => {
      const result = renderPrompt('{{type}} from {{sender}}', { type: 'Email', sender: 'Bob' });
      expect(result).toBe('Email from Bob');
    });

    it('throws on missing variable', () => {
      expect(() => renderPrompt('Hello {{name}}!', {})).toThrow('missing variable "{{name}}"');
    });

    it('leaves text without placeholders unchanged', () => {
      expect(renderPrompt('No placeholders here', {})).toBe('No placeholders here');
    });

    it('handles empty values', () => {
      expect(renderPrompt('Subject: {{subject}}', { subject: '' })).toBe('Subject: ');
    });
  });

  describe('PERSONA_CLASSIFY', () => {
    it('contains persona_list placeholder', () => {
      expect(PERSONA_CLASSIFY).toContain('{{persona_list}}');
    });

    it('contains item metadata placeholders', () => {
      expect(PERSONA_CLASSIFY).toContain('{{type}}');
      expect(PERSONA_CLASSIFY).toContain('{{source}}');
      expect(PERSONA_CLASSIFY).toContain('{{sender}}');
      expect(PERSONA_CLASSIFY).toContain('{{subject}}');
    });

    it('instructs JSON output format', () => {
      expect(PERSONA_CLASSIFY).toContain('"persona"');
      expect(PERSONA_CLASSIFY).toContain('"confidence"');
    });

    it('includes "NEVER invent" guard rail', () => {
      expect(PERSONA_CLASSIFY).toMatch(/never\s+invent/i);
    });
  });

  describe('PERSONA_CLASSIFY_RESPONSE_SCHEMA', () => {
    it('is a valid JSON schema object', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.type).toBe('object');
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties).toBeDefined();
    });

    it('has required fields: persona, confidence, reason', () => {
      const required = PERSONA_CLASSIFY_RESPONSE_SCHEMA.required;
      expect(required).toContain('persona');
      expect(required).toContain('confidence');
      expect(required).toContain('reason');
    });

    it('defines persona as string', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.persona.type).toBe('string');
    });

    it('defines confidence as number', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.confidence.type).toBe('number');
    });

    it('includes secondary persona field (optional)', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.secondary).toBeDefined();
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.secondary.type).toBe('string');
    });

    it('includes has_event and event_hint fields', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.has_event.type).toBe('boolean');
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.event_hint.type).toBe('string');
    });

    it('can be serialized to JSON for Gemini API', () => {
      const json = JSON.stringify(PERSONA_CLASSIFY_RESPONSE_SCHEMA);
      expect(() => JSON.parse(json)).not.toThrow();
    });
  });

  describe('CONTENT_ENRICH', () => {
    it('contains body placeholder', () => {
      expect(CONTENT_ENRICH).toContain('{{body}}');
    });

    it('defines L0 and L1 output', () => {
      expect(CONTENT_ENRICH).toContain('"l0"');
      expect(CONTENT_ENRICH).toContain('"l1"');
    });

    it('includes has_event field', () => {
      expect(CONTENT_ENRICH).toContain('"has_event"');
    });
  });

  describe('SILENCE_CLASSIFY', () => {
    it('defines three tiers', () => {
      expect(SILENCE_CLASSIFY).toContain('1 = Fiduciary');
      expect(SILENCE_CLASSIFY).toContain('2 = Solicited');
      expect(SILENCE_CLASSIFY).toContain('3 = Engagement');
    });

    it('references Silence First principle', () => {
      expect(SILENCE_CLASSIFY).toContain('Silence First');
    });
  });

  describe('GUARD_SCAN', () => {
    it('contains numbered_response placeholder', () => {
      expect(GUARD_SCAN).toContain('{{numbered_response}}');
    });

    it('lists all 6 violation types', () => {
      expect(GUARD_SCAN).toContain('Therapy simulation');
      expect(GUARD_SCAN).toContain('Engagement hooks');
      expect(GUARD_SCAN).toContain('Intimacy simulation');
      expect(GUARD_SCAN).toContain('Unsolicited recommendations');
      expect(GUARD_SCAN).toContain('Hallucinated trust');
      expect(GUARD_SCAN).toContain('Consensus claims');
    });

    it('instructs sentence-number indexing', () => {
      expect(GUARD_SCAN).toContain('sentence_indices');
      expect(GUARD_SCAN).toContain('0-based');
    });

    it('includes nuanced rules', () => {
      expect(GUARD_SCAN).toContain('NEVER unsolicited');
      expect(GUARD_SCAN).toContain('venting');
    });
  });

  describe('ANTI_HER', () => {
    it('references Law 2', () => {
      expect(ANTI_HER).toContain('Law 2');
    });

    it('contains contact_names placeholder', () => {
      expect(ANTI_HER).toContain('{{contact_names}}');
    });

    it('instructs redirect to real people', () => {
      expect(ANTI_HER).toMatch(/redirect/i);
    });
  });

  describe('REMINDER_PLAN', () => {
    it('contains event_date placeholder', () => {
      expect(REMINDER_PLAN).toContain('{{event_date}}');
    });

    it('defines reminder JSON output', () => {
      expect(REMINDER_PLAN).toContain('"reminders"');
      expect(REMINDER_PLAN).toContain('"due_at"');
    });

    it('contains vault_context placeholder', () => {
      expect(REMINDER_PLAN).toContain('{{vault_context}}');
    });

    it('contains timezone placeholder', () => {
      expect(REMINDER_PLAN).toContain('{{timezone}}');
    });

    it('includes anti-hallucination guard', () => {
      expect(REMINDER_PLAN).toContain('NEVER fabricate');
    });

    it('includes consolidation rule', () => {
      expect(REMINDER_PLAN).toContain('Consolidation');
    });
  });

  describe('NUDGE_ASSEMBLE', () => {
    it('contains contact_name placeholder', () => {
      expect(NUDGE_ASSEMBLE).toContain('{{contact_name}}');
    });

    it('includes "NEVER fabricate" guard rail', () => {
      expect(NUDGE_ASSEMBLE).toMatch(/never\s+fabricate/i);
    });

    it('supports null return for insufficient context', () => {
      expect(NUDGE_ASSEMBLE).toContain('null');
    });
  });

  describe('CHAT_SYSTEM', () => {
    it('contains vault_context placeholder', () => {
      expect(CHAT_SYSTEM).toContain('{{vault_context}}');
    });

    it('includes persona boundary rule', () => {
      expect(CHAT_SYSTEM).toContain('persona boundaries');
    });

    it('includes Law 2 reference', () => {
      expect(CHAT_SYSTEM).toContain('Law 2');
    });

    it('includes "NEVER invent" guard rail', () => {
      expect(CHAT_SYSTEM).toMatch(/never\s+invent/i);
    });
  });

  describe('PERSON_IDENTITY_EXTRACTION', () => {
    it('contains text placeholder', () => {
      expect(PERSON_IDENTITY_EXTRACTION).toContain('{{text}}');
    });

    it('defines identity_links output format', () => {
      expect(PERSON_IDENTITY_EXTRACTION).toContain('"identity_links"');
      expect(PERSON_IDENTITY_EXTRACTION).toContain('"name"');
      expect(PERSON_IDENTITY_EXTRACTION).toContain('"relationship"');
      expect(PERSON_IDENTITY_EXTRACTION).toContain('"evidence"');
    });

    it('lists valid relationship types', () => {
      expect(PERSON_IDENTITY_EXTRACTION).toContain('spouse');
      expect(PERSON_IDENTITY_EXTRACTION).toContain('child');
      expect(PERSON_IDENTITY_EXTRACTION).toContain('parent');
      expect(PERSON_IDENTITY_EXTRACTION).toContain('colleague');
    });

    it('instructs to extract only explicit statements', () => {
      expect(PERSON_IDENTITY_EXTRACTION).toMatch(/only\s+extract\s+explicit/i);
    });

    it('includes "NEVER fabricate" guard rail', () => {
      expect(PERSON_IDENTITY_EXTRACTION).toMatch(/never\s+fabricate/i);
    });

    it('returns empty array when no relationships found', () => {
      expect(PERSON_IDENTITY_EXTRACTION).toContain('empty array');
    });
  });

  describe('ANTI_HER_CLASSIFY', () => {
    it('contains user_message placeholder', () => {
      expect(ANTI_HER_CLASSIFY).toContain('{{user_message}}');
    });

    it('defines 4 classification categories', () => {
      expect(ANTI_HER_CLASSIFY).toContain('normal');
      expect(ANTI_HER_CLASSIFY).toContain('venting');
      expect(ANTI_HER_CLASSIFY).toContain('companionship_seeking');
      expect(ANTI_HER_CLASSIFY).toContain('therapy_seeking');
    });

    it('references Law 4', () => {
      expect(ANTI_HER_CLASSIFY).toContain('Law 4');
    });

    it('defaults to normal when uncertain', () => {
      expect(ANTI_HER_CLASSIFY).toMatch(/default\s+to\s+"normal"/i);
    });

    it('distinguishes venting from companionship', () => {
      expect(ANTI_HER_CLASSIFY).toContain('venting');
      expect(ANTI_HER_CLASSIFY).toContain('SAFE');
    });

    it('instructs JSON output with category, confidence, signals', () => {
      expect(ANTI_HER_CLASSIFY).toContain('"category"');
      expect(ANTI_HER_CLASSIFY).toContain('"confidence"');
      expect(ANTI_HER_CLASSIFY).toContain('"signals"');
    });
  });

  describe('PII_PRESERVE_INSTRUCTION', () => {
    it('instructs to preserve placeholder tokens', () => {
      expect(PII_PRESERVE_INSTRUCTION).toContain('[EMAIL_1]');
      expect(PII_PRESERVE_INSTRUCTION).toContain('[PHONE_1]');
    });

    it('includes "MUST" preserve directive', () => {
      expect(PII_PRESERVE_INSTRUCTION).toMatch(/must/i);
      expect(PII_PRESERVE_INSTRUCTION).toContain('Preserve every placeholder token EXACTLY');
    });

    it('includes example of correct vs wrong behavior', () => {
      expect(PII_PRESERVE_INSTRUCTION).toContain('WRONG');
    });

    it('warns against guessing real values', () => {
      expect(PII_PRESERVE_INSTRUCTION).toMatch(/never\s+attempt\s+to\s+guess/i);
    });
  });

  describe('ENRICHMENT_LOW_TRUST_INSTRUCTION', () => {
    it('instructs attribution for unverified claims', () => {
      expect(ENRICHMENT_LOW_TRUST_INSTRUCTION).toContain('According to the sender');
    });

    it('prohibits authoritative language', () => {
      expect(ENRICHMENT_LOW_TRUST_INSTRUCTION).toContain('Do NOT use authoritative language');
    });

    it('flags urgency language as misleading', () => {
      expect(ENRICHMENT_LOW_TRUST_INSTRUCTION).toContain('act now');
    });

    it('includes provenance warning header', () => {
      expect(ENRICHMENT_LOW_TRUST_INSTRUCTION).toContain('PROVENANCE WARNING');
    });
  });

  describe('all prompts are non-empty strings', () => {
    for (const [name, template] of Object.entries(PROMPT_REGISTRY)) {
      it(`${name} is a non-empty string`, () => {
        expect(typeof template).toBe('string');
        expect(template.length).toBeGreaterThan(50);
      });
    }
  });
});
