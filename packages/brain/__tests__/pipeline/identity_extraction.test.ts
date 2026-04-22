/**
 * Person identity extraction — deterministic + LLM relationship extraction.
 *
 * Tests regex patterns, LLM provider, merging, and error handling.
 */

import {
  extractIdentityLinks,
  extractDeterministic,
  parseLLMResponse,
  registerIdentityExtractor,
  resetIdentityExtractor,
  type IdentityLink,
} from '../../src/pipeline/identity_extraction';

describe('Person Identity Extraction', () => {
  afterEach(() => resetIdentityExtractor());

  describe('extractDeterministic', () => {
    it('extracts "X is my daughter" pattern', () => {
      const links = extractDeterministic('Emma is my daughter and she loves school.');
      expect(links).toHaveLength(1);
      expect(links[0].name).toBe('Emma');
      expect(links[0].relationship).toBe('child');
      expect(links[0].confidence).toBe('high');
      expect(links[0].method).toBe('deterministic');
    });

    it('extracts "X is my husband" pattern', () => {
      const links = extractDeterministic('John is my husband.');
      expect(links).toHaveLength(1);
      expect(links[0].name).toBe('John');
      expect(links[0].relationship).toBe('spouse');
    });

    it('extracts "my colleague Bob" pattern', () => {
      const links = extractDeterministic('I spoke with my colleague Bob about the project.');
      expect(links).toHaveLength(1);
      expect(links[0].name).toBe('Bob');
      expect(links[0].relationship).toBe('colleague');
    });

    it('extracts "X is my mother" pattern', () => {
      const links = extractDeterministic('Alice is my mother.');
      expect(links).toHaveLength(1);
      expect(links[0].name).toBe('Alice');
      expect(links[0].relationship).toBe('parent');
    });

    it('extracts "X is my brother" pattern', () => {
      const links = extractDeterministic('Tom is my brother.');
      expect(links).toHaveLength(1);
      expect(links[0].name).toBe('Tom');
      expect(links[0].relationship).toBe('sibling');
    });

    it('extracts "my friend Sarah" pattern', () => {
      const links = extractDeterministic('I went to lunch with my friend Sarah.');
      expect(links).toHaveLength(1);
      expect(links[0].name).toBe('Sarah');
      expect(links[0].relationship).toBe('friend');
    });

    it('extracts multiple relationships from one text', () => {
      const text = 'Emma is my daughter. John is my husband. Alice is my mother.';
      const links = extractDeterministic(text);
      expect(links).toHaveLength(3);
      const names = links.map((l) => l.name);
      expect(names).toContain('Emma');
      expect(names).toContain('John');
      expect(names).toContain('Alice');
    });

    it('deduplicates same name mentioned multiple times', () => {
      const text = 'Emma is my daughter. Emma is my daughter and she is 5.';
      const links = extractDeterministic(text);
      expect(links).toHaveLength(1);
    });

    it('returns empty for text with no relationship patterns', () => {
      const links = extractDeterministic('I went to the grocery store today.');
      expect(links).toHaveLength(0);
    });

    it('returns empty for empty text', () => {
      expect(extractDeterministic('')).toHaveLength(0);
    });

    it('includes evidence (matched phrase)', () => {
      const links = extractDeterministic('Emma is my daughter.');
      expect(links[0].evidence).toContain('Emma');
      expect(links[0].evidence).toContain('daughter');
    });

    it('handles two-word names', () => {
      const links = extractDeterministic('Mary Jane is my sister.');
      expect(links).toHaveLength(1);
      expect(links[0].name).toBe('Mary Jane');
    });
  });

  describe('parseLLMResponse', () => {
    it('parses valid JSON response', () => {
      const json = JSON.stringify({
        identity_links: [
          {
            name: 'Emma',
            relationship: 'child',
            confidence: 'high',
            evidence: 'Emma is my daughter',
          },
        ],
      });
      const links = parseLLMResponse(json);
      expect(links).toHaveLength(1);
      expect(links[0].name).toBe('Emma');
      expect(links[0].relationship).toBe('child');
      expect(links[0].method).toBe('llm');
    });

    it('handles markdown code fence wrapping', () => {
      const response =
        '```json\n{"identity_links": [{"name": "Bob", "relationship": "friend", "confidence": "medium", "evidence": "friend Bob"}]}\n```';
      const links = parseLLMResponse(response);
      expect(links).toHaveLength(1);
      expect(links[0].name).toBe('Bob');
    });

    it('normalizes relationship synonyms', () => {
      const json = JSON.stringify({
        identity_links: [
          { name: 'Jane', relationship: 'wife', confidence: 'high', evidence: 'wife Jane' },
          { name: 'Tom', relationship: 'son', confidence: 'high', evidence: 'son Tom' },
          { name: 'Bob', relationship: 'boss', confidence: 'medium', evidence: 'boss Bob' },
        ],
      });
      const links = parseLLMResponse(json);
      expect(links[0].relationship).toBe('spouse');
      expect(links[1].relationship).toBe('child');
      expect(links[2].relationship).toBe('colleague');
    });

    it('returns empty for malformed JSON', () => {
      expect(parseLLMResponse('not json')).toHaveLength(0);
    });

    it('returns empty for empty input', () => {
      expect(parseLLMResponse('')).toHaveLength(0);
    });

    it('filters out links with empty names', () => {
      const json = JSON.stringify({
        identity_links: [
          { name: '', relationship: 'friend', confidence: 'high', evidence: '' },
          { name: 'Alice', relationship: 'sibling', confidence: 'high', evidence: 'sister Alice' },
        ],
      });
      const links = parseLLMResponse(json);
      expect(links).toHaveLength(1);
      expect(links[0].name).toBe('Alice');
    });

    it('defaults to unknown relationship for invalid types', () => {
      const json = JSON.stringify({
        identity_links: [
          { name: 'Zara', relationship: 'pet_owner', confidence: 'high', evidence: 'Zara' },
        ],
      });
      const links = parseLLMResponse(json);
      expect(links[0].relationship).toBe('unknown');
    });
  });

  describe('extractIdentityLinks (combined)', () => {
    it('uses deterministic only when no LLM registered', async () => {
      const result = await extractIdentityLinks('Emma is my daughter.');
      expect(result.method).toBe('deterministic');
      expect(result.links).toHaveLength(1);
      expect(result.links[0].name).toBe('Emma');
    });

    it('merges deterministic and LLM results', async () => {
      registerIdentityExtractor(async () =>
        JSON.stringify({
          identity_links: [
            {
              name: 'Emma',
              relationship: 'child',
              confidence: 'high',
              evidence: 'Emma is my daughter',
            },
            { name: 'Bob', relationship: 'friend', confidence: 'medium', evidence: 'friend Bob' },
          ],
        }),
      );

      // Emma found by both deterministic and LLM — deterministic wins
      // Bob found only by LLM — added
      const result = await extractIdentityLinks('Emma is my daughter. Bob helped me move.');
      expect(result.method).toBe('combined');
      expect(result.links).toHaveLength(2);

      const emma = result.links.find((l) => l.name === 'Emma')!;
      expect(emma.method).toBe('deterministic'); // deterministic takes priority

      const bob = result.links.find((l) => l.name === 'Bob')!;
      expect(bob.method).toBe('llm');
    });

    it('falls back to deterministic when LLM fails', async () => {
      registerIdentityExtractor(async () => {
        throw new Error('timeout');
      });

      const result = await extractIdentityLinks('Emma is my daughter.');
      expect(result.method).toBe('deterministic');
      expect(result.links).toHaveLength(1);
    });

    it('returns empty for empty text', async () => {
      const result = await extractIdentityLinks('');
      expect(result.links).toHaveLength(0);
    });

    it('returns empty for text with no relationships', async () => {
      const result = await extractIdentityLinks('I went shopping today.');
      expect(result.links).toHaveLength(0);
    });

    it('scrubs PII before sending text to LLM', async () => {
      let receivedPrompt = '';
      registerIdentityExtractor(async (_system, prompt) => {
        receivedPrompt = prompt;
        return JSON.stringify({ identity_links: [] });
      });

      await extractIdentityLinks(
        'Emma is my daughter. Her email is emma@family.com and phone is 555-999-1234.',
      );

      // Structured PII should be scrubbed (emails, phones)
      expect(receivedPrompt).not.toContain('emma@family.com');
      expect(receivedPrompt).not.toContain('555-999-1234');
      // Names are NOT scrubbed (by design — needed for relationship extraction)
      expect(receivedPrompt).toContain('Emma');
    });

    it('rehydrates PII tokens in LLM response', async () => {
      // Use text without explicit "X is my Y" pattern so LLM link wins the merge
      registerIdentityExtractor(async () =>
        JSON.stringify({
          identity_links: [
            {
              name: 'Priya',
              relationship: 'colleague',
              confidence: 'medium',
              evidence: 'Priya at [EMAIL_1]',
            },
          ],
        }),
      );

      const result = await extractIdentityLinks(
        'Priya works with me. Reach her at priya@work.com.',
      );
      // LLM found Priya (deterministic regex won't match "works with me" pattern)
      const priya = result.links.find((l) => l.name === 'Priya');
      expect(priya).toBeDefined();
      // Evidence should have [EMAIL_1] rehydrated to original email
      expect(priya!.evidence).toContain('priya@work.com');
      expect(priya!.evidence).not.toContain('[EMAIL_1]');
    });
  });
});
