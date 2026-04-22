/**
 * digest_renderer tests.
 */

import {
  assembleDigest,
  type DigestItem,
} from '../src/brain/digest_assembler';
import {
  DEFAULT_MAX_BODY_CHARS,
  renderDigest,
  type DigestRenderOptions,
} from '../src/brain/digest_renderer';

function item(overrides: Partial<DigestItem> = {}): DigestItem {
  return {
    id: 'v1',
    title: 'Item title',
    at: 1_700_000_000,
    kind: 'vault',
    ...overrides,
  };
}

function render(
  items: DigestItem[] = [],
  opts: DigestRenderOptions = {},
  assembleOpts: Parameters<typeof assembleDigest>[1] = {},
): string {
  return renderDigest(assembleDigest({ nowSec: 1_700_000_000, items }, assembleOpts), opts);
}

describe('renderDigest — input validation', () => {
  it.each([
    ['null', null],
    ['non-object', 'bogus'],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() =>
      renderDigest(bad as unknown as Parameters<typeof renderDigest>[0]),
    ).toThrow(/digest/);
  });
});

describe('renderDigest — empty digest', () => {
  it('empty digest → empty string', () => {
    expect(render()).toBe('');
  });

  it('headline alone when no items', () => {
    const out = renderDigest(assembleDigest({ nowSec: 0, headline: 'Good morning' }));
    expect(out).toBe('# Good morning');
  });
});

describe('renderDigest — bucket headings', () => {
  it('fiduciary bucket renders with 🚨 heading', () => {
    const out = render([item({ priority: 'fiduciary', title: 'Fire alarm' })]);
    expect(out).toContain('## 🚨 Fiduciary');
    expect(out).toContain('- Fire alarm');
  });

  it('solicited bucket renders', () => {
    const out = render([item({ priority: 'solicited', title: 'Reply' })]);
    expect(out).toContain('## Solicited');
    expect(out).toContain('- Reply');
  });

  it('engagement bucket renders', () => {
    const out = render([item({ title: 'News' })]);
    expect(out).toContain('## Engagement');
  });

  it('plaintext mode uses colon-style headings', () => {
    const out = render(
      [item({ priority: 'fiduciary', title: 'Alarm' })],
      { mode: 'plaintext' },
    );
    expect(out).toContain('🚨 Fiduciary:');
    expect(out).not.toContain('##');
  });

  it('empty buckets are omitted', () => {
    const out = render([item({ priority: 'fiduciary' })]);
    expect(out).toContain('🚨 Fiduciary');
    expect(out).not.toContain('Solicited');
    expect(out).not.toContain('Engagement');
  });

  it('bucket ordering: fiduciary → solicited → engagement', () => {
    const out = render([
      item({ id: 'a', priority: 'engagement', title: 'eng' }),
      item({ id: 'b', priority: 'fiduciary', title: 'fid' }),
      item({ id: 'c', priority: 'solicited', title: 'sol' }),
    ]);
    const fidIdx = out.indexOf('fid');
    const solIdx = out.indexOf('sol');
    const engIdx = out.indexOf('eng');
    expect(fidIdx).toBeLessThan(solIdx);
    expect(solIdx).toBeLessThan(engIdx);
  });

  it('custom labels override defaults', () => {
    const out = render(
      [item({ priority: 'fiduciary', title: 'x' })],
      { labels: { fiduciary: 'URGENT' } },
    );
    expect(out).toContain('## URGENT');
    expect(out).not.toContain('🚨');
  });
});

