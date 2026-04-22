/**
 * deep_link_builder tests.
 */

import {
  DEFAULT_MAX_EXCERPT_CHARS,
  DeepLinkError,
  buildDeepLink,
  renderDisplay,
  type DeepLinkInput,
} from '../src/brain/deep_link_builder';

function input(overrides: Partial<DeepLinkInput> = {}): DeepLinkInput {
  return { url: 'https://www.example.com/path', ...overrides };
}

describe('buildDeepLink — input validation', () => {
  it.each([
    ['null input', null],
    ['missing url', {}],
    ['empty url', { url: '' }],
    ['whitespace url', { url: '   ' }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() =>
      buildDeepLink(bad as DeepLinkInput),
    ).toThrow(DeepLinkError);
  });

  it('rejects malformed URL', () => {
    expect(() => buildDeepLink(input({ url: 'not a url' }))).toThrow(/invalid_url/);
  });

  it('rejects non-http scheme', () => {
    expect(() => buildDeepLink(input({ url: 'ftp://example.com' }))).toThrow(/unsupported_scheme/);
  });

  it('rejects javascript: scheme', () => {
    expect(() => buildDeepLink(input({ url: 'javascript:alert(1)' }))).toThrow(/unsupported_scheme/);
  });
});

describe('buildDeepLink — tracking-param stripping', () => {
  it('strips utm_* params', () => {
    const r = buildDeepLink(
      input({ url: 'https://example.com/?utm_source=google&utm_medium=cpc&q=hello' }),
    );
    const parsed = new URL(r.payload.url);
    expect(parsed.searchParams.get('utm_source')).toBeNull();
    expect(parsed.searchParams.get('utm_medium')).toBeNull();
    expect(parsed.searchParams.get('q')).toBe('hello');
  });

  it('strips well-known exact params (fbclid, gclid, etc.)', () => {
    const r = buildDeepLink(
      input({ url: 'https://example.com/?fbclid=abc&gclid=xyz&id=5' }),
    );
    const parsed = new URL(r.payload.url);
    expect(parsed.searchParams.has('fbclid')).toBe(false);
    expect(parsed.searchParams.has('gclid')).toBe(false);
    expect(parsed.searchParams.get('id')).toBe('5');
  });

  it('extraTrackingParams option strips additional keys', () => {
    const r = buildDeepLink(
      input({ url: 'https://example.com/?ref_source=spam&keep=yes' }),
      { extraTrackingParams: ['ref_source'] },
    );
    const parsed = new URL(r.payload.url);
    expect(parsed.searchParams.has('ref_source')).toBe(false);
    expect(parsed.searchParams.get('keep')).toBe('yes');
  });

  it('preserves fragment', () => {
    const r = buildDeepLink(input({ url: 'https://example.com/path#section-2' }));
    expect(new URL(r.payload.url).hash).toBe('#section-2');
  });

  it('tracking-param stripping is case-insensitive', () => {
    const r = buildDeepLink(
      input({ url: 'https://example.com/?UTM_SOURCE=x&FBCLID=y' }),
    );
    const parsed = new URL(r.payload.url);
    expect(parsed.searchParams.has('UTM_SOURCE')).toBe(false);
    expect(parsed.searchParams.has('FBCLID')).toBe(false);
  });
});

describe('buildDeepLink — host normalisation', () => {
  it('anchor drops leading www. by default', () => {
    const r = buildDeepLink(input({ url: 'https://www.example.com/' }));
    expect(r.payload.anchor).toBe('example.com');
    expect(r.payload.host).toBe('www.example.com');
  });

  it('anchor preserves www when requested', () => {
    const r = buildDeepLink(
      input({ url: 'https://www.example.com/' }),
      { preserveWwwInAnchor: true },
    );
    expect(r.payload.anchor).toBe('www.example.com');
  });

  it('hostname is lowercased', () => {
    const r = buildDeepLink(input({ url: 'https://EXAMPLE.COM/path' }));
    expect(r.payload.host).toBe('example.com');
    expect(new URL(r.payload.url).hostname).toBe('example.com');
  });
});

