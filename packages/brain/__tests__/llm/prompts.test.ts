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
    it('has exactly 13 prompts', () => {
      expect(PROMPT_NAMES.length).toBe(13);
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
      'VAULT_CONTEXT',
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
    // As of the Python-parity port the prompt is a pure system
    // message — no `{{placeholder}}` slots. Callers build the user
    // message as a JSON blob (see `gemini_classify.ts`) so the
    // prompt + schema pair stays byte-identical to Python.
    it('is placeholder-free', () => {
      expect(PERSONA_CLASSIFY).not.toMatch(/\{\{[^}]+\}\}/);
    });

    it('anchors the primary-purpose routing principle', () => {
      expect(PERSONA_CLASSIFY).toMatch(/primary purpose/i);
    });

    it('describes the five-persona mapping (general/work/health/finance/general)', () => {
      expect(PERSONA_CLASSIFY).toContain('→ general');
      expect(PERSONA_CLASSIFY).toContain('→ work');
      expect(PERSONA_CLASSIFY).toContain('→ health');
      expect(PERSONA_CLASSIFY).toContain('→ finance');
    });

    it('documents data_responsibility overrides', () => {
      expect(PERSONA_CLASSIFY).toContain('data_responsibility=household');
      expect(PERSONA_CLASSIFY).toContain('data_responsibility=care');
      expect(PERSONA_CLASSIFY).toContain('data_responsibility=external');
    });

    it('instructs primary/secondary/has_event JSON output shape', () => {
      expect(PERSONA_CLASSIFY).toContain('"primary"');
      expect(PERSONA_CLASSIFY).toContain('"secondary"');
      expect(PERSONA_CLASSIFY).toContain('"confidence"');
      expect(PERSONA_CLASSIFY).toContain('"has_event"');
      expect(PERSONA_CLASSIFY).toContain('"event_hint"');
    });

    it('includes "do NOT invent" guard rail', () => {
      expect(PERSONA_CLASSIFY).toMatch(/do not invent/i);
    });
  });

  describe('PERSONA_CLASSIFY_RESPONSE_SCHEMA', () => {
    it('is a valid JSON schema object', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.type).toBe('object');
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties).toBeDefined();
    });

    it('has required fields: primary, confidence, reason, has_event', () => {
      const required = PERSONA_CLASSIFY_RESPONSE_SCHEMA.required;
      expect(required).toContain('primary');
      expect(required).toContain('confidence');
      expect(required).toContain('reason');
      expect(required).toContain('has_event');
    });

    it('defines primary as string', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.primary.type).toBe('string');
    });

    it('defines confidence as number', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.confidence.type).toBe('number');
    });

    it('defines secondary as array of strings (multi-persona fan-out)', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.secondary).toBeDefined();
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.secondary.type).toBe('array');
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.secondary.items?.type).toBe('string');
    });

    it('includes has_event and event_hint fields', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.has_event.type).toBe('boolean');
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.event_hint.type).toBe('string');
    });

    it('includes attribution_corrections array', () => {
      expect(PERSONA_CLASSIFY_RESPONSE_SCHEMA.properties.attribution_corrections?.type).toBe(
        'array',
      );
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
    // Port to Python's PROMPT_GUARD_SCAN_SYSTEM shape (byte-identical).
    // The scanner in `reasoning/guard_scanner.ts` reads the categories
    // off `anti_her_sentences` / `unsolicited_sentences` / etc. — drift
    // here breaks the post-process wiring.
    it('contains {{prompt}} and {{numbered_content}} placeholders', () => {
      expect(GUARD_SCAN).toContain('{{prompt}}');
      expect(GUARD_SCAN).toContain('{{numbered_content}}');
    });

    it('defines the four violation-category arrays', () => {
      expect(GUARD_SCAN).toContain('"anti_her_sentences"');
      expect(GUARD_SCAN).toContain('"unsolicited_sentences"');
      expect(GUARD_SCAN).toContain('"fabricated_sentences"');
      expect(GUARD_SCAN).toContain('"consensus_sentences"');
    });

    it('instructs integer-index sentence labelling', () => {
      expect(GUARD_SCAN).toMatch(/only\s+integer\s+indices/i);
      expect(GUARD_SCAN).toContain('[N]');
    });

    it('includes the "never unsolicited" nuance', () => {
      expect(GUARD_SCAN).toMatch(/NEVER unsolicited/i);
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
    it('contains "what is now" placeholders', () => {
      // Lineage: {{event_date}} → {{today}} → {{now_local}} +
      // {{now_ms_grouped}}. Localised string drives the LLM's
      // year-bump/past-birthday reasoning; underscored Unix-ms is the
      // arithmetic anchor that survives PII scrubbing (the bare 13-digit
      // form was getting masked as a phone number — see commit notes).
      expect(REMINDER_PLAN).toContain('{{now_local}}');
      expect(REMINDER_PLAN).toContain('{{now_ms_grouped}}');
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

    it('includes consolidation rule for arrivals (Python parity)', () => {
      // Python phrasing: "create ONE reminder that includes ALL relevant
      // context about that person from the vault" — no "Consolidation"
      // header keyword.
      expect(REMINDER_PLAN).toContain('ONE reminder');
      expect(REMINDER_PLAN).toContain('ALL relevant context');
    });

    it('carries the canonical Alonso arrival example (capabilities.md spec)', () => {
      // Pinning the verbatim example so prompt edits that drop it
      // surface in code review.
      expect(REMINDER_PLAN).toContain('Alonso is arriving');
      expect(REMINDER_PLAN).toContain('cold brew coffee');
    });

    it('exposes arrival as a valid kind for the LLM to choose', () => {
      // No per-scenario rule for lead time — we trust the reasoning
      // model to pick a sensible fire time from the event content +
      // vault context. Just expose the kind so the type system stays
      // honest with what the deterministic extractor produces.
      expect(REMINDER_PLAN).toContain('arrival');
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
    // Python parity port (April 2026): the Python prompt is the SOURCE
    // OF TRUTH and is sent as a SYSTEM message with the user text as
    // a separate USER message — there's no `{{text}}` placeholder.

    it('does NOT use a {{text}} placeholder (Python two-message pattern)', () => {
      expect(PERSON_IDENTITY_EXTRACTION).not.toContain('{{text}}');
    });

    it('defines identity_links output format including role_phrase', () => {
      expect(PERSON_IDENTITY_EXTRACTION).toContain('"identity_links"');
      expect(PERSON_IDENTITY_EXTRACTION).toContain('"name"');
      // Python parity — `role_phrase` is the verbatim relationship
      // string ("my brother") that drives the people-graph's
      // role-phrase exclusivity invariant. Pinning it here so a
      // prompt edit that drops the field shows up in code review.
      expect(PERSON_IDENTITY_EXTRACTION).toContain('"role_phrase"');
      expect(PERSON_IDENTITY_EXTRACTION).toContain('"relationship"');
      expect(PERSON_IDENTITY_EXTRACTION).toContain('"evidence"');
    });

    it('lists valid relationship types from the Python enum', () => {
      // Python: child|spouse|parent|sibling|friend|colleague|other
      expect(PERSON_IDENTITY_EXTRACTION).toContain('child');
      expect(PERSON_IDENTITY_EXTRACTION).toContain('spouse');
      expect(PERSON_IDENTITY_EXTRACTION).toContain('parent');
      expect(PERSON_IDENTITY_EXTRACTION).toContain('sibling');
      expect(PERSON_IDENTITY_EXTRACTION).toContain('friend');
      expect(PERSON_IDENTITY_EXTRACTION).toContain('colleague');
      expect(PERSON_IDENTITY_EXTRACTION).toContain('other');
    });

    it('instructs to extract only IDENTITY statements (Python phrasing)', () => {
      // Python: "Only extract IDENTITY statements: ..."
      expect(PERSON_IDENTITY_EXTRACTION).toMatch(/only\s+extract\s+identity/i);
    });

    it('blocks third-party relationship extraction (Python rule)', () => {
      // Python explicitly excludes "Sancho's daughter Emma" — a
      // relationship between two other people, not the user.
      expect(PERSON_IDENTITY_EXTRACTION).toMatch(/between two other people/i);
    });

    it('returns empty identity_links when no statements found', () => {
      expect(PERSON_IDENTITY_EXTRACTION).toContain('"identity_links": []');
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