describe('renderDigest — item rendering', () => {
  it('shows ISO date when item.at > 0', () => {
    const out = render([item({ title: 'Meeting', at: 1_700_000_000 })]);
    expect(out).toMatch(/- Meeting \(2023-\d{2}-\d{2}\)/);
  });

  it('showDates: false hides the date', () => {
    const out = render(
      [item({ title: 'Meeting', at: 1_700_000_000 })],
      { showDates: false },
    );
    expect(out).toContain('- Meeting');
    expect(out).not.toMatch(/\(2023-/);
  });

  it('body rendered on its own line when present', () => {
    const out = render([item({ title: 'Title', body: 'Body text' })]);
    expect(out).toContain('- Title');
    expect(out).toContain('  Body text');
  });

  it('showBodies: false hides bodies', () => {
    const out = render(
      [item({ title: 'Title', body: 'Body text' })],
      { showBodies: false },
    );
    expect(out).not.toContain('Body text');
  });

  it('body truncated with ellipsis past maxBodyChars', () => {
    const long = 'y'.repeat(500);
    const out = render(
      [item({ title: 'Title', body: long })],
      { maxBodyChars: 20 },
    );
    // 20 chars incl. the ellipsis.
    expect(out).toMatch(/\sy{1,20}…$/m);
  });

  it('DEFAULT_MAX_BODY_CHARS is 200', () => {
    expect(DEFAULT_MAX_BODY_CHARS).toBe(200);
  });

  it('item.at=0 suppresses the date suffix', () => {
    const out = render([item({ title: 'No date', at: 0 })]);
    expect(out).toContain('- No date');
    expect(out).not.toMatch(/\(/);
  });

  it('item without body renders just the title line', () => {
    const out = render([item({ title: 'Alone' })]);
    const lines = out.split('\n');
    expect(lines.some((l) => l === '- Alone (2023-11-14)')).toBe(true);
  });
});

describe('renderDigest — overflow', () => {
  it('overflow appended when bucket overflowed', () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      item({ id: `v${i}`, priority: 'engagement', title: `#${i}` }),
    );
    const out = render(many);
    expect(out).toMatch(/… and 5 more/);
  });

  it('no overflow line when overflow is 0', () => {
    const out = render([item({ title: 'Solo' })]);
    expect(out).not.toMatch(/and \d+ more/);
  });
});

describe('renderDigest — topics + contacts', () => {
  it('topics rendered as comma-separated list', () => {
    const digest = assembleDigest({
      nowSec: 0,
      topics: [
        { label: 'meeting', salience: 0.9 },
        { label: 'project', salience: 0.5 },
      ],
    });
    const out = renderDigest(digest);
    expect(out).toContain('## Topics');
    expect(out).toContain('meeting, project');
  });

  it('topics omitted when empty', () => {
    const out = render();
    expect(out).not.toContain('Topics');
  });

  it('contacts rendered with note in parens when present', () => {
    const digest = assembleDigest({
      nowSec: 0,
      contacts: [
        { id: 'c1', name: 'Alice', note: 'spouse' },
        { id: 'c2', name: 'Bob' },
      ],
    });
    const out = renderDigest(digest);
    expect(out).toContain('Alice (spouse), Bob');
  });

  it('plaintext contacts use colon-style header', () => {
    const digest = assembleDigest({
      nowSec: 0,
      contacts: [{ id: 'c1', name: 'Alice' }],
    });
    const out = renderDigest(digest, { mode: 'plaintext' });
    expect(out).toContain('Contacts: Alice');
  });
});

describe('renderDigest — headline', () => {
  it('markdown headline uses h1', () => {
    const digest = assembleDigest({ nowSec: 0, headline: 'Daily briefing' });
    const out = renderDigest(digest);
    expect(out.startsWith('# Daily briefing')).toBe(true);
  });

  it('plaintext headline is bare text (no #)', () => {
    const digest = assembleDigest({ nowSec: 0, headline: 'Daily briefing' });
    const out = renderDigest(digest, { mode: 'plaintext' });
    expect(out.startsWith('Daily briefing')).toBe(true);
    expect(out).not.toContain('#');
  });

  it('null headline is skipped', () => {
    const out = render([item({ title: 'x' })]);
    expect(out).not.toMatch(/^# /);
  });
});

describe('renderDigest — integration with assembleDigest', () => {
  it('full digest renders fiduciary + solicited + engagement + topics + contacts + headline', () => {
    const digest = assembleDigest({
      nowSec: 1_700_000_000,
      headline: 'Good morning',
      items: [
        item({ id: 'f1', priority: 'fiduciary', title: 'Fire' }),
        item({ id: 's1', priority: 'solicited', title: 'Reply needed' }),
        item({ id: 'e1', priority: 'engagement', title: 'Blog post' }),
      ],
      topics: [{ label: 'quarterly', salience: 0.9 }],
      contacts: [{ id: 'c', name: 'Alice' }],
    });
    const out = renderDigest(digest);
    expect(out).toContain('# Good morning');
    expect(out).toContain('## 🚨 Fiduciary');
    expect(out).toContain('## Solicited');
    expect(out).toContain('## Engagement');
    expect(out).toContain('## Topics');
    expect(out).toContain('## Contacts');
  });

  it('sections separated by blank line in output', () => {
    const out = render([
      item({ id: 'f1', priority: 'fiduciary', title: 'F' }),
      item({ id: 'e1', priority: 'engagement', title: 'E' }),
    ]);
    expect(out).toContain('\n\n');
  });
});