describe('buildDeepLink — attribution', () => {
  it('author rendered when supplied', () => {
    const r = buildDeepLink(
      input({ author: 'Alice Jones', publisher: 'Dina Times' }),
    );
    expect(r.display).toContain('Alice Jones');
    expect(r.display).toContain('Dina Times');
  });

  it('publisher falls back to anchor when not supplied', () => {
    const r = buildDeepLink(input());
    expect(r.payload.publisher).toBe('example.com');
  });

  it('publishedAtSec rendered as ISO date prefix in display', () => {
    const r = buildDeepLink(
      input({ author: 'Alice', publishedAtSec: 1_700_000_000 }),
    );
    expect(r.display).toMatch(/2023-\d{2}-\d{2}/);
    expect(r.payload.publishedAtIso).toMatch(/^2023-\d{2}-\d{2}T/);
  });

  it('non-finite publishedAtSec is dropped', () => {
    const r = buildDeepLink(
      input({ publishedAtSec: Number.POSITIVE_INFINITY }),
    );
    expect(r.payload.publishedAtSec).toBeNull();
    expect(r.payload.publishedAtIso).toBeNull();
  });

  it('empty author trimmed to null', () => {
    const r = buildDeepLink(input({ author: '   ' }));
    expect(r.payload.author).toBeNull();
  });

  it('ref echoes into payload', () => {
    const r = buildDeepLink(input({ ref: 'briefing-2026-04-22' }));
    expect(r.payload.ref).toBe('briefing-2026-04-22');
  });

  it('ref is trimmed', () => {
    const r = buildDeepLink(input({ ref: '  hello  ' }));
    expect(r.payload.ref).toBe('hello');
  });

  it('empty ref → null', () => {
    const r = buildDeepLink(input({ ref: '   ' }));
    expect(r.payload.ref).toBeNull();
  });
});

describe('buildDeepLink — excerpt', () => {
  it('excerpt preserved up to default cap', () => {
    const r = buildDeepLink(input({ excerpt: 'Short excerpt here.' }));
    expect(r.payload.excerpt).toBe('Short excerpt here.');
  });

  it('excerpt trimmed', () => {
    const r = buildDeepLink(input({ excerpt: '   with whitespace   ' }));
    expect(r.payload.excerpt).toBe('with whitespace');
  });

  it('excerpt truncated with ellipsis when over cap', () => {
    const long = 'x'.repeat(500);
    const r = buildDeepLink(
      input({ excerpt: long }),
      { maxExcerptChars: 20 },
    );
    expect(r.payload.excerpt).toHaveLength(20);
    expect(r.payload.excerpt!.endsWith('…')).toBe(true);
  });

  it('DEFAULT_MAX_EXCERPT_CHARS is 280', () => {
    expect(DEFAULT_MAX_EXCERPT_CHARS).toBe(280);
  });

  it('no excerpt → null', () => {
    const r = buildDeepLink(input());
    expect(r.payload.excerpt).toBeNull();
  });
});

describe('buildDeepLink — payload shape', () => {
  it('every field populated or explicitly null', () => {
    const r = buildDeepLink(input());
    expect(Object.keys(r.payload).sort()).toEqual([
      'anchor',
      'author',
      'excerpt',
      'host',
      'publishedAtIso',
      'publishedAtSec',
      'publisher',
      'ref',
      'url',
    ]);
  });
});

describe('renderDisplay', () => {
  it('author + publisher + date joined by comma', () => {
    const s = renderDisplay({
      url: 'https://x/',
      host: 'x',
      anchor: 'x',
      author: 'Alice',
      publisher: 'Times',
      publishedAtIso: '2026-04-22T12:00:00.000Z',
      publishedAtSec: 1_745_000_000,
      excerpt: null,
      ref: null,
    });
    expect(s).toBe('Alice, Times, 2026-04-22');
  });

  it('no author → publisher + date only', () => {
    const s = renderDisplay({
      url: 'https://x/',
      host: 'x',
      anchor: 'x',
      author: null,
      publisher: 'x.com',
      publishedAtIso: '2026-04-22T00:00:00.000Z',
      publishedAtSec: 1_745_000_000,
      excerpt: null,
      ref: null,
    });
    expect(s).toBe('x.com, 2026-04-22');
  });

  it('no date → just publisher', () => {
    const s = renderDisplay({
      url: 'https://x/',
      host: 'x',
      anchor: 'x',
      author: null,
      publisher: 'x.com',
      publishedAtIso: null,
      publishedAtSec: null,
      excerpt: null,
      ref: null,
    });
    expect(s).toBe('x.com');
  });
});
