/**
 * vault_context tests (GAP.md #30 closure).
 */

import type { Topic } from '../src/brain/topic_extractor';
import {
  DEFAULT_MAX_CHARS,
  assembleVaultContext,
  renderContextAsPrompt,
  type VaultContextContact,
  type VaultContextItem,
} from '../src/brain/vault_context';

function item(overrides: Partial<VaultContextItem> = {}): VaultContextItem {
  return {
    id: 'v1',
    summary: 'Short summary',
    timestamp: 1_700_000_000,
    type: 'email',
    source: 'gmail',
    ...overrides,
  };
}

describe('assembleVaultContext — input validation', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['string', 'bogus'],
  ] as const)('rejects %s input', (_l, bad) => {
    expect(() =>
      assembleVaultContext(bad as unknown as Parameters<typeof assembleVaultContext>[0]),
    ).toThrow(/input/);
  });

  it.each([
    ['', /persona/],
    ['   ', /persona/],
  ])('rejects empty persona', (persona, regex) => {
    expect(() =>
      assembleVaultContext({ persona, query: 'q' }),
    ).toThrow(regex);
  });

  it('rejects empty query', () => {
    expect(() =>
      assembleVaultContext({ persona: 'p', query: '  ' }),
    ).toThrow(/query/);
  });
});

describe('assembleVaultContext — basic shape', () => {
  it('minimal input produces persona + query sections', () => {
    const ctx = assembleVaultContext({ persona: 'general', query: 'what is up' });
    const kinds = ctx.sections.map((s) => s.kind);
    expect(kinds).toContain('persona');
    expect(kinds).toContain('query');
    expect(kinds).toContain('recent_items');
    expect(ctx.meta.persona).toBe('general');
    expect(ctx.meta.itemsIncluded).toBe(0);
    expect(ctx.meta.truncated).toBe(false);
  });

  it('body strings have chars pinned equal to section.chars', () => {
    const ctx = assembleVaultContext({ persona: 'p', query: 'q' });
    for (const s of ctx.sections) {
      expect(s.chars).toBe(s.body.length);
    }
  });

  it('persona + query bodies are trimmed', () => {
    const ctx = assembleVaultContext({ persona: '  work  ', query: '  hi  ' });
    const persona = ctx.sections.find((s) => s.kind === 'persona')!;
    const query = ctx.sections.find((s) => s.kind === 'query')!;
    expect(persona.body).toBe('work');
    expect(query.body).toBe('hi');
  });
});

describe('assembleVaultContext — optional inputs', () => {
  it('subject renders self/group/unknown/contact', () => {
    const s1 = assembleVaultContext({ persona: 'p', query: 'q', subject: { kind: 'self' } })
      .sections.find((s) => s.kind === 'subject')!;
    expect(s1.body).toBe('self (the user)');

    const s2 = assembleVaultContext({ persona: 'p', query: 'q', subject: { kind: 'group' } })
      .sections.find((s) => s.kind === 'subject')!;
    expect(s2.body).toBe('group (family/team)');

    const s3 = assembleVaultContext({ persona: 'p', query: 'q', subject: { kind: 'unknown' } })
      .sections.find((s) => s.kind === 'subject')!;
    expect(s3.body).toBe('unknown');

    const s4 = assembleVaultContext({
      persona: 'p', query: 'q',
      subject: { kind: 'contact', contactId: 'c-1' },
    }).sections.find((s) => s.kind === 'subject')!;
    expect(s4.body).toBe('contact:c-1');
  });

  it('tier is surfaced in meta + body', () => {
    const ctx = assembleVaultContext({ persona: 'p', query: 'q', tier: 'sensitive' });
    expect(ctx.meta.tier).toBe('sensitive');
    expect(ctx.sections.find((s) => s.kind === 'tier')!.body).toBe('sensitive');
  });

  it('topics ordered by salience desc + capped at topicLimit', () => {
    const topics: Array<Pick<Topic, 'label' | 'salience'>> = [
      { label: 'a', salience: 0.1 },
      { label: 'b', salience: 0.9 },
      { label: 'c', salience: 0.5 },
    ];
    const ctx = assembleVaultContext(
      { persona: 'p', query: 'q', topics },
      { topicLimit: 2 },
    );
    const body = ctx.sections.find((s) => s.kind === 'topics')!.body;
    const lines = body.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('b');
    expect(lines[1]).toContain('c');
    expect(lines[0]).toMatch(/\(0\.90\)/);
  });

  it('contacts render with relation + note', () => {
    const contacts: VaultContextContact[] = [
      { id: 'c1', name: 'Alice', relation: 'spouse', note: 'co-owner' },
      { id: 'c2', name: 'Bob' },
    ];
    const ctx = assembleVaultContext({ persona: 'p', query: 'q', contacts });
    const body = ctx.sections.find((s) => s.kind === 'contacts')!.body;
    expect(body).toContain('Alice (spouse) — co-owner');
    expect(body).toContain('Bob');
  });

  it('empty topic / contact arrays do not produce empty sections', () => {
    const ctx = assembleVaultContext({
      persona: 'p',
      query: 'q',
      topics: [],
      contacts: [],
    });
    const kinds = ctx.sections.map((s) => s.kind);
    expect(kinds).not.toContain('topics');
    expect(kinds).not.toContain('contacts');
  });
});

