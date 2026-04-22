/**
 * markdown_escaper tests.
 */

import {
  escapeCommonMark,
  escapeForDialect,
  escapeGithubFlavored,
  escapeMarkdownV2,
  sanitizeForDialect,
  stripMarkdown,
  type MarkdownDialect,
} from '../src/brain/markdown_escaper';

describe('escapeForDialect — input validation', () => {
  it('rejects non-string text', () => {
    expect(() =>
      escapeForDialect(42 as unknown as string, 'commonmark'),
    ).toThrow(/text/);
  });

  it('rejects unknown dialect', () => {
    expect(() =>
      escapeForDialect('x', 'bogus' as MarkdownDialect),
    ).toThrow(/dialect/);
  });
});

describe('escapeCommonMark', () => {
  it('escapes typical reserved chars', () => {
    const out = escapeCommonMark('**bold**');
    expect(out).toBe('\\*\\*bold\\*\\*');
  });

  it('escapes brackets + parens', () => {
    expect(escapeCommonMark('[link](url)')).toBe('\\[link\\]\\(url\\)');
  });

  it('escapes heading + list markers', () => {
    expect(escapeCommonMark('# heading')).toBe('\\# heading');
    expect(escapeCommonMark('- item')).toBe('\\- item');
  });

  it('escapes backslash itself', () => {
    expect(escapeCommonMark('a\\b')).toBe('a\\\\b');
  });

  it('leaves plain text untouched', () => {
    expect(escapeCommonMark('hello world')).toBe('hello world');
  });
});

describe('escapeMarkdownV2', () => {
  it('escapes all 18 telegram reserved chars', () => {
    const reserved = '_*[]()~`>#+-=|{}.!';
    const out = escapeMarkdownV2(reserved);
    // Every reserved char should be backslash-prefixed.
    for (const ch of reserved) {
      expect(out.indexOf(`\\${ch}`)).toBeGreaterThanOrEqual(0);
    }
  });

  it('escapes period', () => {
    expect(escapeMarkdownV2('Total: $1.00')).toBe('Total: $1\\.00');
  });

  it('escapes hyphen', () => {
    expect(escapeMarkdownV2('a-b')).toBe('a\\-b');
  });
});

describe('escapeGithubFlavored', () => {
  it('escapes @ mentions', () => {
    expect(escapeGithubFlavored('@alice')).toBe('\\@alice');
  });

  it('escapes pipe (table separator)', () => {
    expect(escapeGithubFlavored('a|b')).toBe('a\\|b');
  });

  it('escapes base commonmark chars too', () => {
    expect(escapeGithubFlavored('**bold**')).toBe('\\*\\*bold\\*\\*');
  });
});

describe('escapeForDialect switch', () => {
  it.each([
    ['commonmark', '**hi**', '\\*\\*hi\\*\\*'],
    ['markdownV2', 'a.b', 'a\\.b'],
    ['githubFlavored', '@user', '\\@user'],
  ] as const)('%s: %s → %s', (dialect, input, expected) => {
    expect(escapeForDialect(input, dialect as MarkdownDialect)).toBe(expected);
  });
});

describe('stripMarkdown', () => {
  it('strips bold markers', () => {
    expect(stripMarkdown('**bold text**')).toBe('bold text');
  });

  it('strips italic (star) markers', () => {
    expect(stripMarkdown('*italic*')).toBe('italic');
  });

  it('strips italic (underscore) markers', () => {
    expect(stripMarkdown('_italic_')).toBe('italic');
  });

  it('strips strikethrough', () => {
    expect(stripMarkdown('~~gone~~')).toBe('gone');
  });

  it('strips code spans', () => {
    expect(stripMarkdown('`code`')).toBe('code');
  });

  it('strips links but keeps label', () => {
    expect(stripMarkdown('Go to [site](https://ex.com)')).toBe('Go to site');
  });

  it('strips images leaving alt text', () => {
    expect(stripMarkdown('![alt](https://ex.com/img.png)')).toBe('alt');
  });

  it('strips heading markers', () => {
    expect(stripMarkdown('# Heading\n## Subheading')).toBe('Heading\nSubheading');
  });

  it('strips list markers', () => {
    expect(stripMarkdown('- item1\n* item2\n+ item3')).toBe('item1\nitem2\nitem3');
  });

  it('strips ordered list markers', () => {
    expect(stripMarkdown('1. first\n2. second')).toBe('first\nsecond');
  });

  it('strips blockquote markers', () => {
    expect(stripMarkdown('> quoted\n>nested')).toBe('quoted\nnested');
  });

  it('strips nested bold + italic together', () => {
    expect(stripMarkdown('**bold with _italic_ inside**')).toBe('bold with italic inside');
  });

  it('leaves plain text unchanged', () => {
    expect(stripMarkdown('hello world')).toBe('hello world');
  });

  it('rejects non-string', () => {
    expect(() => stripMarkdown(42 as unknown as string)).toThrow(/text/);
  });
});

describe('sanitizeForDialect', () => {
  it('strips then escapes', () => {
    // **bold.** — strip to "bold." then escape dot in markdownV2.
    expect(sanitizeForDialect('**bold.**', 'markdownV2')).toBe('bold\\.');
  });

  it('link with reserved char in label', () => {
    // Link stripped → "one.two"; dot escaped in markdownV2.
    expect(
      sanitizeForDialect('[one.two](https://x.com)', 'markdownV2'),
    ).toBe('one\\.two');
  });
});

describe('edge cases', () => {
  it('empty string → empty string across all dialects', () => {
    expect(escapeCommonMark('')).toBe('');
    expect(escapeMarkdownV2('')).toBe('');
    expect(escapeGithubFlavored('')).toBe('');
    expect(stripMarkdown('')).toBe('');
  });

  it('markdownV2 escapes in same order as telegram adapter', () => {
    // Cross-check: the escapeMarkdownV2 output here should match
    // what telegram_adapter.renderSendMessage produces for MarkdownV2.
    const raw = '(hi)';
    expect(escapeMarkdownV2(raw)).toBe('\\(hi\\)');
  });
});