describe('assembleVaultContext — recent items + budget', () => {
  it('includes items up to itemLimit', () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      item({ id: `v${i}`, summary: `summary ${i}` }),
    );
    const ctx = assembleVaultContext(
      { persona: 'p', query: 'q', recentItems: items },
      { itemLimit: 3 },
    );
    expect(ctx.meta.itemsIncluded).toBe(3);
    const itemsBody = ctx.sections.find((s) => s.kind === 'recent_items')!.body;
    expect(itemsBody).toContain('[v0]');
    expect(itemsBody).toContain('[v1]');
    expect(itemsBody).toContain('[v2]');
    expect(itemsBody).not.toContain('[v3]');
  });

  it('respects maxChars budget — truncates oldest-first', () => {
    const big = 'x'.repeat(600);
    const items = Array.from({ length: 5 }, (_, i) =>
      item({ id: `v${i}`, summary: `summary ${i}`, body: big }),
    );
    const ctx = assembleVaultContext(
      { persona: 'p', query: 'q', recentItems: items },
      { maxChars: 1500, maxItemBodyChars: 600 },
    );
    expect(ctx.meta.truncated).toBe(true);
    expect(ctx.meta.itemsIncluded).toBeLessThan(items.length);
    expect(ctx.meta.totalChars).toBeLessThanOrEqual(1500);
  });

  it('DEFAULT_MAX_CHARS is 4000', () => {
    expect(DEFAULT_MAX_CHARS).toBe(4000);
  });

  it('body truncation respects maxItemBodyChars', () => {
    const long = 'y'.repeat(500);
    const ctx = assembleVaultContext(
      { persona: 'p', query: 'q', recentItems: [item({ body: long })] },
      { maxItemBodyChars: 100 },
    );
    const body = ctx.sections.find((s) => s.kind === 'recent_items')!.body;
    expect(body).toMatch(/y{1,100}…/);
  });

  it('item with no body still renders summary + header', () => {
    const ctx = assembleVaultContext({
      persona: 'p',
      query: 'q',
      recentItems: [item({ id: 'v1', summary: 'just summary' })],
    });
    const body = ctx.sections.find((s) => s.kind === 'recent_items')!.body;
    expect(body).toContain('[v1]');
    expect(body).toContain('just summary');
  });

  it('items rendered with ISO timestamp', () => {
    const ctx = assembleVaultContext({
      persona: 'p',
      query: 'q',
      recentItems: [item({ timestamp: 1_700_000_000 })],
    });
    const body = ctx.sections.find((s) => s.kind === 'recent_items')!.body;
    expect(body).toMatch(/2023-\d{2}-\d{2}T/);
  });

  it('totalChars equals sum of section chars', () => {
    const ctx = assembleVaultContext({
      persona: 'p',
      query: 'q',
      recentItems: [item()],
      topics: [{ label: 't', salience: 0.5 }],
    });
    const sum = ctx.sections.reduce((s, sec) => s + sec.chars, 0);
    expect(ctx.meta.totalChars).toBe(sum);
  });
});

describe('renderContextAsPrompt', () => {
  it('renders non-empty sections with ## headings', () => {
    const ctx = assembleVaultContext({
      persona: 'p',
      query: 'hello',
      tier: 'general',
    });
    const prompt = renderContextAsPrompt(ctx);
    expect(prompt).toContain('## Active persona\np');
    expect(prompt).toContain('## User query\nhello');
    expect(prompt).toContain('## Content tier\ngeneral');
  });

  it('skips empty sections', () => {
    const ctx = assembleVaultContext({ persona: 'p', query: 'q' });
    const prompt = renderContextAsPrompt(ctx);
    // No topics/contacts/subject/tier sections when not provided.
    expect(prompt.split('##').length - 1).toBeLessThanOrEqual(3); // persona + query + maybe recent_items
  });
});
